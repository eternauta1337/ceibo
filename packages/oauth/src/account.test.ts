// Unit de la obtención de la cuenta externa real por provider + el backfill de grants viejos.
// El fetch se inyecta (`fetchImpl`) → cero red. Cubre los providers que SÍ exponen identidad
// con su scope actual (gmail, drive, notion) y los que NO (calendar, sheets → null), más los
// caminos del backfill (refresh de token vencido, no-resoluble queda null, error por grant).

import { addUser, getOauthGrant, type OauthGrant, openDb, upsertOauthGrant } from "@ceibo/store";
import { describe, expect, it, vi } from "vitest";
import { backfillGrantAccounts, fetchProviderAccount } from "./index.ts";

const resp = (ok: boolean, body: unknown): Response =>
  ({ ok, status: ok ? 200 : 400, json: async () => body, text: async () => "" }) as Response;

const db = () => openDb(":memory:");
const grant = (userId: number, over: Partial<OauthGrant> = {}): OauthGrant => ({
  user_id: userId,
  service: "gmail",
  profile: "default",
  provider: "google",
  mcp_url: "https://mcp/gmail",
  display_name: "Gmail",
  account: null,
  broken_at: null,
  notified_at: null,
  refresh_token: "rt",
  access_token: "at",
  expires_at: "2099-01-01T00:00:00.000Z",
  scope: "s",
  ...over,
});

describe("fetchProviderAccount", () => {
  it("gmail: users.getProfile → emailAddress", async () => {
    const f = vi.fn(async (_url: string | URL | Request) => resp(true, { emailAddress: "user@example.com" }));
    expect(await fetchProviderAccount({ service: "gmail", accessToken: "t", fetchImpl: f })).toBe(
      "user@example.com",
    );
    expect(String(f.mock.calls[0]?.[0])).toContain("gmail.googleapis.com");
  });

  it("gmail: HTTP no-ok o sin email → null", async () => {
    const fail = vi.fn(async () => resp(false, {}));
    expect(await fetchProviderAccount({ service: "gmail", accessToken: "t", fetchImpl: fail })).toBeNull();
    const empty = vi.fn(async () => resp(true, {}));
    expect(await fetchProviderAccount({ service: "gmail", accessToken: "t", fetchImpl: empty })).toBeNull();
  });

  it("drive: about.get → user.emailAddress", async () => {
    const f = vi.fn(async () => resp(true, { user: { emailAddress: "d@e.com" } }));
    expect(await fetchProviderAccount({ service: "drive", accessToken: "t", fetchImpl: f })).toBe("d@e.com");
    const noUser = vi.fn(async () => resp(true, {}));
    expect(await fetchProviderAccount({ service: "drive", accessToken: "t", fetchImpl: noUser })).toBeNull();
  });

  it("notion: /v1/users/me → bot.workspace_name (o name como fallback)", async () => {
    const ws = vi.fn(async () => resp(true, { bot: { workspace_name: "Mi Workspace" } }));
    expect(await fetchProviderAccount({ service: "notion", accessToken: "t", fetchImpl: ws })).toBe(
      "Mi Workspace",
    );
    const named = vi.fn(async () => resp(true, { name: "Bot ceibo" }));
    expect(await fetchProviderAccount({ service: "notion", accessToken: "t", fetchImpl: named })).toBe(
      "Bot ceibo",
    );
    const fail = vi.fn(async () => resp(false, {}));
    expect(await fetchProviderAccount({ service: "notion", accessToken: "t", fetchImpl: fail })).toBeNull();
  });

  it("calendar / sheets: scope sin identidad → null sin pegarle al provider", async () => {
    const f = vi.fn(async () => resp(true, { emailAddress: "no" }));
    expect(await fetchProviderAccount({ service: "calendar", accessToken: "t", fetchImpl: f })).toBeNull();
    expect(await fetchProviderAccount({ service: "sheets", accessToken: "t", fetchImpl: f })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("servicio desconocido → null", async () => {
    const f = vi.fn(async () => resp(true, {}));
    expect(await fetchProviderAccount({ service: "nope", accessToken: "t", fetchImpl: f })).toBeNull();
  });

  it("red caída (fetch throws) → null (best-effort)", async () => {
    const f = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await fetchProviderAccount({ service: "gmail", accessToken: "t", fetchImpl: f })).toBeNull();
  });
});

describe("backfillGrantAccounts", () => {
  it("completa los grants sin account con la cuenta del provider", async () => {
    const d = db();
    const u = addUser(d, "demo");
    upsertOauthGrant(d, grant(u.id, { service: "gmail", account: null }));
    const f = vi.fn(async () => resp(true, { emailAddress: "user@example.com" }));
    const out = await backfillGrantAccounts({ db: d, env: {}, fetchImpl: f });
    expect(out).toEqual({ scanned: 1, filled: 1 });
    expect(getOauthGrant(d, u.id, "gmail")?.account).toBe("user@example.com");
  });

  it("refresca el access_token vencido antes de consultar la cuenta", async () => {
    const d = db();
    const u = addUser(d, "demo");
    upsertOauthGrant(
      d,
      grant(u.id, { service: "gmail", account: null, expires_at: "2000-01-01T00:00:00.000Z" }),
    );
    const f = vi.fn(async (url: string | URL | Request) => {
      const s = String(url);
      if (s.includes("oauth2.googleapis.com")) return resp(true, { access_token: "fresh", expires_in: 3600 });
      if (s.includes("gmail.googleapis.com")) return resp(true, { emailAddress: "refreshed@gmail.com" });
      throw new Error(`url inesperada: ${s}`);
    });
    const env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec" } as unknown as NodeJS.ProcessEnv;
    const out = await backfillGrantAccounts({ db: d, env, fetchImpl: f });
    expect(out.filled).toBe(1);
    expect(getOauthGrant(d, u.id, "gmail")?.account).toBe("refreshed@gmail.com");
    // Pegó primero al token endpoint (refresh) y después al de gmail.
    expect(String(f.mock.calls[0]?.[0])).toContain("oauth2.googleapis.com");
  });

  it("lo no-resoluble (calendar) queda en null y no cuenta como filled", async () => {
    const d = db();
    const u = addUser(d, "demo");
    upsertOauthGrant(d, grant(u.id, { service: "calendar", account: null }));
    const f = vi.fn(async () => resp(true, { emailAddress: "no" }));
    const out = await backfillGrantAccounts({ db: d, env: {}, fetchImpl: f });
    expect(out).toEqual({ scanned: 1, filled: 0 });
    expect(getOauthGrant(d, u.id, "calendar")?.account).toBeNull();
  });

  it("un error al refrescar no tumba el backfill (best-effort por grant)", async () => {
    const d = db();
    const u = addUser(d, "demo");
    upsertOauthGrant(
      d,
      grant(u.id, { service: "gmail", account: null, expires_at: "2000-01-01T00:00:00.000Z" }),
    );
    const f = vi.fn(async () => {
      throw new Error("token endpoint caído");
    });
    const env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec" } as unknown as NodeJS.ProcessEnv;
    const out = await backfillGrantAccounts({ db: d, env, fetchImpl: f });
    expect(out).toEqual({ scanned: 1, filled: 0 });
    expect(getOauthGrant(d, u.id, "gmail")?.account).toBeNull();
  });
});
