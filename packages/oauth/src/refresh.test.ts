import type { SessionBackend } from "@ceibo/agent";
import { makeMaBackend } from "@ceibo/agent";
import {
  addUser,
  getOauthGrant,
  openDb,
  sealGrantNotified,
  setUserBackendMode,
  setUserLocalVault,
  setUserVault,
  upsertOauthGrant,
} from "@ceibo/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isInvalidGrant, refreshGrantsForUser } from "./index.ts";

// Backend fake: client Anthropic stub (list vacío → create) envuelto en el MaBackend
// real, así el test ejercita la costura tal cual la usa el gateway.
function fakeBackend() {
  const created: unknown[] = [];
  const client = {
    beta: {
      vaults: {
        credentials: {
          list: async () => ({ data: [] }),
          create: async (_v: string, body: unknown) => {
            created.push(body);
          },
          update: async () => {},
          delete: async () => {},
        },
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: stub estructural
  } as any;
  return { backend: makeMaBackend(client), created };
}

const ENV = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "secret" } as NodeJS.ProcessEnv;

function seedDueGrant() {
  const db = openDb(":memory:");
  const u = addUser(db, "owner", { name: "Owner" });
  setUserVault(db, u.id, "vault-1");
  upsertOauthGrant(db, {
    user_id: u.id,
    service: "gmail",
    profile: "default",
    provider: "google",
    mcp_url: "https://mcp/gmail",
    display_name: "Gmail",
    account: null,
    broken_at: null,
    notified_at: null,
    refresh_token: "old-rt",
    access_token: "old-at",
    expires_at: "2020-01-01T00:00:00.000Z", // ya vencido → due
    scope: "s",
  });
  return { db, userId: u.id };
}

function stubRefreshFetch(json: unknown) {
  const calls: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      return { ok: true, status: 200, json: async () => json, text: async () => "" } as Response;
    }),
  );
  return calls;
}

/** Fetch que devuelve un HTTP no-ok con el body dado (para invalid_grant HTTP 400 y transitorios 5xx). */
function stubRefreshHttpError(status: number, body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({ ok: false, status, json: async () => ({}), text: async () => body }) as unknown as Response,
    ),
  );
}

/** Fetch que TIRA (simula caída de red / DNS / timeout) → error transitorio, NO invalid_grant. */
function stubRefreshNetworkError() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch failed");
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("refreshGrantsForUser", () => {
  it("refresca el grant vencido, re-pushea al vault y persiste el token nuevo", async () => {
    const { db, userId } = seedDueGrant();
    const { backend, created } = fakeBackend();
    const calls = stubRefreshFetch({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 });

    await refreshGrantsForUser({ db, backend, userId, env: ENV });

    expect(calls).toHaveLength(1); // un refresh HTTP
    expect(created).toHaveLength(1); // un static_bearer al vault
    const g = getOauthGrant(db, userId, "gmail");
    expect(g?.access_token).toBe("new-at");
    expect(g?.refresh_token).toBe("new-rt");
  });

  it("conserva el refresh_token viejo si el provider no rota (no viene en la respuesta)", async () => {
    const { db, userId } = seedDueGrant();
    const { backend } = fakeBackend();
    stubRefreshFetch({ access_token: "new-at", expires_in: 3600 }); // sin refresh_token

    await refreshGrantsForUser({ db, backend, userId, env: ENV });

    expect(getOauthGrant(db, userId, "gmail")?.refresh_token).toBe("old-rt");
  });

  it("sin grants por vencer → no toca la red", async () => {
    const db = openDb(":memory:");
    const u = addUser(db, "owner");
    setUserVault(db, u.id, "vault-1");
    const { backend } = fakeBackend();
    const calls = stubRefreshFetch({});
    await refreshGrantsForUser({ db, backend, userId: u.id, env: ENV });
    expect(calls).toHaveLength(0);
  });

  it("usuario sin vault → no-op (no hay dónde pushear)", async () => {
    const db = openDb(":memory:");
    const u = addUser(db, "novault"); // sin setUserVault
    upsertOauthGrant(db, {
      user_id: u.id,
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
      expires_at: "2020-01-01T00:00:00.000Z",
      scope: "s",
    });
    const { backend } = fakeBackend();
    const calls = stubRefreshFetch({ access_token: "x", expires_in: 1 });
    await refreshGrantsForUser({ db, backend, userId: u.id, env: ENV });
    expect(calls).toHaveLength(0);
  });

  // Backend que sólo registra a qué vault se pushea (espeja el `--vault` del agent-vault local).
  function recordingBackend() {
    const vaults: string[] = [];
    const backend: SessionBackend = {
      createVault: async () => "unused",
      setStaticBearerCredential: async (vaultId) => {
        vaults.push(vaultId);
      },
      revokeOauthCredential: async () => true,
      setSessionAgentConfig: async () => {},
      createSession: async () => "s",
      reuseOrCreate: async () => "s",
      attach: () => ({ send: async () => {}, interrupt: async () => {}, close: () => {} }),
    };
    return { backend, vaults };
  }

  it("usuario LOCAL: pushea el token refrescado al local_vault_id, NO al vault_id MA", async () => {
    const { db, userId } = seedDueGrant(); // seedDueGrant ya setea vault_id = 'vault-1' (MA)
    setUserLocalVault(db, userId, "archima-local-vault");
    setUserBackendMode(db, userId, "local");
    const { backend, vaults } = recordingBackend();
    stubRefreshFetch({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 });

    await refreshGrantsForUser({ db, backend, userId, env: ENV });

    // El push fue al vault LOCAL (el que conoce el agent-vault de la box), no al vault MA.
    expect(vaults).toEqual(["archima-local-vault"]);
    expect(vaults).not.toContain("vault-1");
  });

  it("usuario LOCAL sin local_vault_id provisionado → no-op (no pushea a un vault MA inexistente)", async () => {
    const { db, userId } = seedDueGrant(); // tiene vault_id MA pero NO local_vault_id
    setUserBackendMode(db, userId, "local");
    const { backend, vaults } = recordingBackend();
    const calls = stubRefreshFetch({ access_token: "x", expires_in: 1 });

    await refreshGrantsForUser({ db, backend, userId, env: ENV });

    expect(calls).toHaveLength(0); // ni siquiera intenta el refresh HTTP
    expect(vaults).toHaveLength(0); // y NO pushea al vault MA (vault-1)
  });

  // --- Detección de muerte de grant (invalid_grant) + anti-spam --------------------------------
  it("invalid_grant: marca el grant roto y lo DEVUELVE (transición sano→roto)", async () => {
    const { db, userId } = seedDueGrant();
    const { backend } = fakeBackend();
    // Google devuelve HTTP 400 { "error": "invalid_grant" } cuando el refresh token murió.
    stubRefreshHttpError(400, JSON.stringify({ error: "invalid_grant" }));

    const broken = await refreshGrantsForUser({ db, backend, userId, env: ENV });

    expect(broken.map((g) => g.service)).toEqual(["gmail"]);
    expect(getOauthGrant(db, userId, "gmail")?.broken_at).not.toBeNull();
  });

  it("invalid_grant: REINTENTA reportar mientras no se selle notified_at (retry-hasta-entregar)", async () => {
    const { db, userId } = seedDueGrant();
    const { backend } = fakeBackend();
    stubRefreshHttpError(400, JSON.stringify({ error: "invalid_grant" }));

    // El anti-spam mira notified_at, NO broken_at: mientras la entrega no se selle, cada sweep lo
    // vuelve a devolver (así no se pierde el aviso si la entrega falló, ej. en cron).
    const first = await refreshGrantsForUser({ db, backend, userId, env: ENV });
    expect(first).toHaveLength(1);
    const second = await refreshGrantsForUser({ db, backend, userId, env: ENV });
    expect(second).toHaveLength(1); // sigue sin sellar → reintenta
    expect(getOauthGrant(db, userId, "gmail")?.broken_at).not.toBeNull();
  });

  it("invalid_grant: una vez sellado notified_at, NO se re-reporta (anti-spam)", async () => {
    const { db, userId } = seedDueGrant();
    const { backend } = fakeBackend();
    stubRefreshHttpError(400, JSON.stringify({ error: "invalid_grant" }));

    const first = await refreshGrantsForUser({ db, backend, userId, env: ENV });
    expect(first).toHaveLength(1);
    // El gateway entregó bien → sella. (Acá simulamos ese sello con el helper del store.)
    sealGrantNotified(db, userId, "gmail", "default");
    const second = await refreshGrantsForUser({ db, backend, userId, env: ENV });
    expect(second).toHaveLength(0); // ya avisado → no re-reporta
    expect(getOauthGrant(db, userId, "gmail")?.notified_at).not.toBeNull();
    expect(getOauthGrant(db, userId, "gmail")?.broken_at).not.toBeNull(); // sigue roto (estado)
  });

  it("error TRANSITORIO (HTTP 5xx): NO marca roto ni reporta (se reintenta)", async () => {
    const { db, userId } = seedDueGrant();
    const { backend } = fakeBackend();
    stubRefreshHttpError(503, "upstream unavailable");

    const broken = await refreshGrantsForUser({ db, backend, userId, env: ENV });

    expect(broken).toHaveLength(0);
    expect(getOauthGrant(db, userId, "gmail")?.broken_at).toBeNull(); // sigue sano
  });

  it("error TRANSITORIO (red/timeout, fetch tira): NO marca roto ni reporta", async () => {
    const { db, userId } = seedDueGrant();
    const { backend } = fakeBackend();
    stubRefreshNetworkError();

    const broken = await refreshGrantsForUser({ db, backend, userId, env: ENV });

    expect(broken).toHaveLength(0);
    expect(getOauthGrant(db, userId, "gmail")?.broken_at).toBeNull();
  });

  it("un refresh que vuelve a andar limpia broken_at Y notified_at", async () => {
    const { db, userId } = seedDueGrant();
    const { backend } = fakeBackend();
    // Primero muere y se sella el aviso.
    stubRefreshHttpError(400, JSON.stringify({ error: "invalid_grant" }));
    await refreshGrantsForUser({ db, backend, userId, env: ENV });
    sealGrantNotified(db, userId, "gmail", "default");
    expect(getOauthGrant(db, userId, "gmail")?.broken_at).not.toBeNull();
    expect(getOauthGrant(db, userId, "gmail")?.notified_at).not.toBeNull();
    // Luego el usuario reconecta / el grant revive → el próximo refresh anda y limpia AMBOS.
    vi.unstubAllGlobals();
    stubRefreshFetch({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 });
    await refreshGrantsForUser({ db, backend, userId, env: ENV });
    expect(getOauthGrant(db, userId, "gmail")?.broken_at).toBeNull();
    expect(getOauthGrant(db, userId, "gmail")?.notified_at).toBeNull();
  });
});

describe("isInvalidGrant", () => {
  it("true sólo para el marcador invalid_grant; transitorios → false", () => {
    expect(isInvalidGrant(new Error('refresh HTTP 400: {"error":"invalid_grant"}'))).toBe(true);
    expect(isInvalidGrant(new Error("refresh HTTP 400: invalid_grant"))).toBe(true);
    // Transitorios / otros errores: NO.
    expect(isInvalidGrant(new Error("refresh HTTP 503: upstream unavailable"))).toBe(false);
    expect(isInvalidGrant(new Error("fetch failed"))).toBe(false);
    expect(isInvalidGrant(new Error('refresh HTTP 400: {"error":"invalid_request"}'))).toBe(false);
  });
});
