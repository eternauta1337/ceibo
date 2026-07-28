import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeWavPcm16,
  classifyAudio,
  defaultRate,
  defaultVoice,
  displayVoice,
  isLikelyHallucination,
  isValidLang,
  isValidPitch,
  isValidRate,
  isValidVoice,
  isValidVolume,
  paramSupported,
  resolveVoice,
  STT_CHUNK_FAILED_MARKER,
  speechProvider,
  splitWavForStt,
  transcribe,
  transcribeDetailed,
  voiceMatchesLang,
  voicesForLang,
} from "./index.ts";

// Capturamos los args de cada shell-out para verificar qué idioma se le pasa al whisper, sin
// invocar ffmpeg/python de verdad. La línea JSON que emite stt.py se simula en el mock.
const h = vi.hoisted(() => ({
  execCalls: [] as { bin: string; args: string[] }[],
  sttText: "hola", // texto que "emite" stt.py; cada test lo puede pisar
  // WAV que "lee" readFile (el que ffmpeg habría normalizado). Vacío por default → analyzeWavPcm16
  // devuelve null → el pre-check degrada a "transcribir igual" (no afecta a los tests que no lo usan).
  wavBuf: Buffer.from("") as Buffer,
}));
vi.mock("node:child_process", () => ({
  execFile: (bin: string, args: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) => {
    h.execCalls.push({ bin, args });
    const isStt = args.some((a) => a.includes("stt.py"));
    cb(null, { stdout: isStt ? JSON.stringify({ text: h.sttText, language: "es" }) : "", stderr: "" });
  },
}));
vi.mock("node:fs/promises", () => ({
  mkdtemp: async () => "/tmp/ceibo-speech-test",
  writeFile: async () => {},
  readFile: async () => h.wavBuf,
  rm: async () => {},
}));

// Construye un WAV PCM-16 mono 16kHz con `n` muestras de amplitud `amp` (Int16). amp=0 → silencio.
function makeWav(n: number, amp = 0, sampleRate = 16000): Buffer {
  const dataSize = n * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(amp, 44 + i * 2);
  return buf;
}

afterEach(() => vi.unstubAllEnvs());

describe("idioma + provider", () => {
  it("provider default = local", () => {
    expect(speechProvider()).toBe("local");
  });
  it("SPEECH_PROVIDER=inworld → inworld", () => {
    vi.stubEnv("SPEECH_PROVIDER", "inworld");
    expect(speechProvider()).toBe("inworld");
  });
  it("isValidLang", () => {
    expect(isValidLang("es")).toBe(true);
    expect(isValidLang("en")).toBe(true);
    expect(isValidLang("fr")).toBe(false);
  });
  it("defaultRate default +0%", () => {
    expect(defaultRate()).toBe("+0%");
  });
});

describe("voces (modo local / edge-tts)", () => {
  it("voicesForLang devuelve la lista edge del idioma", () => {
    expect(voicesForLang("es")[0]?.id).toBe("es-AR-ElenaNeural");
    expect(voicesForLang("en")[0]?.id).toBe("en-US-AriaNeural");
    // idioma inválido cae a 'es'
    expect(voicesForLang("xx")[0]?.id).toBe("es-AR-ElenaNeural");
  });
  it("defaultVoice 'es' es una voz es-*, 'en' una en-*", () => {
    expect(defaultVoice("es").startsWith("es-")).toBe(true);
    expect(defaultVoice("en").startsWith("en-")).toBe(true);
  });
  it("resolveVoice: id edge del catálogo pasa; basura → undefined", () => {
    expect(resolveVoice("es-CO-SalomeNeural", "es")).toBe("es-CO-SalomeNeural");
    expect(resolveVoice("patata", "es")).toBeUndefined();
    expect(resolveVoice("  ", "es")).toBeUndefined();
  });
  it("isValidVoice: formato edge", () => {
    expect(isValidVoice("es-AR-ElenaNeural")).toBe(true);
    expect(isValidVoice("Ashley")).toBe(false);
  });
  it("voiceMatchesLang: prefijo de idioma", () => {
    expect(voiceMatchesLang("es-AR-ElenaNeural", "es")).toBe(true);
    expect(voiceMatchesLang("en-US-AriaNeural", "es")).toBe(false);
  });
});

describe("voces (modo inworld)", () => {
  it("voicesForLang usa el catálogo inworld; nick resuelve al id", () => {
    vi.stubEnv("SPEECH_PROVIDER", "inworld");
    expect(voicesForLang("es")[0]?.nick).toBe("tomas");
    expect(resolveVoice("tomas", "es")).toBe("nifty-mole-4852__tomasar");
    // displayVoice mapea el id largo al apodo corto
    expect(displayVoice("nifty-mole-4852__tomasar")).toBe("tomas");
  });
  it("isValidVoice inworld: nombre propio sí, formato edge NO", () => {
    vi.stubEnv("SPEECH_PROVIDER", "inworld");
    expect(isValidVoice("Ashley")).toBe(true);
    expect(isValidVoice("es-AR-ElenaNeural")).toBe(false);
  });
  it("voces retiradas (ale/juno) fuera del catálogo y rechazadas → caen a default", () => {
    vi.stubEnv("SPEECH_PROVIDER", "inworld");
    const ids = voicesForLang("es").map((v) => v.id);
    expect(ids).not.toContain("nifty-mole-4852__alear2");
    expect(ids).not.toContain("nifty-mole-4852__junoar");
    // un user con la voz retirada guardada: isValidVoice false → synthesize usa defaultVoice
    expect(isValidVoice("nifty-mole-4852__alear2")).toBe(false);
    expect(isValidVoice("nifty-mole-4852__junoar")).toBe(false);
  });
  it("paramSupported: inworld solo rate", () => {
    vi.stubEnv("SPEECH_PROVIDER", "inworld");
    expect(paramSupported("rate")).toBe(true);
    expect(paramSupported("pitch")).toBe(false);
    expect(paramSupported("volume")).toBe(false);
  });
});

describe("prosodia", () => {
  it("rate/volume = porcentaje con signo; pitch = Hz con signo", () => {
    expect(isValidRate("+10%")).toBe(true);
    expect(isValidRate("10%")).toBe(false);
    expect(isValidVolume("-50%")).toBe(true);
    expect(isValidPitch("+5Hz")).toBe(true);
    expect(isValidPitch("+5%")).toBe(false);
  });
  it("paramSupported local: todos", () => {
    expect(paramSupported("rate")).toBe(true);
    expect(paramSupported("pitch")).toBe(true);
    expect(paramSupported("volume")).toBe(true);
  });
});

describe("transcribe — nudge de idioma (modo local / faster-whisper)", () => {
  beforeEach(() => {
    h.execCalls.length = 0;
    h.sttText = "hola"; // default; los tests de alucinación lo pisan
    h.wavBuf = Buffer.from(""); // sin WAV analizable → pre-check no interviene
    vi.stubEnv("SPEECH_PYTHON", "python3"); // habilita el provider local (speechEnabled)
  });
  // El último arg del shell-out a stt.py es el `language` que va a faster-whisper.
  const sttLangArg = () => {
    const py = h.execCalls.find((c) => c.args.some((a) => a.includes("stt.py")));
    return py?.args[py.args.length - 1];
  };

  it("lang explícito → se pasa como language al whisper", async () => {
    const txt = await transcribe(Buffer.from("x"), "audio/ogg", "en");
    expect(txt).toBe("hola");
    expect(sttLangArg()).toBe("en");
  });

  it("sin lang y sin env → '' (autodetect, no rompe)", async () => {
    const txt = await transcribe(Buffer.from("x"));
    expect(txt).toBe("hola");
    expect(sttLangArg()).toBe("");
  });

  it("lang per-call PISA al WHISPER_LANGUAGE del env", async () => {
    vi.stubEnv("WHISPER_LANGUAGE", "fr");
    await transcribe(Buffer.from("x"), undefined, "es");
    expect(sttLangArg()).toBe("es");
  });

  it("sin lang cae al WHISPER_LANGUAGE del env si está seteado", async () => {
    vi.stubEnv("WHISPER_LANGUAGE", "fr");
    await transcribe(Buffer.from("x"));
    expect(sttLangArg()).toBe("fr");
  });

  it("transcript alucinado (ruido) → transcribe devuelve '' (no dispara turno)", async () => {
    h.sttText = "Thanks for watching!";
    expect(await transcribe(Buffer.from("x"), "audio/ogg", "en")).toBe("");
  });

  it("transcript sólo puntuación → ''", async () => {
    h.sttText = "...";
    expect(await transcribe(Buffer.from("x"))).toBe("");
  });

  it("habla real claro SÍ pasa (no rompe el happy path)", async () => {
    h.sttText = "hola, ¿cómo estás?";
    expect(await transcribe(Buffer.from("x"))).toBe("hola, ¿cómo estás?");
  });
});

describe("filtro de alucinaciones de STT", () => {
  it("frases-basura típicas de silencio → alucinación", () => {
    for (const s of [
      "Thank you.",
      "Thanks for watching!",
      "thank you for watching",
      "you",
      "Bye!",
      "Please subscribe",
      "Subtítulos realizados por la comunidad de Amara.org",
      "Subtitles by the Amara.org community",
      "Gracias por ver el video",
      "[BLANK_AUDIO]",
      "[Music]",
      "(aplausos)",
    ]) {
      expect(isLikelyHallucination(s), s).toBe(true);
    }
  });

  it("vacío / sólo puntuación / un único carácter → alucinación", () => {
    expect(isLikelyHallucination("")).toBe(true);
    expect(isLikelyHallucination("   ")).toBe(true);
    expect(isLikelyHallucination(".")).toBe(true);
    expect(isLikelyHallucination("...")).toBe(true);
    expect(isLikelyHallucination("¿?")).toBe(true);
    expect(isLikelyHallucination("y")).toBe(true);
  });

  it("habla real corta y válida NO se filtra (sí, ok, dale, no, gracias, hola)", () => {
    for (const s of ["sí", "si", "ok", "dale", "no", "gracias", "hola", "buenas", "ya está"]) {
      expect(isLikelyHallucination(s), s).toBe(false);
    }
  });

  it("frase real que contiene una palabra-basura NO se filtra (match exacto, no substring)", () => {
    expect(isLikelyHallucination("gracias por el dato que me pasaste")).toBe(false);
    expect(isLikelyHallucination("thank you for the report, please review it")).toBe(false);
  });
});

describe("analyzeWavPcm16 (pre-check de audio)", () => {
  it("buffer no-WAV / muy corto → null (degrada a transcribir igual)", () => {
    expect(analyzeWavPcm16(Buffer.from(""))).toBeNull();
    expect(analyzeWavPcm16(Buffer.from("no soy un wav"))).toBeNull();
  });

  it("duración = muestras / sampleRate", () => {
    const s = analyzeWavPcm16(makeWav(16000, 1000)); // 1.0s @ 16kHz
    expect(s).not.toBeNull();
    expect(s?.durationSec).toBeCloseTo(1.0, 3);
    expect(s?.samples).toBe(16000);
  });

  it("silencio absoluto (amp 0) → rmsDbfs -Infinity", () => {
    const s = analyzeWavPcm16(makeWav(16000, 0));
    expect(s?.rmsDbfs).toBe(Number.NEGATIVE_INFINITY);
  });

  it("amplitud alta → rmsDbfs por encima de -50", () => {
    const s = analyzeWavPcm16(makeWav(16000, 3000));
    expect(s?.rmsDbfs).toBeGreaterThan(-50);
  });

  it("data size declarado mayor que el buffer → clampea (clip truncado, no crashea)", () => {
    const wav = makeWav(100, 1000);
    wav.writeUInt32LE(999_999, 40); // miente el tamaño del chunk data
    const s = analyzeWavPcm16(wav);
    expect(s).not.toBeNull();
    expect(s?.samples).toBe(100); // sólo cuenta lo realmente presente
  });
});

describe("classifyAudio (guard primario)", () => {
  const MIN = 400; // ms
  const SIL = -50; // dBFS
  it("audio demasiado corto → tooShort", () => {
    expect(classifyAudio(makeWav(1600, 3000), MIN, SIL)).toBe("tooShort"); // 0.1s
  });
  it("audio silencioso (largo pero sin nivel) → silent", () => {
    expect(classifyAudio(makeWav(16000, 0), MIN, SIL)).toBe("silent"); // 1s de silencio
    expect(classifyAudio(makeWav(16000, 50), MIN, SIL)).toBe("silent"); // ~-56 dBFS
  });
  it("audio con habla (duración + nivel ok) → ok", () => {
    expect(classifyAudio(makeWav(16000, 3000), MIN, SIL)).toBe("ok");
  });
  it("buffer no analizable → null (transcribir igual)", () => {
    expect(classifyAudio(Buffer.from(""), MIN, SIL)).toBeNull();
  });
});

describe("transcribeDetailed — guard de audio + motivo", () => {
  beforeEach(() => {
    h.execCalls.length = 0;
    h.sttText = "hola";
    h.wavBuf = Buffer.from("");
    vi.stubEnv("SPEECH_PYTHON", "python3");
  });

  it("audio silencioso → reason 'silent', text '' y NO llama a stt.py", async () => {
    h.wavBuf = makeWav(16000, 0); // 1s de silencio
    const r = await transcribeDetailed(Buffer.from("x"));
    expect(r).toEqual({ text: "", reason: "silent" });
    expect(h.execCalls.some((c) => c.args.some((a) => a.includes("stt.py")))).toBe(false);
  });

  it("audio demasiado corto → reason 'tooShort' y NO transcribe", async () => {
    h.wavBuf = makeWav(1600, 3000); // 0.1s
    const r = await transcribeDetailed(Buffer.from("x"));
    expect(r).toEqual({ text: "", reason: "tooShort" });
    expect(h.execCalls.some((c) => c.args.some((a) => a.includes("stt.py")))).toBe(false);
  });

  it("audio con sonido pero STT alucina → reason 'noSpeech' (segunda red)", async () => {
    h.wavBuf = makeWav(16000, 3000);
    h.sttText = "Thanks for watching!";
    const r = await transcribeDetailed(Buffer.from("x"), "audio/ogg", "en");
    expect(r).toEqual({ text: "", reason: "noSpeech" });
  });

  it("audio con habla real → reason 'ok' + texto", async () => {
    h.wavBuf = makeWav(16000, 3000);
    h.sttText = "hola, ¿cómo estás?";
    const r = await transcribeDetailed(Buffer.from("x"));
    expect(r).toEqual({ text: "hola, ¿cómo estás?", reason: "ok" });
  });

  it("WAV no analizable → degrada a transcribir igual (reason ok)", async () => {
    h.wavBuf = Buffer.from(""); // analyze → null → no se descarta
    h.sttText = "dale";
    const r = await transcribeDetailed(Buffer.from("x"));
    expect(r).toEqual({ text: "dale", reason: "ok" });
  });
});

describe("splitWavForStt (chunking de audios largos)", () => {
  const frames = (chunk: Buffer) => (chunk.length - 44) / 2; // PCM-16 mono

  it("WAV bajo el umbral → [el MISMO buffer], sin copiar (hot path intacto)", () => {
    const wav = makeWav(16000, 3000); // 1s
    const out = splitWavForStt(wav, 2);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(wav); // identidad, no copia
  });

  it("buffer no parseable → [el mismo buffer] (legacy: un solo request)", () => {
    const junk = Buffer.from("no soy un wav");
    expect(splitWavForStt(junk, 2)).toEqual([junk]);
  });

  it("WAV largo → N chunks, cada uno bajo el máximo, sin perder ni duplicar frames", () => {
    const wav = makeWav(16000 * 7, 3000); // 7s @ chunks de 2s
    const out = splitWavForStt(wav, 2);
    expect(out.length).toBeGreaterThanOrEqual(4); // ⌈7/2⌉
    const maxFrames = 2 * 16000;
    let total = 0;
    for (const chunk of out) {
      expect(frames(chunk)).toBeLessThanOrEqual(maxFrames);
      expect(analyzeWavPcm16(chunk)).not.toBeNull(); // cada chunk es un WAV válido standalone
      total += frames(chunk);
    }
    expect(total).toBe(16000 * 7); // se preserva TODO el audio (sin overlap → sin dedup)
    // y el data concatenado de los chunks == el data original (mismo orden, mismos bytes)
    const joined = Buffer.concat(out.map((c) => c.subarray(44)));
    expect(joined.equals(wav.subarray(44))).toBe(true);
  });

  it("el corte cae en el tramo silencioso cercano al target (no parte palabras)", () => {
    // 5s de señal con un hueco de silencio en frames [19000, 25000]. Con chunks de 2s, el
    // target del primer corte es el frame 24000 y la ventana de búsqueda [16000, 32000]: el
    // punto más silencioso está dentro del hueco.
    const wav = makeWav(16000 * 5, 3000);
    wav.fill(0, 44 + 19000 * 2, 44 + 25000 * 2);
    const out = splitWavForStt(wav, 2);
    const cut = frames(out[0]!);
    expect(cut).toBeGreaterThanOrEqual(19000);
    expect(cut).toBeLessThanOrEqual(25000);
  });
});

describe("transcribeDetailed — chunking inworld (audios largos)", () => {
  // Cada request capturado: el base64 que viajó en audioData.content.
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    h.execCalls.length = 0;
    vi.stubEnv("SPEECH_PROVIDER", "inworld");
    vi.stubEnv("INWORLD_API_KEY", "test-key");
    vi.stubEnv("STT_CHUNK_SECONDS", "2"); // chunks chicos para test (default real: 300s)
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Stubbea fetch: `reply(n)` decide la respuesta del request n-ésimo (texto o error HTTP). */
  function stubFetch(reply: (n: number) => string | Error) {
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { audioData: { content: string } };
      const n = calls.length;
      calls.push(body.audioData.content);
      const r = reply(n);
      if (r instanceof Error) return { ok: false, status: 429, text: async () => r.message };
      return { ok: true, json: async () => ({ transcription: { transcript: r } }) };
    });
  }

  it("WAV largo → N requests en orden, cada uno bajo el límite, texto concatenado", async () => {
    h.wavBuf = makeWav(16000 * 7, 3000); // 7s @ chunks de 2s → 4 chunks
    stubFetch((n) => `parte${n}`);
    const r = await transcribeDetailed(Buffer.from("x"));
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(r.reason).toBe("ok");
    expect(r.text).toBe(calls.map((_, n) => `parte${n}`).join(" ")); // orden preservado
    // ningún request supera el máximo por chunk (ni en raw decodificado ni en base64)
    const maxRaw = 44 + 2 * 16000 * 2; // header + 2s de PCM-16 mono 16kHz
    for (const content of calls) {
      expect(Buffer.from(content, "base64").length).toBeLessThanOrEqual(maxRaw);
      expect(content.length).toBeLessThanOrEqual(Math.ceil(maxRaw / 3) * 4);
    }
  });

  it("WAV bajo el umbral → UN solo request (sin chunking)", async () => {
    h.wavBuf = makeWav(16000, 3000); // 1s < 2s
    stubFetch(() => "hola che");
    const r = await transcribeDetailed(Buffer.from("x"));
    expect(calls).toHaveLength(1);
    expect(r).toEqual({ text: "hola che", reason: "ok" });
  });

  it("default sin STT_CHUNK_SECONDS: un audio de varios segundos sigue en UN request", async () => {
    vi.stubEnv("STT_CHUNK_SECONDS", ""); // sin override → 300s
    h.wavBuf = makeWav(16000 * 7, 3000);
    stubFetch(() => "todo junto");
    const r = await transcribeDetailed(Buffer.from("x"));
    expect(calls).toHaveLength(1);
    expect(r.text).toBe("todo junto");
  });

  it("un chunk falla tras los reintentos → transcripción parcial con marcador", async () => {
    h.wavBuf = makeWav(16000 * 3, 3000); // 3s @ chunks de 2s → 2 chunks
    expect(splitWavForStt(h.wavBuf, 2)).toHaveLength(2);
    // chunk 0 ok (request 0); chunk 1 falla los 3 intentos (requests 1..3)
    stubFetch((n) => (n === 0 ? "uno" : new Error("boom")));
    const r = await transcribeDetailed(Buffer.from("x"));
    expect(calls).toHaveLength(4); // 1 + 3 reintentos
    expect(r).toEqual({ text: `uno ${STT_CHUNK_FAILED_MARKER}`, reason: "ok" });
  });

  it("un chunk falla pero se recupera en el reintento → texto completo sin marcador", async () => {
    h.wavBuf = makeWav(16000 * 3, 3000); // 2 chunks
    // requests: 0→"uno"; 1→error (chunk 1, intento 1); 2→"dos" (chunk 1, intento 2)
    stubFetch((n) => (n === 1 ? new Error("flaky") : n === 0 ? "uno" : "dos"));
    const r = await transcribeDetailed(Buffer.from("x"));
    expect(calls).toHaveLength(3);
    expect(r).toEqual({ text: "uno dos", reason: "ok" });
  });

  it("TODOS los chunks fallan → propaga el error (no devuelve sólo markers)", async () => {
    h.wavBuf = makeWav(16000 * 3, 3000); // 2 chunks
    stubFetch(() => new Error("inworld caído"));
    await expect(transcribeDetailed(Buffer.from("x"))).rejects.toThrow(/inworld caído/);
  });

  it("chunk silencioso se saltea (pre-check por chunk) y chunk alucinado se filtra", async () => {
    // 6s: señal 0–2s, SILENCIO 2–4s, señal 4–6s. Algún chunk cae entero en el hueco de
    // silencio (el corte silence-aware busca justamente eso) → no gasta request.
    const wav = makeWav(16000 * 6, 3000);
    wav.fill(0, 44 + 16000 * 2 * 2, 44 + 16000 * 4 * 2);
    h.wavBuf = wav;
    const nChunks = splitWavForStt(wav, 2).length;
    stubFetch((n) => (n === 0 ? "hola" : n === 1 ? "Thanks for watching!" : "chau"));
    const r = await transcribeDetailed(Buffer.from("x"));
    expect(calls.length).toBeLessThan(nChunks); // al menos un chunk silencioso NO fue a la API
    expect(r.reason).toBe("ok");
    expect(r.text).not.toContain("Thanks"); // la alucinación por-chunk no ensucia el total
    expect(r.text).toContain("hola");
  });

  /** Captura el `transcribeConfig` de cada request (no sólo el audio) para asertar el hint de idioma. */
  function stubFetchCapturingConfig(configs: Array<Record<string, unknown>>) {
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { transcribeConfig: Record<string, unknown> };
      configs.push(body.transcribeConfig);
      return { ok: true, json: async () => ({ transcription: { transcript: "hola" } }) };
    });
  }

  it("lang explícito → se forwardea como transcribeConfig.language (hint de idioma)", async () => {
    h.wavBuf = makeWav(16000, 3000); // 1s → un solo request
    const configs: Array<Record<string, unknown>> = [];
    stubFetchCapturingConfig(configs);
    await transcribeDetailed(Buffer.from("x"), "audio/ogg", "es");
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ language: "es", audioEncoding: "LINEAR16" });
  });

  it("sin lang → NO se manda el campo language (autodetect a ciegas)", async () => {
    h.wavBuf = makeWav(16000, 3000);
    const configs: Array<Record<string, unknown>> = [];
    stubFetchCapturingConfig(configs);
    await transcribeDetailed(Buffer.from("x"));
    expect(configs).toHaveLength(1);
    expect(configs[0]).not.toHaveProperty("language");
  });

  it("audio largo (chunked) → cada chunk lleva el hint de idioma", async () => {
    h.wavBuf = makeWav(16000 * 5, 3000); // 5s @ chunks de 2s → varios requests
    const configs: Array<Record<string, unknown>> = [];
    stubFetchCapturingConfig(configs);
    await transcribeDetailed(Buffer.from("x"), "audio/ogg", "es");
    expect(configs.length).toBeGreaterThan(1);
    for (const cfg of configs) expect(cfg).toMatchObject({ language: "es" });
  });
});
