// E2E del oauth-server (Ola 5, cierre): el state-machine PKCE de punta a punta sobre HTTP real.
//
//  - Server REAL: `createOauthServer` montado en http.createServer, puerto efímero; requests por fetch.
//  - Backend fakeado: se inyecta `backendForUser: () => fakeBackend` (SessionBackend en memoria);
//    createVault + setStaticBearerCredential capturados — nunca tocamos infra de Anthropic.
//  - El intercambio code→token del provider (Google) se stubea: `fetch` se rutea por URL — las
//    llamadas al provider devuelven tokens canónicos; las del driver al localhost pasan al fetch real.
//  - Store real `:memory:`: enroll token real (single-use), grant + conexión escritos de verdad.
//
// Prueba el cableado del broker que los unit no tocan: /start valida el token y redirige con
// state+PKCE; /callback cambia el code por tokens, empuja el static_bearer al vault, persiste el
// grant (con refresh_token), marca el enroll token usado y registra la conexión.

import { createServer, type Server } from "node:http";
import net from "node:net";
import type { SessionBackend } from "@ceibo/agent";
import {
  addUser,
  createEnrollToken,
  getOauthGrant,
  listConnections,
  openDb,
  peekEnrollToken,
} from "@ceibo/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOauthServer } from "./engine.ts";

// Captura de los static_bearer que el broker empuja al vault (la salida a Anthropic, fakeada).
const h = vi.hoisted(() => ({
  bearers: [] as Array<{ vaultId: string; mcpServerUrl: string; token: string }>,
}));

// fakeBackend: la costura SessionBackend en memoria, inyectada como dep (en vez de mockear el
// módulo). createVault devuelve un id fijo; setStaticBearerCredential captura el bearer que el
// broker empuja al vault (la salida a Anthropic). El resto no lo ejercita este e2e.
const fakeBackend: SessionBackend = {
  createVault: async () => "vault-fake",
  setStaticBearerCredential: async (vaultId, cred) => {
    h.bearers.push({ vaultId, mcpServerUrl: cred.mcpServerUrl, token: cred.token });
  },
  revokeOauthCredential: async () => false,
  setSessionAgentConfig: async () => {},
  createSession: async () => "sess-fake",
  reuseOrCreate: async () => "sess-fake",
  attach: () => ({ send: async () => {}, interrupt: async () => {}, close: () => {} }),
};

type Db = ReturnType<typeof openDb>;

const REDIRECT_URI = "https://oauth.test/oauth/callback";
const ENV = {
  GOOGLE_CLIENT_ID: "gcid",
  GOOGLE_CLIENT_SECRET: "gsecret",
  GMAIL_MCP_URL: "https://mcp.test/mcp/gmail/SEC",
} as unknown as NodeJS.ProcessEnv;

let db: Db;
let httpServer: Server;
let base: string;
let userId: number;
let realFetch: typeof globalThis.fetch;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

beforeEach(async () => {
  h.bearers.length = 0;
  db = openDb(":memory:");
  userId = addUser(db, "alice").id;

  // fetch ruteado: provider Google → tokens canónicos; cualquier otra URL (el driver al
  // localhost) → fetch real. Así el e2e habla HTTP de verdad sin que el stub se lo coma.
  realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "at-123",
            refresh_token: "rt-456",
            expires_in: 3600,
            scope: "s1 s2",
          }),
          text: async () => "",
        } as Response;
      }
      // Lookup de la cuenta real (gmail.getProfile) tras el token exchange.
      if (String(url).includes("gmail.googleapis.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ emailAddress: "alice@gmail.com" }),
          text: async () => "",
        } as Response;
      }
      return realFetch(url, init);
    }),
  );

  const oauth = createOauthServer({
    env: ENV,
    backendForUser: () => fakeBackend,
    db,
    redirectUri: REDIRECT_URI,
  });
  const port = await freePort();
  httpServer = createServer(oauth.handle);
  await new Promise<void>((r) => httpServer.listen(port, "127.0.0.1", r));
  base = `http://127.0.0.1:${port}`;
});

afterEach(() => {
  httpServer.close();
  db.close();
  vi.unstubAllGlobals();
});

describe("oauth-server e2e — enrollment PKCE de punta a punta", () => {
  it("start → callback: cambia el code por tokens, empuja el bearer al vault y persiste el grant", async () => {
    const token = createEnrollToken(db, userId, "gmail", "personal");

    // /start: valida el token y redirige al consentimiento del provider con state + PKCE.
    const start = await fetch(`${base}/oauth/start?t=${token}`, { redirect: "manual" });
    expect(start.status).toBe(302);
    const location = start.headers.get("location") ?? "";
    const authUrl = new URL(location);
    expect(authUrl.origin + authUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authUrl.searchParams.get("code_challenge")).toBeTruthy(); // PKCE armado
    const state = authUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    // Todavía no consumido: el single-use se quema al COMPLETAR el callback, no al abrir /start.
    expect(peekEnrollToken(db, token)).toBeTruthy();

    // /callback: cambia el code por tokens (provider stubeado) y completa el enrollment.
    const cb = await fetch(`${base}/oauth/callback?code=the-code&state=${state}`, { redirect: "manual" });
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain("Listo");

    // El static_bearer (access_token corto) se empujó al vault, con la URL del MCP por perfil.
    expect(h.bearers).toHaveLength(1);
    expect(h.bearers[0]?.token).toBe("at-123");
    expect(h.bearers[0]?.mcpServerUrl).toBe("https://mcp.test/mcp/gmail/personal/SEC");

    // El grant (refresh_token incluido) quedó en NUESTRA DB; la conexión registrada.
    const grant = getOauthGrant(db, userId, "gmail", "personal");
    expect(grant?.refresh_token).toBe("rt-456");
    expect(grant?.access_token).toBe("at-123");
    expect(grant?.account).toBe("alice@gmail.com"); // cuenta real capturada en el callback
    expect(listConnections(db, userId).some((c) => c.service === "gmail" && c.profile === "personal")).toBe(
      true,
    );
    // Enroll token: single-use consumido al completar.
    expect(peekEnrollToken(db, token)).toBeUndefined();
  });

  it("callback con state desconocido → 400 y no escribe grant ni bearer", async () => {
    const cb = await fetch(`${base}/oauth/callback?code=x&state=inexistente`, { redirect: "manual" });
    expect(cb.status).toBe(400);
    expect(await cb.text()).toContain("Sesión desconocida");
    expect(h.bearers).toHaveLength(0);
    expect(getOauthGrant(db, userId, "gmail", "personal")).toBeUndefined();
  });

  it("start con token inválido → 400, sin redirect", async () => {
    const start = await fetch(`${base}/oauth/start?t=no-existe`, { redirect: "manual" });
    expect(start.status).toBe(400);
    expect(start.headers.get("location")).toBeNull();
  });
});
