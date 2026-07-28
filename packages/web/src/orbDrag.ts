/** Helper PURO para el arrastre del orbe durante el swipe-up a manos libres.
 *  Extraído del componente para poder testearlo sin DOM. */

/** Máximo de píxeles que el orbe puede subir desde su posición de reposo.
 *  Elegido para que el orbe quede bien visible (no suba hasta el top de la pantalla)
 *  pero igualmente refleje un gesto expresivo. */
export const ORB_DRAG_MAX_PX = 160;

/**
 * Calcula el offset vertical del orbe durante el drag.
 *
 * @param startY   clientY en el momento del pointerdown
 * @param currentY clientY actual (pointermove)
 * @param max      máximo de subida en px (default: ORB_DRAG_MAX_PX)
 * @returns translateY en px (≤0, nunca positivo — el orbe solo sube)
 */
export function clampDragDy(startY: number, currentY: number, max = ORB_DRAG_MAX_PX): number {
  const dy = currentY - startY; // negativo si el dedo subió
  return Math.max(-max, Math.min(0, dy));
}
