// Entrypoint CLI del batch orchestrator de REM para gpuhost.
// No acepta argumentos: toda la configuración viene de variables de entorno.
//
// Env vars requeridas:
//   REM_BATCH_SECRET       Bearer token (= REM_BATCH_SECRET del web-server) — obligatorio
//
// Env vars opcionales (con defaults):
//   REM_BATCH_URL          URL base del web-server (default: "https://ceibo.example.com")
//   REM_PLANNER_PROVIDER   vllm | anthropic (default: vllm = gemma local)
//   ANTHROPIC_API_KEY      API key de Anthropic — solo si REM_PLANNER_PROVIDER=anthropic
//   REM_OPENCODE_BASE      URL de opencode-serve (default: http://127.0.0.1:4200)
//   REM_GEMMA_MODEL        modelo/proveedor (default: local/gemma4-31b)
//   REM_VLLM_BASE          base OpenAI-compat del planner gemma (default: http://127.0.0.1:8000/v1)
//   REM_GIT_PROXY_BASE     URL del proxy git (default: https://ceibo.example.com/api/git)
//   REM_PLANNER_MODEL      modelo del planner (default: según proveedor — vllm→gemma, anthropic→sonnet)
//   REM_GIT_AUTHOR_NAME    nombre git del autor (default: "Ceibo REM")
//   REM_GIT_AUTHOR_EMAIL   email git del autor (default: rem@example.com)
//   REM_EXECUTOR_TIMEOUT_MS timeout del executor en ms (default: 900000)
//
// Exit code: 0 OK, 1 error fatal (no se pudo conectar al web-server, etc.)

import { batchConfigFromEnv, runRemBatch } from "./batch.ts";

async function main() {
  const cfg = batchConfigFromEnv();
  const results = await runRemBatch(cfg);

  const errors = results.filter((r) => r.status === "error");
  if (errors.length > 0) {
    // El report ya fue entregado al web-server. Salimos con 1 para que systemd
    // registre el batch como fallido (journalctl mostrará las wikis con error).
    console.error(`[rem-batch] ${errors.length} wiki(s) con error: ${errors.map((r) => r.wiki).join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[rem-batch] error fatal:", (e as Error)?.message ?? String(e));
  process.exit(1);
});
