// Construcción de la burbuja del agente en el chat. Pieza pura (testeable sin React), extraída de
// useChannel para fijar el INVARIANTE del web fix (2026-06-20):
//
//   Cada mensaje del agente es una burbuja NUEVA e INMUTABLE (append-only). NO se reusa ni se muta
//   una burbuja "en vuelo". Antes la web reusaba una sola burbuja por turno (upsert + un id ref):
//   cuando en un mismo turno llegaban DOS mensajes —el link de conexión que postea el sistema
//   out-of-band + la respuesta del modelo— el segundo PISABA al primero y el usuario veía el
//   placeholder en vez del link. Con append-only los dos coexisten y ninguno pisa al otro.
//
// El id se acuña AFUERA (en el caller) y se pasa acá, para que el caller pueda atarlo de forma
// síncrona a la reproducción de voz (voicePlayback) sin depender de cuándo React corre el updater.

import type { ChatMessage } from "./useChannel.ts";

export interface AgentBubblePatch {
  text?: string;
  mode?: "text" | "voice";
  thinking?: boolean;
  audioUrl?: string;
}

/** La burbuja del agente a partir de un id + patch (defaults: mode=text, text="", thinking=false). */
export function makeAgentBubble(id: string, patch: AgentBubblePatch): ChatMessage {
  return {
    id,
    role: "agent",
    mode: patch.mode ?? "text",
    text: patch.text ?? "",
    thinking: patch.thinking ?? false,
    audioUrl: patch.audioUrl,
  };
}

/** Appendea la burbuja como una entrada NUEVA, devolviendo un array nuevo (no muta `messages` ni
 *  ninguna burbuja previa). Este es el invariante: append-only, sin upsert. */
export function appendAgentBubble(
  messages: ChatMessage[],
  id: string,
  patch: AgentBubblePatch,
): ChatMessage[] {
  return [...messages, makeAgentBubble(id, patch)];
}
