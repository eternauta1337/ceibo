import { describe, expect, it } from "vitest";
import { appendAgentBubble, makeAgentBubble } from "./agentBubble.ts";

describe("makeAgentBubble (patch → burbuja del agente)", () => {
  it("aplica defaults: mode=text, text='', thinking=false", () => {
    expect(makeAgentBubble("a", {})).toEqual({
      id: "a",
      role: "agent",
      mode: "text",
      text: "",
      thinking: false,
      audioUrl: undefined,
    });
  });

  it("respeta los valores explícitos (voz con audioUrl)", () => {
    expect(makeAgentBubble("v", { mode: "voice", text: "hola", audioUrl: "blob:x" })).toEqual({
      id: "v",
      role: "agent",
      mode: "voice",
      text: "hola",
      thinking: false,
      audioUrl: "blob:x",
    });
  });
});

describe("appendAgentBubble — INVARIANTE del web fix: mensajes del agente append-only e inmutables", () => {
  it("appendea una burbuja nueva sin mutar el array de entrada", () => {
    const before = [makeAgentBubble("u1", { text: "hola" })];
    const after = appendAgentBubble(before, "a1", { text: "respuesta" });
    expect(after).toHaveLength(2);
    expect(before).toHaveLength(1); // el original NO se mutó (array nuevo)
    expect(after[1]?.id).toBe("a1");
  });

  it("DOS mensajes del agente en el mismo turno → DOS burbujas; el primero NO se pisa", () => {
    // El caso real: en un turno llegan (1) el link de conexión que postea el sistema out-of-band
    // y (2) la respuesta del modelo. Antes (upsert + id ref reusado) el 2do pisaba al 1ro y el
    // usuario veía el placeholder en vez del link. Append-only → los dos coexisten.
    const link = "Para conectar tu cuenta de gmail, abrí este link:\nhttps://app/oauth/start?t=tok";
    let msgs = appendAgentBubble([], "link", { text: link });
    msgs = appendAgentBubble(msgs, "reply", { text: "Te pasé el link, avisame cuando autorices." });

    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.id).toBe("link");
    expect(msgs[0]?.text).toBe(link); // ← la burbuja del link sigue intacta (no la pisó la respuesta)
    expect(msgs[1]?.id).toBe("reply");
    // ids distintos: nunca se reusa una burbuja en vuelo
    expect(msgs[0]?.id).not.toBe(msgs[1]?.id);
  });

  it("no muta una burbuja ya emitida al appendear la siguiente", () => {
    const first = appendAgentBubble([], "first", { text: "uno" });
    const firstBubble = first[0];
    const second = appendAgentBubble(first, "second", { text: "dos" });
    // la referencia de la 1ra burbuja se preserva sin cambios (inmutable)
    expect(second[0]).toBe(firstBubble);
    expect(second[0]?.text).toBe("uno");
  });
});
