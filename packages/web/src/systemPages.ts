// Registry de páginas de sistema: tabs especiales que NO son archivos de la wiki.
//
// Cada página de sistema es una entrada identificada por un id string literal, con su
// título, ícono (ya existente en icons.tsx) y slug de URL de un solo segmento.
// El registry es extensible: sumar una página = agregar una entrada al array y al tipo.
//
// Lógica pura (sin DOM/React/imports externos): testeable en node.

/** Identificadores de páginas de sistema disponibles (v2). */
export type SystemPage =
  | "config"
  | "agenda"
  | "conexiones"
  | "archivo"
  | "perfil"
  | "apariencia"
  | "canales"
  | "idioma";

/** Agrupado del menú del launcher: "content" = contenido vivo (Agenda/Canales/Conexiones/Archivo);
 *  "setup" = configuración personal (Perfil/Apariencia/Idioma y voz/Configuración). El separador
 *  se dibuja en cada cambio de grupo. */
export type SystemPageGroup = "content" | "setup";

/** Metadata de una página de sistema. */
export interface SystemPageMeta {
  /** Identificador estable de la página. */
  id: SystemPage;
  /** Título para mostrar en la tab y en el menú del launcher. */
  title: string;
  /** Nombre del ícono en icons.tsx. */
  icon: "settings" | "clock" | "plug" | "archive" | "message" | "user" | "palette" | "languages";
  /** Slug de URL (un solo segmento, sin `/`). Libre porque parseNoteUrl exige ≥2 segmentos. */
  slug: string;
  /** Grupo en el menú del launcher. El separador se dibuja entre el último "content" y el primero "setup". */
  group: SystemPageGroup;
}

/** Registry ordenado de páginas de sistema (orden = orden en el menú del launcher).
 *
 * v3: 8 páginas (Agenda / Canales / Conexiones / Archivo — grupo "content";
 *                Perfil / Apariencia / Idioma y voz / Configuración — grupo "setup").
 *
 * Back-compat: los ids "config" | "agenda" | "conexiones" | "archivo" de v1 siguen
 * siendo válidos (las tabs persistidas restauran igual).
 */
export const SYSTEM_PAGES: readonly SystemPageMeta[] = [
  // Grupo "content": contenido vivo que mirás seguido.
  { id: "agenda", title: "Agenda", icon: "clock", slug: "agenda", group: "content" },
  { id: "canales", title: "Canales", icon: "message", slug: "canales", group: "content" },
  { id: "conexiones", title: "Conexiones", icon: "plug", slug: "conexiones", group: "content" },
  { id: "archivo", title: "Archivo", icon: "archive", slug: "archivo", group: "content" },
  // Grupo "setup": configuración personal, lo que tocás cada tanto.
  { id: "perfil", title: "Perfil", icon: "user", slug: "perfil", group: "setup" },
  { id: "apariencia", title: "Apariencia", icon: "palette", slug: "apariencia", group: "setup" },
  { id: "idioma", title: "Idioma y voz", icon: "languages", slug: "idioma", group: "setup" },
  { id: "config", title: "Configuración", icon: "settings", slug: "config", group: "setup" },
] as const;

/** Mapa slug → SystemPage (para parsear deep-links). */
const SLUG_TO_PAGE: ReadonlyMap<string, SystemPage> = new Map(SYSTEM_PAGES.map((p) => [p.slug, p.id]));

/** Mapa id → metadata (para lookup rápido). */
const PAGE_META: ReadonlyMap<SystemPage, SystemPageMeta> = new Map(SYSTEM_PAGES.map((p) => [p.id, p]));

/** Devuelve la metadata de una página de sistema.
 *  El mapa siempre tiene una entrada por cada valor del tipo SystemPage (garantizado por
 *  la construcción del SYSTEM_PAGES registry). El fallback es defensivo, nunca alcanzable. */
export function getSystemPageMeta(page: SystemPage): SystemPageMeta {
  const meta = PAGE_META.get(page);
  if (!meta) {
    // No puede ocurrir si el tipo SystemPage y SYSTEM_PAGES están sincronizados.
    throw new Error(`BUG: página de sistema desconocida: ${page}`);
  }
  return meta;
}

/** Dado un slug de URL, devuelve el id de la página de sistema correspondiente, o null. */
export function pageFromSlug(slug: string): SystemPage | null {
  return SLUG_TO_PAGE.get(slug) ?? null;
}

/** Verifica si un string es un SystemPage válido. */
export function isSystemPage(value: unknown): value is SystemPage {
  return typeof value === "string" && PAGE_META.has(value as SystemPage);
}
