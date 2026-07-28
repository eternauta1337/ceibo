// Compone el system prompt de ceibo: un CORE agnóstico (persona, voz, terminología, convenciones
// de wiki, idioma, principios) + el ADAPTER del backend (la mecánica: sync, tools, sub-agentes).
// Una sola fuente del core para los dos backends → el persona y `[[voice]]` no se duplican.
//   - MA: publish-agent.ts publica composePrompt("ma") al agente de Managed Agents.
//   - archima (legacy/AGENTS.md): composePrompt("archima").
//
// FLUJO ARCHIMA NUEVO (delegación v2): en vez de UN AGENTS.md monolítico, archima usa DOS prompts
// STANDALONE, cableados por opencode.json `{file:}` a agentes custom:
//   - `coordinator` → el agente conversacional `ceibo` (sin tools de archivos; delega y charla).
//   - `worker`      → el agente ejecutor `ceibo-worker` (file tools + sync + script).
// Son autocontenidos (NO componen core.md): el coordinador tiene que quedar chico (prefill = oro).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Backend = "ma" | "archima";
export type ArchimaRole = "coordinator" | "worker";

const read = (f: string): string =>
  readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8").trim();

/** Sustituye los placeholders `{{VAR}}` que dependen del env al publicar (ej. el username del bot
 *  de Telegram). Lee de `process.env`: publish-agent carga el `.env` antes de componer. */
const subst = (text: string): string =>
  text.replace(/\{\{TELEGRAM_BOT_USERNAME\}\}/g, process.env.TELEGRAM_BOT_USERNAME ?? "ceibo");

/** core agnóstico + adapter del backend, en ese orden (el persona/voz/convenciones primero). */
export function composePrompt(backend: Backend): string {
  return subst(`${read("core.md")}\n\n${read(`adapter-${backend}.md`)}\n`);
}

/** Prompt STANDALONE de un rol de archima (coordinator/worker) para el flujo de delegación v2.
 *  NO compone core.md: cada archivo es autocontenido (el coordinador tiene que quedar chico). Lo
 *  consume opencode.json vía `{file:}` por agente. */
export function composeArchimaRolePrompt(role: ArchimaRole): string {
  return `${subst(read(`${role}-archima.md`))}\n`;
}
