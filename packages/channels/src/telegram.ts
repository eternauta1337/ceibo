// Canal Telegram: bot vía Vercel Chat SDK (polling). Dos sentidos:
//   - RECEPCIÓN: el adapter entrega (thread, message); lo normalizamos (texto + audio + media)
//     y se lo pasamos al core por `port.handleIncoming` (mismo núcleo que cli/web).
//   - EGRESS PROACTIVO: `postTarget(chatId)` devuelve un PostTarget que postea a un chat por la
//     Bot API directa, SIN mensaje entrante (sin `thread` del SDK). Es la "ventanilla" que el
//     gateway usa para crons, digest de REM, etc. Esta es la pieza que web/mobile van a reusar.
//
// El canal NO importa el core: recibe un `TelegramPort` (lo que llama al gateway) y expone su
// egress. El boundary queda tipado y verificable por el grafo de imports.

import type { InboundMedia } from "@ceibo/agent";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat } from "chat";
import { MemoryStateAdapter } from "./state-memory.ts";
import type { ChannelPolicy, InboundAudio, PostTarget, TurnFact } from "./types.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

// Política del canal telegram: texto-nativo, eco de transcripción ON.
export const TELEGRAM_CHANNEL: ChannelPolicy = { name: "telegram", echoTranscript: true };

const VISION_IMAGE = /^image\/(png|jpe?g|gif|webp)$/i; // las que el modelo puede ver
const MAX_MEDIA_BYTES = 15 * 1024 * 1024; // tope por adjunto (req a MA ~32MB, base64 +33%)

// Adjunto entrante normalizado por el SDK (forma mínima que consumimos).
export type InboundAttachment = {
  type?: string;
  mimeType?: string;
  fetchData?: () => Promise<Buffer>;
  name?: string;
  size?: number;
};

// image/jpg → image/jpeg; default a jpeg si el canal no informó un MIME de visión (las fotos
// de Telegram son jpeg). Las que llegan acá ya pasaron el filtro isImg.
export function normVisionMime(mime: string): string {
  if (/^image\/jpe?g$/i.test(mime) || /^image\/jpg$/i.test(mime)) return "image/jpeg";
  return VISION_IMAGE.test(mime) ? mime.toLowerCase() : "image/jpeg";
}

// Normaliza los adjuntos del canal a InboundMedia (imágenes + PDFs). Baja los bytes y los
// codifica base64. Descarta lo que el modelo no puede ver (con un aviso al chat).
export async function collectInboundMedia(
  attachments: InboundAttachment[],
  thread: PostTarget,
): Promise<InboundMedia[]> {
  const out: InboundMedia[] = [];
  for (const a of attachments) {
    const mime = a.mimeType ?? "";
    const isImg = a.type === "image" || VISION_IMAGE.test(mime);
    const isPdf = mime === "application/pdf";
    if (!isImg && !isPdf) continue;
    if (!a.fetchData) continue;
    if (a.size && a.size > MAX_MEDIA_BYTES) {
      await thread.post(
        `El adjunto "${a.name ?? "(sin nombre)"}" es muy grande (${Math.round(a.size / 1e6)}MB), no lo puedo abrir.`,
      );
      continue;
    }
    const buf = await a.fetchData();
    if (buf.length > MAX_MEDIA_BYTES) {
      await thread.post(`El adjunto "${a.name ?? "(sin nombre)"}" es muy grande, no lo puedo abrir.`);
      continue;
    }
    out.push(
      isPdf
        ? { kind: "document", data: buf.toString("base64"), mediaType: "application/pdf", filename: a.name }
        : { kind: "image", data: buf.toString("base64"), mediaType: normVisionMime(mime) },
    );
  }
  return out;
}

// Mensaje crudo de la Bot API (escape hatch `message.raw` del SDK). El adapter NO normaliza
// `reply_to_message` (sus `extractAttachments` sólo miran el mensaje actual), pero Telegram lo
// manda cuando el usuario responde (reply) a un mensaje: ahí viven la nota de voz / el audio
// citados, con su `file_id` — re-descargable por `getFile` en cualquier momento.
type RawQuotedAudio = { file_id?: string; mime_type?: string };
export type RawReplyMessage = {
  reply_to_message?: { voice?: RawQuotedAudio; audio?: RawQuotedAudio };
};

/** Extrae el audio del mensaje CITADO (reply): el caso "reply a una nota de voz vieja +
 *  «transcribí esto»". Devuelve un InboundAudio lazy que baja los bytes por `file_id` (vía
 *  `download`), o undefined si el mensaje no es reply o el citado no trae audio/voice. El
 *  audio PROPIO del mensaje actual tiene prioridad: esto se consulta sólo cuando no hay. */
export function extractReplyAudio(
  raw: unknown,
  download: (fileId: string) => Promise<Buffer>,
): InboundAudio | undefined {
  const reply = (raw as RawReplyMessage | null | undefined)?.reply_to_message;
  const quoted = reply?.voice ?? reply?.audio;
  const fileId = quoted?.file_id;
  if (!quoted || !fileId) return undefined;
  return { fetchData: () => download(fileId), mime: quoted.mime_type };
}

// Lo que el canal telegram necesita del core (boundary tipado). Interface segregation:
// sólo `handleIncoming`. El egress proactivo lo provee el canal (postTarget), no el core.
export type TelegramPort = {
  handleIncoming(
    channel: ChannelPolicy,
    externalId: string,
    text: string,
    thread: PostTarget,
    extras?: { audio?: InboundAudio; media?: InboundMedia[]; facts?: TurnFact[] },
  ): Promise<void>;
};

export type TelegramOpts = {
  botToken: string;
  botUsername?: string;
  /** Override de la base de la Bot API (default api.telegram.org). */
  apiBaseUrl?: string;
};

export type TelegramChannel = {
  /** Egress proactivo: PostTarget hacia un chat por Bot API, sin mensaje entrante.
   *  La "ventanilla" para crons / digest de REM / cualquier push del gateway. */
  postTarget(chatId: string): PostTarget;
  /** Arranca el bot (initialize + polling) y registra el menú de slash commands. */
  start(): Promise<void>;
  /** Para el polling (apagado limpio). */
  close(): Promise<void>;
};

/** Lo mínimo que `makeDebugActivity` necesita de una respuesta de la Bot API: leer el JSON
 *  (para sacar el `message_id` del sendMessage). Estructural a propósito → testeable sin fetch. */
type BotApiResponse = { json(): Promise<unknown> };
/** POST a un método de la Bot API. La inyectamos para poder testear sin red. */
export type BotApiCall = (method: string, body: unknown) => Promise<BotApiResponse>;

/**
 * Render de actividad en modo debug (Pieza A). Para no spamear con N mensajes, edita UN solo
 * mensaje "🔧 …" por secuencia de actividad: el primer tool-call lo crea (sendMessage), los
 * siguientes lo editan in-place (editMessageText). El estado (message_id) vive en el closure
 * → se resetea solo en el próximo turno (cada turno crea un PostTarget nuevo).
 *
 * - `opts.debug` falso/ausente → no-op (el typing/sendChatAction lo maneja el gateway aparte).
 * - mismo label consecutivo → no toca nada (evita el "message is not modified" de Telegram).
 * - best-effort: si la Bot API falla, se traga (la actividad es cosmética, nunca rompe el turno).
 *
 * Exportada (con `call` inyectable) para testearla sin levantar el canal.
 */
export function makeDebugActivity(chatId: string, call: BotApiCall): NonNullable<PostTarget["activity"]> {
  let msgId: number | undefined;
  let last: string | undefined;
  return async (label, opts) => {
    if (!opts?.debug) return; // off → no rendereamos (typing lo maneja el gateway)
    // Telegram es superficie de debug → mostramos el label amable + el detalle (params) si vino.
    const text = opts.detail ? `🔧 ${label}: ${opts.detail}` : `🔧 ${label}`;
    if (text === last) return; // mismo label seguido → no tocamos (evita "not modified")
    last = text;
    try {
      if (msgId === undefined) {
        const res = await call("sendMessage", { chat_id: chatId, text });
        const json = (await res.json().catch(() => null)) as { result?: { message_id?: number } } | null;
        msgId = json?.result?.message_id;
      } else {
        await call("editMessageText", { chat_id: chatId, message_id: msgId, text });
      }
    } catch {
      /* la actividad es cosmética: nunca rompe el turno */
    }
  };
}

export function startTelegramChannel(opts: TelegramOpts, port: TelegramPort): TelegramChannel {
  const apiBase = opts.apiBaseUrl ?? "https://api.telegram.org";
  const token = opts.botToken;

  // POST a la Bot API (JSON). Lo comparte el render de debug (makeDebugActivity) y el egress.
  const botCall: BotApiCall = (method, body) =>
    fetch(`${apiBase}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // Re-descarga un archivo de Telegram por file_id (getFile → fetch del file_path). Lo usa el
  // audio CITADO (reply): el SDK sólo arma `fetchData` para los adjuntos del mensaje ACTUAL,
  // pero la Bot API permite re-bajar cualquier file_id (el del voice citado incluido).
  const downloadFile = async (fileId: string): Promise<Buffer> => {
    const res = await botCall("getFile", { file_id: fileId });
    const json = (await res.json().catch(() => null)) as { result?: { file_path?: string } } | null;
    const filePath = json?.result?.file_path;
    if (!filePath) throw new Error(`getFile sin file_path (file_id=${fileId})`);
    const file = await fetch(`${apiBase}/file/bot${token}/${filePath}`);
    if (!file.ok) throw new Error(`descarga de ${filePath}: HTTP ${file.status}`);
    return Buffer.from(await file.arrayBuffer());
  };

  // Sube una nota de voz OGG/Opus por la Bot API (multipart). En DMs, chat_id = userId.
  const sendVoice = async (chatId: string, ogg: Buffer): Promise<void> => {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("voice", new Blob([new Uint8Array(ogg)], { type: "audio/ogg" }), "voice.ogg");
    await fetch(`${apiBase}/bot${token}/sendVoice`, { method: "POST", body: form });
  };

  const telegram = createTelegramAdapter({
    botToken: token,
    mode: "polling",
    longPolling: { timeout: 30, dropPendingUpdates: true },
  });

  const bot = new Chat({
    userName: opts.botUsername || "ceibo",
    adapters: { telegram },
    state: new MemoryStateAdapter(),
  });

  // RECEPCIÓN. El thread del SDK cubre post/startTyping; le sumamos postVoice (Fase 10) vía
  // Bot API, y extraemos el adjunto de audio (nota de voz / archivo de audio) si vino.
  bot.onDirectMessage(async (thread, message) => {
    if (message.author.isMe) return;
    const chatId = message.author.userId;
    const base = thread as unknown as PostTarget;
    const target: PostTarget = {
      post: (t) => base.post(t),
      startTyping: () => base.startTyping(),
      postVoice: (ogg) => sendVoice(chatId, ogg),
      activity: makeDebugActivity(chatId, botCall),
    };
    const attachments = (message.attachments ?? []) as InboundAttachment[];
    const att = attachments.find((a) => a.type === "audio");
    const fetchData = att?.fetchData;
    const ownAudio: InboundAudio | undefined = fetchData
      ? { fetchData: () => fetchData() as Promise<Buffer>, mime: att?.mimeType }
      : undefined;
    // Reply-to-transcribe: si el mensaje actual NO trae audio propio pero es un reply a una
    // nota de voz / audio, ese audio citado viaja como el `audio` del turno (mismo camino
    // `extras.audio` → STT en el gateway). El audio propio siempre tiene prioridad.
    const audio = ownAudio ?? extractReplyAudio(message.raw, downloadFile);
    // Imágenes y PDFs entrantes (Fase 16): el modelo los ve/lee. Los normaliza y baja
    // collectInboundMedia; el audio sigue su propio camino (STT).
    const media = ownAudio
      ? undefined
      : await collectInboundMedia(attachments, target).catch((e) => {
          console.log(dim(`[media] user ${chatId}: ${(e as Error)?.message ?? e}`));
          return undefined;
        });
    await port.handleIncoming(TELEGRAM_CHANNEL, chatId, message.text, target, {
      audio,
      media,
      // El agente sabe POR DÓNDE le hablan (mismo tag que manda la web: [canal: web]) →
      // mata la confusión "¿me hablás por WhatsApp?" cuando piden transcribir un audio.
      facts: [{ label: "canal", value: "telegram" }],
    });
  });

  // EGRESS PROACTIVO. PostTarget que postea a un chat por chat_id sin mensaje entrante.
  const postTarget = (chatId: string): PostTarget => {
    return {
      post: async (text) => void (await botCall("sendMessage", { chat_id: chatId, text }).catch(() => {})),
      startTyping: async () =>
        void (await botCall("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {})),
      postVoice: async (ogg) => void (await sendVoice(chatId, ogg).catch(() => {})),
      activity: makeDebugActivity(chatId, botCall),
    };
  };

  // Registra el menú de slash commands (autocomplete al tocar "/"). El adapter NO lo hace;
  // es una llamada directa a la Bot API. Best-effort.
  const registerSlashCommands = async (): Promise<void> => {
    const commands = [
      { command: "new", description: "Nueva sesión" },
      {
        command: "compact",
        description: "Compactar la conversación (achica el contexto sin perder el hilo)",
      },
      { command: "status", description: "Estado de la sesión: backend, modelo, tamaño del contexto" },
      { command: "connect", description: "Conectar una cuenta: /connect <servicio> <perfil>" },
      { command: "disconnect", description: "Desconectar una cuenta: /disconnect <servicio> [perfil]" },
      { command: "connections", description: "Ver qué tenés conectado" },
      { command: "voice", description: "Voz: /voice list · /voice <id> · /voice rate|pitch|volume" },
      { command: "language", description: "Idioma: /language list · /language <id> (es/en)" },
      {
        command: "model",
        description: "Modelo: /model list · /model <id> (haiku/sonnet/opus) — reinicia el contexto",
      },
      {
        command: "wiki",
        description: "Wikis: /wiki list · /wiki set <nombre|all> · /wiki label <wiki> <alias>",
      },
      { command: "rem", description: "Consolidar wikis: /rem <wiki> · /rem all (junta, ordena, limpia)" },
      { command: "agenda", description: "Tus recordatorios: /agenda · /agenda cancel <id>" },
      { command: "debug", description: "Modo debug: /debug on · /debug off (mostrar los pasos del agente)" },
      { command: "stop", description: "Interrumpir al agente" },
      { command: "session", description: "Id de sesión actual" },
      { command: "web", description: "Link para entrar a la UI web (voz + wiki)" },
    ];
    try {
      const res = await fetch(`${apiBase}/bot${token}/setMyCommands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commands }),
      });
      console.log(
        dim(res.ok ? `slash commands registrados (${commands.length})` : `setMyCommands HTTP ${res.status}`),
      );
    } catch (e) {
      console.log(dim(`setMyCommands error: ${(e as Error)?.message ?? e}`));
    }
  };

  return {
    postTarget,
    start: async () => {
      await bot.initialize(); // wiring del Chat instance en los adapters
      await telegram.startPolling(); // arranca el loop de getUpdates (mantiene vivo el proceso)
      void registerSlashCommands(); // menú "/" (best-effort)
    },
    close: async () => {
      await telegram.stopPolling().catch(() => {});
    },
  };
}
