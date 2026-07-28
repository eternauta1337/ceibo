// Fase 10 — smoke de voz (round-trip TTS → STT). Corre en la box, donde vive el venv
// (faster-whisper + edge-tts) + ffmpeg. Sintetiza una frase con edge-tts, la transcribe
// con whisper, y compara. No toca Telegram ni la DB: valida sólo @ceibo/speech.
//
// Uso (en la box):
//   set -a && . ./.env && set +a && npx tsx scripts/smoke-speech.ts
// (requiere SPEECH_PYTHON apuntando al python del venv, y ffmpeg en PATH)

import { defaultVoice, speechEnabled, synthesize, transcribe } from "../packages/speech/src/index.ts";

const PHRASE = process.argv[2] ?? "Hola, esto es una prueba de voz del asistente Ceibo.";

async function main(): Promise<void> {
  if (!speechEnabled()) {
    console.error("✗ speech no configurado (falta SPEECH_PYTHON). Seteá el .env y reintentá.");
    process.exit(1);
  }
  console.log(`voz: ${defaultVoice()}`);
  console.log(`frase: "${PHRASE}"`);

  const t0 = Date.now();
  const ogg = await synthesize(PHRASE);
  console.log(`✓ TTS: ${ogg.length} bytes OGG/Opus (${Date.now() - t0}ms)`);

  const t1 = Date.now();
  const back = await transcribe(ogg, "audio/ogg");
  console.log(`✓ STT: "${back}" (${Date.now() - t1}ms)`);

  const norm = (s: string) => s.toLowerCase().replace(/[^a-záéíóúñ ]/g, "").trim();
  console.log(norm(back).includes("prueba de voz") ? "✓ round-trip OK" : "⚠ round-trip dudoso (revisá arriba)");
}

main().catch((e) => {
  console.error(`✗ ${e?.message ?? e}`);
  process.exit(1);
});
