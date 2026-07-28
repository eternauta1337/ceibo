// Helpers PUROS del estado expandido/colapsado del explorer.
//
// El estado `expanded` es un Set de claves `repo` (wiki abierta) y `repo:carpeta` (carpeta abierta).
// Al abrir un archivo, auto-expandimos la wiki + todas las carpetas ancestro para revelarlo. Eso es
// ADITIVO (nunca quita lo que el user dejó abierto) y debe correr SÓLO cuando cambia el archivo
// abierto — si re-corre en cada render re-abre una carpeta recién colapsada a mano (bug QA 2026-06-11:
// "colapso una carpeta y se vuelve a abrir sola"). Acá vive la lógica pura; el glue (efecto + deps por
// IDENTIDAD del archivo, no por referencia del objeto) está en Explorer.tsx.

/** Clave estable de una carpeta en el set `expanded`. Misma forma que `folderKey` de Explorer. */
export const folderKeyOf = (repo: string, full: string): string => `${repo}:${full}`;

/** Claves que hay que tener expandidas para REVELAR `path` dentro de `repo`: la wiki (`repo`) y
 *  cada carpeta ancestro (`repo:a`, `repo:a/b`, …). NO incluye el archivo en sí. Orden raíz→hoja. */
export function neededExpandKeys(repo: string, path: string): string[] {
  const needed: string[] = [repo];
  const parts = path.split("/");
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : (parts[i] ?? "");
    needed.push(folderKeyOf(repo, acc));
  }
  return needed;
}

/** Aplica la auto-expansión aditiva: devuelve `prev` con las claves ancestro de `(repo,path)`
 *  agregadas. Devuelve EL MISMO set (identidad estable → sin re-render) si ya estaban todas — clave
 *  para no re-expandir lo que el user colapsó cuando el archivo abierto no cambió. */
export function addExpandKeys(prev: ReadonlySet<string>, repo: string, path: string): Set<string> {
  const needed = neededExpandKeys(repo, path);
  if (needed.every((k) => prev.has(k))) return prev as Set<string>;
  const next = new Set(prev);
  for (const k of needed) next.add(k);
  return next;
}
