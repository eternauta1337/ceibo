// Entry-point del servicio web standalone (Fase 4.3). Proceso propio, aparte del gateway:
//
//   [SPA/mobile] ──HTTP/SSE──► [web-server] ──canal remoto──► [gateway] ──► [agente MA]
//                                   │  (mensajería)
//                                   └──wikis in-process──► GitHub (plano repos, sin el agente)
//
// Dos planos:
//   - MENSAJERÍA: el turno entrante (POST /api/send) se manda por el canal remoto
//     (connectRemoteChannel → gateway); la respuesta del agente vuelve como frames
//     (out/typing/heard/voice/viewer/created) que traducimos a `pushToUser` (SSE).
//   - REPOS: `wikis` in-process (App key local) → la web edita/lee notas aunque el gateway
//     esté caído (D3). El change-feed se tailea de la misma DB SQLite (multi-proceso).

import { fileURLToPath } from "node:url";
import { connectRemoteChannel, type RemoteClient, type ServerFrame } from "@ceibo/channels";
import {
  ceiboEnv,
  createEmbedder,
  DEFAULT_EMBED_MODEL,
  defaultDbPath,
  getUserBackendMode,
  getUserModel,
  listReposForUser,
  openDb,
  sockPath,
} from "@ceibo/store";
import { type Wikis, wikisFromEnv } from "@ceibo/wikis";
import { emailEnabled, sendMagicLinkEmail } from "./email.ts";
import { serverFrameToClient } from "./frames.ts";
import { defaultModelKeyForBackend, modelsForBackend } from "./models.ts";
import { makeFreezeGate } from "./notes-freeze.ts";
import { startNotesIndexer } from "./notes-indexer.ts";
import { startNotesMirror } from "./notes-mirror.ts";
import { requestSessionReset } from "./sessionReset.ts";
import { startWebServer } from "./web.ts";

process.loadEnvFile(new URL("../../../.env", import.meta.url)); // Node 22+; .env único del monorepo
const env = process.env;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

for (const k of ["WEB_SESSION_KEY", "REMOTE_CHANNEL_SECRET"]) {
  if (!env[k]) {
    console.error(`Falta ${k} en .env`);
    process.exit(1);
  }
}

const db = openDb(defaultDbPath());
// App key local → plano repos independiente del agente (D3). Opcional: sin GitHub App
// configurado el web-server arranca igual sin plano de repos (notas vía GitHub off), igual
// que el gateway. Necesario para dev local sin App propia (ver dev.md).
let wikis: Wikis | undefined;
try {
  wikis = wikisFromEnv();
} catch (e) {
  console.log(dim(`wikis OFF (${(e as Error).message}) — sin plano de repos (notas vía GitHub off)`));
}

// Google Sign-In (Fase 4.5): opt-in por env. Por default REUSA el client del oauth broker
// (`GOOGLE_CLIENT_ID/SECRET`, el mismo que conecta Gmail/Calendar al agente) — un client de
// Google por proyecto alcanza para ambos flujos (login pide sólo `openid email`; el broker pide
// las scopes de servicio). `GOOGLE_OAUTH_CLIENT_ID/SECRET` permite un client dedicado si algún
// día se separan. OJO: el redirect URI `<origin>/api/auth/google/callback` tiene que estar
// registrado en ese client (además del `/oauth/callback` del broker). Sin client o sin
// WEB_PUBLIC_ORIGIN → las rutas /api/auth/google/* devuelven 503.
const googleClientId = env.GOOGLE_OAUTH_CLIENT_ID || env.GOOGLE_CLIENT_ID;
const googleClientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;
const googleAuth =
  googleClientId && googleClientSecret && env.WEB_PUBLIC_ORIGIN
    ? {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        redirectUri: `${env.WEB_PUBLIC_ORIGIN.replace(/\/$/, "")}/api/auth/google/callback`,
      }
    : undefined;
console.log(
  dim(`google sign-in ${googleAuth ? "ON" : "OFF (falta GOOGLE_CLIENT_ID/SECRET o WEB_PUBLIC_ORIGIN)"}`),
);
// Magic link por mail (Resend): opt-in por RESEND_API_KEY + WEB_PUBLIC_ORIGIN (para armar el
// link). Sin esto, POST /api/auth/email/start devuelve 503 y sólo anda Google + el magic-link
// que reparte el bot por Telegram.
const emailLoginOn = emailEnabled() && Boolean(env.WEB_PUBLIC_ORIGIN);
console.log(
  dim(`email magic-link ${emailLoginOn ? "ON" : "OFF (falta RESEND_API_KEY o WEB_PUBLIC_ORIGIN)"}`),
);

// Cliente del canal remoto: la mensajería viaja por acá. Mutable para la reconexión.
let client: RemoteClient | undefined;
const remoteSock = env.REMOTE_CHANNEL_SOCK ?? sockPath("remote");

// Puerto por entorno: prod/dev 8820 (local), staging 8821 (convive con prod en la box).
const webPort = env.WEB_PORT ? Number(env.WEB_PORT) : ceiboEnv() === "staging" ? 8821 : 8820;

const web = startWebServer({
  db,
  port: webPort,
  bindHost: env.WEB_BIND_HOST,
  staticDir: env.WEB_STATIC_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
  sessionKey: env.WEB_SESSION_KEY as string,
  // MENSAJERÍA por el canal remoto. El turno sale por el cliente; la respuesta vuelve por onFrame.
  sendToAgent: (user, text, audio, facts, media, origin) => {
    const factsWire = facts.map((f) => ({ label: f.label, value: f.value }));
    if (audio) {
      void audio
        .fetchData()
        .then((bytes) => client?.sendAudio(user.handle, bytes, audio.mime, factsWire, origin));
    } else {
      // Texto + adjuntos (imágenes/PDF) van en el mismo frame `msg`: el modelo los ve juntos.
      client?.sendText(user.handle, text, factsWire, media, origin);
    }
  },
  // REPOS in-process (App key local): viewer + lectura/escritura de notas. Independiente del agente.
  // C1: viewerSecret gatea el path /mcp/viewer/<secret>; viewerHmacKey firma/verifica el Bearer.
  viewerSecret: env.VIEWER_MCP_SECRET,
  viewerHmacKey: env.VIEWER_MCP_HMAC_KEY,
  wikis,
  // Feature db F3c: NOTES_WRITE_MODE=db ⇒ las notas se leen/escriben contra la DB (el
  // espejo git de F3b exporta atrás). Default: git (comportamiento de siempre).
  notesWriteMode: env.NOTES_WRITE_MODE === "db" ? "db" : "git",
  // Freeze del cutover: flag por archivo (touch/rm sin restart). Default junto a la DB.
  freeze: makeFreezeGate(env.NOTES_FREEZE_FILE ?? `${defaultDbPath().replace(/[^/]*$/, "")}notes.freeze`),
  userRepoNames: (userId) => listReposForUser(db, userId).map((r) => r.name),
  // F5: para lecturas de archivos en la vista "archivo" — incluye repos archivados.
  userRepoNamesWithArchived: (userId) =>
    listReposForUser(db, userId, { includeArchived: true }).map((r) => r.name),
  // Por-usuario (workstream E): el cog muestra el roster del backend del usuario (MA → Anthropic;
  // local → roster local). Con 1 sola opción (ej. local con un único modelo) el cog la muestra
  // read-only (no cambiable); con 0 opciones no hay campo modelo. Multi-opción = seleccionable.
  chatModels: (userId) =>
    modelsForBackend(getUserBackendMode(db, userId), env).map((m) => ({ id: m.key, label: m.label })),
  userModel: (userId) =>
    getUserModel(db, userId) ?? defaultModelKeyForBackend(getUserBackendMode(db, userId)),
  wikiSyncSecret: env.WIKI_SYNC_SECRET,
  // Gate de source-IP para /api/git: solo la infra de archima puede acceder (fail-closed).
  // WIKI_GIT_ALLOWED_IPS = comma-separated, ej. "203.0.113.10". Sin var → set vacío → deniega todo.
  gitAllowedIps: env.WIKI_GIT_ALLOWED_IPS
    ? new Set(
        env.WIKI_GIT_ALLOWED_IPS.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : new Set<string>(),
  // REM batch-pull (gpuhost): Bearer de sistema (REM_BATCH_SECRET) + gate de IP (reusa
  // WIKI_GIT_ALLOWED_IPS por default). Sin secret → handler no montado.
  remBatchSecret: env.REM_BATCH_SECRET,
  // TELEGRAM_BOT_TOKEN: para el digest de REM a Telegram. Normalmente vive en gateway;
  // el web-server lo necesita para mandar el digest directamente (sin pasar por el gateway).
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  googleAuth,
  // Magic link por mail: el origin público arma el link; `sendMagicLink` queda undefined si
  // Resend no está configurado → el endpoint responde 503 (gate en web.ts).
  webPublicOrigin: env.WEB_PUBLIC_ORIGIN,
  sendMagicLink: emailEnabled() ? sendMagicLinkEmail : undefined,
  // WhatsApp es conectable sólo si el gateway tiene wacli (espeja el gate de engine.ts). El
  // web-server no manda turnos de wacli; lo usa sólo para ofrecer WhatsApp como conectable en
  // GET /api/connections (informativo; el pairing real es por chat: /connect whatsapp).
  whatsappEnabled: Boolean(env.WACLI_MCP_URL),
  // Plano de control F3: reset de sesión MA en el gateway. Se pasa como closure que captura
  // `client` (mutable: siempre usa la conexión activa en el momento de la llamada).
  resetSessions: (userIds) => requestSessionReset(userIds, client, (s) => console.log(dim(s))),
  log: (s) => console.log(dim(s)),
});

// Índice derivado de notas (feature db F1): FTS + vectores en la DB, git sigue siendo fuente
// de verdad. Corre sólo con plano de repos; NOTES_INDEX=0 lo apaga. Sin EMBED_URL indexa
// igual (léxico) y los vectores quedan pendientes hasta que el bi-encoder (gpuhost) aparezca.
if (wikis && env.NOTES_INDEX !== "0") {
  const embedder = env.EMBED_URL
    ? createEmbedder({ url: env.EMBED_URL, modelId: env.EMBED_MODEL || DEFAULT_EMBED_MODEL })
    : null;
  startNotesIndexer({ db, wikis, embedder, log: (s) => console.log(dim(s)) });
  // Espejo git una-vía (feature db F3b): exporta los writes del CONTRATO (note_versions)
  // al repo git — backup continuo + historia que sigue. Pre-cutover es un no-op (no hay
  // versiones del contrato). NOTES_MIRROR=0 lo apaga sin tocar el índice.
  if (env.NOTES_MIRROR !== "0") {
    startNotesMirror({ db, wikis, log: (s) => console.log(dim(s)) });
  }
  console.log(
    dim(`notes-index ON (embeddings ${embedder ? `ON → ${env.EMBED_URL}` : "OFF (falta EMBED_URL)"})`),
  );
} else {
  console.log(dim(`notes-index OFF (${wikis ? "NOTES_INDEX=0" : "sin wikis"})`));
}

// Frames de respuesta del agente (del gateway, por el canal remoto) → SSE del usuario. Cada
// frame trae `user` (= handle); lo resolvemos a userId y abanicamos a sus streams.
const onFrame = (f: ServerFrame): void => {
  const userHandle = "user" in f ? f.user : undefined;
  if (!userHandle) return;
  const userId = web.userIdByHandle(userHandle);
  if (userId === undefined) return;
  // `origin` (si vino): la respuesta es de un turno → entregamos sólo a la vista que preguntó.
  // Ausente: egress proactivo (crons/REM/viewer) → pushToUser abanica a todas las vistas.
  const origin = "origin" in f ? f.origin : undefined;
  // Mapeo frame→payload aislado en `frames.ts` (testeable). `undefined` = frame sin payload de
  // cliente (auth-ok/auth-err). Cada case que falte = un frame dropeado que nunca llega al browser.
  const msg = serverFrameToClient(f);
  if (msg) {
    const delivered = web.pushToUser(userId, msg, origin);
    if (f.t === "subagents" || (f.t === "activity" && f.kind === "subagent")) {
      const originLabel = origin ? origin.slice(0, 8) : "broadcast";
      const detail = f.t === "subagents" ? ` count=${f.count}` : ` label=${JSON.stringify(f.label)}`;
      console.log(
        dim(`web frame ${f.t}: user=${userId} origin=${originLabel} delivered=${delivered}${detail}`),
      );
    }
  }
};

// Conexión al gateway con reconexión simple por timer.
const connect = (): RemoteClient =>
  connectRemoteChannel({
    secret: env.REMOTE_CHANNEL_SECRET as string,
    transport: { kind: "unix", path: remoteSock },
    onFrame,
    onReady: () => console.log(dim("canal remoto: conectado al gateway")),
    onClose: () => {
      // Cubre tanto la desconexión como el arranque-en-frío (el gateway todavía no levantó
      // el socket): reintentamos cada 2s hasta conectar. La mensajería espera; el plano repos
      // (wikis in-process) sigue andando sin el canal.
      console.log(dim("canal remoto: sin conexión, reintento en 2s"));
      setTimeout(() => {
        client = connect();
      }, 2000);
    },
    log: (s) => console.log(dim(s)),
  });
client = connect();

console.log(
  dim(`web-server arriba · env=${ceiboEnv()} · http://127.0.0.1:${webPort} · db=${defaultDbPath()}`),
);

const shutdown = () => {
  console.log(dim("\nparando web-server…"));
  client?.close();
  web.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
