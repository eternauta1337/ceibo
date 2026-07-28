// Estado del indicador DEDICADO y PERSISTENTE de sub-agente (issue #29). Distinto del indicador
// efímero de actividad del chat (`activity`), que se sobreescribe con CADA tool-call y por eso un
// spawn de sub-agente parpadeaba un frame y quedaba tapado. Este indicador se ENCIENDE cuando llega un
// frame `activity` marcado `kind:"subagent"` y se mantiene hasta el FIN REAL DEL TURNO, reflejando
// que el agente sigue apoyándose en un especialista durante TODO el turno.
//
// FIN DE TURNO (v2): el indicador se apaga con el frame `turn-done` (lo emite el gateway en
// `turnComplete` = `session.status_idle` con `end_turn`, la señal LIMPIA de "el turno terminó"), o
// con un `error` terminal. Antes se apagaba con el PRIMER `text`/`voice` — pero el agente postea
// TEXTO INTERMEDIO durante el turno (ej. "ya lo busco…" y DESPUÉS el resumen), y ese `text`
// apagaba el badge antes de tiempo (el bug que reportó el owner). Por eso text/voice ya NO apagan.
// (Un turno nuevo del usuario también lo resetea, vía `pushUserMsg` en useChannel — red de seguridad.)
//
// La lógica vive acá como función PURA (sin React) para poder testearla en node (la web corre sus
// tests en entorno node, sin jsdom). El hook (`useChannel`) sólo llama a
// `subAgentFromFrame` en su handler de SSE y a `null` al arrancar un turno.

/** El sub-agente activo del turno: su `label` amable ("consultando a un especialista") y, opcional,
 *  el `detail` (tier/modelo: haiku/sonnet/opus). `null` = no hay sub-agente activo ahora. */
export type SubAgentState = { label: string; detail?: string } | null;

/** Forma mínima del frame SSE que nos interesa para el indicador. */
type Activityish = { t: string; kind?: string; label?: string; detail?: string };

/** Forma mínima del frame para el conteo de sub-agentes (mini-orbs). */
type Countish = { t: string; count?: number };

/**
 * Próximo conteo de sub-agentes activos (= cuántos mini-orbs decoran el orb) dado el frame entrante
 * y el conteo actual. El frame `subagents` es la ÚNICA fuente de verdad: es el conteo ABSOLUTO que
 * manda el gateway (no un delta) y el gateway lo re-afirma en cada borde (después de CADA turn-done
 * vía turnComplete, al registrar un worker async y al terminar éste).
 * - frame `subagents` → adopta `count` (clamp a ≥0).
 * - cualquier otro frame → NO toca el conteo.
 *
 * DELEGACIÓN v2: turn-done/error YA NO resetean a 0. El reset en turn-done venía de MA cloud,
 * donde los sub-agentes (`task`) viven DENTRO del turno — pero ahí el gateway ya manda el
 * `subagents` absoluto (0) justo después del turn-done, así que el reset local era redundante…
 * y CLOBBEREABA el caso nuevo: los workers async de archima SOBREVIVEN al turno (el spawn cierra
 * el turno al instante), y el reset local apagaba su mini-orb/underhint apenas nacía. Lo mismo
 * con el reset al arrancar un turno del usuario (pushUserMsg): mataba el orb del worker vivo
 * mientras el usuario seguía charlando. Peor caso sin resets locales: un conteo stale tras un
 * crash del gateway, que se autocorrige con el próximo turno cerrado (re-afirmación) o un reload.
 * Pura y testeable (igual que `subAgentFromFrame`); el hook la llama en su handler de SSE.
 */
export function subagentCountFromFrame(prev: number, msg: Countish): number {
  if (msg.t === "subagents") return Math.max(0, msg.count ?? 0);
  return prev;
}

/**
 * Próximo estado del indicador dado el frame entrante y el estado actual.
 * - frame `activity` con `kind:"subagent"` y `label` → ENCIENDE (set con label/detail).
 * - frame `turn-done` (fin real del turno) o `error` (terminal) → APAGA (`null`).
 * - cualquier otro frame (incluido `text`/`voice` INTERMEDIO, un `activity` normal de tool-call,
 *   `heard`, `typing`, `refresh`, …) → NO toca el estado (el sub-agente sigue activo TODO el turno).
 */
export function subAgentFromFrame(prev: SubAgentState, msg: Activityish): SubAgentState {
  if (msg.t === "activity" && msg.kind === "subagent" && msg.label) {
    return { label: msg.label, ...(msg.detail ? { detail: msg.detail } : {}) };
  }
  if (msg.t === "turn-done" || msg.t === "error") return null;
  return prev;
}

/** Cómo presentamos cada tier del roster (el `detail` del frame trae el tier crudo): nombre del
 *  modelo + una palabra de capacidad family-friendly. `worker-high`=opus es el "especialista";
 *  sonnet el "intermedio"; haiku el "rápido". */
const TIER_PRESENTATION: Record<string, { model: string; capability: string }> = {
  haiku: { model: "Haiku", capability: "rápido" },
  sonnet: { model: "Sonnet", capability: "intermedio" },
  opus: { model: "Opus", capability: "especialista" },
};

/** Contenido a pintar en el badge persistente: el `head` FIJO del turno (modelo + capacidad, o
 *  el label amable si no conocemos el tier) y la `activity` LIVE (lo que el sub-agente hace ahora,
 *  cambia con cada tool-call; undefined si todavía no hay nada en vuelo). */
export interface SubAgentBadge {
  head: string;
  activity?: string;
}

/** Combina el sub-agente (persistente: modelo + capacidad) con su actividad en curso (efímera).
 *  Ej.: `{ head: "Sonnet · intermedio", activity: "buscando en la web" }`. Pura y testeable. */
export function subAgentBadge(state: NonNullable<SubAgentState>, activity: string | null): SubAgentBadge {
  const tier = state.detail ? TIER_PRESENTATION[state.detail.toLowerCase()] : undefined;
  const head = tier ? `${tier.model} · ${tier.capability}` : state.label;
  return activity ? { head, activity } : { head };
}
