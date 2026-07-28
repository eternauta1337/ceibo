// Sandbox de REM: corré una pasada SIN pushear, para ver qué planificaría/haría REM.
// Es la herramienta para iterar sobre REM (prompts, planner gemma-vs-sonnet, ejecución) sin
// tocar ninguna wiki real: clona/copia a un scratch efímero, planifica, opcionalmente ejecuta,
// muestra el plan y el `git diff` de lo que dejaría — y NUNCA hace push.
//
// Uso (dev):    tsx src/dry-run.ts <wiki> [opciones]
// Uso (bundle): node rem-dry.cjs <wiki> [opciones]
//
// Fuente de la wiki (una de las dos):
//   --local <dir>     Copia un directorio local a un scratch git (no toca el original, no usa red).
//                     Ideal para iterar: apuntá a cualquier carpeta de notas .md.
//   (sin --local)     Clona la wiki por el proxy git (necesita REM_PUSH_TOKEN con permiso de read).
//
// Opciones:
//   --scope "<txt>"   Scope que ve el planner (default: "pasada COMPLETA").
//   --planner <prov>  anthropic | vllm  (default: el de REM_PLANNER_PROVIDER, o anthropic).
//   --execute         Además del plan, corre el executor (gemma/opencode) sobre el scratch y
//                     muestra el git diff. SIN --execute solo planifica (no llama a opencode).
//   --keep            No borra el scratch al terminar; imprime su path para inspeccionarlo.
//
// Env: mismas vars que el runner (ver runner.ts configFromEnv). Carga automáticamente
// ~/.config/ceibo/rem-batch.env (override con REM_ENV_FILE) sin pisar lo seteado inline —
// así REM_VLLM_BASE y demás config salen del archivo y no hace falta pasarlos en la línea.
// La API key de Anthropic solo se exige si el planner es anthropic.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { remPlanHasWork } from "@ceibo/gateway/logic";
import {
  cloneWiki,
  DEFAULT_EXECUTOR_TIMEOUT_MS,
  DEFAULT_PLANNER_PROVIDER,
  gitHead,
  makeScratch,
  type RemRunnerConfig,
  readAnthropicKey,
  readVllmKey,
  readWikiContent,
  runExecutor,
  runPlanner,
  wipeDir,
} from "./runner.ts";

interface DryOpts {
  wiki: string;
  scope: string;
  provider: "anthropic" | "vllm";
  execute: boolean;
  keep: boolean;
  localDir?: string;
}

/** Carga el env-file del batch (`~/.config/ceibo/rem-batch.env`, override con REM_ENV_FILE) en
 *  process.env SIN pisar lo ya seteado — así un var inline/exportado gana, y el resto sale del
 *  archivo. Da paridad con el batch real (run-batch.sh sourcea el mismo archivo). Sin deps. */
function loadBatchEnv(): void {
  const path = process.env.REM_ENV_FILE ?? join(process.env.HOME ?? "", ".config/ceibo/rem-batch.env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    const key = m?.[1];
    if (!key) continue;
    let val = (m[2] ?? "").trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function parseArgs(argv: string[]): DryOpts {
  const [wiki, ...rest] = argv;
  if (!wiki || wiki.startsWith("--")) {
    throw new Error(
      'Uso: rem-dry <wiki> [--local <dir>] [--scope "..."] [--planner anthropic|vllm] [--execute] [--keep]',
    );
  }
  const opts: DryOpts = {
    wiki,
    scope: "Es una pasada de prueba (dry-run): haz una pasada COMPLETA y propone consolidaciones.",
    provider: process.env.REM_PLANNER_PROVIDER === "anthropic" ? "anthropic" : DEFAULT_PLANNER_PROVIDER,
    execute: false,
    keep: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--execute") opts.execute = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "--scope") opts.scope = rest[++i] ?? opts.scope;
    else if (a === "--local") opts.localDir = rest[++i];
    else if (a === "--planner") {
      const p = rest[++i];
      if (p !== "anthropic" && p !== "vllm") throw new Error(`--planner invalido: ${String(p)}`);
      opts.provider = p;
    } else throw new Error(`opcion desconocida: ${a}`);
  }
  return opts;
}

/** Config del runner para el sandbox. La key de Anthropic solo se lee si el planner es anthropic. */
function dryConfig(provider: "anthropic" | "vllm"): RemRunnerConfig {
  return {
    gitProxyBase: process.env.REM_GIT_PROXY_BASE ?? "https://ceibo.example.com/api/git",
    pushToken: process.env.REM_PUSH_TOKEN ?? "",
    opencodeBase: process.env.REM_OPENCODE_BASE ?? "http://127.0.0.1:4200",
    gemmaModel: process.env.REM_GEMMA_MODEL ?? "local/gemma4-31b",
    anthropicKey: provider === "anthropic" ? readAnthropicKey(process.env.ANTHROPIC_API_KEY) : "",
    plannerProvider: provider,
    plannerModel: process.env.REM_PLANNER_MODEL,
    vllmBase: process.env.REM_VLLM_BASE ?? "http://127.0.0.1:8000/v1",
    vllmKey: readVllmKey(process.env.REM_VLLM_KEY),
    plannerTimeoutMs: Number(process.env.REM_PLANNER_TIMEOUT_MS || "120000"),
    executorTimeoutMs: Number(process.env.REM_EXECUTOR_TIMEOUT_MS || String(DEFAULT_EXECUTOR_TIMEOUT_MS)),
    gitAuthorName: process.env.REM_GIT_AUTHOR_NAME ?? DRY_AUTHOR_NAME,
    gitAuthorEmail: process.env.REM_GIT_AUTHOR_EMAIL ?? DRY_AUTHOR_EMAIL,
  };
}

const DRY_AUTHOR_NAME = "Ceibo REM (dry-run)";
const DRY_AUTHOR_EMAIL = "rem@example.com";

/** Corre un comando con argv (SIN shell) y tira si falla. Nada de plantillas de shell acá:
 *  `localDir` viene de la línea de comandos y el autor de env vars — interpolarlos en un
 *  string que pasa por `sh` sería inyección de comandos aunque el input sea del operador. */
function run(bin: string, args: string[], timeoutMs: number): void {
  const r = spawnSync(bin, args, { timeout: timeoutMs, stdio: "pipe", encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} → exit ${r.status}: ${(r.stderr ?? "").trim()}`);
  }
}

/** `git -C <dir> config user.{name,email}` con los defaults del dry-run. El tipo los marca
 *  opcionales aunque `dryConfig()` siempre los complete. */
function gitIdentity(scratch: string, cfg: RemRunnerConfig): void {
  run("git", ["-C", scratch, "config", "user.name", cfg.gitAuthorName ?? DRY_AUTHOR_NAME], 5_000);
  run("git", ["-C", scratch, "config", "user.email", cfg.gitAuthorEmail ?? DRY_AUTHOR_EMAIL], 5_000);
}

/** Copia un directorio local a un scratch git (sin tocar el original). Si no es repo, lo inicializa. */
function seedFromLocal(localDir: string, scratch: string, cfg: RemRunnerConfig): void {
  if (!existsSync(localDir)) throw new Error(`--local: no existe ${localDir}`);
  // Copia el contenido (incluye .git si hay) a un scratch nuevo; el original nunca se toca.
  run("cp", ["-a", `${localDir}/.`, `${scratch}/`], 30_000);
  // Inicializamos git ANTES del config (si la fuente no era repo, todavía no hay .git).
  const hadGit = existsSync(join(scratch, ".git"));
  if (!hadGit) run("git", ["-C", scratch, "init", "-q"], 5_000);
  gitIdentity(scratch, cfg);
  // Si no traía historia git, commit baseline para que el diff/ls-files funcionen.
  if (!hadGit) {
    run("git", ["-C", scratch, "add", "-A"], 10_000);
    run("git", ["-C", scratch, "commit", "-q", "-m", "baseline (dry-run)", "--allow-empty"], 10_000);
  }
}

function gitText(scratch: string, args: string[]): string {
  const r = spawnSync("git", ["-C", scratch, ...args], { encoding: "utf8", timeout: 30_000 });
  return (r.stdout ?? "").trimEnd();
}

async function main() {
  loadBatchEnv(); // antes de leer cualquier REM_*: el env-file completa lo no seteado inline.
  const opts = parseArgs(process.argv.slice(2));
  const cfg = dryConfig(opts.provider);
  const scratch = makeScratch();
  const out = (s: string) => process.stdout.write(`${s}\n`);

  try {
    // 1. Sembrar el scratch (local o clon por proxy).
    if (opts.localDir) {
      out(`▸ origen: local ${opts.localDir} → scratch ${scratch}`);
      seedFromLocal(opts.localDir, scratch, cfg);
    } else {
      if (!cfg.pushToken)
        throw new Error("falta REM_PUSH_TOKEN para clonar por el proxy (o usá --local <dir>)");
      out(`▸ origen: proxy ${cfg.gitProxyBase}/${opts.wiki} → scratch ${scratch}`);
      cloneWiki(opts.wiki, cfg, scratch);
      gitIdentity(scratch, cfg);
    }

    // 2. Planner. (display espeja el modelo real que se manda: vllm strippea el "provider/")
    const gemmaModelId = cfg.gemmaModel.includes("/") ? cfg.gemmaModel.split("/")[1] : cfg.gemmaModel;
    const model =
      opts.provider === "vllm"
        ? (cfg.plannerModel ?? gemmaModelId)
        : (cfg.plannerModel ?? "claude-sonnet-4-6");
    out(`▸ planner: ${opts.provider} (${model})`);
    const wikiContent = readWikiContent(scratch);
    const { plan, cost, rawResponse } = await runPlanner(opts.wiki, opts.scope, wikiContent, cfg);

    if (!plan) {
      out("\n✗ el planner NO devolvió un plan válido. Respuesta cruda:\n");
      out(rawResponse.slice(0, 2000));
      return;
    }

    out("\n=== PLAN ===");
    out(`risk:                       ${plan.risk}`);
    out(`should_execute:             ${String(plan.should_execute)}`);
    out(`requires_user_confirmation: ${String(plan.requires_user_confirmation)}`);
    out(`summary:                    ${plan.summary}`);
    out(`acciones (${plan.actions.length}):`);
    for (const a of plan.actions) {
      out(`  • ${a.type.padEnd(8)} ${a.path}${a.target ? ` → ${a.target}` : ""}  — ${a.reason}`);
    }
    if (plan.blockers?.length) out(`blockers: ${plan.blockers.join("; ")}`);
    if (plan.report_for_user) out(`report_for_user: ${plan.report_for_user}`);
    if (cost > 0) out(`costo planner: $${cost.toFixed(4)}`);

    // Espejo de los guards de runRemForWiki (informativo: el dry-run no decide nada irreversible).
    const wouldExecute =
      plan.should_execute && remPlanHasWork(plan) && !plan.requires_user_confirmation && plan.risk !== "high";
    out(
      `\n▸ en una corrida real, REM ${wouldExecute ? "EJECUTARÍA" : "NO ejecutaría (no-op/pausa)"} este plan.`,
    );

    // 3. Executor (opcional). Nunca pushea.
    if (opts.execute) {
      if (!wouldExecute) {
        out("\n▸ --execute pedido pero el plan es no-op/pausa: no corro el executor.");
      } else {
        out("\n=== EXECUTOR (gemma) — sobre el scratch, sin push ===");
        const headBefore = gitHead(scratch);
        const { summary, idle } = await runExecutor(opts.wiki, plan, scratch, cfg);
        out(`idle (terminó solo): ${String(idle)}`);
        out(`resumen del executor: ${summary}`);
        const headAfter = gitHead(scratch);
        if (!idle) {
          out("⚠ el executor no terminó (timeout) — el diff puede estar incompleto.");
        }
        if (headAfter && headAfter !== headBefore) {
          out("\n=== DIFF que REM dejaría (NO se pushea) ===");
          out(gitText(scratch, ["diff", "--stat", `${headBefore}..${headAfter}`]));
          out("");
          out(gitText(scratch, ["log", "--oneline", `${headBefore}..${headAfter}`]));
        } else {
          out("\n▸ el executor no dejó ningún commit nuevo.");
        }
      }
    } else {
      out("\n▸ (pasá --execute para correr también el executor gemma y ver el diff)");
    }
  } finally {
    if (opts.keep) {
      out(`\n▸ scratch conservado en: ${scratch} (borralo a mano cuando termines)`);
    } else {
      wipeDir(scratch);
    }
  }
}

main().catch((e) => {
  console.error("rem-dry: error:", (e as Error)?.message ?? String(e));
  process.exit(1);
});
