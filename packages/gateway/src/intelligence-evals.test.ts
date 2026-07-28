import { describe, expect, it } from "vitest";
import {
  CRITICAL_EVAL_AREAS,
  evalCoverage,
  evalReport,
  formatEvalReport,
  INTELLIGENCE_EVALS,
  type IntelligenceEvalCase,
  scoreEvalOutput,
  validateIntelligenceEvalSuite,
} from "./intelligence-evals.ts";

function evalCase(id: string): IntelligenceEvalCase {
  const c = INTELLIGENCE_EVALS.find((e) => e.id === id);
  expect(c).toBeDefined();
  return c as IntelligenceEvalCase;
}

describe("INTELLIGENCE_EVALS", () => {
  it("tiene casos accionables y sin ids duplicados", () => {
    expect(validateIntelligenceEvalSuite(INTELLIGENCE_EVALS)).toEqual([]);
  });

  it("cubre todas las areas criticas del asistente", () => {
    const coverage = evalCoverage(INTELLIGENCE_EVALS);
    for (const area of CRITICAL_EVAL_AREAS) {
      expect(coverage[area], area).toBeGreaterThan(0);
    }
  });

  it("incluye guards especificos para archima: subagentes, git crudo y REM", () => {
    const text = JSON.stringify(INTELLIGENCE_EVALS);
    expect(text).toContain("subagent_spawn");
    expect(text).toContain("git crudo");
    expect(text).toContain("borrado masivo");
  });

  it("produce un reporte deterministico para comparar suites/modelos", () => {
    const report = evalReport(INTELLIGENCE_EVALS);
    expect(report.total).toBe(INTELLIGENCE_EVALS.length);
    expect(report.byBackend.archima).toBeGreaterThan(0);
    expect(report.byBackend.any).toBeGreaterThan(0);
    expect(report.actionable).toBe(INTELLIGENCE_EVALS.length);
    expect(report.withForbids).toBeGreaterThan(0);
    expect(formatEvalReport(report)).toContain(`evals total:${INTELLIGENCE_EVALS.length}`);
  });

  it("scoreEvalOutput valida tool esperada y forbids", () => {
    const c = evalCase("connections-gmail");
    const ok = scoreEvalOutput(c, "Llamo connect_service y devuelvo auth_url.");
    expect(ok.passed).toBe(true);
    expect(ok.score).toBe(1);

    const bad = scoreEvalOutput(c, "pedir comando /connect desde config.");
    expect(bad.passed).toBe(false);
    expect(bad.checks.tool).toBe(false);
    expect(bad.checks.forbids.some((f) => !f.passed)).toBe(true);
  });

  it("scoreEvalOutput no aprueba salidas vacias aunque no violen forbids", () => {
    const c = evalCase("conversation-direct-answer");
    const empty = scoreEvalOutput(c, "   ");
    expect(empty.passed).toBe(false);
    expect(empty.checks.nonEmpty).toBe(false);
    expect(empty.score).toBeLessThan(1);
  });
});
