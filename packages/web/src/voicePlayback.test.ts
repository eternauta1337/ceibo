import { describe, expect, it } from "vitest";
import { fmtVoiceTime, shouldAutoplayVoice } from "./voicePlayback";

describe("shouldAutoplayVoice", () => {
  it("chat cerrado (orbe): autoplay siempre, haya sido voz o texto", () => {
    expect(shouldAutoplayVoice(true, false)).toBe(true);
    expect(shouldAutoplayVoice(true, true)).toBe(true);
  });

  it("chat abierto + turno por TEXTO: no autoplay (Telegram-like, play manual)", () => {
    expect(shouldAutoplayVoice(false, false)).toBe(false);
  });

  it("chat abierto + turno por NOTA DE VOZ: autoplay igual (pedido del owner)", () => {
    expect(shouldAutoplayVoice(false, true)).toBe(true);
  });

  it("turno MUTEADO (tap en el orbe mientras hablaba): nunca autoplay, gane lo que gane lo demás", () => {
    // muted manda sobre el default de orbe Y sobre el turno-por-voz: la voz de ese turno no suena.
    expect(shouldAutoplayVoice(true, false, true)).toBe(false);
    expect(shouldAutoplayVoice(true, true, true)).toBe(false);
    expect(shouldAutoplayVoice(false, true, true)).toBe(false);
  });

  it("sin mutear (default del flag): se comporta como antes", () => {
    expect(shouldAutoplayVoice(true, false, false)).toBe(true);
    expect(shouldAutoplayVoice(false, false, false)).toBe(false);
  });
});

describe("fmtVoiceTime", () => {
  it("formatea m:ss con cero a la izquierda en los segundos", () => {
    expect(fmtVoiceTime(0)).toBe("0:00");
    expect(fmtVoiceTime(7.4)).toBe("0:07");
    expect(fmtVoiceTime(59.9)).toBe("0:59");
    expect(fmtVoiceTime(60)).toBe("1:00");
    expect(fmtVoiceTime(83)).toBe("1:23");
    expect(fmtVoiceTime(605)).toBe("10:05");
  });

  it("metadata sin cargar (NaN/Infinity) o negativos → 0:00", () => {
    expect(fmtVoiceTime(Number.NaN)).toBe("0:00");
    expect(fmtVoiceTime(Number.POSITIVE_INFINITY)).toBe("0:00");
    expect(fmtVoiceTime(-3)).toBe("0:00");
  });
});
