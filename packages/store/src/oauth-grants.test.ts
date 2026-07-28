import { describe, expect, it } from "vitest";
import {
  addUser,
  deleteOauthGrant,
  getOauthGrant,
  grantNeedsNotify,
  listConnections,
  listGrantsForUser,
  listGrantsMissingAccount,
  listRefreshableGrantsForUser,
  markGrantBroken,
  type OauthGrant,
  openDb,
  recordConnection,
  removeConnection,
  sealGrantNotified,
  setOauthGrantAccount,
  upsertOauthGrant,
} from "./index.ts";

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
  expires_at: "2030-01-01T00:00:00.000Z",
  scope: "s",
  ...over,
});

describe("connections", () => {
  it("record idempotente + list + remove (perfil y todo el servicio)", () => {
    const d = db();
    const u = addUser(d, "demo");
    recordConnection(d, u.id, "gmail");
    recordConnection(d, u.id, "gmail"); // idempotente (upsert)
    recordConnection(d, u.id, "gmail", "work");
    expect(listConnections(d, u.id)).toEqual([
      { service: "gmail", profile: "default" },
      { service: "gmail", profile: "work" },
    ]);
    removeConnection(d, u.id, "gmail", "work"); // un perfil
    expect(listConnections(d, u.id)).toEqual([{ service: "gmail", profile: "default" }]);
    recordConnection(d, u.id, "gmail", "work");
    removeConnection(d, u.id, "gmail"); // todos los perfiles del servicio
    expect(listConnections(d, u.id)).toEqual([]);
  });
});

describe("oauth grants", () => {
  it("upsert crea y luego actualiza (conserva refresh_token si el nuevo es null)", () => {
    const d = db();
    const u = addUser(d, "demo");
    upsertOauthGrant(d, grant(u.id, { access_token: "at1", refresh_token: "rt1" }));
    expect(getOauthGrant(d, u.id, "gmail")?.access_token).toBe("at1");
    // update con refresh_token null → conserva el viejo (COALESCE)
    upsertOauthGrant(d, grant(u.id, { access_token: "at2", refresh_token: null }));
    const g = getOauthGrant(d, u.id, "gmail");
    expect(g?.access_token).toBe("at2");
    expect(g?.refresh_token).toBe("rt1");
  });

  it("listGrantsForUser ordena por service, profile", () => {
    const d = db();
    const u = addUser(d, "demo");
    upsertOauthGrant(d, grant(u.id, { service: "notion" }));
    upsertOauthGrant(d, grant(u.id, { service: "gmail" }));
    expect(listGrantsForUser(d, u.id).map((g) => g.service)).toEqual(["gmail", "notion"]);
  });

  it("delete por perfil y por servicio entero", () => {
    const d = db();
    const u = addUser(d, "demo");
    upsertOauthGrant(d, grant(u.id, { profile: "default" }));
    upsertOauthGrant(d, grant(u.id, { profile: "work" }));
    deleteOauthGrant(d, u.id, "gmail", "work");
    expect(listGrantsForUser(d, u.id).map((g) => g.profile)).toEqual(["default"]);
    deleteOauthGrant(d, u.id, "gmail");
    expect(listGrantsForUser(d, u.id)).toEqual([]);
  });

  it("account: se persiste, COALESCE lo conserva en refresh, setter lo actualiza", () => {
    const d = db();
    const u = addUser(d, "demo");
    // Enrolar con cuenta.
    upsertOauthGrant(d, grant(u.id, { account: "user@example.com" }));
    expect(getOauthGrant(d, u.id, "gmail")?.account).toBe("user@example.com");
    // Un refresh (account null) NO pisa la cuenta existente (COALESCE).
    upsertOauthGrant(d, grant(u.id, { account: null, access_token: "at2" }));
    expect(getOauthGrant(d, u.id, "gmail")?.account).toBe("user@example.com");
    // El setter la cambia (y puede limpiarla).
    setOauthGrantAccount(d, u.id, "gmail", "default", "otra@gmail.com");
    expect(getOauthGrant(d, u.id, "gmail")?.account).toBe("otra@gmail.com");
    setOauthGrantAccount(d, u.id, "gmail", "default", null);
    expect(getOauthGrant(d, u.id, "gmail")?.account).toBeNull();
  });

  it("listGrantsMissingAccount: solo los grants con account NULL", () => {
    const d = db();
    const u = addUser(d, "demo");
    upsertOauthGrant(d, grant(u.id, { service: "gmail", account: "user@example.com" }));
    upsertOauthGrant(d, grant(u.id, { service: "drive", account: null }));
    upsertOauthGrant(d, grant(u.id, { service: "notion", account: null }));
    expect(listGrantsMissingAccount(d).map((g) => g.service)).toEqual(["drive", "notion"]);
  });

  it("broken_at: markGrantBroken transiciona sano→roto una sola vez (anti-spam)", () => {
    const d = db();
    const u = addUser(d, "demo");
    upsertOauthGrant(d, grant(u.id));
    expect(getOauthGrant(d, u.id, "gmail")?.broken_at).toBeNull();
    // 1ª vez: sano→roto → true, y broken_at queda seteado.
    expect(markGrantBroken(d, u.id, "gmail", "default")).toBe(true);
    expect(getOauthGrant(d, u.id, "gmail")?.broken_at).not.toBeNull();
    // 2ª vez (ya roto): false (guard anti-spam) y no re-pisa el broken_at.
    const firstBrokenAt = getOauthGrant(d, u.id, "gmail")?.broken_at;
    expect(markGrantBroken(d, u.id, "gmail", "default")).toBe(false);
    expect(getOauthGrant(d, u.id, "gmail")?.broken_at).toBe(firstBrokenAt);
  });

  it("un upsert exitoso (reconexión/refresh OK) limpia broken_at Y notified_at", () => {
    const d = db();
    const u = addUser(d, "demo");
    upsertOauthGrant(d, grant(u.id));
    markGrantBroken(d, u.id, "gmail", "default");
    sealGrantNotified(d, u.id, "gmail", "default");
    expect(getOauthGrant(d, u.id, "gmail")?.broken_at).not.toBeNull();
    expect(getOauthGrant(d, u.id, "gmail")?.notified_at).not.toBeNull();
    // upsert con broken_at/notified_at null (reconexión o refresh que anda) limpia AMBOS.
    upsertOauthGrant(d, grant(u.id, { broken_at: null, notified_at: null, access_token: "at-nuevo" }));
    expect(getOauthGrant(d, u.id, "gmail")?.broken_at).toBeNull();
    expect(getOauthGrant(d, u.id, "gmail")?.notified_at).toBeNull();
  });

  it("notified_at: grantNeedsNotify = roto y sin avisar; sealGrantNotified lo apaga", () => {
    const d = db();
    const u = addUser(d, "demo");
    upsertOauthGrant(d, grant(u.id));
    // Sano → no necesita aviso.
    expect(grantNeedsNotify(d, u.id, "gmail", "default")).toBe(false);
    // Roto y sin sellar → necesita aviso (el broker lo reintenta cada sweep).
    markGrantBroken(d, u.id, "gmail", "default");
    expect(grantNeedsNotify(d, u.id, "gmail", "default")).toBe(true);
    // Entregado (sellado) → ya no necesita aviso (anti-spam).
    sealGrantNotified(d, u.id, "gmail", "default");
    expect(grantNeedsNotify(d, u.id, "gmail", "default")).toBe(false);
    expect(getOauthGrant(d, u.id, "gmail")?.notified_at).not.toBeNull();
  });

  it("sealGrantNotified no sella un grant sano (broken_at NULL) — evita sellar tras revivir", () => {
    const d = db();
    const u = addUser(d, "demo");
    upsertOauthGrant(d, grant(u.id)); // sano
    sealGrantNotified(d, u.id, "gmail", "default"); // no-op: broken_at es NULL
    expect(getOauthGrant(d, u.id, "gmail")?.notified_at).toBeNull();
  });

  it("broken_at: markGrantBroken es POR grant (service+profile), no pisa otras cuentas", () => {
    const d = db();
    const u = addUser(d, "demo");
    upsertOauthGrant(d, grant(u.id, { profile: "work" }));
    upsertOauthGrant(d, grant(u.id, { profile: "personal" }));
    expect(markGrantBroken(d, u.id, "gmail", "work")).toBe(true);
    // "work" roto; "personal" sigue sano.
    expect(getOauthGrant(d, u.id, "gmail", "work")?.broken_at).not.toBeNull();
    expect(getOauthGrant(d, u.id, "gmail", "personal")?.broken_at).toBeNull();
  });

  it("markGrantBroken sobre un grant inexistente → false (no crea filas)", () => {
    const d = db();
    const u = addUser(d, "demo");
    expect(markGrantBroken(d, u.id, "gmail", "default")).toBe(false);
    expect(listGrantsForUser(d, u.id)).toEqual([]);
  });

  it("listRefreshableGrantsForUser: solo los con refresh_token+expiry que vencen antes del corte", () => {
    const d = db();
    const u = addUser(d, "demo");
    upsertOauthGrant(d, grant(u.id, { service: "gmail", expires_at: "2020-01-01T00:00:00.000Z" })); // vencido
    upsertOauthGrant(d, grant(u.id, { service: "drive", expires_at: "2099-01-01T00:00:00.000Z" })); // lejos
    upsertOauthGrant(d, grant(u.id, { service: "notion", refresh_token: null, expires_at: null })); // no refrescable
    const due = listRefreshableGrantsForUser(d, u.id, "2026-01-01T00:00:00.000Z");
    expect(due.map((g) => g.service)).toEqual(["gmail"]);
  });
});

describe("oauth grants — cifrado at-rest (A3)", () => {
  it("la columna en disco NO está en claro; getOauthGrant devuelve el plaintext", () => {
    const d = db();
    const u = addUser(d, "demo");
    upsertOauthGrant(d, grant(u.id, { access_token: "ACCESS-CLARO", refresh_token: "REFRESH-CLARO" }));
    // Raw: lo que está en la columna es cifrado, no el plaintext.
    const raw = d
      .prepare("SELECT access_token, refresh_token FROM oauth_grants WHERE user_id = ?")
      .get(u.id) as { access_token: string; refresh_token: string };
    expect(raw.access_token).not.toBe("ACCESS-CLARO");
    expect(raw.refresh_token).not.toBe("REFRESH-CLARO");
    // Pero el getter descifra → plaintext de vuelta.
    const g = getOauthGrant(d, u.id, "gmail");
    expect(g?.access_token).toBe("ACCESS-CLARO");
    expect(g?.refresh_token).toBe("REFRESH-CLARO");
  });

  it("refresh_token null se guarda null (no se cifra)", () => {
    const d = db();
    const u = addUser(d, "demo");
    upsertOauthGrant(d, grant(u.id, { refresh_token: null }));
    const raw = d.prepare("SELECT refresh_token FROM oauth_grants WHERE user_id = ?").get(u.id) as {
      refresh_token: string | null;
    };
    expect(raw.refresh_token).toBeNull();
    expect(getOauthGrant(d, u.id, "gmail")?.refresh_token).toBeNull();
  });

  it("fila vieja en claro (decrypt falla) → tratada como no conectada (undefined / excluida)", () => {
    const d = db();
    const u = addUser(d, "demo");
    // Insertamos a mano un grant con tokens EN CLARO (simula fila pre-cifrado).
    d.prepare(
      `INSERT INTO oauth_grants (user_id, service, profile, provider, mcp_url, display_name, account, refresh_token, access_token, expires_at, scope)
       VALUES (?, 'gmail', 'default', 'google', 'https://mcp/gmail', 'Gmail', NULL, 'rt-claro', 'at-claro', '2030-01-01T00:00:00.000Z', 's')`,
    ).run(u.id);
    expect(getOauthGrant(d, u.id, "gmail")).toBeUndefined();
    expect(listGrantsForUser(d, u.id)).toEqual([]);
  });
});
