// Identidad de una nota = (repo, path). Predicado PURO compartido por los guards que evitan la
// contaminación cruzada de contenido entre pestañas: cuando una op async (load de una nota, eco de
// un autosave) resuelve, hay que verificar que la nota que la disparó SIGUE siendo la activa antes
// de aplicar su resultado al `doc`/cache visible. Si el usuario cambió de pestaña mid-flight, la
// identidad ya no coincide → se descarta el efecto (no se pisa la nota nueva con la vieja).

export interface NoteRef {
  repo: string;
  path: string;
}

/** ¿`a` y `b` son la MISMA nota? `null`/`undefined` (sin nota abierta) nunca coincide con nada. */
export function isSameNote(a: NoteRef | null | undefined, b: NoteRef | null | undefined): boolean {
  if (!a || !b) return false;
  return a.repo === b.repo && a.path === b.path;
}

/** ¿La nota `target` quedó "stale" respecto de la abierta `live`? (= ya no es la activa).
 *  Es el guard que usan loadEntry/refetch tras cada await, y patchDoc antes de tocar el doc. */
export function isStaleNote(live: NoteRef | null | undefined, target: NoteRef): boolean {
  return !isSameNote(live, target);
}
