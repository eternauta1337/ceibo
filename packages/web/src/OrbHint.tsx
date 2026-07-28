import type { Status } from "./useChannel.ts";

// Underhint del orbe: la línea de microcopy bajo el orbe (la píldora con el status básico —
// idle / grabando / pensando / hablando / conectando). Antes era un
// `<p class="orb-hint">` suelto dentro de `.orb-mover`; lo extrajimos a este componente para que
// CUALQUIER orbe pueda tener el suyo (el principal y, a futuro, los mini-orbs de sub-agentes).
//
// Es PRESENTACIONAL: no decide CUÁNDO mostrarse ni anima por sí mismo el montaje/desmontaje. La
// lógica de aparición/desaparición "hacia el orbe" (texto montado que sobrevive al vacío para
// animar la salida, el timer de desmontaje, el toggle `hintsEnabled`) vive en el caller (App.tsx).
// Acá sólo: pintar la píldora con las clases correctas (look + animación in/out) y el aria-live.
//
// Las clases preservan el contrato del CSS existente (`index.css`): `orb-hint` (look), `orb-hint-<status>`
// (variantes por estado) y `orb-hint-<phase>` (animación emerge/migrar). `variant` agrega un
// modificador opcional (`orb-hint-<variant>`) para distinguir el underhint del orbe principal del
// de un mini-orb (sub-agente) sin tocar el del principal.

export type OrbHintPhase = "in" | "out";

/** className de la píldora del underhint. PURA (testeable en node, sin DOM): arma `orb-hint`
 *  (look) + `orb-hint-<status>` + `orb-hint-<phase>` (animación) + opcional `orb-hint-<variant>`
 *  (modificador del mini-orb). Mismo contrato de clases que el `<p>` inline que reemplazó. */
export function orbHintClass(status: Status, phase: OrbHintPhase, variant?: string): string {
  return `orb-hint orb-hint-${status} orb-hint-${phase}${variant ? ` orb-hint-${variant}` : ""}`;
}

export function OrbHint({
  text,
  status,
  phase,
  variant,
}: {
  /** El texto a mostrar. Vacío → no renderiza nada (el caller controla el ciclo de vida). */
  text: string;
  /** Estado del orbe, para la clase `orb-hint-<status>` (mismo contrato que antes). */
  status: Status;
  /** Fase de animación: "in" = emerge desde el orbe, "out" = migra de vuelta y se desmonta. */
  phase: OrbHintPhase;
  /** Modificador opcional (ej. "sub" para el underhint de un mini-orb). Sin variante = el principal. */
  variant?: string;
}) {
  if (!text) return null;
  return (
    <p className={orbHintClass(status, phase, variant)} aria-live="polite">
      {text}
    </p>
  );
}
