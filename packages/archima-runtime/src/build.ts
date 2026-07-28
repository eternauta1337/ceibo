// build.ts — ensambla el árbol de runtime DESPLEGABLE de archima a partir del set versionado
// (de-secreteado, en `runtime/`) MÁS los artefactos de FUENTE ÚNICA que no se copian a mano:
//   - prompts del agente: generados con `print-prompt` (gateway) — coordinator (`ceibo.md`) y
//     worker (`ceibo-worker.md`). La box los tenía hand-copiados y driftearon; acá se regeneran.
//
// El output queda con los PLACEHOLDERS de secretos intactos (`__VLLM_KEY__`,
// `__ANTHROPIC_VAULT_REF__`): este build NO inyecta secretos. La box los sustituye al servir
// (cp.sh sed-ea `__VLLM_KEY__` desde ~/.archima/vllm.key). Ver README.
//
// Es una herramienta de DEPLOY (la consume el `deploy:archima-*` de F6.2), no runtime.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
const RUNTIME_SRC = join(PKG_ROOT, "runtime");

/** Literales-secreto que NUNCA pueden aparecer en el árbol desplegable (red de seguridad). */
const SECRET_PATTERNS: RegExp[] = [
  /vault-[A-Za-z0-9_-]{6,}/,
  /sk-[A-Za-z0-9_-]{16,}/,
  /sk-ant[A-Za-z0-9_-]{6,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Genera un prompt standalone del flujo de delegación v2 vía el CLI estable del gateway.
 *  `--reporter=silent` evita que el banner de pnpm contamine el stdout. */
function printPrompt(role: "archima-coordinator" | "archima-worker"): string {
  return execFileSync("pnpm", ["--reporter=silent", "--filter", "@ceibo/gateway", "print-prompt", role], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

/** Recorre recursivamente `dir` devolviendo cada path de archivo. Exportada: la usan los tests. */
export function* walkFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p);
    else yield p;
  }
}

/** Falla si algún archivo del árbol contiene un literal-secreto. Exportada: la usan los tests
 *  sobre `runtime/` y `diff-box`. */
export function assertNoSecrets(dir: string): void {
  for (const file of walkFiles(dir)) {
    const text = readFileSync(file, "utf8");
    for (const re of SECRET_PATTERNS) {
      const m = text.match(re);
      if (m) throw new Error(`literal-secreto en ${file}: ${m[0].slice(0, 6)}… (patrón ${re})`);
    }
  }
}

/** Ensambla el árbol desplegable en `outDir` (lo recrea de cero). Devuelve `outDir`. */
export function build(outDir: string): string {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // 1. set estático versionado (vm/ + configs/, de-secreteado), preservando bits +x.
  cpSync(RUNTIME_SRC, outDir, { recursive: true });
  // 2. prompts de fuente única — generados, NO copiados a mano.
  const promptsDir = join(outDir, "configs", "prompts");
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, "ceibo.md"), printPrompt("archima-coordinator"));
  writeFileSync(join(promptsDir, "ceibo-worker.md"), printPrompt("archima-worker"));
  // 3. red de seguridad: el árbol desplegable no puede llevar secretos.
  assertNoSecrets(outDir);
  return outDir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] ?? join(PKG_ROOT, "dist", "runtime");
  build(out);
  console.error(`runtime de archima ensamblado en ${out}`);
}
