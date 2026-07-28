import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthUrl,
  decodeIdToken,
  emailFromClaims,
  exchangeCode,
  type GoogleAuthConfig,
  signState,
  verifyState,
} from "./google-auth.ts";

const KEY = "test-session-key";
const CFG: GoogleAuthConfig = {
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: "secret",
  redirectUri: "https://example.test/api/auth/google/callback",
};

// Arma un id_token de juguete (header.payload.firma) — sólo nos importa el payload, porque
// no verificamos firma (ver cabecera del módulo). La firma es un placeholder.
function fakeIdToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.firma`;
}

describe("state CSRF firmado", () => {
  it("verifica un state recién firmado", () => {
    const now = 1_000_000;
    const s = signState(KEY, now);
    expect(verifyState(s, KEY, now + 1000)).toBe(true);
  });

  it("rechaza state expirado", () => {
    const now = 1_000_000;
    const s = signState(KEY, now);
    expect(verifyState(s, KEY, now + 11 * 60 * 1000)).toBe(false); // TTL 10min
  });

  it("rechaza state con otra key (firma inválida)", () => {
    const s = signState(KEY, 1_000_000);
    expect(verifyState(s, "otra-key", 1_000_500)).toBe(false);
  });

  it("rechaza state manipulado", () => {
    const s = signState(KEY, 1_000_000);
    expect(verifyState(`${s}x`, KEY, 1_000_500)).toBe(false);
    expect(verifyState("a.b.c", KEY, 1_000_500)).toBe(false);
    expect(verifyState("malformado", KEY, 1_000_500)).toBe(false);
  });

  it("dos states son distintos (nonce)", () => {
    expect(signState(KEY, 1_000_000)).not.toBe(signState(KEY, 1_000_000));
  });
});

describe("buildAuthUrl", () => {
  it("arma la URL con los params correctos", () => {
    const u = new URL(buildAuthUrl(CFG, "STATE123"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe(CFG.clientId);
    expect(u.searchParams.get("redirect_uri")).toBe(CFG.redirectUri);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid email");
    expect(u.searchParams.get("state")).toBe("STATE123");
    expect(u.searchParams.get("prompt")).toBe("select_account");
  });
});

describe("emailFromClaims", () => {
  const now = 1_000_000_000_000;
  const base = {
    iss: "https://accounts.google.com",
    aud: CFG.clientId,
    exp: Math.floor(now / 1000) + 600,
    email: "Alicia@Gmail.com",
    email_verified: true,
  };

  it("devuelve el email lowercased de un id_token válido", () => {
    const claims = decodeIdToken(fakeIdToken(base));
    expect(emailFromClaims(claims, CFG.clientId, now)).toBe("alicia@gmail.com");
  });

  it("tolera email_verified como string 'true'", () => {
    const claims = decodeIdToken(fakeIdToken({ ...base, email_verified: "true" }));
    expect(emailFromClaims(claims, CFG.clientId, now)).toBe("alicia@gmail.com");
  });

  it("rechaza aud que no es nuestro client_id", () => {
    const claims = decodeIdToken(fakeIdToken({ ...base, aud: "otro.apps.googleusercontent.com" }));
    expect(() => emailFromClaims(claims, CFG.clientId, now)).toThrow(/aud/);
  });

  it("rechaza iss inválido", () => {
    const claims = decodeIdToken(fakeIdToken({ ...base, iss: "https://evil.example" }));
    expect(() => emailFromClaims(claims, CFG.clientId, now)).toThrow(/iss/);
  });

  it("rechaza id_token expirado", () => {
    const claims = decodeIdToken(fakeIdToken({ ...base, exp: Math.floor(now / 1000) - 10 }));
    expect(() => emailFromClaims(claims, CFG.clientId, now)).toThrow(/expirado/);
  });

  it("rechaza email no verificado", () => {
    const claims = decodeIdToken(fakeIdToken({ ...base, email_verified: false }));
    expect(() => emailFromClaims(claims, CFG.clientId, now)).toThrow(/verificado/);
  });

  it("rechaza id_token mal formado", () => {
    expect(() => decodeIdToken("no-es-un-jwt")).toThrow(/mal formado/);
  });

  it("rechaza claims sin email", () => {
    const { email, ...sinEmail } = base;
    const claims = decodeIdToken(fakeIdToken(sinEmail));
    expect(() => emailFromClaims(claims, CFG.clientId, now)).toThrow(/sin email/);
  });
});

describe("exchangeCode", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (resp: { ok?: boolean; status?: number; json?: unknown; text?: string }) => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return {
          ok: resp.ok ?? true,
          status: resp.status ?? 200,
          json: async () => resp.json,
          text: async () => resp.text ?? "",
        } as Response;
      }),
    );
    return calls;
  };

  it("POSTea el code form-urlencoded con client_id/secret y devuelve el id_token", async () => {
    const calls = stub({ json: { id_token: "ID.TOK.EN" } });
    const tok = await exchangeCode(CFG, "the-code");
    expect(tok).toBe("ID.TOK.EN");
    const call = calls[0];
    if (!call) throw new Error("fetch no fue llamado");
    const { url, init } = call;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const b = new URLSearchParams(init.body as string);
    expect(b.get("code")).toBe("the-code");
    expect(b.get("grant_type")).toBe("authorization_code");
    expect(b.get("client_id")).toBe(CFG.clientId);
    expect(b.get("client_secret")).toBe(CFG.clientSecret);
  });

  it("HTTP no-ok → tira con status", async () => {
    stub({ ok: false, status: 400, text: "invalid_grant" });
    await expect(exchangeCode(CFG, "x")).rejects.toThrow(/400/);
  });

  it("respuesta sin id_token → tira", async () => {
    stub({ json: {} });
    await expect(exchangeCode(CFG, "x")).rejects.toThrow(/sin id_token/);
  });
});
