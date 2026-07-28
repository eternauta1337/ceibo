// Lógica pura del autoplay de la respuesta de voz + el estado del player ESPEJO del chat.
// La reproducción real es UNA sola (el <audio> bendecido y reusado de useChannel); cuando el
// clip pertenece a una burbuja del chat, el canal publica este estado para que la burbuja
// muestre la reproducción EN CURSO (progreso avanzando, botón en pausa) en vez de un
// <audio controls> muerto en 0:00 mientras la voz suena por el elemento compartido.

/** Estado de la reproducción en curso atada a una burbuja del chat. */
export interface VoicePlayback {
  /** `ChatMessage.id` de la burbuja del agente cuyo audio está sonando. */
  msgId: string;
  /** false = pausado por el usuario (el clip sigue cargado, se puede reanudar). */
  playing: boolean;
  /** Posición actual, en segundos. */
  t: number;
  /** Duración en segundos; 0 mientras el metadata no llegó (o no es finito). */
  dur: number;
}

/** ¿Auto-reproducir la respuesta de voz que acaba de llegar?
 *
 *  - `autoplayDefault`: el default por modo de UI — chat CERRADO (orbe / push-to-talk) = true,
 *    chat ABIERTO = false (Telegram-like, lo setea App según `chatOpen`).
 *  - `turnWasVoice`: el último turno lo inició el usuario con una NOTA DE VOZ (no texto).
 *  - `muted`: el usuario MUTEÓ este turno (tap en el orbe mientras hablaba). Manda sobre todo
 *    lo demás: la voz que siga llegando del turno NO debe sonar (el texto sí se appendea aparte).
 *
 *  Regla del owner: si mandaste audio, la respuesta de voz suena SIEMPRE — esté el chat
 *  abierto o cerrado. Si escribiste texto con el chat abierto, queda manual (play en la
 *  burbuja). Pero si muteaste el turno, no suena nada de ese turno. */
export function shouldAutoplayVoice(autoplayDefault: boolean, turnWasVoice: boolean, muted = false): boolean {
  if (muted) return false;
  return autoplayDefault || turnWasVoice;
}

/** "m:ss" para el player espejo. NaN / Infinity / negativos → "0:00" (metadata aún sin cargar). */
export function fmtVoiceTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
