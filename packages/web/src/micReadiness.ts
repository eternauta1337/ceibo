// Lógica PURA del ciclo de vida del micrófono en iOS/WebKit, separada del DOM/WebAudio para
// testearla sin browser. El contexto del bug (iPhone + Bluetooth en el auto) y las fuentes que
// fundamentan estas decisiones están en useChannel.ts; el resumen:
//
//  - Un track de mic VIVO (readyState "live") aún NO garantiza que entre audio: tras volver del
//    background o un cambio de ruta (Bluetooth A2DP↔HFP), WebKit deja el track `muted` y la
//    fuente tarda en re-entregar PCM. Marcar "grabando" mirando sólo `readyState` muestra la
//    ilusión de grabar (la onda corre pero no entra audio) hasta que llega el evento `unmute`.
//    → "listo para grabar" = readyState "live" Y `muted === false`.
//  - NO se manipula `navigator.audioSession.type`: setear "playback" con un track de mic vivo
//    MATA el track (spec W3C Audio Session); `auto` (default) + track de mic vivo ⇒
//    play-and-record ⇒ HFP = el auto ve una "llamada". La sesión baja sola cuando no queda nada
//    capturando. La salida al parlante se logra NO teniendo mic vivo durante la reproducción.

/** Estado de un MediaStreamTrack que nos importa para decidir si capturar. Subconjunto de la
 *  interfaz real (readyState + muted) → la lógica se testea con objetos planos. */
export interface TrackState {
  readyState: "live" | "ended";
  muted: boolean;
}

/** ¿El track está REALMENTE listo para capturar audio? Vivo no alcanza: si está `muted` (típico
 *  tras background / cambio de ruta Bluetooth) entra silencio hasta el `unmute`. Pieza pura. */
export function isTrackCapturing(t: TrackState | null | undefined): boolean {
  return !!t && t.readyState === "live" && t.muted === false;
}

/** Dado el conjunto de tracks de un stream, ¿hay al menos uno capturando de verdad? (vivo +
 *  des-muteado). Lo usa startRecording para decidir si puede pintar "grabando" YA o debe esperar
 *  el `unmute`. */
export function streamCapturing(tracks: readonly TrackState[]): boolean {
  return tracks.some(isTrackCapturing);
}

/** ¿Hay algún track VIVO (aunque esté muteado)? Distinto de `streamCapturing`: un track vivo se
 *  puede reusar (esperando su `unmute`) sin re-adquirir; uno `ended` hay que volver a pedirlo. */
export function streamHasLiveTrack(tracks: readonly TrackState[]): boolean {
  return tracks.some((t) => t.readyState === "live");
}

// Cuánto esperamos el evento `unmute` antes de arrancar a grabar igual. Si el track quedó muteado
// y nunca des-mutea (caso raro), no dejamos al usuario colgado sin poder grabar: tras este tope
// arrancamos y el guard de blob vacío/corto del onstop descarta si de verdad no entró nada.
export const UNMUTE_TIMEOUT_MS = 1500;
