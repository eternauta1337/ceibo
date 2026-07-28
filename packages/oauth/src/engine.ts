// Motor del servicio OAuth — el state-machine del enrollment PKCE, SIN side-effects de
// arranque. `createOauthServer(deps)` devuelve el request handler que el bootstrap
// (`server.ts`) monta en un `http.createServer`; este módulo se puede importar en tests sin
// leer .env ni abrir un puerto (la costura del e2e — Ola 5).
//
// Es NUESTRO broker: el `client_secret` de la app y los refresh_token viven sólo acá (nuestra
// infra); al vault de Anthropic se le manda SÓLO un `static_bearer` corto. Rutas:
//
//   GET /oauth/start?t=<token>      valida el token de UN SOLO USO (lo minteó el store vía
//                                   `ceibo oauth enroll <handle> <svc>`), resuelve
//                                   service→provider, arma PKCE si aplica, guarda el state en
//                                   memoria y redirige al consentimiento del provider.
//   GET /oauth/callback?code&state  cambia el code por tokens, pushea un `static_bearer` al
//                                   vault del usuario y guarda el grant (refresh_token incluido)
//                                   en la DB de la box.
//
// El token de /start ata el flujo a un usuario concreto: sin él, cualquiera con el link podría
// linkear SU cuenta externa al vault de otro (confused-deputy). Ningún valor de token (del
// provider ni del vault) se loguea jamás.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionBackend } from "@ceibo/agent";
import {
  type Db,
  getUser,
  markEnrollTokenUsed,
  peekEnrollToken,
  recordConnection,
  setUserLocalVault,
  setUserVault,
  type User,
  upsertOauthGrant,
  vaultIdForUser,
} from "@ceibo/store";
import {
  buildAuthUrl,
  DEFAULT_PROFILE,
  exchangeCode,
  fetchProviderAccount,
  knownProvider,
  knownService,
  makePkce,
  makeState,
  mcpUrlForProfile,
  type OAuthProvider,
} from "./index.ts";
import { esc, providerCredsFromEnv, sweepExpired } from "./server-logic.ts";

/** Dependencias que el bootstrap (`server.ts`) construye desde el entorno y le inyecta. */
export interface OauthServerDeps {
  env: NodeJS.ProcessEnv;
  backendForUser: (user: User) => SessionBackend;
  db: Db;
  redirectUri: string; // OAUTH_REDIRECT_URI
}

/** El handler HTTP que el bootstrap monta en `http.createServer`. */
export interface OauthServer {
  handle(req: IncomingMessage, res: ServerResponse): void;
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/** Construye el motor del servicio OAuth. Sin side-effects: no lee .env ni abre puerto. */
export function createOauthServer(deps: OauthServerDeps): OauthServer {
  const { env, backendForUser, db, redirectUri: REDIRECT_URI } = deps;

  /** Credenciales de la app OAuth de un provider (de env). Faltan → provider no enrolable. */
  function providerCreds(p: OAuthProvider): { clientId: string; clientSecret: string } | undefined {
    return providerCredsFromEnv(p, env);
  }

  // State pendiente entre /start y /callback. En memoria (el flujo dura segundos);
  // un restart cancela enrollments en curso — se re-emite el link y listo.
  interface Pending {
    userId: number;
    service: string;
    profile: string; // multi-cuenta (Fase 7): qué perfil del servicio se está conectando
    provider: string;
    verifier?: string; // solo si el provider usa PKCE
    scopes: string[];
    token: string; // el enroll token; se marca usado recién al completar el callback
    createdAt: number;
  }
  const pending = new Map<string, Pending>();
  const PENDING_TTL_MS = 15 * 60 * 1000;

  function sweepPending(): void {
    sweepExpired(pending, Date.now(), PENDING_TTL_MS);
  }

  function html(res: ServerResponse, status: number, title: string, body: string): void {
    const t = esc(title);
    const b = esc(body);
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>${t}</title>` +
        `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center"><h2>${t}</h2><p>${b}</p></body>`,
    );
  }

  async function handleStart(url: URL, res: ServerResponse): Promise<void> {
    const token = url.searchParams.get("t");
    if (!token) return html(res, 400, "Link inválido", "Falta el token de enrollment.");

    // PEEK (no consumir): validamos el token pero NO lo marcamos usado acá. El consumo
    // single-use se hace al COMPLETAR el OAuth (en /callback) — así un prefetch del link
    // (ej. el preview de Telegram) no lo quema antes de que la persona haga click.
    const claim = peekEnrollToken(db, token);
    if (!claim) return html(res, 400, "Link inválido o vencido", "Pedí uno nuevo y reintentá.");

    const svc = knownService(claim.service);
    if (!svc) return html(res, 500, "Servicio desconocido", `No conozco el servicio "${claim.service}".`);
    const provider = knownProvider(svc.provider);
    if (!provider) return html(res, 500, "Provider desconocido", `Servicio mal configurado.`);
    const creds = providerCreds(provider);
    if (!creds)
      return html(
        res,
        500,
        "Servicio sin configurar",
        `Falta ${provider.clientIdEnv}/${provider.clientSecretEnv}.`,
      );

    const state = makeState();
    let challenge: string | undefined;
    let verifier: string | undefined;
    if (provider.usePkce) {
      const pkce = makePkce();
      challenge = pkce.challenge;
      verifier = pkce.verifier;
    }
    pending.set(state, {
      userId: claim.userId,
      service: claim.service,
      profile: claim.profile,
      provider: svc.provider,
      verifier,
      scopes: svc.scopes,
      token,
      createdAt: Date.now(),
    });
    sweepPending();

    const authUrl = buildAuthUrl({
      provider,
      clientId: creds.clientId,
      redirectUri: REDIRECT_URI,
      scopes: svc.scopes,
      state,
      challenge,
    });
    console.log(
      dim(
        `start: user=${claim.userId} service=${claim.service}` +
          `${claim.profile === DEFAULT_PROFILE ? "" : `/${claim.profile}`} (${svc.provider}) → redirect`,
      ),
    );
    res.writeHead(302, { location: authUrl });
    res.end();
  }

  async function handleCallback(url: URL, res: ServerResponse): Promise<void> {
    const err = url.searchParams.get("error");
    if (err) return html(res, 400, "Autorización cancelada", `El proveedor devolvió: ${err}.`);

    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const p = pending.get(state);
    if (!p)
      return html(
        res,
        400,
        "Sesión desconocida",
        "El enrollment venció o ya se completó. Pedí un link nuevo.",
      );
    pending.delete(state); // single-use
    if (!code) return html(res, 400, "Falta el code", "Reintentá el enrollment.");

    const svc = knownService(p.service);
    if (!svc) return html(res, 500, "Servicio desconocido", `No conozco "${p.service}".`);
    const provider = knownProvider(p.provider);
    if (!provider) return html(res, 500, "Provider desconocido", "Servicio mal configurado.");
    const creds = providerCreds(provider);
    if (!creds) return html(res, 500, "Servicio sin configurar", "Faltan las credenciales del provider.");
    const baseMcpUrl = env[svc.mcpUrlEnv];
    if (!baseMcpUrl)
      return html(res, 500, "Servicio sin configurar", `Falta ${svc.mcpUrlEnv} en el .env del oauth.`);
    // Perfil no-default → `?profile=<perfil>` (key con la que el vault distingue cuentas).
    const mcpUrl = mcpUrlForProfile(baseMcpUrl, p.profile);

    const user = getUser(db, p.userId);
    if (!user) return html(res, 500, "Usuario inexistente", "El usuario fue borrado durante el flujo.");

    const tokens = await exchangeCode({
      provider,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      code,
      verifier: p.verifier,
      redirectUri: REDIRECT_URI,
    });

    // Vault del usuario para SU backend activo (lazy: lo creamos si todavía no tenía). Cada backend
    // tiene su propio vault con IDs incompatibles (MA: vlt_011C…; local/archima: UUID/slug) →
    // persistimos al column que le corresponde y nunca pisamos el del otro. (Hoy el oauth-server
    // tira para 'local' porque archima no está cableado en este proceso; cuando se cablee, esto ya
    // provisiona el vault correcto en vez de empujar la cred a un vault MA inexistente.)
    let vaultId = vaultIdForUser(user) ?? undefined;
    if (!vaultId) {
      vaultId = await backendForUser(user).createVault(`ceibo · ${user.handle}`);
      if (user.backend_mode === "local") setUserLocalVault(db, user.id, vaultId);
      else setUserVault(db, user.id, vaultId);
    }

    // El perfil entra al display_name de la cred del vault (visible al auditar), salvo
    // el default que queda como hasta ahora.
    const profileSuffix = p.profile === DEFAULT_PROFILE ? "" : ` (${p.profile})`;
    const displayName = `${svc.displayName}${profileSuffix} · ${user.handle}`;

    // Al vault de Anthropic SOLO le mandamos un static_bearer (access_token corto, sin
    // refresh_token ni client_secret). El refresh lo hace nuestro broker (abajo).
    await backendForUser(user).setStaticBearerCredential(vaultId, {
      mcpServerUrl: mcpUrl,
      displayName,
      token: tokens.accessToken,
    });

    // Cuenta externa real (ej. user@example.com / workspace de Notion), para mostrarla en el
    // detalle de Conexiones. Best-effort: si el provider no la expone con su scope o falla, null.
    const account = await fetchProviderAccount({
      service: p.service,
      accessToken: tokens.accessToken,
    });

    // El grant (refresh_token + access_token + expiry) vive en NUESTRA infra (la box).
    // refresh_token null = provider sin refresh (Notion: el token no expira).
    upsertOauthGrant(db, {
      user_id: user.id,
      service: p.service,
      profile: p.profile,
      provider: p.provider,
      mcp_url: mcpUrl,
      display_name: displayName,
      account,
      broken_at: null, // reconexión fresca = grant sano: limpia cualquier rotura previa (invalid_grant)
      notified_at: null, // y limpia el sello de notif → si vuelve a romperse, se avisa de nuevo
      refresh_token: tokens.refreshToken ?? null,
      access_token: tokens.accessToken,
      expires_at: tokens.expiresAt ?? null,
      scope: tokens.scope,
    });

    markEnrollTokenUsed(db, p.token); // recién acá: single-use al COMPLETAR (no al abrir)
    recordConnection(db, user.id, p.service, p.profile); // vista para /connections (la auth real es el vault)
    console.log(
      dim(`callback: ${svc.displayName}${profileSuffix} conectado para user=${user.id} (${user.handle})`),
    );
    html(
      res,
      200,
      "Listo ✅",
      `Conectaste ${svc.displayName}${profileSuffix}. Cerrá esta pestaña y volvé al chat.`,
    );
  }

  // Request handler que el bootstrap monta en http.createServer. El refresh NO vive acá: es
  // lazy y lo dispara el gateway al preparar el turno de un usuario activo
  // (`refreshGrantsForUser`). Este servicio sólo hace el enrollment (escribe el grant + el
  // primer static_bearer).
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = (async () => {
      if (req.method !== "GET") return html(res, 405, "Método no permitido", "Usá GET.");
      if (url.pathname === "/oauth/start") return handleStart(url, res);
      if (url.pathname === "/oauth/callback") return handleCallback(url, res);
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("ok");
      }
      return html(res, 404, "No encontrado", "Ruta desconocida.");
    })();
    route.catch((e) => {
      console.error(dim(`error: ${(e as Error)?.message ?? String(e)}`));
      if (!res.headersSent) html(res, 500, "Error interno", "Algo falló en el enrollment. Reintentá.");
    });
  };

  return { handle };
}
