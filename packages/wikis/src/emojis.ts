// Sidecar de emojis por-nota (estilo Notion). Cada wiki guarda un mapa `path → emoji`
// en `.ceibo/emojis.json`, COMMITEADO al repo de la wiki por el mismo write-path que las
// notas → versiona junto con la wiki y viaja entre clones. El explorer IGNORA `.ceibo/`
// en su árbol (son metadatos, no notas).
//
// Este módulo es PURO (sin red, sin octokit): parseo tolerante + merge/clear + serialización.
// La lógica con efectos (read/write+commit) vive en `index.ts` reusando getFile/createFile/
// putFile. Se separa así para poder testear el merge/clear en node sin tocar GitHub.

/** Path repo-relativo del sidecar de emojis dentro de cada wiki. */
export const EMOJIS_PATH = ".ceibo/emojis.json";
/** Prefijo de la carpeta de metadatos de ceibo dentro de una wiki. Todo lo que cuelga de acá
 *  NO es una nota del usuario → se excluye del listado de archivos del explorer. */
export const CEIBO_DIR_PREFIX = ".ceibo/";

/** Mapa `path de nota (repo-relativo) → emoji`. */
export type EmojiMap = Record<string, string>;

/** ¿Este path es metadato interno de ceibo (carpeta `.ceibo/`)? Si lo es, NO es una nota:
 *  el listado de archivos del explorer lo filtra. */
export function isCeiboMeta(path: string): boolean {
  return path.replace(/^\/+/, "").startsWith(CEIBO_DIR_PREFIX);
}

/** Parsea el contenido del sidecar a un `EmojiMap`. TOLERANTE: JSON inválido, no-objeto, o
 *  entradas que no son `string→string no vacío` se descartan → siempre devuelve un mapa válido
 *  (vacío en el peor caso). Nunca tira: un sidecar corrupto no debe romper el explorer. */
export function parseEmojis(json: string | null | undefined): EmojiMap {
  if (!json) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: EmojiMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim() && k) out[k.replace(/^\/+/, "")] = v;
  }
  return out;
}

/** Devuelve un mapa NUEVO con `path → emoji` aplicado. Si `emoji` viene vacío/whitespace,
 *  BORRA la entrada (limpiar el emoji de una nota). No muta `map`. */
export function applyEmoji(map: EmojiMap, path: string, emoji: string): EmojiMap {
  const clean = path.replace(/^\/+/, "");
  const next: EmojiMap = { ...map };
  const trimmed = emoji.trim();
  if (trimmed) next[clean] = trimmed;
  else delete next[clean];
  return next;
}

/** Serializa el mapa al JSON que se commitea (claves ordenadas para diffs estables + newline
 *  final, como cualquier archivo de texto del repo). */
export function serializeEmojis(map: EmojiMap): string {
  const ordered: EmojiMap = {};
  for (const k of Object.keys(map).sort()) ordered[k] = map[k] as string;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
