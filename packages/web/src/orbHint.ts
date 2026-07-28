import type { Status } from "./useChannel.ts";

/** Microcopy del hint bajo el orbe: SÓLO el status básico (idle / grabando / pensando /
 *  hablando / conectando). El detalle del tool-call en curso NO va acá
 *  — vive como indicador efímero en el chat (ver ChatActivityIndicator). */
export function computeOrbHint(
  status: Status,
  activity: string | null,
  subagentCount: number,
  handsfree: boolean,
  hasSubHint = false,
): string {
  if (handsfree) return "Tocá para terminar";
  if (status === "connecting") return "conectando…";
  if (status === "recording") return "Tocá para terminar";
  // Mientras piensa/habla, si hay un tool-call en curso mostramos su label AMABLE real (ej.
  // "web search", "actualizando una nota") igual que el indicador del chat — más informativo
  // que el genérico "pensando…". Sin actividad en vuelo, cae al estado básico. El label ya
  // viene humanizado (sin params ni jerga) desde `activityLabel` (@ceibo/channels).
  if (status === "thinking") return activity || "pensando…";
  if (status === "speaking") return activity || "hablando…";
  // EXCEPCIÓN (delegación v2): el orb está LIBRE (idle) pero hay ≥1 sub-agente vivo trabajando en
  // background (el gateway cerró el turno tras el spawn y dejó el conteo en >0). Mostramos el
  // underhint de delegación en vez del "mantené presionado" → el usuario ve que su pedido sigue en
  // curso aunque pueda seguir hablando. Persiste mientras el worker trabaje (count cae a 0 al terminar).
  // PERO si el SEGUNDO underhint (mini-orbs: "Corriendo N subagentes") ya está visible (`hasSubHint`),
  // ese cubre el caso → el principal NO duplica con "subagente creado" y vuelve al idle normal.
  if (subagentCount > 0 && !hasSubHint) return "subagente creado";
  return "Tocá para hablar"; // idle
}

/** Texto del SEGUNDO underhint (bajo el principal) cuando hay sub-agentes vivos: "Corriendo N
 *  subagentes" (singular si N==1). `count` = `subagentCount` que la web ya tiene del frame
 *  `subagents`. N ≤ 0 → "" (el caller no lo renderiza). Pura y testeable. */
export function subagentCountHint(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "Corriendo 1 subagente" : `Corriendo ${count} subagentes`;
}
