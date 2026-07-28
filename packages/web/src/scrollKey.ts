// Key de la memoria de scroll de las notas abiertas (ver `wikiScrollMemo` en App + WikiViewBody).
//
// Por qué NO se keyea por `doc.id`: el id de la entrada (`OpenDoc.id`) se REGENERA con
// `crypto.randomUUID()` en cada `loadEntry` (useChannel.ts), y `loadEntry` corre en CADA
// `selectTab`/`open`/navegación. O sea, volver a una pestaña ya abierta produce un id NUEVO →
// el Map nunca matchea → el scroll restaurado siempre era 0 (la nota saltaba arriba). Bug del
// fix de #273.
//
// La key estable combina el **id de la pestaña** (`activeTabId`, que SÍ persiste entre
// activaciones de la misma pestaña) con el `repo/path` de la nota mostrada:
//   - Sobrevive al cambio de pestaña y vuelta (el tab id no cambia) → restaura la posición.
//   - Distingue la MISMA nota abierta en dos pestañas distintas (tab id distinto → scroll propio).
//   - Distingue notas distintas dentro del historial back/forward de una misma pestaña (path).
//
// Lógica pura (sin DOM/React) para testearla bajo el harness node del monorepo.

/** Construye la key estable de scroll para una nota mostrada en una pestaña. */
export function scrollKey(tabId: string, repo: string, path: string): string {
  return `${tabId}::${repo}/${path}`;
}
