// Gestión del changelog por fragmentos (estilo towncrier), adaptado al flujo
// feature→dev→staging→main de ceibo. Sin deps externas (igual que scripts/dev.mjs).
//
//   node scripts/changelog.mjs render                  # imprime los fragmentos agrupados
//                                                       # (cuerpo del PR de release / preview de staging)
//   node scripts/changelog.mjs release "<encabezado>"  # foldea los fragmentos a CHANGELOG.md y los borra
//                                                       # (release a prod: staging→main)
//   node scripts/changelog.mjs check [--base <ref>]    # gate de CI: falla si el PR no agrega ningún fragmento
//
// Formato de fragmento: changelog.d/<slug>.<tipo>.md   (tipo ∈ feat|fix|perf|docs|chore)
// Contenido: una línea user-facing en markdown, sin encabezado (multilínea permitida).

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRAG_DIR = join(ROOT, "changelog.d");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const MARKER = "<!-- nuevas-entradas -->";

// Orden de render (también valida los tipos permitidos).
const TYPES = [
  ["feat", "✨ Nuevas funciones"],
  ["fix", "🐛 Arreglos"],
  ["perf", "⚡ Performance"],
  ["docs", "📝 Documentación"],
  ["chore", "🔧 Interno"],
];
const TYPE_SET = new Set(TYPES.map(([t]) => t));

function readFragments() {
  let files;
  try {
    files = readdirSync(FRAG_DIR);
  } catch {
    return [];
  }
  const frags = [];
  for (const f of files) {
    if (!f.endsWith(".md") || f === "README.md") continue;
    const type = f.slice(0, -3).split(".").pop();
    if (!TYPE_SET.has(type)) {
      console.error(`changelog: tipo inválido '${type}' en ${f} (válidos: ${[...TYPE_SET].join(", ")})`);
      process.exit(1);
    }
    const text = readFileSync(join(FRAG_DIR, f), "utf8").trim();
    if (!text) {
      console.error(`changelog: fragmento vacío ${f}`);
      process.exit(1);
    }
    frags.push({ file: f, type, text });
  }
  return frags;
}

function renderMarkdown(frags) {
  const lines = [];
  for (const [type, title] of TYPES) {
    const items = frags.filter((x) => x.type === type).sort((a, b) => a.file.localeCompare(b.file));
    if (!items.length) continue;
    lines.push(`### ${title}`, "");
    for (const it of items) {
      const [first, ...rest] = it.text.split("\n");
      lines.push(`- ${first}`);
      for (const r of rest) lines.push(`  ${r}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function cmdRender() {
  const frags = readFragments();
  if (!frags.length) {
    console.error("changelog: no hay fragmentos en changelog.d/");
    return;
  }
  process.stdout.write(`${renderMarkdown(frags)}\n`);
}

function cmdRelease(heading) {
  if (!heading) {
    console.error('uso: changelog.mjs release "<encabezado>"');
    process.exit(1);
  }
  const frags = readFragments();
  if (!frags.length) {
    console.error("changelog: no hay fragmentos para liberar");
    process.exit(1);
  }
  const existing = readFileSync(CHANGELOG, "utf8");
  if (!existing.includes(MARKER)) {
    console.error(`changelog: falta el marcador ${MARKER} en CHANGELOG.md`);
    process.exit(1);
  }
  const section = `## ${heading}\n\n${renderMarkdown(frags)}\n`;
  writeFileSync(CHANGELOG, existing.replace(MARKER, `${MARKER}\n\n${section}`));
  for (const f of frags) rmSync(join(FRAG_DIR, f.file));
  console.error(`changelog: ${frags.length} fragmento(s) liberados bajo "## ${heading}" y borrados`);
}

function cmdCheck(args) {
  const i = args.indexOf("--base");
  const base = i >= 0 ? args[i + 1] : "origin/dev";
  let changed = "";
  try {
    changed = execSync(`git diff --name-only ${base}...HEAD`, { cwd: ROOT, encoding: "utf8" });
  } catch (e) {
    console.error(`changelog check: falló git diff contra ${base}: ${e.message}`);
    process.exit(1);
  }
  const added = changed
    .split("\n")
    .filter((p) => p.startsWith("changelog.d/") && p.endsWith(".md") && !p.endsWith("README.md"));
  if (!added.length) {
    console.error("changelog check: este PR no agrega ningún fragmento en changelog.d/.");
    console.error("  → agregá changelog.d/<slug>.<tipo>.md (tipo: feat|fix|perf|docs|chore) con una línea user-facing,");
    console.error("    o etiquetá el PR con 'skip-changelog' si el cambio no es observable.");
    process.exit(1);
  }
  // Valida formato/tipos de TODO el set (no solo lo agregado).
  readFragments();
  console.error(`changelog check: OK — ${added.length} fragmento(s) nuevo(s).`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "render":
    cmdRender();
    break;
  case "release":
    cmdRelease(rest[0]);
    break;
  case "check":
    cmdCheck(rest);
    break;
  default:
    console.error("uso: changelog.mjs <render|release|check>");
    process.exit(1);
}
