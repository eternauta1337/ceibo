// Tests del dedup por seq del cliente (Fase C): la garantía de que un replay del server
// (frames re-emitidos al reconectar) NO duplica burbujas ni descuadra contadores — todo
// frame ya procesado se descarta antes de tocar estado. Pura, sin DOM (tests en node).

import { describe, expect, it } from "vitest";
import { acceptFrame, streamUrl } from "./frameSeq.ts";
import { subagentCountFromFrame } from "./subAgent.ts";

describe("acceptFrame — idempotencia del replay", () => {
  it("frames con seq creciente se aceptan y avanzan el watermark", () => {
    let last = 0;
    const a = acceptFrame(last, { seq: 100 });
    expect(a).toEqual({ accept: true, next: 100 });
    last = a.next;
    expect(acceptFrame(last, { seq: 101 })).toEqual({ accept: true, next: 101 });
  });

  it("un frame replayed ya visto (seq ≤ watermark) se DESCARTA — ni igual ni menor pasan", () => {
    expect(acceptFrame(100, { seq: 100 })).toEqual({ accept: false, next: 100 });
    expect(acceptFrame(100, { seq: 99 })).toEqual({ accept: false, next: 100 });
  });

  it("huecos en el seq son normales (frames de turno de OTRAS vistas): se acepta igual", () => {
    expect(acceptFrame(100, { seq: 150 })).toEqual({ accept: true, next: 150 });
  });

  it("frames sin seq (ready/ping/resync, control de conexión) pasan siempre sin mover el watermark", () => {
    expect(acceptFrame(100, {})).toEqual({ accept: true, next: 100 });
    expect(acceptFrame(100, { seq: undefined })).toEqual({ accept: true, next: 100 });
  });

  it("seq no-numérico o no-finito (server raro/futuro) degrada a aceptar sin mover el watermark", () => {
    expect(acceptFrame(100, { seq: "123" })).toEqual({ accept: true, next: 100 });
    expect(acceptFrame(100, { seq: Number.NaN })).toEqual({ accept: true, next: 100 });
  });

  it("tras un restart del server (seq re-basado en Date.now, mayor que el viejo) NO se traga frames", () => {
    const oldWatermark = 1_700_000_000_123; // seq de la sesión anterior del server
    const fresh = acceptFrame(oldWatermark, { seq: 1_700_000_400_000 }); // base nueva = now > viejo
    expect(fresh.accept).toBe(true);
  });

  it("escenario completo: el replay de un turno ya visto no duplica el conteo de sub-agentes", () => {
    // Vivo: subagents 1 → 0. Replay de los MISMOS frames (mismos seqs) → dedup los frena
    // antes de la reducción y el conteo queda como estaba.
    const frames = [
      { t: "subagents", count: 1, seq: 10 },
      { t: "subagents", count: 0, seq: 11 },
    ];
    let last = 0;
    let count = 0;
    for (const f of frames) {
      const d = acceptFrame(last, f);
      if (!d.accept) continue;
      last = d.next;
      count = subagentCountFromFrame(count, f);
    }
    expect(count).toBe(0);
    // Reconnect con watermark viejo → el server re-emite ambos: ninguno pasa el dedup.
    for (const f of frames) {
      const d = acceptFrame(last, f);
      expect(d.accept).toBe(false);
    }
    expect(count).toBe(0);
  });
});

describe("streamUrl — el since del reconnect manual", () => {
  it("sin watermark (boot) no manda since; con watermark lo manda", () => {
    expect(streamUrl("view-1", 0)).toBe("/api/stream?sid=view-1");
    expect(streamUrl("view-1", 123)).toBe("/api/stream?sid=view-1&since=123");
  });

  it("escapa el sid", () => {
    expect(streamUrl("a b", 0)).toBe("/api/stream?sid=a%20b");
  });
});
