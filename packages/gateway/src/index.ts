// Gateway de ceibo — proceso always-on (multi-usuario + metering). Bootstrap.
//
// Lee el entorno, construye las dependencias (Anthropic, DB, wikis), arma el motor
// (`createGateway` en `./engine.ts` — toda la lógica de un turno) y lo cablea a los
// canales (Telegram polling, control socket cli, canal remoto del web-server) + el
// scheduler de crons. El motor no tiene side-effects de arranque: vive acá.
//
//   pnpm start   (carga .env automáticamente)
//
// Comandos (por usuario): /new (sesión nueva), /session (id), /stop (interrumpir).

import { timingSafeEqual } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { makeMaBackend, type SessionConfig } from "@ceibo/agent";
import { makeArchimaBackend } from "@ceibo/backend-local";
import {
  type CliChannel,
  type PostTarget,
  REMOTE_CHANNEL,
  type RemoteChannel,
  startCliChannel,
  startRemoteChannel,
  startTelegramChannel,
  startWhatsAppChannel,
  type TelegramChannel,
  WHATSAPP_CHANNEL,
  type WhatsAppChannel,
} from "@ceibo/channels";
import { handleMcpPost } from "@ceibo/mcps/src/core/transport.ts";
import { knownService } from "@ceibo/oauth";
import {
  addInboxItem,
  type CronRow,
  ceiboEnv,
  countUnread,
  createEmbedder,
  DEFAULT_EMBED_MODEL,
  defaultDbPath,
  listChannels,
  type OauthGrant,
  openDb,
  pruneEnrollTokens,
  sockPath,
  type User,
  wacliBotStoreDir,
} from "@ceibo/store";
import { type Wikis, wikisFromEnv } from "@ceibo/wikis";
import { makeControlServer } from "./control-mcp.ts";
import { CHANNEL, createGateway, dim, makeBackendForUser, seedOwner } from "./engine.ts";
import { controlUrlSecret } from "./logic.ts";
import { makeNotesServer } from "./notes-mcp.ts";
import { stopAllFollows } from "./wacli.ts";

process.loadEnvFile(new URL("../../../.env", import.meta.url)); // Node 22+; .env único en el root del monorepo

const env = process.env;
// En dev (web-only), TELEGRAM_BOT_TOKEN no es necesario: no hay canal Telegram.
// En staging/prod siempre es requerido.
const required =
  ceiboEnv() === "dev"
    ? ["ANTHROPIC_API_KEY", "AGENT_ID", "ENV_ID"]
    : ["ANTHROPIC_API_KEY", "AGENT_ID", "ENV_ID", "TELEGRAM_BOT_TOKEN"];
for (const k of required) {
  if (!env[k]) {
    console.error(`Falta ${k} en .env`);
    process.exit(1);
  }
}

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
// La costura de backend de sesión. `maBackend` envuelve el `client` de MA; `archimaBackend`
// (opcional) habla con archima vía ssh-sobre-tailnet + opencode; `backendForUser` elige por
// usuario según `users.backend_mode`. Sin ARCHIMA_* en el env, archima queda apagado y los
// usuarios 'local' fallan explícito (default es 'ma' → conducta idéntica para todos).
const maBackend = makeMaBackend(client);
const archimaDefaultModel =
  env.ARCHIMA_MODEL_ID ?? env.ARCHIMA_COORDINATOR_MODEL_ID ?? env.ARCHIMA_WORKER_MODEL_ID;
const archimaBackend = env.ARCHIMA_SSH_TARGET
  ? makeArchimaBackend({
      sshTarget: env.ARCHIMA_SSH_TARGET,
      sshKey: env.ARCHIMA_SSH_KEY as string,
      cp: env.ARCHIMA_CP,
      av: env.ARCHIMA_AV,
      providerID: env.ARCHIMA_PROVIDER_ID as string,
      modelID: archimaDefaultModel as string,
      coordinatorModelID: env.ARCHIMA_COORDINATOR_MODEL_ID,
      workerModelID: env.ARCHIMA_WORKER_MODEL_ID,
      vmPort: env.ARCHIMA_VM_PORT ? Number(env.ARCHIMA_VM_PORT) : undefined,
    })
  : undefined;
const backendForUser = makeBackendForUser(maBackend, archimaBackend);
const cfg: SessionConfig = {
  agentId: env.AGENT_ID as string,
  envId: env.ENV_ID as string,
};
const db = openDb(defaultDbPath());

// Substrato de wikis (GitHub App). Opcional: si no está configurado, el gateway
// anda igual sin montar repos (chat pelado).
let wikis: Wikis | undefined;
try {
  wikis = wikisFromEnv();
} catch (e) {
  console.log(dim(`wikis no configurado (${(e as Error).message}) — sin montaje de repos`));
}

// Bootstrap OPCIONAL: si está seteada TELEGRAM_OWNER_ID y el owner no existe, lo siembra
// (sólo útil en una DB nueva). El allowlist/identidades reales viven en `channel_identities`
// (DB), gestionado por `ceibo channel` → en una box ya provista esta var sobra y se omite.
if (env.TELEGRAM_OWNER_ID) seedOwner(db, env.TELEGRAM_OWNER_ID);

// Canales (asignados más abajo). Los resolvers de egress proactivo los referencian con
// binding tardío: sólo se invocan al disparar un cron (mucho después del arranque), así que
// rompen la circularidad (los canales necesitan `handleIncoming`, que sale de createGateway).
let telegramChannel: TelegramChannel | undefined;
let whatsappChannel: WhatsAppChannel | undefined;
let remoteChannel: RemoteChannel | undefined;

// Egress proactivo (crons/REM) hacia un usuario: elige el canal donde es alcanzable.
// Telegram primero (ventanilla persistente: la Bot API entrega aunque el user esté offline);
// si no tiene identidad telegram, cae al canal remoto (web-server, Fase 4.3) por su handle
// web. El post remoto se descarta si no hay web-server conectado (la vista está offline) —
// limitación aceptada hasta que haya un inbox web persistente. undefined = sin canal
// alcanzable → el caller saltea. (Cabo suelto 4.3: web-only users no recibían sus crons.)
function proactiveTarget(user: User): PostTarget | undefined {
  const ids = listChannels(db, user.id);
  const tg = ids.find((c) => c.channel === CHANNEL)?.external_id;
  if (tg) return telegramChannel?.postTarget(tg);
  // WhatsApp es igual de persistente que Telegram (entrega offline) → segundo en la lista.
  const wa = ids.find((c) => c.channel === WHATSAPP_CHANNEL.name)?.external_id;
  if (wa && whatsappChannel) return whatsappChannel.postTarget(wa);
  const webId = ids.find((c) => c.channel === REMOTE_CHANNEL.name)?.external_id;
  if (webId && remoteChannel) return remoteChannel.postTarget(webId);
  return undefined;
}

// Fan-out: un PostTarget que reenvía a varios canales a la vez (para el cron 'all').
function fanOut(targets: PostTarget[]): PostTarget {
  return {
    post: (text) => Promise.all(targets.map((t) => t.post(text))),
    startTyping: () => Promise.all(targets.map((t) => t.startTyping())),
    postVoice: (ogg, text) =>
      Promise.all(targets.map((t) => (t.postVoice ? t.postVoice(ogg, text) : t.post(text ?? "")))),
    postHeard: (text) => Promise.all(targets.map((t) => t.postHeard?.(text) ?? Promise.resolve())),
  };
}

// Target de egress de un cron de canal `web` (feature crons-delivery): la entrega web es DURABLE
// vía el inbox persistente, no efímera como el resto del egress proactivo. Acumula el texto del
// turno (post/postVoice) y, en `turnDone`, inserta UNA fila de inbox con todo lo dicho. Sin
// fallback a Telegram: "canal donde fue creado" puro (decisión #3 del owner — un recordatorio con
// hora se puede pasar si no abrís la web a tiempo). Además, si hay una vista viva, emite el frame
// `inbox` en vivo (vía el postTarget remoto, que broadcastea) para subir el badge al instante.
//
// startTyping/activity/etc. del turno son no-ops acá: la web no muestra "pensando" para un cron
// de fondo; sólo nos importa el texto final, que se baja por click desde el inbox.
function webInboxTarget(user: User, cron: CronRow): PostTarget {
  const parts: string[] = [];
  const remote = remoteChannel?.postTarget(user.handle); // ventanilla remota para el frame en vivo
  const flush = (): void => {
    const body = parts.join("\n\n").trim();
    parts.length = 0;
    if (!body) return; // turno sin salida (ej. report 'never' silencioso) → no ensuciamos el inbox
    addInboxItem(db, {
      userId: user.id,
      kind: "cron",
      sourceId: cron.id,
      title: cron.title?.trim() || cron.what.slice(0, 60),
      body,
    });
    // Push en vivo del badge (best-effort): si no hay vista conectada, el broadcast se descarta y
    // el badge sube igual la próxima vez que la web pegue a GET /api/inbox. La durabilidad ya quedó
    // garantizada por el addInboxItem de arriba.
    void remote?.inbox?.(countUnread(db, user.id));
  };
  return {
    post: async (text) => {
      if (text.trim()) parts.push(text);
    },
    startTyping: async () => {},
    postVoice: async (_ogg, text) => {
      if (text?.trim()) parts.push(text); // sólo la transcripción: el inbox es texto
    },
    // Fin REAL del turno: recién acá sabemos que el agente terminó → persistimos todo lo acumulado.
    turnDone: () => flush(),
  };
}

// Egress de un cron según su canal elegido ('telegram' | 'whatsapp' | 'web' | 'all'). Honra la
// elección entre los canales que el usuario tiene registrados; 'all' hace fan-out a los
// persistentes (telegram/whatsapp). `web` (feature crons-delivery) entrega al inbox DURABLE (ver
// webInboxTarget) — sin fallback a Telegram. Para los demás canales, si el elegido no está
// disponible, cae a proactiveTarget para no perder el disparo.
function cronTarget(user: User, cron: CronRow): PostTarget | undefined {
  const channel = cron.channel;
  // Web: entrega durable al inbox, siempre (no depende de que la vista esté abierta).
  if (channel === "web") return webInboxTarget(user, cron);
  const ids = listChannels(db, user.id);
  const tgId = ids.find((c) => c.channel === CHANNEL)?.external_id;
  const waId = ids.find((c) => c.channel === WHATSAPP_CHANNEL.name)?.external_id;
  const tg = tgId ? telegramChannel?.postTarget(tgId) : undefined;
  const wa = waId && whatsappChannel ? whatsappChannel.postTarget(waId) : undefined;
  const pick: PostTarget[] = [];
  if (channel === "whatsapp") {
    if (wa) pick.push(wa);
  } else if (channel === "all") {
    if (tg) pick.push(tg);
    if (wa) pick.push(wa);
  } else {
    // 'telegram' (y cualquier valor legacy/desconocido) → Telegram.
    if (tg) pick.push(tg);
  }
  if (pick.length === 0) return proactiveTarget(user); // el elegido no está disponible → fallback
  if (pick.length === 1) return pick[0];
  return fanOut(pick);
}

// Entrega la notificación de "grant OAuth roto" (invalid_grant → reconectar) al usuario. La entrega
// CONFIABLE es el item DURABLE del 🔔 (inbox persistente): sobrevive offline y sube el badge la
// próxima vez que la web cargue, así que su INSERT es el criterio de "entregado" (el motor sella
// notified_at sólo si esto devuelve true). Además, best-effort: empuja el badge en vivo si hay vista
// abierta y espeja el aviso al canal persistente de chat (Telegram/WhatsApp) para alcanzar a quien
// no abre la web. El link de reconexión ya viene armado (enroll token + OAUTH_BASE_URL/oauth/start).
// Late-binding de los canales (como cronTarget): se resuelven al invocar, no al construir el gateway.
async function notifyGrantBroken(user: User, grant: OauthGrant, reconnectUrl: string): Promise<boolean> {
  const label = knownService(grant.service)?.displayName ?? grant.service;
  const acct = grant.account
    ? ` (${grant.account})`
    : grant.profile !== "default"
      ? ` (${grant.profile})`
      : "";
  const title = `Reconectá tu ${label}`;
  const body =
    `Se desconectó tu ${label}${acct} de Google: venció el permiso y necesito que lo reconectes ` +
    `para poder volver a usarlo. Reconectalo acá (el link vence en 30 min, un solo uso):\n${reconnectUrl}`;
  try {
    // Durabilidad primero: el item persiste aunque no haya vista viva (el badge sube al cargar).
    addInboxItem(db, { userId: user.id, kind: "system", title, body });
  } catch (e) {
    console.error(`[grant-death] user=${user.id} addInboxItem falló: ${(e as Error)?.message ?? e}`);
    return false; // no se pudo persistir → NO sellar; el motor reintenta el próximo sweep
  }
  // Badge en vivo (best-effort): si no hay vista conectada, el broadcast se descarta y el badge sube
  // igual la próxima vez que la web pegue a GET /api/inbox. La durabilidad ya quedó garantizada.
  void remoteChannel?.postTarget(user.handle).inbox?.(countUnread(db, user.id));
  // Espejo al canal de chat persistente (Telegram/WhatsApp) para alcanzar a quien no abre la web.
  // Best-effort, no afecta el resultado (la entrega confiable ya es el item durable de arriba).
  const chat = proactiveTarget(user);
  if (chat) void chat.post(body).catch(() => {});
  return true;
}

const gw = createGateway({
  env,
  client,
  backendForUser,
  db,
  cfg,
  wikis,
  cronTarget,
  notifyGrantBroken,
});
const {
  handleIncoming,
  sendBroadcast,
  fireDueCrons,
  runCommandForUser,
  postToUser,
  spawnSubagentForUser,
  killSubagentForUser,
  closeRelays,
  runDailyClears,
} = gw;

// Canal Telegram (bot vía Chat SDK): recepción + egress proactivo viven en el paquete
// @ceibo/channels. El gateway le inyecta `handleIncoming` (boundary tipado) y se queda
// con `telegramChannel.postTarget(chatId)` para los pushes proactivos (crons, digest de REM).
// En dev (web-only) el token es opcional: sin él el canal queda apagado.
if (env.TELEGRAM_BOT_TOKEN) {
  telegramChannel = startTelegramChannel(
    {
      botToken: env.TELEGRAM_BOT_TOKEN,
      botUsername: env.TELEGRAM_BOT_USERNAME,
      apiBaseUrl: env.TELEGRAM_API_BASE_URL,
    },
    { handleIncoming },
  );
  await telegramChannel.start(); // bot.initialize + polling + slash commands (best-effort)
} else {
  console.log(dim("canal telegram OFF (falta TELEGRAM_BOT_TOKEN — modo dev web-only)"));
}

// Canal WhatsApp (el número propio de ceibo, vía wacli). Opcional: sólo si
// WHATSAPP_BOT_ENABLED. Mismo contrato que telegram — `handleIncoming` inyectado (los
// slash-commands salen gratis) + `whatsappChannel.postTarget(jid)` para los pushes
// proactivos. El bot se parea aparte: `pnpm --filter @ceibo/channels pair-bot`.
if (env.WHATSAPP_BOT_ENABLED) {
  whatsappChannel = startWhatsAppChannel(
    { botStore: wacliBotStoreDir(), wacliBin: env.WACLI_BIN },
    { handleIncoming },
  );
  try {
    await whatsappChannel.start(); // verifica el pairing + levanta webhook + sync --follow
  } catch (e) {
    console.log(dim(`canal whatsapp OFF: ${(e as Error)?.message ?? e}`));
    whatsappChannel = undefined;
  }
} else {
  console.log(dim("canal whatsapp OFF (falta WHATSAPP_BOT_ENABLED)"));
}

// Canal `cli` local (ceibo chat <handle> / broadcast): unix socket NDJSON.
// El gateway inyecta sólo lo que el canal necesita (CliPort) — boundary tipado, sin que
// el canal importe el core.
const sock = controlSockPath();
const cliChannel: CliChannel = startCliChannel(sock, { handleIncoming, sendBroadcast });

// Canal remoto (Fase 4.2/4.3): servidor del protocolo NDJSON-sobre-socket por el que el
// web-server se conecta "como un canal más" (Fase 4.3b). Opcional: sólo si
// REMOTE_CHANNEL_SECRET está seteada. INERTE hasta que un cliente se conecte. El egress
// proactivo (crons/REM) hacia usuarios del canal web usará `remoteChannel.postTarget(user)`.
if (env.REMOTE_CHANNEL_SECRET) {
  remoteChannel = startRemoteChannel(
    {
      secret: env.REMOTE_CHANNEL_SECRET,
      transport: {
        kind: "unix",
        path: env.REMOTE_CHANNEL_SOCK ?? sockPath("remote"),
      },
      log: (s) => console.log(dim(s)),
    },
    {
      handleIncoming,
      handleControl: (frame) => {
        if (frame.op === "reset-session") gw.resetSessionForUser(frame.userId);
      },
    },
  );
} else {
  console.log(dim("canal remoto OFF (falta REMOTE_CHANNEL_SECRET)"));
}

// El canal web (SPA + SSE + magic-link + plano repos + /api/sync) vive ahora en el servicio
// propio @ceibo/web-server (Fase 4.3): se conecta al gateway por el canal remoto para la
// mensajería y maneja los repos con su `wikis` in-process. El gateway ya no sirve HTTP de la
// web — sólo el control socket (cli), telegram polling y el canal remoto.

// MCP `control`: el agente corre los comandos del usuario (`ceibo_command`). Vive in-process
// acá (como el viewer en el web-server) porque ejecuta runCommandForUser, que toca el estado
// vivo por usuario (ctxByUser). Listener HTTP propio detrás del ingress: nginx rutea
// /mcp/control/<secret> a CONTROL_MCP_PORT (proxy_pass SIN strip, longest-prefix sobre /mcp/).
// El secreto en el path gatea (timing-safe); el Bearer firmado identifica al usuario en callTool.
// Opcional: sólo si CONTROL_MCP_SECRET (path-gate) + CONTROL_MCP_HMAC_KEY (HMAC Bearer) están.
// C1: las dos claves están separadas — el path-secret no se filtra como clave HMAC.
let controlHttp: ReturnType<typeof createServer> | undefined;
if (env.CONTROL_MCP_SECRET && env.CONTROL_MCP_HMAC_KEY) {
  const secret = env.CONTROL_MCP_SECRET;
  const hmacKey = env.CONTROL_MCP_HMAC_KEY;
  // Fail-fast: el secreto va EMBEBIDO en CONTROL_MCP_URL (path `/mcp/control/<secret>`) Y en
  // CONTROL_MCP_SECRET (lo que este listener valida). TIENEN que ser idénticos. Si se desalinean
  // —fácil al llenar el .env a mano, son dos vars separadas— el listener da 404 a TODO y el connect
  // queda muerto EN SILENCIO (incidente staging 2026-06-20). Lo cazamos al arrancar, no en runtime.
  if (env.CONTROL_MCP_URL) {
    if (controlUrlSecret(env.CONTROL_MCP_URL) !== secret) {
      throw new Error(
        "CONTROL_MCP_URL y CONTROL_MCP_SECRET no coinciden: el secreto embebido en la URL " +
          "(/mcp/control/<secret>) debe ser EXACTAMENTE CONTROL_MCP_SECRET. Desalineados → el control " +
          "MCP da 404 y el connect no funciona. Alineá ambos en el .env (un secreto, el MISMO en los dos).",
      );
    }
  }
  const controlServer = makeControlServer(
    hmacKey,
    runCommandForUser,
    spawnSubagentForUser,
    killSubagentForUser,
    postToUser,
  );
  const safeEqual = (a: string, b: string): boolean => {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  };
  const port = Number(env.CONTROL_MCP_PORT ?? 8830);
  const host = env.CONTROL_MCP_HOST ?? "127.0.0.1";
  controlHttp = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (path.startsWith("/mcp/control/") && req.method === "POST") {
      const got = path.slice("/mcp/control/".length).split("/")[0] ?? "";
      if (!safeEqual(got, secret)) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      void handleMcpPost(controlServer, req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  controlHttp.listen(port, host, () => console.log(dim(`MCP control ON · ${host}:${port}/mcp/control`)));
} else {
  console.log(dim("MCP control OFF (falta CONTROL_MCP_SECRET o CONTROL_MCP_HMAC_KEY)"));
}

// MCP `notes` (feature db F2): búsqueda híbrida + lectura sobre el índice derivado en la DB.
// Mismo patrón que control (path-secret + Bearer HMAC per-uid), listener propio en
// NOTES_MCP_PORT (default 8831). nginx: `proxy_pass` de /mcp/notes/ a ese puerto SIN strip.
// El embedder (bi-encoder en gpuhost, EMBED_URL) es opcional: sin él la búsqueda es léxica.
let notesHttp: ReturnType<typeof createServer> | undefined;
if (env.NOTES_MCP_SECRET && env.NOTES_MCP_HMAC_KEY) {
  const secret = env.NOTES_MCP_SECRET;
  const hmacKey = env.NOTES_MCP_HMAC_KEY;
  // Mismo fail-fast que control: el secreto embebido en NOTES_MCP_URL tiene que ser EL MISMO.
  if (env.NOTES_MCP_URL) {
    const embedded = env.NOTES_MCP_URL.split("/mcp/notes/")[1]?.split("/")[0] ?? "";
    if (embedded !== secret) {
      throw new Error(
        "NOTES_MCP_URL y NOTES_MCP_SECRET no coinciden: el secreto embebido en la URL " +
          "(/mcp/notes/<secret>) debe ser EXACTAMENTE NOTES_MCP_SECRET (misma clase de incidente " +
          "que control, staging 2026-06-20: desalineados → 404 silencioso).",
      );
    }
  }
  const embedder = env.EMBED_URL
    ? createEmbedder({ url: env.EMBED_URL, modelId: env.EMBED_MODEL || DEFAULT_EMBED_MODEL })
    : null;
  // F3c: con NOTES_WRITE_MODE=db se montan también las tools de escritura del contrato.
  const notesServer = makeNotesServer(hmacKey, db, embedder, {
    writeMode: env.NOTES_WRITE_MODE === "db" ? "db" : "git",
  });
  const safeEqual = (a: string, b: string): boolean => {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  };
  const port = Number(env.NOTES_MCP_PORT ?? 8831);
  const host = env.NOTES_MCP_HOST ?? "127.0.0.1";
  notesHttp = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (path.startsWith("/mcp/notes/") && req.method === "POST") {
      const got = path.slice("/mcp/notes/".length).split("/")[0] ?? "";
      if (!safeEqual(got, secret)) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      void handleMcpPost(notesServer, req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  notesHttp.listen(port, host, () =>
    console.log(dim(`MCP notes ON · ${host}:${port}/mcp/notes (embeddings ${embedder ? "ON" : "OFF"})`)),
  );
} else {
  console.log(dim("MCP notes OFF (falta NOTES_MCP_SECRET o NOTES_MCP_HMAC_KEY)"));
}

// Scheduler de crons (Fase 8, lado FIRE). Sólo si el MCP schedule está configurado.
// Tick periódico: barre los crons vencidos y los dispara. Guard anti-solapamiento (en el motor).
const SCHEDULER_TICK_MS = Number(env.SCHEDULER_TICK_MS ?? 30_000);
let schedulerTimer: ReturnType<typeof setInterval> | undefined;
if (env.SCHEDULE_MCP_URL) {
  schedulerTimer = setInterval(() => {
    void fireDueCrons();
  }, SCHEDULER_TICK_MS);
  console.log(dim(`scheduler de crons ON (tick ${SCHEDULER_TICK_MS}ms)`));
}

// Clear diario de sesión por timezone (quickboot/sessions §3). Tick frecuente: barre los usuarios
// locales activos y resetea la sesión de los que cruzaron su "4am local" desde el último tick. El
// barrido es barato (no toca a nadie hasta que vence su 4am). Timer DEDICADO (no colgado del
// scheduler de crons): su cadencia y su semántica son propias. 15 min de tick basta: el clear es
// best-effort y la ventana de la madrugada es amplia.
//
// Kill-switch (`DAILY_CLEAR_ENABLED`, default ON): el clear es un job always-on que RESETEA
// sesiones de usuarios. Poder apagarlo por env —sin rollback de código— es higiene de prod: permite
// un rollout escalonado (deployás el código con el clear OFF en prod, validás en staging, y recién
// ahí lo prendés) o cortarlo en caliente si se porta mal. `false`/`0`/`off` lo desactiva.
const DAILY_CLEAR_ENABLED = !["false", "0", "off"].includes(
  (env.DAILY_CLEAR_ENABLED ?? "true").toLowerCase(),
);
const DAILY_CLEAR_TICK_MS = Number(env.DAILY_CLEAR_TICK_MS ?? 15 * 60_000);
let dailyClearTimer: ReturnType<typeof setInterval> | undefined;
if (DAILY_CLEAR_ENABLED) {
  dailyClearTimer = setInterval(() => {
    try {
      runDailyClears();
    } catch (e) {
      console.warn("daily clear:", e);
    }
  }, DAILY_CLEAR_TICK_MS);
  console.log(dim(`clear diario de sesión ON (tick ${DAILY_CLEAR_TICK_MS}ms)`));
} else {
  console.log(dim("clear diario de sesión OFF (DAILY_CLEAR_ENABLED=false)"));
}

// GC de tokens de enrollment + magic-link (cada hora). openDb los limpia al arrancar
// pero el gateway corre semanas — sin esto, las tablas crecen indefinidamente.
const tokenGcTimer = setInterval(
  () => {
    try {
      pruneEnrollTokens(db);
    } catch (e) {
      console.warn("token gc:", e);
    }
  },
  60 * 60 * 1000,
);
console.log(
  dim(`gateway arriba · env=${ceiboEnv()} · multi-usuario · polling · db=${defaultDbPath()} · sock=${sock}`),
);

// Apagado limpio.
const shutdown = async () => {
  console.log(dim("\nparando…"));
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (dailyClearTimer) clearInterval(dailyClearTimer);
  clearInterval(tokenGcTimer);
  cliChannel.close(); // canal cli (unix socket)
  remoteChannel?.close(); // canal remoto (web-server, Fase 4.3)
  controlHttp?.close(); // listener del MCP control
  stopAllFollows(); // mata los sync --follow de wacli per-usuario (Fase 9)
  await telegramChannel?.close();
  await whatsappChannel?.close(); // canal whatsapp del bot: mata su sync --follow + webhook
  closeRelays(); // suelta los relays MA vivos
  try {
    const sp = controlSockPath();
    if (existsSync(sp)) unlinkSync(sp);
  } catch {}
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Path del control socket. Al lado de la DB (no /tmp: systemd PrivateTmp lo aislaría del
// proceso CLI). GATEWAY_SOCK lo overridea.
function controlSockPath(): string {
  return process.env.GATEWAY_SOCK ?? sockPath("gateway");
}
