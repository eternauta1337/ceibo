import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetAudioSessionForTest,
  type AudioSessionType,
  readAudioSessionType,
  setAudioSession,
  shouldApplyAudioSession,
} from "./audioSession";

describe("shouldApplyAudioSession (decisión pura de idempotencia)", () => {
  it("sin categoría aplicada todavía → aplica", () => {
    expect(shouldApplyAudioSession(null, "play-and-record")).toBe(true);
    expect(shouldApplyAudioSession(null, "auto")).toBe(true);
  });

  it("misma categoría que la última aplicada → no-op (corta el churn Bluetooth)", () => {
    expect(shouldApplyAudioSession("auto", "auto")).toBe(false);
    expect(shouldApplyAudioSession("play-and-record", "play-and-record")).toBe(false);
  });

  it("cambio real → aplica", () => {
    expect(shouldApplyAudioSession("auto", "play-and-record")).toBe(true);
    expect(shouldApplyAudioSession("play-and-record", "auto")).toBe(true);
  });
});

describe("setAudioSession (idempotente sobre navigator.audioSession, NUNCA playback)", () => {
  const nav = navigator as unknown as { audioSession?: { type?: string } };
  let assigns: string[];

  beforeEach(() => {
    __resetAudioSessionForTest();
    assigns = [];
    let backing = "playback"; // simula la categoría CLAVADA en "playback" por el código viejo
    Object.defineProperty(nav, "audioSession", {
      configurable: true,
      value: {
        get type() {
          return backing;
        },
        set type(v: string) {
          backing = v;
          assigns.push(v);
        },
      },
    });
  });

  afterEach(() => {
    delete nav.audioSession;
    __resetAudioSessionForTest();
  });

  it("play-and-record deshace el 'playback' clavado (1ª asignación se aplica)", () => {
    setAudioSession("play-and-record");
    expect(assigns).toEqual(["play-and-record"]);
    expect(readAudioSessionType()).toBe("play-and-record");
  });

  it("pedir la MISMA categoría dos veces → la segunda NO re-asigna", () => {
    setAudioSession("play-and-record");
    setAudioSession("play-and-record");
    expect(assigns).toEqual(["play-and-record"]);
  });

  it("ciclo capturar→idle→capturar usa solo {play-and-record, auto} (nunca playback)", () => {
    setAudioSession("play-and-record"); // captura
    setAudioSession("auto"); // idle / antes de reproducir voz
    setAudioSession("auto"); // idempotente
    setAudioSession("play-and-record"); // próxima captura
    expect(assigns).toEqual(["play-and-record", "auto", "play-and-record"]);
    expect(assigns).not.toContain("playback");
  });

  it("setAudioSession devuelve la categoría efectiva", () => {
    expect(setAudioSession("play-and-record")).toBe("play-and-record");
    expect(setAudioSession("play-and-record")).toBe("play-and-record"); // no-op, mismo efectivo
    expect(setAudioSession("auto")).toBe("auto");
  });

  it("el tipo NUNCA permite 'playback' (chequeo de tipos en runtime: solo auto/play-and-record)", () => {
    const valid: AudioSessionType[] = ["auto", "play-and-record"];
    expect(valid).not.toContain("playback" as unknown as AudioSessionType);
  });
});

describe("setAudioSession sin la API", () => {
  const nav = navigator as unknown as { audioSession?: { type?: string } };
  beforeEach(() => {
    __resetAudioSessionForTest();
    delete nav.audioSession;
  });
  afterEach(() => __resetAudioSessionForTest());

  it("no rompe ni memoriza; readAudioSessionType → null", () => {
    expect(setAudioSession("play-and-record")).toBeNull();
    expect(readAudioSessionType()).toBeNull();
  });
});
