// CLI del gate de cutover: verifica DB vs git HEAD para todas las wikis activas (read-only).
// Uso (en la box, con el freeze puesto): pnpm --filter @ceibo/web-server cutover:verify
// Exit 0 = limpio (flip seguro); exit 1 = diferencias (NO flipear).

import { allActiveRepoNames, defaultDbPath, openDb } from "@ceibo/store";
import { wikisFromEnv } from "@ceibo/wikis";
import { formatVerify, isClean, verifyAll } from "./notes-verify.ts";

async function main(): Promise<void> {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
  const db = openDb(defaultDbPath());
  const wikis = wikisFromEnv();
  const repos = allActiveRepoNames(db);
  const results = await verifyAll(db, wikis, repos);
  console.log(formatVerify(results));
  db.close();
  process.exit(results.every(isClean) ? 0 : 1);
}

const entrypointUrl = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : "";
if (import.meta.url === entrypointUrl) {
  void main();
}
