// Dataset de emojis para el picker rico (paleta + search). Se carga LAZY (dynamic import)
// la primera vez que se abre el picker, así los ~1900 emojis + keywords no entran al bundle
// principal de la SPA — Vite los code-splitea. El resultado se cachea a nivel módulo.
//
// Fuentes: `unicode-emoji-json` (grupos + nombre/slug por emoji) y `emojilib` (char→keywords),
// ambos paquetes de SÓLO datos (MIT). El índice de búsqueda matchea sobre nombre + slug +
// keywords, para que "feliz"/"happy"/"smile" caigan en 😀 aunque su nombre sea "grinning face".

export type EmojiEntry = {
  char: string;
  name: string;
  /** términos de búsqueda ya normalizados (lowercase, sin separadores) */
  terms: string;
};

export type EmojiGroup = {
  name: string;
  slug: string;
  emojis: EmojiEntry[];
};

export type EmojiData = {
  groups: EmojiGroup[];
  /** lista plana para búsqueda */
  all: EmojiEntry[];
};

type RawEmoji = { emoji: string; name: string; slug: string };
type RawGroup = { name: string; slug: string; emojis: RawEmoji[] };

let cache: EmojiData | null = null;
let inflight: Promise<EmojiData> | null = null;

function buildTerms(e: RawEmoji, keywords: string[]): string {
  // nombre + slug (con guiones bajos como espacios) + keywords de emojilib, todo lowercase.
  const parts = [e.name, e.slug.replace(/_/g, " "), ...keywords.map((k) => k.replace(/_/g, " "))];
  return parts.join(" ").toLowerCase();
}

/** Carga (una vez) y cachea el dataset de emojis. Llamadas concurrentes comparten el mismo fetch. */
export async function loadEmojiData(): Promise<EmojiData> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const [byGroupMod, emojilibMod] = await Promise.all([
      import("unicode-emoji-json/data-by-group.json"),
      import("emojilib"),
    ]);
    const rawGroups = (byGroupMod.default ?? byGroupMod) as unknown as RawGroup[];
    const keywordsByChar = (emojilibMod.default ?? emojilibMod) as unknown as Record<string, string[]>;
    const groups: EmojiGroup[] = rawGroups.map((g) => ({
      name: g.name,
      slug: g.slug,
      emojis: g.emojis.map((e) => ({
        char: e.emoji,
        name: e.name,
        terms: buildTerms(e, keywordsByChar[e.emoji] ?? []),
      })),
    }));
    const all = groups.flatMap((g) => g.emojis);
    cache = { groups, all };
    inflight = null;
    return cache;
  })();
  return inflight;
}

/** Filtra el dataset por una query de texto (matchea sobre nombre/slug/keywords). Tokeniza la
 *  query por espacios y exige que TODOS los tokens estén presentes (AND), para búsquedas tipo
 *  "cara feliz". Vacío → null (el caller muestra la vista por categorías). */
export function searchEmojis(data: EmojiData, query: string, limit = 120): EmojiEntry[] | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const tokens = q.split(/\s+/).filter(Boolean);
  const out: EmojiEntry[] = [];
  for (const e of data.all) {
    if (tokens.every((t) => e.terms.includes(t))) {
      out.push(e);
      if (out.length >= limit) break;
    }
  }
  return out;
}
