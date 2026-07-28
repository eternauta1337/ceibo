import type { ServerFrame } from "@ceibo/channels";
import { describe, expect, it } from "vitest";
import { serverFrameToClient } from "./frames.ts";

const U = "ale"; // user/handle: el mapeo lo ignora (lo resuelve el entry-point), pero el tipo lo pide.

describe("serverFrameToClient", () => {
  it("mapea los frames de respuesta del agente", () => {
    expect(serverFrameToClient({ t: "out", user: U, text: "hola" })).toEqual({ t: "text", text: "hola" });
    expect(serverFrameToClient({ t: "typing", user: U })).toEqual({ t: "typing" });
    expect(serverFrameToClient({ t: "heard", user: U, text: "oído" })).toEqual({ t: "heard", text: "oído" });
    expect(serverFrameToClient({ t: "turn-done", user: U })).toEqual({ t: "turn-done" });
    expect(serverFrameToClient({ t: "error", user: U, error: "boom" })).toEqual({
      t: "error",
      error: "boom",
    });
    expect(serverFrameToClient({ t: "chat-title", user: U, title: "Tema" })).toEqual({
      t: "chat-title",
      title: "Tema",
    });
  });

  it("voice mapea bytes→data", () => {
    const bytes = "AQID"; // base64 en el cable (VoiceFrame.bytes es string)
    expect(serverFrameToClient({ t: "voice", user: U, mime: "audio/ogg", bytes, text: "t" })).toEqual({
      t: "voice",
      mime: "audio/ogg",
      data: bytes,
      text: "t",
    });
  });

  it("viewer→open y created mantienen repo/path/sha", () => {
    expect(serverFrameToClient({ t: "viewer", user: U, repo: "r", path: "p" })).toEqual({
      t: "open",
      repo: "r",
      path: "p",
    });
    expect(serverFrameToClient({ t: "created", user: U, repo: "r", path: "p", sha: "s" })).toEqual({
      t: "created",
      repo: "r",
      path: "p",
      sha: "s",
    });
  });

  it("reenvía el frame `subagents` con su count (regresión: antes moría en el web-server)", () => {
    expect(serverFrameToClient({ t: "subagents", user: U, count: 3 })).toEqual({
      t: "subagents",
      count: 3,
    });
    expect(serverFrameToClient({ t: "subagents", user: U, count: 0 })).toEqual({
      t: "subagents",
      count: 0,
    });
  });

  it("reenvía el frame `notice` con su texto (aviso de sistema: compactada / reiniciada)", () => {
    expect(serverFrameToClient({ t: "notice", user: U, text: "Conversación compactada" })).toEqual({
      t: "notice",
      text: "Conversación compactada",
    });
  });

  it("activity incluye `kind` sólo cuando viene (sub-agente vs tool-call normal)", () => {
    expect(serverFrameToClient({ t: "activity", user: U, label: "buscando", detail: "q" })).toEqual({
      t: "activity",
      label: "buscando",
      detail: "q",
    });
    expect(serverFrameToClient({ t: "activity", user: U, label: "sub-agente", kind: "subagent" })).toEqual({
      t: "activity",
      label: "sub-agente",
      detail: undefined,
      kind: "subagent",
    });
  });

  it("reenvía el frame `inbox` con su count (feature crons-delivery: sube el badge del FAB 🔔)", () => {
    expect(serverFrameToClient({ t: "inbox", user: U, count: 2 })).toEqual({ t: "inbox", count: 2 });
  });

  it("frames sin payload de cliente (auth) → undefined", () => {
    expect(serverFrameToClient({ t: "auth-ok" } as ServerFrame)).toBeUndefined();
    expect(serverFrameToClient({ t: "auth-err", reason: "x" } as ServerFrame)).toBeUndefined();
  });
});
