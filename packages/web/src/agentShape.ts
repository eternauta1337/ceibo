// Mapeo estado-del-agente → forma geométrica del orbe. Las formas dejaron de ser random-puro:
// comunican QUÉ está pasando (motivación del owner, "saber mejor qué está pasando"). Pero el owner
// pidió MÁS VARIABILIDAD mientras piensa, así que reconciliamos por TIERS de vértices en vez de una
// forma exacta por sub-fase:
//
//   · círculo            → reposo / escuchando / hablando / conectando  (estados de I/O: redondo, calmo)
//   · 3–4 lados (△ ▢)    → PENSANDO puro (razonando, sin tool)
//   · 5–6 lados (⬠ ⬡)    → USANDO UNA TOOL (hay un tool-call en vuelo, `activity` != null)
//   · 7–8 lados          → DELEGANDO en un sub-agente del roster (operación más pesada)
//
// La lectura "redondo = I/O; angular = computando, y MÁS VÉRTICES = trabajo más pesado" se mantiene
// (los tiers no se solapan), pero DENTRO del tier se elige una forma al azar por transición → más
// variabilidad visual (sumada al giro rápido random del motor). Se pierde el mapeo exacto
// "△=pensar, ▢=tool" a cambio de variedad; el TIER sigue comunicando el peso. Trade-off elegido a
// pedido del owner (ver PR).
//
// Función PURA (rng inyectable) para testearla en node, igual que subAgent.ts / orbPosition.ts: los
// tests pasan un rng determinista; prod usa Math.random. El motor del orbe además "gatea" las formas
// por estado (sólo "pensando" trae poly>0 en su config), así que cualquier estado != thinking se ve
// redondo aunque pidiéramos un polígono. Mantener ambas cosas alineadas hace el comportamiento robusto.

import type { OrbShape } from "@ceibo/orb";
import type { Status } from "./useChannel.ts";

// Tiers de formas por sub-fase del pensar (rangos de lados que NO se solapan → el tier comunica el peso).
const THINK_SHAPES = ["triangle", "square"] as const; // pensar puro: 3–4 lados
const TOOL_SHAPES = ["pentagon", "hexagon"] as const; // usando tool: 5–6 lados
const SUBAGENT_SHAPES = ["heptagon", "octagon"] as const; // sub-agente: 7–8 lados

/** Elige un elemento al azar del set (rng inyectable; clampeado al rango por seguridad). */
function pick(set: readonly OrbShape[], rng: () => number): OrbShape {
  const i = Math.min(set.length - 1, Math.max(0, Math.floor(rng() * set.length)));
  return set[i] as OrbShape;
}

/** Forma del orbe para el estado actual del agente. `activity` = label del tool-call en curso
 *  (null si no hay ninguno); `subAgentActive` = hay un sub-agente del roster trabajando ahora.
 *  `rng` se inyecta en los tests; en prod es Math.random (variabilidad por transición). */
export function shapeForAgent(
  status: Status,
  activity: string | null,
  subAgentActive: boolean,
  rng: () => number = Math.random,
): OrbShape {
  if (status !== "thinking") return "circle"; // idle / recording / speaking / connecting / unauth
  if (subAgentActive) return pick(SUBAGENT_SHAPES, rng); // delegando (gana sobre el tool-call que dispara el spawn)
  if (activity) return pick(TOOL_SHAPES, rng); // usando una tool
  return pick(THINK_SHAPES, rng); // pensando puro
}
