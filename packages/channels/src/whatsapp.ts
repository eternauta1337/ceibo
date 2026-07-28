// Canal WhatsApp: el número propio de ceibo (el "bot") vía wacli (whatsmeow). Mismo rol que
// Telegram — la gente le escribe al bot y el agente responde — y mismo contrato:
//   - RECEPCIÓN: `wacli sync --follow --webhook` postea cada mensaje vivo a un server HTTP
//     loopback; lo normalizamos (texto + voz + media) y se lo pasamos al core por
//     `port.handleIncoming` (el MISMO núcleo que telegram/cli/web → los slash-commands salen
//     gratis: viven en handleIncoming, no en el canal).
//   - EGRESS PROACTIVO: `postTarget(jid)` postea a un chat por `wacli send`, sin mensaje
//     entrante — la "ventanilla" para crons / digest de REM, igual que telegram.
//
// NO es el wacli per-usuario de @ceibo/mcps (ése lee el WhatsApp del usuario). Este es el
// número del bot, en un store dedicado (`wacliBotStoreDir()`), pareado aparte (scripts/pair-bot).
//
// El canal NO importa el core: recibe un `WhatsAppPort` (lo que llama al gateway). El boundary
// queda tipado y verificable por el grafo de imports.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundMedia } from "@ceibo/agent";
import { fetchWacliMediaBytes, readWacliMediaInfoByMsgId } from "@ceibo/store";
import { normVisionMime } from "./telegram.ts";
import type { ChannelPolicy, InboundAudio, PostTarget, TurnFact } from "./types.ts";
import { type ChunkMode, chunkText, WHATSAPP_HARD_LIMIT } from "./wacli-chunking.ts";
import { WacliClient } from "./wacli-client.ts";
import { WacliWebhookServer } from "./wacli-webhook-server.ts";
import {
  isGroupJid,
  jidToString,
  stripDeviceSuffix,
  type WacliWebhookMessage,
} from "./wacli-webhook-types.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

// Política del canal whatsapp: texto-nativo, eco de transcripción ON (como telegram).
export const WHATSAPP_CHANNEL: ChannelPolicy = { name: "whatsapp", echoTranscript: true };

const MAX_MEDIA_BYTES = 15 * 1024 * 1024; // tope por adjunto (req a MA ~32MB, base64 +33%)

// Lo que el canal whatsapp necesita del core (boundary tipado). Mismo shape que TelegramPort:
// sólo `handleIncoming`. El egress proactivo lo provee el canal (postTarget), no el core.
export type WhatsAppPort = {
  handleIncoming(
    channel: ChannelPolicy,
    externalId: string,
    text: string,
    thread: PostTarget,
    extras?: { audio?: InboundAudio; media?: InboundMedia[]; facts?: TurnFact[] },
  ): Promise<void>;
};

export type WhatsAppOpts = {
  /** Directorio `--store` del bot. Default: `wacliBotStoreDir()` (lo resuelve el gateway). */
  botStore: string;
  /** Path al binario wacli, o `wacli` en PATH. */
  wacliBin?: string;
  /**
   * Saltea el spawn de `wacli sync` tras `start()`. Seam SÓLO para tests — deja empujar el
   * webhook directo sin un subproceso real. Producción nunca lo setea.
   */
  skipSync?: boolean;
};

export type WhatsAppChannel = {
  /** Egress proactivo: PostTarget hacia un chat por JID, sin mensaje entrante. */
  postTarget(chatId: string): PostTarget;
  /** Arranca el canal: verifica el pairing, levanta el webhook y el `sync --follow`. */
  start(): Promise<void>;
  /** Para el follow y cierra el webhook (apagado limpio). */
  close(): Promise<void>;
};

/** Resultado de normalizar un webhook: a quién enrutar y con qué, o `null` para descartar. */
export type NormalizedInbound = {
  /** Identidad del canal (clave de `resolveUser`): el JID del remitente. */
  externalId: string;
  /** JID del chat = destino de respuesta. En DM == externalId. */
  chatId: string;
  /** ID del mensaje (coordenada para bajar media del store del bot). */
  messageId: string;
  /** Texto (o caption del adjunto). */
  text: string;
  /** Tipo de media crudo de wacli (`image`/`ptt`/`audio`/`document`/…), si hay. */
  mediaType?: string;
  /** MIME del adjunto, si hay. */
  mediaMime?: string;
  /** Nombre del archivo del adjunto, si hay. */
  mediaName?: string;
};

/**
 * Normaliza un `WacliWebhookMessage` a lo que el canal enruta, o `null` si hay que
 * descartarlo. Descartamos: ecos propios (`FromMe`), borrados (`Revoked`), reacciones
 * entrantes (v1) y **grupos** (`@g.us`) — v1 es sólo DMs, igual que el canal telegram.
 * Pura (sin I/O) → testeable sin subproceso wacli.
 */
export function normalizeWebhookMessage(msg: WacliWebhookMessage): NormalizedInbound | null {
  if (msg.FromMe) return null; // eco de nuestro propio envío
  if (msg.Revoked) return null; // borrado — nada que entregar
  if (msg.ReactionEmoji) return null; // reacción entrante — v1 no las maneja

  const chatId = stripDeviceSuffix(jidToString(msg.Chat));
  if (isGroupJid(chatId)) return null; // v1: sólo DMs
  const externalId = stripDeviceSuffix(msg.SenderJID || chatId);

  const mediaType = msg.Media ? (msg.Media.Type || "document").toLowerCase() : undefined;
  // OJO: para AUDIO, wacli rellena `Text` (y `Media.Caption`) con el placeholder "[Audio]"
  // (internal/wa/messages_media.go) — las notas de voz no llevan caption en WhatsApp. Si lo
  // tomáramos como texto, el core vería texto no-vacío y SALTEARÍA el STT. Por eso, para
  // audio/ptt, forzamos text="" → el core dispara la transcripción. El resto de los tipos
  // (imagen/video/doc) sí traen el caption real en `Text`/`Caption`.
  const isAudio = mediaType === "audio" || mediaType === "ptt";
  const out: NormalizedInbound = {
    externalId,
    chatId,
    messageId: msg.ID,
    text: isAudio ? "" : msg.Text || msg.Media?.Caption || "",
  };
  if (msg.Media) {
    out.mediaType = mediaType;
    if (msg.Media.MimeType) out.mediaMime = msg.Media.MimeType;
    if (msg.Media.Filename) out.mediaName = msg.Media.Filename;
  }
  return out;
}

export function startWhatsAppChannel(opts: WhatsAppOpts, port: WhatsAppPort): WhatsAppChannel {
  const client = new WacliClient({ bin: opts.wacliBin, store: opts.botStore });
  const webhook = new WacliWebhookServer();
  let syncProc: ChildProcess | null = null;
  let shuttingDown = false;
  let botJid: string | null = null;

  // Baja los BYTES de un adjunto del store del bot (read-only, sin lock; ver @ceibo/store).
  // Lookup por msg_id solo: el webhook entrega el chat como LID (`<id>@lid`) pero la DB indexa
  // por el phone JID, así que `chat_jid` no matchea — el `msg_id` (stanza id) sí, y es único.
  const fetchMediaBytes = async (msgId: string): Promise<Buffer> => {
    const info = readWacliMediaInfoByMsgId(opts.botStore, msgId);
    if (!info?.mediaType) throw new Error(`sin media para msg ${msgId}`);
    return fetchWacliMediaBytes(info);
  };

  // Imágenes (visión) + PDFs entrantes → InboundMedia base64. Descarta lo que el modelo no ve.
  const collectMedia = async (norm: NormalizedInbound): Promise<InboundMedia[]> => {
    const mt = norm.mediaType ?? "";
    const mime = norm.mediaMime ?? "";
    const isImg = mt === "image" || mt === "sticker" || /^image\//i.test(mime);
    const isPdf = mt === "document" && mime === "application/pdf";
    if (!isImg && !isPdf) return [];
    const buf = await fetchMediaBytes(norm.messageId);
    if (buf.length > MAX_MEDIA_BYTES) {
      await postTarget(norm.chatId).post(
        `El adjunto "${norm.mediaName ?? "(sin nombre)"}" es muy grande, no lo puedo abrir.`,
      );
      return [];
    }
    return [
      isPdf
        ? {
            kind: "document",
            data: buf.toString("base64"),
            mediaType: "application/pdf",
            filename: norm.mediaName,
          }
        : { kind: "image", data: buf.toString("base64"), mediaType: normVisionMime(mime) },
    ];
  };

  // Manda un texto, chunkeado si supera el límite duro de WhatsApp. Devuelve los ids enviados.
  const sendChunkedText = async (chatId: string, text: string): Promise<string[]> => {
    const chunks = chunkText(text, WHATSAPP_HARD_LIMIT, "newline" as ChunkMode);
    const ids: string[] = [];
    for (const c of chunks) {
      const r = await client.sendText(chatId, c);
      if (r.id) ids.push(r.id);
    }
    return ids;
  };

  // Sube una nota de voz OGG/Opus (wacli toma un --file). Equivalente al postVoice de telegram.
  const sendVoiceNote = async (chatId: string, ogg: Buffer): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "ceibo-wa-"));
    const file = join(dir, "voice.ogg");
    try {
      writeFileSync(file, ogg);
      await client.sendVoice(chatId, file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  // PostTarget hacia un chat por JID. Lo usan tanto la recepción (destino de respuesta) como
  // el egress proactivo (crons/REM). `startTyping` es no-op: a diferencia de los `send` (que wacli
  // delega al follow por IPC), `presence` NO delega → abriría otro socket que choca con el lock /
  // patea el follow. No vale el churn por un "escribiendo…".
  const postTarget = (chatId: string): PostTarget => ({
    post: async (text) => void (await sendChunkedText(chatId, text).catch(() => {})),
    startTyping: async () => {},
    postVoice: async (ogg) => void (await sendVoiceNote(chatId, ogg).catch(() => {})),
  });

  const handleWebhookMessage = async (msg: WacliWebhookMessage): Promise<void> => {
    const norm = normalizeWebhookMessage(msg);
    if (!norm) return;

    const target = postTarget(norm.chatId);
    const mt = norm.mediaType ?? "";
    let audio: InboundAudio | undefined;
    let media: InboundMedia[] | undefined;

    // Nota de voz / audio sin texto → STT (el core transcribe). Imágenes/PDF → el modelo las ve.
    if ((mt === "ptt" || mt === "audio") && !norm.text.trim()) {
      audio = { fetchData: () => fetchMediaBytes(norm.messageId), mime: norm.mediaMime };
    } else if (norm.mediaType) {
      media = await collectMedia(norm).catch((e) => {
        console.log(dim(`[whatsapp:media] ${norm.chatId}: ${(e as Error)?.message ?? e}`));
        return undefined;
      });
    }

    await port
      .handleIncoming(WHATSAPP_CHANNEL, norm.externalId, norm.text, target, {
        audio,
        media,
        // Mismo tag que web ([canal: web]) y telegram: el agente sabe POR DÓNDE le hablan —
        // distinto de las tools `wa_*` (que leen la cuenta de WhatsApp CONECTADA del usuario).
        facts: [{ label: "canal", value: "whatsapp" }],
      })
      .catch((e) => console.log(dim(`[whatsapp] handleIncoming: ${(e as Error)?.message ?? e}`)));
  };

  // `wacli sync --follow`: recibe los mensajes vivos y los postea al webhook. Mientras corre,
  // wacli levanta un send-delegate IPC (`<store>/.send.sock`) → nuestros `wacli send` se delegan
  // a ESTE proceso y salen por su conexión, sin abrir otro socket ni cortar el follow. El respawn
  // con backoff es sólo red de seguridad ante un crash genuino del follow (no por los sends).
  // `--webhook-allow-private` deja usar la URL loopback; `--download-media` deja la media en disco.
  const startSync = (): void => {
    if (shuttingDown) return;
    const args = [
      "sync",
      "--follow",
      "--download-media",
      "--store",
      opts.botStore,
      "--webhook",
      webhook.url,
      "--webhook-secret",
      webhook.webhookSecret,
      "--webhook-allow-private",
    ];
    console.log(dim(`[whatsapp] sync --follow → ${webhook.url}`));
    const proc = spawn(client.binary, args, { stdio: ["ignore", "inherit", "inherit"], env: process.env });
    syncProc = proc;
    proc.once("exit", (code, signal) => {
      syncProc = null;
      if (!shuttingDown) {
        console.log(dim(`[whatsapp] sync salió (code=${code} signal=${signal}) — respawn en 2s`));
        setTimeout(() => startSync(), 2000).unref();
      }
    });
    proc.once("error", (err) => console.log(dim(`[whatsapp] sync spawn error: ${String(err)}`)));
  };

  webhook.onMessage(handleWebhookMessage);

  return {
    postTarget,
    start: async () => {
      const status = await client.authStatus();
      if (!status.authenticated) {
        throw new Error(
          "el bot de WhatsApp no está pareado. Corré `pnpm --filter @ceibo/channels pair-bot` (con WHATSAPP_BOT_STORE) antes de arrancar el gateway.",
        );
      }
      botJid = status.linked_jid ?? status.jid ?? null;
      await webhook.listen();
      if (!opts.skipSync) startSync();
      console.log(dim(`canal whatsapp arriba · bot=${botJid ?? "?"}`));
    },
    close: async () => {
      shuttingDown = true;
      if (syncProc && !syncProc.killed) {
        syncProc.kill("SIGTERM");
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        if (syncProc && !syncProc.killed) syncProc.kill("SIGKILL");
      }
      await webhook.close();
    },
  };
}
