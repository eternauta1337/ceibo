// Entrypoint CLI del rem-runner per-wiki.
// Uso (bundle): node rem-runner.cjs <wikiName> <pushToken> "<scope>"
// Uso (dev):    tsx src/index.ts <wikiName> <pushToken> "<scope>"
//
// Env vars configurables (ver runner.ts configFromEnv):
//   REM_PLANNER_PROVIDER  vllm | anthropic (default: vllm = gemma local)
//   ANTHROPIC_API_KEY     | ~/.archima/anthropic.key (solo si REM_PLANNER_PROVIDER=anthropic)
//   REM_OPENCODE_BASE     (default: http://127.0.0.1:4200)
//   REM_GEMMA_MODEL       (default: local/gemma4-31b)
//   REM_VLLM_BASE         (default: http://127.0.0.1:8000/v1 — planner gemma)
//   REM_GIT_PROXY_BASE    (default: https://ceibo.example.com/api/git)
//   REM_PLANNER_MODEL     (default: según proveedor — vllm→modelID de gemma, anthropic→claude-sonnet-4-6)
//   REM_GIT_AUTHOR_NAME   (default: "Ceibo REM")
//   REM_GIT_AUTHOR_EMAIL  (default: rem@example.com)
//
// Salida: una linea JSON a stdout con RemRunnerResult, ademas de logs a stderr.
// Exit code: 0 siempre (el status "error" va en el JSON, no en el exit code).

import { configFromEnv, runRemForWiki } from "./runner.ts";

async function main() {
  const [, , wikiName, pushToken, scope] = process.argv;

  if (!wikiName || !pushToken) {
    console.error(
      "Uso: node rem-runner.cjs <wikiName> <pushToken> [scope]\n" +
        "  wikiName  : nombre del repo (ej. ale-wiki)\n" +
        "  pushToken : token de push scopeado a esa wiki\n" +
        '  scope     : descripcion del delta (ej. "primera corrida")',
    );
    process.exit(1);
  }

  const effectiveScope = scope ?? "Es la PRIMERA corrida de REM sobre esta wiki: haz una pasada COMPLETA.";

  const cfg = configFromEnv();
  // El pushToken de CLI tiene precedencia sobre el env REM_PUSH_TOKEN.
  cfg.pushToken = pushToken;

  const result = await runRemForWiki(wikiName, cfg, effectiveScope);
  // Salida parseable para el orquestador del gateway.
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((e) => {
  console.error("rem-runner: error fatal:", (e as Error)?.message ?? String(e));
  process.exit(1);
});
