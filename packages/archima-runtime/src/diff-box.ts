// diff-box.ts — herramienta de OPERADOR (no corre en CI: necesita SSH a la box). Verifica que un
// checkout del paquete reproduce FIELMENTE el runtime vivo de gpuhost, que es el criterio de
// "hecho" de F6.1 ("diff paquete ↔ box solo en secretos/.bak/assets").
//
// Qué hace: ensambla el árbol desplegable (build()), trae el runtime de la box (read-only, sin
// `.bak`), de-secretea la copia de la box igual que el paquete, y compara archivo por archivo.
// Los prompts driftean a propósito (la box los tenía hand-copiados; el paquete los regenera) →
// se reportan como DRIFT esperado, no como error. (`wiki-sync.mjs` quedará BOX-ONLY hasta que se
// redeploye el runtime: se removió del path de archima — git nativo es el único acceso a wikis.)
// Un mismatch en un archivo ESTÁTICO canónico (vm/*, opencode-delegv2.json) sí es error.
//
// Uso: ARCHIMA_SSH_TARGET=gpuhost pnpm --filter @ceibo/archima-runtime diff-box
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "./build.ts";

const SSH = process.env.ARCHIMA_SSH_TARGET ?? "gpuhost";
const BOX = process.env.ARCHIMA_BOX_RUNTIME ?? "~/experiment-malocal";
/** Generados/vendoreados por el build → drift esperado contra la box hand-copiada. */
const EXPECTED_DRIFT = new Set(["configs/prompts/ceibo.md", "configs/prompts/ceibo-worker.md"]);

/** De-secretea la copia de la box del opencode config igual que el paquete (anthropic ref). */
function desecret(text: string): string {
  try {
    const secret = JSON.parse(text)?.provider?.anthropic?.options?.apiKey;
    if (typeof secret === "string" && !secret.startsWith("__")) {
      return text.replace(secret, "__ANTHROPIC_VAULT_REF__");
    }
  } catch {
    /* no es JSON parseable: se compara tal cual */
  }
  return text;
}

function relFiles(dir: string): string[] {
  return execFileSync("find", [dir, "-type", "f"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((p) => p.slice(dir.length + 1))
    .sort();
}

const tmp = mkdtempSync(join(tmpdir(), "archima-diffbox-"));
const pkgTree = build(join(tmp, "pkg"));
const boxTree = join(tmp, "box");
for (const sub of ["vm", "configs"]) {
  execFileSync("rsync", ["-a", "--exclude=*.bak*", `${SSH}:${BOX}/${sub}/`, `${boxTree}/${sub}/`]);
}

const pkgFiles = new Set(relFiles(pkgTree));
const boxFiles = new Set(relFiles(boxTree));
let errors = 0;
const drift: string[] = [];
const boxOnly: string[] = [];

for (const rel of pkgFiles) {
  if (!boxFiles.has(rel)) {
    console.log(`PKG-ONLY  ${rel}`);
    errors++;
    continue;
  }
  const a = readFileSync(join(pkgTree, rel), "utf8");
  const b = desecret(readFileSync(join(boxTree, rel), "utf8"));
  if (a === b) continue;
  if (EXPECTED_DRIFT.has(rel)) drift.push(rel);
  else {
    console.log(`MISMATCH  ${rel}  (archivo estático canónico difiere — esperado byte-idéntico)`);
    errors++;
  }
}
for (const rel of boxFiles) if (!pkgFiles.has(rel)) boxOnly.push(rel);

console.log(`\nDRIFT esperado (se reconcilia al deploy): ${drift.join(", ") || "—"}`);
console.log(`BOX-ONLY (no-canónico/.bak/assets, descartado): ${boxOnly.join(", ") || "—"}`);
console.log(
  errors === 0
    ? "\nOK: el paquete reproduce el runtime estático de la box."
    : `\nFALLO: ${errors} archivo(s) inesperado(s).`,
);
process.exit(errors === 0 ? 0 : 1);
