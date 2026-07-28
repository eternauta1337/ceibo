import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeCode, PROVIDERS, refreshAccessToken } from "./index.ts";

const google = PROVIDERS.google as NonNullable<(typeof PROVIDERS)["google"]>;
const notion = PROVIDERS.notion as NonNullable<(typeof PROVIDERS)["notion"]>;

// Fake de fetch: registra la última llamada y devuelve lo que el test decida.
function stubFetch(resp: { ok?: boolean; status?: number; json?: unknown; text?: string }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: resp.ok ?? true,
      status: resp.status ?? 200,
      json: async () => resp.json,
      text: async () => resp.text ?? "",
    } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

// La (única) request capturada; falla explícito si fetch no se llamó.
const reqOf = (calls: { url: string; init: RequestInit }[]) => {
  const c = calls[0];
  if (!c) throw new Error("fetch no fue llamado");
  return c;
};
// Helpers para inspeccionar el body capturado según el modo de auth.
const formBody = (init: RequestInit) => new URLSearchParams(init.body as string);
const jsonBody = (init: RequestInit) => JSON.parse(init.body as string);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("exchangeCode — Google (PKCE, secret en el body, form-urlencoded)", () => {
  it("manda code + verifier + client_id/secret en el body urlencoded y parsea los tokens", async () => {
    const calls = stubFetch({
      json: { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "s1 s2" },
    });
    const tok = await exchangeCode({
      provider: google,
      clientId: "cid",
      clientSecret: "secret",
      code: "the-code",
      verifier: "ver",
      redirectUri: "https://app/cb",
    });

    expect(calls).toHaveLength(1);
    const { url, init } = reqOf(calls);
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const b = formBody(init);
    expect(b.get("grant_type")).toBe("authorization_code");
    expect(b.get("code")).toBe("the-code");
    expect(b.get("code_verifier")).toBe("ver");
    expect(b.get("client_id")).toBe("cid");
    expect(b.get("client_secret")).toBe("secret");
    expect(b.get("redirect_uri")).toBe("https://app/cb");

    expect(tok.accessToken).toBe("at");
    expect(tok.refreshToken).toBe("rt");
    expect(tok.scope).toBe("s1 s2");
    // expires_in 3600 desde 2026-01-01T00:00:00Z
    expect(tok.expiresAt).toBe("2026-01-01T01:00:00.000Z");
  });

  it("provider PKCE sin verifier → tira sin tocar fetch", async () => {
    const calls = stubFetch({ json: {} });
    await expect(
      exchangeCode({
        provider: google,
        clientId: "c",
        clientSecret: "s",
        code: "x",
        redirectUri: "https://a/cb",
      }),
    ).rejects.toThrow(/PKCE/);
    expect(calls).toHaveLength(0);
  });

  it("hasRefresh pero el provider no devolvió refresh_token → tira (re-consent)", async () => {
    stubFetch({ json: { access_token: "at", expires_in: 3600 } });
    await expect(
      exchangeCode({
        provider: google,
        clientId: "c",
        clientSecret: "s",
        code: "x",
        verifier: "v",
        redirectUri: "https://a/cb",
      }),
    ).rejects.toThrow(/refresh_token/);
  });

  it("HTTP no-ok → tira con status y cuerpo", async () => {
    stubFetch({ ok: false, status: 400, text: "bad_request" });
    await expect(
      exchangeCode({
        provider: google,
        clientId: "c",
        clientSecret: "s",
        code: "x",
        verifier: "v",
        redirectUri: "https://a/cb",
      }),
    ).rejects.toThrow(/400.*bad_request/);
  });
});

describe("exchangeCode — Notion (Basic auth, JSON, sin refresh)", () => {
  it("usa Authorization Basic + content-type JSON y no manda secret en el body", async () => {
    const calls = stubFetch({ json: { access_token: "at" } }); // sin expires_in ni scope
    const tok = await exchangeCode({
      provider: notion,
      clientId: "cid",
      clientSecret: "secret",
      code: "code",
      redirectUri: "https://app/cb",
    });

    const { init } = reqOf(calls);
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe(`Basic ${Buffer.from("cid:secret").toString("base64")}`);
    const b = jsonBody(init);
    expect(b.client_secret).toBeUndefined();
    expect(b.code).toBe("code");
    expect(b.grant_type).toBe("authorization_code");

    // Notion: no expira, scope ausente → defaults
    expect(tok.accessToken).toBe("at");
    expect(tok.refreshToken).toBeUndefined();
    expect(tok.expiresAt).toBeUndefined();
    expect(tok.scope).toBe("");
  });
});

describe("refreshAccessToken", () => {
  it("Google: grant_type=refresh_token en form, conserva token rotado", async () => {
    const calls = stubFetch({
      json: { access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 },
    });
    const tok = await refreshAccessToken({
      provider: google,
      clientId: "cid",
      clientSecret: "secret",
      refreshToken: "old-rt",
    });
    const b = formBody(reqOf(calls).init);
    expect(b.get("grant_type")).toBe("refresh_token");
    expect(b.get("refresh_token")).toBe("old-rt");
    expect(tok.accessToken).toBe("new-at");
    expect(tok.refreshToken).toBe("new-rt");
    expect(tok.expiresAt).toBe("2026-01-01T01:00:00.000Z");
  });

  it("si el provider no rota el refresh_token, viene undefined (el caller conserva el viejo)", async () => {
    stubFetch({ json: { access_token: "new-at", expires_in: 3600 } });
    const tok = await refreshAccessToken({
      provider: google,
      clientId: "c",
      clientSecret: "s",
      refreshToken: "old-rt",
    });
    expect(tok.refreshToken).toBeUndefined();
  });

  it("HTTP no-ok → tira", async () => {
    stubFetch({ ok: false, status: 401, text: "invalid_grant" });
    await expect(
      refreshAccessToken({ provider: google, clientId: "c", clientSecret: "s", refreshToken: "r" }),
    ).rejects.toThrow(/401.*invalid_grant/);
  });
});
