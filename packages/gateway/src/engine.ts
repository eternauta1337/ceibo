// Motor del gateway de ceibo — la lógica de un turno (multi-usuario + metering), SIN
// side-effects de arranque. `createGateway(deps)` devuelve los handlers que el bootstrap
// (`index.ts`) cablea a los canales; este módulo se puede importar en tests sin abrir
// sockets, conectar Telegram ni leer .env (esa es la costura del e2e — Ola 5).
//
// Cerebro: una sesión de Managed Agents cloud POR USUARIO, manejada por `@ceibo/agent`
// (bidireccional, sin turnos). El allowlist + el ruteo salen del store
// (`channel_identities`): un mensaje se resuelve a un usuario activo o se ignora. Cada
// turno completado se contabiliza en `usage_turns` (fuente de verdad para facturar).
//
// Comandos (por usuario): /new (sesión nueva), /session (id), /stop (interrumpir).

import type Anthropic from "@anthropic-ai/sdk";
import {
  apiErrorMessage,
  type ErrorOrigin,
  type InboundMedia,
  type Relay,
  type SessionBackend,
  type SessionConfig,
  type Sink,
  type TurnTiming,
  type TurnUsage,
} from "@ceibo/agent";
import {
  activityLabel,
  type ChannelPolicy,
  type InboundAudio,
  type PostTarget,
  SUBAGENT_SPAWNED_HINT,
  type TurnFact,
} from "@ceibo/channels";
import {
  buildAgentMcpConfig,
  DEFAULT_PROFILE,
  knownService,
  mcpUrlForProfile,
  refreshGrantsForUser,
  SERVICE_NAMES,
  sanitizeProfile,
  serverNameForProfile,
} from "@ceibo/oauth";
import {
  defaultRate,
  defaultVoice,
  displayVoice,
  isValidLang,
  isValidPitch,
  isValidRate,
  isValidVolume,
  LANGS,
  paramSupported,
  resolveVoice,
  speechEnabled,
  speechProvider,
  synthesize,
  transcribeDetailed,
  voiceMatchesLang,
  voicesForLang,
} from "@ceibo/speech";
import {
  addChannel,
  addUser,
  type CronRow,
  cancelCron,
  ceiboEnv,
  completeCron,
  createEnrollToken,
  createWebLoginToken,
  type Db,
  deleteOauthGrant,
  firstUserForRepo,
  getOauthGrant,
  getSession,
  getUser,
  getUserActiveWiki,
  getUserDebug,
  getUserLang,
  getUserModel,
  getUserSpeech,
  getWikiHead,
  isOwner,
  latestWikiChangeId,
  listChannels,
  listConnections,
  listCronsDue,
  listCronsForUser,
  listGrantsForUser,
  listReposForUser,
  listSyncWatermarks,
  listUsers,
  nextFireFrom,
  type OauthGrant,
  type Repo,
  recordBroadcast,
  recordConnection,
  recordRemTurn,
  recordTurn,
  removeConnection,
  rescheduleCron,
  resolveUser,
  sealGrantNotified,
  setDefaultProfile,
  setRepoLabel,
  setSession,
  setUserActiveWiki,
  setUserDebug,
  setUserLang,
  setUserLocalVault,
  setUserModel,
  setUserSpeech,
  setUserVault,
  signScheduleToken,
  signUserToken,
  type User,
  vaultIdForUser,
  viewCron,
  wikiChangesSince,
  wikiDisplayNames,
  wikiLabel,
} from "@ceibo/store";
import type { Wikis } from "@ceibo/wikis";
import {
  buildTitlePrompt,
  currentTimeTag,
  formatTurnSummary,
  formatWorkerResultForCoordinator,
  isSubstantialForTitle,
  langTag,
  parseModalityDirective,
  parseWorkerStructuredResultFromParts,
  pickDefaultProfile,
  publicErrorReason,
  remMaxDeletions,
  resolveAgentId,
  sanitizeTitle,
  sessionFingerprint,
  verifyWorkerObservedDiff,
  type WikiTurnChange,
  type WorkerObservedWikiDiff,
  type WorkerVerificationIssue,
  wikiMatches,
} from "./logic.ts";
import {
  CHAT_MODELS,
  type ChatModel,
  DEFAULT_MODEL_KEY,
  defaultModelKeyForBackend,
  modelsForBackend,
} from "./models.ts";
import { enrollWhatsapp, logoutWhatsapp, noteActivity, stopFollow } from "./wacli.ts";

/** El único canal con ventanilla persistente (Telegram). Identidad raíz del owner y destino
 *  por default del egress proactivo. */
export const CHANNEL = "telegram";

/** Texto tenue para los logs del gateway. */
export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/** Formatea el timing del turno (solo backend local; ver quickboot/mediciones.md) para la línea de
 *  log de turno: `ttft:21.4s gen:1.2s ` (con espacio final), o `` si no hay timing (MA, o turno sin
 *  send). `ttft` = prefill (alto = cold; <0.5s con `in` grande = prefix-cache hit/warm); `gen` =
 *  generación (turnMs − ttft). Si falta ttft pero hay turnMs, cae a `turn:Xs`. */
export function fmtTurnTiming(t?: TurnTiming): string {
  if (!t) return "";
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const parts: string[] = [];
  if (t.ttftMs != null) parts.push(`ttft:${s(t.ttftMs)}`);
  if (t.turnMs != null) {
    if (t.ttftMs != null) parts.push(`gen:${s(Math.max(0, t.turnMs - t.ttftMs))}`);
    else parts.push(`turn:${s(t.turnMs)}`);
  }
  return parts.length ? `${parts.join(" ")} ` : "";
}

/** Nombre del server MCP de búsqueda web (Tavily hosted) en la config de opencode. Sólo se monta
 *  para archima (backend local), gateado por `TAVILY_MCP_URL`. Ver `webSearchExtraServers`. */
export const TAVILY_SERVER_NAME = "tavily";

/** Servers MCP extra de búsqueda web para un usuario, montados como remotos en la sesión.
 *  Hoy: Tavily (MCP hosted oficial, `mcp.tavily.com`) SOLO para archima (`backend_mode === "local"`)
 *  y SOLO si `TAVILY_MCP_URL` está seteado. En MA devuelve [] a propósito: MA tiene su propio egress
 *  y no pasa por el AV (que es quien allowlistea el host e inyecta el Bearer por-host, como con gmail),
 *  así que su web search se resolvería por otra vía. La key vive en gpuhost y la inyecta el AV: NO
 *  toca este código. Pura (sin I/O) para poder fijar el gating en tests. */
export function webSearchExtraServers(
  env: NodeJS.ProcessEnv,
  user: Pick<User, "backend_mode">,
): { name: string; url: string }[] {
  if (env.TAVILY_MCP_URL && user.backend_mode === "local") {
    return [{ name: TAVILY_SERVER_NAME, url: env.TAVILY_MCP_URL }];
  }
  return [];
}

// Dependencias que el bootstrap (`index.ts`) construye desde el entorno y le inyecta al motor.
// `cronTarget` se resuelve con los canales YA creados; como sólo se invoca al disparar un cron
// (mucho después del arranque), el bootstrap lo puede pasar con binding tardío y así romper la
// circularidad (los canales necesitan `handleIncoming`; el egress proactivo necesita los canales).
export interface GatewayDeps {
  env: NodeJS.ProcessEnv;
  client: Anthropic;
  /** Backend de sesión (la costura): hoy MA global (makeMaBackend); per-usuario en PR-B. */
  backendForUser: (user: User) => SessionBackend;
  db: Db;
  cfg: SessionConfig;
  /** Substrato de wikis (GitHub App). Opcional: sin esto el gateway anda igual (chat pelado). */
  wikis?: Wikis;
  /** Egress de un cron según su canal elegido ('telegram'|'whatsapp'|'web'|'all'); 'all' hace
   *  fan-out a los canales persistentes del usuario. `web` (feature crons-delivery) devuelve un
   *  target que persiste el resultado en el inbox durable (siempre) + emite el frame `inbox` en
   *  vivo si la vista está abierta — necesita la fila completa del cron (title/source_id), de ahí
   *  que reciba el CronRow. undefined = ningún canal alcanzable. */
  cronTarget: (user: User, cron: CronRow) => PostTarget | undefined;
  /** Entrega la notificación de "grant OAuth roto" (invalid_grant → hay que reconectar) al usuario
   *  como item DURABLE en el 🔔 (inbox persistente + badge en vivo + fallback al canal si aplica).
   *  Recibe el grant roto (service/profile/account/display_name) y el link de reconexión ya armado.
   *  Devuelve `true` SÓLO si la entrega fue confiable (item durable insertado) → el motor recién
   *  entonces sella `notified_at` (retry-hasta-entregar). Vive en el bootstrap (index.ts) porque
   *  necesita el canal remoto + addInboxItem, que el motor no tiene. undefined = no configurado
   *  (dev/tests sin canales) → el motor no sella y reintenta el próximo sweep. */
  notifyGrantBroken?: (user: User, grant: OauthGrant, reconnectUrl: string) => Promise<boolean>;
}

/** Los handlers que el motor expone al bootstrap. El canal (telegram/cli/remote) los cablea. */
export interface Gateway {
  handleIncoming: (
    channel: ChannelPolicy,
    externalId: string,
    text: string,
    thread: PostTarget,
    extras?: { audio?: InboundAudio; media?: InboundMedia[]; facts?: TurnFact[] },
  ) => Promise<void>;
  sendBroadcast: (text: string, emit: (line: string) => void) => Promise<{ sent: number; failed: number }>;
  fireDueCrons: () => Promise<void>;
  /** Corre un comando de usuario (`/connect`, `/model`, …) para `userId` y devuelve la salida
   *  del handler como texto. La usa el MCP `control` (tool `ceibo_command`): el agente controla
   *  los mismos comandos que el usuario tipea. Throw si el comando no existe o el user es desconocido. */
  runCommandForUser: (userId: number, command: string) => Promise<string>;
  /** Postea un mensaje al chat real del usuario fuera de banda (sin pasar por el modelo). La usa el
   *  MCP `control` (tool `connect_service`) para entregar el auth_url EXACTO directo al chat, así el
   *  link llega bien aunque el modelo no lo transcriba. Devuelve true si había un thread vivo. */
  postToUser: (userId: number, text: string) => Promise<boolean>;
  /** Despacha un sub-agente ASÍNCRONO para `userId` (lo usa el MCP `control` · tool `subagent_spawn`).
   *  Devuelve INMEDIATO el texto de confirmación de despacho (o el motivo si no se pudo: backend no
   *  archima, o techo de workers vivos). El worker corre en background; su resultado se le inyecta
   *  después al coordinador como turno sintético. Throw sólo si el usuario es desconocido. */
  spawnSubagentForUser: (userId: number, goal: string, title?: string) => Promise<string>;
  /** Cancela un worker asíncrono vivo de `userId` (lo usa el MCP `control` · tool `subagent_kill`).
   *  `ref` = id numérico o (pedazo único de) título. Saca el worker del registro y del conteo,
   *  aborta su turno opencode en la VM (best-effort) y suprime la inyección de su resultado.
   *  Devuelve el texto para el modelo (confirmación o el motivo si no se pudo). Throw sólo si el
   *  usuario es desconocido. */
  killSubagentForUser: (userId: number, ref: string) => Promise<string>;
  /** Cierra todos los relays vivos (apagado limpio). */
  closeRelays: () => void;
  /**
   * Recrea la sesión MA del usuario `userId` (plano de control — lo usa el canal remoto al
   * recibir un frame `control/reset-session` del web-server). Si el usuario tiene un turno
   * en vuelo (`busy`), el reset se difiere al cierre del turno (no corta el turno a la mitad).
   * Si no hay sesión viva ni contexto de usuario, es no-op silencioso.
   */
  resetSessionForUser: (userId: number) => void;
  /**
   * Tick del clear diario de sesión (quickboot/sessions §3): por cada usuario `backend_mode=local`
   * activo, hace un HARD reset de su sesión a las 4am de SU timezone, para que el prefill matutino
   * arranque mínimo. Lo llama un timer del gateway; barato e idempotente si no vence nada.
   */
  runDailyClears: () => void;
}

/** Bootstrap OPCIONAL de una DB nueva: siembra al owner si TELEGRAM_OWNER_ID está seteada y no
 *  existe. El allowlist real vive en `channel_identities` (gestionado por `ceibo channel`). */
export function seedOwner(db: Db, ownerTelegramId: string): void {
  if (resolveUser(db, CHANNEL, ownerTelegramId)) return;
  const u = addUser(db, "owner"); // sin nombre de display; el owner se renombra por CLI
  addChannel(db, u.id, CHANNEL, ownerTelegramId);
  console.log(dim(`owner sembrado: ${u.handle} ↔ ${CHANNEL}:${ownerTelegramId}`));
}

/** Selector de backend de sesión por usuario (el enchufe de archima). MA es el default ('ma');
 *  'local' resuelve al backend de archima si está configurado en el env (ARCHIMA_*). Si un
 *  usuario está en 'local' pero archima no fue cableado, falla explícito en vez de caer a MA. */
export function makeBackendForUser(
  maBackend: SessionBackend,
  archimaBackend?: SessionBackend,
): (user: User) => SessionBackend {
  return (user) => {
    if (user.backend_mode === "local") {
      if (!archimaBackend) {
        throw new Error(
          `usuario ${user.id} (${user.handle}): backend 'local' pedido pero archima no está configurado (faltan ARCHIMA_* en el env)`,
        );
      }
      return archimaBackend;
    }
    return maBackend;
  };
}

/** Origen de error para `apiErrorMessage`, derivado del backend del usuario: un user 'local'
 *  corre en archima (ssh/cp.sh/opencode) → sus errores NO son de Anthropic. */
export function errorOriginForUser(user: User): ErrorOrigin {
  return user.backend_mode === "local" ? "local" : "ma";
}

/** Construye el motor del gateway con las dependencias inyectadas. Sin side-effects: no abre
 *  sockets ni conecta canales (eso es el bootstrap). Devuelve los handlers a cablear. */
export function createGateway(deps: GatewayDeps): Gateway {
  const { env, client, backendForUser, db, cfg, wikis, cronTarget, notifyGrantBroken } = deps;

  // Modelos de chat ofrecibles — POR BACKEND (workstream E). MA: coordinadores Anthropic
  // publicados (haiku siempre = AGENT_ID; sonnet/opus si su env está). Local (archima): el roster
  // de inferencia local. La lista que ve cada usuario en /model y el cog se computa por su
  // backend_mode; abajo, el mapa MA sólo lo usa agentIdForUser (el modelo de un usuario MA = un
  // agentId; para un usuario local el agentId es inerte — su modelo lo sirve opencode en la VM).
  const maModelByKey = new Map(CHAT_MODELS.filter((m) => !!env[m.envKey]).map((m) => [m.key, m] as const));

  // Modelo barato para titular el chat (resumen semántico del tema actual): haiku por default,
  // configurable por env. NO pasa por MA (no es un turno de agente) — es una utilidad de texto
  // sobre el cliente Anthropic que ya tenemos. Ver maybeUpdateChatTitle / generateChatTitle.
  const TITLE_MODEL = env.CHAT_TITLE_MODEL ?? "claude-haiku-4-5";

  /** Modelos ofrecibles a un usuario según su backend (MA → Anthropic; local → roster local). */
  function modelsForUser(user: User): ChatModel[] {
    return modelsForBackend(user.backend_mode, env);
  }

  /** agentId del coordinador para un usuario MA según su modelo elegido (sin elección → default
   *  sonnet; si no está publicado, cae al principal AGENT_ID). Para un usuario LOCAL el agentId no
   *  selecciona modelo (lo sirve opencode) → devolvemos el principal, inerte para archima. */
  function agentIdForUser(user: User): string {
    if (user.backend_mode === "local") return cfg.agentId;
    return resolveAgentId(getUserModel(db, user.id), maModelByKey, env, cfg.agentId, DEFAULT_MODEL_KEY);
  }

  function localCoordinatorModelForUser(user: User): SessionConfig["localModel"] | undefined {
    if (user.backend_mode !== "local") return undefined;
    const key = getUserModel(db, user.id);
    if (!key) return undefined;
    const model = modelsForUser(user).find((m) => m.key === key);
    if (!model) return undefined;
    const slash = model.model.indexOf("/");
    if (slash > 0) {
      return { providerID: model.model.slice(0, slash), modelID: model.model.slice(slash + 1) };
    }
    return { modelID: model.model };
  }

  // Servicio WhatsApp (Fase 9) en la vista de conexiones. Single-account por usuario
  // (un --store por userId), así que sin perfil (a diferencia de los OAuth multi-cuenta).
  const WHATSAPP_SERVICE = "whatsapp";
  /** ¿El usuario tiene WhatsApp pareado? (marca barata en `connections`, puesta al parear.) */
  function whatsappConnected(userId: number): boolean {
    return listConnections(db, userId).some((c) => c.service === WHATSAPP_SERVICE);
  }

  /** Vault del usuario para SU backend activo (lazy): lo crea la primera vez y lo cachea en el row.
   *  Cada backend tiene su propio vault con IDs incompatibles (MA: vlt_011C…; local/archima:
   *  UUID/slug) → persistimos al column que le corresponde al backend (vault_id vs local_vault_id)
   *  y NUNCA pisamos el del otro. Así un user puede ir y volver entre 'ma' y 'local' sin perder
   *  ninguno, y el push de credenciales del backend local va al vault que el agent-vault conoce. */
  async function ensureVault(user: User): Promise<string> {
    const existing = vaultIdForUser(user);
    if (existing) return existing;
    const local = user.backend_mode === "local";
    const vaultId = await backendForUser(user).createVault(`ceibo · ${user.handle}`);
    if (local) {
      setUserLocalVault(db, user.id, vaultId);
      user.local_vault_id = vaultId;
    } else {
      setUserVault(db, user.id, vaultId);
      user.vault_id = vaultId;
    }
    return vaultId;
  }

  /** Mintea al vault el Bearer de identidad de wacli (token firmado → userId → --store).
   *  C1: firma con WACLI_MCP_HMAC_KEY (dedicada), no con el path-secret de la URL. La URL
   *  (WACLI_MCP_URL) ya embebe el WACLI_MCP_PATH_SECRET que gatea el acceso. */
  async function mintWacliBearer(user: User, vaultId: string): Promise<void> {
    if (!env.WACLI_MCP_URL || !env.WACLI_MCP_HMAC_KEY) return;
    await backendForUser(user).setStaticBearerCredential(vaultId, {
      mcpServerUrl: env.WACLI_MCP_URL,
      displayName: "WhatsApp",
      token: signUserToken(user.id, env.WACLI_MCP_HMAC_KEY),
    });
  }

  // Prepara la config de sesión de un usuario:
  //  - mintea UN token efímero scoped a EXACTAMENTE sus repos (aislamiento por auth),
  //  - monta esos repos (lectura por clon),
  //  - guarda ese token en el vault del usuario como credencial del GitHub MCP
  //    (escritura), creando el vault la primera vez.
  async function prepareSession(user: User, originChannel?: string): Promise<Partial<SessionConfig>> {
    const repos = wikis ? listReposForUser(db, user.id) : [];
    // El vault hace falta para GitHub MCP (repos), OAuth, schedule (Fase 8) y wacli si el
    // usuario lo conectó (Fase 9). Si no hay ninguno, no creamos vault (chat pelado).
    const needVault =
      repos.length > 0 ||
      !!env.SCHEDULE_MCP_URL ||
      !!env.VIEWER_MCP_URL ||
      !!env.CONTROL_MCP_URL ||
      (!!env.WACLI_MCP_URL && whatsappConnected(user.id)) ||
      // Búsqueda web (Tavily) sólo aplica a archima (backend local); si es lo ÚNICO configurado,
      // igual hace falta el vault para sembrarle la cred (ver bloque de seeding más abajo).
      (!!env.TAVILY_MCP_URL && !!env.TAVILY_API_KEY && user.backend_mode === "local");
    if (!needVault) return {};

    const vaultId = await ensureVault(user);

    // Mint de las creds del vault EN PARALELO (quickboot): eran ~4 creds × 2 llamadas AV seriales
    // (credential set + service add) = ~8 round-trips ssh = el grueso del `prep` del cold-open
    // (medido ~4.6s). El AV es concurrency-safe para escrituras al mismo vault (verificado) y
    // ControlMaster multiplexa las sesiones ssh → las disparamos juntas y esperamos todas al final.
    const credTasks: Promise<unknown>[] = [];

    // Cred del MCP schedule (Fase 8): static_bearer = token de identidad firmado que el
    // launcher verifica para sacar el userId. C1: firma con SCHEDULE_MCP_HMAC_KEY (dedicada);
    // la URL ya embebe el SCHEDULE_MCP_PATH_SECRET que gatea el acceso. Idempotente.
    if (env.SCHEDULE_MCP_URL && env.SCHEDULE_MCP_HMAC_KEY) {
      // El canal de origen va EMBEBIDO en el token (feature crons-delivery) → el MCP schedule crea
      // el cron con ese canal y el fire-path lo entrega ahí. Fallback telegram si no se conoce
      // (ej. una sesión revivida por un cron, que no tiene canal de origen interactivo).
      credTasks.push(
        backendForUser(user).setStaticBearerCredential(vaultId, {
          mcpServerUrl: env.SCHEDULE_MCP_URL,
          displayName: "Crons",
          token: signScheduleToken(user.id, originChannel ?? "telegram", env.SCHEDULE_MCP_HMAC_KEY),
        }),
      );
    }

    // Cred del MCP viewer (managed-ui Fase B): mismo patrón que schedule (token firmado
    // → userId → empuje al WS). Global: el agente puede llamar viewer_open siempre; si el
    // usuario no tiene la web abierta, la tool lo avisa. Idempotente.
    // C1 (resuelto): firma con VIEWER_MCP_HMAC_KEY (dedicada), no con el path-secret de la
    // URL. La URL (VIEWER_MCP_URL) ya embebe el VIEWER_MCP_SECRET que gatea el acceso.
    // Misma política que schedule/wacli: sin HMAC key no se mintea la cred.
    if (env.VIEWER_MCP_URL && env.VIEWER_MCP_HMAC_KEY) {
      credTasks.push(
        backendForUser(user).setStaticBearerCredential(vaultId, {
          mcpServerUrl: env.VIEWER_MCP_URL,
          displayName: "Vista web",
          token: signUserToken(user.id, env.VIEWER_MCP_HMAC_KEY),
        }),
      );
    }

    // Cred del MCP control: mismo patrón que schedule/viewer (token firmado → userId →
    // runCommandForUser). Global: el agente puede correr comandos del usuario (`ceibo_command`)
    // siempre. Idempotente. Opcional: sin CONTROL_MCP_URL no se monta.
    // C1 (resuelto): firma con CONTROL_MCP_HMAC_KEY (dedicada), no con el path-secret de la
    // URL. La URL (CONTROL_MCP_URL) ya embebe el CONTROL_MCP_SECRET que gatea el acceso.
    // Misma política que schedule/wacli: sin HMAC key no se mintea la cred.
    if (env.CONTROL_MCP_URL && env.CONTROL_MCP_HMAC_KEY) {
      credTasks.push(
        backendForUser(user).setStaticBearerCredential(vaultId, {
          mcpServerUrl: env.CONTROL_MCP_URL,
          displayName: "Comandos",
          token: signUserToken(user.id, env.CONTROL_MCP_HMAC_KEY),
        }),
      );
    }

    // Cred del MCP notes (feature db F2): mismo patrón que control/viewer (token firmado →
    // userId → scope de wikis vía listReposForUser). Global; sin NOTES_MCP_URL no se monta.
    if (env.NOTES_MCP_URL && env.NOTES_MCP_HMAC_KEY) {
      credTasks.push(
        backendForUser(user).setStaticBearerCredential(vaultId, {
          mcpServerUrl: env.NOTES_MCP_URL,
          displayName: "Notas",
          token: signUserToken(user.id, env.NOTES_MCP_HMAC_KEY),
        }),
      );
    }

    // Cred del MCP wacli (Fase 9): sólo si el usuario tiene WhatsApp pareado (a diferencia
    // de schedule, que es global). Idempotente; re-asegura la cred en cada sesión.
    if (env.WACLI_MCP_URL && whatsappConnected(user.id)) credTasks.push(mintWacliBearer(user, vaultId));

    // Cred del MCP de búsqueda web (Tavily) — SÓLO archima (backend local; en MA el egress es de
    // MA, ver `webSearchExtraServers`). A diferencia de schedule/viewer/control (token que firmamos
    // nosotros), acá el "token" es la API KEY de Tavily —la cuenta del hogar— que viene de
    // env.TAVILY_API_KEY: NO la minteamos. La sembramos en CADA vault porque el AV inyecta el Bearer
    // por-host y NO hay herencia de creds entre vaults → sin esto un usuario nuevo nace sin búsqueda
    // web (era EL agujero sistémico: la cred sólo estaba sembrada a mano en un único vault). La URL
    // (`mcp.tavily.com/mcp/`) cae a cred `CRED_MCP_TAVILY_COM` + host pelado `mcp.tavily.com` (el
    // único segmento de path se trata como secret y se descarta). Idempotente (upsert por sesión).
    if (env.TAVILY_MCP_URL && env.TAVILY_API_KEY && user.backend_mode === "local") {
      credTasks.push(
        backendForUser(user).setStaticBearerCredential(vaultId, {
          mcpServerUrl: env.TAVILY_MCP_URL,
          displayName: "Tavily",
          token: env.TAVILY_API_KEY,
        }),
      );
    }

    // Esperamos las creds JUNTAS (paralelo, AV concurrency-safe) en vez de serial.
    await Promise.all(credTasks);

    if (repos.length === 0 || !wikis) return { vaultId };

    // NI el chat NI REM montan ya las wikis por git (colgaba → cold-start) ni usan el GitHub MCP.
    // Pasamos el material NEUTRAL de wiki-sync (token firmado + URL); el backend lo entrega a su
    // sustrato (MA → File resources; archima → cp.sh a la VM). Ambos trabajan sobre la working
    // copy LOCAL que hidratan por HTTPS contra `/api/sync`. (Fase 2c chat; REM migrado después.)
    return { vaultId, wikiSync: wikiSyncFor(user.id) };
  }

  /** Material neutral de wiki-sync para un user (token firmado + URL), o undefined si falta
   *  config. El gateway SÓLO firma; el upload/entrega al sustrato es del backend. */
  function wikiSyncFor(userId: number): SessionConfig["wikiSync"] {
    if (!env.WIKI_SYNC_SECRET || !env.WIKI_SYNC_URL) return undefined;
    return {
      token: signUserToken(userId, env.WIKI_SYNC_SECRET),
      url: env.WIKI_SYNC_URL,
      // Lista de wikis del user → archima las clona todas (wikibomb). MA la ignora.
      wikis: listReposForUser(db, userId).map((r) => r.name),
    };
  }

  // Estado vivo por usuario. La sesión MA es 1:1 con el usuario.
  interface UserCtx {
    user: User;
    sessionId?: string;
    relay?: Relay;
    // Apertura de relay EN VUELO (bug E): dos ensureRelay concurrentes (mensaje del usuario +
    // inyección de worker/cron) veían ambos `relay === undefined` y attacheaban DOS pumps al mismo
    // canal — el 2º pisaba `ctx.relay` y el 1º quedaba vivo para siempre duplicando frames y
    // contabilidad. Una sola apertura a la vez; los demás esperan la misma promesa.
    relayOpening?: Promise<void>;
    lastThread?: PostTarget;
    // Multi-cuenta (Fase 7): key de los perfiles extra ya aplicados a la sesión viva
    // (nombres de server ordenados, ej. "gmail_work,sheets_personal"). Evita re-pegarle
    // al session.update si no cambió nada. undefined = todavía no chequeado en esta sesión.
    appliedProfilesKey?: string;
    // MCP reconcile en vuelo (quickboot): true mientras los MCP se conectan en background tras un
    // cold-open. El gateway le inyecta al turno un aviso de que las tools externas todavía no están
    // listas (el agente dice "dame un segundo") en vez de correr como si no las tuviera.
    mcpPending?: boolean;
    // Canal de ORIGEN de la sesión (feature crons-delivery): el canal por el que el usuario abrió
    // la sesión (telegram/web/whatsapp). Se setea en handleIncoming y se hilvana hasta
    // prepareSession para mintear el token de schedule CON el canal → un cron creado en esta sesión
    // se entrega a este canal (en vez del telegram hardcodeado). Limitación v1: se fija al abrir la
    // sesión, no por-mensaje (la cred del schedule es estática del vault, una por sesión).
    originChannel?: string;
    // Crons (Fase 8): hay un turno en vuelo (serialización — el scheduler difiere si está
    // ocupado, para no pisar turnEgress). turnEgress decide qué hace el Sink con el output
    // del turno actual: 'always' (default, interactivo) postea; 'never' lo traga (cron de
    // fondo). 'conditional' es fast-follow. Se resetea a 'always' al terminar el turno.
    busy?: boolean;
    // Cancelación de un turno de usuario ENCOLADO (orb tap mientras "pensando"): `/stop` corre
    // CONCURRENTE con la prep del turno (STT → build de tags → relay.send). `relay.interrupt()`
    // solo frena un turno YA corriendo; si el `/stop` llega ANTES del `relay.send` (ventana de la
    // prep), el interrupt es no-op y el turno se despacharía igual y contestaría. Este flag cubre
    // ESA ventana: `/stop` lo prende, y el dispatch lo chequea JUSTO antes de `relay.send` y aborta.
    // Se resetea al ACEPTAR un turno nuevo legítimo (al tope de handleIncoming, antes de la prep) y
    // tras consumirlo en el dispatch. NO lo miran los sends internos del coordinador (workers/crons):
    // es solo la cancelación del turno interactivo del usuario.
    cancelRequested?: boolean;
    turnEgress?: "always" | "never" | "conditional";
    // Resumen de cambios de wiki del turno: en un turno INTERACTIVO (el usuario le pidió algo al
    // agente, no un cron/REM de fondo) capturamos el cursor del feed `wiki_changes` ANTES del
    // turno; al cerrar leemos los cambios source='agent' posteriores y posteamos un resumen en la
    // voz del agente. undefined = no es un turno interactivo (o no hay wikis) → no se resume.
    wikiTurnStartId?: number;
    // Voz (Fase 10): el AGENTE decide voz vs texto con [[voz]]/[[texto]] (espejo instruido en
    // el system prompt). egressTail serializa las salidas del Sink (la síntesis TTS es async y
    // los bloques agent.message podrían reordenarse).
    egressTail?: Promise<unknown>;
    // Título del chat (tema actual): en un turno INTERACTIVO capturamos el texto del usuario
    // (`titleUserMsg`) y acumulamos las partes de la respuesta del agente (`titleAgentParts`);
    // al cerrar le pedimos a haiku un título corto y lo emitimos como frame `chat-title`.
    // `chatTitle` = el último emitido (para no re-emitir si el tema no cambió → no parpadea).
    // undefined en `titleUserMsg` = turno no interactivo (cron/REM) → no se titula.
    titleUserMsg?: string;
    titleAgentParts?: string[];
    chatTitle?: string;
    // Sub-agentes asíncronos (archima): workers vivos despachados con `subagent_spawn` (id→meta).
    // Corren en una SEGUNDA sesión opencode en la misma VM; al terminar, su resultado se inyecta al
    // coordinador como turno sintético. El conteo de mini-orbs combina ESTO con `taskSubagents`.
    // `kill` (lo registra startWorker cuando el worker ya existe) cancela el worker a pedido del
    // coordinador (tool `subagent_kill`): aborta su turno opencode en la VM y resuelve su `done`
    // sin inyección de resultado.
    // `originThread`: el PostTarget del turno que DESPACHÓ el worker (el `lastThread` vigente al
    // `subagent_spawn`). El resultado del worker se inyecta como turno sintético al cerrar; sin
    // esto, la inyección posteaba a `ctx.lastThread` AL MOMENTO DE ENTREGAR — que para entonces
    // pudo haber sido pisado por un mensaje de otro canal del usuario (telegram) o un cron, y el
    // resultado terminaba en el canal equivocado (ej. una nota de voz por Telegram para un pedido
    // hecho desde la web). Capturamos el thread de ORIGEN acá y lo restauramos en injectToCoordinator
    // → la respuesta vuelve a la vista/canal que preguntó (preserva el `origin` web y su modalidad).
    workers?: Map<
      number,
      {
        title: string;
        goal: string;
        sid?: string;
        startedAt: number;
        kill?: () => void;
        originThread?: PostTarget;
      }
    >;
    nextWorkerId?: number;
    // Conteo de sub-agentes que reporta el BACKEND del turno vivo (tool-calls `task` en `running`,
    // MA: threads del roster). Lo combinamos con `workers.size` para el frame `subagents` (mini-orbs)
    // → las dos fuentes no se pisan (ver emitSubagents). Se resetea a 0 al cerrar el turno.
    taskSubagents?: number;
    // Inyecciones (resultados de workers) encoladas mientras el coordinador está en un turno: se
    // disparan de a una al cerrar el turno (drainPending), serializadas como los crons (fireOne).
    // Cada item lleva su propio canal de ORIGEN (`originThread`) para que la respuesta vuelva a la
    // vista/canal que pidió ESE trabajo — un string pelado (legacy/sin origen) cae al `lastThread`
    // vigente como antes.
    pendingInjections?: (string | { text: string; originThread: PostTarget })[];
    // Plano de control (F3): reset de sesión diferido. Si llega un frame `reset-session` mientras
    // hay un turno en vuelo, lo marcamos acá en vez de cortar el turno. drainPending lo procesa
    // al cerrar el turno — ANTES de drenar inyecciones (sesión fresca antes de inyectar).
    pendingReset?: boolean;
    // Coreografía del anuncio de delegación (archima): cuando el coordinador despacha workers con
    // `subagent_spawn`, el ANUNCIO al usuario lo redacta el MODELO (su voz, uno solo aunque haya
    // despachado varios) — el gateway ya no postea un template. Estado por turno:
    //   • "pending" — hubo ≥1 spawn y el anuncio todavía no salió: el PRÓXIMO `agent.message` del
    //     coordinador ES el anuncio → se postea y RECIÉN AHÍ se cierra el turno para el usuario
    //     (turn-done). `labels` junta los títulos despachados (para el fallback); `timer` es la
    //     garantía anti-silencio: si el modelo no anuncia a tiempo, el gateway postea una línea
    //     mínima que cubre a todos y cierra el turno igual.
    //   • "done" — el anuncio ya salió (del modelo o el fallback): el output POSTERIOR del
    //     coordinador en ESE turno (su confirmación lenta, si llega) se DESCARTA — evita el
    //     duplicado. La sesión opencode NO se aborta (corrompería el turno): termina en background
    //     y se traga. Se limpia al cerrar el turno (turnComplete/dead) y al arrancar uno nuevo
    //     (beginTurn).
    spawnAnnounce?: { state: "pending" | "done"; labels: string[]; timer?: ReturnType<typeof setTimeout> };
    // Telemetría de sesión para el comando `/status` (quickboot/sessions). Se cachea el usage
    // ACUMULADO de la última respuesta (`turnComplete`) y el modelo, y el instante de la última
    // compactación (`notice` de `session.compacted`). Todo best-effort: si nunca hubo un turno
    // cerrado, `/status` lo dice. No se persiste (vive con el ctx en memoria).
    lastUsage?: TurnUsage;
    lastUsageModel?: string;
    lastCompactedAt?: number;
  }
  const ctxByUser = new Map<number, UserCtx>();

  // Sub-agentes asíncronos: techo de workers vivos por usuario (la tool rechaza si se excede) y
  // timeout por worker (al vencer se abandona la sesión y se inyecta "no terminó a tiempo").
  const MAX_WORKERS = Math.max(1, Number(env.SUBAGENT_MAX) || 3);
  const WORKER_TIMEOUT_MS = Math.max(10, Number(env.SUBAGENT_TIMEOUT_MS) || 10 * 60 * 1000);
  // Tope de chars del resumen del worker que se reinyecta al coordinador (su contexto se recachea
  // cada turno → el crudo completo es caro). El prompt del worker ya pide ≤10 líneas; esto es el seguro.
  const WORKER_SUMMARY_CAP = Math.max(200, Number(env.SUBAGENT_SUMMARY_CAP) || 1500);
  // Garantía anti-silencio del anuncio de spawn: cuánto esperamos (desde el ÚLTIMO tool-result de
  // `subagent_spawn`) a que el MODELO redacte su anuncio antes de que el gateway postee la línea
  // mínima de fallback y cierre el turno. Generoso a propósito (archima genera lento): el owner
  // prefiere la voz natural del modelo; el fallback es el seguro contra el "usuario en el vacío".
  const ANNOUNCE_TIMEOUT_MS = Math.max(1, Number(env.SUBAGENT_ANNOUNCE_TIMEOUT_MS) || 30_000);

  // Guardrail de REM (incidente 2026-06-09): tope MECÁNICO de borrado por pasada. Si una corrida
  // de REM borra más de este número de notas .md (deletions NETAS — renames/moves no cuentan,
  // ver remNetDeletions en logic.ts), el gateway la revierte entera con un commit de revert
  // (sin force) y avisa al dueño de la wiki. Env REM_MAX_DELETIONS, default 10; 0 = cualquier
  // deletion neta dispara el revert.
  const REM_MAX_DELETIONS = remMaxDeletions(env.REM_MAX_DELETIONS);
  const WORKER_MAX_DELETIONS = remMaxDeletions(env.SUBAGENT_MAX_DELETIONS, REM_MAX_DELETIONS);

  function normalizeWorkerText(s: string): string {
    return s
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Frame `subagents` (mini-orbs) = sub-agentes vivos AHORA, COMBINANDO las dos fuentes: los que
   *  reporta el backend del turno (`taskSubagents`, tool-calls `task`) + los workers async vivos
   *  (`workers.size`). Conteo absoluto (reemplaza el anterior en la web). En crons de fondo
   *  ('never') no hay vista que decorar → no-op. */
  function emitSubagents(ctx: UserCtx): void {
    if (ctx.turnEgress === "never") return;
    const n = (ctx.taskSubagents ?? 0) + (ctx.workers?.size ?? 0);
    void ctx.lastThread?.subagents?.(n);
  }

  /** Limpia el estado del anuncio de spawn del turno (incluido el timer anti-silencio). */
  function clearSpawnAnnounce(ctx: UserCtx): void {
    if (ctx.spawnAnnounce?.timer) clearTimeout(ctx.spawnAnnounce.timer);
    ctx.spawnAnnounce = undefined;
  }

  /** Línea mínima de anuncio que postea el GATEWAY como fallback anti-silencio (sólo si el modelo
   *  no redactó la suya): cubre a TODOS los despachados del turno. Mecánica a propósito — la voz
   *  natural es del modelo; esto es el seguro contra el "usuario en el vacío". */
  function fallbackAnnounce(labels: string[]): string {
    if (labels.length === 1)
      return `Disparé un sub-agente para ${labels[0]}. Seguí hablando conmigo mientras trabaja.`;
    return (
      `Disparé ${labels.length} sub-agentes: ${labels.join(", ")}. ` +
      `Seguí hablando conmigo mientras trabajan.`
    );
  }

  /** Anti-silencio: si hubo spawns y el anuncio del MODELO no salió (timer vencido, turno cerrado
   *  sin texto, o relay muerto), postea la línea mínima que cubre a todos y cierra el turno para
   *  el usuario. Marca el anuncio como hecho → el texto tardío del coordinador, si llega, se traga. */
  function flushPendingAnnounce(ctx: UserCtx): void {
    const sa = ctx.spawnAnnounce;
    if (!sa || sa.state !== "pending") return;
    if (sa.timer) clearTimeout(sa.timer);
    sa.timer = undefined;
    sa.state = "done";
    const thread = ctx.lastThread;
    if (!thread || ctx.turnEgress === "never") return;
    console.log(dim(`→ [${ctx.user.id}] anuncio de spawn por FALLBACK (el modelo no anunció)`));
    void thread.post?.(fallbackAnnounce(sa.labels));
    // Cierre del turno para el usuario (orb libre) + re-afirmación del conteo DESPUÉS del
    // turn-done (la web toma el frame `subagents` como única fuente de verdad).
    void thread.turnDone?.();
    emitSubagents(ctx);
  }

  /** Marca el inicio de un turno: ocupa el ctx y fija el modo de egress del Sink.
   *  Si el usuario tiene WhatsApp pareado, marca actividad → arranca/mantiene el
   *  `sync --follow` (L349: el socket vive sólo mientras hay actividad, no 24/7). */
  function beginTurn(
    ctx: UserCtx,
    egress: "always" | "never" | "conditional" = "always",
    opts?: { interactive?: boolean },
  ): void {
    ctx.busy = true;
    ctx.turnEgress = egress;
    // Turno nuevo → la coreografía de anuncio de spawn del turno anterior se descarta (estado y
    // timer anti-silencio). Si el usuario mandó otro mensaje mientras la cola del coordinador
    // drenaba su frase tardía, ESTE turno es legítimo y su salida SÍ se postea.
    clearSpawnAnnounce(ctx);
    // Resumen de turno: sólo en turnos interactivos (handleIncoming) y si hay wikis. Capturamos
    // el cursor del feed ANTES del turno; al cerrar leemos los cambios source='agent' con id >
    // este cursor para resumir lo que tocó el agente en ESTE turno. undefined = no se resume.
    ctx.wikiTurnStartId = opts?.interactive && wikis ? latestWikiChangeId(db) : undefined;
    ctx.egressTail = undefined; // cadena de salida fresca por turno (Fase 10)
    // Título del chat: arranca limpio por turno. handleIncoming setea estos campos DESPUÉS de
    // beginTurn sólo en turnos interactivos; en crons/REM quedan undefined → no se titula.
    ctx.titleUserMsg = undefined;
    ctx.titleAgentParts = undefined;
    if (env.WACLI_MCP_URL && whatsappConnected(ctx.user.id)) noteActivity(ctx.user.id);
  }

  // Tag que el bridge antepone al texto que va al AGENTE cuando el usuario mandó una nota de
  // voz, para que el agente lo sepa y pueda espejar (responder con [[voz]]) — la decisión es
  // del agente (instruida en el system prompt), el bridge sólo informa el canal de entrada.
  const INBOUND_VOICE_TAG = "[el usuario te habló por una nota de voz]";

  // Tag de idioma (Fase 15). El prompt del agente es compartido por todos los usuarios → el
  // idioma per-usuario se inyecta por turno, como el de voz. Sólo cuando != 'es' (el prompt
  // ya tiene español por default; cero costo de tokens en el caso común). El agente y los
  // sub-agentes (heredan el mismo prompt) responden en el idioma indicado.

  // Postea una respuesta del agente al canal según su marcador de modalidad. Si pidió voz
  // pero el canal no la soporta (ej. `cli`) o la síntesis falla, cae a texto (marcador ya
  // removido). La voz/prosodia salen de los settings del usuario (/voice).
  async function emitReply(ctx: UserCtx, raw: string): Promise<void> {
    const thread = ctx.lastThread;
    if (!thread) return;
    const { voice, text } = parseModalityDirective(raw);
    // La modalidad la decide el agente con `[[voice]]`/`[[text]]`. El bridge no espeja
    // ni tiene preferencia: con marcador → voz; sin marcador → texto. (Antes el web
    // forzaba voz siempre porque la UI no mostraba texto; ahora la UI tiene un caption
    // visible y un text input, así que respondemos texto cuando el agente lo eligió.)
    const wantVoice = voice;
    if (wantVoice && speechEnabled() && thread.postVoice) {
      try {
        const sp = getUserSpeech(db, ctx.user.id);
        await thread.postVoice(
          await synthesize(text, {
            ...sp,
            rate: sp.rate ?? defaultRate(), // NULL → lenta por default (Elena lenta)
            lang: getUserLang(db, ctx.user.id),
          }),
          text, // la transcripción viaja junto al audio → el chat web la muestra (#1/#2)
        );
        return;
      } catch (e) {
        console.log(dim(`[tts] user=${ctx.user.id}: ${(e as Error)?.message ?? e} → caigo a texto`));
      }
    }
    await thread.post(text);
  }

  /** Resumen de cambios de wiki del turno interactivo: lee los cambios source='agent' de ESTE
   *  usuario con id > el cursor capturado al arrancar el turno (`wikiTurnStartId`), los
   *  coalesce/formatea en la voz del agente y los postea al thread DESPUÉS de su respuesta.
   *  No-op si el turno no era interactivo, no hay wikis, o el agente no tocó la wiki. Se encadena
   *  en `egressTail` para salir tras el último mensaje del agente (esa cadena serializa el egress
   *  del turno; la síntesis TTS es async). */
  function postTurnSummary(ctx: UserCtx): void {
    const cursor = ctx.wikiTurnStartId;
    ctx.wikiTurnStartId = undefined;
    if (cursor == null || !wikis) return;
    const thread = ctx.lastThread;
    if (!thread) return;
    const items: WikiTurnChange[] = [];
    for (const c of wikiChangesSince(db, cursor)) {
      if (c.source !== "agent" || c.userId !== ctx.user.id) continue;
      for (const e of c.entries) items.push({ op: e.op, path: e.path });
    }
    const summary = formatTurnSummary(items);
    if (!summary) return;
    console.log(dim(`→ [${ctx.user.id}] resumen de turno: ${items.length} cambio(s) de wiki`));
    ctx.egressTail = (ctx.egressTail ?? Promise.resolve())
      .then(() => thread.post(summary))
      .catch((e) => console.log(dim(`[turn-summary] user=${ctx.user.id}: ${(e as Error)?.message ?? e}`)));
  }

  /** Título del chat (tema actual): tras un turno interactivo, genera con haiku un título corto
   *  (2-5 palabras) y lo emite como frame `chat-title`. Best-effort y async — NO bloquea el
   *  cierre del turno (el caller no la awaitea). Saltea turnos no interactivos (sin
   *  `titleUserMsg`), canales que no soportan el frame (telegram/cli, sin `chatTitle` en el
   *  PostTarget) y turnos triviales (gate de sustancia). No re-emite si el tema no cambió. */
  function maybeUpdateChatTitle(ctx: UserCtx): void {
    const userMsg = ctx.titleUserMsg;
    const parts = ctx.titleAgentParts;
    ctx.titleUserMsg = undefined;
    ctx.titleAgentParts = undefined;
    if (!userMsg) return; // turno no interactivo (cron/REM) → no se titula
    const thread = ctx.lastThread;
    if (!thread?.chatTitle) return; // el canal no pinta títulos → no gastamos un call de haiku
    const agentMsg = (parts ?? []).join("\n");
    if (!isSubstantialForTitle(userMsg, agentMsg)) return; // saludo/confirmación/sin sustancia
    void generateChatTitle(userMsg, agentMsg, ctx.chatTitle)
      .then((title) => {
        if (!title || title === ctx.chatTitle) return; // sin tema nuevo → no parpadeamos
        ctx.chatTitle = title;
        console.log(dim(`✎ [${ctx.user.id}] título: ${title}`));
        return thread.chatTitle?.(title);
      })
      .catch((e) => console.log(dim(`[chat-title] user=${ctx.user.id}: ${(e as Error)?.message ?? e}`)));
  }

  /** Le pide a haiku (TITLE_MODEL) un título corto del tema del último intercambio. Devuelve el
   *  título saneado, o undefined si hay que mantener el previo (sentinel OK / vacío / igual).
   *  Usa el cliente Anthropic ya construido — NO es un turno de agente (no pasa por MA). */
  async function generateChatTitle(
    userMsg: string,
    agentMsg: string,
    prev?: string,
  ): Promise<string | undefined> {
    const { system, user } = buildTitlePrompt(userMsg, agentMsg, prev);
    const resp = await client.messages.create({
      model: TITLE_MODEL,
      max_tokens: 24,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = resp.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return sanitizeTitle(text, prev);
  }

  function makeSink(ctx: UserCtx): Sink {
    return {
      message: (t: string) => {
        // Gate de egress (Fase 8): los crons 'never' corren en silencio (sólo log).
        if (ctx.turnEgress === "never") {
          console.log(dim(`→ [${ctx.user.id}] (cron silencioso) ${t.length} chars`));
          return;
        }
        // Coreografía de delegación: el anuncio del turno ya salió (el del modelo o el fallback) y
        // el turno ya se cerró para el usuario → cualquier texto POSTERIOR del coordinador en este
        // mismo turno (su confirmación lenta, divagues) se DESCARTA. Sólo logueamos.
        if (ctx.spawnAnnounce?.state === "done") {
          console.log(dim(`→ [${ctx.user.id}] (post-anuncio suprimido) ${t.length} chars`));
          return;
        }
        console.log(dim(`→ [${ctx.user.id}] ${t.length} chars`));
        // Título del chat: acumulá la respuesta del agente del turno interactivo (titleAgentParts
        // sólo existe en esos turnos) para resumir el tema al cerrar.
        ctx.titleAgentParts?.push(t);
        // Coreografía de delegación: hubo spawns en este turno y el anuncio estaba pendiente →
        // ESTE mensaje ES el anuncio del modelo (su voz). Se postea por el path normal (emitReply:
        // respeta [[voice]]/[[text]]) y RECIÉN DESPUÉS se cierra el turno para el usuario
        // (turn-done) + se re-afirma el conteo de sub-agentes (invariante del frame `subagents`:
        // el absoluto fresco post-turn-done mantiene los mini-orbs de los workers vivos).
        const sa = ctx.spawnAnnounce;
        if (sa?.state === "pending") {
          if (sa.timer) clearTimeout(sa.timer);
          sa.timer = undefined;
          sa.state = "done"; // lo que el coordinador diga después de su anuncio se traga
          ctx.egressTail = (ctx.egressTail ?? Promise.resolve())
            .then(() => emitReply(ctx, t))
            .then(() => {
              void ctx.lastThread?.turnDone?.();
              emitSubagents(ctx);
            })
            .catch(() => {});
          return;
        }
        // Serializa las salidas: la síntesis TTS es async; sin la cadena, dos bloques
        // agent.message podrían postearse fuera de orden.
        ctx.egressTail = (ctx.egressTail ?? Promise.resolve()).then(() => emitReply(ctx, t)).catch(() => {});
      },
      activity: (name, input) => {
        // Traza de progreso: cada tool-call / sub-agente del turno (para ver dónde se va el
        // tiempo). El stream emite el nombre crudo en `name` y los args en `input`.
        console.log(dim(`· [${ctx.user.id}] ${name}`));
        // (El refresh de la vista web tras una escritura ya NO sale de acá: el agente escribe
        //  por el substrato /api/sync, que registra el change feed, y el web server lo tailea y
        //  refresca las vistas — Fase 3a. Las vistas se suscriben al substrato, no a tool-calls.)
        if (ctx.turnEgress === "never") return; // sin typing/actividad para crons de fondo
        void ctx.lastThread?.startTyping();
        // Modo debug (Pieza A): humanizamos el label crudo y se lo pasamos al canal. Lo partimos
        // en `label` (verbo amable, SIN params) y `detail` (resumen de params, opcional): el hint
        // always-on bajo el orb usa SÓLO el label (no filtra el comando crudo con debug off); las
        // superficies de debug (log de la web, Telegram con `/debug on`) usan label + detail. El
        // canal remoto emite el frame `activity` SIEMPRE; Telegram sólo postea si hay `/debug on`.
        // El humanizado se hace acá (server-side) → el frame viaja con texto listo para pintar.
        const { label, detail } = activityLabel(name, input);
        void ctx.lastThread?.activity?.(label, { debug: getUserDebug(db, ctx.user.id), detail });
      },
      // Conteo de sub-agentes vivos del agente (archima: tool-calls `task` en `running`; MA:
      // threads del roster). Lo pasamos al canal → frame `subagents` → la web dibuja N mini-orbs
      // decorando el orb. En crons de fondo ('never') no hay vista que decorar → no-op.
      subagents: (count) => {
        if (ctx.turnEgress === "never") return;
        // Guardamos el conteo del backend y emitimos COMBINADO con los workers async vivos (las dos
        // fuentes alimentan el MISMO frame absoluto → sin pisarse). Ver emitSubagents.
        ctx.taskSubagents = count;
        emitSubagents(ctx);
      },
      status: (s: string) => {
        console.log(dim(`[${ctx.user.id}] ${s}`));
      },
      // Error de la API/MA que falló el turno (límite de uso, billing, modelo caído tras agotar
      // reintentos): a diferencia de `status` (log-only), esto el USUARIO lo tiene que ver. Lo
      // posteamos a su canal — encadenado en egressTail para no pisar el orden del egress — y lo
      // logueamos con console.error (no `dim`) como backstop para que el owner lo vea en los logs
      // apenas pasa. El turno se cierra solo con el status_idle (retries_exhausted) que sigue.
      error: (text: string) => {
        console.error(`[ceibo][API-ERROR][user=${ctx.user.id}] ${text.replace(/\n/g, " ")}`);
        const thread = ctx.lastThread;
        if (!thread) return;
        // Gate de egress: en un cron de fondo ('never') no posteamos al usuario, pero el
        // console.error de arriba igual deja rastro para el owner.
        if (ctx.turnEgress === "never") return;
        ctx.egressTail = (ctx.egressTail ?? Promise.resolve())
          .then(() => thread.post(text))
          .catch((e) =>
            console.log(dim(`[api-error post] user=${ctx.user.id}: ${(e as Error)?.message ?? e}`)),
          );
      },
      // Aviso de SISTEMA neutro (compactación / clear): el usuario lo tiene que ver, pero NO es voz
      // del agente (`message`) ni un error (`error`). Lo encadenamos en egressTail para no pisar el
      // orden del egress. Canal remoto (web) → frame `notice` (línea de sistema atenuada); los
      // canales texto-nativos (telegram/cli/whatsapp) no implementan `notice` → caemos a `post` con
      // un prefijo. Gate de egress: en un cron de fondo ('never') no se postea al usuario.
      notice: (text: string) => {
        console.log(dim(`ℹ [${ctx.user.id}] ${text}`));
        // Telemetría para `/status`: este path del Sink lo dispara SÓLO la compactación (auto o
        // `/compact`) vía `session.compacted` del relay — el clear diario (F3) postea su aviso por
        // otra vía. Registramos el instante de la última compactación.
        ctx.lastCompactedAt = Date.now();
        if (ctx.turnEgress === "never") return;
        const thread = ctx.lastThread;
        if (!thread) return;
        ctx.egressTail = (ctx.egressTail ?? Promise.resolve())
          .then(() => (thread.notice ? thread.notice(text) : thread.post(`ℹ️ ${text}`)))
          .catch((e) => console.log(dim(`[notice post] user=${ctx.user.id}: ${(e as Error)?.message ?? e}`)));
      },
      // El relay se murió sin remedio (sesión MA terminada server-side). Soltamos el relay
      // muerto y liberamos el ctx: el próximo mensaje del usuario lo rearma vía ensureRelay
      // (reuseOrCreate recrea la sesión si la vieja terminó). Evita la sesión zombie que antes
      // obligaba a un /new manual.
      dead: () => {
        console.log(dim(`[${ctx.user.id}] relay caído → recreo en el próximo mensaje`));
        // close() además de soltar: ABORTA el stream SSE del pump (backend local) → no queda un
        // pump zombie escuchando el bus con este sink (bug E).
        ctx.relay?.close();
        ctx.relay = undefined;
        ctx.busy = false;
        // El turno murió con spawns sin anunciar → línea mínima anti-silencio (el usuario tiene
        // que saber que los sub-agentes quedaron trabajando) y limpieza del estado.
        flushPendingAnnounce(ctx);
        clearSpawnAnnounce(ctx);
        ctx.turnEgress = "always";
        // El turno murió sin cerrar (no hay end_turn): descartamos el cursor → no resumimos.
        ctx.wikiTurnStartId = undefined;
        // Idem el título: el turno no cerró → descartamos lo capturado, no titulamos.
        ctx.titleUserMsg = undefined;
        ctx.titleAgentParts = undefined;
        // El relay murió liberando el ctx → si hay resultados de workers encolados, intentá
        // drenarlos (injectToCoordinator rearma el relay vía ensureRelay).
        void drainPending(ctx);
      },
      // Fin de turno: usage acumulado → delta → ledger. Libera el ctx y vuelve al egress
      // interactivo por default (el próximo turno postea, salvo que un cron diga lo contrario).
      turnComplete: (usage, model, timing) => {
        ctx.busy = false;
        // Telemetría para `/status`: cacheamos el usage ACUMULADO de la sesión y el modelo de este
        // turno (best-effort; no se persiste). `usage.input` ≈ tamaño del contexto re-prefileado.
        ctx.lastUsage = usage;
        if (model) ctx.lastUsageModel = model;
        // Anti-silencio: el coordinador cerró el turno sin redactar su anuncio de spawn (terminó
        // con la tool-call y cero texto) → línea mínima del gateway ANTES de cerrar. Después se
        // limpia el estado: el turno cerró de verdad. El turnDone de abajo es un duplicado inocuo
        // si el anuncio ya lo emitió (la web es idempotente: re-cierra el indicador efímero).
        flushPendingAnnounce(ctx);
        clearSpawnAnnounce(ctx);
        ctx.turnEgress = "always";
        // Fin del turno REAL → señal limpia a la vista que preguntó para cerrar el indicador
        // efímero de actividad del chat y apagar el indicador persistente de sub-agente (no antes:
        // un `agent.message` intermedio NO cierra el turno). El canal remoto (web) lo emite como
        // frame `turn-done`; telegram/cli no lo implementan.
        void ctx.lastThread?.turnDone?.();
        // El turno cerró → re-afirmamos el conteo combinado DESPUÉS de turn-done (INVARIANTE que la
        // web asume: el frame `subagents` es la única fuente de verdad; ella ya no resetea en
        // turn-done → tras cada turno llega este absoluto fresco). Quién es la verdad del conteo
        // del backend depende del backend:
        //  • MA: los sub-agentes `task` MUEREN con el turno y MA no garantiza emitir el 0 final
        //    (conteo best-effort) → lo forzamos a 0 acá como red de seguridad.
        //  • LOCAL (archima): un `task(background:true)` SOBREVIVE al turno (corre en el scope de la
        //    instancia opencode y avisa al terminar). El backend ES la verdad y YA emitió el conteo
        //    correcto (persiste el background, converge a 0 vía el prompt sintético de resultado) →
        //    NO lo pisamos. Los bloqueantes locales ya emitieron su 0 en `session.idle`, antes de acá.
        if (ctx.user.backend_mode !== "local") ctx.taskSubagents = 0;
        emitSubagents(ctx);
        // Resumen de cambios de wiki del turno (sólo turnos interactivos que tocaron la wiki):
        // leemos los cambios source='agent' de ESTE usuario con id > el cursor capturado al
        // arrancar el turno, y posteamos un resumen en la voz del agente DESPUÉS de su respuesta.
        postTurnSummary(ctx);
        // Título del chat: tras un turno interactivo con sustancia, generá (best-effort, async)
        // un título corto del tema actual y emitilo como frame `chat-title`. NO bloquea el cierre.
        maybeUpdateChatTitle(ctx);
        // Sub-agentes async: el coordinador quedó libre (busy=false) → si hay resultados de workers
        // encolados (llegaron mientras estaba en este turno), disparamos el siguiente como turno
        // sintético. Serializado: cada inyección es un turno y al cerrar drena el próximo.
        void drainPending(ctx);
        if (!ctx.sessionId) return;
        const turn = recordTurn(db, ctx.user.id, ctx.sessionId, model, usage);
        if (turn) {
          console.log(
            dim(
              `$ [${ctx.user.id}] in:${turn.input} out:${turn.output} ` +
                `cache:${turn.cache5m + turn.cache1h}/${turn.cacheRead} model:${model} ` +
                `${fmtTurnTiming(timing)}→ $${turn.costUsd.toFixed(4)}`,
            ),
          );
        }
      },
    };
  }

  // Atacha (o reusa) la sesión MA del usuario. No resetea el snapshot de metering
  // salvo que la sesión sea genuinamente nueva. DEDUP en vuelo (bug E): dos llamadas
  // concurrentes comparten LA MISMA apertura — sin esto, ambas pasaban el `if (ctx.relay)`,
  // ambas attacheaban, y el pump perdedor quedaba vivo duplicando todos los frames del canal.
  async function ensureRelay(ctx: UserCtx): Promise<void> {
    if (ctx.relay) return;
    if (!ctx.relayOpening) {
      ctx.relayOpening = openRelay(ctx).finally(() => {
        ctx.relayOpening = undefined;
      });
    }
    return ctx.relayOpening;
  }

  async function openRelay(ctx: UserCtx): Promise<void> {
    const stored = getSession(db, ctx.user.id);
    const title = `ceibo · ${ctx.user.handle}`;
    // Sub-timing del revival (quickboot): `prep` = prepareSession (mint de creds del vault, AV CLI
    // por ssh), `reuse` = reuseOrCreate (state+wiki+serve). Pinpoint del `open` no atribuido.
    const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    const tPrep = Date.now();
    const prepared = await prepareSession(ctx.user, ctx.originChannel);
    const prepMs = Date.now() - tPrep;
    const userCfg: SessionConfig = {
      ...cfg,
      agentId: agentIdForUser(ctx.user),
      localModel: localCoordinatorModelForUser(ctx.user),
      ...prepared,
    };
    const tReuse = Date.now();
    const sid = await backendForUser(ctx.user).reuseOrCreate(userCfg, title, stored?.session_id);
    console.log(dim(`⏱ openRelay[${ctx.user.id}] prep:${s(prepMs)} reuse:${s(Date.now() - tReuse)}`));
    // Re-chequeo post-await: si otro path (recreateSession) armó un relay mientras esperábamos,
    // NO attacheamos un segundo pump sobre el mismo canal.
    if (ctx.relay) return;
    if (sid !== stored?.session_id) setSession(db, ctx.user.id, sid); // sesión nueva → snapshot 0
    ctx.sessionId = sid;
    ctx.relay = backendForUser(ctx.user).attach(sid, makeSink(ctx));
    console.log(dim(`sesión [${ctx.user.id}]: ${sid} (${sessionFingerprint(sid)})`));
  }

  // Crea una sesión MA fresca para el usuario y la deja atachada (reemplaza la viva). La usa
  // /new y /wiki set (cambiar el set de wikis montadas exige recrear la sesión: los mounts son
  // fijos al crearla). Resetea el snapshot de metering (sesión nueva = acumulado 0).
  async function recreateSession(ctx: UserCtx): Promise<string> {
    // Si hay una apertura de relay en vuelo, esperala ANTES de reemplazar: si no, el attach viejo
    // podía completarse después y pisar el relay fresco dejando un pump huérfano (bug E).
    await ctx.relayOpening?.catch(() => {});
    // ATÓMICO respecto del relay: construimos la sesión nueva y su relay ANTES de cerrar el viejo.
    // Si createSession tira (típico: backend/VM unreachable durante un reboot o inestabilidad de
    // red), el relay viejo sigue VIVO y la sesión queda como estaba; el error se propaga al caller
    // (que muestra la frase amable) sin haber roto nada. El bug original era el inverso: cerrábamos
    // el relay viejo PRIMERO y, si createSession tiraba, nunca armábamos el nuevo → sesión "muda"
    // (el modelo podía generar pero el gateway no entregaba nada y ctx.relay apuntaba a un relay
    // cerrado) hasta forzar otro /new con la red estable.
    const title = `ceibo · ${ctx.user.handle}`;
    const sid = await backendForUser(ctx.user).createSession(
      {
        ...cfg,
        agentId: agentIdForUser(ctx.user),
        localModel: localCoordinatorModelForUser(ctx.user),
        ...(await prepareSession(ctx.user, ctx.originChannel)),
      },
      title,
    );
    const newRelay = backendForUser(ctx.user).attach(sid, makeSink(ctx));
    // Swap: recién acá cerramos el relay viejo (aborta su pump SSE → cero zombie, bug E) y apuntamos
    // ctx al nuevo. close() del viejo va inmediatamente antes del overwrite para no dejar dos pumps
    // entregando al mismo sink. Si una apertura concurrente (ensureRelay) armó un relay durante
    // nuestro await de createSession, lo cerramos acá también — recreateSession descarta la sesión
    // viva por diseño, así que reemplazar lo que haya es la semántica esperada.
    ctx.relay?.close();
    ctx.relay = newRelay;
    setSession(db, ctx.user.id, sid);
    ctx.sessionId = sid;
    // El sid completo queda acá (log del owner); al usuario sólo le llega el fingerprint.
    console.log(dim(`sesión [${ctx.user.id}]: ${sid} (recreada ${sessionFingerprint(sid)})`));
    ctx.appliedProfilesKey = undefined; // sesión fresca: re-montar los perfiles extra
    await applyProfileServers(ctx).catch((e) => console.log(dim(`[perfiles] ${(e as Error)?.message ?? e}`)));
    return sid;
  }

  // Resuelve qué perfil tratar como "default" del usuario para el montaje de servers.
  // Orden: (1) el seteado por el user con /profile default; (2) si tiene UN único perfil
  // distintivo en sus grants, usarlo (auto-pick: cubre el caso típico de un user con sólo
  // "personal"); (3) fallback al literal "default" (legacy / sin grants). Sin esto, un user
  // con grants "personal"/"work" y sin /profile default seteado terminaba buscando un grant
  // llamado "default" que no existe → el agente no veía ninguno como principal.
  function resolveDefaultProfile(user: User): string {
    const grantProfiles = listGrantsForUser(db, user.id).map((g) => g.profile);
    return pickDefaultProfile(user.default_profile, grantProfiles, DEFAULT_PROFILE);
  }

  // Multi-cuenta (Fase 7): aplica al agente la config de servers que corresponde al usuario.
  // Si el default es un perfil con nombre (ej. "personal"), el server base de ese servicio
  // se overridea con la URL del grant (con `?profile=personal`) — sin esto el vault buscaba
  // la credencial bajo la URL pelada y no había. Los perfiles EXTRA (no-default) se montan
  // como servers adicionales (`gmail_work`, etc). Vía session.update (override per-sesión).
  // Barato: sólo le pega a la API si la firma del config (default + extras) cambió.
  // Idempotente y lazy: un /connect nuevo se monta en el próximo mensaje del usuario; un
  // restart re-aplica una vez.
  async function applyProfileServers(ctx: UserCtx): Promise<void> {
    if (!ctx.sessionId) return;
    const userDefaultProfile = resolveDefaultProfile(ctx.user);
    const allGrants = listGrantsForUser(db, ctx.user.id);
    // Default con nombre: el server base apunta a esa URL (no la pelada del env).
    const defaultUrlOverrides: Record<string, string> = {};
    if (userDefaultProfile !== DEFAULT_PROFILE) {
      for (const g of allGrants) {
        if (g.profile === userDefaultProfile) defaultUrlOverrides[g.service] = g.mcp_url;
      }
    }
    // Skip grants con profile = DEFAULT_PROFILE (= "default"): su server name resuelto
    // sería el del servicio pelado (ej. "notion") y chocaría con el base. El grant
    // legacy sigue accesible vía el server base (URL pelada matchea en el vault).
    // Importante cuando el user setea default a un perfil con nombre (ej. "personal")
    // pero tiene grants viejos sin perfil para otros servicios.
    const extra = allGrants
      .filter((g) => g.profile !== userDefaultProfile && g.profile !== DEFAULT_PROFILE)
      .map((g) => ({ name: serverNameForProfile(g.service, g.profile), url: g.mcp_url }));
    // Búsqueda web (Tavily) — SOLO para archima (backend local), gateado por env. Ver
    // `webSearchExtraServers`: monta el MCP HOSTED de Tavily como server remoto extra; el AV
    // (MITM proxy de la VM) allowlistea el host e inyecta el Bearer por-host (modelo idéntico a
    // gmail), así la VM nunca ve la key. La key NUNCA toca este código (modelo b: vive en gpuhost).
    extra.push(...webSearchExtraServers(env, ctx.user));
    // La key cache incluye el default profile y las URLs override, no solo los nombres extra.
    const extraKey = extra
      .map((e) => e.name)
      .sort()
      .join(",");
    const overrideKey = Object.entries(defaultUrlOverrides)
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    const key = `default=${userDefaultProfile}|over=${overrideKey}|extra=${extraKey}`;
    if (key === (ctx.appliedProfilesKey ?? "")) {
      ctx.appliedProfilesKey = key; // confirma en el primer chequeo sin pegarle a la API
      return; // fast-path warm: NO toca mcpPending (queda false → sin tag)
    }
    // Va a reconciliar de verdad (cold-open o cambió el set): marcamos pending SÍNCRONO (antes del
    // await) → el tag del turno avisa que las tools se están conectando. Corre en background.
    ctx.mcpPending = true;
    // Reemplazo TOTAL: base (github + servicios self-hosted) + extras. El default override
    // hace que el server base del servicio con perfil con nombre apunte a la URL correcta.
    // En dev no corre la flota de MCPs base self-hosted (gmail/calendar/…); saltearlos en
    // vez de tirar deja que igual se monte el control MCP (connect/comandos). Prod/staging
    // mantienen el throw (guardrail contra misconfig). Ver buildAgentMcpConfig.skipMissing.
    const agentCfg = buildAgentMcpConfig({
      env,
      extraServers: extra,
      defaultUrlOverrides,
      skipMissing: ceiboEnv() === "dev",
    });
    await backendForUser(ctx.user).setSessionAgentConfig(ctx.sessionId, agentCfg);
    ctx.appliedProfilesKey = key;
    ctx.mcpPending = false; // tools conectadas → el próximo turno ya no avisa
    console.log(
      dim(
        `perfiles [${ctx.user.id}]: default="${userDefaultProfile}" extra=[${extraKey || "ninguno"}] → session.update`,
      ),
    );
  }

  // Núcleo de manejo de un mensaje entrante, compartido por TODOS los canales
  // (telegram, cli, …). La identidad (canal + external_id) resuelve a un usuario
  // del allowlist; `thread` es el destino de respuesta (PostTarget) de ese canal.
  async function handleIncoming(
    channel: ChannelPolicy,
    externalId: string,
    text: string,
    thread: PostTarget,
    extras?: { audio?: InboundAudio; media?: InboundMedia[]; facts?: TurnFact[] },
  ): Promise<void> {
    const audio = extras?.audio;
    const media = extras?.media;
    const facts = extras?.facts ?? [];
    // Allowlist + router: la identidad de canal tiene que resolver a un usuario activo.
    const user = resolveUser(db, channel.name, externalId);
    if (!user) {
      console.log(dim(`ignorado: ${channel.name}:${externalId} (no autorizado)`));
      return;
    }

    let ctx = ctxByUser.get(user.id);
    if (!ctx) {
      ctx = { user };
      ctxByUser.set(user.id, ctx);
    }
    ctx.lastThread = thread;
    // Canal de origen (feature crons-delivery): lo recordamos para mintear el token de schedule con
    // este canal en prepareSession → un cron creado en esta sesión se entrega ACÁ. Se fija en la 1ª
    // apertura de la sesión (la cred del schedule es estática del vault, una por sesión): si la
    // sesión ya está abierta, prepareSession no se re-llama, así que el canal efectivo es el de
    // apertura (limitación v1 documentada).
    ctx.originChannel = channel.name;

    // Turno nuevo legítimo → limpiamos un `cancelRequested` viejo (de un cancel anterior) ANTES de
    // arrancar la prep (STT → tags → relay.send). Va acá, al tope, no en beginTurn: un `/stop`
    // corre CONCURRENTE con la prep de ESTE turno (el usuario tapea mientras transcribimos), así que
    // el reset tiene que pasar ANTES de esa ventana — si reseteáramos después (ej. en beginTurn, tras
    // el STT), pisaríamos el flag que ese `/stop` acaba de prender y el turno se despacharía igual.
    // El propio mensaje `/stop` también pasa por acá: resetea, pero runCommand lo vuelve a prender
    // (el set gana) y nunca llega al dispatch. Los sends internos (workers/crons) no entran por acá.
    ctx.cancelRequested = false;

    // Voz entrante (Fase 10 · STT). Si llegó audio sin texto, lo transcribimos: el agente
    // sólo ve texto (MA no tiene audio) y NUNCA le mandamos texto vacío (de ahí venía el
    // 400). Echamos lo entendido para que el usuario pueda corregir. `inboundVoice` se le
    // informa al agente (tag) para que pueda espejar — la decisión de responder en voz es
    // del agente, no del bridge.
    let msgText = text;
    let inboundVoice = false;
    if (audio && !text.trim()) {
      if (!speechEnabled()) {
        await thread.post("Recibí un audio, pero la transcripción no está configurada en este gateway.");
        return;
      }
      void thread.startTyping();
      try {
        const bytes = await audio.fetchData();
        console.log(dim(`[stt] user=${user.id} ${channel.name} mime=${audio.mime ?? "?"} ${bytes.length}B`));
        // Nudge del STT al idioma del usuario (en vez de autodetect ciego: con audio
        // corto/ruidoso whisper a veces autodetecta árabe/japonés). lang inválido → undefined
        // (autodetect), no rompe.
        const hint = isValidLang(user.lang) ? user.lang : undefined;
        const { text: transcript, reason } = await transcribeDetailed(bytes, audio.mime, hint);
        if (!transcript) {
          // Audio inválido. Distinguimos: tap accidental / silencio total (el guard de @ceibo/speech
          // lo detectó ANTES de transcribir) → lo IGNORAMOS sin postear nada (no merece respuesta).
          // Habla no entendida (hubo sonido pero el STT no dio texto útil) → avisamos para que repita.
          if (reason === "silent" || reason === "tooShort") {
            console.log(dim(`[stt] user=${user.id} audio ignorado (${reason})`));
            // Ya arrancamos startTyping() arriba (el orb se puso "pensando" mientras transcribíamos).
            // Como acá no posteamos nada (ignoramos el audio inválido), hay que cerrar el turno
            // explícito o el orb queda trabado en "pensando": emitimos turnDone (= fin de turno, sin
            // respuesta). Channel-safe: telegram/wa/cli no lo implementan (no-op).
            await thread.turnDone?.();
            return;
          }
          await thread.post("No te entendí el audio (no detecté habla). ¿Lo repetís o me escribís?");
          return;
        }
        msgText = transcript;
        inboundVoice = true;
        // Eco de lo transcrito para que el usuario corrija. El web lo recibe estructurado
        // (`postHeard` → evento `heard`, se muestra como la "pregunta" arriba de la respuesta);
        // telegram/cli, texto-nativos, lo reciben como texto si su política lo pide.
        if (thread.postHeard) await thread.postHeard(transcript);
        else if (channel.echoTranscript) await thread.post(`🎤 «${transcript}»`);
      } catch (e) {
        // El detalle (URL/errno del servicio de STT) va al log, NO al canal del usuario.
        console.error(`[stt] user=${user.id} transcripción falló: ${(e as Error)?.message ?? e}`);
        await thread.post("No pude transcribir el audio. Probá de nuevo en un momento.");
        return;
      }
    } else if (audio) {
      // Audio + TEXTO en el mismo turno: el caso reply-to-transcribe de Telegram (reply a una
      // nota de voz vieja + "transcribí esto") o un archivo de audio con caption. Antes este
      // caso DROPEABA el audio en silencio (la rama de arriba pide texto vacío) y el agente
      // confabulaba ("¿es un audio de WhatsApp?"). Lo transcribimos y va al agente JUNTO al
      // texto del usuario, marcado como cita. `inboundVoice` queda false: el usuario tipeó.
      if (!speechEnabled()) {
        await thread.post("Recibí un audio, pero la transcripción no está configurada en este gateway.");
        return;
      }
      void thread.startTyping();
      try {
        const bytes = await audio.fetchData();
        console.log(
          dim(
            `[stt] user=${user.id} ${channel.name} (audio citado) mime=${audio.mime ?? "?"} ${bytes.length}B`,
          ),
        );
        const hint = isValidLang(user.lang) ? user.lang : undefined;
        const { text: transcript } = await transcribeDetailed(bytes, audio.mime, hint);
        if (!transcript) {
          // Acá el usuario PIDIÓ algo sobre el audio (hay texto) → un fallo merece respuesta
          // directa, no un turno donde el agente improvise sin el audio.
          await thread.post("No encontré habla en ese audio (no pude transcribirlo).");
          return;
        }
        msgText = `${text}\n\n[transcripción del audio citado]:\n«${transcript}»`;
      } catch (e) {
        console.error(`[stt] user=${user.id} transcripción falló: ${(e as Error)?.message ?? e}`);
        await thread.post("No pude transcribir el audio. Probá de nuevo en un momento.");
        return;
      }
    }

    const line = msgText.trim();
    console.log(dim(`← [${user.id}/${channel.name}] ${line.slice(0, 100)}`));

    // Los comandos (`/new`, `/model`, `/wiki set`, …) recrean la sesión, lo que puede tirar un
    // error del backend (ej. cold-start de la VM en local). Sin este try el throw escapaba de
    // handleIncoming (que sólo envuelve el turno normal) y caía en el `.catch()` del canal, que
    // mandaba el `.message` CRUDO al browser (con env id, "cold-start", "intentos", "fetch
    // failed"). Lo capturamos acá: el crudo va al LOG; al usuario, la frase amable de
    // apiErrorMessage (que para 'local' nunca adjunta el detalle). runCommand cubre handleModel/
    // handleWiki (los invoca adentro), así que NINGÚN comando puede escapar sin pasar por acá.
    try {
      if (await runCommand(ctx, line, thread)) return;
    } catch (e) {
      console.error(`[ceibo][comando][user=${user.id}] ${(e as Error)?.message ?? e}`);
      await thread.post(apiErrorMessage(e, undefined, errorOriginForUser(user)));
      return;
    }

    // Nada que mandar (mensaje vacío sin adjunto) → no le mandamos un turno vacío al agente
    // (MA devolvería 400). Pasa si el mensaje era sólo un comando que ya respondimos, o vacío.
    if (!line && !media?.length) return;

    // Refresh lazy: antes de pasarle el turno al agente, re-minteamos los tokens OAuth
    // de ESTE usuario que estén por vencer y los re-pusheamos a su vault (el agente
    // puede llamar un MCP en este mismo turno). Sólo usuarios activos, sólo lo que vence.
    // El refresh devuelve los grants que murieron (invalid_grant) EN ESTA corrida, sólo la 1ª vez
    // (anti-spam via broken_at). `ctx.lastThread` ya está fijado arriba, así que postToUser entrega.
    const broken = await refreshGrantsForUser({
      db,
      backend: backendForUser(user),
      userId: user.id,
      env,
    }).catch((e) => {
      console.log(dim(`[refresh] user=${user.id}: ${(e as Error)?.message ?? e}`));
      return [] as OauthGrant[];
    });
    await notifyBrokenGrants(user, broken);

    // Crear/atachar la sesión puede tirar un error HTTP del SDK (ej. 400). Sin este try el
    // throw burbujeaba arriba y el turno moría mudo → surfaceamos un mensaje limpio y cortamos.
    // `tOpenStart` mide el costo de apertura (ensureRelay = serve+sesión, y abajo applyProfiles =
    // MCP reconcile): se loguea sólo en cold session-open (>500ms). Ver quickboot/mediciones.md §5.
    const tOpenStart = Date.now();
    try {
      await ensureRelay(ctx);
    } catch (e) {
      // El error crudo (con la interna: VM, env id, cp.sh, stdout) queda en el LOG; el usuario
      // recibe la frase limpia de apiErrorMessage (que para 'local' nunca adjunta el detalle).
      console.error(`[ceibo][backend][user=${user.id}] ensureRelay falló: ${(e as Error)?.message ?? e}`);
      await thread.post(apiErrorMessage(e, undefined, errorOriginForUser(user)));
      return;
    }
    const tRelayReady = Date.now();
    // MCP reconcile FUERA del path crítico (quickboot): conectar los ~9 MCP tardaba ~2.5s y el
    // agente NO los necesita para RESPONDER (a diferencia del bind serve+sesión, que el prompt
    // asegura por su cuenta vía oc.prompt→bind). Lo corremos en background; si la consulta necesita
    // una tool todavía no conectada, el tag de abajo (ctx.mcpPending) le dice al agente que avise
    // "dame un segundo que conecto tus herramientas" en vez de fallar/inventar. MATIZ de UX: el 1er
    // turno de una sesión cold corre con las tools externas todavía conectándose (el resto del hilo
    // ya las tiene). `appliedProfilesKey` hace que en turnos warm esto sea no-op instantáneo.
    // applyProfileServers setea `ctx.mcpPending=true` en su prefijo SÍNCRONO sólo si va a reconciliar
    // de verdad (no en el fast-path warm) → el check del tag de abajo (síncrono) ve el valor correcto.
    ctx.mcpPending = false;
    void applyProfileServers(ctx).catch((e) =>
      console.log(dim(`[perfiles] user=${user.id}: ${(e as Error)?.message ?? e}`)),
    );
    // Desglose del session-open (quickboot): `open` = serve+sesión (ensureRelay). El MCP reconcile
    // ya no está en el path crítico (background) → sólo logueamos `open` cuando fue costoso (cold).
    const openMs = tRelayReady - tOpenStart;
    if (openMs > 500) {
      console.log(
        dim(`⏱ [${user.id}] open:${(openMs / 1000).toFixed(1)}s (cold session-open; mcp en background)`),
      );
    }
    void thread.startTyping();
    beginTurn(ctx, "always", { interactive: true }); // turno interactivo: el usuario lo mira → al cerrar, resumimos lo que el agente tocó en la wiki
    // Título del chat: capturamos el texto del usuario de ESTE turno y arrancamos a juntar la
    // respuesta del agente (en makeSink.message) → al cerrar, haiku resume el tema. Sólo acá
    // (turno interactivo): los crons/REM dejan estos campos en undefined → no se titula.
    ctx.titleUserMsg = line;
    ctx.titleAgentParts = [];
    // Tags que el bridge antepone al turno: voz entrante (Fase 10, para que el agente espeje
    // con [[voice]]) e idioma (Fase 15, sólo si != 'es'; el prompt responde en ese idioma).
    const tags: string[] = [];
    // Hora actual: ancla INEQUÍVOCA (ISO 8601 con offset) para que el agente resuelva tiempos
    // relativos ("en 1 minuto", "mañana 9am") y agende recordatorios (MCP schedule) en la hora
    // correcta. Sin esto, modelos locales (archima/Gemma) toman la hora del sistema (UTC) como si
    // fuera local y erran por el offset de la tz. Va PRIMERO y en TODOS los backends (a MA le es
    // redundante pero consistente). Misma tz que el MCP schedule (DEFAULT_TZ) para que coincidan.
    tags.push(currentTimeTag(new Date(), process.env.DEFAULT_TZ));
    // Nombre de pila del usuario: el agente se dirige a la persona por su nombre (ver core.md).
    // Solo si está seteado y difiere del handle (sino no aporta sobre el slug técnico).
    if (user.name && user.name !== user.handle) tags.push(`[usuario: ${user.name}]`);
    // Ubicación del usuario (perfil, opt-in): si la configuró, se la pasamos al agente para que
    // resuelva contexto local (clima, husos, "cerca mío", recomendaciones). Sólo si está seteada.
    if (user.location?.trim()) tags.push(`[ubicación: ${user.location.trim()}]`);
    // Facts que adjunta el canal (ej. web: [canal: web] y, si hay nota abierta,
    // [vista: <repo>/<path>]). Después el bridge agrega los suyos: voz entrante (Fase 10,
    // mirror → el agente pone [[voice]]) e idioma (Fase 15, sólo si != 'es').
    for (const f of facts) tags.push(`[${f.label}: ${f.value}]`);
    if (inboundVoice) tags.push(INBOUND_VOICE_TAG);
    // Fase 2c: el agente ya no monta las wikis (working copy local hidratada por wiki-sync) →
    // le pasamos la lista de sus wikis para que sepa cuál hidratar. La en foco (/wiki set) primero.
    if (wikis) {
      const names = listReposForUser(db, user.id).map((r) => r.name);
      if (names.length) {
        const active = getUserActiveWiki(db, user.id);
        const inFocus = active && names.includes(active) ? active : undefined;
        const ordered = inFocus ? [inFocus, ...names.filter((n) => n !== inFocus)] : names;
        tags.push(`[wikis: ${ordered.join(", ")}${inFocus ? ` (en foco: ${inFocus})` : ""}]`);
        // Wiki-sync desacoplado (quickboot): el reopen NO espera a que se sincronicen las wikis
        // (sacaba ~8s del cold-open). Mientras el sync corre en background, el agente puede
        // responder YA — pero sus wikis todavía no están listas para leer/editar. Le avisamos para
        // que, si la consulta toca una nota, lo diga ("dame un segundo que termino de sincronizar")
        // en vez de leer una copia vieja o inventar. Tag mutuamente excluyente con el de deriva.
        if (backendForUser(user).wikiSyncPending?.(ctx.sessionId ?? "")) {
          tags.push(
            "[tus wikis se están SINCRONIZANDO en background y todavía NO están listas para " +
              "leer, buscar ni editar. Si el usuario pide algo de una nota/wiki, avisale en una " +
              "frase que esperás unos segundos a que termine de sincronizar y NO inventes el " +
              "contenido; para todo lo demás respondé normal.]",
          );
        } else {
          // Deriva (Fase 2c): chequeamos TODAS las wikis que el agente sincronizó esta sesión
          // (las que tienen watermark = las únicas con copia local que puede estar vieja), NO sólo
          // la "en foco" — el usuario puede no tener ninguna en foco y el agente igual trabaja
          // sobre la del [vista]. Comparamos el watermark del user contra el HEAD que mantiene el
          // WATCHER ÚNICO (wiki_heads, web-server) — lectura local de la DB, sin pegarle a GitHub
          // por turno (el watcher ya lo polleó). Si el HEAD avanzó, la copia del agente está VIEJA
          // → ordenale refrescar ANTES de leer/editar. Auto-correctivo: cuando el agente pulle, el
          // sync sube el watermark al HEAD y la directiva desaparece; si la ignora, se re-inyecta.
          // null = el watcher todavía no observó esa wiki → no afirmamos deriva (fail-open).
          const drifted = listSyncWatermarks(db, user.id)
            .filter((w) => names.includes(w.repo))
            .filter((w) => {
              const head = getWikiHead(db, w.repo);
              return head !== null && head !== w.ref;
            })
            .map((w) => w.repo);
          if (drifted.length) {
            const lista = drifted.map((r) => `«${r}»`).join(", ");
            // Deriva: el cómo refrescar depende del backend — local/archima usa git nativo
            // (las wikis ya están cloneadas en ~/work/); MA usa el script de sync (sin git).
            const refreshHow =
              user.backend_mode === "local"
                ? `corriendo \`git -C ~/work/<wiki> pull\` para ${drifted.length > 1 ? "cada una" : "ella"}`
                : `CORRIENDO EL SCRIPT DE SYNC de tu entorno (verbo \`pull\`, o \`hydrate\` si ` +
                  `todavía no la bajaste en esta sesión). NUNCA uses git para esto (\`git pull\`/` +
                  `\`clone\`/\`fetch\`): el git nativo de este entorno se cuelga; el sync va SIEMPRE por el script`;
            tags.push(
              `[${drifted.length > 1 ? "estas wikis cambiaron" : "esta wiki cambió"} afuera (otra ` +
                `pestaña, tu editor o REM) desde tu última copia local: ${lista} → ANTES de leer, ` +
                `buscar o editar notas de ${drifted.length > 1 ? "ellas" : "ella"} traé la última ` +
                `versión ${refreshHow}]`,
            );
          }
        }
      }
    }
    // MCP en background (quickboot): si las tools externas todavía se están conectando tras un
    // cold-open, avisamos al agente para que difiera lo que las necesite en vez de fallar/inventar.
    if (ctx.mcpPending) {
      tags.push(
        "[tus herramientas externas (mail, calendario, drive, hojas, notas, recordatorios, " +
          "búsqueda web) todavía se están CONECTANDO y NO están disponibles este turno. Si el " +
          "usuario pide algo que las necesita, avisale en una frase corta que esperás unos segundos " +
          "a que terminen de conectarse y NO inventes el resultado; para todo lo demás respondé normal.]",
      );
    }
    const memoryTag = await relevantMemoryTagForTurn(user, line).catch((e) => {
      console.log(dim(`[memoria] user=${user.id}: ${(e as Error)?.message ?? e}`));
      return undefined;
    });
    if (memoryTag) tags.push(memoryTag);
    const lt = langTag(getUserLang(db, user.id));
    if (lt) tags.push(lt);
    const toAgent = tags.length ? `${tags.join("\n")}\n${line}` : line;
    // Cancelación de un turno ENCOLADO: un `/stop` (orb tap mientras "pensando") corrió concurrente
    // con la prep de ARRIBA (STT → tags) y prendió `cancelRequested`. El `relay.interrupt()` de ese
    // `/stop` fue no-op (todavía no despachamos) → acá, JUSTO antes de `relay.send`, abortamos: NO
    // mandamos el turno al agente y lo cerramos como un fin de turno limpio (soltamos `busy`, volvemos
    // al egress interactivo, descartamos el resumen/título capturados y avisamos `turn-done` al cliente
    // para que el orb no quede colgado en "pensando"). El `relay.interrupt()` ya cubrió el caso del
    // turno YA corriendo; esto cubre el de la ventana prep→send. El flag se rearma a false en el tope
    // de handleIncoming del próximo turno, así que un cancel no se arrastra al siguiente.
    if (ctx.cancelRequested) {
      ctx.cancelRequested = false;
      ctx.busy = false;
      ctx.turnEgress = "always";
      ctx.wikiTurnStartId = undefined;
      ctx.titleUserMsg = undefined;
      ctx.titleAgentParts = undefined;
      console.log(dim(`→ [${user.id}] turno cancelado en prep (/stop antes del despacho) → no se envía`));
      void thread.turnDone?.();
      return;
    }
    console.log(dim(`→ [${user.id}] tags=[${tags.join(" ")}]`));
    ctx.relay?.send(toAgent, media).catch((e) => {
      // El `send` enqueua el user.message; un throw acá es un error HTTP del SDK (ej. 400 al
      // mandar). Soltamos `busy` y surfaceamos un mensaje limpio/accionable (no el error crudo,
      // que queda en el log con toda la interna).
      ctx.busy = false;
      console.error(`[ceibo][backend][user=${user.id}] send falló: ${(e as Error)?.message ?? e}`);
      void thread.post(apiErrorMessage(e, undefined, errorOriginForUser(user)));
    });
  }

  // Dispatch de los comandos de usuario (slash-commands). Devuelve true si la línea era un
  // comando (ya respondido vía `thread`); false si no, y el caller la pasa al agente. Lo
  // comparten el path de canal (handleIncoming) y la tool MCP `ceibo_command`
  // (runCommandForUser) → una sola fuente de verdad de "qué hace cada comando".
  async function runCommand(ctx: UserCtx, line: string, thread: PostTarget): Promise<boolean> {
    const { user } = ctx;
    if (line === "/start") {
      await thread.post(
        `Hola ${user.name ?? user.handle}. Soy el gateway de ceibo. Escribime y se lo paso al agente.`,
      );
      return true;
    }
    if (line === "/session") {
      // El id REAL es interna (nombre de VM con env id en archima; sesn_… en MA) → mostramos un
      // fingerprint corto no reversible. Para soporte alcanza: el gateway loguea el mapeo
      // completo al abrir/recrear la sesión.
      await thread.post(
        ctx.sessionId ? `Sesión activa: ${sessionFingerprint(ctx.sessionId)}` : "(sin sesión todavía)",
      );
      return true;
    }
    if (line === "/web") {
      // Magic link a la UI web (managed-ui Fase A). Telegram ya es la raíz de identidad
      // → el link sólo la transfiere a una cookie. Un solo uso, vence en 5 min.
      const base = (env.WEB_BASE_URL ?? env.OAUTH_BASE_URL)?.replace(/\/+$/, "");
      if (!base || !env.WEB_SESSION_KEY) {
        await thread.post("La UI web no está configurada en este gateway.");
        return true;
      }
      const token = createWebLoginToken(db, user.id);
      await thread.post(
        `Tu link para entrar a la UI web (un solo uso, vence en 5 min):\n${base}/${user.handle}?t=${token}`,
      );
      return true;
    }
    if (line === "/voice" || line.startsWith("/voice ")) {
      await handleVoice(user, line.slice("/voice".length).trim(), thread);
      return true;
    }
    if (line === "/language" || line.startsWith("/language ")) {
      await handleLanguage(user, line.slice("/language".length).trim(), thread);
      return true;
    }
    if (line === "/model" || line.startsWith("/model ")) {
      await handleModel(ctx, line.slice("/model".length).trim(), thread);
      return true;
    }
    if (line === "/debug" || line.startsWith("/debug ")) {
      await handleDebug(ctx, line.slice("/debug".length).trim(), thread);
      return true;
    }
    if (line === "/wiki" || line.startsWith("/wiki ")) {
      await handleWiki(ctx, line.slice("/wiki".length).trim(), thread);
      return true;
    }
    if (line === "/agenda" || line.startsWith("/agenda ")) {
      await handleAgenda(user, line.slice("/agenda".length).trim(), thread);
      return true;
    }
    if (line === "/stop") {
      // Cubrimos los DOS estados posibles del turno a cancelar:
      //  • corriendo: `relay.interrupt()` aborta la generación en el backend.
      //  • ENCOLADO/en-prep (STT → tags, todavía sin `relay.send`): el interrupt es no-op (no hay
      //    nada que abortar) → marcamos `cancelRequested` para que el dispatch lo chequee justo
      //    antes de `relay.send` y NO despache el turno (ver beginTurn/relay.send).
      ctx.cancelRequested = true;
      await ctx.relay?.interrupt().catch((e) => {
        console.error(`[stop] user=${user.id} interrupt falló: ${e?.message ?? e}`);
        return thread.post("No pude interrumpir el turno. Probá de nuevo en un momento.");
      });
      return true;
    }
    if (line === "/new") {
      // OJO: el sid NO se muestra (es el nombre de la VM, con el env id adentro — interna).
      // Queda en el log de recreateSession; al usuario le alcanza la confirmación.
      await recreateSession(ctx);
      await thread.post("Listo, sesión nueva: arrancamos de cero.");
      return true;
    }
    if (line === "/compact") {
      await handleCompact(ctx, thread);
      return true;
    }
    if (line === "/status") {
      await handleStatus(ctx, thread);
      return true;
    }
    if (line === "/profile" || line.startsWith("/profile ")) {
      const arg = line.slice("/profile".length).trim();
      const [sub, ...restArr] = arg.split(/\s+/);
      const val = restArr.join(" ").trim();
      if (sub === "default") {
        // Sin argumento: mostrar el default actual.
        if (!val) {
          const current = user.default_profile;
          const resolved = resolveDefaultProfile(user);
          if (current) {
            await thread.post(
              `Perfil default: "${current}". Para cambiar: /profile default <nombre>. Para borrar: /profile default none.`,
            );
          } else if (resolved !== DEFAULT_PROFILE) {
            await thread.post(
              `Sin default seteado, pero auto-detecté "${resolved}" (es el único que tenés). Para fijarlo: /profile default ${resolved}.`,
            );
          } else {
            await thread.post("No tenés perfil default. /profile default <nombre> para setearlo.");
          }
          return true;
        }
        // Borrar el default explícitamente.
        if (val === "none" || val === "clear") {
          setDefaultProfile(db, user.id, null);
          user.default_profile = null;
          await thread.post("Quitado el perfil default.");
          if (ctx.relay) await applyProfileServers(ctx);
          return true;
        }
        const profile = sanitizeProfile(val);
        if (profile === DEFAULT_PROFILE) {
          await thread.post(`"${val}" no sirve como perfil default (reservado).`);
          return true;
        }
        // Validar que el perfil exista en algún grant del usuario (evita typos
        // que dejan default apuntando a un perfil fantasma).
        const grants = listGrantsForUser(db, user.id);
        const exists = grants.some((g) => g.profile === profile);
        if (!exists) {
          const available = [...new Set(grants.map((g) => g.profile))].filter((p) => p !== DEFAULT_PROFILE);
          await thread.post(
            available.length
              ? `"${profile}" no figura entre tus perfiles conectados (${available.join(", ")}).`
              : `"${profile}" no figura entre tus perfiles conectados.`,
          );
          return true;
        }
        setDefaultProfile(db, user.id, profile);
        user.default_profile = profile;
        await thread.post(`Listo, ahora el perfil default es "${profile}".`);
        // Si el usuario tiene sesión viva, hay que refrescar los perfiles montados.
        if (ctx.relay) await applyProfileServers(ctx);
        return true;
      }
      await thread.post("Uso: /profile default [<nombre>|none] (sin args muestra el actual).");
      return true;
    }
    if (line === "/connections") {
      // Agrupado por servicio: cada conexión activa con TODOS sus perfiles.
      const byService = new Map<string, string[]>();
      for (const c of listConnections(db, user.id)) {
        const arr = byService.get(c.service) ?? [];
        arr.push(c.profile);
        byService.set(c.service, arr);
      }
      const lines = [...byService.entries()].map(
        ([svc, profiles]) => `• ${svc}: ${profiles.sort().join(", ")}`,
      );
      const conectables = env.WACLI_MCP_URL ? [...SERVICE_NAMES, WHATSAPP_SERVICE] : SERVICE_NAMES;
      await thread.post(
        `Conectables: ${conectables.join(", ")}\n\n` +
          `Conectado:\n${lines.length ? lines.join("\n") : "  (nada todavía)"}\n\n` +
          `Conectar: /connect <servicio> <perfil> (ej. /connect gmail personal).\n` +
          `WhatsApp: /connect whatsapp <número con código de país>.`,
      );
      return true;
    }
    if (line === "/connect" || line.startsWith("/connect ")) {
      const rest = line.slice("/connect".length).trim();
      const [serviceRaw, profileRaw] = rest.split(/\s+/);
      // Servicio CASE-INSENSITIVE: `knownService` es `SERVICES[name]` (keys en minúscula). El
      // modelo chico (y a veces el usuario) escribe "Gmail" → knownService("Gmail")=undefined →
      // "No conozco" → el connect quedaba SIN URL → fallback → placeholder en el chat (#484, visto
      // en staging; dev pasaba "gmail" y andaba). Normalizamos a minúscula. El perfil NO se toca.
      const service = serviceRaw?.toLowerCase();

      // WhatsApp (Fase 9): NO es OAuth — es pairing por código vía wacli. El resto de la
      // línea (tras "whatsapp") es el número con código de país. El enrollment corre en
      // background: relaya el código y, al conectar, mintea el Bearer al vault.
      if (service === WHATSAPP_SERVICE || service === "wa") {
        if (!env.WACLI_MCP_URL || !env.WACLI_MCP_HMAC_KEY) {
          await thread.post("WhatsApp no está configurado en este gateway.");
          return true;
        }
        const phone = rest.slice(service.length).trim();
        if (!phone) {
          await thread.post("Pasame tu número con código de país, ej: /connect whatsapp +54 9 11 1234-5678");
          return true;
        }
        await thread.post(`Conectando WhatsApp (${phone})… en unos segundos te paso el código.`);
        // El enrollment es async: el pairing code y el resultado llegan DESPUÉS de que
        // runCommand retornó. Si el comando vino por el MCP `control` (runCommandForUser), el
        // `thread` es un buffer capturador ya descartado → posteamos a `ctx.lastThread` (el
        // thread real del turno vivo del usuario), con fallback a `thread` para el path de canal.
        const out = ctx.lastThread ?? thread;
        void enrollWhatsapp(user.id, phone, {
          onPairCode: (code) => {
            void out.post(
              `Tu código de vinculación: ${code}\n\n` +
                "En WhatsApp: Ajustes → Dispositivos vinculados → Vincular un dispositivo → " +
                '"Vincular con número de teléfono", e ingresá el código. (vence en unos minutos)',
            );
          },
          onConnected: () => {
            recordConnection(db, user.id, WHATSAPP_SERVICE);
            void ensureVault(user)
              .then((vaultId) => mintWacliBearer(user, vaultId))
              .catch((e) => console.log(dim(`[wacli] mint user=${user.id}: ${(e as Error)?.message ?? e}`)));
          },
        })
          .then((r) =>
            out.post(
              r.connected
                ? "WhatsApp conectado ✅ Ya puedo leer tus chats y contactos (solo lectura)."
                : `No se completó la conexión de WhatsApp: ${publicErrorReason(new Error(r.error ?? "cancelada"), "falló la conexión")}.`,
            ),
          )
          .catch((e) => {
            console.error(`[wacli] user=${user.id} connect falló: ${(e as Error)?.message ?? e}`);
            return out.post(
              `Error conectando WhatsApp: ${publicErrorReason(e, "no pude hablar con el servicio de WhatsApp")}. Probá de nuevo en un rato.`,
            );
          });
        return true;
      }

      // Identidad = el canal (este usuario). Sin <handle> → nadie conecta por otro.
      // Forma: /connect <servicio> <perfil>.  El perfil es OBLIGATORIO y explícito:
      // toda cuenta se nombra (no más "default" implícito). "default" queda reservado
      // para las conexiones legacy ya existentes; no se puede crear una nueva.
      if (!service) {
        await thread.post(
          `¿Qué querés conectar? Disponibles: ${SERVICE_NAMES.join(", ")}.\n` +
            `Forma: /connect <servicio> <perfil> (ej. /connect gmail personal).`,
        );
        return true;
      }
      if (!knownService(service)) {
        await thread.post(`No conozco "${service}". Disponibles: ${SERVICE_NAMES.join(", ")}`);
        return true;
      }
      if (!profileRaw) {
        await thread.post(
          `Te falta el perfil: cada cuenta se conecta con un nombre.\n` +
            `Ej: /connect ${service} personal  ·  /connect ${service} work`,
        );
        return true;
      }
      const profile = sanitizeProfile(profileRaw);
      if (profile === DEFAULT_PROFILE) {
        await thread.post(
          `"${profileRaw}" no sirve como perfil (vacío o reservado). Elegí un nombre, ej. personal o work.`,
        );
        return true;
      }
      const base = env.OAUTH_BASE_URL?.replace(/\/+$/, "");
      if (!base) {
        await thread.post("falta OAUTH_BASE_URL en la config del gateway");
        return true;
      }
      const token = createEnrollToken(db, user.id, service, profile);
      await thread.post(
        `Para conectar ${service} (perfil "${profile}"), abrí este link (vence en 30 min, un solo uso) y aprobá el acceso:\n${base}/oauth/start?t=${token}`,
      );
      return true;
    }
    if (line === "/disconnect" || line.startsWith("/disconnect ")) {
      // Forma: /disconnect <servicio> [perfil].  Sin perfil → el perfil default del usuario.
      const [service, profileRaw] = line.slice("/disconnect".length).trim().split(/\s+/);
      const userDefaultProfile = resolveDefaultProfile(user);

      // WhatsApp (Fase 9): logout de wacli + borrar el Bearer del vault + apagar el follow.
      if (service === WHATSAPP_SERVICE || service === "wa") {
        if (!whatsappConnected(user.id)) {
          await thread.post("No tenés WhatsApp conectado.");
          return true;
        }
        stopFollow(user.id);
        await logoutWhatsapp(user.id).catch(() => {});
        const waVault = vaultIdForUser(user);
        if (waVault && env.WACLI_MCP_URL) {
          await backendForUser(user)
            .revokeOauthCredential(waVault, env.WACLI_MCP_URL)
            .catch(() => {});
        }
        removeConnection(db, user.id, WHATSAPP_SERVICE);
        await thread.post("Desconectaste WhatsApp (cerré la sesión y borré la credencial de tu vault).");
        return true;
      }

      if (!service) {
        const connected = listConnections(db, user.id).map((c) =>
          c.profile === DEFAULT_PROFILE ? c.service : `${c.service}:${c.profile}`,
        );
        await thread.post(
          connected.length
            ? `¿Qué desconectar? Conectado: ${connected.join(", ")}. Ej: /disconnect gmail  ·  /disconnect gmail work`
            : "No tenés nada conectado.",
        );
        return true;
      }
      if (!knownService(service)) {
        await thread.post(`No conozco "${service}". Disponibles: ${SERVICE_NAMES.join(", ")}`);
        return true;
      }
      const svc = knownService(service);
      const profile = profileRaw ? sanitizeProfile(profileRaw) : userDefaultProfile;
      const label = profile === DEFAULT_PROFILE ? service : `${service} (perfil "${profile}")`;
      const grant = getOauthGrant(db, user.id, service, profile);
      const hasConn = listConnections(db, user.id).some(
        (c) => c.service === service && c.profile === profile,
      );
      // "Conectado" = hay grant del broker O marca de conexión. El default legacy de
      // Fase 4 (mcp_oauth, pre-broker) tiene connection pero NO grant → igual hay que
      // poder desconectarlo (revocar la cred del vault). La URL de la cred sale del
      // grant si existe, o se computa desde el env (perfil → ?profile=).
      if (!grant && !hasConn) {
        await thread.post(`No tenés ${label} conectado.`);
        return true;
      }
      const mcpUrl =
        grant?.mcp_url ?? (svc ? mcpUrlForProfile(env[svc.mcpUrlEnv] ?? "", profile) : undefined);
      try {
        const discVault = vaultIdForUser(user);
        if (discVault && mcpUrl) await backendForUser(user).revokeOauthCredential(discVault, mcpUrl);
        deleteOauthGrant(db, user.id, service, profile); // grant del broker (no-op si no había)
        removeConnection(db, user.id, service, profile); // saca la vista
        await thread.post(`Desconectaste ${label} (borré la credencial de tu vault).`);
      } catch (e) {
        console.error(`[disconnect] user=${user.id} ${label}: ${(e as Error)?.message ?? e}`);
        await thread.post(`No pude desconectar ${label}. Probá de nuevo en un momento.`);
      }
      return true;
    }
    return false;
  }

  // Corre un comando de usuario para `userId` desde fuera de un canal (la tool MCP
  // `ceibo_command`): el agente controla los mismos comandos que el usuario tipea. Captura la
  // salida del handler (los handlers postean, no devuelven) y la retorna para que el agente la
  // use/parafrasee. Si el comando recreó la sesión (/new, /model, /wiki set), el turno del
  // agente que llamó esta tool queda huérfano y su respuesta se pierde → posteamos la salida al
  // thread real out-of-band para que el usuario igual vea la confirmación.
  async function runCommandForUser(userId: number, command: string): Promise<string> {
    let ctx = ctxByUser.get(userId);
    if (!ctx) {
      const u = getUser(db, userId);
      if (!u) throw new Error(`usuario ${userId} desconocido`);
      ctx = { user: u };
      ctxByUser.set(userId, ctx);
    }
    const trimmed = command.trim();
    if (!trimmed) throw new Error("comando vacío");
    const line = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    // PostTarget capturador: junta lo que el handler postea (sin voz/typing) para devolverlo.
    const buf: string[] = [];
    const capture: PostTarget = {
      post: (text: string) => {
        buf.push(text);
        return Promise.resolve();
      },
      startTyping: () => Promise.resolve(),
    };
    const sidBefore = ctx.sessionId;
    const matched = await runCommand(ctx, line, capture);
    if (!matched) throw new Error(`comando desconocido: ${line.split(/\s+/)[0]}`);
    const out = buf.join("\n").trim();
    // Sesión recreada durante el comando → la respuesta del agente se pierde; avisamos directo.
    if (ctx.sessionId !== sidBefore && ctx.lastThread && out) void ctx.lastThread.post(out);
    return out || "ok";
  }

  // Postea un mensaje al chat REAL del usuario fuera de banda (sin pasar por el modelo). Lo usa
  // `connect_service` del MCP control para entregar el auth_url EXACTO: así el link de conexión
  // llega bien aunque el modelo chico no lo transcriba (escribe `[auth_url]`) o invente uno.
  // Devuelve true si había un thread vivo al que postear.
  async function postToUser(userId: number, text: string): Promise<boolean> {
    const ctx = ctxByUser.get(userId);
    // Observabilidad (#484): distinguir POR QUÉ no se entrega el link OOB. En staging el connect
    // cae al fallback (delivered=false) aunque el web stream esté vivo → necesitamos saber si es
    // falta de ctx, falta de lastThread, o que el .post() tira. dev no lo reproduce.
    if (!ctx) {
      console.warn(dim(`[postToUser] user=${userId}: sin ctx en ctxByUser → false`));
      return false;
    }
    if (!ctx.lastThread) {
      console.warn(dim(`[postToUser] user=${userId}: ctx sin lastThread → false`));
      return false;
    }
    try {
      await ctx.lastThread.post(text);
      return true;
    } catch (e) {
      console.warn(
        dim(`[postToUser] user=${userId}: lastThread.post() tiró: ${(e as Error)?.message ?? e} → false`),
      );
      return false;
    }
  }

  // Notifica al usuario que uno o más grants OAuth murieron (invalid_grant → refresh token
  // expirado; Google los vence ~cada 7 días en modo Testing). `refreshGrantsForUser` nos devuelve
  // los grants que están rotos y todavía SIN avisar (broken_at set, notified_at NULL). Entregamos la
  // notif como item DURABLE en el 🔔 (vía la dep `notifyGrantBroken`, que vive en el bootstrap con el
  // canal remoto) con el link de reconexión (mismo mecanismo que /connect: enroll token +
  // OAUTH_BASE_URL/oauth/start). SÓLO si la entrega fue confiable sellamos `notified_at` — si no,
  // el grant reaparece el próximo sweep (retry-hasta-entregar → sin "aviso perdido"). Anti-spam: una
  // vez sellado, `refreshGrantsForUser` ya no lo devuelve. Por grant (service+profile), multi-cuenta ok.
  async function notifyBrokenGrants(user: User, broken: OauthGrant[]): Promise<void> {
    if (broken.length === 0) return;
    const base = env.OAUTH_BASE_URL?.replace(/\/+$/, "");
    if (!base) {
      console.warn(dim(`[grant-death] user=${user.id}: falta OAUTH_BASE_URL → no puedo armar el link`));
      return; // sin link no entregamos ni sellamos → se reintenta cuando esté la config
    }
    if (!notifyGrantBroken) {
      console.warn(dim(`[grant-death] user=${user.id}: sin notifyGrantBroken (dev/tests) → no sello`));
      return; // sin canal de entrega → no sellar; reintenta el próximo sweep
    }
    for (const g of broken) {
      const token = createEnrollToken(db, user.id, g.service, g.profile);
      const link = `${base}/oauth/start?t=${token}`;
      const delivered = await notifyGrantBroken(user, g, link).catch(() => false);
      // Sellar SÓLO si la entrega fue confiable (item durable en el 🔔). Si falló, notified_at queda
      // NULL → el grant reaparece el próximo sweep y reintentamos. `sealGrantNotified` es condicional
      // a broken_at (no sella si el grant revivió entre el intento y el sello).
      if (delivered) sealGrantNotified(db, user.id, g.service, g.profile);
      console.log(dim(`[grant-death] user=${user.id} ${g.service}/${g.profile} entregado=${delivered}`));
    }
  }

  // /voice — settings de voz del usuario (Fase 10): qué voz y prosodia usar para el TTS.
  // NO maneja "modo voz/texto": eso lo decide el agente (marcador [[voice]]/[[text]]); la voz
  // está siempre disponible. Subcomandos: list · <id> · rate/pitch/volume <val> · reset.
  const PARAM_HELP: Record<"rate" | "volume" | "pitch", string> = {
    rate: "porcentaje con signo, ej. +10% (más rápido) o -15% (más lento)",
    volume: "porcentaje con signo, ej. +10% o -50%",
    pitch: "Hz con signo, ej. +5Hz (más agudo) o -10Hz (más grave)",
  };
  const PARAM_VALID = { rate: isValidRate, volume: isValidVolume, pitch: isValidPitch } as const;

  async function handleVoice(user: User, arg: string, thread: PostTarget): Promise<void> {
    if (!speechEnabled()) {
      await thread.post("La voz (STT/TTS) no está configurada en este gateway.");
      return;
    }
    const [sub, ...restArr] = arg.trim().split(/\s+/);
    const val = restArr.join(" ").trim();
    const cur = getUserSpeech(db, user.id);
    const lang = getUserLang(db, user.id); // /voice muestra y valida voces del idioma activo (Fase 15)
    const fmt = (v: string | null) => v ?? "default";

    if (sub === "list") {
      await thread.post(
        `Voces (cambiá con /voice <nombre>):\n${voicesForLang(lang)
          .map((v) => `• ${v.nick ?? v.id} — ${v.label}`)
          .join("\n")}\n\nActual: ${displayVoice(cur.voice ?? defaultVoice(lang))}`,
      );
      return;
    }
    if (sub === "reset") {
      setUserSpeech(db, user.id, { voice: null, rate: null, pitch: null, volume: null });
      await thread.post(
        `Listo, volví a la voz y parámetros por defecto (${displayVoice(defaultVoice(lang))}).`,
      );
      return;
    }
    if (sub === "rate" || sub === "pitch" || sub === "volume") {
      if (!paramSupported(sub)) {
        await thread.post(
          `En el provider de voz actual (${speechProvider()}) "${sub}" no aplica; sólo "rate".`,
        );
        return;
      }
      if (!val) {
        await thread.post(`Pasame un valor: /voice ${sub} <valor> (${PARAM_HELP[sub]}). "off" lo resetea.`);
        return;
      }
      if (val === "off" || val === "default") {
        setUserSpeech(db, user.id, { [sub]: null });
        await thread.post(`${sub} vuelto al default.`);
        return;
      }
      if (!PARAM_VALID[sub](val)) {
        await thread.post(`"${val}" no es válido para ${sub} (${PARAM_HELP[sub]}).`);
        return;
      }
      setUserSpeech(db, user.id, { [sub]: val });
      await thread.post(`${sub} = ${val}. (probá pedirme un audio para escucharlo)`);
      return;
    }
    const resolved = sub ? resolveVoice(sub, lang) : undefined;
    if (sub && resolved) {
      // La voz tiene que ser del idioma activo (sino se diría el texto con acento ajeno).
      if (!voiceMatchesLang(resolved, lang)) {
        await thread.post(
          `"${sub}" no es del idioma activo (${lang}). Cambiá de idioma con /language o elegí una de /voice list.`,
        );
        return;
      }
      setUserSpeech(db, user.id, { voice: resolved });
      await thread.post(`Voz cambiada a ${displayVoice(resolved)}. (probá pedirme un audio)`);
      return;
    }
    if (sub) {
      await thread.post(
        `No reconozco "${sub}". Usá: /voice list · /voice <nombre> · /voice rate|pitch|volume <val> · /voice reset.`,
      );
      return;
    }
    // Sin args → estado + ayuda.
    await thread.post(
      `🔊 Voz (el sistema lee tus mensajes en voz cuando el asistente responde en audio)\n` +
        `• Voz: ${cur.voice ? displayVoice(cur.voice) : `default (${displayVoice(defaultVoice(lang))})`}\n` +
        `• rate: ${fmt(cur.rate)} · pitch: ${fmt(cur.pitch)} · volume: ${fmt(cur.volume)}\n\n` +
        `Cambiar: /voice list (ver voces) · /voice <nombre> · /voice rate +10% · /voice reset.`,
    );
  }

  // /language — idioma del usuario (Fase 15). Cambia el idioma de respuesta del agente
  // (tag por turno) y reinicia la voz a la default del idioma nuevo. Subcomandos: list · <id>.
  async function handleLanguage(user: User, arg: string, thread: PostTarget): Promise<void> {
    const sub = arg.trim().toLowerCase();
    const cur = getUserLang(db, user.id);
    const menu = LANGS.map((l) => `• ${l.id} — ${l.label}${l.id === cur ? " (actual)" : ""}`).join("\n");

    if (!sub || sub === "list") {
      await thread.post(`🌐 Idioma\n${menu}\n\nCambiar: /language <id> (ej. /language en).`);
      return;
    }
    if (!isValidLang(sub)) {
      await thread.post(`No reconozco "${sub}". Idiomas:\n${menu}`);
      return;
    }
    if (sub === cur) {
      await thread.post(`Ya estabas en ${sub}.`);
      return;
    }
    setUserLang(db, user.id, sub); // resetea la voz a la default del idioma nuevo
    await thread.post(
      sub === "es"
        ? `Listo, te hablo en español. (la voz volvió a la default: ${defaultVoice(sub)})`
        : `Done, I'll talk to you in English now. (voice reset to default: ${defaultVoice(sub)})`,
    );
  }

  // /model — modelo de chat del usuario. El modelo es atributo del AGENTE en MA (no de la
  // sesión), así que cambiarlo RECREA la sesión apuntando a otro coordinador → reinicia el
  // contexto conversacional (la wiki sobrevive, se re-clona). `/model` sin args lista; `/model
  // <id>` cambia. Si la box sólo tiene un modelo publicado, igual responde (lista de uno).
  async function handleModel(ctx: UserCtx, arg: string, thread: PostTarget): Promise<void> {
    const sub = arg.trim().toLowerCase();
    // Lista + default POR BACKEND (workstream E): un usuario local ve el roster local, uno MA los
    // de Anthropic. modelByKey/defaultKey se computan acá por su backend_mode (no globales).
    const models = modelsForUser(ctx.user);
    const modelByKey = new Map(models.map((m) => [m.key, m] as const));
    const defaultKey = defaultModelKeyForBackend(ctx.user.backend_mode);
    const cur = getUserModel(db, ctx.user.id) ?? defaultKey;
    const menu = models.map((m) => `• ${m.key} — ${m.label}${m.key === cur ? " (actual)" : ""}`).join("\n");

    if (!sub || sub === "list") {
      await thread.post(
        `🧠 Modelo\n${menu}\n\nCambiar: /model <id> (ej. /model ${models[0]?.key ?? "..."}). Reinicia el contexto.`,
      );
      return;
    }
    const target = modelByKey.get(sub);
    if (!target) {
      await thread.post(`No reconozco "${sub}". Modelos:\n${menu}`);
      return;
    }
    if (target.key === cur) {
      await thread.post(`Ya estabas en ${target.key}.`);
      return;
    }
    // Guardamos ANTES de recrear: recreateSession lee agentIdForUser → toma el modelo nuevo.
    setUserModel(db, ctx.user.id, target.key === defaultKey ? null : target.key);
    // El sid no se muestra (interna: nombre de VM/env id); queda en el log de recreateSession.
    await recreateSession(ctx);
    await thread.post(`Listo, ahora uso ${target.label}. Sesión nueva (contexto reiniciado).`);
  }

  // Formateo compacto de un conteo de tokens para `/status`: 1234 → "1.2k", 980 → "980".
  function fmtTokens(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
  }
  // Formateo de una antigüedad (ms) en lenguaje natural corto para `/status`: "12s" / "5m" / "2h".
  function fmtAgo(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.round(m / 60)}h`;
  }

  // /compact — compactación manual on-demand (quickboot/sessions §6). A diferencia de /new (hard
  // reset), achica el contexto SIN perder el hilo: opencode reemplaza la historia vieja por un
  // checkpoint con resumen. Sólo aplica al backend LOCAL (archima/opencode); MA auto-compacta
  // server-side y no expone un trigger. El aviso "Conversación compactada" sale por el Sink
  // (session.compacted) → acá sólo va el ack del comando (y el reporte de error si falla).
  async function handleCompact(ctx: UserCtx, thread: PostTarget): Promise<void> {
    if (ctx.user.backend_mode !== "local") {
      await thread.post("La compactación manual no aplica a tu backend: la conversación se compacta sola.");
      return;
    }
    const summarize = ctx.relay?.summarize;
    if (!summarize) {
      await thread.post("No hay una sesión activa para compactar. Escribime algo y volvé a probar.");
      return;
    }
    try {
      await summarize();
      await thread.post(
        "Listo, compacté la conversación. El contexto quedó más chico sin perder el hilo. ✅",
      );
    } catch (e) {
      console.error(`[compact] user=${ctx.user.id}: ${(e as Error)?.message ?? e}`);
      await thread.post("No pude compactar la conversación ahora. Probá de nuevo en un momento.");
    }
  }

  // /status — estado de la sesión (quickboot/sessions §6): backend, modelo, tamaño del contexto del
  // último turno (≈ lo que se re-prefilea en frío) y cuándo fue la última compactación. Da
  // visibilidad de "por qué va lento" (contexto grande). Los tokens salen del usage cacheado en
  // `turnComplete`; la compactación, del `notice` cacheado. Todo best-effort (vive con el ctx).
  async function handleStatus(ctx: UserCtx, thread: PostTarget): Promise<void> {
    const lines: string[] = ["📊 Estado de la sesión"];
    lines.push(`• Backend: ${ctx.user.backend_mode === "local" ? "local (archima)" : "Managed Agents"}`);
    const models = modelsForUser(ctx.user);
    const curKey = getUserModel(db, ctx.user.id) ?? defaultModelKeyForBackend(ctx.user.backend_mode);
    lines.push(`• Modelo: ${models.find((m) => m.key === curKey)?.label ?? curKey}`);
    if (ctx.lastUsage) {
      // El prefill frío re-procesa el contexto entero: input + lo que se leyó de cache lo aproxima.
      const ctxTok = ctx.lastUsage.input + ctx.lastUsage.cacheRead;
      lines.push(`• Contexto (último turno): ~${fmtTokens(ctxTok)} tokens`);
    } else {
      lines.push("• Contexto: todavía sin turnos en esta sesión");
    }
    lines.push(
      ctx.lastCompactedAt
        ? `• Última compactación: hace ${fmtAgo(Date.now() - ctx.lastCompactedAt)}`
        : "• Compactación: ninguna en esta sesión",
    );
    // Próximo clear diario (sólo backend local: el reset por-tz corre a las 4am del usuario).
    if (ctx.user.backend_mode === "local") {
      try {
        const tz = ctx.user.timezone || "UTC";
        const when = new Date(nextFireFrom(CLEAR_CRON, tz, new Date().toISOString())).toLocaleString(
          "es-AR",
          {
            timeZone: tz,
            weekday: "short",
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          },
        );
        lines.push(`• Próximo reinicio diario: ${when}`);
      } catch {
        /* tz inválida → omitir esta línea */
      }
    }
    lines.push(`• Sesión: ${ctx.sessionId ? sessionFingerprint(ctx.sessionId) : "(sin sesión todavía)"}`);
    await thread.post(lines.join("\n"));
  }

  // /debug — modo debug del usuario (Pieza A). `on`/`off` lo prende/apaga; sin args muestra el
  // estado. NO recrea la sesión: sólo cambia cómo el canal renderiza la actividad del agente en
  // los próximos turnos (Telegram postea los tool-calls; la web ya los muestra always-on).
  async function handleDebug(ctx: UserCtx, arg: string, thread: PostTarget): Promise<void> {
    const sub = arg.trim().toLowerCase();
    if (!sub) {
      const on = getUserDebug(db, ctx.user.id);
      await thread.post(
        on
          ? "🔧 Modo debug: ON. Te muestro los pasos del agente. Para apagar: /debug off."
          : "Modo debug: OFF. Para ver los pasos del agente: /debug on.",
      );
      return;
    }
    const on = sub === "on" || sub === "1" || sub === "true";
    const off = sub === "off" || sub === "0" || sub === "false";
    if (!on && !off) {
      await thread.post("Uso: /debug on · /debug off (sin args muestra el estado).");
      return;
    }
    setUserDebug(db, ctx.user.id, on);
    ctx.user.debug_mode = on ? 1 : 0; // espejo en memoria (la fuente es la DB)
    await thread.post(
      on ? "🔧 Modo debug ON. Vas a ver lo que va haciendo el agente paso a paso." : "Modo debug OFF.",
    );
  }

  // Nombre visible de una wiki para `viewer`: el label pelado ("luminos"), salvo colisión con
  // otra wiki visible (ahí la ajena se prefija con el dueño → "demo-luminos"). Ver wikiDisplayNames.
  // Computa sobre TODO el set del viewer porque la desambiguación depende del conjunto.
  function wikiNameFor(repo: Repo, viewer: User): string {
    const base = wikis ? listReposForUser(db, viewer.id) : [];
    const repos = base.some((r) => r.id === repo.id) ? base : [...base, repo];
    return wikiDisplayNames(db, viewer.handle, repos).get(repo.name) ?? repo.name;
  }

  // Resuelve lo que tipeó el usuario (`/wiki set <x>`, `/rem <x>`) a una de sus wikis. Tolerante:
  // matchea contra el nombre del repo, el label pelado, la forma `dueño-label`, o el display name
  // efectivo (con desambiguación) — todo case-insensitive.
  function resolveWiki(repos: Repo[], viewer: User, typed: string): Repo | undefined {
    const display = wikiDisplayNames(db, viewer.handle, repos);
    return repos.find((r) => {
      const ownerHandle = firstUserForRepo(db, r.id)?.handle ?? r.name;
      return wikiMatches(
        { name: r.name, label: wikiLabel(r, ownerHandle), ownerHandle, display: display.get(r.name) },
        typed,
      );
    });
  }

  const MEMORY_MAX_FILES_PER_REPO = 80;
  const MEMORY_MAX_FACTS = 5;

  const MEMORY_STOPWORDS = new Set([
    "para",
    "como",
    "cuando",
    "donde",
    "sobre",
    "esto",
    "esta",
    "este",
    "estas",
    "estos",
    "quiero",
    "podes",
    "podés",
    "decime",
    "dime",
    "hacer",
    "tengo",
    "tiene",
    "tienen",
    "notas",
    "nota",
  ]);

  function searchTerms(text: string): string[] {
    const terms = text
      .toLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu)
      ?.filter((t) => !MEMORY_STOPWORDS.has(t));
    return Array.from(new Set(terms ?? [])).slice(0, 12);
  }

  function looksSensitive(path: string, text: string): boolean {
    const haystack = `${path}\n${text}`.toLowerCase();
    return /\b(password|contraseña|passwd|secret|token|api[_ -]?key|private[_ -]?key|credencial|credential)\b/.test(
      haystack,
    );
  }

  function memorySnippet(text: string, terms: string[]): string {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter((l) => !looksSensitive("", l));
    const hit =
      lines.find((l) => {
        const lower = l.toLowerCase();
        return terms.some((t) => lower.includes(t));
      }) ?? lines[0];
    return (hit ?? "").replace(/^[-*#\s]+/, "").slice(0, 220);
  }

  function clampInt(n: number | undefined, def: number, min: number, max: number): number {
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.floor(n as number)));
  }

  function requireUserForTool(userId: number): User {
    const user = getUser(db, userId);
    if (!user) throw new Error(`usuario desconocido: ${userId}`);
    return user;
  }

  async function relevantMemoryTagForTurn(user: User, line: string): Promise<string | undefined> {
    if (!wikis) return undefined;
    const terms = searchTerms(line);
    if (terms.length === 0) return undefined;
    const repos = listReposForUser(db, user.id);
    const facts: { wiki: string; path: string; snippet: string; score: number }[] = [];
    for (const repo of repos) {
      const tree = await wikis.tree(repo.name);
      const paths = tree.paths
        .filter((p) => p.startsWith("memoria/") && p.endsWith(".md"))
        .slice(0, MEMORY_MAX_FILES_PER_REPO);
      if (!paths.length) continue;
      const snap = await wikis.read(repo.name, tree.ref, paths);
      for (const file of snap.files) {
        if (looksSensitive(file.path, file.content)) continue;
        const pathLower = file.path.toLowerCase();
        const contentLower = file.content.toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (pathLower.includes(term)) score += 3;
          if (contentLower.includes(term)) score += 1;
        }
        if (score <= 0) continue;
        const snippet = memorySnippet(file.content, terms);
        if (!snippet) continue;
        facts.push({ wiki: wikiNameFor(repo, user), path: file.path, snippet, score });
      }
    }
    facts.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const selected = facts.slice(0, MEMORY_MAX_FACTS);
    if (!selected.length) return undefined;
    return `[memoria relevante: ${selected.map((f) => `${f.wiki}/${f.path}: ${f.snippet}`).join(" | ")}]`;
  }

  // /wiki — wiki en foco del usuario (Fase 16). `/wiki list` muestra las wikis y cuál está
  // activa; `/wiki set <nombre>` enfoca el chat en una sola (menos contexto/costo); `/wiki set
  // all` vuelve a todas; `/wiki label <wiki> <alias>` setea el alias humano. Cambiar el foco
  // RECREA la sesión (los mounts son fijos al crearla), así que reinicia el contexto.
  async function handleWiki(ctx: UserCtx, arg: string, thread: PostTarget): Promise<void> {
    const repos = wikis ? listReposForUser(db, ctx.user.id) : [];
    if (repos.length === 0) {
      await thread.post("No tenés wikis configuradas.");
      return;
    }
    const active = getUserActiveWiki(db, ctx.user.id);
    const parts = arg.trim().split(/\s+/).filter(Boolean);

    if (parts.length === 0 || parts[0] === "list") {
      const lines = repos
        .map((r) => `• ${wikiNameFor(r, ctx.user)}${active === r.name ? " (en foco)" : ""}`)
        .join("\n");
      const focused = active ? repos.find((r) => r.name === active) : undefined;
      const scope = focused ? `en foco: ${wikiNameFor(focused, ctx.user)}` : "en foco: todas";
      await thread.post(
        `📚 Wikis (${scope}):\n${lines}\n\nEnfocar: /wiki set <nombre> · /wiki set all (todas).\n` +
          `Renombrar: /wiki label <wiki> <alias>.\nCambiar el foco reinicia la sesión de chat.`,
      );
      return;
    }

    if (parts[0] === "set") {
      const target = parts.slice(1).join(" ");
      if (!target) {
        await thread.post("Pasame qué wiki: /wiki set <nombre> · /wiki set all.");
        return;
      }
      if (target === "all") {
        if (active === null) {
          await thread.post("El chat ya ve todas tus wikis.");
          return;
        }
        setUserActiveWiki(db, ctx.user.id, null);
        await recreateSession(ctx);
        await thread.post("Listo, el asistente vuelve a ver TODAS tus wikis. (sesión reiniciada)");
        return;
      }
      const repo = resolveWiki(repos, ctx.user, target);
      if (!repo) {
        await thread.post(`No encontré la wiki "${target}". Mandá /wiki list para verlas.`);
        return;
      }
      const shown = wikiNameFor(repo, ctx.user);
      if (active === repo.name) {
        await thread.post(`El chat ya está enfocado en "${shown}".`);
        return;
      }
      setUserActiveWiki(db, ctx.user.id, repo.name);
      await recreateSession(ctx);
      await thread.post(
        `Listo, el asistente trabaja sólo sobre "${shown}". (/wiki set all para volver a todas; sesión reiniciada)`,
      );
      return;
    }

    if (parts[0] === "label") {
      const repo = parts[1] ? resolveWiki(repos, ctx.user, parts[1]) : undefined;
      const alias = parts[2]?.toLowerCase();
      if (!repo || !alias) {
        await thread.post("Forma: /wiki label <wiki> <alias>. Ej: /wiki label demo personal.");
        return;
      }
      // Validación slug unificada web/chat (F2 Q8): misma regex que assertValidLabel en @ceibo/wikis.
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(alias)) {
        await thread.post(
          "El alias va en minúsculas, sin espacios (letras, números y guiones, 1-31 chars). Ej: personal, trabajo.",
        );
        return;
      }
      // En wikis compartidas, solo el owner puede renombrar (Q8). Verificar con ownerOf.
      if (!isOwner(db, repo.id, ctx.user.id)) {
        await thread.post("Solo el dueño puede renombrar esta wiki.");
        return;
      }
      setRepoLabel(db, repo.id, alias);
      await thread.post(`Listo, ahora esa wiki se llama "${wikiNameFor(repo, ctx.user)}".`);
      return;
    }

    await thread.post(
      `No reconozco "/wiki ${parts.join(" ")}". Usá /wiki list · /wiki set <nombre|all> · /wiki label <wiki> <alias>.`,
    );
  }

  // /agenda — ver y cancelar los recordatorios programados (crons) del usuario. Lectura pura
  // del store (sin turno de LLM): los crea el agente vía la tool MCP schedule, esto sólo los
  // lista y cancela. `/agenda` lista los activos agrupados; `/agenda cancel <id>` cancela uno
  // (acotado al dueño por cancelCron). Mismo dispatch para todos los canales (runCommand).
  async function handleAgenda(user: User, arg: string, thread: PostTarget): Promise<void> {
    const sub = arg.trim();

    // /agenda cancel <id>
    if (sub.startsWith("cancel")) {
      const id = Number(sub.slice("cancel".length).trim());
      if (!Number.isInteger(id) || id <= 0) {
        await thread.post("Uso: /agenda cancel <id> (el id sale del listado de /agenda).");
        return;
      }
      const ok = cancelCron(db, id, user.id);
      await thread.post(ok ? `Listo, cancelé el #${id}.` : `No encontré un recordatorio activo #${id} tuyo.`);
      return;
    }
    if (sub && sub !== "list") {
      await thread.post("Uso: /agenda (listar) · /agenda cancel <id>");
      return;
    }

    // /agenda (o /agenda list) → listar activos
    const crons = listCronsForUser(db, user.id).map(viewCron);
    if (crons.length === 0) {
      await thread.post(
        "No tenés nada agendado. Pedímelo en una y lo agendo (ej. «recordame mañana 9am llamar al pediatra»).",
      );
      return;
    }
    const once = crons.filter((c) => c.kind === "once");
    const recur = crons.filter((c) => c.kind === "recur");
    const blocks: string[] = [];
    if (once.length) {
      blocks.push(`⏰ *Únicos*\n${once.map((c) => `#${c.id} · ${c.nextHuman} — ${c.what}`).join("\n")}`);
    }
    if (recur.length) {
      blocks.push(
        `🔁 *Recurrentes*\n${recur
          .map((c) => `#${c.id} · ${c.recurHuman ?? c.nextHuman} — ${c.what}`)
          .join("\n")}`,
      );
    }
    await thread.post(`🗓 Tu agenda\n\n${blocks.join("\n\n")}\n\nCancelá con /agenda cancel <id>.`);
  }

  // --- egress proactivo (broadcast + scheduler de crons, Fase 8) ----------

  // Anuncio de la empresa a TODOS los usuarios activos (broadcast). Inmediato y literal:
  // postea el MISMO `text` tal cual a cada usuario por Telegram (sin pasar por el agente).
  // Lo dispara `ceibo broadcast` vía el control socket. Best-effort por destinatario (un fallo
  // no aborta el resto); registra la corrida en `broadcasts` (auditoría). Devuelve la cuenta.
  //
  // No reusa telegramPostTarget: ese `post` es fire-and-forget (traga el error) y acá
  // necesitamos saber por destinatario si llegó o falló para que la auditoría sea real.
  async function sendBroadcast(
    text: string,
    emit: (line: string) => void,
  ): Promise<{ sent: number; failed: number }> {
    const base = env.TELEGRAM_API_BASE_URL ?? "https://api.telegram.org";
    const token = env.TELEGRAM_BOT_TOKEN as string;
    let sent = 0;
    let failed = 0;
    for (const user of listUsers(db)) {
      if (user.status !== "active") continue;
      const chatId = listChannels(db, user.id).find((c) => c.channel === CHANNEL)?.external_id;
      if (!chatId) continue; // sin identidad de Telegram → no es destinatario
      try {
        const res = await fetch(`${base}/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        sent++;
      } catch (e) {
        failed++;
        emit(`⚠️  ${user.handle}: ${(e as Error)?.message ?? e}`);
      }
    }
    recordBroadcast(db, text, sent, failed);
    emit(`📢 anuncio enviado · ${sent} ok${failed ? ` · ${failed} fallaron` : ""}`);
    return { sent, failed };
  }

  let schedulerBusy = false;
  /** Un tick del scheduler: barre los crons vencidos y los dispara. No solapa ticks. */
  async function fireDueCrons(): Promise<void> {
    if (schedulerBusy) return;
    schedulerBusy = true;
    try {
      const due = listCronsDue(db, new Date().toISOString());
      for (const cron of due) {
        await fireOne(cron).catch((e) => console.log(dim(`[cron ${cron.id}] ${(e as Error)?.message ?? e}`)));
      }
    } finally {
      schedulerBusy = false;
    }
  }

  // ──────────────────────────── Sub-agentes asíncronos (archima) ────────────────────────────
  // El coordinador despacha en el MISMO turno todos los workers que el pedido necesite (tool
  // `subagent_spawn`, MCP control), después ANUNCIA al usuario en UNA frase suya (cuántos y para
  // qué) y cierra su turno (queda libre para charlar; fallback anti-silencio si no anuncia). Cada
  // worker corre en una SEGUNDA sesión opencode en la MISMA VM; al terminar, su resultado se
  // inyecta al coordinador como turno sintético (mismo patrón que los crons/fireOne) y el
  // coordinador le responde al usuario proactivamente. Un worker trabado/innecesario se cancela
  // con la tool `subagent_kill` (killSubagentForUser).

  /** Prompt del worker: contexto (es un sub-agente de ceibo) + el encargo COMPLETO. Le pedimos que
   *  ejecute de punta a punta (incluido subir cambios a la wiki) y termine con un resumen. */
  function workerPrompt(title: string, goal: string): string {
    return (
      `[sos un SUB-AGENTE de ceibo, despachado por el coordinador para ejecutar de forma autónoma la ` +
      `tarea: "${title}". Ejecutá el encargo COMPLETO de punta a punta —leer/hidratar las wikis que ` +
      `haga falta, escribir y correr scripts, y SUBIR los cambios a la wiki que corresponda— sin pedir ` +
      `confirmación (el usuario ya se la dio al coordinador). No converses: trabajá.\n` +
      `ERRORES — si un tool falla 3 veces seguidas con el MISMO error, no sigas reintentando: ` +
      `reportá status "blocked" de inmediato con el error en "blockers".\n` +
      `Al terminar, tu ÚLTIMO mensaje debe cerrar con un bloque JSON fenced, sin texto después, con este contrato:\n` +
      "```json\n" +
      `{"status":"done|blocked|partial","pushed":true,"commit_message":"mensaje si hubo commit","changed_notes":[{"path":"ruta.md","action":"created|edited|moved|archived|deleted"}],"opened_note":"ruta.md","blockers":["si aplica"],"summary_for_user":"resumen claro para el usuario"}\n` +
      "```\n" +
      `Usá status "done" si terminaste, "partial" si avanzaste pero quedó algo pendiente, y "blocked" ` +
      `si no pudiste avanzar. El resumen debe decir qué cambiaste y dónde, y lo que el coordinador deba ` +
      `saber para informarle al usuario.]\n\n${goal}`
    );
  }

  /** Destila lo que devolvió el worker a lo que se reinyecta: el ÚLTIMO mensaje no vacío, parseando
   *  el JSON estructurado si existe y con fallback legacy a texto libre capado. */
  function capWorkerSummary(parts: string[], verificationIssues?: WorkerVerificationIssue[]): string {
    return formatWorkerResultForCoordinator(parts, WORKER_SUMMARY_CAP, { verificationIssues });
  }

  /** Envuelve el output del worker como turno sintético para el coordinador (mismo molde que los
   *  crons): el coordinador lo verifica e informa al usuario por su canal. */
  function injectionPrompt(title: string, output: string): string {
    return `[resultado del sub-agente "${title}" que despachaste]\n${output}\nVerificalo e informale al usuario.`;
  }

  /** Inyecta un turno sintético al coordinador. Si está en un turno (busy), lo encola para drenar al
   *  cerrar (drainPending) — serializado como los crons. Si está libre, rearma el relay y lo dispara.
   *
   *  `originThread` (opcional): el canal/vista que ORIGINÓ el trabajo (ej. el resultado de un
   *  sub-agente vuelve a la vista web que lo pidió). Lo restauramos como `ctx.lastThread` ANTES de
   *  disparar el turno → la respuesta del coordinador sale por ESE thread, no por el `lastThread`
   *  que algún otro canal/cron pudo haber pisado mientras el worker corría. Sin él (crons), la
   *  inyección usa el `lastThread` vigente como antes. */
  async function injectToCoordinator(ctx: UserCtx, text: string, originThread?: PostTarget): Promise<void> {
    if (ctx.busy) {
      ctx.pendingInjections ??= [];
      // La cola serializa inyecciones; cada una vuelve a su propio canal de origen. Guardamos el
      // thread junto al texto (no sólo el texto) para no perder el ruteo al drenar (drainPending).
      ctx.pendingInjections.push(originThread ? { text, originThread } : text);
      return;
    }
    // Restauramos el canal/vista de origen ANTES de abrir el turno: el Sink del coordinador postea a
    // `ctx.lastThread`, así que fijarlo acá hace que la respuesta vuelva a quien preguntó.
    if (originThread) ctx.lastThread = originThread;
    try {
      await ensureRelay(ctx);
    } catch (e) {
      // No pudimos revivir la sesión del coordinador para entregar el resultado: lo logueamos y, si
      // hay canal, avisamos. El resultado se pierde (el worker ya terminó) — mejor que colgar.
      console.log(
        dim(`[subagent] user=${ctx.user.id} no pude inyectar resultado: ${(e as Error)?.message ?? e}`),
      );
      void ctx.lastThread?.post?.(
        "Un sub-agente terminó pero no pude entregarte el resultado (sesión caída).",
      );
      return;
    }
    beginTurn(ctx, "always");
    ctx.relay?.send(text).catch((e) => {
      ctx.busy = false;
      console.log(
        dim(`[subagent] user=${ctx.user.id} send de inyección falló: ${(e as Error)?.message ?? e}`),
      );
      void drainPending(ctx);
    });
  }

  /**
   * Drena el estado pendiente del coordinador cuando queda libre (lo llama turnComplete/dead).
   * Orden: (1) reset diferido de sesión (pendingReset → sesión fresca antes de inyectar);
   * (2) próxima inyección encolada (pendingInjections).
   */
  async function drainPending(ctx: UserCtx): Promise<void> {
    if (ctx.busy) return;
    // Reset diferido: recrea la sesión antes de drenar inyecciones.
    if (ctx.pendingReset) {
      ctx.pendingReset = false;
      console.log(dim(`[control] reset-session user=${ctx.user.id}: drenando reset diferido`));
      await recreateSession(ctx).catch((e) =>
        console.log(
          dim(
            `[control] reset-session user=${ctx.user.id}: error en reset diferido: ${(e as Error)?.message ?? e}`,
          ),
        ),
      );
      // Nota: NO drenamos inyecciones después del reset (la sesión es nueva, el contexto
      // del worker puede ser inconsistente). Las inyecciones en cola se descartan.
      ctx.pendingInjections = [];
      return;
    }
    const next = ctx.pendingInjections?.shift();
    if (!next) return;
    if (typeof next === "string") await injectToCoordinator(ctx, next);
    else await injectToCoordinator(ctx, next.text, next.originThread);
  }

  /** Worker ya ARRANCADO (sesión creada + prompt enviado): lo que la fase de fondo
   *  (finishWorker) necesita para esperar el fin, destilar el resumen y limpiar. */
  interface StartedWorker {
    sid: string;
    relay: Relay;
    parts: string[];
    wikiBaseline: WorkerWikiBaseline[];
    done: Promise<void>;
    timer: ReturnType<typeof setTimeout>;
    wasTimedOut: () => boolean;
    /** true si el coordinador lo canceló con `subagent_kill` (no se inyecta resultado). */
    wasKilled: () => boolean;
  }

  interface WorkerWikiBaseline {
    repo: string;
    head: string;
  }

  async function captureWorkerWikiBaseline(ctx: UserCtx): Promise<WorkerWikiBaseline[]> {
    if (!wikis) return [];
    const repos = listReposForUser(db, ctx.user.id);
    if (repos.length === 0) return [];
    const settled = await Promise.allSettled(
      repos.map(async (repo) => ({ repo: repo.name, head: await wikis.headSha(repo.name) })),
    );
    const out: WorkerWikiBaseline[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled") out.push(r.value);
      else
        console.log(
          dim(
            `[subagent] user=${ctx.user.id} baseline wiki falló: ${(r.reason as Error)?.message ?? r.reason}`,
          ),
        );
    }
    return out;
  }

  async function observeWorkerWikiDiffs(
    ctx: UserCtx,
    baseline: WorkerWikiBaseline[],
  ): Promise<WorkerObservedWikiDiff[]> {
    if (!wikis || baseline.length === 0) return [];
    const settled = await Promise.allSettled(
      baseline.map(async (b) => {
        const headAfter = await wikis.headSha(b.repo);
        if (headAfter === b.head) return undefined;
        const diff = await wikis.diffFiles(b.repo, b.head, headAfter);
        return {
          repo: b.repo,
          added: diff.added,
          removed: diff.removed,
          renamed: diff.renamed,
          modified: diff.modified,
        } satisfies WorkerObservedWikiDiff;
      }),
    );
    const out: WorkerObservedWikiDiff[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled") {
        if (r.value) out.push(r.value);
      } else {
        console.log(
          dim(`[subagent] user=${ctx.user.id} diff wiki falló: ${(r.reason as Error)?.message ?? r.reason}`),
        );
      }
    }
    return out;
  }

  /** FASE 1 del worker: crea la sesión opencode del worker en la VM viva del coordinador, atachea
   *  su sink y le manda el encargo. spawnSubagentForUser la AWAITEA antes del tool-result (la
   *  coreografía de aviso ya salió OPTIMISTA antes): si algo de esto falla (ej. "Falta el token de
   *  autorización."), el spawn NO existió y se corrige honesto — aviso mecánico de error, count
   *  abajo y tool-result que le dice la verdad al modelo.
   *
   *  El worker corre en LA MISMA VM/infra del coordinador (sesión opencode aparte), NO en una VM
   *  propia: antes llamaba createSession con un título propio → otro vmName → cp.sh CLONABA una VM
   *  por worker (cold-start de minutos). Necesita la sesión viva del coordinador (ctx.sessionId =
   *  su nombre de VM) y un backend que soporte sub-agentes (sólo el local; spawnSubagentForUser ya
   *  gatea a backend_mode === "local"). */
  async function startWorker(ctx: UserCtx, id: number, title: string, goal: string): Promise<StartedWorker> {
    const backend = backendForUser(ctx.user);
    const vmSessionId = ctx.sessionId;
    if (!vmSessionId)
      throw new Error("el coordinador no tiene sesión viva: no hay VM donde correr el sub-agente");
    if (!backend.createWorkerSession) throw new Error("este backend no soporta sub-agentes asíncronos");

    const parts: string[] = [];
    let settled = false;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const finishOnce = (): void => {
      if (settled) return;
      settled = true;
      resolveDone();
    };

    const sid = await backend.createWorkerSession(vmSessionId);
    const rec = ctx.workers?.get(id);
    if (rec) rec.sid = sid;
    // Re-afirmación del conteo AHORA que el worker existe DE VERDAD (sesión opencode creada): la
    // coreografía optimista emitió el count provisional ~9s antes — si ese frame salió con un
    // count viejo, se perdió, o un reset del lado web lo pisó, este re-emit deja el conteo
    // correcto (≥1) y el mini-orb del worker PERSISTE. El frame es absoluto e idempotente →
    // el duplicado es inocuo. (El decremento al terminar lo re-emite finishWorker en su finally.)
    emitSubagents(ctx);

    // El sink del worker NUNCA emite al canal del usuario: junta texto para el resumen y cierra.
    const sink: Sink = {
      message: (t: string) => {
        parts.push(t);
      },
      error: (t: string) => {
        parts.push(`[error] ${t}`);
      },
      // Attribution del usage del worker (bug E): se asienta al USUARIO bajo la sesión PROPIA del
      // worker (`sid`), NUNCA como turno del coordinador. recordRemTurn inserta la fila directa —
      // la sesión del worker es efímera (un prompt → un turno), su acumulado ES el turno — sin
      // tocar el snapshot `sessions` del coordinador (recordTurn acá lo pisaría: upsert por
      // user_id → rompería el metering del chat). Antes este usage se DESCARTABA acá y, por el
      // filtro leaky del bus, se asentaba duplicado al coordinador.
      turnComplete: (usage, model) => {
        if (!settled) {
          const total = usage.input + usage.output + usage.cache5m + usage.cache1h + usage.cacheRead;
          if (total > 0) {
            const cost = recordRemTurn(db, ctx.user.id, sid, model, usage);
            console.log(
              dim(
                `$ [${ctx.user.id}] worker ${id}: model:${model} in:${usage.input} out:${usage.output} → $${cost.toFixed(4)}`,
              ),
            );
          }
        }
        finishOnce();
      },
      dead: () => finishOnce(),
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      finishOnce();
    }, WORKER_TIMEOUT_MS);

    const relay = backend.attach(sid, sink);
    const wikiBaseline = await captureWorkerWikiBaseline(ctx);
    try {
      await relay.send(workerPrompt(title, goal));
    } catch (e) {
      // El encargo nunca llegó → el worker no existe: limpiar el attach/timer y propagar al
      // caller (que avisa el fallo mecánicamente).
      clearTimeout(timer);
      relay.close();
      throw e;
    }
    // El worker ya existe DE VERDAD → registrar el handle de cancelación (tool `subagent_kill`):
    // aborta su turno opencode EN LA VM (interrupt = POST /session/:id/abort — frena la generación
    // de ESA sesión, sin tocar la VM ni otros workers; best-effort) y resuelve `done` como
    // cancelado → finishWorker NO inyecta resultado y limpia registro/conteo por su finally.
    let killed = false;
    if (rec)
      rec.kill = () => {
        if (settled || killed) return;
        killed = true;
        void relay.interrupt().catch(() => {});
        finishOnce();
      };
    return {
      sid,
      relay,
      parts,
      wikiBaseline,
      done,
      timer,
      wasTimedOut: () => timedOut,
      wasKilled: () => killed,
    };
  }

  /** FASE 2 del worker — en background: espera el fin (turnComplete/dead/timeout), destila su
   *  resumen, lo inyecta al coordinador como turno sintético y limpia el registro SIEMPRE.
   *  El conteo de mini-orbs se emite al despachar y al terminar (emitSubagents combina con `task`). */
  async function finishWorker(ctx: UserCtx, id: number, title: string, w: StartedWorker): Promise<void> {
    // El canal/vista que despachó este worker (capturado al spawn). La inyección del resultado va a
    // ESTE thread, no al `lastThread` del momento de entrega (que pudo cambiar de canal mientras el
    // worker corría). Si no quedó registrado (no debería), cae a undefined → `lastThread` vigente.
    const originThread = ctx.workers?.get(id)?.originThread;
    try {
      await w.done;
      // Cancelado por el coordinador (`subagent_kill`): NO se inyecta nada — el coordinador lo
      // mató a sabiendas (el tool-result ya le pidió confirmarle al usuario). El finally limpia.
      if (w.wasKilled()) {
        console.log(dim(`🗡 [subagent] user=${ctx.user.id} worker ${id} cancelado: ${title}`));
        return;
      }
      // Timeout: además de abandonarlo, ABORTAMOS su turno opencode en la VM (best-effort) para
      // no dejar la generación corriendo de fondo hasta el guardrail del backend.
      if (w.wasTimedOut()) void w.relay.interrupt().catch(() => {});
      // Inyectamos SOLO el ÚLTIMO mensaje del worker (su RESUMEN: el prompt del worker le pide
      // cerrar con un resumen ≤10 líneas), CAPADO a ~1500 chars. Reinyectar el crudo completo
      // (todos los `parts`) infla el contexto del coordinador (que se recachea cada turno) — el
      // costo que justamente buscamos evitar. El cap es el seguro si el worker se fue de largo.
      const structured = parseWorkerStructuredResultFromParts(w.parts);
      const observedDiffs = await observeWorkerWikiDiffs(ctx, w.wikiBaseline);
      const diffIssues = verifyWorkerObservedDiff(structured, observedDiffs, {
        maxDeletedNotes: WORKER_MAX_DELETIONS,
      });
      const output = capWorkerSummary(w.parts, diffIssues);
      const result = w.wasTimedOut()
        ? `[el sub-agente "${title}" (id ${id}) no terminó a tiempo (${Math.round(WORKER_TIMEOUT_MS / 60000)} min) y quedó abandonado. Avisale al usuario que la tarea quedó pendiente.]`
        : output || `[el sub-agente "${title}" (id ${id}) terminó sin producir un resumen.]`;
      await injectToCoordinator(ctx, injectionPrompt(title, result), originThread);
    } catch (e) {
      // El motivo viaja al COORDINADOR (que se lo repite al usuario) → sin interna; crudo al log.
      console.error(`[subagent] user=${ctx.user.id} worker ${id} falló: ${(e as Error)?.message ?? e}`);
      const motivo = publicErrorReason(e, "problema de conexión con el entorno");
      await injectToCoordinator(
        ctx,
        injectionPrompt(title, `[el sub-agente falló: ${motivo}]`),
        originThread,
      );
    } finally {
      clearTimeout(w.timer);
      w.relay.close();
      ctx.workers?.delete(id);
      emitSubagents(ctx);
    }
  }

  /** Despacha un worker asíncrono para `userId` (lo llama el MCP control · `subagent_spawn`). Devuelve
   *  INMEDIATO un texto de confirmación (o el motivo si no se pudo): backend no-archima, o techo de
   *  workers vivos alcanzado. Throw sólo si el usuario es desconocido. El worker corre en background. */
  async function spawnSubagentForUser(userId: number, goal: string, title?: string): Promise<string> {
    const user = getUser(db, userId);
    if (!user) throw new Error(`usuario desconocido: ${userId}`);
    // Sólo archima (backend local): MA tiene su propio roster de coordinadores (no rompemos nada).
    if (user.backend_mode !== "local") {
      return "Los sub-agentes asíncronos sólo están disponibles en archima; en este backend no puedo despacharlos.";
    }
    let ctx = ctxByUser.get(userId);
    if (!ctx) {
      ctx = { user };
      ctxByUser.set(userId, ctx);
    }
    ctx.workers ??= new Map();
    if (ctx.workers.size >= MAX_WORKERS) {
      return `No pude despachar: ya tenés ${MAX_WORKERS} sub-agentes corriendo. Esperá a que termine alguno antes de lanzar otro.`;
    }
    const id = (ctx.nextWorkerId ?? 0) + 1;
    const label = title?.trim() || `tarea #${id}`;
    const titleKey = normalizeWorkerText(label);
    const goalKey = normalizeWorkerText(goal);
    const duplicate = [...ctx.workers].find(([, w]) => {
      if (normalizeWorkerText(w.title) === titleKey) return true;
      return goalKey.length > 0 && normalizeWorkerText(w.goal) === goalKey;
    });
    if (duplicate) {
      const [duplicateId, duplicateWorker] = duplicate;
      return (
        `Ya hay un sub-agente corriendo para «${duplicateWorker.title}» (id ${duplicateId}). ` +
        "No lances otro igual: esperá su resultado o cancelalo si querés probar otra estrategia."
      );
    }
    ctx.nextWorkerId = id;
    // Capturamos el thread de ORIGEN (el canal/vista que despachó el worker) AHORA, mientras
    // `ctx.lastThread` todavía apunta al turno vigente. Al cerrar el worker, su resultado se inyecta
    // a ESTE thread (ver injectToCoordinator), no al `lastThread` del momento de entrega — que pudo
    // haber sido pisado por otro canal/cron mientras el worker corría.
    ctx.workers.set(id, { title: label, goal, startedAt: Date.now(), originThread: ctx.lastThread });
    // Coreografía OPTIMISTA (contrato UX: señal visible ≤2s): el tool-call ya es VÁLIDO (params
    // OK, techo OK) → underhint + count provisional salen YA, ANTES del startWorker
    // (createWorkerSession en la VM tarda ~9s). El ANUNCIO en texto NO sale acá: lo redacta el
    // MODELO cuando termine de despachar (uno solo para todos los spawns del turno); el timer
    // anti-silencio de abajo es el seguro. Si el spawn falla, se CORRIGE honesto: aviso mecánico
    // de error y count abajo.
    noteSpawnDispatched(ctx, label);
    // El tool-result al modelo SÍ espera al resultado real del startWorker: si falló, le dice la
    // verdad (que NO bluffee "disparé un sub-agente" — el spawn no existió).
    let started: StartedWorker;
    try {
      started = await startWorker(ctx, id, label, goal);
    } catch (e) {
      ctx.workers.delete(id);
      // `motivo` viaja al usuario Y al modelo (que se lo puede repetir) → si el error trae
      // interna (VM, cp.sh, env id…) se reemplaza por un genérico; el crudo queda en el log.
      const motivo = publicErrorReason(e, "no pude conectar con tu entorno");
      console.error(`[subagent] user=${userId} spawn de «${label}» falló: ${(e as Error)?.message ?? e}`);
      // Corrección honesta de la señal optimista: error mecánico al usuario y el count provisional
      // vuelve a bajar (mini-orb fuera). Este spawn sale del anuncio pendiente; si era el ÚNICO,
      // la coreografía se cancela entera → el texto del modelo (su explicación del fallo) es
      // output normal del turno y se postea.
      const sa = ctx.spawnAnnounce;
      if (sa?.state === "pending") {
        const i = sa.labels.lastIndexOf(label);
        if (i >= 0) sa.labels.splice(i, 1);
        if (sa.labels.length === 0) clearSpawnAnnounce(ctx);
      }
      void ctx.lastThread?.post?.(`No pude crear el sub-agente (${motivo}). Probá de nuevo en un momento.`);
      emitSubagents(ctx);
      return (
        `NO se pudo crear el sub-agente (${motivo}). Ya le avisé al usuario mecánicamente. ` +
        `NO digas que despachaste un sub-agente (no existe); si corresponde, ofrecé reintentar más tarde.`
      );
    }
    void finishWorker(ctx, id, label, started); // background: NO await — el turno del coordinador se libera
    // (Re)armar la garantía anti-silencio: desde el ÚLTIMO tool-result de spawn, el modelo tiene
    // ANNOUNCE_TIMEOUT_MS para redactar su anuncio; si no llega, el gateway postea el fallback.
    armAnnounceFallback(ctx);
    console.log(dim(`🧵 [subagent] user=${userId} despachado id=${id}: ${label}`));
    // El PRÓXIMO texto del coordinador es el anuncio y SÍ se postea (ver makeSink.message): la
    // instrucción de acá guía al modelo a despachar TODO primero y anunciar UNA sola vez.
    return (
      `Sub-agente despachado (id ${id}): ${label}. El usuario AÚN NO recibió ningún aviso. ` +
      `Si el pedido necesita más sub-agentes, despachalos AHORA (más subagent_spawn, sin texto entre medio). ` +
      `Despachado el último, avisale al usuario en UNA sola frase natural —cuántos sub-agentes ` +
      `lanzaste y para qué— y terminá tu turno sin usar más herramientas. Cuando cada sub-agente ` +
      `termine te llega su resultado como turno nuevo.`
    );
  }

  /** Coreografía mecánica POR SPAWN (la hace el GATEWAY, optimista: apenas el tool-call es
   *  válido, ANTES de que el worker exista — startWorker tarda ~9s; la señal visible sale ≤2s):
   *  (a) registra el label en el anuncio PENDIENTE del turno (el texto lo redacta el MODELO al
   *  final, uno para todos los spawns; ver makeSink.message y flushPendingAnnounce); (b) emite el
   *  underhint `subagente creado` (frame `activity` kind:"subagent"); (c) emite el conteo
   *  provisional de sub-agentes vivos (frame `subagents` — el chip "N trabajando"; startWorker lo
   *  re-afirma al registrar el worker real). El turno NO se cierra acá: se cierra cuando sale el
   *  anuncio (del modelo o el fallback). Si el startWorker posterior falla, spawnSubagentForUser
   *  corrige honesto (aviso de error, count abajo, label fuera del anuncio). */
  function noteSpawnDispatched(ctx: UserCtx, label: string): void {
    ctx.spawnAnnounce ??= { state: "pending", labels: [] };
    const sa = ctx.spawnAnnounce;
    // Un spawn nuevo re-abre el anuncio (si el modelo anunció y despachó OTRO después — no
    // debería, el prompt lo prohíbe — el próximo texto vuelve a postearse: peor un mensaje de
    // más que un spawn mudo).
    sa.state = "pending";
    sa.labels.push(label);
    if (ctx.turnEgress !== "never") {
      // underhint del orb: `subagente creado` (el canal remoto lo marca kind:"subagent").
      void ctx.lastThread?.activity?.(SUBAGENT_SPAWNED_HINT, { debug: getUserDebug(db, ctx.user.id) });
    }
    // conteo provisional (chip "N trabajando"): el frame es absoluto e idempotente.
    emitSubagents(ctx);
  }

  /** (Re)arma el timer anti-silencio del anuncio: corre desde el último tool-result de spawn.
   *  Al vencer con el anuncio aún pendiente, flushPendingAnnounce postea la línea mínima del
   *  gateway y cierra el turno para el usuario (nunca "usuario en el vacío"). */
  function armAnnounceFallback(ctx: UserCtx): void {
    const sa = ctx.spawnAnnounce;
    if (!sa || sa.state !== "pending") return;
    if (sa.timer) clearTimeout(sa.timer);
    sa.timer = setTimeout(() => {
      sa.timer = undefined;
      if (ctx.spawnAnnounce !== sa) return; // el turno ya rotó (beginTurn limpió) → no postear
      flushPendingAnnounce(ctx);
    }, ANNOUNCE_TIMEOUT_MS);
  }

  /** Cancela un worker asíncrono VIVO de `userId` (lo llama el MCP control · tool
   *  `subagent_kill`). `ref` es el id numérico o (un pedazo único de) su título. Saca el worker
   *  del registro y baja el conteo YA (chip/mini-orb fuera), aborta su turno opencode en la VM
   *  (best-effort, vía el handle que registró startWorker) y marca su `done` como cancelado →
   *  no se inyecta ningún resultado. Devuelve el texto para el modelo (que le confirma al
   *  usuario en su voz). Throw sólo si el usuario es desconocido. */
  async function killSubagentForUser(userId: number, ref: string): Promise<string> {
    const user = getUser(db, userId);
    if (!user) throw new Error(`usuario desconocido: ${userId}`);
    const ctx = ctxByUser.get(userId);
    const workers = ctx?.workers;
    if (!ctx || !workers || workers.size === 0)
      return "No hay ningún sub-agente corriendo ahora — nada que cancelar.";
    const vivos = (): string => [...workers].map(([wid, w]) => `id ${wid}: «${w.title}»`).join("; ");
    const wanted = ref.trim();
    // Por id exacto ("2", "id 2"), o por título (substring case-insensitive, si matchea UNO solo).
    let found: [number, { title: string; kill?: () => void }] | undefined;
    const asId = Number(wanted.replace(/^id\s+/i, ""));
    const byId = Number.isInteger(asId) ? workers.get(asId) : undefined;
    if (byId) found = [asId, byId];
    else {
      const needle = wanted.toLowerCase();
      const matches = [...workers].filter(([, w]) => w.title.toLowerCase().includes(needle));
      if (matches.length === 1) found = matches[0];
      else if (matches.length > 1)
        return `Hay varios sub-agentes que matchean «${wanted}»: ${vivos()}. Repetí con el id.`;
    }
    if (!found) return `No encontré ese sub-agente. Vivos ahora: ${vivos()}.`;
    const [id, rec] = found;
    if (!rec.kill)
      return `El sub-agente (id ${id}): ${rec.title} todavía se está creando; reintentá en unos segundos.`;
    // Fuera del registro y conteo abajo YA (el kill remoto es best-effort y async).
    workers.delete(id);
    emitSubagents(ctx);
    rec.kill();
    console.log(dim(`🗡 [subagent] user=${userId} kill id=${id}: ${rec.title}`));
    return (
      `Cancelado el sub-agente (id ${id}): ${rec.title}. No va a llegar ningún resultado suyo. ` +
      `Confirmale al usuario en UNA frase, en tu voz, que lo cancelaste.`
    );
  }

  /** Dispara un cron vencido: revive la sesión del usuario (continuidad), inyecta el
   *  `what` como prompt sintético y empuja el output según el modo de reporte. */
  async function fireOne(cron: CronRow): Promise<void> {
    const user = getUser(db, cron.user_id);
    // Usuario inexistente/inactivo → cerrar el cron para no reintentar por siempre.
    if (!user || user.status !== "active") {
      if (cron.kind === "once") completeCron(db, cron.id);
      else cancelCron(db, cron.id, cron.user_id);
      return;
    }
    // Egress según el canal elegido del cron ('telegram'|'whatsapp'|'all'; editable desde la
    // UI). 'all' hace fan-out a los persistentes que tenga el usuario. Si el elegido no está
    // disponible. undefined → sin canal alcanzable.
    const target = cronTarget(user, cron);
    if (!target) {
      console.log(dim(`[cron ${cron.id}] user=${user.id} sin canal de egress alcanzable → salteo`));
      return;
    }

    let ctx = ctxByUser.get(user.id);
    if (!ctx) {
      ctx = { user };
      ctxByUser.set(user.id, ctx);
    }
    // Serialización: si hay un turno en vuelo, diferir al próximo tick (no toco next_fire,
    // así vuelve a salir como vencido). Evita pisar turnEgress de un turno interactivo.
    if (ctx.busy) {
      console.log(dim(`[cron ${cron.id}] user=${user.id} ocupado → difiero`));
      return;
    }

    // Continuidad de sesión (Gate 3): revivir/reusar + re-primear, igual que el path
    // interactivo (refresh de tokens → relay → perfiles). prepareSession (dentro de
    // ensureRelay) re-asegura la cred del schedule en el vault.
    // Fijamos lastThread ANTES del refresh para que una eventual notificación de grant muerto
    // (invalid_grant) salga por el canal del cron (postToUser usa ctx.lastThread). Se re-fija abajo.
    ctx.lastThread = target;
    const brokenCron = await refreshGrantsForUser({
      db,
      backend: backendForUser(user),
      userId: user.id,
      env,
    }).catch(() => [] as OauthGrant[]);
    await notifyBrokenGrants(user, brokenCron);
    await ensureRelay(ctx);
    await applyProfileServers(ctx).catch((e) => console.log(dim(`[perfiles] ${(e as Error)?.message ?? e}`)));
    ctx.lastThread = target;

    // Avanzar el schedule ANTES de disparar: si el turno tarda más que el tick, no se
    // re-dispara (one-shot → done; recurrente → próximo next_fire). Preferimos perder un
    // disparo ante un fallo de send a repetirlo.
    if (cron.kind === "recur" && cron.recur_expr) {
      rescheduleCron(db, cron.id, nextFireFrom(cron.recur_expr, cron.tz, new Date().toISOString()));
    } else {
      completeCron(db, cron.id);
    }

    const prompt = `[recordatorio programado · agendado ${cron.created_at} UTC]\n${cron.what}`;
    console.log(dim(`⏰ [cron ${cron.id}] user=${user.id} report=${cron.report} → disparo`));
    beginTurn(ctx, cron.report);
    ctx.relay?.send(prompt).catch((e) => {
      ctx.busy = false;
      console.error(`[cron ${cron.id}] send falló: ${(e as Error)?.message ?? e}`);
      // Cron 'never' (housekeeping): un fallo de transporte SÍ se avisa al usuario — sin el
      // detalle crudo (puede traer interna del backend), que ya quedó en el log de arriba.
      if (cron.report === "never") {
        void ctx?.lastThread?.post(`⚠️ No pude ejecutar la tarea programada #${cron.id}.`);
      }
    });
  }

  // Apagado limpio: soltar todos los relays vivos (el bootstrap cierra canales/timers/db).
  const closeRelays = () => {
    for (const ctx of ctxByUser.values()) ctx.relay?.close();
  };

  // ───────────────────── Clear diario de sesión por timezone (quickboot/sessions §3) ───────────
  // Cada usuario `backend_mode=local` recibe un HARD reset de su sesión a las 4am de SU timezone:
  // arranca el día con el hilo mínimo → el prefill frío matutino es chico (ataca el "Frío 1"). Es
  // no-destructivo: la memoria durable del usuario vive en su wiki, no en el transcript del chat.
  //
  // Estado in-memory: `nextClearAt` mapea userId → el próximo 4am (ISO UTC) que esperamos. Se
  // inicializa lazy a "próximo 4am FUTURO" (NO dispara al arrancar) y se reprograma tras cada
  // disparo. Un restart cerca de las 4am puede saltearse UN clear (se recomputa a futuro) — benigno:
  // la compactación es la red de seguridad y al día siguiente vuelve a caer. Nunca re-dispara de más.
  const CLEAR_CRON = "0 4 * * *"; // 4am del tz del usuario
  const nextClearAt = new Map<number, string>();

  /** Hard reset de la sesión de UN usuario por el clear diario (best-effort, async). No-op si no
   *  hay sesión viva; difiere implícitamente al día siguiente si hay un turno en vuelo (raro a las
   *  4am). Tras recrear, avisa "Conversación reiniciada" por el último canal del usuario (reusa el
   *  frame `notice` de Fase 1; si la vista está offline el aviso se descarta — el reset igual pasó). */
  function clearDailySession(userId: number): void {
    const ctx = ctxByUser.get(userId);
    if (!ctx?.sessionId) return; // sin sesión viva → nada que resetear (la próxima nace fresca)
    if (ctx.busy) {
      console.log(dim(`[clear diario] user=${userId} ocupado → salteo (cae de nuevo mañana)`));
      return;
    }
    console.log(dim(`[clear diario] user=${userId}: recreando sesión (hard reset)`));
    void recreateSession(ctx)
      .then(() => ctx.lastThread?.notice?.("Conversación reiniciada"))
      .catch((e) => console.log(dim(`[clear diario] user=${userId}: ${(e as Error)?.message ?? e}`)));
  }

  /** Tick del clear diario (lo llama un timer del gateway). Por cada usuario LOCAL activo dispara el
   *  clear cuando su "4am local" cayó en la última ventana. Barato e idempotente si no vence nada;
   *  un usuario con tz inválida se saltea sin romper el barrido. */
  function runDailyClears(): void {
    const nowIso = new Date().toISOString();
    for (const user of listUsers(db)) {
      if (user.backend_mode !== "local" || user.status !== "active") continue;
      const tz = user.timezone || "UTC";
      const due = nextClearAt.get(user.id);
      if (due === undefined) {
        // Primera vez que lo vemos: programamos su próximo 4am (no dispara ahora).
        try {
          nextClearAt.set(user.id, nextFireFrom(CLEAR_CRON, tz, nowIso));
        } catch {
          /* tz inválida → lo ignoramos hasta que se corrija */
        }
        continue;
      }
      if (nowIso < due) continue; // todavía no
      // Venció: reprogramamos ANTES de disparar (no re-dispara si el clear tarda) y después limpiamos.
      try {
        nextClearAt.set(user.id, nextFireFrom(CLEAR_CRON, tz, nowIso));
      } catch {
        nextClearAt.delete(user.id);
      }
      clearDailySession(user.id);
    }
  }

  /**
   * Plano de control: recrea la sesión MA del usuario `userId`.
   * - No hay sesión (sin ctx o sin sessionId): no-op silencioso (la próxima sesión leerá el
   *   estado nuevo de la DB).
   * - Hay turno en vuelo (ctx.busy): difiere el reset al cierre del turno usando el mismo
   *   mecanismo que las inyecciones (pendingResetSession flag) — no corta el turno a la mitad.
   * - Libre: recrea la sesión directamente (async, best-effort, fallo solo en log).
   */
  function resetSessionForUser(userId: number): void {
    const ctx = ctxByUser.get(userId);
    if (!ctx?.sessionId) {
      // Sin sesión viva: no-op. La próxima sesión leerá el estado de la DB actualizado.
      console.log(dim(`[control] reset-session user=${userId}: sin sesión viva → no-op`));
      return;
    }
    if (ctx.busy) {
      // Turno en vuelo: diferimos el reset al cierre del turno. Usamos pendingReset en el ctx
      // para que drainPending lo procese al desbloquear.
      console.log(dim(`[control] reset-session user=${userId}: turno en vuelo → diferido`));
      ctx.pendingReset = true;
      return;
    }
    console.log(dim(`[control] reset-session user=${userId}: recreando sesión`));
    void recreateSession(ctx).catch((e) =>
      console.log(
        dim(`[control] reset-session user=${userId}: error recreando sesión: ${(e as Error)?.message ?? e}`),
      ),
    );
  }

  return {
    handleIncoming,
    sendBroadcast,
    fireDueCrons,
    runCommandForUser,
    postToUser,
    spawnSubagentForUser,
    killSubagentForUser,
    closeRelays,
    resetSessionForUser,
    runDailyClears,
  };
}
