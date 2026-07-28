import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Test de SEMÁNTICA del blame de git (el que GitHub corre por debajo de la GraphQL API que usa
// `wikis.blame`). Reproduce el bug de atribución reportado por el owner: en una wiki de dos
// usuarios, U1 escribe la línea 1 y U2 agrega la línea 2; el blame mostraba a U2 como autor de
// AMBAS líneas.
//
// Root cause: git blamea por bytes del blob. Si el commit de U1 dejó la línea 1 SIN `\n` terminal,
// el commit de U2 (que agrega la línea 2) reescribe los bytes de la línea 1 — le agrega el `\n`
// que le faltaba — y git se la atribuye a U2. El fix (web/noteContent.ts `withTrailingNewline`,
// aplicado en el save del editor) garantiza que cada commit deje la nota newline-terminada, así un
// append posterior no toca la última línea previa y el blame atribuye cada línea a su autor real.
//
// Estos tests corren git de verdad sobre un repo temporal (no tocan GitHub ni el mock de octokit).
//
// ⚠️ AISLAMIENTO CRÍTICO: cuando vitest corre DESDE un hook de git (ej. el pre-push de husky), git
// le pasa al hook `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` apuntando al repo REAL. Si los
// heredáramos, nuestros `git -C <tmp> commit` escribirían en el repo del proyecto (¡commits
// "u1/u2" en la rama!) en vez del repo temporal. Por eso scrubbeamos esas vars en CADA invocación.

let dir: string;

// process.env SIN las vars de localización de git → todo `git -C <tmp>` opera sólo sobre el
// repo temporal, nunca sobre el repo del proyecto (aunque corramos dentro de un git hook).
function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const e = { ...process.env, ...extra };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) {
    delete e[k];
  }
  return e;
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: cleanEnv() });
}

/** Quién (nombre de autor git) escribió cada línea, según `git blame`, en orden. */
function blameAuthors(file: string): string[] {
  // `--line-porcelain` emite un bloque por línea con `author <nombre>`.
  const out = git("blame", "--line-porcelain", file);
  return out
    .split("\n")
    .filter((l) => l.startsWith("author "))
    .map((l) => l.slice("author ".length));
}

/** Commitea `note.md` como `name`/`email` con fecha fija (autor Y committer). La identidad va por
 *  `-c user.*` y las fechas por env en CADA commit — nunca escribimos `git config` ni dependemos
 *  del reloj: así el test es determinista y no flakea bajo el runner paralelo (ese write+read de
 *  config bajo carga era la causa del fallo intermitente). */
function commitAs(name: string, email: string, date: string, message: string): void {
  execFileSync(
    "git",
    ["-C", dir, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", message],
    {
      encoding: "utf8",
      env: cleanEnv({
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
      }),
    },
  );
}

/** Simula los dos commits de dos usuarios: U1 escribe `firstWrite`, U2 escribe `secondWrite`. */
function twoUserCommits(firstWrite: string, secondWrite: string): void {
  const file = join(dir, "note.md");
  writeFileSync(file, firstWrite);
  git("add", "note.md");
  commitAs("U1", "u1@users.example.com", "2026-01-01T10:00:00", "u1 escribe la línea 1");
  writeFileSync(file, secondWrite);
  git("add", "note.md");
  commitAs("U2", "u2@users.example.com", "2026-01-02T10:00:00", "u2 agrega la línea 2");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ceibo-blame-"));
  git("init", "-q");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("atribución del blame con dos autores", () => {
  it("BUG: línea 1 sin `\\n` terminal → el append de U2 le roba la autoría a U1", () => {
    // Lo que pasaba ANTES del fix: el editor commiteaba el cuerpo tal cual, sin `\n` final.
    twoUserCommits("línea 1", "línea 1\nlínea 2\n");
    // Demostración del bug: git le atribuye AMBAS líneas a U2.
    expect(blameAuthors("note.md")).toEqual(["U2", "U2"]);
  });

  it("FIX: línea 1 newline-terminada → cada línea queda con su autor real", () => {
    // Lo que pasa CON el fix (withTrailingNewline en el save): el commit de U1 deja "línea 1\n",
    // así el commit de U2 no toca esos bytes y el blame separa bien los autores.
    twoUserCommits("línea 1\n", "línea 1\nlínea 2\n");
    expect(blameAuthors("note.md")).toEqual(["U1", "U2"]);
  });
});
