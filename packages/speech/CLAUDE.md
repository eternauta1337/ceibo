# @ceibo/speech

STT/TTS channel-agnostic: faster-whisper para transcribir, edge-tts para sintetizar. Shell-out a un venv Python + ffmpeg.

- **Depende de (interno):** nada (hoja)
- **Consumido por:** mcps, gateway, web-server

## Scope

Estás trabajando en `@ceibo/speech`. Editá **solo** dentro de `packages/speech/`. Si el
cambio necesita tocar otros paquetes, pará: declará el scope cruzado en
`.claude/active-scope` (ej. `speech <otro>`) o vacialo si el cambio cruza a propósito —
no edites otros paquetes "de paso". El guard de scope lo enforcea. Ver el `CLAUDE.md` raíz.
