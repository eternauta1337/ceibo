// @ceibo/oauth — lógica del enrollment OAuth, generalizada por PROVIDER.
//
// Fase 4 nació atado a Google (un solo AUTH/TOKEN endpoint, PKCE siempre,
// client_secret en el body, refresh_token obligatorio). Fase 6 lo abre a varios
// proveedores (Google, Notion) introduciendo `OAuthProvider`: cada uno declara sus
// endpoints, si usa PKCE, cómo autentica el token request (body vs Basic) y si
// devuelve refresh_token. Un `Service` (gmail, calendar, notion, …) referencia un
// provider + sus scopes + de qué env sale su MCP URL self-hosted.
//
// Somos el BROKER: el `client_secret` y el `refresh_token` viven sólo en NUESTRA
// infra (env + DB de la box), NUNCA en el vault de Anthropic. Al vault le escribimos
// sólo un `static_bearer` corto (vía @ceibo/agent). El refresh lo hacemos
// nosotros (`refreshGrantsForUser`, lazy, disparado por el gateway al haber actividad
// del usuario), no el vault. Las piezas (makePkce / buildAuthUrl / exchangeCode /
// refreshAccessToken) las consumen el servicio HTTP de enrollment (server.ts) y el
// gateway. Ningún valor de token se loguea nunca.

import { createHash, randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { SessionBackend } from "@ceibo/agent";
import {
  type Db,
  getUser,
  grantNeedsNotify,
  listGrantsMissingAccount,
  listRefreshableGrantsForUser,
  markGrantBroken,
  type OauthGrant,
  setOauthGrantAccount,
  upsertOauthGrant,
  vaultIdForUser,
} from "@ceibo/store";

// --- Providers OAuth ------------------------------------------------------
// Cómo difiere un proveedor de otro. Lo que NO difiere (response_type=code,
// state anti-CSRF, redirect_uri) vive en buildAuthUrl/exchangeCode.

export interface OAuthProvider {
  /** Endpoint de consentimiento (donde mandamos al usuario). */
  authEndpoint: string;
  /** Endpoint de intercambio `code` → tokens. */
  tokenEndpoint: string;
  /** Env var con el client_id de la app OAuth registrada en el provider. */
  clientIdEnv: string;
  /** Env var con el client_secret. */
  clientSecretEnv: string;
  /** PKCE (S256). Google sí; Notion no. */
  usePkce: boolean;
  /** Cómo viaja el secret en el token request: en el body (Google) o como
   *  HTTP Basic `client_id:client_secret` (Notion). */
  tokenAuth: "body" | "basic";
  /** Params extra en la URL de consentimiento (ej. Google `access_type=offline`
   *  + `prompt=consent` para forzar refresh_token; Notion `owner=user`). */
  authParams?: Record<string, string>;
  /** Devuelve refresh_token + expiry → credencial `mcp_oauth` (el vault refresca
   *  solo). Si es false, el token no expira → credencial `static_bearer`. */
  hasRefresh: boolean;
}

export const PROVIDERS: Record<string, OAuthProvider> = {
  google: {
    authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    usePkce: true,
    tokenAuth: "body",
    authParams: { access_type: "offline", prompt: "consent" },
    hasRefresh: true,
  },
  notion: {
    authEndpoint: "https://api.notion.com/v1/oauth/authorize",
    tokenEndpoint: "https://api.notion.com/v1/oauth/token",
    clientIdEnv: "NOTION_CLIENT_ID",
    clientSecretEnv: "NOTION_CLIENT_SECRET",
    usePkce: false,
    tokenAuth: "basic",
    authParams: { owner: "user" },
    // Notion entrega un access_token de larga duración y NO devuelve refresh_token
    // → lo guardamos como static_bearer (no hay nada que refrescar).
    hasRefresh: false,
  },
};

export function knownProvider(name: string): OAuthProvider | undefined {
  return PROVIDERS[name];
}

// --- Registro de servicios enrollables ------------------------------------
// service → provider + scopes que pide + de qué env sale su MCP URL self-hosted.
// Agregar un servicio Google es sumar una entrada (mismo provider). Notion suma
// otro provider. El gateway lee `mcpUrlEnv`/`displayName`; el server resuelve el
// provider para armar el flujo.
export interface Service {
  provider: string; // clave en PROVIDERS
  scopes: string[]; // Google: scope param; Notion: vacío (las capabilities van en la integración)
  mcpUrlEnv: string; // env var con la URL del MCP self-hosted del servicio
  displayName: string; // para el display_name de la credencial del vault
}

export const SERVICES: Record<string, Service> = {
  gmail: {
    provider: "google",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
    mcpUrlEnv: "GMAIL_MCP_URL",
    displayName: "Gmail",
  },
  calendar: {
    provider: "google",
    // calendar.events cubre listar/leer/crear eventos (no borra calendarios).
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    mcpUrlEnv: "CALENDAR_MCP_URL",
    displayName: "Google Calendar",
  },
  drive: {
    provider: "google",
    // Solo lectura: el MCP de Drive lee/busca, no escribe.
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    mcpUrlEnv: "DRIVE_MCP_URL",
    displayName: "Google Drive",
  },
  sheets: {
    provider: "google",
    // spreadsheets (no .readonly) porque append_values escribe (additivo).
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    mcpUrlEnv: "SHEETS_MCP_URL",
    displayName: "Google Sheets",
  },
  notion: {
    provider: "notion",
    scopes: [], // Notion define capacidades en la integración, no por scope param
    mcpUrlEnv: "NOTION_MCP_URL",
    displayName: "Notion",
  },
};

export function knownService(name: string): Service | undefined {
  return SERVICES[name];
}

export const SERVICE_NAMES = Object.keys(SERVICES);

// --- Permisos legibles por grant (para el detalle de Conexiones) ----------
// Traducimos los scopes OAuth (lo que devuelve el token exchange, en oauth_grants.scope; o el
// catálogo estático SERVICES como fallback) a texto humano. Notion no usa scopes (las capacidades
// viven en la integración). Sin datos nuevos: solo lo que ya tenemos.

const SCOPE_LABELS: Record<string, string> = {
  "https://www.googleapis.com/auth/gmail.readonly": "Leer tu correo",
  "https://www.googleapis.com/auth/gmail.compose": "Redactar y enviar correo",
  "https://www.googleapis.com/auth/calendar.events": "Ver y crear eventos del calendario",
  "https://www.googleapis.com/auth/drive.readonly": "Ver y buscar archivos de Drive (solo lectura)",
  "https://www.googleapis.com/auth/spreadsheets": "Ver y editar planillas",
  openid: "Tu identidad básica",
  email: "Tu dirección de correo",
  profile: "Tu perfil básico",
};

/** Fallback prolijo para un scope que no conocemos: el último segmento de la URL del scope
 *  (ej. ".../auth/gmail.send" → "gmail.send"), o el scope crudo si no es una URL. */
function humanizeUnknownScope(scope: string): string {
  return scope.split("/").pop() || scope;
}

/** Permisos legibles de un grant. Usa el `scope` realmente otorgado (preferido) o, si viene vacío,
 *  los scopes del catálogo del servicio. Notion → mensaje propio (no usa scopes OAuth). Devuelve
 *  [] si el servicio no es OAuth (ej. whatsapp) y no hay scopes — el caller oculta el bloque. */
export function describePermissions(opts: { service: string; scope?: string }): string[] {
  const svc = knownService(opts.service);
  if (svc?.provider === "notion") return ["Según los permisos de la integración de Notion"];
  const fromGrant = opts.scope?.trim() ? opts.scope : (svc?.scopes ?? []).join(" ");
  const raw = fromGrant.split(/\s+/).filter(Boolean);
  return raw.map((s) => SCOPE_LABELS[s] ?? humanizeUnknownScope(s));
}

// --- Multi-cuenta: perfiles (Fase 7) -------------------------------------
// Un usuario puede tener varias cuentas del mismo servicio ("work", "personal").
// El perfil "default" = cuenta única, retro-compatible (URL pelada, mismo server
// base del agente). Un perfil extra se distingue por un SEGMENTO DE PATH en la MCP
// URL — `…/mcp/<svc>/<perfil>/<secret>` — antes del secret. El vault de Anthropic
// keyea las credenciales por la URL COMPLETA (exact-match), así que dos perfiles no
// se pisan; PERO el MITM-proxy del agent-vault (backend archima) path-scopea por
// host+path y NO matchea query string → con el `?profile=` viejo los perfiles del
// mismo servicio colisionaban en un solo matcher/cred y se pisaban el token. Por eso
// el perfil va en el PATH (que el proxy SÍ distingue), no en la query. El MCP server
// sigue ignorando el segmento de perfil (gatea por el secret, que es el ÚLTIMO
// segmento; el token inyectado YA es la cuenta).

export const DEFAULT_PROFILE = "default";

/** URL del MCP de GitHub (escritura). Compartida por el agente y el gateway. */
export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

/** Nombre del mcp_server de crons (Fase 8). El prefijo de tools que ve el agente
 *  (`schedule_create`, …). URL en env SCHEDULE_MCP_URL; cred per-usuario en el vault. */
export const SCHEDULE_SERVER_NAME = "schedule";

/** Nombre del mcp_server de WhatsApp (Fase 9). Prefijo de tools (`wa_list_chats`, …).
 *  URL en env WACLI_MCP_URL; cred per-usuario (token firmado) en el vault al parear. */
export const WACLI_SERVER_NAME = "wacli";

/** Nombre del mcp_server `viewer` (managed-ui Fase B): el agente abre/crea archivos en la
 *  vista web del usuario (`viewer_open`, `viewer_create`). URL en env VIEWER_MCP_URL
 *  (lo sirve el gateway in-process); cred per-usuario (token firmado) en el vault. */
export const VIEWER_SERVER_NAME = "viewer";

/** Nombre del mcp_server `control`: el agente corre los comandos de usuario (`/connect`,
 *  `/model`, `/new`, …) por chat/voz vía la tool `ceibo_command`. URL en env CONTROL_MCP_URL
 *  (lo sirve el gateway in-process, como viewer); cred per-usuario (token firmado) en el vault. */
export const CONTROL_SERVER_NAME = "control";

/** Nombre del mcp_server `notes` (feature db F2): búsqueda híbrida + lectura de notas sobre
 *  el índice derivado en la DB. Lo sirve el gateway in-process (como control); URL en
 *  NOTES_MCP_URL; cred per-usuario (token firmado con NOTES_MCP_HMAC_KEY) en el vault.
 *  opencode expone sus tools como `notes_search`/`notes_read`/`notes_list`. */
export const NOTES_SERVER_NAME = "notes";

/** Normaliza un nombre de perfil escrito por el usuario: minúsculas, [a-z0-9-],
 *  guiones colapsados, recortado a 32. "" o "default" → DEFAULT_PROFILE. */
export function sanitizeProfile(raw: string): string {
  const s = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return s === "" || s === DEFAULT_PROFILE ? DEFAULT_PROFILE : s;
}

/** MCP URL para un perfil: pelada para "default" (retro-compat); para el resto, el
 *  perfil entra como SEGMENTO DE PATH antes del secret (`…/mcp/<svc>/<perfil>/<secret>`).
 *  Va en el path —no en `?profile=`— porque el MITM-proxy del agent-vault (archima)
 *  path-scopea por host+path y NO matchea query: con la query, los perfiles del mismo
 *  servicio colapsaban a un solo matcher/cred y se pisaban el token. El secret sigue
 *  siendo el ÚLTIMO segmento (lo que asumen el gate de `mcps` y el `/*` del matcher). */
export function mcpUrlForProfile(baseUrl: string, profile: string): string {
  if (profile === DEFAULT_PROFILE) return baseUrl;
  const u = new URL(baseUrl);
  const segs = u.pathname.split("/").filter(Boolean);
  // Insertar el perfil ANTES del último segmento (el secret). Sin path significativo
  // (no debería pasar con las MCP URLs reales) lo appendeamos como único segmento.
  if (segs.length >= 1) segs.splice(segs.length - 1, 0, profile);
  else segs.push(profile);
  u.pathname = `/${segs.join("/")}`;
  return u.toString();
}

/** Nombre del mcp_server (= prefijo de las tools que ve el agente). Perfil default
 *  = el nombre del servicio (ej. `gmail`, lo que ya usa el agent.yaml); extra =
 *  `<servicio>_<perfil>` (ej. `gmail_work`). */
export function serverNameForProfile(service: string, profile: string): string {
  return profile === DEFAULT_PROFILE ? service : `${service}_${profile}`;
}

// --- Builder de mcp_servers + tools del agente ----------------------------
// FUENTE ÚNICA de la config de MCP del agente, usada por:
//   - publish-agent.ts (agente GLOBAL, base, sin perfiles extra),
//   - el gateway (override PER-SESIÓN: base + los perfiles que ESE usuario conectó,
//     vía session.update).
// Con `extraServers` vacío produce EXACTAMENTE la config base histórica (el agente
// publicado no cambia). Los perfiles extra se appendean como server + toolset.

type UrlServer = Anthropic.Beta.Agents.BetaManagedAgentsURLMCPServerParams;
type ToolParam =
  | Anthropic.Beta.Agents.BetaManagedAgentsAgentToolset20260401Params
  | Anthropic.Beta.Agents.BetaManagedAgentsMCPToolsetParams
  | Anthropic.Beta.Agents.BetaManagedAgentsCustomToolParams;

export interface AgentMcpConfig {
  mcp_servers: UrlServer[];
  tools: ToolParam[];
}

/** Un mcp_server extra (perfil no-default) a montar en una sesión. */
export interface ExtraServer {
  name: string; // serverNameForProfile(service, profile), ej. "gmail_work"
  url: string; // grant.mcp_url (lleva ?profile=…)
}

const ALLOW_ALL = { enabled: true, permission_policy: { type: "always_allow" as const } };
const fullToolset = (name: string): ToolParam => ({
  type: "mcp_toolset",
  mcp_server_name: name,
  default_config: ALLOW_ALL,
});

export function buildAgentMcpConfig(opts: {
  env: NodeJS.ProcessEnv;
  extraServers?: ExtraServer[];
  /** Override de la URL del server base por servicio. Lo usa el gateway cuando el
   *  usuario tiene default_profile != "default" (multi-cuenta): el server base
   *  conserva el nombre (`gmail`) pero apunta a la URL del grant default (con
   *  `?profile=personal`), para que el vault encuentre la credencial. Sin
   *  override, se usa la URL pelada del env (caso legacy / sin perfiles). */
  defaultUrlOverrides?: Record<string, string>;
  /** Si `true`, saltea (en vez de tirar) los servicios base sin URL configurada. Lo usa
   *  el caller per-sesión en dev (`CEIBO_ENV==='dev'`), donde no corre la flota de MCPs
   *  base self-hosted pero sí queremos montar el control MCP solo. `publish-agent` (prod)
   *  lo deja en `false`: ahí el throw es un guardrail útil contra misconfig. Al saltear un
   *  servicio se omite también su toolset, para no referenciar un server inexistente. */
  skipMissing?: boolean;
}): AgentMcpConfig {
  const extra = opts.extraServers ?? [];
  const overrides = opts.defaultUrlOverrides ?? {};
  const baseServices: UrlServer[] = [];
  for (const name of SERVICE_NAMES) {
    const svc = SERVICES[name] as Service;
    const url = overrides[name] ?? opts.env[svc.mcpUrlEnv];
    if (!url) {
      if (opts.skipMissing) continue;
      throw new Error(`falta ${svc.mcpUrlEnv} en el env`);
    }
    baseServices.push({ type: "url", name, url });
  }
  const mountedServiceNames = baseServices.map((s) => s.name);
  // MCP `schedule` (Fase 8): server base global (todos lo tienen), URL única. La
  // cred per-usuario (token firmado → userId) la pone el gateway en cada vault.
  // Opcional: si no está SCHEDULE_MCP_URL, no se monta (como los demás MCPs).
  const scheduleUrl = opts.env.SCHEDULE_MCP_URL;
  // MCP `wacli` (Fase 9): server base global (read-only), URL única. La cred per-usuario
  // (token firmado → userId → --store) la pone el gateway al parear. Opcional.
  const wacliUrl = opts.env.WACLI_MCP_URL;
  // MCP `viewer` (managed-ui Fase B): lo sirve el gateway in-process; URL única. La cred
  // per-usuario (token firmado → userId → WS) la pone el gateway en cada vault. Opcional.
  const viewerUrl = opts.env.VIEWER_MCP_URL;
  // MCP `control`: lo sirve el gateway in-process (necesita ctxByUser, como viewer); URL única.
  // La cred per-usuario (token firmado → userId → runCommandForUser) la pone el gateway en cada
  // vault. Opcional: si no está CONTROL_MCP_URL, no se monta (el agente no puede correr comandos).
  const controlUrl = opts.env.CONTROL_MCP_URL;
  // MCP `notes` (feature db F2): búsqueda/lectura sobre el índice derivado; gateway in-process.
  const notesUrl = opts.env.NOTES_MCP_URL;
  const mcp_servers: UrlServer[] = [
    // Fase 2c: el agente de chat ya NO usa el GitHub MCP. Lee/escribe la working copy local
    // de la wiki (hidratada por wiki-sync, ver agent.yaml) y sincroniza por HTTPS. (REM sigue
    // con el GitHub MCP, en buildRemMcpConfig.)
    ...baseServices,
    ...(scheduleUrl ? [{ type: "url" as const, name: SCHEDULE_SERVER_NAME, url: scheduleUrl }] : []),
    ...(wacliUrl ? [{ type: "url" as const, name: WACLI_SERVER_NAME, url: wacliUrl }] : []),
    ...(viewerUrl ? [{ type: "url" as const, name: VIEWER_SERVER_NAME, url: viewerUrl }] : []),
    ...(controlUrl ? [{ type: "url" as const, name: CONTROL_SERVER_NAME, url: controlUrl }] : []),
    ...(notesUrl ? [{ type: "url" as const, name: NOTES_SERVER_NAME, url: notesUrl }] : []),
    ...extra.map((e): UrlServer => ({ type: "url", name: e.name, url: e.url })),
  ];
  const tools: ToolParam[] = [
    // Agent toolset: bash/read/glob/grep/web_* + write/edit HABILITADOS (Fase 2c). El agente
    // edita la working copy LOCAL de la wiki (en /workspace/<repo>, hidratada por wiki-sync) y
    // la sube con `node /opt/wiki-sync.mjs push`. Antes write/edit estaban apagados porque la
    // única vía era el GitHub MCP y lo escrito en el sandbox no persistía; ahora el sandbox
    // tiene archivos locales reales que SÍ se sincronizan, así que editar local es lo correcto.
    {
      type: "agent_toolset_20260401",
      default_config: { enabled: true, permission_policy: { type: "always_allow" } },
    },
    ...mountedServiceNames.map(fullToolset),
    ...(scheduleUrl ? [fullToolset(SCHEDULE_SERVER_NAME)] : []),
    ...(wacliUrl ? [fullToolset(WACLI_SERVER_NAME)] : []),
    ...(viewerUrl ? [fullToolset(VIEWER_SERVER_NAME)] : []),
    ...(controlUrl ? [fullToolset(CONTROL_SERVER_NAME)] : []),
    ...(notesUrl ? [fullToolset(NOTES_SERVER_NAME)] : []),
    ...extra.map((e) => fullToolset(e.name)),
  ];
  return { mcp_servers, tools };
}

/** Config MCP mínima para REM (Fase 16): SOLO github (las 4 tools de archivo) +
 * filesystem. REM corre aparte del chat y opera ÚNICAMENTE sobre la wiki montada —
 * no toca gmail/calendar/drive/sheets/notion/schedule/wacli (sus schemas inflan el
 * cache-write, que REM paga en cada corrida, y no los usa). Mismo recorte de tools
 * de GitHub que el agente de chat: leer/escribir/borrar archivos, nada más. */
export function buildRemMcpConfig(): AgentMcpConfig {
  return {
    // Igual que el chat (Fase 2c): REM ya NO usa el GitHub MCP. Trabaja la working copy LOCAL
    // (hidratada por wiki-sync) con write/edit, y sube con `node /mnt/session/uploads/wiki-sync.mjs
    // push`. Sin MCP servers (solo necesita el agent_toolset: bash/read/write/edit/grep).
    mcp_servers: [],
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: { enabled: true, permission_policy: { type: "always_allow" } },
      },
    ],
  };
}

// --- PKCE + state ---------------------------------------------------------
export interface Pkce {
  verifier: string;
  challenge: string;
}

/** Par PKCE. El verifier protege el `code` en tránsito; el challenge va en la URL. */
export function makePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** State opaco anti-CSRF que ata el callback al flujo que arrancamos. */
export function makeState(): string {
  return randomBytes(16).toString("base64url");
}

// --- URL de consentimiento ------------------------------------------------
export function buildAuthUrl(opts: {
  provider: OAuthProvider;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  challenge?: string; // requerido si provider.usePkce
}): string {
  const u = new URL(opts.provider.authEndpoint);
  const params: Record<string, string> = {
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    state: opts.state,
    ...(opts.provider.authParams ?? {}),
  };
  if (opts.scopes.length > 0) params.scope = opts.scopes.join(" ");
  if (opts.provider.usePkce) {
    if (!opts.challenge) throw new Error("buildAuthUrl: provider usa PKCE pero falta challenge");
    params.code_challenge = opts.challenge;
    params.code_challenge_method = "S256";
  }
  u.search = new URLSearchParams(params).toString();
  return u.toString();
}

// --- Intercambio code → tokens --------------------------------------------
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string; // ausente si el provider no lo da (Notion)
  expiresAt?: string; // ISO; ausente si el token no expira (Notion)
  scope: string; // space-joined ("" si el provider no lo devuelve)
}

export async function exchangeCode(opts: {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
  code: string;
  verifier?: string; // requerido si provider.usePkce
  redirectUri: string;
}): Promise<OAuthTokens> {
  const { provider } = opts;
  const headers: Record<string, string> = {};
  const body: Record<string, string> = {
    code: opts.code,
    grant_type: "authorization_code",
    redirect_uri: opts.redirectUri,
  };
  if (provider.usePkce) {
    if (!opts.verifier) throw new Error("exchangeCode: provider usa PKCE pero falta verifier");
    body.code_verifier = opts.verifier;
  }
  if (provider.tokenAuth === "basic") {
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
    headers.authorization = `Basic ${basic}`;
  } else {
    body.client_id = opts.clientId;
    body.client_secret = opts.clientSecret;
  }

  // Google quiere x-www-form-urlencoded; Notion (Basic) acepta JSON. Mandamos el
  // formato que cada uno espera según su modo de auth.
  let payload: string;
  if (provider.tokenAuth === "basic") {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(body).toString();
  }

  const res = await fetch(provider.tokenEndpoint, { method: "POST", headers, body: payload });
  if (!res.ok) {
    throw new Error(`token exchange HTTP ${res.status}: ${await res.text()}`);
  }
  const tok = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (provider.hasRefresh && !tok.refresh_token) {
    // Pasa si la persona ya había autorizado antes: hay que revocar y reintentar.
    throw new Error(
      "El proveedor no devolvió refresh_token (revocá el acceso en su panel de permisos y reintentá).",
    );
  }

  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt:
      typeof tok.expires_in === "number"
        ? new Date(Date.now() + tok.expires_in * 1000).toISOString()
        : undefined,
    scope: tok.scope ?? "",
  };
}

/**
 * Refresca un access_token con un refresh_token (grant_type=refresh_token). Lo usa
 * el broker: el `client_secret` vive en NUESTRA infra (.env de la box) y nunca toca
 * el vault de Anthropic. Provider-aware (body vs Basic). Algunos providers no rotan
 * el refresh_token en el refresh → `refreshToken` puede venir undefined (el caller
 * conserva el anterior).
 */
export async function refreshAccessToken(opts: {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch; // inyectable para tests; por defecto el fetch global
}): Promise<OAuthTokens> {
  const { provider } = opts;
  const f = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
  };
  if (provider.tokenAuth === "basic") {
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
    headers.authorization = `Basic ${basic}`;
    headers["content-type"] = "application/json";
  } else {
    body.client_id = opts.clientId;
    body.client_secret = opts.clientSecret;
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const payload =
    provider.tokenAuth === "basic" ? JSON.stringify(body) : new URLSearchParams(body).toString();

  const res = await f(provider.tokenEndpoint, { method: "POST", headers, body: payload });
  if (!res.ok) {
    throw new Error(`refresh HTTP ${res.status}: ${await res.text()}`);
  }
  // (nota) La distinción invalid_grant (grant muerto → reconectar) vs error TRANSITORIO
  // (red/5xx/timeout) la hace `isInvalidGrant` sobre este mensaje; ver `refreshGrantsForUser`.
  const tok = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token, // undefined si no rota → el caller conserva el viejo
    expiresAt:
      typeof tok.expires_in === "number"
        ? new Date(Date.now() + tok.expires_in * 1000).toISOString()
        : undefined,
    scope: tok.scope ?? "",
  };
}

// --- Broker de refresh (lazy, por usuario) --------------------------------

/**
 * ¿El error de refresh es `invalid_grant` (refresh token MUERTO → reconectar) y no un fallo
 * TRANSITORIO (red, 5xx, timeout)? Google expira los refresh tokens ~cada 7 días en modo "Testing"
 * → responde HTTP 400 con `{"error":"invalid_grant"}`. Sólo ese caso cuenta como grant muerto: un
 * timeout o un 503 NO deben marcar el grant como roto (se reintenta el próximo sweep).
 *
 * Detección conservadora: el mensaje de `refreshAccessToken` es `refresh HTTP <status>: <body>`.
 * Exigimos el marcador textual `invalid_grant` en el body. No matcheamos por status solo (un 400
 * puede ser otro `error`), ni tratamos 5xx/red como muerte. Errores de red (fetch throw) no traen
 * "invalid_grant" → devuelven false, como corresponde.
 */
export function isInvalidGrant(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /invalid_grant/i.test(msg);
}

/**
 * Refresca los grants de UN usuario que están por vencer y re-pushea el access_token
 * nuevo a su vault (como `static_bearer`). Lo llama el gateway al preparar el turno
 * del usuario → refrescamos solo lo de usuarios ACTIVOS y solo lo que está por
 * vencer (no un barrido global de todos los grants cada hora). El `client_secret` y
 * el `refresh_token` se leen de NUESTRA infra (env + DB de la box), nunca del vault.
 * Best-effort: si un refresh falla, lo loguea y sigue (el resto no se bloquea).
 *
 * Detección de muerte de grant: si el refresh falla con `invalid_grant` (refresh token expirado),
 * marcamos el grant como roto (`markGrantBroken`, idempotente) y lo DEVOLVEMOS si todavía necesita
 * aviso (`grantNeedsNotify`: broken y `notified_at` NULL). El caller (el gateway, que tiene el 🔔 del
 * usuario) intenta ENTREGAR la notif (item durable) y, sólo si la entrega sale bien, sella
 * `notified_at`. Así el anti-spam mira notified_at, no broken_at: mientras la entrega no salga bien
 * la reintentamos cada sweep (elimina el "aviso perdido"); una vez entregada, no re-notifica. Los
 * fallos transitorios (red/5xx) NO marcan ni notifican. Devolvemos la lista para mantener el paquete
 * oauth sin dependencia del gateway (el cruce lo resuelve el caller).
 */
export async function refreshGrantsForUser(opts: {
  db: Db;
  backend: SessionBackend;
  userId: number;
  env?: NodeJS.ProcessEnv;
  withinMs?: number;
}): Promise<OauthGrant[]> {
  const env = opts.env ?? process.env;
  const within = opts.withinMs ?? 15 * 60 * 1000;
  const before = new Date(Date.now() + within).toISOString();
  const due = listRefreshableGrantsForUser(opts.db, opts.userId, before);
  if (due.length === 0) return [];
  const user = getUser(opts.db, opts.userId);
  // El vault al que pusheamos depende del backend ACTIVO del user: MA → vault_id, local → local_vault_id.
  // El `backend` que nos pasan ya es el del user (backendForUser), así que el id tiene que ser el del
  // mismo backend; si no, pushea al agent-vault local un id MA (vlt_…) inexistente → "Vault not found".
  const vaultId = user ? vaultIdForUser(user) : null;
  if (!vaultId) return [];

  const toNotify: OauthGrant[] = [];
  for (const g of due) {
    const provider = knownProvider(g.provider);
    if (!provider || !g.refresh_token) continue;
    const clientId = env[provider.clientIdEnv];
    const clientSecret = env[provider.clientSecretEnv];
    if (!clientId || !clientSecret) continue; // provider sin configurar → no podemos refrescar
    try {
      const tok = await refreshAccessToken({
        provider,
        clientId,
        clientSecret,
        refreshToken: g.refresh_token,
      });
      await opts.backend.setStaticBearerCredential(vaultId, {
        mcpServerUrl: g.mcp_url,
        displayName: g.display_name,
        token: tok.accessToken,
      });
      upsertOauthGrant(opts.db, {
        ...g,
        broken_at: null, // refresh OK = grant sano: limpia una rotura previa si el grant revivió…
        notified_at: null, // …y su sello de notif (si vuelve a romperse, se avisa de nuevo).
        refresh_token: tok.refreshToken ?? g.refresh_token, // algunos no rotan → conservar
        access_token: tok.accessToken,
        expires_at: tok.expiresAt ?? g.expires_at,
        scope: tok.scope || g.scope,
      });
    } catch (e) {
      console.error(`[refresh] user=${opts.userId} ${g.service}: ${(e as Error)?.message ?? e}`);
      // invalid_grant = refresh token muerto → marcar roto (idempotente). Transitorio (red/5xx/
      // timeout) → no tocar broken_at; se reintenta el próximo sweep.
      if (!isInvalidGrant(e)) continue;
      markGrantBroken(opts.db, opts.userId, g.service, g.profile);
      // Retry-hasta-entregar: devolvemos el grant si sigue necesitando aviso (roto y sin sellar).
      // El gateway intenta entregar y sella `notified_at` sólo si sale bien; si no, reaparece acá.
      if (grantNeedsNotify(opts.db, opts.userId, g.service, g.profile)) toNotify.push(g);
    }
  }
  return toNotify;
}

// --- Cuenta externa real por grant (para el detalle de Conexiones) --------
// Obtenemos la identidad de la cuenta conectada (ej. user@example.com, el workspace de Notion)
// con el access_token y SIN pedir scopes nuevos. Lo que se puede con los scopes actuales:
//   - gmail   (gmail.readonly): users.getProfile → emailAddress
//   - drive   (drive.readonly): about.get → user.emailAddress
//   - notion  (token de bot):   GET /v1/users/me → bot.workspace_name
// Lo que NO (devuelve null, la UI muestra fallback "—"):
//   - calendar (scope calendar.events no habilita CalendarList/Calendars/Settings)
//   - sheets   (scope spreadsheets no expone identidad)
// Para esos dos haría falta sumar `openid email` (re-consent) — decisión del owner, no acá.
// Best-effort: cualquier fallo (HTTP no-ok, parseo, red) → null.

const NOTION_VERSION = "2022-06-28";

/** Identidad de la cuenta externa de un servicio, con el access_token dado. null si el
 *  servicio no puede exponerla con su scope actual o si la llamada falla. Inyectable
 *  (`fetchImpl`) para tests; por defecto usa el `fetch` global. */
export async function fetchProviderAccount(opts: {
  service: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const f = opts.fetchImpl ?? fetch;
  const svc = knownService(opts.service);
  if (!svc) return null;
  const auth = { authorization: `Bearer ${opts.accessToken}` };
  try {
    if (svc.provider === "google") {
      if (opts.service === "gmail") {
        const r = await f("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: auth });
        if (!r.ok) return null;
        const j = (await r.json()) as { emailAddress?: string };
        return j.emailAddress ?? null;
      }
      if (opts.service === "drive") {
        const r = await f("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
          headers: auth,
        });
        if (!r.ok) return null;
        const j = (await r.json()) as { user?: { emailAddress?: string } };
        return j.user?.emailAddress ?? null;
      }
      // calendar / sheets: sus scopes no exponen identidad → null (fallback en la UI).
      return null;
    }
    if (svc.provider === "notion") {
      const r = await f("https://api.notion.com/v1/users/me", {
        headers: { ...auth, "notion-version": NOTION_VERSION },
      });
      if (!r.ok) return null;
      const j = (await r.json()) as { bot?: { workspace_name?: string }; name?: string };
      return j.bot?.workspace_name ?? j.name ?? null;
    }
    return null;
  } catch {
    return null; // best-effort: red/parseo caído → cuenta desconocida
  }
}

/**
 * Backfill best-effort de `account` para grants viejos (los enrolados antes de esta feature).
 * Para cada grant sin cuenta: si el access_token está vencido y el grant es refrescable, refresca
 * el token EN MEMORIA (no persiste tokens ni toca el vault — el broker lazy ya se encarga) y con
 * ese token consulta la cuenta al provider; si la obtiene, la guarda. Idempotente: los que no se
 * puedan resolver quedan en null y se reintentan en la próxima corrida. Pensado para correr una
 * vez al arrancar el servicio oauth.
 */
export async function backfillGrantAccounts(opts: {
  db: Db;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<{ scanned: number; filled: number }> {
  const env = opts.env ?? process.env;
  const grants = listGrantsMissingAccount(opts.db);
  let filled = 0;
  for (const g of grants) {
    try {
      let token = g.access_token;
      const provider = knownProvider(g.provider);
      // Token vencido + refrescable → refrescamos en memoria para no pegarle con uno muerto.
      const expired = g.expires_at != null && g.expires_at <= new Date().toISOString();
      if (provider?.hasRefresh && expired && g.refresh_token) {
        const clientId = env[provider.clientIdEnv];
        const clientSecret = env[provider.clientSecretEnv];
        if (clientId && clientSecret) {
          const tok = await refreshAccessToken({
            provider,
            clientId,
            clientSecret,
            refreshToken: g.refresh_token,
            fetchImpl: opts.fetchImpl,
          });
          token = tok.accessToken;
        }
      }
      const account = await fetchProviderAccount({
        service: g.service,
        accessToken: token,
        fetchImpl: opts.fetchImpl,
      });
      if (account != null) {
        setOauthGrantAccount(opts.db, g.user_id, g.service, g.profile, account);
        filled++;
      }
    } catch (e) {
      console.error(`[backfill] user=${g.user_id} ${g.service}: ${(e as Error)?.message ?? e}`);
    }
  }
  return { scanned: grants.length, filled };
}
