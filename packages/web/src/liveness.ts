// Watchdog de liveness del stream SSE (Fase A del plan "conexión rock solid").
//
// EL BUG QUE MATA: la reconexión dependía SOLO de `es.onerror`. En una conexión half-open
// (sleep de la laptop, cambio de wifi, NAT/edge que olvidó el mapping) `onerror` NUNCA
// dispara: el EventSource se cree OPEN para siempre y no reconecta. Y como el edge habla
// HTTP/2, el SSE y los POST /api/send comparten UNA conexión TCP → la zombie se lleva las
// dos direcciones (no llegan respuestas Y los sends se escriben al vacío). F5 lo arreglaba
// porque abre TCP nuevo.
//
// EL FIX: el server ahora manda un keep-alive OBSERVABLE (`{t:"ping"}` cada 25s, antes era
// un comentario SSE invisible para JS) → en una conexión sana SIEMPRE llega algo en <25s.
// Este módulo decide cuándo "hace demasiado que no llega nada" y fuerza el reconnect:
//   - `check()` (tick periódico): >SSE_DEAD_MS sin eventos → la conexión está muerta aunque
//     readyState diga OPEN → reconectar.
//   - `wake()` (visibilitychange→visible / window online): el browser acaba de despertar o
//     recuperó red — si la conexión no está OPEN o el último evento ya está viejo
//     (>SSE_STALE_MS), reconectar YA sin esperar al tick (los timers estuvieron suspendidos).
//
// Lógica PURA (sin DOM, sin timers propios): la web corre sus tests en node sin jsdom, así
// que el wiring real (setInterval + addEventListener) vive en useChannel y acá sólo está la
// decisión, testeable con relojes fake. El debounce anti-doble-reconnect (online +
// visibilitychange suelen disparar JUNTOS al despertar) vive acá adentro: `fire()` no
// reconecta dos veces en <RECONNECT_MIN_GAP_MS.

/** Sin NINGÚN evento SSE (ping incluido) por más de esto = conexión muerta. >2× el ping de
 *  25s del server: dos pings perdidos seguidos no pasan en una conexión sana. */
export const SSE_DEAD_MS = 65_000;
/** Umbral del gatillo rápido (wake/online): más laxo que DEAD (alcanza con un ping perdido)
 *  porque el evento del browser ya es evidencia de que la red/el tab estuvo suspendido. */
export const SSE_STALE_MS = 35_000;
/** Cada cuánto tickea el watchdog (el costo de un tick es comparar dos timestamps). */
export const WATCHDOG_TICK_MS = 10_000;
/** Ventana de debounce entre reconnects forzados (watchdog + wake + online pueden coincidir). */
export const RECONNECT_MIN_GAP_MS = 5_000;

// readyState del EventSource (numéricos para no depender del global en node).
const OPEN = 1;

export interface LivenessDeps {
  /** readyState del EventSource actual; -1 si todavía no hay ninguno (boot sin sesión). */
  getReadyState(): number;
  /** Timestamp (ms epoch) del último evento SSE recibido; 0 = nunca. connect() lo resetea
   *  a "ahora" al crear cada EventSource — eso le da a la conexión nueva una ventana de
   *  gracia completa y evita que el watchdog la mate apenas nace (loop de reconnects). */
  getLastEventAt(): number;
  /** Fuerza el reconnect: close del EventSource actual + connect() nuevo (mismo sid). */
  reconnect(): void;
  /** Reloj inyectable para tests; default Date.now. */
  now?(): number;
}

export interface Liveness {
  /** Tick del watchdog. Devuelve true si forzó reconnect (para log/debug). */
  check(): boolean;
  /** Gatillo de visibilitychange→visible / window online. true si forzó reconnect. */
  wake(): boolean;
}

export function createLiveness(deps: LivenessDeps): Liveness {
  const now = deps.now ?? Date.now;
  let lastForcedAt = 0;
  // Único punto de salida hacia reconnect(): debounce compartido entre check y wake.
  const fire = (): boolean => {
    const t = now();
    if (t - lastForcedAt < RECONNECT_MIN_GAP_MS) return false;
    lastForcedAt = t;
    deps.reconnect();
    return true;
  };
  return {
    check(): boolean {
      if (deps.getReadyState() < 0) return false; // sin EventSource (unauth) → nada que vigilar
      const last = deps.getLastEventAt();
      if (!last) return false; // defensa: connect() siempre lo setea, pero 0 = sin baseline
      if (now() - last <= SSE_DEAD_MS) return false; // hubo señal de vida hace poco → sana
      return fire();
    },
    wake(): boolean {
      const rs = deps.getReadyState();
      if (rs < 0) return false;
      const last = deps.getLastEventAt();
      const stale = !last || now() - last > SSE_STALE_MS;
      // OPEN y con eventos frescos → la conexión sobrevivió al sleep/cambio de red: no tocar.
      if (rs === OPEN && !stale) return false;
      return fire();
    },
  };
}
