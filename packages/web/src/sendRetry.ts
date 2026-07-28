// Envío saliente resiliente (Fase B.2 del plan "conexión rock solid").
//
// EL BUG QUE MATA: `postSend` era un fetch sin timeout, sin chequear `r.ok` y con
// `.catch(() => undefined)` — TODO fallo era invisible. Con el edge en HTTP/2 el SSE y los
// POSTs comparten una conexión TCP: cuando esa conexión está mal (half-open, red caída),
// el POST cuelga minutos o muere, y el usuario manda algo y "no pasa nada": ni error, ni
// respuesta, ni rastro en el gateway. El 413 de un audio grande moría igual de mudo.
//
// EL FIX: cada envío tiene timeout (AbortController), chequea el status y reintenta con
// backoff corto los fallos TRANSITORIOS (red/timeout/5xx/429). Un 4xx terminal (413, 401…)
// no se reintenta: el resultado va al caller para que dé feedback al usuario en vez de
// tragárselo. El watchdog de la Fase A (liveness.ts) ya reconecta el SSE — acá lo único
// que importa es que el ENVÍO no se pierda en silencio.
//
// Lógica con deps inyectables (fetch/sleep): la web corre sus tests en node sin jsdom,
// así que esto se testea con fakes; el wiring real (qué hacer ante el fallo definitivo:
// marcar la burbuja, "reintentar") vive en useChannel.

/** Timeout de un POST de texto. Corto: un texto pesa KB; si en 15s no entró, la conexión
 *  está mal y conviene reintentar (el retry puede agarrar la conexión h2 fresca que abre
 *  el watchdog de la Fase A). */
export const SEND_TIMEOUT_TEXT_MS = 15_000;
/** Timeout de un POST de audio: el body puede ser de varios MB en base64 sobre una
 *  subida lenta (mobile) — le damos más aire antes de declarar el intento muerto. */
export const SEND_TIMEOUT_AUDIO_MS = 60_000;
/** Backoff entre reintentos (2 reintentos → 3 intentos en total). Corto a propósito:
 *  el usuario está mirando el "pensando"; más de ~3 intentos conviene fallar claro y
 *  dejarle el botón de reintentar. */
export const SEND_RETRY_DELAYS_MS = [1_000, 2_500];

/** Tope CLIENT-SIDE del blob de audio antes de subirlo, para feedback inmediato sin
 *  empujar MB al pedo. La fuente de verdad es el server (nginx `client_max_body_size 26m`
 *  + `MAX_SEND_BYTES` 25MB del web-server, sobre el JSON con el audio en base64): base64
 *  infla +33%, así que 25MB de body ≈ 18.7MB de blob crudo. 18MB deja margen para el
 *  resto del JSON. A ~48kbps de opus son >50 minutos de audio: no limita ningún uso real. */
export const MAX_AUDIO_BLOB_BYTES = 18 * 1024 * 1024;

/** Piso CLIENT-SIDE del blob de audio. En algunos devices (iOS/WebKit) el MediaRecorder
 *  reusado a veces no captura nada en la 2ª grabación y emite SÓLO el header WebM (~5 bytes,
 *  sin cluster finalizado): no es cero, así que `!blob.size` no lo atrapa, pero ffmpeg lo
 *  rechaza en el STT ("Invalid data found") y el turno muere. Descartamos esos blobs antes de
 *  subirlos para dar feedback inmediato ("no te escuché, reintentá"). Un opus real de >MIN_REC_MS
 *  pesa miles de bytes, así que 256 nunca corta una nota de voz legítima. */
export const MIN_AUDIO_BLOB_BYTES = 256;

export type SendKind = "text" | "audio";

/** Resultado de un envío, YA agotados los reintentos. `network` agrupa fallo de red,
 *  DNS y timeout (abort) — para el usuario son lo mismo: "no salió, reintentá". */
export type SendResult =
  | { ok: true }
  | { ok: false; reason: "http"; status: number }
  | { ok: false; reason: "network" };

export type SendFailure = Exclude<SendResult, { ok: true }>;

/** ¿Este status HTTP vale un reintento? Sólo los transitorios: 5xx (server/edge caído),
 *  408 (timeout del server) y 429 (rate-limit — el backoff ya espera). El resto de los
 *  4xx son terminales: reintentar un 413 (body demasiado grande) o un 401 da lo mismo. */
export function retryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/** ¿Tiene sentido ofrecer "reintentar" MANUAL tras el fallo definitivo? Red/timeout y
 *  5xx sí (la conexión puede haber vuelto); un 413 no — el payload nunca va a entrar. */
export function retryableFailure(f: SendFailure): boolean {
  return f.reason === "network" || retryableStatus(f.status);
}

/** Mensaje para el usuario ante un fallo DEFINITIVO de envío. Claro y accionable; el 413
 *  de un audio dice la verdad ("demasiado largo") en vez de un genérico. */
export function sendFailureMessage(f: SendFailure, kind: SendKind): string {
  if (f.reason === "http" && f.status === 413) {
    return kind === "audio"
      ? "El audio es demasiado largo para enviarlo. Probá con uno más corto."
      : "El mensaje es demasiado grande para enviarlo. Probá con adjuntos más chicos.";
  }
  if (f.reason === "http" && !retryableStatus(f.status)) {
    return `No se pudo enviar (error ${f.status}).`;
  }
  return kind === "audio"
    ? "No se pudo subir el audio. Revisá tu conexión y reintentá."
    : "No se pudo enviar. Revisá tu conexión y reintentá.";
}

export interface SendOpts {
  /** Timeout POR INTENTO (no total). */
  timeoutMs: number;
  /** Esperas entre intentos; default SEND_RETRY_DELAYS_MS. [] = sin reintentos. */
  retryDelaysMs?: number[];
  /** Inyectables para tests. */
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** POST con timeout + retry/backoff. NUNCA lanza: devuelve el resultado (ok o el último
 *  fallo) para que el caller decida el feedback. Un 4xx terminal corta los reintentos. */
export async function sendWithRetry(url: string, body: string, opts: SendOpts): Promise<SendResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = opts.retryDelaysMs ?? SEND_RETRY_DELAYS_MS;
  let last: SendFailure = { ok: false, reason: "network" };
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1] ?? 0);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const r = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: ctrl.signal,
      });
      if (r.ok) return { ok: true };
      last = { ok: false, reason: "http", status: r.status };
      if (!retryableStatus(r.status)) return last; // terminal: reintentar no ayuda
    } catch {
      last = { ok: false, reason: "network" }; // red caída / DNS / timeout (abort)
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}
