// Dedup de frames SSE por seq (Fase C del plan "conexión rock-solid", lado cliente).
//
// El server estampa cada frame entregado con un `seq` monotónico POR USUARIO (campo
// `seq` en el JSON + línea `id:` del evento SSE). Al reconectar, el server RE-EMITE del
// buffer lo que el cliente declaró no haber visto (header `Last-Event-ID` en el reconnect
// nativo del EventSource; `?since=` en el reconnect manual del watchdog). Ese replay
// puede traer frames que esta vista YA procesó (ej.: reconnect con watermark viejo, o el
// max(header, since) del server eligiendo el más conservador): re-procesarlos duplicaría
// burbujas (`heard`/`text` re-puchean mensajes), re-reproduciría audio (`voice` autoplay)
// y ensuciaría el log de actividad. La garantía de idempotencia es ESTA función: un frame
// con `seq` ≤ al último visto se descarta ANTES de tocar ningún estado.
//
// Cada vista recibe una SUBSECUENCIA estrictamente creciente del seq de su usuario (los
// frames de turno de OTRAS vistas no le llegan → huecos normales, no son pérdida), así
// que "seq nuevo > último visto" es exactamente "no lo procesé". Frames sin `seq`
// (`ready`, `ping`, `resync` — control de conexión, no replay-ables) pasan siempre.
//
// Restart del server: el seq re-arranca basado en Date.now() (> que cualquier seq viejo),
// así que el dedup nunca se traga frames nuevos tras un deploy. Pura (sin React/DOM) para
// testearse en node, como liveness.ts.

/** Decisión de dedup: ¿procesar este frame? `next` = watermark a guardar (avanza solo
 *  con frames aceptados que traen seq). */
export function acceptFrame(lastSeq: number, msg: { seq?: unknown }): { accept: boolean; next: number } {
  const seq = msg.seq;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return { accept: true, next: lastSeq };
  if (seq <= lastSeq) return { accept: false, next: lastSeq };
  return { accept: true, next: seq };
}

/** URL del stream SSE para `connect()`: el `since` (último seq visto) viaja como query
 *  en el reconnect MANUAL — un EventSource nuevo NO manda `Last-Event-ID` (eso es solo
 *  del reconnect nativo del MISMO EventSource), y justo el caso del watchdog (conexión
 *  zombie → EventSource nuevo) es el que más necesita el replay. */
export function streamUrl(sid: string, lastSeq: number): string {
  const since = lastSeq > 0 ? `&since=${lastSeq}` : "";
  return `/api/stream?sid=${encodeURIComponent(sid)}${since}`;
}
