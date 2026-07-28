// @ceibo/speech — STT/TTS del bridge, channel-agnostic.
//
// MA no tiene audio (user.message es text|image|document; output sólo texto), así que
// todo el audio vive ACÁ, por encima del canal: el gateway transcribe lo que entra antes
// de mandarlo a la sesión, y sintetiza la respuesta antes de devolverla. Cualquier canal
// que traiga un adjunto de audio hereda el feature (no es Telegram-específico).
//
// Dos providers, elegibles por env (SPEECH_PROVIDER):
//   - "local" (default): todo gratis, sin API paga — faster-whisper (STT, CPU) + edge-tts
//     (TTS, servicio "Read aloud" de Edge, sin key). Subprocess de un venv Python; ffmpeg
//     convierte formatos.
//   - "inworld": STT (inworld-stt-1) + TTS (inworld-tts-1.5-max) vía API HTTP síncrona
//     (base64 in/out). Más calidad + voice profiling en STT; cuesta plata (INWORLD_API_KEY).
//     ffmpeg se sigue usando sólo para concatenar chunks de TTS (límite 2000 chars/request).
// El gateway no cambia: las firmas transcribe()/synthesize() son las mismas; el dispatch
// por provider vive acá adentro.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// --- Config ---------------------------------------------------------------
// IMPORTANTE: la config se lee EN CADA LLAMADA, no al cargar el módulo. El gateway hace
// `process.loadEnvFile()` DESPUÉS de los imports (los imports corren el top-level de este
// módulo antes), así que capturar `process.env.X` en un `const` top-level lo dejaría con
// los defaults aunque el `.env` después tenga el valor. Por eso `cfg()` es una función.
const FALLBACK_VOICE = "es-AR-ElenaNeural"; // la voz edge-tts que pidió el owner
const MAX_BUFFER = 64 * 1024 * 1024; // 64MB: notas de voz/respuestas largas entran holgadas

export type Provider = "local" | "inworld";

function cfg() {
  const provider: Provider = process.env.SPEECH_PROVIDER === "inworld" ? "inworld" : "local";
  return {
    provider,
    // --- local (faster-whisper + edge-tts) ---
    // `python` del venv de la box; edge-tts se invoca con el mismo intérprete vía `-m edge_tts`.
    python: process.env.SPEECH_PYTHON ?? "python3",
    ffmpeg: process.env.FFMPEG_BIN ?? "ffmpeg",
    whisperModel: process.env.WHISPER_MODEL ?? "base",
    whisperCompute: process.env.WHISPER_COMPUTE ?? "int8",
    whisperLanguage: process.env.WHISPER_LANGUAGE ?? "", // "" = autodetect
    // --- inworld (API HTTP) ---
    inworldKey: process.env.INWORLD_API_KEY ?? "",
    inworldBaseUrl: process.env.INWORLD_BASE_URL ?? "https://api.inworld.ai",
    inworldTtsModel: process.env.INWORLD_TTS_MODEL ?? "inworld-tts-1.5-max",
    inworldSttModel: process.env.INWORLD_STT_MODEL ?? "inworld/inworld-stt-1",
    inworldVoiceDefault: process.env.INWORLD_VOICE_DEFAULT ?? "",
    // --- comunes ---
    sttTimeout: Number(process.env.STT_TIMEOUT_MS ?? 120_000),
    ttsTimeout: Number(process.env.TTS_TIMEOUT_MS ?? 60_000),
    // --- guard de audio inválido (pre-check antes de whisper) ---
    // Audio más corto que esto = tap accidental / nota fallida → no vale la pena transcribir.
    sttMinDurationMs: Number(process.env.STT_MIN_DURATION_MS ?? 400),
    // Nivel RMS (dBFS) por debajo del cual el clip es silencio/ruido de fondo, no habla. Voz
    // real ronda -20..-40 dBFS; silencio/ambiente cae bien por debajo de -50.
    sttSilenceDbfs: Number(process.env.STT_SILENCE_DBFS ?? -50),
    // --- chunking de STT para audios largos (inworld) ---
    // Inworld rechaza mensajes de más de 16777216 bytes (HTTP 429 "trying to send message
    // larger than max"). El WAV normalizado (PCM s16le 16kHz mono) pesa 32000 B/s → un audio
    // de ~9 min ya pisa el límite. Si el WAV excede este máximo por chunk, se parte en tramos
    // de a lo sumo STT_CHUNK_SECONDS y se transcribe cada uno (ver splitWavForStt). Default
    // 300s = 5 min ≈ 9.6MB raw ≈ 12.8MB en base64: holgado bajo 16MB mida lo que mida Inworld
    // (el log real reporta el tamaño RAW del audio, pero dejamos margen para ambos). Audios
    // que entran en un chunk siguen yendo en UN request, igual que siempre.
    sttChunkSeconds: Number(process.env.STT_CHUNK_SECONDS || 300), // `||`: "" cuenta como no seteado
  };
}

/** Provider de voz activo (lo usa el gateway para matizar la ayuda de /voice). */
export function speechProvider(): Provider {
  return cfg().provider;
}

/** Idiomas soportados (Fase 15). El idioma afecta el prompt del agente (tag por turno en el
 *  gateway), qué voces muestra /voice y el hint de idioma del STT (sesga la autodetección
 *  hacia el idioma del usuario — ver transcribe/transcribeDetailed). */
export type Lang = "es" | "en";
export const LANGS: { id: Lang; label: string }[] = [
  { id: "es", label: "Español" },
  { id: "en", label: "English" },
];
export function isValidLang(s: string): s is Lang {
  return s === "es" || s === "en";
}
function normLang(s: string | null | undefined): Lang {
  return s && isValidLang(s) ? s : "es";
}

/** Voz por defecto del idioma, según el provider activo.
 *  - local: respeta el override legacy `TTS_VOICE_DEFAULT` para 'es' (la voz que pidió el
 *    owner); para los demás idiomas, la primera de la lista curada edge-tts.
 *  - inworld: `INWORLD_VOICE_DEFAULT` (env, pisa todo) o la primera de la lista curada. */
export function defaultVoice(lang: string = "es"): string {
  const c = cfg();
  if (c.provider === "inworld") {
    return c.inworldVoiceDefault || voicesForLang(lang)[0]?.id || INWORLD_FALLBACK_VOICE;
  }
  if (normLang(lang) === "es") return process.env.TTS_VOICE_DEFAULT ?? FALLBACK_VOICE;
  return voicesForLang(lang)[0]?.id ?? FALLBACK_VOICE;
}

// Rate por default cuando el usuario no eligió uno (tts_rate NULL). El owner pidió velocidad
// NORMAL por default (backlog: "velocidad normal"); "+0%" → speakingRate 1.0. Env-configurable
// (TTS_RATE_DEFAULT) por si se quiere otra default sin tocar código.
export function defaultRate(): string {
  return process.env.TTS_RATE_DEFAULT ?? "+0%";
}

// El feature se prende por la presencia de la credencial del provider activo (NO hay flags
// STT_ENABLED/TTS_ENABLED propias). local → SPEECH_PYTHON; inworld → INWORLD_API_KEY.
export function speechEnabled(): boolean {
  const c = cfg();
  return c.provider === "inworld" ? Boolean(c.inworldKey) : Boolean(process.env.SPEECH_PYTHON);
}

const STT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "stt.py");

// --- Catálogo de voces -----------------------------------------------------
// Voces curadas por idioma para el menú de /voice. La lista depende del provider: son
// universos de IDs distintos (edge-tts usa `xx-XX-NombreNeural`; Inworld usa nombres
// propios). La primera de cada lista es la default del idioma (ver defaultVoice).

// `id` es el voiceId real que va a la API (puede ser largo/feo, ej. el de un clon Inworld).
// `nick` es un apodo corto y tipeable para /voice (ej. "ale"); si falta, se usa el id.
export interface Voice {
  id: string;
  label: string;
  nick?: string;
}

// edge-tts (local). edge-tts tiene muchas más (`python -m edge_tts --list-voices`); ésta es
// una selección útil sin pegarle a la red.
const EDGE_VOICES_BY_LANG: Record<Lang, Voice[]> = {
  es: [
    { id: "es-AR-ElenaNeural", label: "Elena · Argentina (♀, default)" },
    { id: "es-AR-TomasNeural", label: "Tomás · Argentina (♂)" },
    { id: "es-MX-DaliaNeural", label: "Dalia · México (♀)" },
    { id: "es-MX-JorgeNeural", label: "Jorge · México (♂)" },
    { id: "es-ES-ElviraNeural", label: "Elvira · España (♀)" },
    { id: "es-ES-AlvaroNeural", label: "Álvaro · España (♂)" },
    { id: "es-CO-SalomeNeural", label: "Salomé · Colombia (♀)" },
    { id: "es-UY-MateoNeural", label: "Mateo · Uruguay (♂)" },
  ],
  en: [
    { id: "en-US-AriaNeural", label: "Aria · US (♀, default)" },
    { id: "en-US-GuyNeural", label: "Guy · US (♂)" },
    { id: "en-US-JennyNeural", label: "Jenny · US (♀)" },
    { id: "en-GB-SoniaNeural", label: "Sonia · UK (♀)" },
    { id: "en-GB-RyanNeural", label: "Ryan · UK (♂)" },
    { id: "en-AU-NatashaNeural", label: "Natasha · Australia (♀)" },
  ],
};

// Inworld. Las voces nativas español del catálogo suenan ibéricas, así que el owner las
// sacó del menú: dejamos SOLO voces clonadas con acento latino. El clon se hace de una voz
// regional de edge-tts (POST /voices/v1/voices:clone): hereda el acento/identidad y lo rinde
// con la calidad de TTS-1.5 Max. Los ids llevan el prefijo del workspace de la API key
// actual (nifty-mole-4852__…); si se rota la key a otro workspace, hay que re-clonar y
// actualizar acá. Labels = sólo el 1er nombre (pedido del owner). Default 'es' = Tomás
// (backlog "Voz default Tomás" = el 1ro de la lista). Podés usar cualquier voz del catálogo
// pasando el id a /voice (isValidVoice no verifica contra el catálogo).
const INWORLD_FALLBACK_VOICE = "nifty-mole-4852__tomasar";
const INWORLD_VOICES_BY_LANG: Record<Lang, Voice[]> = {
  es: [
    { id: "nifty-mole-4852__tomasar", nick: "tomas", label: "Tomás" },
    { id: "nifty-mole-4852__elenaar", nick: "elena", label: "Elena" },
    { id: "nifty-mole-4852__salomeco", nick: "salome", label: "Salomé" },
  ],
  en: [
    { id: "Ashley", label: "Ashley (♀, default) — warm, natural" },
    { id: "Olivia", label: "Olivia (♀) — British, friendly" },
    { id: "Deborah", label: "Deborah (♀) — calm, peaceful" },
    { id: "Alex", label: "Alex (♂) — energetic, expressive" },
    { id: "Craig", label: "Craig (♂) — older British, refined" },
    { id: "Hades", label: "Hades (♂) — commanding narrator" },
  ],
};

// Voces retiradas del catálogo que pueden seguir guardadas en el setting `tts_voice` de
// algún usuario (un id válido en forma, que la API todavía resolvería). isValidVoice las
// rechaza para que synthesize caiga a la default, igual que con un id edge-tts viejo.
const RETIRED_INWORLD_VOICES = new Set(["nifty-mole-4852__alear2", "nifty-mole-4852__junoar"]);

/** Voces del idioma para el provider activo (cae a 'es' si el idioma no es válido). */
export function voicesForLang(lang: string): Voice[] {
  const table = cfg().provider === "inworld" ? INWORLD_VOICES_BY_LANG : EDGE_VOICES_BY_LANG;
  return table[normLang(lang)];
}

/** Resuelve lo que tipeó el usuario en /voice (apodo corto o voiceId completo) al voiceId
 *  real que va a la API. Matchea apodo/id del catálogo case-insensitive; si no está en el
 *  catálogo pero tiene forma de id válido (voz custom), lo devuelve tal cual. undefined si
 *  no es ni un apodo conocido ni un id válido. */
export function resolveVoice(input: string, _lang: string): string | undefined {
  const low = input.trim().toLowerCase();
  if (!low) return undefined;
  for (const l of LANGS) {
    const table = cfg().provider === "inworld" ? INWORLD_VOICES_BY_LANG : EDGE_VOICES_BY_LANG;
    for (const v of table[l.id]) {
      if (v.nick?.toLowerCase() === low || v.id.toLowerCase() === low) return v.id;
    }
  }
  return isValidVoice(input) ? input : undefined;
}

/** Nombre corto para mostrar de un voiceId: el apodo del catálogo si existe, sino el id
 *  crudo. Lo usa /voice para no escupir el id largo de un clon. */
export function displayVoice(id: string): string {
  const table = cfg().provider === "inworld" ? INWORLD_VOICES_BY_LANG : EDGE_VOICES_BY_LANG;
  for (const l of LANGS) {
    const v = table[l.id].find((x) => x.id === id);
    if (v) return v.nick ?? v.id;
  }
  return id;
}

const EDGE_VOICE_RE = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/;
/** Valida el formato de un id de voz según el provider.
 *  - local: formato edge-tts `xx-XX-NombreNeural`.
 *  - inworld: nombre propio (letra inicial + alfanum/_/-, sin espacios). No verifica catálogo,
 *    pero SÍ rechaza explícitamente (a) un id con forma edge-tts: si un usuario tenía guardada
 *    una voz edge-tts (ej. es-CO-SalomeNeural) de cuando el provider era local, NO debe pasar
 *    como voiceId de Inworld (la API tira 404); y (b) las voces retiradas del catálogo. En
 *    ambos casos, al rechazarlas, synthesize cae a la default. */
export function isValidVoice(id: string): boolean {
  if (cfg().provider === "inworld") {
    return !RETIRED_INWORLD_VOICES.has(id) && !EDGE_VOICE_RE.test(id) && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id);
  }
  return EDGE_VOICE_RE.test(id);
}

/** ¿La voz corresponde al idioma activo? Reemplaza el check hardcodeado del gateway
 *  (`id.startsWith(lang+"-")`), que sólo vale para edge-tts.
 *  - local: el id edge-tts arranca con `xx-` (el idioma).
 *  - inworld: los IDs no llevan prefijo de idioma. Rechazamos sólo si la voz está curada
 *    en OTRO idioma; un id desconocido (voz custom que pegó el owner) se permite. */
export function voiceMatchesLang(id: string, lang: string): boolean {
  if (cfg().provider !== "inworld") return id.toLowerCase().startsWith(`${normLang(lang)}-`);
  const target = normLang(lang);
  for (const l of ["es", "en"] as Lang[]) {
    if (INWORLD_VOICES_BY_LANG[l].some((v) => v.id === id)) return l === target;
  }
  return true; // id no curado → asumimos válido (custom)
}

// Parámetros de prosodia. edge-tts acepta rate/volume como porcentaje con signo (`+10%`,
// `-20%`) y pitch en Hz con signo (`+5Hz`). Validamos acá para dar buenos errores en /voice.
// En modo Inworld sólo `rate` aplica (se mapea a speakingRate 0.5–1.5); pitch/volume se
// guardan pero se ignoran al sintetizar (la API no los tiene). El formato de validación se
// mantiene igual en ambos providers para no romper settings ya guardados al cambiar de provider.
export interface VoiceParams {
  voice?: string | null;
  rate?: string | null; // ej. +10% (más rápido), -15% (más lento)
  pitch?: string | null; // ej. +5Hz (más agudo), -10Hz (más grave) — sólo local
  volume?: string | null; // ej. +10%, -50% — sólo local
  lang?: string | null; // idioma del usuario (Fase 15): elige la voz default si no hay voz seteada
}
const PCT_RE = /^[+-]\d{1,3}%$/;
const HZ_RE = /^[+-]\d{1,3}Hz$/;
export function isValidRate(v: string): boolean {
  return PCT_RE.test(v);
}
export function isValidVolume(v: string): boolean {
  return PCT_RE.test(v);
}
export function isValidPitch(v: string): boolean {
  return HZ_RE.test(v);
}

/** ¿El provider activo soporta este parámetro de prosodia? Inworld sólo `rate`. Lo usa
 *  /voice para avisar que pitch/volume no aplican en modo Inworld. */
export function paramSupported(param: "rate" | "pitch" | "volume"): boolean {
  return cfg().provider !== "inworld" || param === "rate";
}

/** Carpeta temporal aislada para un trabajo; se borra entera en finally. */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ceibo-speech-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function run(bin: string, args: string[], timeout: number): Promise<{ stdout: string }> {
  try {
    return await execFileAsync(bin, args, { timeout, maxBuffer: MAX_BUFFER });
  } catch (e) {
    const err = e as { code?: string; message?: string; stderr?: string };
    if (err.code === "ENOENT") throw new Error(`no encuentro "${bin}" (¿instalado / en PATH?)`);
    // ffmpeg/python escupen un banner largo primero; el error REAL está al final del
    // stderr. Tomamos las últimas líneas no vacías (no el head, que sólo trae el banner).
    const raw = (err.stderr || err.message || String(e)).trim();
    const tail = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-3)
      .join(" | ");
    throw new Error(`${bin} falló: ${(tail || raw).slice(-400)}`);
  }
}

// --- Inworld HTTP ----------------------------------------------------------
// POST síncrono con `Authorization: Basic <KEY>` (la runtime key de Inworld ya viene
// base64, se usa tal cual). base64 in/out.
async function inworldPost<T>(path: string, body: unknown, timeout: number): Promise<T> {
  const c = cfg();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${c.inworldBaseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${c.inworldKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 400);
      throw new Error(`inworld ${path} → HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return (await res.json()) as T;
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new Error(`inworld ${path}: timeout (${timeout}ms)`);
    throw e;
  } finally {
    clearTimeout(to);
  }
}

// --- Filtro de alucinaciones de STT (tarea #37) ---------------------------
// Con silencio/ruido, whisper (y en menor medida cualquier STT) no devuelve vacío: ALUCINA
// frases típicas de su corpus de subtítulos de YouTube ("thanks for watching", créditos de
// amara.org, "[BLANK_AUDIO]", etc.). stt.py ya filtra por confianza (no_speech_prob /
// avg_logprob), pero algunas alucinaciones salen con confianza alta → este filtro de texto
// es la segunda red. Si el transcript COMPLETO (normalizado) es una de estas frases-basura, o
// es sólo puntuación / un único carácter, lo tratamos como vacío.
//
// CLAVE: es match EXACTO contra el transcript entero normalizado, no substring. Una frase real
// que CONTENGA "gracias" no se filtra; sólo se filtra cuando el audio entero transcribió a la
// frase-basura sola. La lista se mantiene ACOTADA a propósito: habla real corta y válida ("sí",
// "ok", "dale", "no", "gracias", "hola") NO está acá y pasa.
//
// Normalización: lowercase, sin acentos, sin puntuación/símbolos, espacios colapsados.
const STT_HALLUCINATION_PHRASES = new Set([
  // Inglés (subtítulos de YouTube — el caso más común con silencio)
  "you",
  "thank you",
  "thank you very much",
  "thanks",
  "thank you for watching",
  "thanks for watching",
  "thanks for watching the video",
  "please subscribe",
  "subscribe to my channel",
  "dont forget to subscribe",
  "like and subscribe",
  "see you next time",
  "see you in the next video",
  "bye",
  "bye bye",
  // Créditos de subtitulado (amara.org y similares) — multilingüe. Ojo: la normalización
  // convierte el "." de "amara.org" en ESPACIO → "amara org" (no "amaraorg").
  "subtitles by the amara org community",
  "subtitulos realizados por la comunidad de amara org",
  "subtitulos por la comunidad de amara org",
  // Español (créditos / cierres de video)
  "gracias por ver",
  "gracias por ver el video",
  "gracias por ver el video y nos vemos en el proximo",
  "suscribete",
  "suscribete al canal",
  // Marcadores de evento que el modelo a veces emite como texto
  "blank audio",
  "music",
  "musica",
  "applause",
  "aplausos",
  "silence",
  "silencio",
]);

/** Normaliza un transcript para compararlo contra la lista de alucinaciones: lowercase, sin
 *  acentos, sin puntuación ni símbolos, espacios colapsados. */
function normForHallucinationCheck(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // diacríticos (combining marks tras NFD)
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // puntuación/símbolos → espacio
    .replace(/\s+/g, " ")
    .trim();
}

/** ¿El transcript es (casi seguro) una alucinación de STT sobre silencio/ruido, no habla real?
 *  Reglas: vacío tras normalizar / sólo puntuación / un único carácter / match exacto contra
 *  la lista de frases-basura. Exportada para test. */
export function isLikelyHallucination(text: string): boolean {
  const norm = normForHallucinationCheck(text);
  if (!norm) return true; // sólo puntuación/espacios/símbolos (".", "...", "¿?", etc.)
  if (norm.length === 1) return true; // un único carácter suelto ("y", "a", ".") → ruido
  return STT_HALLUCINATION_PHRASES.has(norm);
}

/** Aplica el filtro de alucinaciones: devuelve "" si el transcript es basura de silencio,
 *  sino el texto tal cual. Centraliza el post-proceso para ambos providers. */
function filterTranscript(text: string): string {
  return isLikelyHallucination(text) ? "" : text;
}

// --- Guard de audio inválido (pre-check ANTES de transcribir) --------------
// La RED PRIMARIA contra "audio vacío → whisper alucina → dispara turno". El blocklist de
// frases (arriba) es frágil: depende de adivinar qué alucina whisper (varía por idioma/modelo).
// Acá, en cambio, miramos el AUDIO mismo: un tap accidental o silencio NO debería ir a whisper.
// Reusa el WAV que ffmpeg YA generó para normalizar (pcm_s16le mono 16kHz) — CERO shell-out
// extra, cero latencia agregada.

/** Stats baratas de un WAV PCM 16-bit (lo que produce nuestro ffmpeg). `rmsDbfs` es -Infinity
 *  para silencio absoluto. */
export interface WavStats {
  durationSec: number;
  rmsDbfs: number;
  samples: number;
}

/** Layout físico de un WAV RIFF/PCM-16 (lo que produce nuestro ffmpeg): dónde arranca el chunk
 *  `data` y la geometría de las muestras. Base común de analyzeWavPcm16 y splitWavForStt. */
interface WavLayout {
  sampleRate: number;
  channels: number;
  dataOffset: number;
  dataSize: number;
}

/** Itera los chunks RIFF (tolera LIST u otros que ffmpeg pueda insertar) y devuelve el layout,
 *  o `null` si NO es un PCM-16 parseable. */
function parseWavLayout(buf: Buffer): WavLayout | null {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let channels = 0;
  let dataOffset = -1;
  let dataSize = 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataOffset = body;
      // El size declarado puede exceder lo realmente presente (clip truncado) → clampeamos.
      dataSize = Math.min(size, buf.length - body);
      break; // data suele ir último; con su offset y los fmt ya tenemos todo.
    }
    off = body + size + (size & 1); // chunks alineados a 2 bytes
  }
  if (sampleRate <= 0 || bitsPerSample !== 16 || channels <= 0 || dataOffset < 0) return null;
  return { sampleRate, channels, dataOffset, dataSize };
}

/** Parsea un WAV RIFF/PCM-16 y calcula duración + nivel RMS (dBFS). Devuelve `null` si NO es un
 *  PCM-16 parseable: el caller degrada a "transcribir igual" (tirar audio real por un header raro
 *  es peor que un turno de más). Exportada para test. */
export function analyzeWavPcm16(buf: Buffer): WavStats | null {
  const lay = parseWavLayout(buf);
  if (!lay) return null;
  const bytesPerSample = 2;
  const frameBytes = bytesPerSample * lay.channels;
  const frames = Math.floor(lay.dataSize / frameBytes);
  const durationSec = frames / lay.sampleRate;
  // RMS sobre TODAS las muestras (todos los canales), normalizado a [-1,1] (/32768).
  const totalSamples = frames * lay.channels;
  let sumSq = 0;
  for (let i = 0; i < totalSamples; i++) {
    const s = buf.readInt16LE(lay.dataOffset + i * bytesPerSample) / 32768;
    sumSq += s * s;
  }
  const rms = totalSamples > 0 ? Math.sqrt(sumSq / totalSamples) : 0;
  const rmsDbfs = rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
  return { durationSec, rmsDbfs, samples: totalSamples };
}

// --- Chunking de WAV para STT (audios largos) -------------------------------
// Inworld limita el tamaño de mensaje a 16MB y el WAV normalizado pesa 32000 B/s → audios de
// más de ~9 min revientan con HTTP 429. Como el WAV ya está EN MEMORIA como PCM crudo, el corte
// se hace acá en JS (slice del chunk `data` + header nuevo), sin shell-outs extra a ffmpeg.
//
// Dónde cortar: para no partir palabras, cada corte busca el punto MÁS SILENCIOSO (mínima
// energía RMS sobre ventanas de 300ms) dentro de una ventana de búsqueda alrededor del corte
// target. Si no hay silencio real, el mínimo de energía es igualmente el mejor candidato
// disponible y degrada con elegancia a un corte ~por tiempo fijo (el centro de la ventana), así
// que no hace falta un fallback aparte ni solapamiento+dedup.

/** Frame (no byte) donde conviene cortar dentro de [lo, hi]: el centro de la ventana de 300ms
 *  con menor energía. Si el rango es demasiado angosto, el punto medio (corte por tiempo). */
function quietestCutFrame(wav: Buffer, lay: WavLayout, lo: number, hi: number): number {
  const win = Math.max(1, Math.floor(0.3 * lay.sampleRate)); // ventana RMS: 300ms
  const hop = Math.max(1, Math.floor(0.05 * lay.sampleRate)); // paso: 50ms
  if (hi - lo <= win) return Math.floor((lo + hi) / 2);
  const frameBytes = 2 * lay.channels;
  let bestFrame = Math.floor((lo + hi) / 2);
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (let f = lo; f + win <= hi; f += hop) {
    const base = lay.dataOffset + f * frameBytes;
    const n = win * lay.channels;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const s = wav.readInt16LE(base + i * 2) / 32768;
      energy += s * s;
    }
    if (energy < bestEnergy) {
      bestEnergy = energy;
      bestFrame = f + Math.floor(win / 2);
    }
  }
  return bestFrame;
}

/** WAV standalone (header canónico de 44 bytes + data) con los frames [startFrame, endFrame). */
function sliceWav(wav: Buffer, lay: WavLayout, startFrame: number, endFrame: number): Buffer {
  const frameBytes = 2 * lay.channels;
  const from = lay.dataOffset + startFrame * frameBytes;
  const data = wav.subarray(from, lay.dataOffset + endFrame * frameBytes);
  const out = Buffer.alloc(44 + data.length);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + data.length, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(lay.channels, 22);
  out.writeUInt32LE(lay.sampleRate, 24);
  out.writeUInt32LE(lay.sampleRate * frameBytes, 28);
  out.writeUInt16LE(frameBytes, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(data.length, 40);
  data.copy(out, 44);
  return out;
}

/** Parte un WAV PCM-16 en chunks de a lo sumo `maxSeconds`, cortando cerca de silencios (ver
 *  quietestCutFrame). Si el WAV entra en un chunk —el caso común— devuelve `[wav]` SIN copiar
 *  nada: el hot path de audios cortos no cambia. Si el WAV no es parseable, también `[wav]`
 *  (comportamiento legacy: un solo request). Sin solapamiento: los cortes caen en silencio, los
 *  frames no se duplican ni se pierden. Exportada para test. */
export function splitWavForStt(wav: Buffer, maxSeconds: number): Buffer[] {
  const lay = parseWavLayout(wav);
  if (!lay || !(maxSeconds > 0)) return [wav];
  const frameBytes = 2 * lay.channels;
  const totalFrames = Math.floor(lay.dataSize / frameBytes);
  const maxFrames = Math.floor(maxSeconds * lay.sampleRate);
  if (maxFrames <= 0 || totalFrames <= maxFrames) return [wav];
  // Ventana de búsqueda de silencio: ±radius alrededor del target. El target se corre radius
  // ANTES del límite del chunk para que ningún corte (ni el peor caso) exceda maxFrames.
  const radius = Math.min(10 * lay.sampleRate, Math.floor(maxFrames / 4));
  const chunks: Buffer[] = [];
  let start = 0;
  while (totalFrames - start > maxFrames) {
    const target = start + maxFrames - radius;
    const cut = quietestCutFrame(
      wav,
      lay,
      Math.max(start + 1, target - radius),
      Math.min(totalFrames, target + radius),
    );
    chunks.push(sliceWav(wav, lay, start, cut));
    start = cut;
  }
  chunks.push(sliceWav(wav, lay, start, totalFrames));
  return chunks;
}

/** Clasifica el WAV ANTES de transcribir: `"tooShort"` (más corto que el mínimo),
 *  `"silent"` (RMS por debajo del umbral = silencio/ruido, no habla), `"ok"` (mandalo a STT),
 *  o `null` si no se pudo analizar (transcribir igual). Exportada para test. */
export function classifyAudio(
  wav: Buffer,
  minDurationMs: number,
  silenceDbfs: number,
): "ok" | "tooShort" | "silent" | null {
  const stats = analyzeWavPcm16(wav);
  if (!stats) return null;
  if (stats.durationSec * 1000 < minDurationMs) return "tooShort";
  if (stats.rmsDbfs < silenceDbfs) return "silent";
  return "ok";
}

/** Motivo del resultado de STT:
 *  - `ok`: hay texto.
 *  - `tooShort` / `silent`: el pre-check de audio lo descartó (tap accidental / silencio) →
 *    el caller puede IGNORAR sin postear nada (no merece respuesta).
 *  - `noSpeech`: había audio con sonido, pero el STT no devolvió habla útil (vacío o
 *    alucinación filtrada) → el caller puede avisar "no te entendí". */
export type SttReason = "ok" | "tooShort" | "silent" | "noSpeech";
export interface SttResult {
  text: string;
  reason: SttReason;
}

// Marcador que reemplaza a un chunk que falló definitivamente (tras los reintentos): el caller
// recibe el resto de la transcripción en vez de perder todo el audio. Exportado para test.
export const STT_CHUNK_FAILED_MARKER = "[…tramo no transcrito…]";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** UN request de STT a Inworld con un WAV ya normalizado (LINEAR16 16kHz).
 *  `lang` (opcional) se manda como `transcribeConfig.language`: un HINT en ISO 639 ("es", "en")
 *  que sesga la autodetección hacia ese idioma (no la fuerza). Sin lang → autodetect a ciegas. */
async function inworldSttRequest(wav: Buffer, c: ReturnType<typeof cfg>, lang?: Lang): Promise<string> {
  const resp = await inworldPost<{ transcription?: { transcript?: string } }>(
    "/stt/v1/transcribe",
    {
      transcribeConfig: {
        modelId: c.inworldSttModel,
        audioEncoding: "LINEAR16",
        sampleRateHertz: 16000,
        ...(lang ? { language: lang } : {}),
      },
      audioData: { content: wav.toString("base64") },
    },
    c.sttTimeout,
  );
  return (resp.transcription?.transcript ?? "").trim();
}

/** Transcribe un audio largo ya partido en chunks, en orden, y concatena los textos con espacio.
 *  - Pre-check POR chunk (duración + RMS): un tramo de silencio o el rabito final demasiado
 *    corto no gastan un request.
 *  - Filtro de alucinaciones POR chunk: un tramo de ruido que el STT alucina ("Thanks for
 *    watching") no ensucia la transcripción total (el filtro global por match exacto no
 *    aplicaría sobre el texto ya concatenado).
 *  - Fallo parcial: cada chunk se reintenta hasta 3 veces; si igual falla, entra el marcador
 *    STT_CHUNK_FAILED_MARKER en su lugar y se sigue (mejor 90% del audio que cero). Si NINGÚN
 *    chunk se pudo transcribir, sí se propaga el último error.
 *  Devuelve "" si ningún chunk produjo habla real (→ noSpeech aguas arriba, sin markers sueltos). */
async function inworldSttChunked(chunks: Buffer[], c: ReturnType<typeof cfg>, lang?: Lang): Promise<string> {
  const parts: string[] = [];
  let lastErr: unknown;
  let anyOk = false; // algún chunk respondió (aunque haya sido vacío/alucinación)
  let anyText = false; // algún chunk produjo habla real
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const kind = classifyAudio(chunk, c.sttMinDurationMs, c.sttSilenceDbfs);
    if (kind === "tooShort" || kind === "silent") continue;
    let text: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        text = await inworldSttRequest(chunk, c, lang);
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await sleep(200 * attempt);
      }
    }
    if (text === null) {
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      console.warn(`[stt] chunk ${i + 1}/${chunks.length} falló tras 3 intentos: ${msg}`);
      parts.push(STT_CHUNK_FAILED_MARKER);
      continue;
    }
    anyOk = true;
    const filtered = filterTranscript(text);
    if (filtered) {
      parts.push(filtered);
      anyText = true;
    }
  }
  if (!anyOk && lastErr !== undefined) {
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
  return anyText ? parts.join(" ") : "";
}

// --- STT: audio (cualquier formato) → texto -------------------------------
/**
 * Transcribe bytes de audio a texto. Devuelve el texto (puede ser "" si el audio no tenía
 * habla). `mime` es informativo (ambos providers sniffean el contenido, no la extensión).
 * `lang` (opcional) es el idioma del usuario: nudgea al STT a transcribir EN ese idioma en
 * vez de autodetectar a ciegas (con audio corto/ruidoso whisper a veces autodetecta árabe o
 * japonés). Si no se pasa → autodetect (comportamiento histórico, no rompe a quien no lo dé).
 *  - local: ffmpeg normaliza a WAV 16kHz mono, faster-whisper transcribe. El `lang` per-call
 *    PISA al `WHISPER_LANGUAGE` del env (que sigue siendo el default si no se pasa nada).
 *  - inworld: ffmpeg normaliza a WAV 16kHz mono (LINEAR16) y se manda base64. NO mandamos el
 *    blob crudo: el STT de Inworld sólo acepta LINEAR16/MP3/OGG_OPUS/FLAC, y el audio del web
 *    viene en WebM/Opus (MediaRecorder) → AUTO_DETECT tira HTTP 500 code 13. Normalizar a WAV
 *    cubre cualquier origen (Telegram OGG, web WebM, etc.) de una. El `lang` se forwardea como
 *    `transcribeConfig.language` (ISO 639): es un HINT que SESGA la autodetección hacia ese
 *    idioma, no la fuerza — evita que un audio corto/ruidoso en español autodetecte inglés u
 *    otro idioma. Es opcional en la API; sin lang → autodetect a ciegas (comportamiento previo).
 */
export async function transcribe(audio: Buffer, mime?: string, lang?: Lang): Promise<string> {
  return (await transcribeDetailed(audio, mime, lang)).text;
}

/**
 * Igual que `transcribe()` pero devuelve el MOTIVO además del texto (ver `SttResult`/`SttReason`).
 * El caller (gateway) lo usa para decidir si IGNORA en silencio (tap accidental / silencio) o
 * AVISA "no te entendí" (hubo sonido pero no habla útil).
 *
 * Pipeline (idéntico para ambos providers): ffmpeg normaliza a WAV pcm_s16le 16kHz mono →
 * **pre-check del audio** (duración + RMS) sobre ESE WAV → si pasa, se transcribe (whisper local
 * o Inworld) → filtro de alucinaciones. El pre-check es la red PRIMARIA contra "silencio →
 * whisper alucina → dispara turno"; el blocklist de frases queda como segunda red.
 *
 * Audios largos (sólo inworld): si el WAV excede STT_CHUNK_SECONDS, se parte en chunks bajo el
 * límite de mensaje de 16MB de Inworld y se concatenan las transcripciones (ver splitWavForStt
 * e inworldSttChunked). Whisper local lee de archivo y no tiene ese límite → sin chunking.
 */
export async function transcribeDetailed(audio: Buffer, _mime?: string, lang?: Lang): Promise<SttResult> {
  if (!speechEnabled()) throw new Error("STT no configurado (falta credencial del provider)");
  const c = cfg();
  return withTempDir(async (dir) => {
    const inPath = join(dir, "in");
    const wavPath = join(dir, "audio.wav");
    await writeFile(inPath, audio);
    await run(
      c.ffmpeg,
      ["-y", "-i", inPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
      c.sttTimeout,
    );
    const wav = await readFile(wavPath);

    // Pre-check: audio vacío / demasiado corto / silencioso NO va al STT (evita la alucinación
    // de raíz). `null` = no se pudo analizar → degradamos a transcribir igual.
    const kind = classifyAudio(wav, c.sttMinDurationMs, c.sttSilenceDbfs);
    if (kind === "tooShort") return { text: "", reason: "tooShort" };
    if (kind === "silent") return { text: "", reason: "silent" };

    let raw: string;
    if (c.provider === "inworld") {
      // Audios largos: el WAV se parte en chunks bajo el límite de mensaje de Inworld (16MB).
      // El caso común (audio corto) devuelve [wav] y va en UN request, igual que siempre.
      const chunks = splitWavForStt(wav, c.sttChunkSeconds);
      raw =
        chunks.length === 1
          ? await inworldSttRequest(wav, c, lang)
          : await inworldSttChunked(chunks, c, lang);
    } else {
      // El idioma per-call tiene prioridad sobre el env; "" = autodetect (como hoy).
      const language = lang ?? c.whisperLanguage;
      const { stdout } = await run(
        c.python,
        [STT_SCRIPT, wavPath, c.whisperModel, c.whisperCompute, language],
        c.sttTimeout,
      );
      const last = stdout.trim().split("\n").pop() ?? "{}";
      raw = ((JSON.parse(last) as { text?: string }).text ?? "").trim();
    }

    const text = filterTranscript(raw);
    // Hubo sonido (pasó el pre-check) pero el STT no dio habla útil (vacío o alucinación filtrada).
    return text ? { text, reason: "ok" } : { text: "", reason: "noSpeech" };
  });
}

/** Agrega `--flag=valor` (un solo token) sólo si pasa el validador. El `=` es necesario:
 *  rate/pitch/volume pueden empezar con `-` (ej. -5Hz) y argparse de edge-tts los tomaría
 *  como otro flag si fueran tokens separados. */
function ttsFlag(name: string, value: string | null | undefined, valid: (v: string) => boolean): string[] {
  return value && valid(value) ? [`--${name}=${value}`] : [];
}

// Mapea el rate edge-tts ("+10%", "-15%") al speakingRate de Inworld (0.5–1.5, default 1.0).
// "+10%" → 1.1, "-15%" → 0.85. Clamp a [0.5, 1.5]. null/invalid → 1.0.
function rateToSpeakingRate(rate: string | null | undefined): number {
  if (!rate || !isValidRate(rate)) return 1.0;
  const pct = Number(rate.replace("%", "")); // mantiene el signo
  return Math.min(1.5, Math.max(0.5, 1 + pct / 100));
}

// Parte el texto en chunks de ≤max chars respetando límites de oración/párrafo (Inworld
// limita a 2000 chars/request). Si una oración sola excede max, se trocea duro.
function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let cur = "";
  // Partimos por oraciones (manteniendo el delimitador) y por saltos de línea.
  const pieces = text.split(/(?<=[.!?…\n])\s+/);
  for (const piece of pieces) {
    if (piece.length > max) {
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      for (let i = 0; i < piece.length; i += max) chunks.push(piece.slice(i, i + max));
      continue;
    }
    if (cur.length + piece.length + 1 > max) {
      chunks.push(cur);
      cur = piece;
    } else {
      cur = cur ? `${cur} ${piece}` : piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// --- TTS: texto → nota de voz (OGG/Opus) ----------------------------------
/**
 * Sintetiza `text` a una nota de voz OGG/Opus (lo que Telegram quiere para la burbuja
 * redonda). `p` overridea voz/rate/pitch/volume (cada uno opcional; default de la voz).
 *  - local: edge-tts saca MP3, ffmpeg lo pasa a Opus. El texto va por archivo (no por arg)
 *    para no chocar con límites de longitud ni escaping.
 *  - inworld: POST /tts/v1/voice por chunk (≤2000 chars), audioEncoding OGG_OPUS. 1 chunk
 *    sale directo; multi-chunk se concatena con ffmpeg. rate→speakingRate; pitch/volume N/A.
 */
export async function synthesize(text: string, p: VoiceParams = {}): Promise<Buffer> {
  if (!speechEnabled()) throw new Error("TTS no configurado (falta credencial del provider)");
  const clean = text.trim();
  if (!clean) throw new Error("nada que sintetizar (texto vacío)");
  const c = cfg();
  const useVoice = p.voice && isValidVoice(p.voice) ? p.voice : defaultVoice(p.lang ?? "es");

  if (c.provider === "inworld") return synthesizeInworld(clean, useVoice, p, c);

  const prosody = [
    ...ttsFlag("rate", p.rate, isValidRate),
    ...ttsFlag("pitch", p.pitch, isValidPitch),
    ...ttsFlag("volume", p.volume, isValidVolume),
  ];
  return withTempDir(async (dir) => {
    const txtPath = join(dir, "in.txt");
    const mp3Path = join(dir, "out.mp3");
    const oggPath = join(dir, "out.ogg");
    await writeFile(txtPath, clean, "utf8");
    await run(
      c.python,
      ["-m", "edge_tts", "--voice", useVoice, ...prosody, "--file", txtPath, "--write-media", mp3Path],
      c.ttsTimeout,
    );
    await run(c.ffmpeg, ["-y", "-i", mp3Path, "-c:a", "libopus", "-b:a", "32k", oggPath], c.ttsTimeout);
    return readFile(oggPath);
  });
}

async function synthesizeInworld(
  text: string,
  voiceId: string,
  p: VoiceParams,
  c: ReturnType<typeof cfg>,
): Promise<Buffer> {
  const speakingRate = rateToSpeakingRate(p.rate);
  const audioConfig = { audioEncoding: "OGG_OPUS", sampleRateHertz: 48_000, speakingRate };
  const chunks = chunkText(text, 2_000);
  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    const resp = await inworldPost<{ audioContent?: string }>(
      "/tts/v1/voice",
      { text: chunk, voiceId, modelId: c.inworldTtsModel, audioConfig },
      c.ttsTimeout,
    );
    if (!resp.audioContent) throw new Error("inworld /tts/v1/voice: respuesta sin audioContent");
    parts.push(Buffer.from(resp.audioContent, "base64"));
  }
  const first = parts[0];
  if (!first) throw new Error("inworld TTS: no se generó audio");
  if (parts.length === 1) return first;
  // Multi-chunk: concatenar OGG/Opus a nivel byte no es confiable (múltiples streams con
  // serials distintos). Usamos ffmpeg con el demuxer concat (re-multiplexa sin recodificar).
  return withTempDir(async (dir) => {
    const listPath = join(dir, "list.txt");
    const outPath = join(dir, "out.ogg");
    const lines: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const partPath = join(dir, `part-${i}.ogg`);
      await writeFile(partPath, parts[i]!);
      lines.push(`file '${partPath}'`);
    }
    await writeFile(listPath, lines.join("\n"), "utf8");
    await run(
      c.ffmpeg,
      ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath],
      c.ttsTimeout,
    );
    return readFile(outPath);
  });
}
