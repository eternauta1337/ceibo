// Audio session de iOS/WebKit (navigator.audioSession, iOS 16.4+). Manejo MÍNIMO y CORRECTO de la
// categoría, motivado por un dato de prod: una versión vieja (#640/#643) seteaba `type="playback"`
// y esa categoría PERSISTE a nivel SO/PWA (sobrevive reloads). "playback" es INCOMPATIBLE con
// captura → con la sesión clavada ahí, `getUserMedia` se rechaza con
// `InvalidStateError: AudioSession category is not compatible with audio capture.`. #645 sacó el
// código viejo pero NO deshizo el estado clavado, así que el mic quedó muerto.
//
// Reglas (según la spec W3C Audio Session + ese dato):
//  - Para CAPTURAR hay que pedir `"play-and-record"` ANTES del getUserMedia (deshace el "playback"
//    clavado; es la categoría que el mic exige).
//  - NUNCA seteamos `"playback"`: es lo que clavó el bug (mata el track de mic vivo y bloquea
//    capturas futuras). Para rutear la salida al parlante cuando NO se captura, usamos `"auto"`
//    (el default, compatible con captura futura): con el mic soltado / `enabled=false`, `auto`
//    deja la salida en A2DP/parlante sin clavar nada.
//  - Idempotente: memorizamos la última categoría aplicada y no la re-asignamos — re-asignar
//    re-dispara el cambio de ruteo y con Bluetooth fuerza A2DP↔HFP (el auto ve "llamada" en loop).
//
// API solo-WebKit, NO en los tipos del DOM → feature-detectada, no-op donde no exista. La pieza
// PURA (decidir si aplicar) vive en `shouldApplyAudioSession` y se testea sola.

/** Categorías que usamos. Subconjunto deliberado: NUNCA "playback" (clava el bug). `auto` = default
 *  compatible con captura; `play-and-record` = lo que el mic exige para capturar. */
export type AudioSessionType = "auto" | "play-and-record";

/** Última categoría que efectivamente aplicamos a `navigator.audioSession.type`. Module-level: hay
 *  una sola audio-session global. La memorizamos para la idempotencia. */
let appliedType: AudioSessionType | null = null;

/** Decisión PURA de idempotencia: dado lo último aplicado y lo pedido, ¿hay que asignar? Solo si
 *  CAMBIA (mismo valor → no-op, corta el churn de ruteo Bluetooth). */
export function shouldApplyAudioSession(prev: AudioSessionType | null, next: AudioSessionType): boolean {
  return prev !== next;
}

/** Setea la categoría de la audio session de WebKit, si la API existe. No-op (silencioso) donde no
 *  esté disponible o si tira. Idempotente: pedir la misma categoría que la última aplicada NO
 *  re-asigna (evita re-disparar A2DP↔HFP → "llamada" en loop). Devuelve la categoría EFECTIVA
 *  conocida (la recién aplicada, o la memorizada si fue no-op), o null si la API no existe. */
export function setAudioSession(type: AudioSessionType): AudioSessionType | null {
  if (!shouldApplyAudioSession(appliedType, type)) return appliedType;
  try {
    const sess = (navigator as unknown as { audioSession?: { type?: string } }).audioSession;
    if (sess && typeof sess === "object") {
      sess.type = type;
      appliedType = type; // recién acá: solo memorizamos lo que de verdad pudimos aplicar
      return appliedType;
    }
  } catch {
    /* API ausente o de solo-lectura en este WebKit → no-op (appliedType queda como estaba) */
  }
  return appliedType;
}

/** Lee la categoría actual de la audio session (para el readout de debug: confirmar en el device
 *  que ya NO está en "playback"). Devuelve el string crudo del SO, o null si la API no existe. */
export function readAudioSessionType(): string | null {
  try {
    const sess = (navigator as unknown as { audioSession?: { type?: string } }).audioSession;
    if (sess && typeof sess === "object" && typeof sess.type === "string") return sess.type;
  } catch {
    /* no-op */
  }
  return null;
}

/** Resetea el estado memorizado de la categoría aplicada. Solo para tests (aislar casos). */
export function __resetAudioSessionForTest(): void {
  appliedType = null;
}
