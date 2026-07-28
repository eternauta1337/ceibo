// Remapeo PURO de entradas de pestaña cuando un archivo (o carpeta) se renombra/mueve.
//
// El problema que resuelve: al renombrar/mover desde el explorer, el path de un archivo cambia
// (fromPath → toPath). Las pestañas que apuntaban al path VIEJO (sea la activa o una de fondo,
// sea la entrada actual o una enterrada en el historial back/forward) quedaban apuntando a un
// path que ya no existe → al clickearlas el server tira 404 y la pestaña se cierra sola
// (pérdida silenciosa). En vez de CERRAR la pestaña, la SEGUIMOS: reescribimos toda entrada que
// apunte al path viejo para que apunte al nuevo. Así la pestaña abierta "sigue" al archivo.
//
// Es puro (sin estado, sin React) para testearlo en node; el glue con el estado vive en
// useChannel.remapTabs. Cubre dos formas de op:
//   - archivo: fromPath EXACTO → toPath.
//   - carpeta: todo path bajo `fromPath/` → reescrito al prefijo `toPath/` (el move de carpeta
//     es multi-archivo; remapeamos por prefijo en una sola pasada).

/** Forma mínima de una entrada de pestaña que este helper toca. Las entradas de sistema
 *  (sin repo/path) NO matchean nunca y pasan tal cual; se modelan como `kind:"system"`. */
export type RemapEntry =
  | { kind?: "note"; repo: string; path: string; title: string }
  | { kind: "system"; [k: string]: unknown };

export interface RemapTab {
  id: string;
  entries: RemapEntry[];
  cursor: number;
}

/** Mapea un path viejo a uno nuevo bajo una op de rename/move.
 *  - `isFolder=false`: matchea SOLO el path exacto (`path === fromPath`).
 *  - `isFolder=true`: matchea el propio `fromPath` y todo lo que cuelgue de `fromPath/`,
 *    reescribiendo el prefijo a `toPath`.
 *  Devuelve el path nuevo, o `null` si no aplica (no hay que tocar la entrada). */
export function remapPath(path: string, fromPath: string, toPath: string, isFolder: boolean): string | null {
  if (path === fromPath) return toPath;
  if (isFolder && path.startsWith(`${fromPath}/`)) {
    return `${toPath}${path.slice(fromPath.length)}`;
  }
  return null;
}

/** Recomputa el título visible de la tira a partir del path (último segmento, sin `.md`).
 *  Mismo criterio que `tabTitleOf` en useChannel; lo duplicamos acá para mantener el helper
 *  puro y autónomo (sin importar useChannel, que arrastra React). */
export function tabTitleFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/, "");
}

/** Reescribe TODAS las entradas (de todas las pestañas, en todo el historial) cuyo path caiga
 *  bajo la op, sin tocar el `id`, el `cursor`, ni el orden de las pestañas — así el editor no
 *  remontea (cursor preservado) y la pestaña activa no cambia. Devuelve un nuevo array sólo si
 *  algo cambió; si nada matcheó devuelve el array original (identidad estable → evita re-render).
 *
 *  Sólo remapea entradas del `repo` dado (el move/rename es siempre intra-repo). */
export function remapTabsEntries<T extends RemapTab>(
  tabs: T[],
  repo: string,
  fromPath: string,
  toPath: string,
  isFolder: boolean,
): T[] {
  let anyChanged = false;
  const next = tabs.map((t) => {
    let tabChanged = false;
    const entries = t.entries.map((e) => {
      if (e.kind === "system" || e.repo !== repo) return e;
      const np = remapPath(e.path, fromPath, toPath, isFolder);
      if (np === null) return e;
      tabChanged = true;
      return { ...e, path: np, title: tabTitleFromPath(np) };
    });
    if (!tabChanged) return t;
    anyChanged = true;
    return { ...t, entries };
  });
  return anyChanged ? next : tabs;
}

/** Variante CROSS-WIKI de `remapTabsEntries`: la nota sale del repo `fromRepo` y aparece en
 *  `toRepo` (el move cross-wiki es la única op que cambia el repo de una entrada). Matchea por
 *  `(fromRepo, path)` y reescribe TANTO el `repo` como el `path` de la entrada, así la pestaña
 *  abierta sigue al archivo a su nueva wiki (mismo principio que el intra-repo: seguir, no cerrar).
 *
 *  Hoy sólo soportamos archivos cross-wiki (no carpetas, ver Explorer), pero `isFolder` se acepta
 *  para mantener el contrato simétrico con `remapTabsEntries` y dejar abierto el move de carpeta. */
export function remapTabsEntriesCross<T extends RemapTab>(
  tabs: T[],
  fromRepo: string,
  fromPath: string,
  toRepo: string,
  toPath: string,
  isFolder: boolean,
): T[] {
  let anyChanged = false;
  const next = tabs.map((t) => {
    let tabChanged = false;
    const entries = t.entries.map((e) => {
      if (e.kind === "system" || e.repo !== fromRepo) return e;
      const np = remapPath(e.path, fromPath, toPath, isFolder);
      if (np === null) return e;
      tabChanged = true;
      return { ...e, repo: toRepo, path: np, title: tabTitleFromPath(np) };
    });
    if (!tabChanged) return t;
    anyChanged = true;
    return { ...t, entries };
  });
  return anyChanged ? next : tabs;
}
