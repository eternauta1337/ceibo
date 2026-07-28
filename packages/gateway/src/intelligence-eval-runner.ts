import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  type EvalBackend,
  INTELLIGENCE_EVALS,
  type IntelligenceEvalCase,
  type IntelligenceEvalScore,
  scoreEvalOutput,
} from "./intelligence-evals.ts";

export type EvalRunFormat = "json" | "text";

export interface CapturedEvalOutput {
  id: string;
  output: string;
}

export interface CapturedEvalFile {
  model?: string;
  role?: string;
  backend?: EvalBackend | string;
  outputs: Record<string, string> | CapturedEvalOutput[];
  cases?: CapturedEvalTemplateCase[];
}

export interface CapturedEvalTemplateCase {
  id: string;
  area: IntelligenceEvalCase["area"];
  backend: EvalBackend;
  input: string;
  facts?: string[];
  expected: IntelligenceEvalCase["expected"];
}

export interface IntelligenceEvalRunCase {
  id: string;
  area: IntelligenceEvalCase["area"];
  backend: EvalBackend;
  passed: boolean;
  score: number;
  checks: IntelligenceEvalScore["checks"];
}

export interface IntelligenceEvalRunReport {
  generatedAt: string;
  suiteTotal: number;
  evaluated: number;
  passed: number;
  scoreAvg: number;
  model?: string;
  role?: string;
  backend?: string;
  results: IntelligenceEvalRunCase[];
  missing: string[];
  unknown: string[];
}

export function normalizeCapturedOutputs(input: CapturedEvalFile): Map<string, string> {
  if (Array.isArray(input.outputs)) {
    return new Map(input.outputs.map((entry) => [entry.id, entry.output]));
  }
  return new Map(Object.entries(input.outputs));
}

export function makeCapturedEvalTemplate(cases: IntelligenceEvalCase[]): CapturedEvalFile {
  return {
    model: "",
    role: "",
    backend: "",
    outputs: Object.fromEntries(cases.map((c) => [c.id, ""])),
    cases: cases.map((c) => ({
      id: c.id,
      area: c.area,
      backend: c.backend,
      input: c.input,
      facts: c.facts,
      expected: c.expected,
    })),
  };
}

export function formatManualEvalChecklist(cases: IntelligenceEvalCase[]): string {
  const lines = [
    "# Smoke manual — evals de inteligencia",
    "",
    "Uso: pegar cada prompt en la app de producción y anotar la respuesta capturada en el template JSON si se quiere score offline.",
    "",
    "Setup recomendado:",
    "- Mandar `/model` para confirmar modelos disponibles.",
    "- Si el usuario está en archima/local, confirmar que el modelo visible sea Gemma.",
    "- Usar una wiki/nota descartable para casos que crean o editan contenido.",
    "",
  ];

  for (const c of cases) {
    lines.push(`## ${c.id}`);
    lines.push("");
    lines.push(`- Área: ${c.area}`);
    lines.push(`- Backend objetivo: ${c.backend}`);
    lines.push(`- Prompt: ${c.input}`);
    if (c.facts && c.facts.length > 0) lines.push(`- Contexto esperado: ${c.facts.join(" · ")}`);
    if (c.expected.tool) lines.push(`- Debe usar/mencionar capability: ${c.expected.tool}`);
    lines.push(`- Acción esperada: ${c.expected.action}`);
    if (c.expected.forbids && c.expected.forbids.length > 0) {
      lines.push(`- No debe: ${c.expected.forbids.join(" · ")}`);
    }
    lines.push("- Resultado prod: [ ] pasa [ ] falla");
    lines.push("- Output capturado:");
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export function runCapturedIntelligenceEvals(
  cases: IntelligenceEvalCase[],
  input: CapturedEvalFile,
  generatedAt = new Date().toISOString(),
): IntelligenceEvalRunReport {
  const outputs = normalizeCapturedOutputs(input);
  const knownIds = new Set(cases.map((c) => c.id));
  const results: IntelligenceEvalRunCase[] = [];
  const missing: string[] = [];

  for (const c of cases) {
    const output = outputs.get(c.id);
    if (output === undefined) {
      missing.push(c.id);
      continue;
    }
    const scored = scoreEvalOutput(c, output);
    results.push({
      id: c.id,
      area: c.area,
      backend: c.backend,
      passed: scored.passed,
      score: scored.score,
      checks: scored.checks,
    });
  }

  const unknown = [...outputs.keys()].filter((id) => !knownIds.has(id)).sort();
  const passed = results.filter((r) => r.passed).length;
  const scoreAvg = results.length > 0 ? results.reduce((sum, r) => sum + r.score, 0) / results.length : 0;

  return {
    generatedAt,
    suiteTotal: cases.length,
    evaluated: results.length,
    passed,
    scoreAvg,
    model: input.model,
    role: input.role,
    backend: input.backend,
    results,
    missing,
    unknown,
  };
}

export function formatIntelligenceEvalRun(report: IntelligenceEvalRunReport): string {
  const label = [report.model, report.role, report.backend].filter(Boolean).join(" / ") || "captured outputs";
  const header = [
    `intelligence evals: ${label}`,
    `generated_at: ${report.generatedAt}`,
    `evaluated: ${report.evaluated}/${report.suiteTotal}`,
    `passed: ${report.passed}/${report.evaluated}`,
    `score_avg: ${report.scoreAvg.toFixed(3)}`,
  ];
  const rows = report.results.map((r) => {
    const status = r.passed ? "PASS" : "FAIL";
    return `${status} ${r.score.toFixed(3)} ${r.id} area:${r.area} backend:${r.backend}`;
  });
  const tail = [
    report.missing.length > 0 ? `missing: ${report.missing.join(", ")}` : undefined,
    report.unknown.length > 0 ? `unknown: ${report.unknown.join(", ")}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return [...header, ...rows, ...tail].join("\n");
}

export function parseCapturedEvalFile(value: unknown): CapturedEvalFile {
  if (!isRecord(value)) throw new Error("eval input debe ser un objeto JSON");
  const outputs = value.outputs;
  if (!isRecord(outputs) && !Array.isArray(outputs)) {
    throw new Error("eval input requiere outputs como objeto {caseId: output} o array [{id, output}]");
  }
  if (Array.isArray(outputs)) {
    for (const [i, entry] of outputs.entries()) {
      if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.output !== "string") {
        throw new Error(`outputs[${i}] debe tener id y output string`);
      }
    }
  } else {
    for (const [id, output] of Object.entries(outputs)) {
      if (typeof output !== "string") throw new Error(`outputs.${id} debe ser string`);
    }
  }
  return {
    model: optionalString(value.model, "model"),
    role: optionalString(value.role, "role"),
    backend: optionalString(value.backend, "backend"),
    outputs: outputs as CapturedEvalFile["outputs"],
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const { values } = parseArgs({
    args,
    options: {
      outputs: { type: "string", short: "i" },
      format: { type: "string", short: "f", default: "text" },
      out: { type: "string", short: "o" },
      template: { type: "boolean" },
      "fail-on-fail": { type: "boolean" },
      "fail-on-missing": { type: "boolean" },
    },
  });

  if (values.template) {
    const rendered =
      values.format === "text"
        ? formatManualEvalChecklist(INTELLIGENCE_EVALS)
        : `${JSON.stringify(makeCapturedEvalTemplate(INTELLIGENCE_EVALS), undefined, 2)}\n`;
    await writeOutput(rendered, values.out);
    return;
  }

  if (!values.outputs) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (values.format !== "json" && values.format !== "text") {
    throw new Error("--format debe ser json o text");
  }

  const inputPath = resolveCliPath(values.outputs);
  const parsed = parseCapturedEvalFile(JSON.parse(await readFile(inputPath, "utf8")));
  const report = runCapturedIntelligenceEvals(INTELLIGENCE_EVALS, parsed);
  const rendered =
    values.format === "json"
      ? `${JSON.stringify(report, undefined, 2)}\n`
      : `${formatIntelligenceEvalRun(report)}\n`;
  await writeOutput(rendered, values.out);

  if (values["fail-on-fail"] && report.passed < report.evaluated) process.exitCode = 2;
  if (values["fail-on-missing"] && report.missing.length > 0) process.exitCode = 3;
}

async function writeOutput(rendered: string, out?: string): Promise<void> {
  if (!out) {
    process.stdout.write(rendered);
    return;
  }
  const outPath = resolveCliPath(out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, rendered);
}

function printUsage(): void {
  process.stderr.write(`uso:
  pnpm --filter @ceibo/gateway eval:intelligence -- --template --out tmp/intelligence-evals/template.json
  pnpm --filter @ceibo/gateway eval:intelligence -- --template --format text --out tmp/intelligence-evals/checklist.md
  pnpm --filter @ceibo/gateway eval:intelligence -- --outputs <outputs.json> [--format text|json] [--out tmp/intelligence-evals/run.json]

Formato outputs.json:
{
  "model": "gemma4-31b",
  "role": "coordinator",
  "backend": "archima",
  "outputs": {
    "connections-gmail": "Llamo connect_service y devuelvo auth_url."
  }
}
`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} debe ser string si está presente`);
  return value;
}

function resolveCliPath(path: string): string {
  if (isAbsolute(path)) return path;
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

const entrypointUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
const isCli = import.meta.url === entrypointUrl;

if (isCli) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
