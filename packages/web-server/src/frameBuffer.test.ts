// Tests del ring buffer de frames + replay por seq/sid (Fase C, conexión rock-solid).
// Reloj fake inyectado: nada de timers reales.

import { describe, expect, it } from "vitest";
import { FrameBuffer, parseSeq } from "./frameBuffer.ts";

const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
};

describe("FrameBuffer.push — seq monotónico por usuario", () => {
  it("asigna seqs estrictamente crecientes por usuario y los embebe en el payload", () => {
    const c = clock();
    const fb = new FrameBuffer({ now: c.now });
    const a = fb.push(1, { t: "text", text: "uno" });
    const b = fb.push(1, { t: "turn-done" });
    expect(b.seq).toBe(a.seq + 1);
    expect(a.payload).toMatchObject({ t: "text", text: "uno", seq: a.seq });
    expect(b.payload).toMatchObject({ t: "turn-done", seq: b.seq });
  });

  it("contadores independientes entre usuarios (el seq es POR usuario)", () => {
    const c = clock();
    const fb = new FrameBuffer({ now: c.now });
    const u1a = fb.push(1, { t: "text" });
    const u2a = fb.push(2, { t: "text" });
    const u1b = fb.push(1, { t: "text" });
    expect(u1b.seq).toBe(u1a.seq + 1);
    expect(u2a.seq).toBe(u1a.seq); // misma base de reloj, contador propio
  });

  it("la base del seq es el reloj (Date.now) → un restart re-arranca POR ENCIMA de los seqs viejos", () => {
    const c = clock();
    const fb = new FrameBuffer({ now: c.now });
    const old = fb.push(1, { t: "text" }).seq;
    // "Restart": buffer nuevo, reloj avanzado (el proceso re-arrancó después).
    c.tick(60_000);
    const fb2 = new FrameBuffer({ now: c.now });
    expect(fb2.push(1, { t: "text" }).seq).toBeGreaterThan(old);
  });
});

describe("FrameBuffer.since — replay por watermark + sid-routing", () => {
  it("devuelve solo frames con seq > afterSeq, en orden", () => {
    const c = clock();
    const fb = new FrameBuffer({ now: c.now });
    const a = fb.push(1, { t: "typing" });
    const b = fb.push(1, { t: "text", text: "respuesta" });
    const d = fb.push(1, { t: "turn-done" });
    const r = fb.since(1, a.seq);
    expect(r.gap).toBe(false);
    expect(r.frames.map((f) => f.seq)).toEqual([b.seq, d.seq]);
  });

  it("respeta el sid-routing: a una vista vuelven SUS frames de turno + los broadcasts", () => {
    const c = clock();
    const fb = new FrameBuffer({ now: c.now });
    const before = fb.push(1, { t: "ready-marker" }).seq; // watermark base
    fb.push(1, { t: "text", text: "para-iphone" }, "view-iphone");
    fb.push(1, { t: "refresh" }); // broadcast (sin origin)
    fb.push(1, { t: "text", text: "para-mac" }, "view-mac");
    const iphone = fb.since(1, before, "view-iphone");
    expect(iphone.frames.map((f) => f.payload.text ?? f.payload.t)).toEqual(["para-iphone", "refresh"]);
    const mac = fb.since(1, before, "view-mac");
    expect(mac.frames.map((f) => f.payload.text ?? f.payload.t)).toEqual(["refresh", "para-mac"]);
    // Sin sid (stream solo-broadcast): únicamente los frames sin origin, como deliver en vivo.
    const anon = fb.since(1, before);
    expect(anon.frames.map((f) => f.payload.t)).toEqual(["refresh"]);
  });

  it("usuario sin frames / watermark al día → replay vacío sin gap", () => {
    const c = clock();
    const fb = new FrameBuffer({ now: c.now });
    expect(fb.since(7, 123)).toEqual({ frames: [], gap: false });
    const a = fb.push(1, { t: "text" });
    expect(fb.since(1, a.seq)).toEqual({ frames: [], gap: false });
  });
});

describe("FrameBuffer — evicción acotada y detección de gap (resync)", () => {
  it("cap de frames: evicta lo más viejo y marca gap solo si el watermark quedó detrás", () => {
    const c = clock();
    const fb = new FrameBuffer({ maxFrames: 2, now: c.now });
    const a = fb.push(1, { t: "text", text: "1" });
    const b = fb.push(1, { t: "text", text: "2" });
    const d = fb.push(1, { t: "text", text: "3" }); // evicta a `a`
    // Watermark anterior a lo evictado → gap (no podemos garantizar el replay completo).
    const stale = fb.since(1, a.seq - 1);
    expect(stale.gap).toBe(true);
    expect(stale.frames.map((f) => f.payload.text)).toEqual(["2", "3"]); // best effort igual
    // Watermark al día con lo evictado → replay confiable, sin gap.
    const fresh = fb.since(1, b.seq);
    expect(fresh).toMatchObject({ gap: false });
    expect(fresh.frames.map((f) => f.payload.text)).toEqual(["3"]);
    expect(d.seq).toBeGreaterThan(b.seq);
  });

  it("cap de bytes: un frame pesado (voice base64) empuja afuera a los viejos", () => {
    const c = clock();
    const fb = new FrameBuffer({ maxBytes: 800, now: c.now });
    const small = fb.push(1, { t: "text", text: "chico" });
    fb.push(1, { t: "voice", data: "x".repeat(1000) }); // ~1KB serializado: solo, ya excede el cap
    const r = fb.since(1, small.seq - 1);
    expect(r.gap).toBe(true); // el chico fue evictado por bytes
    // El frame pesado se conserva aunque SOLO exceda el cap (es la respuesta del turno;
    // evict mantiene siempre al menos el último frame).
    expect(r.frames.map((f) => f.payload.t)).toEqual(["voice"]);
  });

  it("TTL: lo más viejo que la ventana expira y cuenta como gap; sweep() lo poda sin query", () => {
    const c = clock();
    const fb = new FrameBuffer({ ttlMs: 10_000, now: c.now });
    const a = fb.push(1, { t: "text", text: "viejo" });
    c.tick(11_000); // expira `a`
    const b = fb.push(1, { t: "text", text: "nuevo" });
    const r = fb.since(1, a.seq - 1);
    expect(r.gap).toBe(true);
    expect(r.frames.map((f) => f.payload.text)).toEqual(["nuevo"]);
    // sweep(): la poda periódica libera memoria aunque nadie reconecte.
    c.tick(11_000); // ahora expira `b` también
    fb.sweep();
    expect(fb.totalBytes()).toBe(0);
    // …y el gap sigue siendo detectable tras el sweep (estado escalar conservado).
    expect(fb.since(1, b.seq - 1).gap).toBe(true);
  });
});

describe("parseSeq — watermark de Last-Event-ID / ?since=", () => {
  it("parsea números válidos y degrada todo lo demás a 0", () => {
    expect(parseSeq("123")).toBe(123);
    expect(parseSeq(["456", "789"])).toBe(456); // header repetido → el primero
    expect(parseSeq("123.9")).toBe(123);
    expect(parseSeq("")).toBe(0);
    expect(parseSeq(null)).toBe(0);
    expect(parseSeq(undefined)).toBe(0);
    expect(parseSeq("abc")).toBe(0);
    expect(parseSeq("-5")).toBe(0);
    expect(parseSeq("Infinity")).toBe(0);
  });
});
