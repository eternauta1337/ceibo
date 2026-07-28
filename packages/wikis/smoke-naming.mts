// Smoke de la convención de nombre de wiki (Fase 16): `<handle>-<label>`. No toca la red.
// Corré: tsx packages/wikis/smoke-naming.mts
import { assertValidLabel, userRepoName } from "./src/index.ts";

if (userRepoName("demo", "personal") !== "demo-personal") throw new Error("userRepoName mal compuesto");
if (userRepoName("lula", "personal") !== "lula-personal") throw new Error("userRepoName mal compuesto");

// Labels válidos: minúsculas, dígitos y guiones.
for (const ok of ["personal", "ceibo", "anniclaw", "wiki-2", "x"]) assertValidLabel(ok);

// Labels inválidos: throw.
for (const bad of ["Personal", "con espacio", "-empieza-guion", "", "acentúa", "muy".repeat(20)]) {
  let threw = false;
  try {
    assertValidLabel(bad);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`label inválido aceptado: "${bad}"`);
}

console.log("OK naming smoke");
