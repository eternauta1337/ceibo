// Backfill de la nota de bienvenida (`Bienvenida.md`) en las wikis EXISTENTES.
//
// Contexto: en #379 hicimos que el README de raíz sea una nota normal, pero las wikis viejas
// quedaron con el README PELADO que dejó `auto_init` (`# <repo>` y nada más). Este script convierte
// ese README pelado en `Bienvenida.md` con el contenido de bienvenida — y SÓLO en esas wikis: usa
// el MISMO predicado `isBareReadme` que la siembra en creación, así NUNCA pisa un README que el
// usuario ya editó.
//
// Para cada wiki:
//   - `Bienvenida.md` ya existe        → skip (ya tiene bienvenida).
//   - README pelado (isBareReadme)     → mueve README.md → Bienvenida.md con el contenido (1 commit).
//   - README con contenido real        → NO toca nada (deja el README del usuario como está).
//   - sin README de raíz               → skip.
//
// Seguro por diseño:
//   - DRY-RUN por default: lista qué wikis cambiaría, sin escribir nada.
//   - `--apply` para escribir de verdad.
//   - conservador: ante la mínima duda (README con cualquier contenido real), NO toca.
//
// Uso (en la box, con el .env cargado para tener las creds de la GitHub App):
//   set -a && . ./.env && set +a
//   npx tsx scripts/backfill-welcome-note.ts            # DRY-RUN (no escribe)
//   npx tsx scripts/backfill-welcome-note.ts --apply    # aplica de verdad
//
// Filtro opcional por substring de nombre (útil para probar contra una sola wiki):
//   npx tsx scripts/backfill-welcome-note.ts --only demo-personal
//   npx tsx scripts/backfill-welcome-note.ts --only demo-personal --apply

import {
  isBareReadme,
  README_PATH,
  WELCOME_MARKDOWN,
  WELCOME_PATH,
  wikisFromEnv,
} from "../packages/wikis/src/index.ts";

const apply = process.argv.includes("--apply");
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : undefined;

type Outcome = "convert" | "skip-already" | "skip-has-content" | "skip-no-readme" | "error";

async function main(): Promise<void> {
  const wikis = wikisFromEnv();
  const org = wikis.org;

  // `listRepos` devuelve "org/nombre"; nos quedamos con el nombre del repo.
  const fullNames = await wikis.listRepos();
  let names = fullNames.map((fn) => fn.split("/").at(-1) ?? fn);
  if (only) names = names.filter((n) => n.includes(only));

  console.log(
    `${apply ? "APPLY" : "DRY-RUN"} — org ${org} — ${names.length} wiki(s)${only ? ` (filtro "${only}")` : ""}\n`,
  );

  const counts: Record<Outcome, number> = {
    convert: 0,
    "skip-already": 0,
    "skip-has-content": 0,
    "skip-no-readme": 0,
    error: 0,
  };

  for (const name of names) {
    let outcome: Outcome;
    let detail = "";
    try {
      // Idempotencia: si ya hay `Bienvenida.md`, no hay nada que hacer.
      const files = await wikis.listFiles(name);
      if (files.includes(WELCOME_PATH)) {
        outcome = "skip-already";
        detail = "ya tiene Bienvenida.md";
      } else {
        let readme: { content: string; sha: string };
        try {
          readme = await wikis.getFile(name, README_PATH);
        } catch (e) {
          // 404 = no hay README de raíz (raro: auto_init siempre deja uno). No inventamos: skip.
          if ((e as { status?: number }).status === 404) {
            counts["skip-no-readme"]++;
            console.log(`  skip   ${name} — sin README de raíz`);
            continue;
          }
          throw e;
        }

        if (!isBareReadme(readme.content)) {
          outcome = "skip-has-content";
          detail = "README con contenido real → no se toca";
        } else if (apply) {
          await wikis.moveFile(
            name,
            README_PATH,
            WELCOME_PATH,
            readme.sha,
            "docs: nota de bienvenida (backfill)",
            {
              newContent: WELCOME_MARKDOWN,
            },
          );
          outcome = "convert";
          detail = "README.md → Bienvenida.md";
        } else {
          outcome = "convert"; // en dry-run cuenta como "se convertiría"
          detail = "SE CONVERTIRÍA README.md → Bienvenida.md (dry-run)";
        }
      }
    } catch (e) {
      outcome = "error";
      detail = (e as Error)?.message ?? String(e);
    }

    counts[outcome]++;
    const mark = outcome === "convert" ? "CONV " : outcome === "error" ? "ERROR" : "skip ";
    console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
  }

  console.log(
    `\nResumen: ${counts.convert} ${apply ? "convertidas" : "a convertir"}, ` +
      `${counts["skip-already"]} ya con Bienvenida, ` +
      `${counts["skip-has-content"]} con contenido (intactas), ` +
      `${counts["skip-no-readme"]} sin README, ${counts.error} con error.`,
  );
  if (!apply && counts.convert > 0) {
    console.log("\n(dry-run — nada se escribió. Reejecutá con --apply para aplicar.)");
  }
  if (counts.error > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`✗ ${(e as Error)?.message ?? e}`);
  process.exit(1);
});
