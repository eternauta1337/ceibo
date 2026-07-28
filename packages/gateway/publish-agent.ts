// Publica una versión nueva del agente ceibo vía el SDK (no el CLI: evita el
// quoting frágil de --mcp-server/--tool y la trampa de que el update NO lee YAML
// de stdin). Reproducible:
//
//   tsx packages/gateway/publish-agent.ts            (carga el .env del root via dotenv? no:)
//   node --env-file=.env --import tsx packages/gateway/publish-agent.ts
//   # o más simple desde el repo:  pnpm --filter @ceibo/gateway publish-agent
//
// El `system:` se compone de `prompt/core.md` (agnóstico, compartido con archima) +
// `prompt/adapter-ma.md` (mecánica MA), vía `composePrompt("ma")`. Los mcp_servers
// + tools los arma `buildAgentMcpConfig` de @ceibo/oauth — la MISMA función que
// usa el gateway para el override per-sesión (multi-cuenta), así el agente publicado
// (base, sin perfiles extra) y las sesiones no driftan. Las URLs de los MCP
// self-hosted (con path secreto) salen del env y NUNCA se commitean. Hace retrieve
// para leer la versión actual y update con esa versión (optimistic lock).
//
// Fase 14: publica TAMBIÉN los 3 sub-agentes del roster (worker-low/mid/high), que son
// idénticos al principal salvo el modelo (haiku/sonnet/opus) y SIN multiagent. El
// principal se actualiza con el roster apuntando a ellos. Sus ids van en el .env
// (AGENT_ID_{LOW,MID,HIGH}); 1ª corrida los crea y los loguea.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { buildAgentMcpConfig } from "@ceibo/oauth";
import { composePrompt } from "./prompt/compose.ts";
import { EXTRA_COORDINATORS } from "./src/models.ts";

process.loadEnvFile(new URL("../../.env", import.meta.url)); // .env único del root del monorepo

const AGENT_ID = process.env.AGENT_ID;
const KEY = process.env.ANTHROPIC_API_KEY;
if (!AGENT_ID || !KEY) {
  console.error("Faltan AGENT_ID / ANTHROPIC_API_KEY en el .env del root.");
  process.exit(1);
}

// --- system: del agente de chat = core agnóstico + adapter MA (ver prompt/) -
// El persona/voz/convenciones viven en prompt/core.md (compartido con archima); la mecánica
// MA (wiki-sync.mjs, MCPs, roster, crons, viewer) en prompt/adapter-ma.md.
const system = composePrompt("ma");

// --- mcp_servers + tools: builder compartido (base, sin perfiles extra) -----
const { mcp_servers, tools } = buildAgentMcpConfig({ env: process.env });

// --- skill wiki-notes: junta los archivos del dir para subirlos en el `create` de abajo. -----
const SKILL_DIR = fileURLToPath(new URL("./skills/wiki-notes", import.meta.url));
const gatherFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? gatherFiles(p) : [p];
  });
// El segundo arg de `toFile` es el filename que el SDK manda en el form-data. El server exige
// que `SKILL.md` viva en el "top-level folder" → NECESITA un prefijo de carpeta (con "SKILL.md"
// suelto rechaza "must be exactly in the top-level folder"). Usamos el dirname de SKILL_DIR como
// base → el filename queda `wiki-notes/SKILL.md` (carpeta padre como top-level).
const skillFiles = await Promise.all(
  gatherFiles(SKILL_DIR).map((p) => toFile(readFileSync(p), relative(dirname(SKILL_DIR), p))),
);

const client = new Anthropic({ apiKey: KEY });

// Skill wiki-notes: cada publicación CREA UNA SKILL NUEVA con el contenido actual de SKILL.md
// y al final borra las viejas (bloque de limpieza al cierre). NO subimos una versión nueva a la
// skill existente: `skills.versions.create` devuelve 400 "SKILL.md must be exactly in the
// top-level folder" para CUALQUIER packaging (probado folder y flat; `create` arma la request
// idéntico y SÍ funciona) — bug del beta de Skills confirmado en SDK 0.97.1 (era la DEUDA de
// Fase 11). El `display_title` NO viaja al prompt (solo el contenido de SKILL.md), así que le
// ponemos un sufijo único (timestamp) para esquivar el "cannot reuse an existing display_title".
// `WIKI_NOTES_SKILL_ID` quedó obsoleto: el id sale del create y la limpieza encuentra las viejas
// por el prefijo del display_title.
const createdSkill = await client.beta.skills.create({
  display_title: `wiki-notes ${new Date().toISOString()}`,
  files: skillFiles,
});
const skillId = createdSkill.id;
const skillVersion = createdSkill.latest_version ?? "";
console.log(`🆕 skill wiki-notes publicada: ${skillId} (v${skillVersion})`);

// Config compartida: principal y workers son IDÉNTICOS salvo el modelo (decisión
// Fase 14: "todos las mismas capacidades"). El roster del coordinador se arma con los
// AGENT_ID_{LOW,MID,HIGH} del .env.
const baseConfig = {
  system,
  mcp_servers,
  tools,
  skills: [{ type: "custom" as const, skill_id: skillId, version: skillVersion || undefined }],
};

// --- workers del roster: mismos que el principal, distinto modelo, SIN multiagent
// (depth 1: no pueden spawnear a su vez). El `name` es por lo que el coordinador los
// referencia al delegar (ver el system prompt). 1ª vez los crea y loguea su id para
// sumar al .env; después reusa por id. -----------
const WORKERS = [
  {
    envKey: "AGENT_ID_LOW",
    name: "worker-low",
    model: "claude-haiku-4-5-20251001",
    desc: "Sub-agente nivel bajo (haiku): trabajo mecánico / masivo / simple.",
  },
  {
    envKey: "AGENT_ID_MID",
    name: "worker-mid",
    model: "claude-sonnet-4-6",
    desc: "Sub-agente nivel medio (sonnet): complejidad intermedia.",
  },
  {
    envKey: "AGENT_ID_HIGH",
    name: "worker-high",
    model: "claude-opus-4-7",
    desc: "Sub-agente nivel alto (opus): razonamiento pesado.",
  },
] as const;

const roster: string[] = [];
for (const w of WORKERS) {
  const existingId = process.env[w.envKey];
  if (!existingId) {
    const created = await client.beta.agents.create({
      name: w.name,
      model: w.model,
      description: w.desc,
      ...baseConfig,
    });
    roster.push(created.id);
    console.log(`🆕 worker ${w.name} (${w.model}) creado: ${created.id}`);
    console.log(`   → agregá ${w.envKey}=${created.id} al .env del root para próximas publicaciones.`);
  } else {
    const cur = await client.beta.agents.retrieve(existingId);
    const upd = await client.beta.agents.update(existingId, {
      version: cur.version,
      model: w.model, // re-aseguramos el modelo por si se cambió el mapeo nivel→modelo
      ...baseConfig,
    });
    roster.push(existingId);
    console.log(`↺ worker ${w.name} ${existingId}: v${upd.version} (${w.model})`);
  }
}

// --- principal (coordinador): misma config + roster de los 3 workers. El modelo del
// principal (haiku) NO se manda → el update lo preserva. -----------
const current = await client.beta.agents.retrieve(AGENT_ID);
console.log(`agente ${AGENT_ID} versión actual: ${current.version}`);
const updated = await client.beta.agents.update(AGENT_ID, {
  version: current.version,
  ...baseConfig,
  multiagent: { type: "coordinator", agents: roster },
});
console.log(
  `✅ publicado: principal v${updated.version} · ${mcp_servers.length} MCP servers · ${tools.length} toolsets · skill wiki-notes v${skillVersion} · roster [${WORKERS.map((w) => w.name).join(", ")}]`,
);

// --- coordinadores extra por modelo (/model): variantes del principal idénticas salvo el
// `model`, CADA UNA con el MISMO roster de workers (delegan igual que el principal). El usuario
// elige el modelo del chat con /model (Telegram) o el cog (web) → la sesión se recrea apuntando
// al coordinador elegido. El principal (haiku/AGENT_ID) es el de arriba, no se re-publica acá.
// 1ª corrida los crea y loguea su id para sumar AGENT_ID_{SONNET,OPUS} al .env; después reusa.
for (const c of EXTRA_COORDINATORS) {
  const coordConfig = { ...baseConfig, multiagent: { type: "coordinator" as const, agents: roster } };
  const existingId = process.env[c.envKey];
  if (!existingId) {
    const created = await client.beta.agents.create({
      name: c.agentName,
      model: c.model,
      description: `Coordinador del chat (${c.key}/${c.model}): variante del principal para /model ${c.key}.`,
      ...coordConfig,
    });
    console.log(`🆕 coordinador ${c.agentName} (${c.model}) creado: ${created.id}`);
    console.log(`   → agregá ${c.envKey}=${created.id} al .env del root para próximas publicaciones.`);
  } else {
    const cur = await client.beta.agents.retrieve(existingId);
    const upd = await client.beta.agents.update(existingId, {
      version: cur.version,
      model: c.model,
      ...coordConfig,
    });
    console.log(`↺ coordinador ${c.agentName} ${existingId}: v${upd.version} (${c.model})`);
  }
}

// NOTA: el REM ya no se publica como agente MA. La consolidación de wikis corre como
// batch-pull en gpuhost (`@ceibo/rem-runner`: planner Anthropic + executor opencode local),
// no sobre Managed Agents. El agente MA viejo (`agent-rem.yaml`, Fase 16) y su trigger
// (/rem + cron en la box) se removieron (#413/#414); este publish ya no lo recrea.

// Limpieza: ahora que TODOS los agentes apuntan a la skill nueva, borramos las wiki-notes
// viejas (toda otra skill cuyo display_title arranca con "wiki-notes"). El borrado puede fallar
// si una versión histórica de algún agente todavía la referencia → lo logueamos y seguimos
// (queda huérfana, inocua). Esto evita que se acumulen skills en cada publicación.
// La API exige borrar TODAS las versiones de una skill antes de borrar la skill ("Cannot
// delete skill with existing versions"). Una versión referenciada por una versión histórica de
// algún agente no se puede borrar → ese caso queda huérfano (inocuo) y lo logueamos. Best-effort.
let removedSkills = 0;
for await (const s of client.beta.skills.list()) {
  if (s.id === skillId || !(s.display_title ?? "").startsWith("wiki-notes")) continue;
  try {
    for await (const v of client.beta.skills.versions.list(s.id)) {
      await client.beta.skills.versions.delete(v.version, { skill_id: s.id });
    }
    await client.beta.skills.delete(s.id);
    removedSkills++;
  } catch (e) {
    console.warn(
      `⚠️ no pude borrar la skill vieja ${s.id} (¿versión referenciada por un agente?): HTTP ${(e as { status?: number }).status ?? "?"}`,
    );
  }
}
console.log(`🧹 skills wiki-notes viejas borradas: ${removedSkills}`);
