#!/usr/bin/env python3
"""STT con faster-whisper. Se invoca como subprocess desde @ceibo/speech.

Uso: stt.py <wav_path> <model> <compute_type> [language]

Lee un WAV 16kHz mono (lo prepara ffmpeg antes), transcribe con faster-whisper y
emite UNA línea JSON {"text", "language"} a stdout. Errores → stderr + exit≠0.
El modelo se carga por spawn (v1); un worker persistente es fast-follow si la
latencia de carga molesta.

Guardas contra silencio / ruido / alucinaciones (tarea #37): con audio sin habla
whisper suele ALUCINAR texto (devuelve "Thank you", "gracias", "Subtítulos…",
etc.) en vez de vacío → eso dispararía un turno del agente para nada. Para evitarlo
devolvemos texto VACÍO (string "") cuando las señales del modelo indican que no hay
habla confiable; el gateway ya trata "" como "no te entendí". Señales usadas:

  - **Sin segmentos**: con `vad_filter=True`, si el VAD no encontró habla no hay
    segmentos → vacío directo.
  - **no_speech_prob** (por segmento): probabilidad de que el segmento sea silencio.
    Promediamos ponderando por duración; si supera NO_SPEECH_THRESHOLD → vacío.
  - **avg_logprob** (por segmento): confianza del decoder (log-prob promedio de los
    tokens). Audio garbled/ruido produce log-probs muy bajos. Promediamos ponderando
    por duración; si cae por debajo de LOGPROB_THRESHOLD → vacío.

Umbrales conservadores (no descartar habla real baja), alineados con las heurísticas
internas de whisper (no_speech 0.6 / logprob -1.0). Override por env si hiciera falta
afinar en prod sin tocar código:

  STT_NO_SPEECH_THRESHOLD  (default 0.6)   -> más bajo = más agresivo filtrando
  STT_LOGPROB_THRESHOLD    (default -1.0)  -> más alto (ej. -0.8) = más agresivo
"""
import json
import os
import sys

NO_SPEECH_THRESHOLD = float(os.getenv("STT_NO_SPEECH_THRESHOLD", "0.6"))
LOGPROB_THRESHOLD = float(os.getenv("STT_LOGPROB_THRESHOLD", "-1.0"))


def main() -> int:
    if len(sys.argv) < 4:
        print("uso: stt.py <wav> <model> <compute> [lang]", file=sys.stderr)
        return 2
    wav, model_size, compute = sys.argv[1], sys.argv[2], sys.argv[3]
    lang = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None

    try:
        from faster_whisper import WhisperModel
    except ImportError as e:  # noqa: BLE001
        print(f"faster-whisper no instalado: {e}", file=sys.stderr)
        return 3

    model = WhisperModel(model_size, device="cpu", compute_type=compute)
    segments, info = model.transcribe(wav, language=lang, beam_size=1, vad_filter=True)
    # `segments` es un generador perezoso: materializarlo dispara la transcripción y
    # nos deja inspeccionar las señales de confianza por segmento.
    segs = list(segments)

    text = "".join(seg.text for seg in segs).strip()

    # --- Guarda de silencio / ruido / baja confianza --------------------------
    # Sin segmentos => el VAD no encontró habla.
    if not segs:
        return _emit("", info, reason="sin-segmentos (VAD no detectó habla)")

    total_dur = sum(max(0.0, seg.end - seg.start) for seg in segs)
    if total_dur <= 0.0:
        return _emit("", info, reason="duración total 0")

    # Promedios ponderados por duración (un segmento largo confiable no lo tira un
    # microsegmento ruidoso, y viceversa).
    mean_no_speech = sum(seg.no_speech_prob * max(0.0, seg.end - seg.start) for seg in segs) / total_dur
    mean_logprob = sum(seg.avg_logprob * max(0.0, seg.end - seg.start) for seg in segs) / total_dur

    if mean_no_speech >= NO_SPEECH_THRESHOLD:
        return _emit("", info, reason=f"no_speech_prob {mean_no_speech:.2f} >= {NO_SPEECH_THRESHOLD}")
    if mean_logprob <= LOGPROB_THRESHOLD:
        return _emit("", info, reason=f"avg_logprob {mean_logprob:.2f} <= {LOGPROB_THRESHOLD}")

    return _emit(text, info)


def _emit(text: str, info, reason: str | None = None) -> int:
    if reason:
        # Log a stderr (no rompe el contrato de UNA línea JSON en stdout) para diagnosticar
        # por qué un audio se trató como vacío.
        print(f"[stt] descartado como vacío: {reason}", file=sys.stderr)
    print(json.dumps({"text": text, "language": info.language}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
