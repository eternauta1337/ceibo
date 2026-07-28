// Resolución del SHA del deploy para el endpoint GET /api/version.
//
// Fuente primaria: `.deployed-sha` en el cwd del proceso (línea 1, recortada a 7 chars).
// Los scripts de deploy (deploy-staging.sh, promote-prod.sh) lo escriben en la raíz del
// árbol desplegado. Fallback para dev local: `git rev-parse --short HEAD`. Si ninguno
// resuelve → null.
//
// Se exporta como función pura para poder testearse sin efectos de módulo.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Resuelve el SHA corto (7 chars) del deploy desde `.deployed-sha` o git. */
export function resolveDeploySha(cwd: string = process.cwd()): string | null {
  try {
    const shaFile = join(cwd, ".deployed-sha");
    if (existsSync(shaFile)) {
      const sha = readFileSync(shaFile, "utf8").split("\n")[0]?.trim().slice(0, 7) ?? null;
      if (sha) return sha;
    }
  } catch {
    /* ignorar errores de lectura */
  }
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    /* no es repo git o git no disponible */
  }
  return null;
}
