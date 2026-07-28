// Invariantes del WIRING de F6.2 (cutover de paths + restore del ref anthropic). Estos tests no
// necesitan red ni la box; blindan que el runtime versionado quedó listo para correr desde
// ~/archima/<env> (self-location) y que ningún archivo sigue apuntando al path viejo.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { walkFiles } from "./build.ts";

const RUNTIME = resolve(dirname(fileURLToPath(import.meta.url)), "..", "runtime");
const read = (rel: string) => readFileSync(join(RUNTIME, "vm", rel), "utf8");

describe("wiring F6.2 del runtime versionado", () => {
  it("cp.sh restaura __ANTHROPIC_VAULT_REF__ al servir (espejo de __VLLM_KEY__)", () => {
    const cp = read("cp.sh");
    expect(cp).toContain("ARCHIMA_ANTHROPIC_REF_FILE");
    expect(cp).toContain("__ANTHROPIC_VAULT_REF__");
    // sustitución idempotente sobre el config temporal, guardada por existencia del file.
    expect(cp).toMatch(/sed -i "s\|__ANTHROPIC_VAULT_REF__\|/);
  });

  it("AVBIN (cp.sh) y AV (cp-forced.sh) apuntan al agent-vault COMPARTIDO ~/archima/agent-vault", () => {
    expect(read("cp.sh")).toContain("archima/agent-vault/agent-vault");
    expect(read("cp-forced.sh")).toContain("archima/agent-vault/agent-vault");
  });

  it("spawn-vm.sh y cp-forced.sh se autolocalizan (mismo archivo sirve prod y staging)", () => {
    // RUNTIME = parent de vm/ (donde vive el script) → ~/archima/<env>, no un path por-entorno.
    expect(read("spawn-vm.sh")).toMatch(/RUNTIME="\$\{ARCHIMA_RUNTIME:-\$\(cd "\$\(dirname "\$0"\)\/\.\./);
    // CP = relativo al propio script → ~/archima/<env>/vm/cp.sh.
    expect(read("cp-forced.sh")).toMatch(/CP="\$HERE\/cp\.sh"/);
  });

  it("ningún archivo de runtime/ referencia el path viejo experiment-malocal", () => {
    const offenders: string[] = [];
    for (const file of walkFiles(RUNTIME)) {
      if (readFileSync(file, "utf8").includes("experiment-malocal")) {
        offenders.push(file.slice(RUNTIME.length + 1));
      }
    }
    expect(offenders, `aún referencian experiment-malocal: ${offenders.join(", ")}`).toEqual([]);
  });
});
