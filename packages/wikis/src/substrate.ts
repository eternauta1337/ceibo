// Contrato git-shaped del substrato de wikis.
//
// Los clientes (el sandbox del agente, la vista web) trabajan sobre una working copy LOCAL
// y SINCRONIZAN con el substrato por estas operaciones — no hacen micro-commits por edición.
// Hidratan con `read`/`tree`, traen deltas con `changesSince`, y pushean con `commit`.
//
// Decisión 1-A (concurrencia): `commit` detecta conflictos POR-PATH. Dos escritores que
// tocan paths distintos se auto-mergean; sólo conflictúa el path que ambos tocaron.
//
// Este módulo es PURO (sin octokit): los tipos + la lógica de conflicto, testeable sola.
// La implementación sobre la Git Data API vive en index.ts.

/** Un cambio a aplicar en un commit: escribir un path (con contenido) o borrarlo.
 *
 *  `base` (optimista por-path, "la edición manual gana"): el blob sha que el escritor CREE que
 *  está vivo en HEAD para ese path en el momento de armar el cambio (su última versión conocida).
 *    - `string`  → "espero que HEAD[path] sea ESTE blob" (edit/delete de algo que ya tenía).
 *    - `null`    → "espero que el path NO exista en HEAD" (create).
 *    - ausente   → cliente legacy (no declara base): el server cae al modelo baseRef-vs-HEAD.
 *  El server rechaza el cambio si el HEAD real no coincide con `base` (otro escritor lo tocó en
 *  el medio) → nunca pisás una edición que no viste. Ver `conflictingChanges`. */
export type Change =
  | { op: "put"; path: string; content: string; base?: string | null }
  | { op: "delete"; path: string; base?: string | null };

/** Resultado de `commit`: ok con el nuevo ref (commit sha), o conflicto con los paths
 *  en conflicto (el cliente re-baja esos y reintenta — mismo modelo que el 409 de hoy). */
export type CommitResult = { ok: true; ref: string } | { ok: false; conflictPaths: string[] };

/** Foto del repo a un ref: el ref (commit sha) + los archivos pedidos con su blob sha. */
export interface WikiSnapshot {
  ref: string;
  files: { path: string; content: string; sha: string }[];
}

/** Árbol del repo a un ref: sólo los paths (blobs), sin contenido. */
export interface WikiTree {
  ref: string;
  paths: string[];
}

/** Delta entre un `baseRef` y HEAD: archivos cambiados (con contenido) y borrados. */
export interface WikiDelta {
  ref: string;
  changed: { path: string; content: string; sha: string }[];
  deleted: string[];
}

/** Conflicto por-path (Decisión 1-A). Un path que vamos a tocar conflictúa SÓLO si su blob
 *  cambió entre `baseRef` y HEAD (otro escritor lo tocó en el medio). Los árboles se pasan
 *  como Map<path, blobSha>; un path ausente del map = no existe en ese commit. Un path con
 *  blob idéntico en base y HEAD NO conflictúa aunque HEAD haya cambiado OTROS paths — ése
 *  es el auto-merge. Cubre los tres casos de "lo tocó el otro": modificado (sha distinto),
 *  agregado (ausente en base) y borrado (ausente en HEAD). */
export function conflictPaths(
  changedPaths: readonly string[],
  baseTree: ReadonlyMap<string, string>,
  headTree: ReadonlyMap<string, string>,
): string[] {
  return changedPaths.filter((p) => baseTree.get(p) !== headTree.get(p));
}

/** Conflicto por-CAMBIO, endurecido para que "la edición manual SIEMPRE gana" (fix invariante
 *  2026-06-09). El modelo viejo (`conflictPaths`) compara baseTree-vs-HEAD del `baseRef` que el
 *  cliente DECLARA. Eso tiene una grieta: si el `baseRef` del cliente ya avanzó al HEAD (su copia
 *  local quedó desincronizada del disco — el agente pulleó/mergeó pero su working copy de ese path
 *  quedó vieja), baseTree == headTree para todos los paths → el chequeo se vuelve un no-op y un
 *  `put` con contenido VIEJO pisa la edición del usuario sin conflicto. El "BUM, versión vieja".
 *
 *  El fix: en vez de confiar SOLO en el `baseRef` declarado, cada cambio trae su `base` (el blob
 *  que el escritor cree vivo para ESE path) y comparamos contra el HEAD REAL al momento del commit:
 *    - `base` presente (string|null): conflictúa si `headTree[path]` != `base` (alguien lo tocó
 *      desde que el escritor lo vio). Es optimistic-concurrency por-path, el mismo modelo que el
 *      editor web (`putFile` con `sha`), ahora también para el agente/REM.
 *    - `base` ausente (cliente legacy): caemos al modelo viejo baseTree-vs-HEAD (sin regresión).
 *  Devuelve los paths en conflicto (el cliente re-baja esos y reintenta). */
export function conflictingChanges(
  changes: readonly Change[],
  baseTree: ReadonlyMap<string, string>,
  headTree: ReadonlyMap<string, string>,
): string[] {
  return changes
    .filter((c) => {
      if (c.base === undefined) {
        // Legacy: el cliente no declara base por-path → baseRef-vs-HEAD como antes.
        return baseTree.get(c.path) !== headTree.get(c.path);
      }
      // Optimista por-path: el HEAD real tiene que coincidir con lo que el escritor vio.
      // `null` → esperaba ausente (create); `undefined` del map = path ausente.
      const expected = c.base ?? undefined;
      return headTree.get(c.path) !== expected;
    })
    .map((c) => c.path);
}
