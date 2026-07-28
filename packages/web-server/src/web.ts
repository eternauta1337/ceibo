// Canal web (managed-ui Fase A): server HTTP del gateway. Sirve la SPA (build de
// @ceibo/web), hace el login por magic-link (cookie de sesión) y expone el canal
// del círculo de voz. Mismo núcleo `handleIncoming` que telegram/cli.
//
// Transporte: SSE + POST (NO WebSocket). El edge de vps.example.com no proxea upgrades WS, pero
// sí HTTP normal, así que:
//   - server→cliente: GET /api/stream (SSE, EventSource) — voz, texto, abrir archivo.
//   - cliente→server: POST /api/send — audio grabado / texto.
// EventSource reconecta solo. Ver memoria exe_edge_no_websocket.
//
// Auth: el bot manda /web → link de un solo uso → la SPA lo POSTea a /api/login →
// cookie httpOnly (signUserToken). El stream y el send se autentican con esa cookie.
// Telegram ya es la raíz de identidad → el magic link no la amplía.
//
// El server bindea 127.0.0.1; el TLS lo termina el edge de vps.example.com (vía nginx, que
// rutea /, /api → este puerto). En dev, Vite proxea /api acá.

import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { InboundAudio, MediaWire, TurnFact } from "@ceibo/channels";
import { handleMcpPost, type McpServer } from "@ceibo/mcps/src/core/transport.ts";
import { describePermissions, SERVICE_NAMES, SERVICES } from "@ceibo/oauth";
import {
  defaultRate,
  defaultVoice,
  displayVoice,
  LANGS,
  paramSupported,
  speechEnabled,
  speechProvider,
  voicesForLang,
} from "@ceibo/speech";
import {
  acceptInvitesForEmail,
  addChannel,
  addInvite,
  addRepo,
  addToWaitingList,
  archiveForUser,
  type CeiboEnv,
  cancelCron,
  ceiboEnv,
  countUnread,
  createWebLoginToken,
  type Db,
  getAuthorizedEmail,
  getCron,
  getInviteByToken,
  getRepoByName,
  getUser,
  getUserAvatar,
  getUserBgQueries,
  getUserByHandle,
  getUserLang,
  getUserSpeech,
  getWikiHead,
  grantAccess,
  hasUserPassword,
  indexedNoteRefs,
  isOwner,
  latestWikiChangeId,
  listActiveWatermarkedRepos,
  listArchivedReposForUser,
  listChannels,
  listCoMembers,
  listConnections,
  listCronsForUser,
  listGrantsForUser,
  listInbox,
  listInvitesForRepo,
  listReposForUser,
  markAllInboxRead,
  markInboxRead,
  markWebLoginTokenUsed,
  peekWebLoginToken,
  recordWikiChange,
  recordWikiEdit,
  registerEmailUserIfAuthorized,
  registerGoogleUserIfAuthorized,
  removeInvite,
  repoHasCommitSources,
  resolveUser,
  revokeAccess,
  roleOf,
  setRepoLabel,
  setUserActiveWiki,
  setUserAvatar,
  setUserBgQueries,
  setUserLocation,
  setUserName,
  setUserPassword,
  setWikiHead,
  signSessionToken,
  softDeleteRepo,
  type User,
  unarchiveForUser,
  updateCron,
  userHasAvatar,
  usersForRepo,
  verifySessionToken,
  verifyUserPassword,
  viewCron,
  type WikiChangeEntry,
  wikiChangesSince,
  wikiCommitSources,
  wikiDisplayNames,
} from "@ceibo/store";
import { assertValidLabel, gitAuthorFor, seedWelcomeNote, userRepoName, type Wikis } from "@ceibo/wikis";
import { archiveFolder, archiveNote } from "./archive.ts";
import { sendWikiInviteEmail as _sendWikiInviteEmail, emailEnabled } from "./email.ts";
import { changedPathsForUser, isRefreshable } from "./feed.ts";
import { FrameBuffer, type FrameBufferOpts, parseSeq } from "./frameBuffer.ts";
import {
  buildAuthUrl,
  decodeIdToken,
  emailFromClaims,
  exchangeCode,
  type GoogleAuthConfig,
  signState,
  verifyState,
} from "./google-auth.ts";
import { buildSetCookie, clientIpFrom, isAllowedOrigin, parseCookie, safeEqual } from "./http.ts";
import { dbCreateFile, dbDeleteFile, dbMoveFile, dbPutFile, dbReadFile } from "./notes-file-ops.ts";
import { FREEZE_BODY, FREEZE_STATUS, type FreezeGate } from "./notes-freeze.ts";
import { isSafeRelPath } from "./path-safety.ts";

/** ¿Es una vía de ESCRITURA de contenido de notas (la que el freeze del cutover corta)?
 *  Lecturas, versión, login y ops estructurales de wiki NO entran. */
export function isFrozenNoteWrite(method: string, path: string): boolean {
  if (path === "/api/sync/commit" && method === "POST") return true;
  if (path.startsWith("/api/git/") && path.endsWith("/git-receive-pack") && method === "POST") return true;
  if (path === "/api/file" && (method === "PUT" || method === "POST" || method === "DELETE")) return true;
  if (
    (path === "/api/file/move" ||
      path === "/api/file/archive" ||
      path === "/api/folder/archive" ||
      path === "/api/file/emoji") &&
    method === "POST"
  ) {
    return true;
  }
  return false;
}

import { makeRemBatchHandler } from "./rem-batch.ts";
import { resolveDeploySha } from "./version.ts";
import { makeViewerServer } from "./viewer.ts";
import { makeWikiGitProxyHandler } from "./wiki-git-proxy.ts";
import { makeWikiSyncHandler } from "./wiki-sync.ts";

// SHA del deploy: resuelto UNA vez al cargar el módulo (no cambia sin redeploy). Ver
// packages/web-server/src/version.ts para la lógica de resolución (.deployed-sha → git).
const DEPLOY_SHA = resolveDeploySha();

// La policy del canal web (`{ name: "web", echoTranscript: false }`) vive ahora en el
// gateway (canal remoto, REMOTE_CHANNEL): el web-server manda el turno por el canal y el
// gateway le aplica la policy. El eco de la transcripción llega como frame `heard` → SSE.
const CHANNEL = "web";
const COOKIE = "ceibo_session";
const STATE_COOKIE = "ceibo_gstate"; // ata el `state` del login Google al browser que lo inició
const STATE_COOKIE_TTL_S = 10 * 60; // == STATE_TTL_MS de google-auth.ts (ventana del login)
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 días
const SSE_PING_MS = 25_000; // keep-alive (< read_timeout de nginx/edge)
const FEED_POLL_MS = 1500; // cada cuánto el web server tailea el change feed para refrescar vistas
const WATCH_POLL_MS = 6000; // cada cuánto el watcher pollea el HEAD de GitHub de las wikis activas
const WATCH_ACTIVE_MIN = 15; // ventana de "wiki viva" (watermark sincronizado hace ≤ esto) a vigilar
const SSE_MAX_LIFETIME_MS = 4 * 60 * 60 * 1000; // 4h: corte duro, el cliente reconecta solo
const MAX_SEND_BYTES = 25 * 1024 * 1024; // tope del POST /api/send (audio base64)
// (el cap del OGG de respuesta TTS vive ahora en el gateway, que lo emite por el canal remoto)
// Rate-limit /api/login: ventana móvil simple in-memory por IP. Pensado para frenar
// fuerza bruta sobre el magic-link (TTL corto + un solo uso ya lo limitan, pero esto
// corta el ruido y nos deja logs útiles).
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_PER_WINDOW = 10;
// Rate-limit de POSTs autenticados por user (ventana fija de 60s, 60 req). Cubre
// /api/send, /api/file PUT/POST/DELETE, /api/file/move. /api/login va por IP
// aparte porque ahí todavía no hay sesión. In-memory simple: si el gateway
// reinicia se pierde, lo cual es OK para esta clase de defensa (cota suave).
const USER_RATE_WINDOW_MS = 60 * 1000;
const USER_RATE_MAX_PER_WINDOW = 60;
// Cap de streams SSE concurrentes por user. N pestañas = N streams; sin cap, un
// browser zombi (o un attacker auth) puede inflar el server sosteniendo cientos.
// Política: LRU eviction — al abrir el (cap+1)-ésimo, cerramos el más viejo, así
// abrir una pestaña nueva siempre funciona.
// 8 (antes 5, 2026-06-11): con el dedup por sid de `register` cada pestaña ocupa UNA
// entrada, así que el cap ya solo acota pestañas/dispositivos REALES distintos — más los
// residuos de sids viejos (reload = sid nuevo) cuyo close tarda en llegar. 8 da aire para
// el caso real del owner (desktop multi-tab + mobile) sin resignar la cota anti-zombi.
// OJO: el fix REAL del "mobile mudo" es el dedup por sid, NO este número.
export const SSE_MAX_PER_USER = 8; // exportado para los e2e del cap/dedup

// Despacho de un turno al agente. En el split (Fase 4.3) el web-server NO tiene el núcleo
// del gateway in-process: manda el turno por el CANAL REMOTO (client.ts) y la respuesta del
// agente vuelve por frames que el entry-point traduce a `pushToUser` (SSE). `web.ts` no sabe
// si hay red de por medio — sólo entrega texto/audio identificados por usuario.
type SendToAgent = (
  user: { id: number; handle: string },
  text: string,
  audio: InboundAudio | undefined,
  facts: TurnFact[],
  media?: MediaWire[],
  // `origin` = id de la vista que originó el turno (el stream SSE del dispositivo). Viaja al
  // gateway y vuelve estampado en la respuesta para entregarla SÓLO a esa vista (no eco multi-device).
  origin?: string,
) => void;

export interface WebServerOpts {
  db: Db;
  port: number;
  bindHost?: string; // dirección de bind del listener HTTP (default 127.0.0.1). 0.0.0.0 = todas las interfaces (incl. tailscale), para que las VMs de archima alcancen /api/git por tailscale.
  staticDir: string; // dist del build de @ceibo/web
  sessionKey: string; // HMAC de la cookie de sesión (WEB_SESSION_KEY)
  sendToAgent: SendToAgent;
  // Fase B (viewer MCP + vista de wiki). Opcionales: sin esto, sólo anda el círculo.
  viewerSecret?: string; // gate del path /mcp/viewer/<secret> (VIEWER_MCP_SECRET)
  /** HMAC key del Bearer del viewer (VIEWER_MCP_HMAC_KEY). C1: desacoplada del path-secret.
   *  Sin esto el viewer MCP no se monta aunque viewerSecret esté. Misma política que schedule/wacli. */
  viewerHmacKey?: string;
  wikis?: Wikis; // para GET /api/file (lectura de la wiki)
  /** Feature db F3c: "db" = las notas se leen/escriben contra la DB (fuente de verdad; el
   *  espejo git de F3b exporta atrás). Default "git" = comportamiento de siempre. El front
   *  no distingue: `sha` es opaco (en modo db es la versión entera stringificada). */
  notesWriteMode?: "git" | "db";
  /** Freeze del cutover (F3): mientras esté puesto el flag, las escrituras de notas 503ean. */
  freeze?: FreezeGate;
  userRepoNames?: (userId: number) => string[]; // repos ACTIVOS a los que el usuario tiene acceso (writes + sync)
  /** Repos del usuario incluyendo archivados (para reads de archivos en la vista "archivo" de F5). */
  userRepoNamesWithArchived?: (userId: number) => string[];
  // Modelo de chat (cog de settings): opciones POR USUARIO (según su backend — MA ve Anthropic,
  // local ve el roster local) + resolver del actual. <2 opciones = el cog no muestra el selector.
  // Cambiar = se manda /model por POST /api/send.
  chatModels?: (userId: number) => { id: string; label: string }[];
  userModel?: (userId: number) => string; // clave del modelo actual (marca el <select>)
  // Fase 2a: endpoint /api/sync/* que el sandbox del agente usa para hidratar/pull/push las
  // wikis por HTTPS (token de identidad firmado, NO el de GitHub). Opcional (opt-in por secret).
  wikiSyncSecret?: string; // HMAC del token de sync (WIKI_SYNC_SECRET)
  /** IPs permitidas para /api/git (gate de source-IP, FRONTERA 1). Viene de WIKI_GIT_ALLOWED_IPS
   *  (comma-separated). Fail-closed: sin IPs → /api/git devuelve 403 siempre. */
  gitAllowedIps?: ReadonlySet<string>;
  /** Bearer de sistema para /api/rem (REM_BATCH_SECRET). Sin secret → handler no montado. */
  remBatchSecret?: string;
  /** IPs permitidas para /api/rem (FRONTERA 1, fail-closed). Default: reusar gitAllowedIps. */
  remBatchAllowedIps?: ReadonlySet<string>;
  /** Token del bot de Telegram para el digest de REM (TELEGRAM_BOT_TOKEN). Sin token → sin digest. */
  telegramBotToken?: string;
  // Fase 4.5: login web por Google Sign-In (OIDC). Opcional: sin esto, las rutas
  // /api/auth/google/* devuelven 503 y sólo anda el login por magic-link de telegram.
  googleAuth?: GoogleAuthConfig;
  // Login/registro web por magic link de mail (Resend). Opt-in: ambos tienen que estar para que
  // POST /api/auth/email/start funcione; si falta alguno, el endpoint devuelve 503. El origin
  // público (== WEB_PUBLIC_ORIGIN) arma el link `<origin>/<handle>?t=<token>` que va en el mail.
  webPublicOrigin?: string;
  sendMagicLink?: (args: { to: string; url: string }) => Promise<void>;
  /** Override de sendWikiInviteEmail para tests (sin tocar Resend). Si no se inyecta, usa el
   *  módulo email.ts real (que requiere RESEND_API_KEY; sin key loguea y sigue). */
  sendInviteEmail?: (args: {
    to: string;
    inviterName: string;
    wikiLabel: string;
    acceptUrl: string;
  }) => Promise<void>;
  /** Override de sendAccessApprovedEmail para tests. */
  sendApprovedEmail?: (args: { to: string }) => Promise<void>;
  // Fase conexiones-v2: si el gateway tiene WhatsApp (wacli) configurado, WhatsApp es un
  // conectable/canal posible. Espeja el gate `env.WACLI_MCP_URL` del gateway (engine.ts) para
  // que GET /api/connections ofrezca whatsapp como conectable. El web-server no manda turnos de
  // wacli (eso es del gateway); sólo lo lista como posibilidad informativa.
  whatsappEnabled?: boolean;
  /**
   * Plano de control F3: reset de sesión MA en el gateway.
   * Lo inyecta el entry-point (`index.ts`) cableando `requestSessionReset` al cliente del
   * canal remoto. F2 lo llama desde los endpoints de membresía (archivar/irse/borrar/quitar).
   * Opcional: si no se inyecta (dev/test sin gateway), es no-op.
   */
  resetSessions?: (userIds: number[]) => void;
  /** Override del intervalo del keep-alive `{t:"ping"}` (ms). SOLO para tests (el default
   *  de 25s haría imposible testear el ping sin esperarlo). Prod no lo setea. */
  ssePingMs?: number;
  /** Override de los caps del ring buffer de frames (Fase C: replay al reconectar).
   *  SOLO para tests (forzar gap/resync con un buffer diminuto). Prod no lo setea. */
  frameBuffer?: FrameBufferOpts;
  log?: (s: string) => void;
}

export interface WebServer {
  /** Empuja un evento a los streams SSE vivos de un usuario; devuelve a cuántos llegó. Con
   *  `origin` (id de stream), entrega SÓLO a esa vista (respuesta de turno → al dispositivo que
   *  preguntó); sin `origin`, abanica a todos (egress proactivo: crons/REM/viewer/refresh). */
  pushToUser(userId: number, msg: unknown, origin?: string): number;
  /** Resuelve un handle (externalId del canal web) a su userId. Lo usa el entry-point para
   *  rutear los frames del canal remoto (que vienen por `user`=handle) a los SSE del user. */
  userIdByHandle(handle: string): number | undefined;
  close(): void;
}

// Adjunto crudo que manda el cliente (sin clasificar). `data` = base64 estándar; `mime` el
// MIME que reportó el browser; `name` el nombre del archivo (opcional). El server lo valida
// y lo clasifica a image|document (ver `classifyMedia`) antes de mandarlo al agente.
type ClientMedia = { name?: string; mime: string; data: string };

// Mensajes que manda el cliente por POST /api/send. El de texto puede traer `media` (chat web:
// imágenes/PDF adjuntos) — con o sin texto. `sid` = id de la pestaña/vista (mismo que abrió el
// stream SSE): identifica el origen para entregarle la respuesta sólo a ella (no eco multi-device).
type ClientMsg =
  | { t: "text"; text: string; media?: ClientMedia[]; openDoc?: { repo: string; path: string }; sid?: string }
  | { t: "audio"; mime?: string; data: string; openDoc?: { repo: string; path: string }; sid?: string };

// MA acepta como content block sólo imágenes (png/jpeg/gif/webp) y PDF. Tope de adjuntos por
// turno (defensa de tamaño además del MAX_SEND_BYTES del body entero).
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_MEDIA_PER_TURN = 8;

/** Valida + clasifica los adjuntos crudos del cliente a `MediaWire` (lo que viaja por el canal
 *  remoto). Descarta lo que MA no acepta (mime fuera de imagen/PDF, o data vacía). Devuelve
 *  hasta MAX_MEDIA_PER_TURN; el resto se ignora silenciosamente. */
function classifyMedia(raw: ClientMedia[] | undefined): MediaWire[] {
  if (!Array.isArray(raw)) return [];
  const out: MediaWire[] = [];
  for (const m of raw) {
    if (out.length >= MAX_MEDIA_PER_TURN) break;
    if (!m || typeof m.data !== "string" || !m.data) continue;
    const mime = typeof m.mime === "string" ? m.mime.toLowerCase() : "";
    const filename = typeof m.name === "string" && m.name ? m.name : undefined;
    if (IMAGE_MIMES.has(mime)) {
      out.push({ kind: "image", mediaType: mime, data: m.data, ...(filename ? { filename } : {}) });
    } else if (mime === "application/pdf") {
      out.push({
        kind: "document",
        mediaType: "application/pdf",
        data: m.data,
        ...(filename ? { filename } : {}),
      });
    }
    // otros mimes: MA no los acepta como bloque → se descartan.
  }
  return out;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// --- Avatar de perfil (edición web) ----------------------------------------
// Tope del BLOB decodificado (512KB) y formatos aceptados. El upload viene como JSON
// base64 (consistente con el audio/media de /api/send), no multipart.
const MAX_AVATAR_BYTES = 512 * 1024;
const AVATAR_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Detecta el tipo de imagen por magic bytes — NO confiamos en el mime declarado por el
 *  cliente (un .exe renombrado a .png pasaría el filtro de extensión). Devuelve el mime
 *  canónico (PNG/JPEG/WebP) o null si no matchea ninguno. */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  return null;
}

/** Defensa CSRF en profundidad sobre SameSite=Lax: en POSTs autenticados rechazamos si
 *  el Origin (o, como fallback, el Referer) no apunta al mismo host del request. Hoy la
 *  cookie es SameSite=Lax → un POST cross-site no se manda; esto cierra el caso edge
 *  (subdominio relacionado, browser viejo, etc.). Si no viene ni Origin ni Referer,
 *  rechazamos: los browsers serios mandan al menos uno en POST same-origin. */
function originAllowed(req: IncomingMessage): boolean {
  return isAllowedOrigin(req.headers.host, req.headers.origin ?? req.headers.referer);
}

/** Mejor esfuerzo para identificar el origen de un request para rate-limit. En la box,
 *  nginx termina TLS y reenvía con `x-forwarded-for`; en dev local pega directo. */
function clientIp(req: IncomingMessage): string {
  const xf = req.headers["x-forwarded-for"];
  return clientIpFrom(typeof xf === "string" ? xf : undefined, req.socket.remoteAddress);
}

/** Lee el valor de una cookie por nombre, o undefined. */
function readCookie(req: IncomingMessage, name: string): string | undefined {
  return parseCookie(req.headers.cookie, name);
}

/** Lee la cookie de sesión de un request y devuelve el userId si el token valida y no venció. */
function userIdFromCookie(req: IncomingMessage, sessionKey: string): number | undefined {
  const tok = readCookie(req, COOKIE);
  return tok ? verifySessionToken(tok, sessionKey, Date.now()) : undefined;
}

function setSessionCookie(res: ServerResponse, userId: number, sessionKey: string): void {
  // El token lleva el `exp` embebido (= Max-Age de la cookie): aunque la cookie sobreviva al
  // logout o sea capturada, el token caduca solo a los 30 días. No es revocación instantánea
  // (eso pediría un epoch por-usuario en DB), pero acota la vida de un token suelto.
  const token = signSessionToken(userId, sessionKey, Date.now() + SESSION_MAX_AGE_S * 1000);
  // appendHeader (no setHeader): en el callback de Google sale junto al Set-Cookie que borra la
  // cookie de state; setHeader pisaría uno de los dos.
  res.appendHeader("Set-Cookie", buildSetCookie(COOKIE, token, { path: "/", maxAge: SESSION_MAX_AGE_S }));
}

// Logout: la cookie es stateless (token firmado, sin store server-side) → desloguear = pedirle
// al browser que la borre (Max-Age=0). El token sigue siendo válido hasta su `exp`, pero al no
// mandarse más, la próxima request cae en 401 → la SPA muestra el login.
function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("Set-Cookie", buildSetCookie(COOKIE, "", { path: "/", maxAge: 0 }));
}

// Cookie temporal que ata el `state` del login Google al browser que inició el flujo: se setea
// en /start y se exige (igual al `state` del query) en /callback. Path acotado a la ruta del
// login; SameSite=Lax → viaja en la navegación top-level GET del redirect de Google. Usa
// appendHeader para no pisar el Set-Cookie de sesión cuando ambos salen en el callback.
function setStateCookie(res: ServerResponse, state: string): void {
  const cookie = buildSetCookie(STATE_COOKIE, state, {
    path: "/api/auth/google",
    maxAge: STATE_COOKIE_TTL_S,
  });
  res.appendHeader("Set-Cookie", cookie);
}
function clearStateCookie(res: ServerResponse): void {
  res.appendHeader("Set-Cookie", buildSetCookie(STATE_COOKIE, "", { path: "/api/auth/google", maxAge: 0 }));
}

// Auto-provisión de la wiki personal en el alta (invariante: todo usuario arranca con la suya).
// Mismo trío que `ceibo repo create <h> personal`: crea el repo `<handle>-personal` en GitHub +
// lo registra + le da acceso al dueño. Best-effort: el `createRepo` toca GitHub (async, puede
// fallar) → NO va en la transacción del alta y NO bloquea el login; si falla, se loguea con la
// línea exacta para recrearla. Idempotente: si el repo ya está en el store, sólo asegura el grant.
async function provisionPersonalWiki(
  db: Db,
  wikis: Wikis | undefined,
  user: User,
  log: (s: string) => void,
): Promise<void> {
  if (!wikis) {
    log(`signup wiki: ${user.handle} sin wikis configurado — saltado`);
    return;
  }
  const label = "personal";
  const name = userRepoName(user.handle, label);
  const org = wikis.org;
  try {
    let repo = getRepoByName(db, org, name);
    if (!repo) {
      await wikis.createRepo(name); // repo privado en GitHub (auto_init)
      await seedWelcomeNote(wikis, name, log); // README pelado → nota Bienvenida.md (best-effort)
      repo = addRepo(db, org, name, label);
    }
    // El creador queda dueño (role='owner') y la wiki personal se marca como tal.
    grantAccess(db, repo.id, user.id, "owner");
    db.prepare("UPDATE repos SET personal = 1 WHERE id = ?").run(repo.id);
    log(`signup wiki: ${org}/${name} lista para ${user.handle}`);
  } catch (e) {
    log(
      `signup wiki ERROR ${user.handle} (${org}/${name}): ${(e as Error)?.message ?? e} — recreá con: ceibo repo create ${user.handle} ${label}`,
    );
  }
}

// --- Vista de conexiones (GET /api/connections, v2) ---------------------------
// Canales conversacionales que mostramos en la web. OJO: el store guarda también una identidad
// `google` (allowlist del login OIDC, creada por el admin con `ceibo channel add <h> google
// <email>`) que NO es un canal de mensajería — la excluimos para que no aparezca como "google"
// en Canales (bug de la v1, que listaba TODO channel_identities sin filtrar).
const CONVERSATIONAL_CHANNELS = ["telegram", "whatsapp", "web"];

// Un perfil conectado de un servicio + la cuenta externa real (ej. user@example.com), o null si
// no se pudo obtener con el scope actual del grant (la UI muestra fallback), + los permisos
// legibles otorgados (derivados del scope del grant o del catálogo del servicio). `broken` =
// el grant murió (invalid_grant → venció el permiso): conectado PERO hay que reconectar (tri-estado).
type ConnProfile = { profile: string; account: string | null; permissions: string[]; broken: boolean };
// `broken` a nivel service = algún perfil roto (para el tinte de warning del card sin abrir el detalle).
type ConnectionsView = {
  channels: { type: string; connected: boolean; identities: string[] }[];
  connections: {
    service: string;
    displayName: string;
    connected: boolean;
    broken: boolean;
    profiles: ConnProfile[];
  }[];
};

function serviceDisplayName(service: string): string {
  if (service === "whatsapp") return "WhatsApp";
  return SERVICES[service]?.displayName ?? service;
}

/** Arma el catálogo de canales + conexiones marcando lo conectado. Read-only; espeja el
 *  `/connections` del gateway pero devolviendo TAMBIÉN lo conectable (no sólo lo activo). */
function buildConnectionsView(db: Db, userId: number, whatsappEnabled: boolean): ConnectionsView {
  // Canales conectados, agrupados por tipo (sólo los conversacionales conocidos; `google` u
  // otras identidades de auth quedan fuera por diseño — ver bug "google" de la v1).
  const identitiesByType = new Map<string, string[]>();
  for (const c of listChannels(db, userId)) {
    if (!CONVERSATIONAL_CHANNELS.includes(c.channel)) continue;
    const arr = identitiesByType.get(c.channel) ?? [];
    arr.push(c.external_id);
    identitiesByType.set(c.channel, arr);
  }
  // Sólo mostramos los canales que EXISTEN (en orden estable). A diferencia de las conexiones,
  // un canal no se "conecta" por comando (telegram es la raíz, web es este dispositivo); la
  // única posibilidad real de vincular —WhatsApp— vive en Conexiones, así que acá no padeamos
  // con items "no vinculado".
  const channels = CONVERSATIONAL_CHANNELS.filter((t) => identitiesByType.has(t)).map((type) => ({
    type,
    connected: true,
    identities: identitiesByType.get(type) ?? [],
  }));

  // Cuenta externa real por (servicio, perfil), tomada de los grants OAuth. Los canales no-OAuth
  // (whatsapp) no tienen grant → su cuenta queda null (la UI muestra fallback).
  const grantByKey = new Map<string, { account: string | null; scope: string; broken: boolean }>();
  for (const g of listGrantsForUser(db, userId)) {
    grantByKey.set(`${g.service}\x00${g.profile}`, {
      account: g.account,
      scope: g.scope,
      broken: g.broken_at != null, // grant muerto (invalid_grant): conectado pero hay que reconectar
    });
  }

  // Conexiones: perfiles conectados por servicio (con su cuenta real + si están rotos).
  const profilesByService = new Map<string, ConnProfile[]>();
  for (const conn of listConnections(db, userId)) {
    const arr = profilesByService.get(conn.service) ?? [];
    const g = grantByKey.get(`${conn.service}\x00${conn.profile}`);
    arr.push({
      profile: conn.profile,
      account: g?.account ?? null,
      permissions: describePermissions({ service: conn.service, scope: g?.scope }),
      broken: g?.broken ?? false,
    });
    profilesByService.set(conn.service, arr);
  }
  // Catálogo de conectables: SERVICE_NAMES (OAuth) + whatsapp si el gateway lo tiene (wacli).
  // Espeja `conectables` del gateway (engine.ts, /connections).
  const connectables = whatsappEnabled ? [...SERVICE_NAMES, "whatsapp"] : [...SERVICE_NAMES];
  // Defensa: si hay un servicio conectado fuera del catálogo (wacli apagado pero ya vinculado,
  // o un servicio futuro), lo sumamos igual para no esconder algo activo.
  for (const svc of profilesByService.keys()) if (!connectables.includes(svc)) connectables.push(svc);
  const connections = connectables.map((service) => {
    const profiles = (profilesByService.get(service) ?? []).sort((a, b) =>
      a.profile.localeCompare(b.profile),
    );
    return {
      service,
      displayName: serviceDisplayName(service),
      connected: profilesByService.has(service),
      broken: profiles.some((p) => p.broken), // algún perfil roto → el card muestra "reconectar"
      profiles,
    };
  });

  return { channels, connections };
}

// --- Endpoint público /api/bg: imagen de fondo desde Unsplash ----------------
//
// Busca una imagen en Unsplash usando queries curadas (bosque, árboles, luz, cozy)
// y devuelve { url, author, authorLink, link } para que el cliente la use como fondo
// y muestre la atribución requerida por las guidelines de Unsplash.
//
// Sin UNSPLASH_ACCESS_KEY → { url: null }. También devuelve { url: null } si Unsplash
// falla o tarda más de 2s (el cliente usa las imágenes locales como fallback).
//
// Cache en memoria por CONJUNTO de queries (una imagen cada 10 minutos por pool):
// protege el tier gratuito de 50 req/hora. Los usuarios que comparten el default
// comparten la entrada; un usuario con queries propias (cog de settings) tiene la
// suya — nunca le servimos la imagen cacheada de otro pool.
//
// Default elegido por el owner en lab testing: /photos/random saca una foto distinta del
// pool en cada fetch. Editá esta entrada si los resultados no son satisfactorios.
const UNSPLASH_BG_QUERIES: readonly string[] = ["forest trees light sunrays"];

const BG_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos
// Tope de entradas vivas del cache (una por pool de queries distinto). Acota memoria si
// muchos usuarios configuran pools distintos; al pasarlo, FIFO (Map preserva inserción).
const BG_CACHE_MAX_KEYS = 100;
// Validación del setting (POST /api/me): cantidad y longitud máximas por query. Acota el
// payload que mandamos a Unsplash y evita guardar listas absurdas.
export const BG_MAX_QUERIES = 10;
export const BG_MAX_QUERY_LEN = 200;

/** Normaliza la lista de queries de fondo que manda el cliente: sólo strings, trimmeadas,
 *  sin vacías, hasta BG_MAX_QUERIES (el resto se descarta). null = nada utilizable (el
 *  caller la trata como "sin preferencia" → default de la app). Una query más larga que
 *  BG_MAX_QUERY_LEN invalida el pedido (devuelve { error }) para que el usuario se entere
 *  en vez de truncar en silencio. */
export function normalizeBgQueries(input: unknown): { queries: string[] | null } | { error: string } {
  if (input === null) return { queries: null };
  if (!Array.isArray(input)) return { error: "bad-request" };
  const queries: string[] = [];
  for (const q of input) {
    if (typeof q !== "string") continue; // basura no-string → se ignora
    const trimmed = q.trim();
    if (!trimmed) continue; // vacías → se ignoran
    if (trimmed.length > BG_MAX_QUERY_LEN) return { error: "query-too-long" };
    queries.push(trimmed);
    if (queries.length >= BG_MAX_QUERIES) break; // tope de cantidad: el resto se descarta
  }
  return { queries: queries.length > 0 ? queries : null };
}

type BgResult = {
  url: string;
  // Placeholder LQIP: la MISMA foto a 32px + blur, proxeada igual que `url`. El cliente la
  // pinta borrosa al instante mientras baja la `url` full, y funde a la nítida al decodear.
  // Cero flash: hasta que esto llega, el fondo es el color sólido del theme (CSS var(--bg)).
  placeholder: string;
  author: string;
  authorLink: string;
  link: string;
};
type BgCache = { result: BgResult | null; fetchedAt: number };

// Cache por clave = el pool de queries efectivo (join con \n: no aparece en una query
// trimmeada → clave inyectiva). Default y usuarios sin preferencia comparten entrada.
const bgCacheByKey = new Map<string, BgCache>();

/** Limpia el caché del fondo de Unsplash. Sólo para tests. */
export function _resetBgCacheForTests(): void {
  bgCacheByKey.clear();
}

/** Descarga atribución cumpliendo las Unsplash API Guidelines: dispara el
 *  `download_location` fire-and-forget con el client_id (triggering download). */
function triggerUnsplashDownload(downloadLocation: string, accessKey: string): void {
  const url = `${downloadLocation}${downloadLocation.includes("?") ? "&" : "?"}client_id=${encodeURIComponent(accessKey)}`;
  fetch(url).catch(() => {
    /* fire-and-forget: si falla no queremos romper nada */
  });
}

function proxiedBgUrl(rawUrl: string): string {
  return `/api/bg-image?url=${encodeURIComponent(rawUrl)}`;
}

function allowedUnsplashImageUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && url.hostname === "images.unsplash.com";
  } catch {
    return false;
  }
}

async function fetchUnsplashBg(accessKey: string, queries: readonly string[]): Promise<BgResult | null> {
  const query = queries[Math.floor(Math.random() * queries.length)];
  const apiUrl =
    `https://api.unsplash.com/photos/random` +
    `?query=${encodeURIComponent(query ?? "forest canopy sunlight")}` +
    `&orientation=landscape` +
    `&content_filter=high` +
    `&client_id=${encodeURIComponent(accessKey)}`;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 2000);
  try {
    const resp = await fetch(apiUrl, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      urls?: { regular?: string; raw?: string };
      user?: { name?: string; links?: { html?: string } };
      links?: { html?: string; download_location?: string };
    };
    // Usar raw con resize dinámico (2560px width, high quality) en lugar de regular (1080px).
    // raw + parámetros de CDN es más nítido en pantallas retina/4K sin costo extra de API.
    const raw = data.urls?.raw;
    const url = raw
      ? `${raw}${raw.includes("?") ? "&" : "?"}w=2560&q=80&auto=format&fit=max`
      : data.urls?.regular;
    // Placeholder LQIP de la MISMA foto: 32px + blur fuerte por el CDN (Imgix) de Unsplash,
    // proxeado igual que la full. ~3KB → el cliente lo pinta borroso al instante y funde a la
    // nítida cuando decodea. Sin `raw` (sólo `regular`) no hay placeholder: el cliente cae al
    // color sólido del theme, igual que con Unsplash offline.
    const sep = raw?.includes("?") ? "&" : "?";
    const placeholder = raw ? `${raw}${sep}w=32&q=40&blur=200&auto=format&fit=max` : "";
    const author = data.user?.name ?? "";
    const authorLink = data.user?.links?.html ?? "";
    const link = data.links?.html ?? "";
    const downloadLocation = data.links?.download_location;
    if (!url) return null;
    // Cumplir guidelines: reportar la descarga a Unsplash (fire-and-forget).
    if (downloadLocation) triggerUnsplashDownload(downloadLocation, accessKey);
    return {
      url: proxiedBgUrl(url),
      placeholder: placeholder ? proxiedBgUrl(placeholder) : "",
      author,
      authorLink,
      link,
    };
  } catch {
    return null; // timeout u otro error de red → el cliente usa fallback local
  } finally {
    clearTimeout(timeout);
  }
}

/** Devuelve la imagen del cache (por pool de queries) si es reciente; si no, fetcha una
 *  nueva y la cachea bajo la clave de ESE pool. Sin access key → null de inmediato. */
async function getBgCached(
  accessKey: string | undefined,
  queries: readonly string[],
): Promise<BgResult | null> {
  if (!accessKey) return null;
  const key = queries.join("\n");
  const now = Date.now();
  const hit = bgCacheByKey.get(key);
  if (hit && now - hit.fetchedAt < BG_CACHE_TTL_MS) return hit.result;
  const result = await fetchUnsplashBg(accessKey, queries);
  // FIFO al pasar el cap (las entradas vencidas son las más viejas en un Map de inserción;
  // borrar la primera alcanza para acotar sin trackear LRU de verdad).
  if (!bgCacheByKey.has(key) && bgCacheByKey.size >= BG_CACHE_MAX_KEYS) {
    const oldest = bgCacheByKey.keys().next().value;
    if (oldest !== undefined) bgCacheByKey.delete(oldest);
  }
  bgCacheByKey.set(key, { result, fetchedAt: now });
  return result;
}

export function startWebServer(opts: WebServerOpts): WebServer {
  const { db, port, staticDir, sessionKey, sendToAgent } = opts;
  const log = opts.log ?? (() => {});
  // Plano de control F3: inyectado por index.ts cableando requestSessionReset al canal remoto.
  // Sin inyección (tests sin gateway) es no-op: los endpoints de membresía no disparan reset.
  const resetSessions = opts.resetSessions ?? (() => {});

  // Mails de invitación (P2). Los callers inyectan overrides para tests; en prod se usan los
  // del módulo email.ts. Best-effort: si falta la key o Resend falla, se loguea y sigue.
  const sendInviteEmail =
    opts.sendInviteEmail ??
    (async (args: { to: string; inviterName: string; wikiLabel: string; acceptUrl: string }) => {
      if (!emailEnabled()) return;
      await _sendWikiInviteEmail(args);
    });
  // sendApprovedEmail se usa en P5 (POST /api/admin/waitlist/approve). Por ahora el flujo de
  // aprobación va solo por CLI; el opt queda reservado para cuando lo consuma el endpoint P5.
  const indexHtml = join(staticDir, "index.html");

  // Identidad de sesión gateada por status: un usuario `disabled` deja de existir para
  // TODA la API web (401 → la SPA cae al login) en vez de quedar en un limbo mudo. Antes
  // la cookie (stateless, 30 días) seguía sirviendo la SPA y aceptando turnos (/api/send
  // devolvía 202) de un usuario deshabilitado, pero el gateway los DESCARTABA en silencio
  // (`resolveUser` filtra `status='active'`) → "mando y no responde, ni con refresh"
  // (2026-06-11: el mobile del owner con sesión de un user disabled). La web cuenta la
  // verdad: sesión inválida. Costo: un SELECT por request a better-sqlite3 (local, ~µs).
  const activeUserId = (req: IncomingMessage): number | undefined => {
    const id = userIdFromCookie(req, sessionKey);
    if (!id) return undefined;
    return getUser(db, id)?.status === "active" ? id : undefined;
  };

  // Fase 3b (liviana): tras una escritura de la web (que sigue yendo por wikis.putFile/etc.,
  // 1 sola llamada — NO migramos al commit del substrato, que sería ~8x para el autosave
  // frecuente), registramos el cambio en el change feed para que las OTRAS pestañas web
  // refresquen (poller de 3a). Fire-and-forget + best-effort: no agrega latencia al save ni
  // lo rompe si falla (el poll de 5s del explorer es el fallback). `headSha` da el commit nuevo.
  const recordWebChange = (repo: string, entries: WikiChangeEntry[], userId: number): void => {
    if (!opts.wikis) return;
    void opts.wikis
      .headSha(repo)
      .then((ref) => {
        recordWikiChange(db, { repo, ref, entries, source: "web", userId });
        setWikiHead(db, repo, ref); // HEAD al día → el watcher no re-reporta este save propio
      })
      .catch((e) => log(`feed record (web ${repo}): ${(e as Error)?.message ?? e}`));
  };
  // Edición (PUT/autosave): registramos COALESCED — una sola fila "editaste X" por ráfaga (ver
  // recordWikiEdit). Alimenta el reporte de cambios en el chat (notificador del gateway). El feed
  // web (otras pestañas) IGNORA las ediciones para refrescar (sólo cambios estructurales), así no
  // reintroducimos el self-refresh del autosave que la nota al pie del PUT advierte.
  const recordWebEdit = (repo: string, path: string, userId: number): void => {
    if (!opts.wikis) return;
    void opts.wikis
      .headSha(repo)
      .then((ref) => {
        recordWikiEdit(db, { repo, ref, path, userId, source: "web" });
        setWikiHead(db, repo, ref);
      })
      .catch((e) => log(`feed edit (web ${repo}): ${(e as Error)?.message ?? e}`));
  };

  // Cache del blame por (repo, path), keyed al HEAD sha del repo: `headSha` es barato
  // (conditional request, 304 gratis) y el blame (GraphQL) sólo se recomputa cuando el repo
  // avanzó de verdad. Guardamos los ranges ya resueltos (handle→nombre y sha→source quedan
  // congelados por ventana de HEAD; aceptable: un rename de display name es rarísimo y el
  // próximo commit refresca). El flag `shared` NO se cachea (se computa por request: es una
  // query local y la membresía puede cambiar sin mover el HEAD). FIFO simple al pasar el cap.
  const blameCache = new Map<string, { ref: string; ranges: unknown[] }>();
  const BLAME_CACHE_MAX = 200;

  // Streams SSE vivos por usuario (egress del turno y, en Fase B, el viewer MCP). Un
  // usuario puede tener varias pestañas abiertas → varios streams. Anotamos cada uno
  // con su timer de corte (lifetime máximo) para limpiar al cerrar.
  const streamsByUser = new Map<number, Set<ServerResponse>>();
  const streamMeta = new WeakMap<ServerResponse, { closer: ReturnType<typeof setTimeout>; sid?: string }>();
  // Índice sid → stream para entregar la respuesta de un turno SÓLO a la vista que preguntó.
  // El sid es estable por pestaña (lo genera el cliente y lo reusa en cada reconexión del
  // EventSource): un reconnect sobreescribe el res viejo por el nuevo bajo el mismo sid.
  const streamBySid = new Map<string, ServerResponse>();
  const register = (userId: number, res: ServerResponse, sid?: string) => {
    const set = streamsByUser.get(userId) ?? new Set();
    // Dedup por sid (fix "mobile mudo", 2026-06-11): una reconexión bajo el MISMO sid
    // REEMPLAZA al stream anterior de esa pestaña — el cliente nunca mantiene dos
    // EventSource vivos por sid (cada reconnect cierra el previo), pero su
    // `req.on("close")` puede tardar minutos o no llegar (red mobile que flapea, HTTP/2
    // zombie del edge). Sin esto cada reconexión SUMABA una entrada al set (en prod el
    // mismo sid llegó a registrarse 7 veces, incluso 2 en el mismo segundo) → el cap se
    // llenaba de streams stale de UNA pestaña y el LRU evictaba streams VIVOS de otros
    // dispositivos. Lo sacamos del set y lo cerramos ANTES del chequeo de cap: una
    // pestaña que reconecta N veces ocupa SIEMPRE 1 sola entrada.
    if (sid) {
      const prev = streamBySid.get(sid);
      // `set.has(prev)` = el res viejo es de ESTE user (defensa cross-user, como deliver).
      if (prev && prev !== res && set.has(prev)) {
        const meta = streamMeta.get(prev);
        if (meta) clearTimeout(meta.closer);
        streamMeta.delete(prev);
        set.delete(prev);
        try {
          prev.end();
        } catch {
          /* ya cerrado */
        }
        // streamBySid NO se toca acá: abajo se reapunta al res nuevo. El close tardío del
        // prev cae en unregister sin meta → no borra el vínculo vivo ni rompe nada.
      }
    }
    // Cap de streams concurrentes por user (LRU): si llegamos al tope, expulsamos
    // los más viejos primero (Set en JS mantiene orden de inserción). Esto evita
    // que un browser zombi o un attacker auth retenga cientos de keep-alives.
    while (set.size >= SSE_MAX_PER_USER) {
      const oldest = set.values().next().value;
      if (!oldest) break;
      log(`SSE evict (cap ${SSE_MAX_PER_USER}): user=${userId}`);
      unregister(userId, oldest);
      try {
        oldest.end();
      } catch {
        /* ya cerrado */
      }
    }
    set.add(res);
    streamsByUser.set(userId, set);
    if (sid) streamBySid.set(sid, res); // reconnect bajo el mismo sid → reapunta al res nuevo
    // Corte duro a las 4h: forzamos al cliente a reconectar (EventSource lo hace solo)
    // así no acumulamos streams zombi en el server cuando el browser quedó pegado.
    const closer = setTimeout(() => {
      try {
        res.end();
      } catch {
        /* ya cerrado */
      }
    }, SSE_MAX_LIFETIME_MS);
    streamMeta.set(res, { closer, sid });
  };
  const unregister = (userId: number, res: ServerResponse) => {
    const meta = streamMeta.get(res);
    if (meta) clearTimeout(meta.closer);
    // Sólo limpiamos el índice si todavía apunta a ESTE res: un reconnect pudo haberlo
    // reapuntado a un res nuevo bajo el mismo sid, y no queremos borrar el vínculo vivo.
    if (meta?.sid && streamBySid.get(meta.sid) === res) streamBySid.delete(meta.sid);
    streamMeta.delete(res);
    const set = streamsByUser.get(userId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) streamsByUser.delete(userId);
  };
  // Ring buffer de frames por usuario (Fase C, conexión rock-solid): TODO frame que pasa por
  // `deliver` recibe un seq monotónico por-usuario, queda retenido acotado (frames/bytes/TTL)
  // y se re-emite al reconectar un stream con watermark (`Last-Event-ID` o `?since=`). Así la
  // respuesta de un turno emitida con el SSE caído deja de perderse para siempre (web.ts:679
  // del análisis). Detalle de diseño/honestidad (gap → resync) en frameBuffer.ts.
  const frames = new FrameBuffer(opts.frameBuffer);
  const recentEgress = new Map<string, number>();
  const dedupeEgress = (userId: number, msg: Record<string, unknown>, origin?: string): boolean => {
    const t = msg.t;
    if (t !== "voice" && t !== "text") return false;
    const text = typeof msg.text === "string" ? msg.text.trim() : "";
    if (!text) return false;
    const windowMs = t === "voice" ? 5000 : 1500;
    const key = `${userId}\0${origin ?? ""}\0${t}\0${text}`;
    const now = Date.now();
    const prev = recentEgress.get(key);
    recentEgress.set(key, now);
    if (recentEgress.size > 200) {
      for (const [k, at] of recentEgress) {
        if (now - at > 60_000) recentEgress.delete(k);
      }
    }
    if (prev === undefined || now - prev > windowMs) return false;
    log(`web dedupe: user=${userId} origin=${origin?.slice(0, 8) ?? "broadcast"} t=${t}`);
    return true;
  };
  // Con `origin` (sid de la vista que originó el turno) entrega SÓLO a ese stream; sin él,
  // abanica a todos los streams del usuario (egress proactivo: crons/REM/viewer/refresh).
  // SIEMPRE buffera antes de entregar — incluso sin ningún stream vivo (devuelve 0 pero el
  // frame queda replay-able): ése es exactamente el caso que la Fase C rescata.
  const deliver = (userId: number, msg: unknown, origin?: string): number => {
    const payload = msg as Record<string, unknown>;
    if (dedupeEgress(userId, payload, origin)) return 0;
    const frame = frames.push(userId, payload, origin);
    const set = streamsByUser.get(userId);
    if (!set) return 0;
    if (origin) {
      const res = streamBySid.get(origin);
      // El stream del origen tiene que seguir vivo Y pertenecer a este user (defensa cross-user).
      if (res && set.has(res)) {
        if (writeSse(res, frame.payload, { id: frame.seq })) return 1;
        unregister(userId, res);
        return 0;
      }
      // Origen desconocido (la pestaña cerró/reconectó con otro sid entre el send y la respuesta):
      // caemos a fanout para no PERDER la respuesta. Reintroduce un eco transitorio sólo en ese
      // caso de borde; preferible a tragarse la respuesta del usuario.
    }
    let n = 0;
    // Si el stream rechaza un write (cliente desconectado pero el `req.on("close")`
    // todavía no disparó), lo limpiamos ahí mismo para no contar muertos.
    const dead: ServerResponse[] = [];
    for (const res of set) {
      if (writeSse(res, frame.payload, { id: frame.seq })) n++;
      else dead.push(res);
    }
    for (const res of dead) unregister(userId, res);
    return n;
  };

  // La traducción de la respuesta del agente a frames SSE (`text`/`typing`/`heard`/`voice`)
  // vive ahora en el entry-point (index.ts): recibe los frames del canal remoto y los abanica
  // con `pushToUser` (= deliver). web.ts ya no construye un PostTarget por turno.

  // viewer MCP (Fase B): in-process con el mapa de streams. Sólo si hay path-secret Y
  // HMAC key (C1). viewer_create es atómico: necesita wikis (para crear el archivo) y
  // userRepoNames (gate por los repos del usuario, mismo modelo que /api/file).
  const viewerServer: McpServer | undefined =
    opts.viewerSecret && opts.viewerHmacKey && opts.wikis && opts.userRepoNames
      ? makeViewerServer(opts.viewerHmacKey, deliver, opts.wikis, opts.userRepoNames)
      : undefined;

  // Endpoint de sync del substrato (Fase 2a): server-to-sandbox por Bearer firmado. Sólo si
  // hay secret + wikis + userRepoNames. El sandbox NUNCA ve el token de GitHub (ver wiki-sync.ts).
  const wikiSync =
    opts.wikiSyncSecret && opts.wikis && opts.userRepoNames
      ? makeWikiSyncHandler({
          secret: opts.wikiSyncSecret,
          wikis: opts.wikis,
          userRepoNames: opts.userRepoNames,
          db,
          readBody,
          log,
        })
      : undefined;

  // Proxy git smart-HTTP scopeado (plan substrato-wikis-working-copy.md, pieza VM):
  // /api/git/* para que la VM de archima haga clone/pull/push con git nativo sin tener
  // el PAT de GitHub ni conectividad directa a github.com. Mismo mecanismo de auth que
  // /api/sync (Bearer firmado → userId → allowlist de repos). Opt-in igual que wikiSync.
  // FRONTERA 1: allowedIps (WIKI_GIT_ALLOWED_IPS) — fail-closed; sin IPs, el handler
  // deniega todo. La IP se pasa desde afuera para que el handler sea testeable en aislamiento.
  const wikiGitProxy =
    opts.wikiSyncSecret && opts.wikis && opts.userRepoNames
      ? makeWikiGitProxyHandler({
          secret: opts.wikiSyncSecret,
          wikis: opts.wikis,
          userRepoNames: opts.userRepoNames,
          allowedIps: opts.gitAllowedIps ?? new Set(),
          log,
        })
      : undefined;

  // REM batch-pull (Fase 5b): dos endpoints para que gpuhost consulte qué wikis ordenar y
  // reporte los resultados. Bearer de sistema (REM_BATCH_SECRET) + gate de IP (reusa
  // WIKI_GIT_ALLOWED_IPS por default). Sin secret → no se monta.
  // Digest a Telegram directo (sin gateway). TELEGRAM_BOT_TOKEN opt-in.
  const remBatch =
    opts.remBatchSecret && opts.wikis && opts.wikiSyncSecret
      ? makeRemBatchHandler({
          secret: opts.remBatchSecret,
          allowedIps: opts.remBatchAllowedIps ?? opts.gitAllowedIps ?? new Set(),
          db,
          wikis: opts.wikis,
          wikiSyncSecret: opts.wikiSyncSecret,
          telegramBotToken: opts.telegramBotToken,
          log,
        })
      : undefined;

  // Rate-limit por user en POSTs autenticados (60 req/min, ventana fija). Sin Redis;
  // se pierde al reiniciar (aceptable para una cota suave). El gateway ya cubre
  // /api/login por IP; este map cubre todo lo demás post-login.
  const rateByUser = new Map<number, { count: number; windowStart: number }>();
  const noteUserRequest = (userId: number): { allowed: boolean; count: number } => {
    const now = Date.now();
    const entry = rateByUser.get(userId);
    if (!entry || now - entry.windowStart > USER_RATE_WINDOW_MS) {
      rateByUser.set(userId, { count: 1, windowStart: now });
      return { allowed: true, count: 1 };
    }
    entry.count++;
    return { allowed: entry.count <= USER_RATE_MAX_PER_WINDOW, count: entry.count };
  };
  // Helper único para los POSTs autenticados: chequeo + respuesta 429 con header
  // Retry-After (segundos hasta que la ventana se purgue). Devuelve true si está OK.
  const enforceUserRate = (userId: number, res: ServerResponse): boolean => {
    const r = noteUserRequest(userId);
    if (r.allowed) return true;
    const entry = rateByUser.get(userId);
    const retryAfter = entry
      ? Math.max(1, Math.ceil((USER_RATE_WINDOW_MS - (Date.now() - entry.windowStart)) / 1000))
      : 60;
    log(`user rate-limit: user=${userId} count=${r.count} (cap ${USER_RATE_MAX_PER_WINDOW}/min)`);
    res
      .writeHead(429, {
        "content-type": "application/json",
        "retry-after": String(retryAfter),
      })
      .end('{"error":"too-many-requests"}');
    return false;
  };

  // Rate-limit de /api/login (item auditoría 9): ventana móvil por IP. Si el writer
  // pasa el cap loguea + 429; el contador se purga al expirar la ventana o al usar
  // exitosamente el token.
  const loginAttempts = new Map<string, { count: number; windowStart: number }>();
  const noteLoginAttempt = (ip: string): { allowed: boolean; count: number } => {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
      loginAttempts.set(ip, { count: 1, windowStart: now });
      return { allowed: true, count: 1 };
    }
    entry.count++;
    return { allowed: entry.count <= LOGIN_MAX_PER_WINDOW, count: entry.count };
  };

  // Keep-alive OBSERVABLE: un evento SSE real `{t:"ping"}` cada 25s mantiene viva la conexión
  // a través del edge Y le da al cliente una señal de vida que SÍ dispara `onmessage` (antes
  // era el comentario `:keep-alive`, que el browser no entrega a JS → el watchdog de liveness
  // del cliente no tenía nada que observar y una conexión half-open quedaba zombie para
  // siempre). El cliente usa el ping sólo para marcar liveness; un cliente viejo lo ignora
  // (parse OK, ningún case del switch matchea). Si un write devuelve false (socket cerrado
  // pero req.on("close") no disparó), limpiamos el stream — sin esto se acumulaban
  // referencias muertas en streamsByUser.
  const ping = setInterval(() => {
    for (const [userId, set] of streamsByUser) {
      const dead: ServerResponse[] = [];
      for (const res of set) {
        if (!writeSse(res, { t: "ping" })) dead.push(res);
      }
      for (const res of dead) unregister(userId, res);
    }
    // GC de los mapas de rate-limit: tiramos ventanas vencidas (no hay leak fuerte
    // —cada IP/user usa pocos bytes— pero el set acumula durante semanas si no).
    const now = Date.now();
    for (const [ip, e] of loginAttempts) {
      if (now - e.windowStart > LOGIN_WINDOW_MS) loginAttempts.delete(ip);
    }
    for (const [userId, e] of rateByUser) {
      if (now - e.windowStart > USER_RATE_WINDOW_MS) rateByUser.delete(userId);
    }
    // GC del ring buffer de frames (Fase C): expira lo más viejo que el TTL para que un
    // usuario que se fue no retenga frames (los `voice` pesan) en memoria indefinidamente.
    frames.sweep();
  }, opts.ssePingMs ?? SSE_PING_MS);

  // Refresh por suscripción al change feed (Fase 3a): tail de `wiki_changes`. Cuando una wiki
  // cambia (commit del agente vía /api/sync, de la web, o de un cron), empuja {t:"refresh"} a
  // las pestañas vivas de los usuarios con acceso a esa wiki — que re-fetchean su nota abierta.
  // Reemplaza el push viejo por WRITE_TOOLS (core) y el puente del endpoint de sync: ahora las
  // vistas se suscriben al SUBSTRATO (el feed), no a acciones del agente. Writer-agnostic.
  let feedCursor = latestWikiChangeId(db);
  const feedPoll = setInterval(() => {
    const changes = wikiChangesSince(db, feedCursor);
    if (changes.length === 0) return;
    feedCursor = changes[changes.length - 1]?.id ?? feedCursor;
    if (streamsByUser.size === 0) return; // nadie mirando → sólo avanzamos el cursor
    // Qué refresca y qué no, y los paths tocados por user → `isRefreshable`/`changedPathsForUser`
    // (feed.ts, testeado). En una línea: refresca todo salvo la edición de contenido que originó
    // la PROPIA web (autosave). El push lleva los paths cambiados de los repos del user para que
    // el cliente, si SU nota abierta está entre ellos, la espere con paciencia (read-after-write
    // del CDN). ANTES se saltaba TODA edición —incluida la del agente—: la nota abierta quedaba
    // vieja hasta el F5 manual (#33).
    if (!changes.some(isRefreshable)) return;
    for (const userId of streamsByUser.keys()) {
      const paths = changedPathsForUser(changes, opts.userRepoNames?.(userId) ?? []);
      if (paths) deliver(userId, { t: "refresh", changed: paths });
    }
  }, FEED_POLL_MS);

  // Watcher ÚNICO del HEAD del substrato (Fase 2c). Es el único que pollea GitHub para detectar
  // cambios OUT-OF-BAND (git push, edición en GitHub.com) que no pasan por el server. Mantiene
  // `wiki_heads` y, cuando detecta un HEAD nuevo, escribe en el change-feed → el feedPoll de
  // arriba refresca las pestañas (web). El gateway, por su lado, lee `wiki_heads` para la deriva
  // del agente SIN pollear. Una sola fuente de polling, dos consumidores (no duplicamos).
  //
  // Set vigilado = wikis con watermark reciente (deriva del agente) ∪ wikis de usuarios con
  // pestaña viva (refresh web). Acota el costo de API al uso real, no al total de wikis. (Escala
  // futura: conditional requests con ETag → los 304 no cuentan contra el rate limit.)
  const watchPoll = setInterval(() => {
    if (!opts.wikis) return;
    const wk = opts.wikis;
    const set = new Set<string>(listActiveWatermarkedRepos(db, WATCH_ACTIVE_MIN));
    for (const userId of streamsByUser.keys()) {
      for (const r of opts.userRepoNames?.(userId) ?? []) set.add(r);
    }
    if (set.size === 0) return; // nada vivo → no pegamos a GitHub
    for (const repo of set) {
      void wk
        .headSha(repo)
        .then((head) => {
          const known = getWikiHead(db, repo);
          if (known === head) return; // sin cambios
          setWikiHead(db, repo, head);
          // Primera observación (known === null) = seed: NO es un cambio para reportar a la web
          // (nadie estaba viendo una versión anterior). Sólo emitimos al feed un cambio real.
          if (known !== null) recordWikiChange(db, { repo, ref: head, paths: [] });
        })
        .catch((e) => log(`watch head ${repo}: ${(e as Error)?.message ?? e}`));
    }
  }, WATCH_POLL_MS);

  const server: Server = createServer((req, res) => {
    void handleHttp(req, res).catch((e) => {
      log(`web http error: ${(e as Error)?.message ?? e}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("error");
      }
    });
  });

  async function serveIndex(res: ServerResponse): Promise<void> {
    const html = await readFile(indexHtml);
    // `no-cache` = el browser DEBE revalidar el index.html en cada carga (no servirlo de caché
    // sin chequear). Sin esto quedaba pegado a un index viejo → asset hashes viejos → la UI no
    // se actualizaba aunque el deploy fuera nuevo. El index referencia los assets hasheados, que
    // sí se cachean para siempre (ver abajo).
    res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
    res.end(html);
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // FREEZE de escrituras de notas (cutover de F3): mientras el flag esté puesto, TODA vía
    // de escritura de CONTENIDO de notas devuelve 503 — editor (PUT/POST/DELETE/move/archive/
    // emoji), git push del agente (receive-pack) y el commit de sync (MA). Las lecturas y las
    // ops estructurales de wiki (crear/compartir) siguen. Se chequea acá, antes del ruteo.
    if (opts.freeze?.frozen() && isFrozenNoteWrite(req.method ?? "", path)) {
      res.writeHead(FREEZE_STATUS, { "content-type": "application/json" }).end(JSON.stringify(FREEZE_BODY));
      return;
    }

    // Sync del substrato (Fase 2a): /api/sync/* lo usa el sandbox del agente, autenticado por
    // Bearer firmado (NO cookie, NO origin-check: server-to-sandbox). Va antes que las rutas
    // de browser para no pasar por sus chequeos de cookie/origin.
    if (wikiSync && path.startsWith("/api/sync/")) {
      await wikiSync(req, res);
      return;
    }

    // Proxy git smart-HTTP (VM archima): /api/git/* — Bearer firmado (mismo que /api/sync),
    // scoping a repos del user, forward streaming a GitHub con installation token del App.
    // El token del App NUNCA sale hacia la VM; el token de la VM NUNCA va a GitHub.
    if (wikiGitProxy && path.startsWith("/api/git/")) {
      // MODO DB: git está DESCONECTADO como camino de escritura — el agente escribe por las
      // tools `notes_*`. Bloqueamos el push (receive-pack); el clone/pull (upload-pack) sigue
      // (hidratar la VM es inofensivo). Red de seguridad: aunque el worker ya no pushea (su
      // prompt usa las tools), un intento no corrompe git.
      if (opts.notesWriteMode === "db" && path.endsWith("/git-receive-pack") && req.method === "POST") {
        res
          .writeHead(409, { "content-type": "application/json" })
          .end(
            '{"error":"git-disconnected","message":"Las notas viven en la DB; escribí con las tools notes_*."}',
          );
        return;
      }
      await wikiGitProxy(req, res);
      return;
    }

    // REM batch-pull (gpuhost): /api/rem/* — Bearer de sistema (REM_BATCH_SECRET) + gate de IP.
    // GET /api/rem/batch enumera wikis con delta; POST /api/rem/report recibe resultados.
    if (remBatch && path.startsWith("/api/rem/")) {
      await remBatch(req, res);
      return;
    }

    // Versión del deploy: SHA corto + entorno. Público, sin auth (el SHA no es secreto).
    // Cachea la respuesta desde DEPLOY_SHA (resuelto al arrancar el proceso).
    if (path === "/api/version" && req.method === "GET") {
      const body = JSON.stringify({ env: ceiboEnv() as CeiboEnv, sha: DEPLOY_SHA });
      res.writeHead(200, { "content-type": "application/json" }).end(body);
      return;
    }

    // Canje del magic-link: la SPA POSTea el token (gated por JS, así un prefetch del
    // preview de Telegram —que sólo hace GET— NO lo quema). Valida+quema → cookie. El
    // token de un solo uso + TTL corto es la frontera de seguridad (no el <handle>).
    if (path === "/api/login" && req.method === "POST") {
      const ip = clientIp(req);
      const rl = noteLoginAttempt(ip);
      if (!rl.allowed) {
        log(`web login rate-limit: ip=${ip} count=${rl.count} (cap ${LOGIN_MAX_PER_WINDOW}/win)`);
        res.writeHead(429, { "content-type": "application/json" }).end('{"error":"too-many-requests"}');
        return;
      }
      // Origin check sobre el POST: el token magic-link ya es de un solo uso, pero
      // exigir Origin same-host elimina cookies forjadas vía formularios cross-origin.
      if (!originAllowed(req)) {
        log(`web login bad-origin: ip=${ip} origin=${req.headers.origin ?? ""}`);
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const body = (await readBody(req, 4096)) ?? "";
      let token: string | undefined;
      try {
        token = (JSON.parse(body) as { t?: string }).t;
      } catch {
        /* body inválido */
      }
      const userId = token ? peekWebLoginToken(db, token) : undefined;
      const user = userId ? getUser(db, userId) : undefined;
      if (!token || !user) {
        log(`web login fail: ip=${ip} reason=${!token ? "no-token" : "unknown-user"}`);
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-token"}');
        return;
      }
      // Usuario deshabilitado: NO mintear sesión (espeja el gate de `activeUserId` y el
      // `resolveUser` del pw-login). Claridad sobre anti-enumeración (decisión de producto).
      if (user.status !== "active") {
        log(`web login fail: ip=${ip} reason=disabled user=${user.id}`);
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"disabled"}');
        return;
      }
      markWebLoginTokenUsed(db, token);
      // Identidad de canal web (idempotente) → resolveUser("web", handle) en el send.
      if (!listChannels(db, user.id).some((c) => c.channel === CHANNEL && c.external_id === user.handle)) {
        addChannel(db, user.id, CHANNEL, user.handle);
      }
      // F6: materializar invitaciones pendientes para todos los emails del usuario.
      // El magic-link puede ser para un usuario que entró por Google (canal google) o email (canal email).
      const loginChannels = listChannels(db, user.id);
      for (const ch of loginChannels) {
        if (ch.channel === "email" || ch.channel === "google") {
          acceptInvitesForEmail(db, ch.external_id, user.id);
        }
      }
      setSessionCookie(res, user.id, sessionKey);
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ handle: user.handle, name: user.name ?? user.handle }));
      log(`web login: ${user.handle} (user=${user.id})`);
      return;
    }

    // Login web por email + contraseña (allowlist). El email es una identidad de canal
    // `email` pre-creada por el admin (`ceibo channel add <h> email <e>`); la password es
    // un verificador seteado por el admin (`ceibo user passwd <h>`). Mismo rate-limit por
    // IP y origin-check que el magic-link. Error genérico en todo fallo: no revela si el
    // email existe ni distingue "sin password" de "password mala" (anti-enumeración).
    if (path === "/api/login/password" && req.method === "POST") {
      const ip = clientIp(req);
      const rl = noteLoginAttempt(ip);
      if (!rl.allowed) {
        log(`web pw-login rate-limit: ip=${ip} count=${rl.count} (cap ${LOGIN_MAX_PER_WINDOW}/win)`);
        res.writeHead(429, { "content-type": "application/json" }).end('{"error":"too-many-requests"}');
        return;
      }
      if (!originAllowed(req)) {
        log(`web pw-login bad-origin: ip=${ip} origin=${req.headers.origin ?? ""}`);
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const body = (await readBody(req, 4096)) ?? "";
      let email: string | undefined;
      let password: string | undefined;
      try {
        const parsed = JSON.parse(body) as { email?: string; password?: string };
        email = parsed.email;
        password = parsed.password;
      } catch {
        /* body inválido */
      }
      // El email se normaliza a lowercase para matchear la identidad allowlisteada (el CLI
      // también lowercasea al hacer `channel add ... email`).
      const normEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
      const user = normEmail && password ? resolveUser(db, "email", normEmail) : undefined;
      if (!user || !password || !verifyUserPassword(db, user.id, password)) {
        log(`web pw-login fail: ip=${ip} email=${normEmail || "(none)"}`);
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad-credentials"}');
        return;
      }
      // Identidad de canal web idempotente (igual que el magic-link y Google).
      if (!listChannels(db, user.id).some((c) => c.channel === CHANNEL && c.external_id === user.handle)) {
        addChannel(db, user.id, CHANNEL, user.handle);
      }
      // F6: materializar invitaciones pendientes para el email usado en el login.
      acceptInvitesForEmail(db, normEmail, user.id);
      setSessionCookie(res, user.id, sessionKey);
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ handle: user.handle, name: user.name ?? user.handle }));
      log(`web pw-login: ${user.handle} (user=${user.id}) ${normEmail}`);
      return;
    }

    // Inicio del login/registro por magic link de mail (invite-only, igual que Google). Pide
    // `{email}`, y si está en la allowlist (o ya tiene cuenta) mintea un token de un solo uso y se
    // lo manda por mail como `<origin>/<handle>?t=<token>` (la SPA lo canjea en /api/login).
    // DECISIÓN DE PRODUCTO (ya NO es anti-enumeración): siendo un invite-only chico, priorizamos
    // claridad para el usuario. Si el email está autorizado (cuenta creada o existente) y se manda
    // el link → 200 `{"ok":true}`. Si NO está autorizado (sin cuenta y fuera de la allowlist) o el
    // formato es inválido → 200 `{"ok":false,"reason":...}` para que la UI avise "tu cuenta no está
    // autorizada todavía". Un error de envío de Resend NO es un problema de autorización → 200
    // `{"ok":true}` igual. El resultado real se loguea server-side.
    if (path === "/api/auth/email/start" && req.method === "POST") {
      if (!opts.sendMagicLink || !opts.webPublicOrigin) {
        res.writeHead(503, { "content-type": "application/json" }).end('{"error":"email-not-configured"}');
        return;
      }
      const ip = clientIp(req);
      const rl = noteLoginAttempt(ip);
      if (!rl.allowed) {
        log(`web email-start rate-limit: ip=${ip} count=${rl.count} (cap ${LOGIN_MAX_PER_WINDOW}/win)`);
        res.writeHead(429, { "content-type": "application/json" }).end('{"error":"too-many-requests"}');
        return;
      }
      if (!originAllowed(req)) {
        log(`web email-start bad-origin: ip=${ip} origin=${req.headers.origin ?? ""}`);
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const body = (await readBody(req, 4096)) ?? "";
      let rawEmail: string | undefined;
      try {
        rawEmail = (JSON.parse(body) as { email?: string }).email;
      } catch {
        /* body inválido */
      }
      const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
      // Validación de formato básica (no exhaustiva): algo@algo.algo. Un email mal formado nunca
      // matchea la allowlist; lo cortamos acá para no minar tokens ni mandar mails a basura.
      const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      // 200 con el resultado real (ver comentario del handler): `ok:true` cuando se manda el link;
      // `ok:false` cuando el email no está autorizado / mal formado → la UI muestra el aviso.
      const ok = () => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      const notAuthorized = (reason: "waitlisted" | "already-waitlisted" | "invalid") =>
        res.writeHead(200, { "content-type": "application/json" }).end(`{"ok":false,"reason":"${reason}"}`);
      if (!validEmail) {
        log(`web email-start: ip=${ip} email=${email || "(none)"} → formato inválido, no-op`);
        notAuthorized("invalid");
        return;
      }
      const reg = registerEmailUserIfAuthorized(db, email);
      if (!reg) {
        // Email no autorizado (P3, decisión #5): agregar a la lista de espera con provenance
        // automática (invited si tiene wiki_invite pendiente, self-signup si no).
        const { alreadyWaiting } = addToWaitingList(db, email);
        const reason = alreadyWaiting ? "already-waitlisted" : "waitlisted";
        log(`web email-start: ${email} no autorizado → waitlist (${reason})`);
        notAuthorized(reason);
        return;
      }
      if (reg.created) {
        log(`email signup: ${reg.user.handle} (user=${reg.user.id}) ${email} → backend local`);
        // Invariante: todo usuario arranca con su wiki personal. Best-effort (toca GitHub, NO
        // bloquea el signup ni el envío del link si falla): el admin puede recrearla con
        // `ceibo repo create <h> personal`. Misma semántica que el camino Google (~:1075).
        await provisionPersonalWiki(db, opts.wikis, reg.user, log);
      }
      const token = createWebLoginToken(db, reg.user.id);
      const url = `${opts.webPublicOrigin.replace(/\/$/, "")}/${reg.user.handle}?t=${token}`;
      try {
        await opts.sendMagicLink({ to: email, url });
        log(
          `web email-start: ${reg.user.handle} (user=${reg.user.id}) ${email} → link enviado${reg.created ? " (signup)" : ""}`,
        );
      } catch (e) {
        log(`web email-start SEND ERROR ${email}: ${(e as Error)?.message ?? e}`);
      }
      ok();
      return;
    }

    // Logout: borra la cookie de sesión. Origin-checked (POST con efecto). La SPA recarga después.
    if (path === "/api/logout" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      clearSessionCookie(res);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }

    // Fondo de pantalla desde Unsplash (público — se ve en la pantalla de login también).
    // Devuelve { url, author, authorLink, link } si hay imagen cacheada/disponible, o
    // { url: null } si no hay key o Unsplash falló → el cliente usa las imágenes locales.
    // Si el request trae sesión válida y el usuario configuró sus prompts (cog de settings),
    // se usa SU pool de queries; sin sesión (pre-login) o sin preferencia → default de la
    // app. Cache 10 min en memoria POR POOL (ver getBgCached): usuarios con queries
    // distintas nunca comparten entrada.
    if (path === "/api/bg" && req.method === "GET") {
      const accessKey = process.env.UNSPLASH_ACCESS_KEY;
      let queries: readonly string[] = UNSPLASH_BG_QUERIES;
      const bgUserId = activeUserId(req);
      if (bgUserId) {
        try {
          const own = getUserBgQueries(db, bgUserId); // ya saneadas; null = sin preferencia/basura
          if (own) queries = own;
        } catch (e) {
          log(`bg queries user=${bgUserId}: ${(e as Error)?.message ?? e} — uso el default`);
        }
      }
      const result = await getBgCached(accessKey, queries);
      res.writeHead(200, {
        "content-type": "application/json",
        // No cachear en el browser: queremos que cada carga del index.html pueda
        // servir una imagen diferente (el cache está en el server, no en el cliente).
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(result ?? { url: null }));
      return;
    }

    if (path === "/api/bg-image" && req.method === "GET") {
      const rawUrl = url.searchParams.get("url") ?? "";
      if (!allowedUnsplashImageUrl(rawUrl)) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end('{"error":"bad-bg-url"}');
        return;
      }
      try {
        // NO pedir AVIF: la URL de Unsplash lleva `auto=format`, así que devuelve el formato
        // que pida este Accept. iOS Safari no decodifica AVIF de forma confiable y `img.decode()`
        // rechaza → la textura WebGL del warp del orbe falla SOLO en mobile (la foto de fondo se
        // ve igual porque la pinta el CSS, que la pide directo con el Accept del browser). WebP
        // (iOS ≥14) + JPEG cubren todo y bajan menos bytes que un PNG. (2026-06-16)
        const upstream = await fetch(rawUrl, {
          headers: { accept: "image/webp,image/jpeg;q=0.9,image/*;q=0.8" },
        });
        if (!upstream.ok) {
          res.writeHead(upstream.status, { "cache-control": "no-store" });
          res.end();
          return;
        }
        const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
        if (!contentType.startsWith("image/")) {
          res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
          res.end('{"error":"bad-bg-content-type"}');
          return;
        }
        const body = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(200, {
          "content-type": contentType,
          "cache-control": "public, max-age=86400",
        });
        res.end(body);
      } catch {
        res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
        res.end('{"error":"bg-fetch-failed"}');
      }
      return;
    }

    // Google Sign-In (Fase 4.5): login web por OIDC. Sólo si está configurado (env del
    // entry-point). `start` redirige a Google con un `state` firmado; `callback` valida el
    // state, canjea el code, saca el email verificado y resuelve el usuario por la identidad
    // `google` (= allowlist por `ceibo channel add <h> google <email>`). Sin match → /?denied=1.
    if (path === "/api/auth/google/start" && req.method === "GET") {
      if (!opts.googleAuth) {
        res.writeHead(503, { "content-type": "text/plain" }).end("google sign-in no configurado");
        return;
      }
      const state = signState(sessionKey, Date.now());
      setStateCookie(res, state); // ata el state al browser → se exige igual en el callback
      res.writeHead(302, { Location: buildAuthUrl(opts.googleAuth, state) }).end();
      return;
    }
    if (path === "/api/auth/google/callback" && req.method === "GET") {
      if (!opts.googleAuth) {
        res.writeHead(503, { "content-type": "text/plain" }).end("google sign-in no configurado");
        return;
      }
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const cookieState = readCookie(req, STATE_COOKIE) ?? "";
      // El state tiene que (a) venir firmado y vigente Y (b) matchear la cookie seteada en
      // /start (atado al browser → cierra el login-CSRF de OAuth). Comparación en tiempo
      // constante; el guard de longitud evita el throw de timingSafeEqual.
      const stateBound =
        state.length === cookieState.length &&
        cookieState.length > 0 &&
        timingSafeEqual(Buffer.from(state), Buffer.from(cookieState));
      if (!code || !stateBound || !verifyState(state, sessionKey, Date.now())) {
        clearStateCookie(res);
        log(`google callback bad-state: ip=${clientIp(req)}`);
        res.writeHead(302, { Location: "/?denied=1" }).end();
        return;
      }
      clearStateCookie(res); // single-use: el state cumplió su función
      try {
        const idToken = await exchangeCode(opts.googleAuth, code);
        const email = emailFromClaims(decodeIdToken(idToken), opts.googleAuth.clientId, Date.now());
        // Gate = allowlist por email. Usuario existente → login. Email autorizado sin cuenta →
        // alta automática atómica (backend_mode='local', identidad `google`). No autorizado →
        // undefined → waitlist (P3, decisión #5). El chequeo de autorización y el alta van juntos
        // en el store (registerGoogleUserIfAuthorized) → un solo gate, sin ventana de bypass.
        const reg = registerGoogleUserIfAuthorized(db, email);
        if (!reg) {
          // Email no autorizado: agregar a la lista de espera (provenance automática).
          const { alreadyWaiting } = addToWaitingList(db, email);
          const param = alreadyWaiting ? "already" : "1";
          log(`google login denegado: ${email} (no autorizado) → waitlisted=${param}`);
          res.writeHead(302, { Location: `/?waitlisted=${param}` }).end();
          return;
        }
        const { user, created } = reg;
        if (created) {
          log(`google signup: ${user.handle} (user=${user.id}) ${email} → backend local`);
          // Invariante: todo usuario arranca con su wiki personal. Best-effort (toca GitHub, NO
          // bloquea el login si falla): el admin puede recrearla con `ceibo repo create <h> personal`.
          await provisionPersonalWiki(db, opts.wikis, user, log);
        }
        // Identidad de canal web idempotente (igual que el magic-link) → resolveUser("web", handle).
        if (!listChannels(db, user.id).some((c) => c.channel === CHANNEL && c.external_id === user.handle)) {
          addChannel(db, user.id, CHANNEL, user.handle);
        }
        // F6: materializar invitaciones pendientes para el email de Google.
        acceptInvitesForEmail(db, email, user.id);
        setSessionCookie(res, user.id, sessionKey);
        log(`google login: ${user.handle} (user=${user.id}) ${email}`);
        res.writeHead(302, { Location: "/" }).end();
      } catch (e) {
        log(`google login error: ${(e as Error)?.message ?? e}`);
        res.writeHead(302, { Location: "/?denied=1" }).end();
      }
      return;
    }

    // Cliente→server (managed-ui): audio grabado / texto. Dispara el turno; la respuesta
    // del agente vuelve por el stream SSE. Responde 202 al toque (no espera el turno).
    if (path === "/api/send" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      const body = await readBody(req, MAX_SEND_BYTES);
      if (body === null) {
        // Body > MAX_SEND_BYTES (típico: audio enorme en base64). 413 honesto: el cliente
        // lo traduce a "audio demasiado largo" sin reintentos (un fallo de red genérico,
        // en cambio, lo haría reintentar un envío que jamás va a entrar).
        log(`/api/send user=${user.id} body too large (> ${MAX_SEND_BYTES}B) → 413`);
        res.writeHead(413, { "content-type": "application/json" }).end('{"error":"too-large"}');
        return;
      }
      let msg: ClientMsg | undefined;
      try {
        msg = JSON.parse(body) as ClientMsg;
      } catch {
        /* body inválido */
      }
      const text = msg?.t === "text" ? msg.text : "";
      const audio: InboundAudio | undefined =
        msg?.t === "audio"
          ? { fetchData: async () => Buffer.from(msg.data, "base64"), mime: msg.mime }
          : undefined;
      const media = msg?.t === "text" ? classifyMedia(msg.media) : [];
      const openDoc = msg?.openDoc;
      log(
        `/api/send user=${user.id} t=${msg?.t ?? "?"} media=${media.length} openDoc=${openDoc ? `${openDoc.repo}/${openDoc.path}` : "—"}`,
      );
      if (!text && !audio && media.length === 0) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"empty"}');
        return;
      }
      res.writeHead(202, { "content-type": "application/json" }).end("{}");
      // Facts del canal web: identidad + la nota abierta (si hay). El núcleo los renderiza
      // como tags [canal: web] / [vista: <repo>/<path>] antepuestos al turno del agente.
      const facts: TurnFact[] = [{ label: "canal", value: "web" }];
      if (openDoc) facts.push({ label: "vista", value: `${openDoc.repo}/${openDoc.path}` });
      // Despacha por el canal remoto; la respuesta del agente vuelve por frames →
      // pushToUser → SSE. Si el agente está caído, el plano repos sigue andando (D3).
      // `sid` = la vista que preguntó → la respuesta del turno vuelve sólo a ésa (no eco).
      sendToAgent({ id: user.id, handle: user.handle }, text, audio, facts, media, msg?.sid);
      return;
    }

    // viewer MCP (Fase B): /mcp/viewer/<secret>, POST JSON-RPC. El secreto en el path
    // gatea (timing-safe); el bearer firmado identifica al usuario dentro de callTool.
    // nginx rutea /mcp/viewer/ acá (longest-prefix sobre /mcp/→launcher).
    if (path.startsWith("/mcp/viewer/") && req.method === "POST") {
      const secret = path.slice("/mcp/viewer/".length).split("/")[0] ?? "";
      if (!viewerServer || !opts.viewerSecret || !safeEqual(secret, opts.viewerSecret)) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      await handleMcpPost(viewerServer, req, res);
      return;
    }

    // Escritura del editor (Fase C): commit DIRECTO a git con la GitHub App, gate por los
    // repos del usuario. Optimista por `baseSha` → 409 si el archivo cambió afuera.
    if (path === "/api/file" && req.method === "PUT") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      let p: { repo?: string; path?: string; content?: string; baseSha?: string } = {};
      try {
        p = JSON.parse((await readBody(req, MAX_SEND_BYTES)) ?? "");
      } catch {
        /* body inválido */
      }
      const allowed = opts.userRepoNames?.(user.id) ?? [];
      if (
        !opts.wikis ||
        !p.repo ||
        !p.path ||
        !isSafeRelPath(p.path) ||
        typeof p.content !== "string" ||
        !p.baseSha ||
        !allowed.includes(p.repo)
      ) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      // MODO DB (feature db F3c, flag NOTES_WRITE_MODE=db): el save es un UPDATE
      // transaccional con check de versión; `sha` = versión entera (opaco para el front).
      // El espejo git (F3b) exporta después. El feed coalesced lo registra el file-op.
      if (opts.notesWriteMode === "db") {
        const r = dbPutFile(db, p.repo, p.path, p.content, p.baseSha, user.id);
        if (r.ok) {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r.value));
          log(`web edit (db): ${user.handle} ${p.repo}/${p.path}`);
        } else {
          res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body));
        }
        return;
      }
      try {
        const out = await opts.wikis.putFile(
          p.repo,
          p.path,
          p.content,
          p.baseSha,
          `✏️ ${p.path} — ${user.handle} (web)`,
          gitAuthorFor(user.handle, user.name),
        );
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sha: out.sha }));
        log(`web edit: ${user.handle} ${p.repo}/${p.path}`);
        // Registramos la edición COALESCED (recordWebEdit): alimenta el reporte de cambios en el
        // chat (notificador del gateway) sin inundar — una sola fila "editaste X" por ráfaga de
        // autosave. El feed web (refresh de otras pestañas) IGNORA las ediciones (ver feedPoll):
        // no reintroducimos el self-refresh/read-after-write que este PUT evita a propósito.
        recordWebEdit(p.repo, p.path, user.id);
      } catch (e) {
        if ((e as { conflict?: boolean }).conflict) {
          res.writeHead(409, { "content-type": "application/json" }).end('{"error":"conflict"}');
        } else {
          res
            .writeHead(500, { "content-type": "application/json" })
            .end(JSON.stringify({ error: (e as Error)?.message ?? "error" }));
        }
      }
      return;
    }

    // Crear archivo nuevo (operación del explorer). Mismo gating que el PUT: cookie
    // + el repo tiene que estar en los del user. Sin baseSha: 422 si ya existe.
    if (path === "/api/file" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      let p: { repo?: string; path?: string; content?: string } = {};
      try {
        p = JSON.parse((await readBody(req, MAX_SEND_BYTES)) ?? "");
      } catch {
        /* body inválido */
      }
      const allowed = opts.userRepoNames?.(user.id) ?? [];
      if (!opts.wikis || !p.repo || !p.path || !isSafeRelPath(p.path) || !allowed.includes(p.repo)) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      if (opts.notesWriteMode === "db") {
        const r = dbCreateFile(db, p.repo, p.path, p.content ?? "", user.id);
        if (r.ok) {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r.value));
          log(`web create (db): ${user.handle} ${p.repo}/${p.path}`);
        } else {
          res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body));
        }
        return;
      }
      try {
        const out = await opts.wikis.createFile(
          p.repo,
          p.path,
          p.content ?? "",
          `➕ ${p.path} — ${user.handle} (web)`,
          gitAuthorFor(user.handle, user.name),
        );
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ sha: out.sha, path: out.path }));
        log(`web create: ${user.handle} ${p.repo}/${p.path}`);
        recordWebChange(p.repo, [{ path: p.path, op: "create" }], user.id);
      } catch (e) {
        if ((e as { exists?: boolean }).exists) {
          res.writeHead(409, { "content-type": "application/json" }).end('{"error":"exists"}');
        } else {
          res
            .writeHead(500, { "content-type": "application/json" })
            .end(JSON.stringify({ error: (e as Error)?.message ?? "error" }));
        }
      }
      return;
    }

    // Borrar archivo. Mismo gating; exige baseSha (el blob sha que se está borrando)
    // para que no se pisen ediciones concurrentes.
    if (path === "/api/file" && req.method === "DELETE") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      let p: { repo?: string; path?: string; baseSha?: string } = {};
      try {
        p = JSON.parse((await readBody(req, MAX_SEND_BYTES)) ?? "");
      } catch {
        /* body inválido */
      }
      const allowed = opts.userRepoNames?.(user.id) ?? [];
      if (
        !opts.wikis ||
        !p.repo ||
        !p.path ||
        !isSafeRelPath(p.path) ||
        !p.baseSha ||
        !allowed.includes(p.repo)
      ) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      if (opts.notesWriteMode === "db") {
        const r = dbDeleteFile(db, p.repo, p.path, p.baseSha, user.id);
        if (r.ok) {
          res.writeHead(200, { "content-type": "application/json" }).end("{}");
          log(`web delete (db): ${user.handle} ${p.repo}/${p.path}`);
        } else {
          res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body));
        }
        return;
      }
      try {
        await opts.wikis.deleteFile(
          p.repo,
          p.path,
          p.baseSha,
          `🗑️ ${p.path} — ${user.handle} (web)`,
          gitAuthorFor(user.handle, user.name),
        );
        recordWebChange(p.repo, [{ path: p.path, op: "delete" }], user.id);
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        log(`web delete: ${user.handle} ${p.repo}/${p.path}`);
      } catch (e) {
        if ((e as { conflict?: boolean }).conflict) {
          res.writeHead(409, { "content-type": "application/json" }).end('{"error":"conflict"}');
        } else {
          res
            .writeHead(500, { "content-type": "application/json" })
            .end(JSON.stringify({ error: (e as Error)?.message ?? "error" }));
        }
      }
      return;
    }

    // Asignar/limpiar el emoji de una nota (estilo Notion). POST {repo, path, emoji}. Mismo
    // gating de mutación que /api/file (origin + sesión + rate + repo del usuario + path seguro):
    // el emoji se commitea al sidecar `.ceibo/emojis.json` de la wiki (versiona con ella). `emoji`
    // vacío = limpiar. Devuelve el mapa resultante para que el cliente refresque sin re-fetch.
    if (path === "/api/file/emoji" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      let p: { repo?: string; path?: string; emoji?: string } = {};
      try {
        p = JSON.parse((await readBody(req, MAX_SEND_BYTES)) ?? "");
      } catch {
        /* body inválido */
      }
      const allowed = opts.userRepoNames?.(user.id) ?? [];
      // El emoji es opcional (vacío = limpiar); el path debe ser una nota segura del repo del usuario.
      if (
        !opts.wikis ||
        !p.repo ||
        !p.path ||
        !isSafeRelPath(p.path) ||
        typeof p.emoji !== "string" ||
        // Tope defensivo: un emoji son pocos chars; nada de payloads gigantes en el sidecar.
        p.emoji.length > 32 ||
        !allowed.includes(p.repo)
      ) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      try {
        const emojis = await opts.wikis.setEmoji(
          p.repo,
          p.path,
          p.emoji,
          gitAuthorFor(user.handle, user.name),
        );
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ emojis }));
        log(`web emoji: ${user.handle} ${p.repo}/${p.path} = ${p.emoji || "(clear)"}`);
      } catch (e) {
        if ((e as { conflict?: boolean }).conflict) {
          res.writeHead(409, { "content-type": "application/json" }).end('{"error":"conflict"}');
        } else {
          res
            .writeHead(500, { "content-type": "application/json" })
            .end(JSON.stringify({ error: (e as Error)?.message ?? "error" }));
        }
      }
      return;
    }

    // Archivar archivo (Explorer): borra la nota + la indexa en el `_archivado.md` de su carpeta,
    // en UN commit (modelo archivado-por-historia; recuperable con recall/search-archived). Mismo
    // gating que DELETE; exige baseSha para no pisar una edición concurrente.
    if (path === "/api/file/archive" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      let p: { repo?: string; path?: string; baseSha?: string } = {};
      try {
        p = JSON.parse((await readBody(req, MAX_SEND_BYTES)) ?? "");
      } catch {
        /* body inválido */
      }
      const allowed = opts.userRepoNames?.(user.id) ?? [];
      if (
        !opts.wikis ||
        !p.repo ||
        !p.path ||
        !isSafeRelPath(p.path) ||
        !p.baseSha ||
        !allowed.includes(p.repo)
      ) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      try {
        const r = await archiveNote(
          opts.wikis,
          p.repo,
          p.path,
          p.baseSha,
          user.handle,
          gitAuthorFor(user.handle, user.name),
        );
        if (!r.ok) {
          res.writeHead(409, { "content-type": "application/json" }).end('{"error":"conflict"}');
          return;
        }
        // Registramos sólo la nota archivada (op 'archive'); el manifest `_archivado.md` es
        // interno y no queremos mostrarlo en el reporte de chat. El refresh del explorer igual
        // dispara (archive es estructural).
        recordWebChange(p.repo, [{ path: p.path, op: "archive" }], user.id);
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        log(`web archive: ${user.handle} ${p.repo}/${p.path} → ${r.manifestPath}`);
      } catch (e) {
        res
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ error: (e as Error)?.message ?? "error" }));
      }
      return;
    }

    // Archivar una CARPETA entera (Explorer), en UN commit: borra todo lo que vive bajo el
    // prefijo (notas + índices `_index.md`/`_archivado.md`) e indexa las notas en el
    // `_archivado.md` de la carpeta PADRE. Archivar nota-a-nota dejaba el manifest ADENTRO
    // de la carpeta → la carpeta "borrada" renacía (zombie) y nunca más se podía borrar.
    if (path === "/api/folder/archive" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      let p: { repo?: string; path?: string } = {};
      try {
        p = JSON.parse((await readBody(req, MAX_SEND_BYTES)) ?? "");
      } catch {
        /* body inválido */
      }
      const allowed = opts.userRepoNames?.(user.id) ?? [];
      if (!opts.wikis || !p.repo || !p.path || !isSafeRelPath(p.path) || !allowed.includes(p.repo)) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      try {
        const r = await archiveFolder(
          opts.wikis,
          p.repo,
          p.path,
          user.handle,
          gitAuthorFor(user.handle, user.name),
        );
        if (!r.ok) {
          res.writeHead(409, { "content-type": "application/json" }).end('{"error":"conflict"}');
          return;
        }
        // Registramos las notas archivadas (op 'archive'); los índices borrados son internos
        // (no van al reporte del chat). Carpeta sin notas (zombie de índices) → nada que
        // reportar, pero el borrado igual ocurrió.
        if (r.archived.length > 0) {
          recordWebChange(
            p.repo,
            r.archived.map((notePath) => ({ path: notePath, op: "archive" as const })),
            user.id,
          );
        }
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ archived: r.archived.length }));
        log(
          `web archive-folder: ${user.handle} ${p.repo}/${p.path}/ (${r.archived.length} notas) → ${r.manifestPath}`,
        );
      } catch (e) {
        res
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ error: (e as Error)?.message ?? "error" }));
      }
      return;
    }

    // ── Wiki management (F2) ─────────────────────────────────────────────────
    // Todas las ops siguen el patrón: origin + cookie + rate-limit + gate server-side.
    // resetSessions (inyectado por index.ts, F3) dispara el reset en remociones de contexto.

    // Guarda centralizada (action: 'archive'|'unarchive'|'leave'|'invite'|'remove-member'|'delete'|'rename').
    // Devuelve {code, error} si debe bloquearse, o null si está OK.
    type WikiPermAction =
      | "archive"
      | "unarchive"
      | "leave"
      | "invite"
      | "remove-member"
      | "delete"
      | "rename";
    function assertWikiPermission(
      repoRow: { id: number; personal: number; deleted_at: string | null },
      actorId: number,
      action: WikiPermAction,
    ): { code: number; error: string } | null {
      if (repoRow.deleted_at !== null) return { code: 403, error: "wiki-deleted" };
      const personal = repoRow.personal === 1;
      const role = roleOf(db, repoRow.id, actorId);
      const owner = role === "owner";
      if (role === undefined) return { code: 403, error: "forbidden" };
      switch (action) {
        case "archive":
          if (personal) return { code: 403, error: "personal-not-archivable" };
          break;
        case "leave":
          if (owner) return { code: 403, error: "owner-cannot-leave" };
          break;
        case "invite":
        case "remove-member":
        case "rename":
          if (!owner) return { code: 403, error: "owner-only" };
          break;
        case "delete":
          if (!owner) return { code: 403, error: "owner-only" };
          if (personal) return { code: 403, error: "personal-not-deletable" };
          break;
        case "unarchive":
          break;
      }
      return null;
    }

    // POST /api/wiki {label} — crear wiki nueva; el creador queda owner. No auto-abre nada.
    if (path === "/api/wiki" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      let p: { label?: string } = {};
      try {
        p = JSON.parse((await readBody(req, 4096)) ?? "");
      } catch {
        /* body inválido */
      }
      const rawLabel = typeof p.label === "string" ? p.label.trim() : "";
      try {
        assertValidLabel(rawLabel);
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid-label"}');
        return;
      }
      if (!opts.wikis) {
        res.writeHead(503, { "content-type": "application/json" }).end('{"error":"wikis-not-configured"}');
        return;
      }
      const repoName = userRepoName(user.handle, rawLabel);
      try {
        await opts.wikis.createRepo(repoName);
        await seedWelcomeNote(opts.wikis, repoName, log); // README pelado → nota Bienvenida.md (best-effort)
        const newRepo = addRepo(db, opts.wikis.org, repoName, rawLabel);
        grantAccess(db, newRepo.id, user.id, "owner");
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ repo: repoName }));
        log(`web wiki create: ${user.handle} → ${repoName}`);
      } catch (e) {
        const msg = (e as Error)?.message ?? "";
        if (msg.includes("422") || /already.exists/i.test(msg)) {
          res.writeHead(422, { "content-type": "application/json" }).end('{"error":"already-exists"}');
        } else {
          res
            .writeHead(500, { "content-type": "application/json" })
            .end(JSON.stringify({ error: msg || "error" }));
        }
      }
      return;
    }

    // POST /api/wiki/invite {repo, handle} — invitar usuario existente (camino A, solo owner).
    // POST /api/wiki/invite {repo, email} — invitar por email (camino B): grant directo si ya tiene
    // cuenta, o invitación pendiente + allowlist chaining si no. Solo owner.
    if (path === "/api/wiki/invite" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      let p: { repo?: string; handle?: string; email?: string } = {};
      try {
        p = JSON.parse((await readBody(req, 4096)) ?? "");
      } catch {
        /* body inválido */
      }
      if (!p.repo || (!p.handle && !p.email)) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      const inviteRepo = listReposForUser(db, user.id, { includeArchived: true }).find(
        (r) => r.name === p.repo,
      );
      if (!inviteRepo) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not-found"}');
        return;
      }
      const invitePerm = assertWikiPermission(inviteRepo, user.id, "invite");
      if (invitePerm) {
        res
          .writeHead(invitePerm.code, { "content-type": "application/json" })
          .end(JSON.stringify({ error: invitePerm.error }));
        return;
      }

      // Camino A: invitar por handle (usuario existente)
      if (p.handle) {
        const invitee = getUserByHandle(db, p.handle);
        if (!invitee || invitee.status !== "active") {
          res.writeHead(404, { "content-type": "application/json" }).end('{"error":"user-not-found"}');
          return;
        }
        grantAccess(db, inviteRepo.id, invitee.id, "member");
        // Invitar es aditivo — NO resetea sesión (Q10)
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        log(`web wiki invite: ${user.handle} invitó a ${invitee.handle} en ${p.repo}`);
        return;
      }

      // Camino B: invitar por email
      const rawEmail = p.email as string;
      const normEmail = rawEmail.trim().toLowerCase();
      const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail);
      if (!validEmail) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid-email"}');
        return;
      }
      // Si ya hay usuario con ese email → grant directo (camino A reducido)
      const existingUser = resolveUser(db, "email", normEmail) ?? resolveUser(db, "google", normEmail);
      if (existingUser) {
        grantAccess(db, inviteRepo.id, existingUser.id, "member");
        res.writeHead(200, { "content-type": "application/json" }).end('{"granted":true}');
        log(`web wiki invite-email (grant directo): ${user.handle} → ${existingUser.handle} en ${p.repo}`);
        return;
      }
      // No tiene cuenta → invitación pendiente + mail (P2: ya NO siembra authorized_emails)
      addInvite(db, inviteRepo.id, normEmail, user.id);
      // Obtener el token generado por addInvite para el link del mail
      const inviteToken = (
        db
          .prepare("SELECT accept_token FROM wiki_invites WHERE repo_id = ? AND email = ?")
          .get(inviteRepo.id, normEmail) as { accept_token: string } | undefined
      )?.accept_token;
      const inviterName = user.name ?? user.handle;
      const wikiLabelStr = inviteRepo.label ?? inviteRepo.name;
      if (inviteToken) {
        const acceptUrl = `${opts.webPublicOrigin ?? "https://ceibo.example.com"}/invitacion?i=${inviteToken}`;
        sendInviteEmail({ to: normEmail, inviterName, wikiLabel: wikiLabelStr, acceptUrl }).catch((e) => {
          log(`web wiki invite-email mail-error: ${(e as Error)?.message ?? e} (invite creado igual)`);
        });
      }
      res.writeHead(200, { "content-type": "application/json" }).end('{"pending":true}');
      log(`web wiki invite-email (pendiente): ${user.handle} → ${normEmail} en ${p.repo}`);
      return;
    }

    // DELETE /api/wiki/invite {repo, email} — revocar invitación pendiente (solo owner).
    // NO toca authorized_emails (decisión conservadora: puede haber sido sembrado por el admin).
    if (path === "/api/wiki/invite" && req.method === "DELETE") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      let p: { repo?: string; email?: string } = {};
      try {
        p = JSON.parse((await readBody(req, 4096)) ?? "");
      } catch {
        /* body inválido */
      }
      if (!p.repo || !p.email) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      const revokeRepo = listReposForUser(db, user.id, { includeArchived: true }).find(
        (r) => r.name === p.repo,
      );
      if (!revokeRepo) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not-found"}');
        return;
      }
      const revokePerm = assertWikiPermission(revokeRepo, user.id, "invite");
      if (revokePerm) {
        res
          .writeHead(revokePerm.code, { "content-type": "application/json" })
          .end(JSON.stringify({ error: revokePerm.error }));
        return;
      }
      const normEmail = (p.email as string).trim().toLowerCase();
      const removed = removeInvite(db, revokeRepo.id, normEmail);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ removed }));
      log(`web wiki invite revoke: ${user.handle} revocó ${normEmail} en ${p.repo} (removed=${removed})`);
      return;
    }

    // GET /api/invite?i=<token> — info de la invitación para la SPA (P4). Sin sesión, read-only.
    // Devuelve {inviter, wikiLabel, state} para que la pantalla /invitacion muestre los datos.
    // state: "valid" | "invalid" | "ready" (email ya autorizado/con cuenta)
    if (path.startsWith("/api/invite") && req.method === "GET" && !path.startsWith("/api/invite/")) {
      const token = new URL(req.url ?? "", "http://x").searchParams.get("i") ?? "";
      if (!token) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"missing-token"}');
        return;
      }
      const inv = getInviteByToken(db, token);
      if (!inv) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ state: "invalid" }));
        return;
      }
      const inviter = inv.invited_by ? getUser(db, inv.invited_by) : undefined;
      const repo = db.prepare("SELECT * FROM repos WHERE id = ?").get(inv.repo_id) as
        | { name: string; label: string | null }
        | undefined;
      const wikiLabel = repo?.label ?? repo?.name ?? "";
      // Si el email ya tiene cuenta o está autorizado, el link lleva directo al login
      const hasCcount = !!resolveUser(db, "email", inv.email) || !!resolveUser(db, "google", inv.email);
      const isAuthorized = !!getAuthorizedEmail(db, inv.email);
      const state = hasCcount || isAuthorized ? "ready" : "valid";
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          state,
          inviter: inviter ? (inviter.name ?? inviter.handle) : null,
          wikiLabel,
        }),
      );
      return;
    }

    // POST /api/invite/accept {token} — aceptar invitación (sin sesión; el invitado anónimo
    // acepta → queda en waiting_list con source='invited'. Idempotente.
    // Estados de respuesta: waitlisted | already-waitlisted | ready | invalid
    if (path === "/api/invite/accept" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      let body: { token?: string } = {};
      try {
        body = JSON.parse((await readBody(req, 4096)) ?? "");
      } catch {
        /* body inválido */
      }
      const token = body.token?.trim() ?? "";
      if (!token) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"missing-token"}');
        return;
      }
      const inv = getInviteByToken(db, token);
      if (!inv) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ state: "invalid" }));
        return;
      }
      // Si ya tiene cuenta o está autorizado → ready (no pasar por waitlist)
      const hasCcount = !!resolveUser(db, "email", inv.email) || !!resolveUser(db, "google", inv.email);
      const isAuthorized = !!getAuthorizedEmail(db, inv.email);
      if (hasCcount || isAuthorized) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ state: "ready" }));
        return;
      }
      // Agregar a la waitlist (source='invited', provenance desde el invite)
      const { alreadyWaiting } = addToWaitingList(db, inv.email, {
        source: "invited",
        invitedBy: inv.invited_by ?? undefined,
      });
      const state = alreadyWaiting ? "already-waitlisted" : "waitlisted";
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ state }));
      log(`web invite accept: ${inv.email} → ${state} (token ${token.slice(0, 8)}…)`);
      return;
    }

    // DELETE /api/wiki/member {repo, handle} — quitar miembro (solo owner; no a sí mismo).
    if (path === "/api/wiki/member" && req.method === "DELETE") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      let p: { repo?: string; handle?: string } = {};
      try {
        p = JSON.parse((await readBody(req, 4096)) ?? "");
      } catch {
        /* body inválido */
      }
      if (!p.repo || !p.handle) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      const rmMemberRepo = listReposForUser(db, user.id, { includeArchived: true }).find(
        (r) => r.name === p.repo,
      );
      if (!rmMemberRepo) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not-found"}');
        return;
      }
      const rmMemberPerm = assertWikiPermission(rmMemberRepo, user.id, "remove-member");
      if (rmMemberPerm) {
        res
          .writeHead(rmMemberPerm.code, { "content-type": "application/json" })
          .end(JSON.stringify({ error: rmMemberPerm.error }));
        return;
      }
      if (p.handle === user.handle) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"cannot-remove-self"}');
        return;
      }
      const rmTarget = getUserByHandle(db, p.handle);
      if (!rmTarget) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"user-not-found"}');
        return;
      }
      // Limpiar active_wiki si apuntaba a este repo
      const rmTargetFull = getUser(db, rmTarget.id);
      if (rmTargetFull?.active_wiki === p.repo) setUserActiveWiki(db, rmTarget.id, null);
      revokeAccess(db, rmMemberRepo.id, rmTarget.id);
      // Remoción → reset de sesión del removido (F3 cableado vía opts.resetSessions)
      resetSessions([rmTarget.id]);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      log(`web wiki remove-member: ${user.handle} quitó a ${rmTarget.handle} de ${p.repo}`);
      return;
    }

    // POST /api/wiki/archive {repo} — archivar para sí (cualquier miembro; no la personal).
    if (path === "/api/wiki/archive" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      let p: { repo?: string } = {};
      try {
        p = JSON.parse((await readBody(req, 4096)) ?? "");
      } catch {
        /* body inválido */
      }
      if (!p.repo) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      const archiveRepo = listReposForUser(db, user.id, { includeArchived: true }).find(
        (r) => r.name === p.repo,
      );
      if (!archiveRepo) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not-found"}');
        return;
      }
      const archivePerm = assertWikiPermission(archiveRepo, user.id, "archive");
      if (archivePerm) {
        res
          .writeHead(archivePerm.code, { "content-type": "application/json" })
          .end(JSON.stringify({ error: archivePerm.error }));
        return;
      }
      archiveForUser(db, archiveRepo.id, user.id);
      // Archivar es remoción de contexto → reset propio (F3 cableado vía opts.resetSessions)
      resetSessions([user.id]);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      log(`web wiki archive: ${user.handle} archivó ${p.repo}`);
      return;
    }

    // POST /api/wiki/unarchive {repo} — desarchivar (sin reset, aditivo).
    if (path === "/api/wiki/unarchive" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      let p: { repo?: string } = {};
      try {
        p = JSON.parse((await readBody(req, 4096)) ?? "");
      } catch {
        /* body inválido */
      }
      if (!p.repo) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      // Buscar con includeArchived para poder desarchivar lo que ya está archivado
      const unarchiveRepo = listReposForUser(db, user.id, { includeArchived: true }).find(
        (r) => r.name === p.repo,
      );
      if (!unarchiveRepo) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not-found"}');
        return;
      }
      const unarchivePerm = assertWikiPermission(unarchiveRepo, user.id, "unarchive");
      if (unarchivePerm) {
        res
          .writeHead(unarchivePerm.code, { "content-type": "application/json" })
          .end(JSON.stringify({ error: unarchivePerm.error }));
        return;
      }
      unarchiveForUser(db, unarchiveRepo.id, user.id);
      // Desarchivar es aditivo — sin reset (Q10)
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      log(`web wiki unarchive: ${user.handle} desarchivó ${p.repo}`);
      return;
    }

    // DELETE /api/wiki/leave {repo} — irse (solo NO-owner).
    if (path === "/api/wiki/leave" && req.method === "DELETE") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      let p: { repo?: string } = {};
      try {
        p = JSON.parse((await readBody(req, 4096)) ?? "");
      } catch {
        /* body inválido */
      }
      if (!p.repo) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      const leaveRepo = listReposForUser(db, user.id, { includeArchived: true }).find(
        (r) => r.name === p.repo,
      );
      if (!leaveRepo) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not-found"}');
        return;
      }
      const leavePerm = assertWikiPermission(leaveRepo, user.id, "leave");
      if (leavePerm) {
        res
          .writeHead(leavePerm.code, { "content-type": "application/json" })
          .end(JSON.stringify({ error: leavePerm.error }));
        return;
      }
      // Limpiar active_wiki si apuntaba a este repo
      if (user.active_wiki === p.repo) setUserActiveWiki(db, user.id, null);
      revokeAccess(db, leaveRepo.id, user.id);
      // Irse es remoción → reset propio (F3 cableado vía opts.resetSessions)
      resetSessions([user.id]);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      log(`web wiki leave: ${user.handle} salió de ${p.repo}`);
      return;
    }

    // DELETE /api/wiki {repo, confirmName} — borrar (solo owner; no personal; confirmName debe matchear).
    if (path === "/api/wiki" && req.method === "DELETE") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      let p: { repo?: string; confirmName?: string } = {};
      try {
        p = JSON.parse((await readBody(req, 4096)) ?? "");
      } catch {
        /* body inválido */
      }
      if (!p.repo || !p.confirmName) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      const deleteRepo = listReposForUser(db, user.id, { includeArchived: true }).find(
        (r) => r.name === p.repo,
      );
      if (!deleteRepo) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not-found"}');
        return;
      }
      const deletePerm = assertWikiPermission(deleteRepo, user.id, "delete");
      if (deletePerm) {
        res
          .writeHead(deletePerm.code, { "content-type": "application/json" })
          .end(JSON.stringify({ error: deletePerm.error }));
        return;
      }
      // confirmName debe matchear el display label de la wiki
      const displayLabel = deleteRepo.label ?? p.repo;
      if (p.confirmName !== displayLabel) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"confirm-mismatch"}');
        return;
      }
      // Obtener miembros ANTES del soft-delete
      const deleteMembers = usersForRepo(db, deleteRepo.id).map((m) => m.id);
      softDeleteRepo(db, deleteRepo.id);
      // Reset de sesión de TODOS los miembros (F3 cableado vía opts.resetSessions)
      if (deleteMembers.length > 0) resetSessions(deleteMembers);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      log(`web wiki delete: ${user.handle} borró ${p.repo} (soft-delete)`);
      return;
    }

    // GET /api/users/directory — usuarios con los que el caller comparte alguna wiki (P6).
    // Antes devolvía todos los activos; ahora restringido a co-miembros (decisión #1).
    if (path === "/api/users/directory" && req.method === "GET") {
      const userId = activeUserId(req);
      if (!userId) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      const dirUsers = listCoMembers(db, userId).map((u) => ({
        handle: u.handle,
        name: u.name ?? u.handle,
        hasAvatar: userHasAvatar(db, u.id),
      }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ users: dirUsers }));
      return;
    }

    // Renombrar el ALIAS (display label) de una wiki desde la UI (7.5). Solo toca `repo.label` en
    // el store — NO renombra el repo de GitHub (eso es otra operacion, pesada). Mismo gating que el
    // resto de /api/file/*: origin + cookie de sesion + el repo tiene que estar en los del usuario.
    // F2: validación slug unificada + gate owner-only en wikis compartidas (Q8).
    if (path === "/api/wiki/label" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      let p: { repo?: string; label?: string } = {};
      try {
        p = JSON.parse((await readBody(req, MAX_SEND_BYTES)) ?? "");
      } catch {
        /* body invalido */
      }
      const rawLabel = typeof p.label === "string" ? p.label.trim() : "";
      const allowed = opts.userRepoNames?.(user.id) ?? [];
      if (!p.repo || !rawLabel || !allowed.includes(p.repo)) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      // Validar slug (unificado web/chat, F2 Q8)
      try {
        assertValidLabel(rawLabel);
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid-label"}');
        return;
      }
      // Resolvemos el id del repo entre los del usuario (doble gate: ya paso allowed.includes).
      const repoRow = listReposForUser(db, user.id).find((r) => r.name === p.repo);
      if (!repoRow) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not-found"}');
        return;
      }
      // En wikis compartidas (>1 activo), solo el owner puede renombrar (Q8)
      const labelMembers = usersForRepo(db, repoRow.id).filter((u) => u.status === "active");
      if (labelMembers.length > 1 && !isOwner(db, repoRow.id, user.id)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"owner-only"}');
        return;
      }
      setRepoLabel(db, repoRow.id, rawLabel);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      log(`web wiki label: ${user.handle} ${p.repo} → ${rawLabel}`);
      return;
    }

    // Agenda: lista los crons (recordatorios) activos del usuario. Lectura pura del store
    // (los crea el agente vía la tool schedule); el cliente recibe los strings ya formateados
    // por viewCron, así no necesita librerías de cron.
    if (path === "/api/crons" && req.method === "GET") {
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      const crons = listCronsForUser(db, user.id).map(viewCron);
      // Canales de delivery que el user tiene registrados (para el selector del modal). Web ya es
      // un canal válido (feature crons-delivery: entrega durable vía el inbox persistente), así que
      // ya NO se filtra — antes quedaba afuera por no tener entrega offline / notificaciones.
      const channels = listChannels(db, user.id)
        .map((c) => c.channel)
        .filter((c) => c === "telegram" || c === "whatsapp" || c === "web");
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ crons, channels: [...new Set(channels)] }));
      return;
    }

    // Inbox del agente (feature crons-delivery): items durables que el agente dejó para la web
    // (hoy, crons creados en web que dispararon). El FAB 🔔 lo lee al cargar y sube el badge en
    // vivo con el frame `inbox`. Lectura pura del store, acotada al dueño.
    if (path === "/api/inbox" && req.method === "GET") {
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      const items = listInbox(db, user.id);
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ items, unread: countUnread(db, user.id) }));
      return;
    }

    // Marcar TODOS los items como leídos (botón "marcar todo" del panel). POST /api/inbox/read-all.
    // Va ANTES del match de `/api/inbox/:id/read` (que es un startsWith) para no colisionar.
    if (path === "/api/inbox/read-all" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      const marked = markAllInboxRead(db, user.id);
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ marked, unread: countUnread(db, user.id) }));
      log(`web inbox read-all: ${user.handle} (${marked})`);
      return;
    }

    // Marcar UN item como leído (al clickearlo → se abre la burbuja en el chat y baja el badge).
    // POST /api/inbox/:id/read — acotado al dueño por markInboxRead.
    if (path.startsWith("/api/inbox/") && path.endsWith("/read") && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      const id = Number(path.slice("/api/inbox/".length, -"/read".length));
      if (!Number.isInteger(id) || id <= 0) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      markInboxRead(db, user.id, id); // idempotente: no error si ya estaba leído
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ unread: countUnread(db, user.id) }));
      return;
    }

    // Conexiones (v2): canales por los que el usuario habla con ceibo + cuentas externas
    // conectadas vía OAuth/pairing. Lectura pura del store (read-only); espeja el
    // slash-command /connections del gateway. Conectar/desconectar es por chat, no acá.
    //
    // A diferencia de la v1 (que sólo listaba lo ACTIVO), acá devolvemos el CATÁLOGO completo
    // de conectables marcando cuáles están conectados — así la web muestra qué posibilidades hay
    // (informativo; el "cómo conectar" se explica por chat en el drill-down de la SPA).
    if (path === "/api/connections" && req.method === "GET") {
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(buildConnectionsView(db, user.id, Boolean(opts.whatsappEnabled))));
      return;
    }

    // Cancelar un cron. DELETE /api/crons/:id — acotado al dueño por cancelCron.
    if (path.startsWith("/api/crons/") && req.method === "DELETE") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      const id = Number(path.slice("/api/crons/".length));
      if (!Number.isInteger(id) || id <= 0) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      const ok = cancelCron(db, id, user.id);
      if (!ok) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not-found"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      log(`web cron cancel: ${user.handle} #${id}`);
      return;
    }

    // Editar un cron (modal de la agenda). PATCH /api/crons/:id — título (`title`) y texto
    // (`what`). El cuándo (fecha/recurrencia) no se edita desde la UI: se le pide al agente
    // por el chat (ahí vive el parseo NL). updateCron acota al dueño y al estado activo.
    if (path.startsWith("/api/crons/") && req.method === "PATCH") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      const id = Number(path.slice("/api/crons/".length));
      if (!Number.isInteger(id) || id <= 0) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      let p: { title?: string; what?: string; channel?: string; report?: string } = {};
      try {
        p = JSON.parse((await readBody(req, 4096)) ?? "");
      } catch {
        /* body inválido → cae en bad-request abajo */
      }
      const edit: { title?: string; what?: string; channel?: string; report?: "always" | "never" } = {};
      // El título nunca se vacía: si llega vacío, lo ignoramos (queda el actual; el store
      // garantiza no-nulo). Tope defensivo de longitud para no romper el listado.
      if (typeof p.title === "string" && p.title.trim()) edit.title = p.title.trim().slice(0, 80);
      if (typeof p.what === "string" && p.what.trim()) edit.what = p.what.trim();
      if (p.channel === "telegram" || p.channel === "whatsapp" || p.channel === "all") {
        edit.channel = p.channel;
      } else if (p.channel !== undefined) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-channel"}');
        return;
      }
      // 'conditional' no se expone (no implementado en el fire-path) → sólo always/never.
      if (p.report === "always" || p.report === "never") {
        edit.report = p.report;
      } else if (p.report !== undefined) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-report"}');
        return;
      }
      if (
        edit.title === undefined &&
        edit.what === undefined &&
        edit.channel === undefined &&
        edit.report === undefined
      ) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      const ok = updateCron(db, id, user.id, edit);
      if (!ok) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not-found"}');
        return;
      }
      const updated = getCron(db, id);
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ cron: updated ? viewCron(updated) : null }));
      log(`web cron edit: ${user.handle} #${id}`);
      return;
    }

    // Mover archivo (drag&drop del explorer). Dos modos:
    //  - INTRA-wiki (default): el server hace UN commit atómico (crea destino + borra origen) vía
    //    wikis.moveFile; si el destino existe, no toca origen. Exige baseSha del origen.
    //  - CROSS-wiki (fromRepo ≠ toRepo): el archivo pasa de una wiki a otra. Como son DOS repos git
    //    distintos NO hay commit atómico posible: componemos getFile(A) → createFile(B) → deleteFile(A).
    //    Orden create→delete a propósito: si el create de B falla, A queda intacto (cero pérdida); si
    //    el delete de A falla DESPUÉS de crear B, el archivo queda duplicado (en A y B) — mejor
    //    duplicado que perdido → 200 con `warning:"source-not-deleted"` (no revertimos el destino).
    if (path === "/api/file/move" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(user.id, res)) return;
      let p: {
        repo?: string;
        fromRepo?: string;
        toRepo?: string;
        fromPath?: string;
        toPath?: string;
        baseSha?: string;
        newContent?: string;
      } = {};
      try {
        p = JSON.parse((await readBody(req, MAX_SEND_BYTES)) ?? "");
      } catch {
        /* body inválido */
      }
      // Compat hacia atrás: el body viejo manda `repo` (un solo repo, intra-wiki). El body nuevo
      // manda `fromRepo`/`toRepo`. Si `fromRepo===toRepo` (o sólo vino `repo`), es intra-wiki.
      const fromRepo = p.fromRepo ?? p.repo;
      const toRepo = p.toRepo ?? p.repo;
      const allowed = opts.userRepoNames?.(user.id) ?? [];
      if (
        !opts.wikis ||
        !fromRepo ||
        !toRepo ||
        !p.fromPath ||
        !p.toPath ||
        !isSafeRelPath(p.fromPath) ||
        !isSafeRelPath(p.toPath) ||
        !p.baseSha ||
        // El usuario necesita acceso activo a AMBAS wikis (origen Y destino).
        !allowed.includes(fromRepo) ||
        !allowed.includes(toRepo) ||
        (p.newContent !== undefined && typeof p.newContent !== "string")
      ) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }

      // MODO DB (F3c): un solo camino para intra y cross-wiki — moveNote conserva la
      // identidad de la nota (historia y vectores sobreviven) y valida versión.
      if (opts.notesWriteMode === "db") {
        const r = dbMoveFile(
          db,
          { repo: fromRepo, path: p.fromPath },
          { repo: toRepo, path: p.toPath },
          p.baseSha,
          user.id,
          p.newContent,
        );
        if (r.ok) {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r.value));
          log(`web move (db): ${user.handle} ${fromRepo}/${p.fromPath} → ${toRepo}/${p.toPath}`);
        } else {
          res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body));
        }
        return;
      }

      const author = gitAuthorFor(user.handle, user.name);
      const isCross = fromRepo !== toRepo;
      try {
        if (!isCross) {
          // INTRA-wiki: commit atómico vía moveFile (sin cambios respecto al comportamiento previo).
          const out = await opts.wikis.moveFile(
            fromRepo,
            p.fromPath,
            p.toPath,
            p.baseSha,
            `📁 ${p.fromPath} → ${p.toPath} — ${user.handle} (web)`,
            { newContent: p.newContent, author },
          );
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ sha: out.sha, path: out.path }));
          log(`web move: ${user.handle} ${fromRepo} ${p.fromPath} → ${p.toPath}`);
          // Mover/renombrar: una sola entrada op 'move' sobre la nota resultante (toPath). El reporte
          // de chat dice "moviste <nota>"; el explorer refresca (move es estructural).
          recordWebChange(fromRepo, [{ path: p.toPath, op: "move" }], user.id);
          return;
        }

        // CROSS-wiki: getFile(A) → createFile(B) → deleteFile(A).
        // 1) Leemos el origen y validamos el baseSha optimista (mismo contrato que el intra-wiki:
        //    si el origen cambió desde que el cliente lo abrió, abortamos antes de crear nada).
        const src = await opts.wikis.getFile(fromRepo, p.fromPath);
        if (src.sha !== p.baseSha) {
          res.writeHead(409, { "content-type": "application/json" }).end('{"error":"conflict"}');
          return;
        }
        const content = p.newContent !== undefined ? p.newContent : src.content;
        // 2) Creamos en el destino. createFile NO sobreescribe: si el path ya existe en B → 409 exists,
        //    y A queda intacto (todavía no lo tocamos).
        const created = await opts.wikis.createFile(
          toRepo,
          p.toPath,
          content,
          `📁 ${fromRepo}/${p.fromPath} → ${toRepo}/${p.toPath} — ${user.handle} (web)`,
          author,
        );
        // 3) Borramos el origen. Si esto falla DESPUÉS de crear el destino, el archivo queda duplicado
        //    (existe en A y en B): preferimos duplicado a pérdida → respondemos 200 con un warning suave
        //    y NO revertimos el destino. El cliente refresca ambos árboles y avisa al usuario.
        try {
          await opts.wikis.deleteFile(
            fromRepo,
            p.fromPath,
            p.baseSha,
            `📁 ${fromRepo}/${p.fromPath} → ${toRepo}/${p.toPath} (borrado del origen) — ${user.handle} (web)`,
            author,
          );
        } catch (delErr) {
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ sha: created.sha, path: created.path, warning: "source-not-deleted" }));
          log(
            `web move cross (origen NO borrado): ${user.handle} ${fromRepo}/${p.fromPath} → ${toRepo}/${p.toPath}: ${(delErr as Error)?.message ?? delErr}`,
          );
          // El destino SÍ se creó → registramos su cambio aunque el origen siga vivo.
          recordWebChange(toRepo, [{ path: p.toPath, op: "move" }], user.id);
          return;
        }
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ sha: created.sha, path: created.path }));
        log(`web move cross: ${user.handle} ${fromRepo}/${p.fromPath} → ${toRepo}/${p.toPath}`);
        // Cambio estructural en AMBAS wikis: el destino gana la nota, el origen la pierde.
        recordWebChange(toRepo, [{ path: p.toPath, op: "move" }], user.id);
        recordWebChange(fromRepo, [{ path: p.fromPath, op: "delete" }], user.id);
      } catch (e) {
        if ((e as { conflict?: boolean }).conflict) {
          res.writeHead(409, { "content-type": "application/json" }).end('{"error":"conflict"}');
        } else if ((e as { exists?: boolean }).exists) {
          res.writeHead(409, { "content-type": "application/json" }).end('{"error":"exists"}');
        } else {
          res
            .writeHead(500, { "content-type": "application/json" })
            .end(JSON.stringify({ error: (e as Error)?.message ?? "error" }));
        }
      }
      return;
    }

    // Edición de perfil (web): el propio usuario setea su alias (display name), su ubicación
    // y/o sus prompts del fondo. Campos OPCIONALES: sólo se toca lo que viene en el body
    // (guardar el alias no pisa los prompts ni la ubicación y viceversa). Alias vacío → null
    // (la UI cae al handle), límite 60. location: texto libre, vacío → null (el agente deja
    // de recibirla), límite 120. bgQueries: array de strings (se normaliza: trim, sin vacías,
    // tope BG_MAX_QUERIES); lista vacía o null limpian la preferencia → default de la app.
    // El avatar va por /api/me/avatar.
    if (path === "/api/me" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!userId || !user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      let p: { name?: unknown; location?: unknown; bgQueries?: unknown };
      try {
        p = JSON.parse((await readBody(req, 16 * 1024)) ?? "");
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      let name = user.name;
      if (p.name !== undefined) {
        const raw = typeof p.name === "string" ? p.name.trim() : "";
        if (raw.length > 60) {
          res.writeHead(400, { "content-type": "application/json" }).end('{"error":"too-long"}');
          return;
        }
        name = raw || null;
        setUserName(db, userId, name);
      }
      // Ubicación: texto libre (ej. "Buenos Aires, Argentina"), vacío → null (el agente deja
      // de recibirla). Mismo patrón que el alias; límite 120 (cabe una ciudad/región).
      let location = user.location;
      if (p.location !== undefined) {
        const raw = typeof p.location === "string" ? p.location.trim() : "";
        if (raw.length > 120) {
          res.writeHead(400, { "content-type": "application/json" }).end('{"error":"too-long"}');
          return;
        }
        location = raw || null;
        setUserLocation(db, userId, location);
      }
      let bgQueries: string[] | null | undefined;
      if (p.bgQueries !== undefined) {
        const norm = normalizeBgQueries(p.bgQueries);
        if ("error" in norm) {
          res
            .writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ error: norm.error }));
          return;
        }
        bgQueries = norm.queries;
        setUserBgQueries(db, userId, bgQueries);
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          name: name ?? user.handle,
          // Ubicación efectiva tras el save (null = sin setear → la UI muestra el campo vacío).
          location: location ?? null,
          // Eco de lo efectivo: tras limpiar (null) la UI repuebla con el default de la app.
          ...(p.bgQueries !== undefined && {
            bgQueries: bgQueries ?? [...UNSPLASH_BG_QUERIES],
            bgIsDefault: !bgQueries,
          }),
        }),
      );
      return;
    }
    // Cambio de contraseña (web): el propio usuario, ya autenticado, cambia su password.
    // Hay que pasar la actual (verificada) antes de setear la nueva. Comparte el rate-limit
    // por IP del login para frenar fuerza bruta sobre la contraseña actual. Requiere tener
    // una password ya seteada (quien entró sólo por magic-link/Google no tiene "actual").
    if (path === "/api/me/password" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!userId || !user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      const ip = clientIp(req);
      const rl = noteLoginAttempt(ip);
      if (!rl.allowed) {
        log(`web pw-change rate-limit: ip=${ip} count=${rl.count} (cap ${LOGIN_MAX_PER_WINDOW}/win)`);
        res.writeHead(429, { "content-type": "application/json" }).end('{"error":"too-many-requests"}');
        return;
      }
      let p: { current?: unknown; new?: unknown };
      try {
        p = JSON.parse((await readBody(req, 4096)) ?? "");
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      const current = typeof p.current === "string" ? p.current : "";
      const next = typeof p.new === "string" ? p.new : "";
      if (!hasUserPassword(db, userId)) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"no-password"}');
        return;
      }
      if (!verifyUserPassword(db, userId, current)) {
        log(`web pw-change wrong-password: ${user.handle} (user=${userId}) ip=${ip}`);
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"wrong-password"}');
        return;
      }
      if (next.length < 8) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"too-short"}');
        return;
      }
      setUserPassword(db, userId, next);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      log(`web pw-change: ${user.handle} (user=${userId})`);
      return;
    }
    // Subir/reemplazar el avatar: JSON { data: <base64>, mime?: <string> }. Validamos tamaño
    // (≤512KB decodificado) y formato real por magic bytes (no por el mime declarado). El
    // mime guardado es el detectado, no el del cliente.
    if (path === "/api/me/avatar" && req.method === "POST") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      if (!userId) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      if (!enforceUserRate(userId, res)) return;
      let p: { data?: unknown };
      try {
        // El body cabe en ~2x el tope (base64 infla ~33%); margen para el envoltorio JSON.
        p = JSON.parse((await readBody(req, MAX_AVATAR_BYTES * 2)) ?? "");
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad-request"}');
        return;
      }
      const b64 = typeof p.data === "string" ? p.data : "";
      const buf = b64 ? Buffer.from(b64, "base64") : Buffer.alloc(0);
      if (buf.length === 0) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"empty"}');
        return;
      }
      if (buf.length > MAX_AVATAR_BYTES) {
        res.writeHead(413, { "content-type": "application/json" }).end('{"error":"too-large"}');
        return;
      }
      const mime = sniffImageMime(buf);
      if (!mime || !AVATAR_MIMES.has(mime)) {
        res.writeHead(415, { "content-type": "application/json" }).end('{"error":"bad-format"}');
        return;
      }
      setUserAvatar(db, userId, buf, mime);
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    // Quitar el avatar.
    if (path === "/api/me/avatar" && req.method === "DELETE") {
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad-origin"}');
        return;
      }
      const userId = activeUserId(req);
      if (!userId) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      setUserAvatar(db, userId, null, null);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405).end("method not allowed");
      return;
    }

    // Stream SSE server→cliente (managed-ui). Autenticado por cookie. Queda abierto;
    // X-Accel-Buffering:no para que nginx no lo bufferee. EventSource reconecta solo.
    if (path === "/api/stream") {
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write("retry: 3000\n\n");
      // `sid` (id de pestaña/vista, estable entre reconexiones): permite entregar la respuesta
      // de un turno sólo a la vista que lo originó. Sin sid, el stream sólo recibe broadcasts.
      const sid = url.searchParams.get("sid") ?? undefined;
      register(user.id, res, sid);
      writeSse(res, { t: "ready", handle: user.handle, name: user.name ?? user.handle });
      // Replay (Fase C): watermark del cliente = max(Last-Event-ID, ?since=). El header lo
      // manda el browser solo en el reconnect NATIVO del EventSource; `?since=` lo manda el
      // cliente en el reconnect MANUAL (watchdog: EventSource nuevo, sin header). Si el
      // EventSource nativo reconecta una URL con `?since=` viejo, el header es más nuevo →
      // max() elige bien (y un replay de más es inocuo: el cliente dedup-ea por seq).
      const since = Math.max(parseSeq(req.headers["last-event-id"]), parseSeq(url.searchParams.get("since")));
      if (since > 0) {
        const missed = frames.since(user.id, since, sid);
        // Gap (el buffer ya no conserva todo lo posterior al watermark): señal HONESTA de
        // resync — el cliente refresca su estado — y después lo que SÍ tenemos (best effort:
        // suele incluir la respuesta del turno, que es lo que importa). Sin gap, replay puro.
        if (missed.gap) writeSse(res, { t: "resync" });
        for (const f of missed.frames) writeSse(res, f.payload, { id: f.seq });
        if (missed.gap || missed.frames.length > 0)
          log(
            `web stream replay: user=${user.id} since=${since} frames=${missed.frames.length}${missed.gap ? " GAP→resync" : ""}`,
          );
      }
      log(`web stream abierto: ${user.handle} (user=${user.id}${sid ? ` sid=${sid.slice(0, 8)}` : ""})`);
      req.on("close", () => unregister(user.id, res));
      return;
    }
    // Fallback long-polling (esbozo Fase C-bonus, sale gratis del buffer+seq): "dame los
    // frames después de seq X" por HTTP normal — la red final si algún día el SSE no pasa.
    // La web HOY no lo usa (el cliente sigue 100% SSE); queda para un fallback futuro tras
    // N reconnects fallidos. Mismo contrato que el replay: watermark + sid-routing + gap.
    if (path === "/api/frames") {
      const userId = activeUserId(req);
      if (!userId) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      const since = parseSeq(url.searchParams.get("since"));
      const sid = url.searchParams.get("sid") ?? undefined;
      const out = frames.since(userId, since, sid);
      res
        .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify({ frames: out.frames.map((f) => f.payload), gap: out.gap }));
      return;
    }
    if (path === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    // Servir el avatar del propio usuario (GET). 404 si no tiene (la UI cae a un placeholder).
    if (path === "/api/me/avatar") {
      const userId = activeUserId(req);
      if (!userId) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      const av = getUserAvatar(db, userId);
      if (!av) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"no-avatar"}');
        return;
      }
      // Privado (es la foto del usuario logueado) y revalidable: el front bustea con ?v=,
      // pero igual no queremos que un proxy lo cachee para otro.
      res.writeHead(200, {
        "content-type": av.mime,
        "content-length": String(av.blob.length),
        "cache-control": "private, max-age=0, must-revalidate",
      });
      res.end(av.blob);
      return;
    }
    // Servir el avatar de OTRO usuario por handle (GET). Lo usa el explorer para mostrar la foto
    // de los miembros con quien se comparte una wiki. Gate: basta estar autenticado — los miembros
    // ya se le exponen al viewer en /api/explorer, así que la foto no agrega exposición. 404 si el
    // handle no existe o el usuario no tiene avatar (la UI cae a las iniciales grises).
    if (path.startsWith("/api/avatar/")) {
      const viewerId = activeUserId(req);
      if (!viewerId) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      const handle = decodeURIComponent(path.slice("/api/avatar/".length));
      const target = handle ? getUserByHandle(db, handle) : undefined;
      const av = target ? getUserAvatar(db, target.id) : null;
      if (!av) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"no-avatar"}');
        return;
      }
      // El handle en la URL identifica al usuario → un proxy compartido no mezclaría fotos, pero
      // lo marcamos `private` igual (va detrás de cookie). TTL corto: el front no bustea por versión
      // acá, así que un cambio de foto del miembro se refleja en ~1min.
      res.writeHead(200, {
        "content-type": av.mime,
        "content-length": String(av.blob.length),
        "cache-control": "private, max-age=60",
      });
      res.end(av.blob);
      return;
    }
    if (path === "/api/me") {
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      // Wiki default = active_wiki si está seteada, sino fallback a `<handle>-personal`
      // si está en sus repos, sino la primera. La usa el botón "+" del UI para crear
      // notas rápidas cuando no hay archivo abierto que dé el contexto.
      const repos = opts.userRepoNames?.(user.id) ?? [];
      const personal = `${user.handle}-personal`;
      const defaultWiki =
        user.active_wiki && repos.includes(user.active_wiki)
          ? user.active_wiki
          : repos.includes(personal)
            ? personal
            : (repos[0] ?? null);
      // Settings de voz para el panel de la web (Fase 10/16): idioma activo + voz actual +
      // las listas (provider-aware) para poblar los <select>. El front cambia mandando los
      // mismos slash-commands (/voice, /language) por POST /api/send (no hay endpoint setter).
      const lang = getUserLang(db, user.id);
      const sp = getUserSpeech(db, user.id);
      const voice = speechEnabled()
        ? {
            enabled: true,
            provider: speechProvider(),
            lang,
            langs: LANGS, // [{id,label}]
            // `id` de cada opción = el apodo corto (lo que se manda a /voice); label legible.
            voices: voicesForLang(lang).map((v) => ({ id: v.nick ?? v.id, label: v.label })),
            current: displayVoice(sp.voice ?? defaultVoice(lang)), // apodo actual (marca el select)
            rate: sp.rate ?? defaultRate(), // NULL → lenta por default (consistente con la síntesis)
            rateSupported: paramSupported("rate"),
          }
        : { enabled: false };
      // Modelo de chat para el cog (espeja a /voice/language): opciones + el actual. El front
      // cambia mandando /model por POST /api/send. Mandamos `model` con ≥1 opción: con una sola
      // (ej. backend local con un único modelo) el cog la muestra read-only (no cambiable), no la
      // oculta. undefined sólo con 0 opciones (la box no ofrece modelo).
      const cm = opts.chatModels?.(user.id) ?? [];
      const model =
        cm.length > 0
          ? {
              current: opts.userModel?.(user.id) ?? cm[0]?.id ?? "",
              options: cm,
            }
          : undefined;
      // Email de registro (read-only, para el panel de perfil): la identidad con la que el
      // usuario entra. Las identidades `email` (magic-link) y `google` (OIDC) guardan el email
      // en `external_id`; preferimos la de `email` (alta explícita por mail) y caemos al `google`.
      // Otros canales (telegram/whatsapp) no son emails → se ignoran. null = sin email asociado.
      const chans = listChannels(db, user.id);
      const email =
        chans.find((c) => c.channel === "email")?.external_id ??
        chans.find((c) => c.channel === "google")?.external_id ??
        null;
      // hasPassword: la UI lo usa para mostrar/ocultar la sección "Cambiar contraseña".
      // Tener canal `email` (magic-link) no implica contraseña — el signal correcto es la
      // existencia de una fila en `web_passwords`. Una cuenta Google puro (o magic-link sin
      // contraseña asignada) devuelve false.
      const hasPassword = hasUserPassword(db, user.id);
      // Prompts del fondo (cog de settings): los del usuario o, sin preferencia, el default
      // de la app — el campo de la UI viene PRECARGADO con lo efectivo (editable, no un
      // placeholder vacío). `bgIsDefault` le dice a la UI si es preferencia propia.
      const userBg = getUserBgQueries(db, user.id);
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          handle: user.handle,
          name: user.name ?? user.handle,
          location: user.location ?? null,
          email,
          hasPassword,
          hasAvatar: userHasAvatar(db, user.id),
          defaultWiki,
          voice,
          model,
          bgQueries: userBg ?? [...UNSPLASH_BG_QUERIES],
          bgIsDefault: !userBg,
        }),
      );
      return;
    }
    // Blame por línea (etapa 2 del "quién tocó qué"): quién escribió cada rango de líneas de
    // una nota. Para wikis COMPARTIDAS (más de un usuario activo con acceso) y también para
    // wikis PERSONALES cuando hay distinción humano/IA disponible (wiki_commit_sources tiene
    // commits del repo): ahí la pregunta es "¿esto lo escribí yo o ceibo?". El gate va acá
    // además del cliente (que ni muestra el botón). Devuelve ranges con `handle` resuelto
    // desde el email canónico `<handle>@users.example.com` (#296) — emails ajenos (bot del
    // App / historia previa) → handle null = "histórico" en la UI — y `source` por sha
    // ('web' = edición humana en la web, 'agent' = el agente/REM, null = desconocido).
    if (path === "/api/file/blame" && req.method === "GET") {
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      const repo = url.searchParams.get("repo") ?? "";
      const filePath = url.searchParams.get("path") ?? "";
      const allowed = opts.userRepoNames?.(user.id) ?? [];
      if (!opts.wikis || !repo || !filePath || !isSafeRelPath(filePath) || !allowed.includes(repo)) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not-found"}');
        return;
      }
      // Gate: wiki compartida (>1 usuario ACTIVO con acceso — mismo criterio que los member
      // chips del explorer; los disabled/test no cuentan) O wiki personal con distinción
      // humano/IA disponible (hay sources registrados para el repo).
      const repoRow = listReposForUser(db, user.id).find((r) => r.name === repo);
      const activos = repoRow ? usersForRepo(db, repoRow.id).filter((u) => u.status === "active") : [];
      const shared = activos.length >= 2;
      if (!shared && !repoHasCommitSources(db, repo)) {
        res.writeHead(403, { "content-type": "application/json" }).end('{"error":"not-shared"}');
        return;
      }
      // Mapa email-de-login → usuario, construido UNA vez por request (no por línea).
      // Cubre usuarios que pushean desde su clone local con su email personal (git config
      // user.email = el mismo email de login), que puede ser distinto al canónico
      // `<handle>@users.example.com` introducido en #296.
      // Canal "email" y "google" son los dos vectores de login web; ambos usan el email
      // como external_id. Normalizado a lowercase para la comparación (insensible a mayúsculas).
      const loginEmailToUser = new Map<string, (typeof activos)[0]>();
      for (const u of activos) {
        for (const ch of listChannels(db, u.id)) {
          if (ch.channel === "email" || ch.channel === "google") {
            loginEmailToUser.set(ch.external_id.toLowerCase(), u);
          }
        }
      }
      try {
        const head = await opts.wikis.headSha(repo);
        const key = `${repo}\u0000${filePath}`;
        const hit = blameCache.get(key);
        if (hit && hit.ref === head) {
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ ref: hit.ref, shared, ranges: hit.ranges }));
          return;
        }
        const blame = await opts.wikis.blame(repo, filePath);
        // source por sha (UNA query para todos los shas del blame): 'web' = edición humana
        // en la web; 'agent' = el agente (chat o REM — 'rem' se colapsa a 'agent' en el wire);
        // ausente = commit anterior al registro de sources → null (desconocido).
        const bySha = wikiCommitSources(db, repo, [...new Set(blame.ranges.map((r) => r.sha))]);
        const ranges = blame.ranges.map((r) => {
          // 1. Email canónico de ceibo → handle (commits firmados por el sistema, #296).
          const m = /^(.+)@users\.example\.com$/.exec(r.authorEmail);
          let handle = m?.[1] ?? null;
          let u = handle ? getUserByHandle(db, handle) : undefined;
          // 2. Fallback: email de login del usuario (commits desde clone local con git
          //    config user.email = email personal). Insensible a mayúsculas.
          if (!handle) {
            const byLogin = loginEmailToUser.get(r.authorEmail.toLowerCase());
            if (byLogin) {
              handle = byLogin.handle;
              u = byLogin;
            }
          }
          // Display name vigente del usuario si existe en el store; si el handle ya no existe
          // (usuario borrado / histórico), caemos al author name grabado en el commit.
          const name = handle ? (u?.name ?? r.authorName) : null;
          const src = bySha.get(r.sha);
          const source = src === "web" ? "web" : src ? "agent" : null;
          // `hasAvatar` con el MISMO gating que los member chips del explorer: la UI solo
          // pide la foto a /api/avatar/<handle> si el autor subió una (sin 404s de más).
          const hasAvatar = u ? userHasAvatar(db, u.id) : false;
          return {
            start: r.startLine,
            end: r.endLine,
            handle,
            name,
            date: r.date,
            sha: r.sha,
            source,
            hasAvatar,
          };
        });
        if (blameCache.size >= BLAME_CACHE_MAX) {
          const oldest = blameCache.keys().next().value;
          if (oldest !== undefined) blameCache.delete(oldest);
        }
        blameCache.set(key, { ref: blame.ref, ranges });
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ref: blame.ref, shared, ranges }));
      } catch (e) {
        // Path inexistente / repo raro: GitHub responde error en el GraphQL → not-found genérico.
        res
          .writeHead(404, { "content-type": "application/json" })
          .end(JSON.stringify({ error: (e as Error)?.message ?? "not-found" }));
      }
      return;
    }
    // Lectura de un archivo de wiki (Fase B): la vista muestra lo que el agente abre.
    // Gate por los repos del usuario; el gateway lee con el App (es trusted). Read-only;
    // la escritura + editor van en Fase C.
    // F5: también acepta repos archivados (para la vista "archivo") — solo lectura.
    if (path === "/api/file") {
      const userId = activeUserId(req);
      if (!userId) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      const repo = url.searchParams.get("repo") ?? "";
      const filePath = url.searchParams.get("path") ?? "";
      // Para lecturas: permite repos activos O archivados del usuario.
      const allowedRead = opts.userRepoNamesWithArchived?.(userId) ?? opts.userRepoNames?.(userId) ?? [];
      if (!opts.wikis || !repo || !filePath || !isSafeRelPath(filePath) || !allowedRead.includes(repo)) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not-found"}');
        return;
      }
      // MODO DB (F3c): read-your-writes — el GET tiene que ver lo que el PUT acaba de
      // escribir (el espejo git corre atrás, con lag). Fallback a git si la nota no está
      // indexada (ej. archivo no-.md, o wiki archivada fuera del índice).
      if (opts.notesWriteMode === "db") {
        const r = dbReadFile(db, repo, filePath);
        if (r.ok) {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r.value));
          return;
        }
      }
      try {
        const file = await opts.wikis.getFile(repo, filePath);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ repo, ...file }));
      } catch (e) {
        res
          .writeHead(404, { "content-type": "application/json" })
          .end(JSON.stringify({ error: (e as Error)?.message ?? "not-found" }));
      }
      return;
    }
    // Explorador (managed-ui): las wikis del usuario + sus árboles de archivos. El front
    // arma el árbol; abrir un archivo va por el MISMO openDoc que usa el agente.
    if (path === "/api/explorer") {
      const userId = activeUserId(req);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user || !opts.wikis) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      const repoRows = listReposForUser(db, user.id);
      const wk = opts.wikis;
      // label = nombre visible con desambiguación por colisión (ver store.wikiDisplayNames):
      // pelado ("luminos") salvo que dos wikis del viewer compartan label → ahí prefija el dueño.
      const display = wikiDisplayNames(db, user.handle, repoRows);
      const wikis = await Promise.all(
        repoRows.map(async ({ id: repoId, name: repo, personal }) => {
          const label = display.get(repo) ?? repo;
          let files = await wk.listFiles(repo).catch(() => [] as string[]);
          // MODO DB (F3c): las notas .md salen de la DB (read-your-writes: crear/borrar se ve
          // al instante, sin esperar el espejo); lo no-.md (si hubiera) sigue del listado git.
          if (opts.notesWriteMode === "db") {
            const dbPaths = indexedNoteRefs(db, repo).map((r) => r.path);
            files = [...files.filter((f) => !f.endsWith(".md")), ...dbPaths].sort();
          }
          // Emoji por-nota (sidecar `.ceibo/emojis.json`): mapa path→emoji. Best-effort: si
          // falla la lectura (sidecar ausente/corrupto) → {} (el emoji es decorativo, no rompe).
          // `typeof` guard por compat con backends de wikis (o mocks) que aún no lo implementan.
          const emojis =
            typeof wk.readEmojis === "function"
              ? await wk.readEmojis(repo).catch(() => ({}) as Record<string, string>)
              : ({} as Record<string, string>);
          // Miembros con acceso (para mostrar "compartida con" en el explorer). Sólo activos
          // (los disabled/test no cuentan como "están en la wiki"). El cliente filtra al propio
          // viewer y muestra chips sólo si queda >0 (= la wiki es compartida). `hasAvatar` deja
          // que el chip pida la foto a /api/avatar/<handle> (fallback a iniciales si no tiene).
          const members = usersForRepo(db, repoId)
            .filter((u) => u.status === "active")
            .map((u) => ({ handle: u.handle, name: u.name ?? u.handle, hasAvatar: userHasAvatar(db, u.id) }));
          // ¿La wiki puede mostrar el toggle de blame? Compartida (≥2 activos) siempre;
          // personal sólo si hay distinción humano/IA disponible (sources registrados).
          // Mismo criterio que el gate de /api/file/blame.
          const blame = members.length >= 2 || repoHasCommitSources(db, repo);
          // F2 → F4: rol del viewer en esta wiki + flag personal + isOwner (para el menú contextual).
          const role = roleOf(db, repoId, user.id) ?? "member";
          const isOwnerFlag = role === "owner";
          // F6: invitaciones pendientes (solo las no aceptadas) para que la UI muestre chips "pendiente".
          // Solo visibles para el owner; para miembros comunes la lista queda vacía.
          const pendingInvites = isOwnerFlag
            ? listInvitesForRepo(db, repoId)
                .filter((inv) => inv.accepted_at === null)
                .map((inv) => ({ email: inv.email, createdAt: inv.created_at }))
            : [];
          return {
            repo,
            label,
            files,
            emojis,
            members,
            blame,
            role,
            personal: personal === 1,
            isOwner: isOwnerFlag,
            pendingInvites,
          };
        }),
      );
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ wikis }));
      return;
    }

    // F5: Vista "archivo" — wikis que el usuario archivó (per-usuario, reversible).
    // Devuelve { archived: [...] } con la misma forma de objeto que /api/explorer pero
    // solo las entradas donde archived_at IS NOT NULL para este usuario.
    if (path === "/api/explorer/archived") {
      const userId = userIdFromCookie(req, sessionKey);
      const user = userId ? getUser(db, userId) : undefined;
      if (!user || !opts.wikis) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauth"}');
        return;
      }
      // listArchivedReposForUser → solo repos con archived_at IS NOT NULL para este usuario.
      const archivedRows = listArchivedReposForUser(db, user.id);
      const wk = opts.wikis;
      const display = wikiDisplayNames(db, user.handle, archivedRows);
      const archived = await Promise.all(
        archivedRows.map(async ({ id: repoId, name: repo, personal }) => {
          const label = display.get(repo) ?? repo;
          const files = await wk.listFiles(repo).catch(() => [] as string[]);
          const members = usersForRepo(db, repoId)
            .filter((u) => u.status === "active")
            .map((u) => ({ handle: u.handle, name: u.name ?? u.handle, hasAvatar: userHasAvatar(db, u.id) }));
          const role = roleOf(db, repoId, user.id) ?? "member";
          const isOwnerFlag = role === "owner";
          return {
            repo,
            label,
            files,
            members,
            role,
            personal: personal === 1,
            isOwner: isOwnerFlag,
          };
        }),
      );
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ archived }));
      return;
    }

    // Una ruta /api/* que llegó hasta acá no existe → 404 JSON (NO la SPA). Esto deja el
    // catch-all de abajo (SPA fallback) libre para servir el index.html en CUALQUIER otra
    // ruta —incluidos los deep-links de nota `/<repo>/<path…>`— sin tragarse las APIs.
    if (path.startsWith("/api/")) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not-found"}');
      return;
    }

    // Static asset (tiene extensión y existe en el dist) → servir; si no, SPA fallback.
    const ext = extname(path);
    if (ext && ext !== ".html") {
      const file = join(staticDir, normalize(path).replace(/^(\.\.[/\\])+/, ""));
      if (file.startsWith(staticDir) && existsSync(file)) {
        // `/assets/*` los emite Vite con hash en el nombre → cacheables PARA SIEMPRE (immutable).
        // El fondo ahora viene de Unsplash (proxeado por /api/bg-image, que setea su propio
        // cache) — ya no hay imágenes locales servidas desde dist. Igual dejamos un cache de 1
        // día para cualquier imagen no hasheada que pudiera quedar (íconos PWA, etc.).
        // El resto no hasheado (favicon, etc.) → no-cache (revalida, no queda pegado a uno viejo).
        const immutable = path.startsWith("/assets/");
        const isImage = [".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"].includes(ext);
        res.writeHead(200, {
          "content-type": MIME[ext] ?? "application/octet-stream",
          "cache-control": immutable
            ? "public, max-age=31536000, immutable"
            : isImage
              ? "public, max-age=86400"
              : "no-cache",
        });
        res.end(await readFile(file));
        return;
      }
    }
    await serveIndex(res); // "/", "/<handle>" y rutas SPA
  }

  const bindHost = opts.bindHost ?? "127.0.0.1";
  server.listen(port, bindHost, () => log(`web server arriba · http://${bindHost}:${port}`));

  return {
    pushToUser: deliver,
    userIdByHandle: (handle: string) => getUserByHandle(db, handle)?.id,
    close() {
      clearInterval(ping);
      clearInterval(feedPoll);
      clearInterval(watchPoll);
      for (const set of streamsByUser.values()) for (const res of set) res.end();
      server.close();
    },
  };
}

/** Escribe un evento SSE (o un comentario si `comment`); devuelve si el stream lo aceptó.
 *  Con `id` (el seq del frame bufferedo) antepone la línea `id:` — el browser la persiste
 *  como `lastEventId` y la devuelve en el header `Last-Event-ID` del reconnect nativo
 *  (resumption estándar de SSE). `ready`/`ping` van SIN id a propósito: no son frames
 *  replay-ables y no deben mover el watermark del cliente. */
function writeSse(res: ServerResponse, msg: unknown, opts?: { comment?: string; id?: number }): boolean {
  try {
    if (res.writableEnded) return false;
    if (opts?.comment) {
      res.write(`${opts.comment}\n\n`);
      return true;
    }
    const id = opts?.id !== undefined ? `id: ${opts.id}\n` : "";
    res.write(`${id}data: ${JSON.stringify(msg)}\n\n`);
    return true;
  } catch {
    return false; // stream muerto
  }
}

/** Junta el body de un request hasta `max` bytes (login: chico; send: audio base64).
 *  Acumula chunks como Buffers y decodifica al final — el patrón `buf += chunk` hacía
 *  toString implícito por chunk y podía romper caracteres multibyte cuando un code
 *  point UTF-8 caía en el borde entre dos chunks.
 *  Body que EXCEDE `max` → resuelve `null` (payload too large) SIN destruir la conexión,
 *  para que el caller responda un status honesto (413 en /api/send; los demás caen en su
 *  path de body inválido). Antes era un `req.destroy()` MUDO: el cliente veía un fallo de
 *  red genérico, indistinguible de una caída (Fase B.2 del plan conexión rock-solid). */
function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > max) {
        chunks.length = 0; // soltá lo acumulado (no se va a usar)
        req.removeAllListeners("data");
        req.resume(); // drená el resto sin acumular, así el request llega a `end`
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}
