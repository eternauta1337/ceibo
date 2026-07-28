// Modelos ofrecibles en el cog de settings de la web. SUBSET de
// `packages/gateway/src/models.ts` (la fuente de verdad, que además tiene la parte de
// publish-agent). El web-server sólo necesita {key, label, envKey} para poblar el selector
// (modelos cuya env var está presente en la box) + la default para marcar el actual.
//
// DEUDA (4.6): esta tabla y la del gateway deberían vivir en un paquete compartido para no
// driftar. El drift posible es cosmético (un label en el cog); los dos procesos corren en la
// misma box con el mismo .env, así que la lista de envKeys presentes coincide.

import type { BackendMode } from "@ceibo/store";

export interface WebChatModel {
  key: string;
  label: string;
  envKey: string;
}

export const CHAT_MODELS: WebChatModel[] = [
  { key: "haiku", label: "Haiku — rápido", envKey: "AGENT_ID" },
  { key: "sonnet", label: "Sonnet — equilibrado (default)", envKey: "AGENT_ID_SONNET" },
  { key: "opus", label: "Opus — máxima capacidad", envKey: "AGENT_ID_OPUS" },
];

export const DEFAULT_MODEL_KEY = "sonnet";

// Backend LOCAL (archima): roster de inferencia local (espeja al de gateway/src/models.ts).
export const LOCAL_MODELS: WebChatModel[] = [{ key: "gemma", label: "Gemma 4 31B — local", envKey: "" }];

export const DEFAULT_LOCAL_MODEL_KEY = "gemma";

/** Modelos del cog según el backend del usuario (MA → Anthropic publicados; local → roster local). */
export function modelsForBackend(mode: BackendMode, env: NodeJS.ProcessEnv): WebChatModel[] {
  if (mode === "local") return LOCAL_MODELS;
  return CHAT_MODELS.filter((m) => !!env[m.envKey]);
}

/** Default del modelo según backend (local → gemma; MA → sonnet). */
export function defaultModelKeyForBackend(mode: BackendMode): string {
  return mode === "local" ? DEFAULT_LOCAL_MODEL_KEY : DEFAULT_MODEL_KEY;
}
