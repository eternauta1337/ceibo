/** Helper PURO para el gesto de swipe-up → manos libres.
 *  Extraído del componente para poder testearlo sin DOM. */

/** Píxeles mínimos hacia arriba (dedo se mueve en Y negativa) para confirmar un swipe-up. */
export const SWIPE_UP_PX = 64;

/**
 * Devuelve `true` si el movimiento del dedo desde `startY` hasta `currentY`
 * alcanza el umbral de swipe-up.
 *
 * @param startY    clientY en el momento del pointerdown
 * @param currentY  clientY actual (pointermove)
 * @param threshold píxeles mínimos (default: SWIPE_UP_PX)
 */
export function shouldEnterHandsfree(startY: number, currentY: number, threshold = SWIPE_UP_PX): boolean {
  return startY - currentY >= threshold;
}
