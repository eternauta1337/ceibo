import { describe, expect, it } from "vitest";
import {
  formatIntelligenceEvalRun,
  formatManualEvalChecklist,
  makeCapturedEvalTemplate,
  normalizeCapturedOutputs,
  parseCapturedEvalFile,
  runCapturedIntelligenceEvals,
} from "./intelligence-eval-runner.ts";
import { INTELLIGENCE_EVALS } from "./intelligence-evals.ts";

describe("intelligence eval runner", () => {
  it("normaliza outputs capturados desde objeto o array", () => {
    expect([...normalizeCapturedOutputs({ outputs: { a: "uno" } })]).toEqual([["a", "uno"]]);
    expect([...normalizeCapturedOutputs({ outputs: [{ id: "b", output: "dos" }] })]).toEqual([["b", "dos"]]);
  });

  it("genera template completo para captura manual de outputs", () => {
    const template = makeCapturedEvalTemplate(INTELLIGENCE_EVALS);

    expect(Object.keys(template.outputs)).toHaveLength(INTELLIGENCE_EVALS.length);
    expect(template.outputs).toHaveProperty("connections-gmail", "");
    expect(template.cases?.[0]).toMatchObject({
      id: INTELLIGENCE_EVALS[0]?.id,
      input: INTELLIGENCE_EVALS[0]?.input,
      expected: INTELLIGENCE_EVALS[0]?.expected,
    });
  });

  it("genera checklist markdown para smoke manual en prod", () => {
    const checklist = formatManualEvalChecklist(INTELLIGENCE_EVALS);

    expect(checklist).toContain("# Smoke manual");
    expect(checklist).toContain("Mandar `/model`");
    expect(checklist).toContain("## connections-gmail");
    expect(checklist).toContain("Debe usar/mencionar capability: connect_service");
    expect(checklist).toContain("Resultado prod: [ ] pasa [ ] falla");
  });

  it("corre scores sobre outputs capturados y reporta missing/unknown", () => {
    const report = runCapturedIntelligenceEvals(
      INTELLIGENCE_EVALS,
      {
        model: "gemma",
        role: "coordinator",
        backend: "archima",
        outputs: {
          "connections-gmail": "Llamo connect_service y devuelvo auth_url.",
          "conversation-direct-answer": "Respuesta directa, sin lectura de wiki innecesaria.",
          "caso-inexistente": "ruido",
        },
      },
      "2026-06-13T12:00:00.000Z",
    );

    expect(report.model).toBe("gemma");
    expect(report.role).toBe("coordinator");
    expect(report.backend).toBe("archima");
    expect(report.evaluated).toBe(2);
    expect(report.suiteTotal).toBe(INTELLIGENCE_EVALS.length);
    expect(report.passed).toBe(1);
    expect(report.unknown).toEqual(["caso-inexistente"]);
    expect(report.missing).toContain("delegation-complex-wiki");
    expect(report.results.map((r) => r.id)).toEqual(["conversation-direct-answer", "connections-gmail"]);
  });

  it("formatea reporte textual deterministico", () => {
    const report = runCapturedIntelligenceEvals(
      INTELLIGENCE_EVALS,
      { model: "gemma", outputs: { "connections-gmail": "connect_service" } },
      "2026-06-13T12:00:00.000Z",
    );

    expect(formatIntelligenceEvalRun(report)).toContain("intelligence evals: gemma");
    // El total sale del tamaño real de la suite (crece cuando se agregan casos).
    expect(formatIntelligenceEvalRun(report)).toContain(`evaluated: 1/${INTELLIGENCE_EVALS.length}`);
    expect(formatIntelligenceEvalRun(report)).toContain("PASS 1.000 connections-gmail");
  });

  it("valida formato de archivo de outputs", () => {
    expect(parseCapturedEvalFile({ outputs: { "connections-gmail": "connect_service" } }).outputs).toEqual({
      "connections-gmail": "connect_service",
    });
    expect(
      parseCapturedEvalFile({
        outputs: { "connections-gmail": "connect_service" },
        cases: [{ id: "connections-gmail" }],
      }).outputs,
    ).toEqual({ "connections-gmail": "connect_service" });
    expect(() => parseCapturedEvalFile({ outputs: { "connections-gmail": 42 } })).toThrow(
      "outputs.connections-gmail debe ser string",
    );
    expect(() => parseCapturedEvalFile({ outputs: [{ id: "x" }] })).toThrow("outputs[0]");
  });
});
