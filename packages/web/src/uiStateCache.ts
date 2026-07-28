// Cache de UI-state general (localStorage) para que un F5 no cambie el layout.
//
// Qué persiste este módulo (complementa lo ya existente — no reemplaza):
//   - `ceibo_doc:<handle>` (useChannel): lista de pestañas + índice activo. YA EXISTÍA.
//     → Este módulo extiende ese contrato: índice -1 = "home mode" (pestañas vivas, ninguna activa).
//   - `ceibo_expopen:<handle>` (App): explorador abierto/cerrado. YA EXISTÍA.
//   - `ceibo_chatopen:<handle>` (App): chat abierto/cerrado. YA EXISTÍA.
//   - `ceibo_scroll:<handle>` (NUEVO): posición de scroll por nota (repo/path → scrollTop).
//
// El scroll se keya por `${repo}/${path}` (sin tabId): entre refreshes cada pestaña
// arranca con UUIDs nuevos, así que la key estable cross-refresh es la nota misma.
// Dentro de una sesión, `wikiScrollMemo` en App.tsx lo maneja por tabId (estable en
// sesión). Este módulo sólo persiste el snapshot cross-refresh.
//
// Lógica pura (sin DOM/React): testeable en el harness node.

const SCROLL_PREFIX = "ceibo_scroll:";
// Tope de entradas de scroll guardadas: cap conservador para no inflar localStorage.
const SCROLL_MAX = 100;

// --- Scroll por nota (cross-refresh) -----------------------------------------------

export interface ScrollCache {
  /** Map de `"${repo}/${path}"` → scrollTop (px). */
  positions: Record<string, number>;
}

/** Construye la key de persistencia del scroll para una nota. */
export function scrollCacheKey(repo: string, path: string): string {
  return `${repo}/${path}`;
}

/** Lee el cache de scroll de un handle. Defensivo: JSON corrupto / ausente → mapa vacío. */
export function readScrollCache(handle: string | undefined): Record<string, number> {
  if (!handle) return {};
  try {
    const raw = localStorage.getItem(`${SCROLL_PREFIX}${handle}`);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Filtramos sólo los valores number (desecha entradas corruptas de cachés viejos).
    const result: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        result[k] = v;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** Guarda el cache de scroll de un handle. LRU simple: si supera el tope, descarta
 *  las entradas más antiguas (por posición en el objeto — heurística suficiente). */
export function writeScrollCache(handle: string | undefined, positions: Record<string, number>): void {
  if (!handle) return;
  try {
    // Cap: conservamos las SCROLL_MAX entradas finales del objeto (las más recientes
    // se agregan/actualizan al final por Object.assign semántica).
    const keys = Object.keys(positions);
    const sliced: Record<string, number> = {};
    const start = Math.max(0, keys.length - SCROLL_MAX);
    for (let i = start; i < keys.length; i++) {
      const k = keys[i];
      if (k !== undefined) sliced[k] = positions[k] as number;
    }
    localStorage.setItem(`${SCROLL_PREFIX}${handle}`, JSON.stringify(sliced));
  } catch {
    /* localStorage lleno / no disponible → silencioso */
  }
}

// --- Helpers para debounce del scroll -----------------------------------------------

// Mapa de timers activos (uno por handle). Módulo-level para sobrevivir entre llamadas.
const _scrollTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Guarda el scroll de una nota con debounce. Llámalo en cada evento `onScroll` del
 *  view-body. Actualiza `positions` in-place y descarta el timer anterior. */
export function saveScrollDebounced(
  handle: string | undefined,
  positions: Record<string, number>,
  repo: string,
  path: string,
  top: number,
  debounceMs = 300,
): void {
  if (!handle) return;
  // Actualiza el mapa in-place para que el siguiente write vea el estado más reciente.
  positions[scrollCacheKey(repo, path)] = top;
  const prev = _scrollTimers.get(handle);
  if (prev !== undefined) clearTimeout(prev);
  const t = setTimeout(() => {
    _scrollTimers.delete(handle);
    writeScrollCache(handle, positions);
  }, debounceMs);
  _scrollTimers.set(handle, t);
}

/** Flush inmediato del scroll (al desmontar / pagehide). Cancela el timer pendiente
 *  y escribe inmediatamente. */
export function flushScrollCache(handle: string | undefined, positions: Record<string, number>): void {
  if (!handle) return;
  const prev = _scrollTimers.get(handle);
  if (prev !== undefined) {
    clearTimeout(prev);
    _scrollTimers.delete(handle);
  }
  writeScrollCache(handle, positions);
}
