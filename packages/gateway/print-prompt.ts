// Emite a stdout el system prompt compuesto. Para generar el AGENTS.md que la VM de archima lee,
// inspeccionar el prompt de MA, o emitir los DOS prompts standalone del flujo de delegación v2
// (coordinador/worker), que opencode.json cablea por `{file:}`:
//   pnpm --filter @ceibo/gateway print-prompt ma
//   pnpm --filter @ceibo/gateway print-prompt archima > AGENTS.md            # legacy monolítico
//   pnpm --filter @ceibo/gateway print-prompt archima-coordinator > ceibo.md # agente `ceibo`
//   pnpm --filter @ceibo/gateway print-prompt archima-worker > ceibo-worker.md

import { type Backend, composeArchimaRolePrompt, composePrompt } from "./prompt/compose.ts";

const target = process.argv[2];
if (target === "archima-coordinator") {
  process.stdout.write(composeArchimaRolePrompt("coordinator"));
} else if (target === "archima-worker") {
  process.stdout.write(composeArchimaRolePrompt("worker"));
} else if (target === "ma" || target === "archima") {
  process.stdout.write(composePrompt(target as Backend));
} else {
  console.error("uso: print-prompt <ma|archima|archima-coordinator|archima-worker>");
  process.exit(1);
}
