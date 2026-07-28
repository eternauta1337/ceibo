// La "cara" de un usuario, compartida entre el explorer (chips de miembros de una wiki) y
// el blame por línea (avatar del autor de un tramo): MISMO mecanismo en los dos lados —
// foto de /api/avatar/<handle> si el usuario subió una (`hasAvatar`), fallback a las
// iniciales del nombre en un círculo gris estable por handle si no (o si la foto falla).
// Acá viven las piezas puras + la URL; el markup lo arma cada lado (React en el explorer,
// DOM imperativo en el widget CM6 del blame) con las MISMAS clases de memberChips.css.

/** URL de la foto de un handle. Mutable a propósito (objeto, no export directo): el harness
 *  de browser la stubea (en `vite dev` no hay backend con avatares). */
export const avatarSrc = {
  of: (handle: string): string => `/api/avatar/${encodeURIComponent(handle)}`,
};

/** Variación estable por handle: un % de mezcla derivado de un hash simple. Por ahora el chip
 *  va en ESCALA DE GRISES acorde al tema (el CSS mezcla el --fg sobre el --surface con este
 *  porcentaje); el % por usuario sólo cambia el tono de gris para distinguirlos, sin color.
 *  Banda 56–82%: siempre bien cargado hacia el --fg → el texto (= --surface) contrasta en
 *  claro y oscuro. (Cuando haya diseño de avatares de verdad, esto vuelve a tener color.) */
export function chipMix(handle: string): string {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  return `${56 + (h % 27)}%`;
}

/** Iniciales de un nombre: 2 letras (primera de las dos primeras palabras, o las 2 primeras
 *  letras si es una sola palabra). En mayúsculas. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  return (parts[0] ?? "?").slice(0, 2).toUpperCase();
}
