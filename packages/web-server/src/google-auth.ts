// Google Sign-In (Fase 4.5) — login web por OIDC authorization-code. Lógica de protocolo,
// pura y testeable; las rutas HTTP (start/callback) + la cookie + la resolución del usuario
// viven en web.ts (que tiene db/sessionKey/helpers). Todo corre en el web-server (nuestra
// box), NO en MA → el client_secret se queda en vps.example.com.
//
// Por qué NO verificamos la firma RS256/JWKS del id_token: el token llega DERECHO del token
// endpoint de Google sobre TLS, en respuesta al code que canjeamos con nuestro client_secret
// (flujo server-side). Google documenta que en ese caso el id_token es confiable sin
// re-verificar la firma. Validamos igual aud/iss/exp/email_verified (defensa en profundidad).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const VALID_ISS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const STATE_TTL_MS = 10 * 60 * 1000; // ventana para completar el login en Google

export type GoogleAuthConfig = {
  clientId: string;
  clientSecret: string;
  /** `<WEB_PUBLIC_ORIGIN>/api/auth/google/callback` — tiene que matchear el redirect URI
   *  registrado en el OAuth client de Google Cloud Console. */
  redirectUri: string;
};

// --- state CSRF (stateless, firmado) ------------------------------------
// El `state` ata el callback al start sin storage server-side: `<exp>.<nonce>.<hmac>`, con
// hmac = HMAC(key, "<exp>.<nonce>"). El nonce (base64url, sin `.`) lo hace único; el exp lo
// caduca. La key es WEB_SESSION_KEY (la misma de la cookie) — un secreto menos que mantener.

export function signState(key: string, now: number): string {
  const exp = now + STATE_TTL_MS;
  const nonce = randomBytes(16).toString("base64url");
  const body = `${exp}.${nonce}`;
  const mac = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyState(state: string, key: string, now: number): boolean {
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [exp, nonce, mac] = parts;
  if (exp === undefined || nonce === undefined || mac === undefined) return false;
  const want = createHmac("sha256", key).update(`${exp}.${nonce}`).digest("base64url");
  const got = Buffer.from(mac);
  const wantBuf = Buffer.from(want);
  if (got.length !== wantBuf.length || !timingSafeEqual(got, wantBuf)) return false;
  const expN = Number(exp);
  return Number.isInteger(expN) && expN >= now;
}

// --- authorize URL ------------------------------------------------------
export function buildAuthUrl(cfg: GoogleAuthConfig, state: string): string {
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email");
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "select_account"); // siempre deja elegir cuenta
  return u.toString();
}

// --- intercambio code → id_token ----------------------------------------
export async function exchangeCode(cfg: GoogleAuthConfig, code: string): Promise<string> {
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
  });
  const r = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`google token exchange ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = (await r.json()) as { id_token?: string };
  if (!j.id_token) throw new Error("google token: respuesta sin id_token");
  return j.id_token;
}

// --- decode + validación de claims --------------------------------------
export type IdClaims = {
  iss?: string;
  aud?: string;
  exp?: number;
  email?: string;
  email_verified?: boolean | string;
  sub?: string;
};

/** Decodifica el payload del JWT (NO verifica firma — ver cabecera del módulo). */
export function decodeIdToken(idToken: string): IdClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) throw new Error("id_token mal formado");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as IdClaims;
}

/** Valida aud/iss/exp/email_verified y devuelve el email verificado (lowercased), o throw. */
export function emailFromClaims(claims: IdClaims, clientId: string, now: number): string {
  if (claims.aud !== clientId) throw new Error("id_token: aud no coincide con el client_id");
  if (!claims.iss || !VALID_ISS.has(claims.iss)) throw new Error("id_token: iss inválido");
  if (!claims.exp || claims.exp * 1000 < now) throw new Error("id_token: expirado");
  // Google manda email_verified como bool (id_token) — toleramos el string "true" por las dudas.
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    throw new Error("id_token: email no verificado por Google");
  }
  const email = (claims.email ?? "").trim().toLowerCase();
  if (!email) throw new Error("id_token: sin email");
  return email;
}
