// Punto de entrada del paquete `@ceibo/channels`. Reexporta el contrato compartido
// (tipos channel-agnostic), los canales concretos (cli, telegram, whatsapp) y el canal
// remoto (protocolo + servidor + cliente).

export { type ActivityParts, activityLabel, isSubagentLabel, SUBAGENT_SPAWNED_HINT } from "./activity.ts";
export { CLI_CHANNEL, type CliChannel, type CliPort, startCliChannel } from "./cli.ts";
export { connectRemoteChannel, type RemoteClient, type RemoteClientOpts } from "./client.ts";
export {
  type ActivityFrame,
  type AnyFrame,
  type ChatTitleFrame,
  type ClientFrame,
  type ControlFrame,
  checkAuth,
  createFrameDecoder,
  deriveConnSecret,
  encodeFrame,
  type MediaWire,
  type ServerFrame,
  type TurnFactWire,
} from "./protocol.ts";
export {
  REMOTE_CHANNEL,
  type RemoteChannel,
  type RemoteOpts,
  type RemotePort,
  startRemoteChannel,
} from "./remote.ts";
export {
  startTelegramChannel,
  TELEGRAM_CHANNEL,
  type TelegramChannel,
  type TelegramOpts,
  type TelegramPort,
} from "./telegram.ts";
export type { ChannelPolicy, InboundAudio, PostTarget, TurnFact } from "./types.ts";
export {
  type NormalizedInbound,
  normalizeWebhookMessage,
  startWhatsAppChannel,
  WHATSAPP_CHANNEL,
  type WhatsAppChannel,
  type WhatsAppOpts,
  type WhatsAppPort,
} from "./whatsapp.ts";
