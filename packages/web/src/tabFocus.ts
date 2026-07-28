// Decisión pura de DÓNDE abrir una nota (repo+path) en la tira de pestañas.
//
// Regla de producto (pedida por el owner, estilo Obsidian):
//   - Si la nota YA está abierta en alguna pestaña (su entrada ACTUAL coincide) → ENFOCAR esa
//     pestaña (no duplicar).
//   - Si NO está abierta → reemplazar el contenido de la pestaña ACTIVA, empujándola a su
//     historial back/forward (el que alimenta las flechas ← →). Igual en desktop y mobile.
//   - `forceNewTab` (⌘-click / "abrir en pestaña nueva") fuerza pestaña nueva cuando la nota no
//     está abierta; si ya está abierta, enfocar SIEMPRE gana (el objetivo es no duplicar).
//   - `activeIsSystem` (la pestaña activa es una página de sistema, ej. Configuración): una nota
//     no se puede "reemplazar" dentro de una tab de sistema (no tiene historial de notas), así
//     que se abre en pestaña nueva. Antes esto era un no-op: clickear una nota con la config
//     abierta no hacía nada (el guard de pushEntryToActiveTab descartaba el push).
//
// ⚠️ Regresión histórica (no repetir): #239 puso "desktop → pestaña nueva" como default para
// notas no abiertas. Eso rompió DOS cosas a la vez: el click simple dejó de reemplazar la
// activa (anti-Obsidian), y como cada open creaba una pestaña de 1 entrada ningún historial
// crecía → las flechas back/forward (que sólo se muestran con historial) desaparecieron. El
// default es replace-active; pestaña nueva es SIEMPRE un gesto explícito (⌘-click / menú).
//
// "Abierta" = la entrada actual (la que se ve en la tira) de alguna pestaña. Una nota enterrada
// en el historial back/forward de una pestaña NO cuenta como abierta.

/** Vista mínima de una pestaña para decidir el foco: su id + la entrada que muestra ahora. */
export interface OpenTabState {
  id: string;
  repo: string;
  path: string;
}

export type OpenDecision =
  | { action: "focus"; tabId: string } // activar una pestaña existente
  | { action: "new-tab" } // crear una pestaña nueva
  | { action: "replace-active" }; // empujar a la pestaña activa (reemplaza su contenido)

export interface OpenOpts {
  /** ⌘-click / menú "abrir en pestaña nueva": fuerza pestaña nueva si la nota no está abierta. */
  forceNewTab?: boolean;
  /** La pestaña activa es una página de sistema: no se puede reemplazar con una nota → pestaña nueva. */
  activeIsSystem?: boolean;
}

export function decideOpenAction(
  repo: string,
  path: string,
  tabs: OpenTabState[],
  opts?: OpenOpts,
): OpenDecision {
  const existing = tabs.find((t) => t.repo === repo && t.path === path);
  if (existing) return { action: "focus", tabId: existing.id };
  if (opts?.forceNewTab) return { action: "new-tab" };
  // La activa es una página de sistema: no tiene historial de notas para "reemplazar",
  // así que abrimos la nota en una pestaña nueva en vez de no hacer nada.
  if (opts?.activeIsSystem) return { action: "new-tab" };
  return { action: "replace-active" };
}
