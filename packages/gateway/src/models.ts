// Modelos ofrecibles como coordinador del chat (/model en Telegram, cog de settings en
// la web). En MA el modelo es atributo del AGENTE, no de la sesión: la API no acepta
// `model` en sessions.create/update. Por eso cada opción es un agente coordinador COMPLETO
// (mismo system/mcp/tools/skill + roster de workers) publicado con distinto `model`.
// Cambiar de modelo ⇒ recrear la sesión apuntando a otro agentId. Es un cambio LIMPIO:
// se reinicia el contexto conversacional (la wiki sobrevive, se re-clona del substrato).
// El handoff por resumen ("compactación") quedó anotado pero NO implementado.
//
// haiku es el PRINCIPAL (es AGENT_ID, el agente de siempre de la box). sonnet/opus son
// coordinadores extra que publica `publish-agent.ts` (ids en AGENT_ID_SONNET / AGENT_ID_OPUS);
// si su env var no está, la box simplemente no ofrece ese modelo.
//
// El DEFAULT (lo que recibe quien no eligió con /model) es sonnet — preferencia de producto,
// distinta de quién es el principal. Requiere AGENT_ID_SONNET publicado en la box; si faltara,
// agentIdForUser cae con gracia al principal (haiku/AGENT_ID).
//
// BACKEND-AWARE (workstream E): los modelos ofrecibles son POR BACKEND. Un usuario MA ve los
// coordinadores de Anthropic (CHAT_MODELS, abajo); uno `local` (archima) ve el roster que sirve
// la inferencia local (LOCAL_MODELS). Para un usuario local el modelo NO es un agentId de MA: es
// el modelo que sirve opencode en su vm gpuhost (hoy Gemma 4 31B).

import type { BackendMode } from "@ceibo/store";

export interface ChatModel {
  /** Clave estable: la que el usuario tipea (`/model <key>`) y la que se guarda en la DB. */
  key: string;
  /** Etiqueta visible (Telegram + cog de la web). */
  label: string;
  /** model-id de Anthropic con que se publica el agente coordinador. */
  model: string;
  /** env var con el agentId del coordinador. El default (haiku) reusa AGENT_ID. */
  envKey: string;
  /** Nombre del agente en MA (sólo lo usa publish-agent al crear las variantes extra). */
  agentName: string;
}

// Los model-id están alineados con el roster de workers de publish-agent (haiku-4-5 /
// sonnet-4-6 / opus-4-7) para no driftar. Bumpear opus→4.8 es un cambio de una línea acá.
export const CHAT_MODELS: ChatModel[] = [
  {
    key: "haiku",
    label: "Haiku — rápido",
    model: "claude-haiku-4-5-20251001",
    envKey: "AGENT_ID",
    agentName: "ceibo",
  },
  {
    key: "sonnet",
    label: "Sonnet — equilibrado (default)",
    model: "claude-sonnet-4-6",
    envKey: "AGENT_ID_SONNET",
    agentName: "ceibo-sonnet",
  },
  {
    key: "opus",
    label: "Opus — máxima capacidad",
    model: "claude-opus-4-7",
    envKey: "AGENT_ID_OPUS",
    agentName: "ceibo-opus",
  },
];

/** Modelo por defecto del chat: el que recibe un usuario sin preferencia y el que `/model`
 *  guarda como "sin preferencia" (null). Preferencia de producto, NO el principal. */
export const DEFAULT_MODEL_KEY = "sonnet";

/** El coordinador principal = el agente AGENT_ID de la box (su modelo lo preserva
 *  publish-agent, NO se re-publica como extra). Es haiku por cómo se creó AGENT_ID;
 *  independiente de cuál sea el default de cara al usuario. */
export const PRINCIPAL_MODEL_KEY = "haiku";

/** Las variantes que publish-agent crea/actualiza como coordinadores aparte: todo salvo el
 *  principal/AGENT_ID (incluye el default, que hoy no es el principal). */
export const EXTRA_COORDINATORS = CHAT_MODELS.filter((m) => m.key !== PRINCIPAL_MODEL_KEY);

// --- Backend LOCAL (archima) ---------------------------------------------------------------
// El roster que sirve la inferencia local de archima. `model` = id de opencode
// (provider/model), no de Anthropic. envKey/agentName NO aplican a local (son MA-only: estos
// modelos no se publican como agentes MA ni pasan por resolveAgentId/publish-agent) — van con
// valores inertes sólo para satisfacer el tipo.
export const LOCAL_MODELS: ChatModel[] = [
  {
    key: "gemma",
    label: "Gemma 4 31B — local",
    model: "local/gemma4-31b",
    envKey: "",
    agentName: "ceibo-local",
  },
];

/** Default local: el que recibe un usuario `local` sin elección explícita. */
export const DEFAULT_LOCAL_MODEL_KEY = "gemma";

export function localModelsForEnv(env: NodeJS.ProcessEnv): ChatModel[] {
  const gemmaModel = env.ARCHIMA_GEMMA_MODEL_ID ?? env.ARCHIMA_WORKER_MODEL_ID ?? env.ARCHIMA_MODEL_ID;
  const gemma = LOCAL_MODELS[0] as ChatModel;
  return [
    {
      ...gemma,
      model: gemmaModel ?? gemma.model,
    },
  ];
}

/** Modelos ofrecibles para un backend. MA → coordinadores Anthropic publicados (gated por su
 *  agentId env); local → el roster de inferencia local. La fuente de verdad de qué ve cada
 *  usuario en `/model` y el cog web. */
export function modelsForBackend(mode: BackendMode, env: NodeJS.ProcessEnv): ChatModel[] {
  if (mode === "local") return localModelsForEnv(env);
  return CHAT_MODELS.filter((m) => !!env[m.envKey]);
}

/** Default del modelo según backend (local → gemma; MA → sonnet). */
export function defaultModelKeyForBackend(mode: BackendMode): string {
  return mode === "local" ? DEFAULT_LOCAL_MODEL_KEY : DEFAULT_MODEL_KEY;
}
