// Lógica pura del refetch tras un {t:"refresh"} del feed. Extraída de useChannel.ts para testear
// sin montar el hook. Decide DOS cosas: si la nota abierta está entre las cambiadas, y con qué
// escalera de reintentos re-leerla.

/** Una nota identificada por repo + path (la abierta, o una de las cambiadas que vino en el feed). */
export interface NoteRef {
  repo: string;
  path: string;
}

/** ¿El refresh del feed nombró la nota ABIERTA entre las cambiadas?
 *
 *  Si sí (típico: el agente editó justo la nota que mirás), el refetch debe reintentar con
 *  paciencia hasta ver el sha nuevo, sorteando el read-after-write del CDN de GitHub (write y
 *  read pegan a edges distintos; la propagación puede tardar varios segundos). Si no, alcanza con
 *  la revalidación corta.
 *
 *  `changed` puede faltar (mensaje viejo de un server sin el campo) o venir vacío (cambio
 *  out-of-band sin paths) → NO es un hit, caemos a la escalera corta. */
export function refreshHitsOpen(open: NoteRef | null, changed: NoteRef[] | undefined): boolean {
  if (!open || !changed) return false;
  return changed.some((c) => c.repo === open.repo && c.path === open.path);
}

/** Escalera de delays (ms) entre reintentos del refetch.
 *
 *  Con `expectChange` (la nota abierta SEGURO cambió) una escalera larga (~9s acumulado) para
 *  esperar la propagación del CDN en vez de rendirse a los ~2s. Si no, la corta de revalidación.
 *  El primer `0` es el intento inmediato; el resto son esperas incrementales antes de reintentar. */
export function refetchDelays(expectChange: boolean): number[] {
  return expectChange ? [0, 400, 800, 1500, 2500, 4000] : [0, 400, 700, 1200];
}
