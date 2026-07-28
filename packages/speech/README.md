# @ceibo/speech

STT/TTS del bridge, **channel-agnostic**. Managed Agents no tiene audio (la entrada
es texto/imagen/documento y la salida sólo texto), así que todo el audio vive en este
paquete, por encima del canal: el gateway transcribe lo que entra antes de mandarlo a
la sesión MA y sintetiza la respuesta antes de devolverla. Cualquier canal que traiga
un adjunto de audio hereda el feature — no es específico de Telegram.

## Diseño

- **Gratis, sin API paga.** STT con [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
  (local, CPU); TTS con [edge-tts](https://github.com/rany2/edge-tts) (servicio "Read aloud"
  de Edge, sin key). Ambos se invocan como subprocess de un venv Python; `ffmpeg` hace las
  conversiones de formato en los dos sentidos.
- **Config leída por llamada, no al cargar el módulo.** El gateway hace `process.loadEnvFile()`
  *después* de los imports, así que capturar `process.env.X` en un `const` top-level lo dejaría
  con los defaults. Por eso la config vive en una función (`cfg()`).

## API

- `transcribe(audio, mime?)`: nota de voz / audio (Buffer) → texto. Idioma en autodetect.
- `synthesize(text, params?)`: texto → audio OGG/Opus (Buffer), con prosodia opcional
  (`rate`/`pitch`/`volume`) y voz por idioma.
- `voicesForLang(lang)` / `defaultVoice(lang)` / `isValidVoice(id)`: catálogo de voces por
  idioma (Fase 15); `/voice` lista sólo las del idioma activo.
- `speechEnabled()`: si el feature está configurado en este entorno.

## Configuración

Por env var (todas con default): `SPEECH_PYTHON` (intérprete del venv), `FFMPEG_BIN`,
`WHISPER_MODEL` (default `base`), `WHISPER_COMPUTE` (`int8`), `WHISPER_LANGUAGE` (`""` =
autodetect), `STT_TIMEOUT_MS`, `TTS_TIMEOUT_MS`.
