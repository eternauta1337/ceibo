import { describe, expect, it } from "vitest";
import {
  type AnyFrame,
  type ControlFrame,
  checkAuth,
  createFrameDecoder,
  deriveConnSecret,
  encodeFrame,
} from "./protocol.ts";

describe("encodeFrame", () => {
  it("serializa a una línea JSON con \\n terminador", () => {
    const line = encodeFrame({ t: "out", user: "u1", text: "hola" });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line.trimEnd())).toEqual({ t: "out", user: "u1", text: "hola" });
  });

  it("round-trip con el decoder", () => {
    const frame: AnyFrame = { t: "msg", user: "u1", text: "hi" };
    const [decoded] = createFrameDecoder().push(encodeFrame(frame));
    expect(decoded).toEqual(frame);
  });

  it("round-trip de un `msg` con adjuntos (media)", () => {
    const frame: AnyFrame = {
      t: "msg",
      user: "u1",
      text: "mirá",
      media: [
        { kind: "image", mediaType: "image/png", data: "AAAA", filename: "foto.png" },
        { kind: "document", mediaType: "application/pdf", data: "BBBB" },
      ],
    };
    const [decoded] = createFrameDecoder().push(encodeFrame(frame));
    expect(decoded).toEqual(frame);
  });
});

describe("createFrameDecoder", () => {
  it("drena varias líneas (batch) en una sola push", () => {
    const dec = createFrameDecoder();
    const chunk = encodeFrame({ t: "ping" } as unknown as AnyFrame) + encodeFrame({ t: "auth-ok" });
    const out = dec.push(chunk);
    expect(out.map((f) => f.t)).toEqual(["ping", "auth-ok"]);
  });

  it("buffer incremental: una línea partida en dos chunks se entrega completa", () => {
    const dec = createFrameDecoder();
    expect(dec.push('{"t":"auth-ok"')).toEqual([]); // sin \n todavía
    const out = dec.push("}\n");
    expect(out).toEqual([{ t: "auth-ok" }]);
  });

  it("ignora líneas vacías y JSON malformado, sin romper las válidas", () => {
    const dec = createFrameDecoder();
    const out = dec.push('\n  \nno-json\n{"t":"auth-ok"}\n');
    expect(out).toEqual([{ t: "auth-ok" }]);
  });

  it("descarta JSON válido que no tiene `t` string (no es un frame)", () => {
    const dec = createFrameDecoder();
    expect(dec.push('{"foo":1}\n')).toEqual([]);
    expect(dec.push('{"t":123}\n')).toEqual([]);
  });

  it("mantiene el estado entre push (el resto sin \\n queda buffereado)", () => {
    const dec = createFrameDecoder();
    expect(dec.push('{"t":"auth-ok"}\n{"t":"ty')).toEqual([{ t: "auth-ok" }]);
    expect(dec.push('ping","user":"u"}\n')).toEqual([{ t: "typing", user: "u" }]);
  });
});

describe("checkAuth", () => {
  it("true si coincide exacto", () => {
    expect(checkAuth("s3cr3t", "s3cr3t")).toBe(true);
  });
  it("false si difiere", () => {
    expect(checkAuth("nope", "s3cr3t")).toBe(false);
  });
  it("false si difiere el largo (sin tirar)", () => {
    expect(checkAuth("short", "much-longer-secret")).toBe(false);
  });
});

describe("deriveConnSecret", () => {
  it("determinista para misma key + label", () => {
    expect(deriveConnSecret("k", "lbl")).toBe(deriveConnSecret("k", "lbl"));
  });
  it("cambia con la key y con el label", () => {
    expect(deriveConnSecret("k1")).not.toBe(deriveConnSecret("k2"));
    expect(deriveConnSecret("k", "a")).not.toBe(deriveConnSecret("k", "b"));
  });
  it("es base64url", () => {
    expect(/^[A-Za-z0-9_-]+$/.test(deriveConnSecret("k"))).toBe(true);
  });
});

describe("ControlFrame (F3 — reset de sesión)", () => {
  it("round-trip de un frame de control reset-session", () => {
    const frame: ControlFrame = { t: "control", op: "reset-session", userId: 42 };
    const [decoded] = createFrameDecoder().push(encodeFrame(frame as unknown as AnyFrame));
    expect(decoded).toEqual(frame);
  });

  it("el decoder no confunde un control frame con un msg frame", () => {
    const dec = createFrameDecoder();
    const msg: AnyFrame = { t: "msg", user: "u1", text: "hi" };
    const ctrl: ControlFrame = { t: "control", op: "reset-session", userId: 7 };
    const [a, b] = dec.push(encodeFrame(msg) + encodeFrame(ctrl as unknown as AnyFrame));
    expect(a).toEqual(msg);
    expect(b).toEqual(ctrl);
  });

  it("serializa con todos los campos requeridos", () => {
    const frame: ControlFrame = { t: "control", op: "reset-session", userId: 1 };
    const line = encodeFrame(frame as unknown as AnyFrame);
    const parsed = JSON.parse(line.trimEnd()) as ControlFrame;
    expect(parsed.t).toBe("control");
    expect(parsed.op).toBe("reset-session");
    expect(parsed.userId).toBe(1);
  });
});
