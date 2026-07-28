// Modo mantenimiento / freeze de escrituras de notas (feature db — cutover de F3).
//
// Durante la ventana de cutover (git → DB como fuente de verdad) hay que CONGELAR todas
// las escrituras de notas mientras se hace el import final + verificación byte-a-byte, para
// que nada cambie entre "verifiqué" y "flipeé". Las LECTURAS siguen (el editor y el agente
// pueden leer/clonar; sólo no pueden escribir).
//
// Flag POR ARCHIVO (no env) a propósito: se prende/apaga con `touch`/`rm` SIN reiniciar el
// server → freeze y unfreeze instantáneos, y rollback inmediato si el smoke post-flip falla.
// Se chequea por-request (un `existsSync`, microsegundos).
//
// Qué congela (todas las vías de ESCRITURA de notas):
//   - editor web: PUT/POST/DELETE /api/file, move, archive, emoji, mutaciones de wiki.
//   - agente: git push (`/api/git/<w>/git-receive-pack`) y `/api/sync/commit` (MA).
// Qué NO congela: lecturas (GET /api/file, clone/pull = upload-pack, búsqueda, el chat).

import { existsSync } from "node:fs";

export interface FreezeGate {
  /** ¿Están congeladas las escrituras de notas ahora mismo? (lee el flag en vivo). */
  frozen(): boolean;
  /** Path del flag (para logs/ops). */
  readonly flagPath: string;
}

export function makeFreezeGate(flagPath: string): FreezeGate {
  return {
    flagPath,
    frozen: () => existsSync(flagPath),
  };
}

/** Cuerpo 503 estándar del freeze — el front lo muestra como "en mantenimiento, reintentá".
 *  El editor ya reintenta ante fallos transitorios de guardado, así que un save durante la
 *  ventana no se pierde: reintenta y entra apenas se descongela. */
export const FREEZE_STATUS = 503 as const;
export const FREEZE_BODY = {
  error: "maintenance",
  message: "Notas en mantenimiento (cutover). Reintentá en unos minutos.",
};
