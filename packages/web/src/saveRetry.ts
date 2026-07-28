// Política de reintento del autosave del editor ante un fallo TRANSITORIO: red caída, 5xx del
// server, o read-after-write del CDN de GitHub (el PUT ve el blob viejo y responde 409 aunque no
// haya edición concurrente). En todos esos casos el texto está a salvo (draft + buffer) y el save
// va a entrar apenas GitHub/la red se estabilizan — así que reintentamos con backoff en vez de
// alarmar con "no se pudo guardar". Sólo tras agotar el presupuesto mostramos el error (ahí sí es
// un fallo persistente que el usuario debería ver). NO cubre el conflicto REAL (solapamiento de
// líneas): ese va al panel de conflicto, no acá.

export interface SaveRetryPlan {
  /** ¿Reintentar el save? false = presupuesto agotado → estado "error". */
  retry: boolean;
  /** Delay antes del próximo intento (ms). Sólo relevante si `retry`. */
  delayMs: number;
}

/**
 * Plan de reintento para el intento número `attempt` (1-based: el 1er reintento es attempt=1).
 * Backoff lineal `baseMs * attempt`, capeado a `capMs`. Tras `max` intentos → `retry:false`.
 */
export function saveRetryPlan(attempt: number, max: number, baseMs: number, capMs: number): SaveRetryPlan {
  if (attempt > max) return { retry: false, delayMs: 0 };
  return { retry: true, delayMs: Math.min(baseMs * attempt, capMs) };
}
