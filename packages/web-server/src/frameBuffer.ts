// Ring buffer de frames SSE por usuario + seq monotónico (Fase C del plan "conexión
// rock-solid"). EL BUG QUE MATA: si el SSE estaba caído cuando el server emitía la
// respuesta de un turno, `deliver` escribía al void y el frame se perdía PARA SIEMPRE
// (sin buffer, sin replay — el historial del chat es localStorage del browser). El
// watchdog de la Fase A reconecta, pero lo que pasó durante la caída no volvía.
//
// EL FIX (resumption nativa de SSE): cada frame que `deliver` emite lleva un `seq`
// monotónico POR USUARIO (línea `id:` del evento + campo `seq` en el JSON) y queda
// guardado acá. Al reconectar, el browser manda `Last-Event-ID` (automático en el
// reconnect nativo del EventSource) o el cliente manda `?since=<seq>` (reconnect
// manual del watchdog, que crea un EventSource NUEVO y por eso no lleva el header).
// El server re-emite del buffer todo lo que tenga seq > ese watermark — respetando el
// sid-routing: a una vista solo vuelven sus frames de turno (origin === sid) y los
// broadcasts (sin origin).
//
// HONESTIDAD DEL REPLAY (resync): si entre el watermark del cliente y lo más viejo
// que el buffer conserva hubo evicciones (por cap de frames, cap de bytes o TTL),
// no podemos garantizar el replay completo → `since()` devuelve `gap: true` y el
// caller antepone un frame `{t:"resync"}` ("perdiste contexto, refrescá el estado")
// a lo que SÍ tenemos. Mejor un refresh suave que mentir con un replay con huecos.
//
// SEQ A PRUEBA DE RESTARTS: el contador por usuario arranca en Date.now() y avanza
// de a 1 por frame. Tras un restart del web-server el contador re-arranca en el
// Date.now() nuevo, que es MAYOR que cualquier seq viejo salvo que se hubieran
// emitido más frames que milisegundos transcurridos (imposible en la práctica) →
// el dedup del cliente (descarta seq ≤ último visto) nunca se traga frames nuevos
// por un reinicio. Lo que se emitió DURANTE el restart no se puede replay-ear
// (el buffer es in-memory y murió con el proceso); aceptado y documentado.
//
// MEMORIA: por usuario, máx MAX_FRAMES frames / MAX_BYTES bytes serializados /
// TTL_MS de edad (lo más viejo se evicta primero). Los frames de voz (audio base64)
// son los pesados — el cap de bytes existe por ellos. El estado escalar por usuario
// (contadores seq/dropped, sin frames) se conserva tras el sweep para que la
// detección de gap sobreviva períodos idle; pesa ~nada y la cantidad de usuarios
// está acotada por la DB (instancia familiar).

/** Cap de frames retenidos por usuario. ~varios turnos de margen: un turno típico son
 *  <10 frames (typing/activity/text/turn-done); 100 cubre holgado una caída de minutos. */
export const FRAME_BUFFER_MAX_FRAMES = 100;
/** Cap de bytes serializados por usuario (los frames `voice` traen el OGG en base64). */
export const FRAME_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
/** Edad máxima de un frame replay-able. Más viejo que esto, mejor resync que replay:
 *  re-entregar media conversación de hace una hora confunde más de lo que ayuda. */
export const FRAME_BUFFER_TTL_MS = 10 * 60 * 1000;

export interface FrameBufferOpts {
  maxFrames?: number;
  maxBytes?: number;
  ttlMs?: number;
  /** Reloj inyectable para tests; default Date.now. */
  now?: () => number;
}

/** Un frame bufferedo: el payload YA lleva `seq` adentro (lo que se re-emite es
 *  byte-a-byte lo mismo que se emitió en vivo, dedup-eable por el cliente). */
export interface BufferedFrame {
  seq: number;
  /** sid de la vista que originó el turno; undefined = broadcast (a todas las vistas). */
  origin?: string;
  payload: Record<string, unknown>;
}

interface Entry extends BufferedFrame {
  at: number; // timestamp de emisión (para el TTL)
  bytes: number; // tamaño serializado (para el cap de bytes)
}

interface UserBuf {
  nextSeq: number;
  /** seq más alto que alguna vez se evictó/expiró: si el watermark del cliente es menor,
   *  hay frames en el hueco que ya no tenemos → gap (resync). */
  droppedSeq: number;
  bytes: number;
  entries: Entry[];
}

export class FrameBuffer {
  private readonly users = new Map<number, UserBuf>();
  private readonly maxFrames: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: FrameBufferOpts = {}) {
    this.maxFrames = opts.maxFrames ?? FRAME_BUFFER_MAX_FRAMES;
    this.maxBytes = opts.maxBytes ?? FRAME_BUFFER_MAX_BYTES;
    this.ttlMs = opts.ttlMs ?? FRAME_BUFFER_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Asigna el próximo seq del usuario, guarda el frame y devuelve el payload a emitir
   *  (el original + `seq`). TODO frame entregado por `deliver` pasa por acá — incluso
   *  sin ningún stream vivo: ESE es el caso que el replay rescata. */
  push(userId: number, msg: Record<string, unknown>, origin?: string): BufferedFrame {
    const t = this.now();
    let buf = this.users.get(userId);
    if (!buf) {
      // Base del seq = Date.now(): monotónico también A TRAVÉS de restarts (ver header).
      buf = { nextSeq: Math.max(t, 1), droppedSeq: 0, bytes: 0, entries: [] };
      this.users.set(userId, buf);
    }
    const seq = buf.nextSeq++;
    const payload = { ...msg, seq };
    const bytes = JSON.stringify(payload).length;
    buf.entries.push({ seq, origin, payload, at: t, bytes });
    buf.bytes += bytes;
    this.evict(buf, t);
    return { seq, origin, payload };
  }

  /** Frames con `seq > afterSeq` destinados a la vista `sid` (sus frames de turno +
   *  los broadcasts; sin sid, solo broadcasts — espeja el contrato de `deliver`).
   *  `gap: true` = hubo frames evictados/expirados después del watermark → el replay
   *  puede estar incompleto y el caller debe señalar resync. */
  since(userId: number, afterSeq: number, sid?: string): { frames: BufferedFrame[]; gap: boolean } {
    const buf = this.users.get(userId);
    if (!buf) return { frames: [], gap: false };
    this.evict(buf, this.now()); // expirar ANTES de mirar: lo vencido no se replay-ea, cuenta como gap
    const gap = buf.droppedSeq > afterSeq;
    const frames = buf.entries.filter(
      (e) => e.seq > afterSeq && (e.origin === undefined || e.origin === sid),
    );
    return { frames, gap };
  }

  /** Poda periódica (la engancha el interval del ping): expira frames viejos de todos
   *  los usuarios para que un usuario que dejó de venir no retenga audio en memoria.
   *  El registro escalar (seq/droppedSeq) se conserva — ver header. */
  sweep(): void {
    const t = this.now();
    for (const buf of this.users.values()) this.evict(buf, t);
  }

  /** Bytes retenidos en total (observabilidad / tests de memoria). */
  totalBytes(): number {
    let n = 0;
    for (const buf of this.users.values()) n += buf.bytes;
    return n;
  }

  private evict(buf: UserBuf, t: number): void {
    const drop = (e: Entry) => {
      buf.bytes -= e.bytes;
      if (e.seq > buf.droppedSeq) buf.droppedSeq = e.seq;
    };
    // TTL: lo vencido se va (entries está ordenado por seq == orden temporal).
    let i = 0;
    while (i < buf.entries.length && t - (buf.entries[i] as Entry).at > this.ttlMs) {
      drop(buf.entries[i] as Entry);
      i++;
    }
    if (i > 0) buf.entries.splice(0, i);
    // Caps de cantidad y de bytes: evicta lo más viejo primero.
    while (buf.entries.length > this.maxFrames || (buf.bytes > this.maxBytes && buf.entries.length > 1)) {
      const e = buf.entries.shift();
      if (!e) break;
      drop(e);
    }
  }
}

/** Parsea un watermark de seq (header `Last-Event-ID` o query `?since=`) a número;
 *  cualquier cosa no-numérica/negativa → 0 (= sin watermark, no se replay-ea nada). */
export function parseSeq(raw: string | string[] | null | undefined): number {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
