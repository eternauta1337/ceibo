import { describe, expect, it } from "vitest";
import { type SubAgentState, subAgentBadge, subAgentFromFrame, subagentCountFromFrame } from "./subAgent.ts";

describe("subAgentFromFrame (#29 indicador persistente)", () => {
  it("se ENCIENDE con un frame activity marcado kind:'subagent'", () => {
    const next = subAgentFromFrame(null, {
      t: "activity",
      kind: "subagent",
      label: "consultando a un especialista",
      detail: "opus",
    });
    expect(next).toEqual({ label: "consultando a un especialista", detail: "opus" });
  });

  it("guarda el label aunque no venga detail", () => {
    expect(
      subAgentFromFrame(null, { t: "activity", kind: "subagent", label: "trabajando con un sub-agente" }),
    ).toEqual({ label: "trabajando con un sub-agente" });
  });

  it("un activity NORMAL (tool-call, sin kind) NO enciende ni pisa el estado", () => {
    // Sin sub-agente activo: queda apagado.
    expect(subAgentFromFrame(null, { t: "activity", label: "buscando en la wiki" })).toBe(null);
    // Con sub-agente activo: PERSISTE (no se pisa con cada tool-call — el bug original).
    const active: SubAgentState = { label: "consultando a un especialista", detail: "opus" };
    expect(subAgentFromFrame(active, { t: "activity", label: "actualizando una nota" })).toBe(active);
  });

  it("PERSISTE a través de un text/voice INTERMEDIO del turno (el bug v1)", () => {
    // El agente postea texto intermedio ("ya lo busco…") y DESPUÉS el resumen: ninguno de esos
    // `text`/`voice` debe apagar el badge — el turno no terminó de verdad.
    const active: SubAgentState = { label: "consultando a un especialista", detail: "opus" };
    expect(subAgentFromFrame(active, { t: "text", label: undefined })).toBe(active);
    expect(subAgentFromFrame(active, { t: "voice" })).toBe(active);
  });

  it("se APAGA al fin REAL del turno: turn-done", () => {
    const active: SubAgentState = { label: "consultando a un especialista" };
    expect(subAgentFromFrame(active, { t: "turn-done" })).toBe(null);
  });

  it("se APAGA ante un error terminal", () => {
    const active: SubAgentState = { label: "consultando a un especialista" };
    expect(subAgentFromFrame(active, { t: "error" })).toBe(null);
  });

  it("frames intermedios (typing/heard/refresh/activity) NO tocan el estado", () => {
    const active: SubAgentState = { label: "trabajando con un sub-agente" };
    expect(subAgentFromFrame(active, { t: "typing" })).toBe(active);
    expect(subAgentFromFrame(active, { t: "heard" })).toBe(active);
    expect(subAgentFromFrame(active, { t: "refresh" })).toBe(active);
  });

  it("ignora un kind:'subagent' sin label (no enciende con basura)", () => {
    expect(subAgentFromFrame(null, { t: "activity", kind: "subagent" })).toBe(null);
  });
});

describe("subAgentBadge (v2 presentación: modelo + capacidad + actividad live)", () => {
  it("mapea el tier a modelo + capacidad family-friendly", () => {
    expect(subAgentBadge({ label: "consultando a un especialista", detail: "opus" }, null)).toEqual({
      head: "Opus · especialista",
    });
    expect(subAgentBadge({ label: "trabajando con un sub-agente", detail: "sonnet" }, null)).toEqual({
      head: "Sonnet · intermedio",
    });
    expect(subAgentBadge({ label: "trabajando con un sub-agente", detail: "haiku" }, null)).toEqual({
      head: "Haiku · rápido",
    });
  });

  it("combina el tipo (fijo) con la actividad en curso (live)", () => {
    expect(
      subAgentBadge({ label: "consultando a un especialista", detail: "opus" }, "buscando en la web"),
    ).toEqual({ head: "Opus · especialista", activity: "buscando en la web" });
  });

  it("sin tier conocido cae al label amable del sub-agente", () => {
    expect(subAgentBadge({ label: "trabajando con un sub-agente" }, null)).toEqual({
      head: "trabajando con un sub-agente",
    });
    expect(
      subAgentBadge({ label: "trabajando con un sub-agente", detail: "qwen-7b" }, "leyendo la wiki"),
    ).toEqual({ head: "trabajando con un sub-agente", activity: "leyendo la wiki" });
  });
});

describe("subagentCountFromFrame (mini-orbs por sub-agente activo)", () => {
  it("adopta el conteo del frame `subagents` (única fuente de verdad)", () => {
    expect(subagentCountFromFrame(0, { t: "subagents", count: 3 })).toBe(3);
    expect(subagentCountFromFrame(3, { t: "subagents", count: 1 })).toBe(1);
  });

  it("clampea a ≥0 y trata count ausente como 0", () => {
    expect(subagentCountFromFrame(2, { t: "subagents", count: -5 })).toBe(0);
    expect(subagentCountFromFrame(2, { t: "subagents" })).toBe(0);
  });

  it("PERSISTE a través de turn-done y error (delegación v2: el worker sobrevive al turno)", () => {
    // El spawn cierra el turno al instante (turn-done) con el worker recién nacido: el reset
    // local en turn-done apagaba su mini-orb apenas aparecía (el bug). El conteo sólo lo baja
    // un frame `subagents` con count menor (el gateway re-afirma el absoluto tras cada borde).
    expect(subagentCountFromFrame(1, { t: "turn-done" })).toBe(1);
    expect(subagentCountFromFrame(4, { t: "error" })).toBe(4);
  });

  it("coreografía completa del spawn: el mini-orb nace, persiste el turn-done y se apaga con el `subagents` final", () => {
    let count = 0;
    // spawn: aviso + turn-done + count provisional 1 (y re-afirmación al registrar el worker).
    count = subagentCountFromFrame(count, { t: "turn-done" });
    count = subagentCountFromFrame(count, { t: "subagents", count: 1 });
    expect(count).toBe(1);
    // el usuario sigue charlando: su turno cierra (turn-done) y el gateway re-afirma 1.
    count = subagentCountFromFrame(count, { t: "text" });
    count = subagentCountFromFrame(count, { t: "turn-done" });
    expect(count).toBe(1); // el mini-orb del worker PERSISTE
    count = subagentCountFromFrame(count, { t: "subagents", count: 1 });
    expect(count).toBe(1);
    // el worker entrega su resumen: el gateway emite el conteo decrementado → orb fuera.
    count = subagentCountFromFrame(count, { t: "subagents", count: 0 });
    expect(count).toBe(0);
  });

  it("MA cloud: el `subagents` absoluto post-turno (0) apaga los sub-agentes `task` del turno", () => {
    // En MA los sub-agentes viven DENTRO del turno; el apagado ya no es un reset local en
    // turn-done sino el frame `subagents: 0` que el gateway emite justo después (turnComplete).
    let count = subagentCountFromFrame(0, { t: "subagents", count: 2 });
    count = subagentCountFromFrame(count, { t: "turn-done" });
    count = subagentCountFromFrame(count, { t: "subagents", count: 0 });
    expect(count).toBe(0);
  });

  it("NO toca el conteo en frames intermedios (text/voice/activity/heard/typing)", () => {
    for (const t of ["text", "voice", "activity", "heard", "typing", "chat-title"]) {
      expect(subagentCountFromFrame(2, { t })).toBe(2);
    }
  });
});
