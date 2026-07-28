// Verificación byte-a-byte DB vs git HEAD (feature db — GATE del cutover de F3).
//
// Antes de flipear a "DB fuente de verdad" hay que probar que el índice de la DB representa
// EXACTAMENTE lo que hay en git — si no, una nota podría "revertirse" o desaparecer para el
// usuario al flipear (el editor pasa a leer la DB). Es el mismo espíritu que `verify-prod.sh`:
// comparar por CONTENIDO, no por un sha declarado.
//
// Sale limpio sólo si, para CADA repo: toda nota .md de git HEAD está en la DB con contenido
// IDÉNTICO, y la DB no tiene notas .md que git no tenga (índice stale). Se corre con el freeze
// puesto (nada cambia mientras verifica). Read-only: no escribe nada.

import type { Db } from "@ceibo/store";
import { indexedNoteRefs } from "@ceibo/store";
import { isIndexablePath } from "./notes-indexer.ts";

export interface VerifySubstrate {
  read(repo: string, ref?: string): Promise<{ ref: string; files: { path: string; content: string }[] }>;
}

export interface RepoVerifyResult {
  repo: string;
  ref: string;
  matched: number;
  dbOnly: string[]; // en la DB pero no en git HEAD (índice stale / write no espejado)
  gitOnly: string[]; // en git pero no en la DB (falta indexar)
  mismatch: string[]; // en ambos, contenido distinto
}

export function isClean(r: RepoVerifyResult): boolean {
  return r.dbOnly.length === 0 && r.gitOnly.length === 0 && r.mismatch.length === 0;
}

export async function verifyRepo(db: Db, wikis: VerifySubstrate, repo: string): Promise<RepoVerifyResult> {
  const snap = await wikis.read(repo);
  const gitNotes = new Map(snap.files.filter((f) => isIndexablePath(f.path)).map((f) => [f.path, f.content]));
  const dbContent = (path: string): string | undefined =>
    (
      db.prepare("SELECT content FROM notes WHERE repo = ? AND path = ?").get(repo, path) as
        | { content: string }
        | undefined
    )?.content;

  const dbPaths = new Set(indexedNoteRefs(db, repo).map((r) => r.path));
  const result: RepoVerifyResult = { repo, ref: snap.ref, matched: 0, dbOnly: [], gitOnly: [], mismatch: [] };

  for (const [path, gitText] of gitNotes) {
    const dbText = dbContent(path);
    if (dbText === undefined) result.gitOnly.push(path);
    else if (dbText === gitText) result.matched++;
    else result.mismatch.push(path);
  }
  for (const path of dbPaths) {
    if (!gitNotes.has(path)) result.dbOnly.push(path);
  }
  return result;
}

export async function verifyAll(
  db: Db,
  wikis: VerifySubstrate,
  repos: string[],
): Promise<RepoVerifyResult[]> {
  const out: RepoVerifyResult[] = [];
  for (const repo of repos) out.push(await verifyRepo(db, wikis, repo));
  return out;
}

export function formatVerify(results: RepoVerifyResult[]): string {
  const lines: string[] = [];
  let dirty = 0;
  for (const r of results) {
    const clean = isClean(r);
    if (!clean) dirty++;
    lines.push(
      `${clean ? "✓" : "✗"} ${r.repo} @ ${r.ref.slice(0, 7)} — match ${r.matched}` +
        (r.mismatch.length ? ` · MISMATCH ${r.mismatch.length}` : "") +
        (r.gitOnly.length ? ` · git-only ${r.gitOnly.length}` : "") +
        (r.dbOnly.length ? ` · db-only ${r.dbOnly.length}` : ""),
    );
    for (const p of r.mismatch) lines.push(`    ≠ ${p}`);
    for (const p of r.gitOnly) lines.push(`    +git ${p}`);
    for (const p of r.dbOnly) lines.push(`    +db  ${p}`);
  }
  lines.push(
    "",
    dirty === 0
      ? "LIMPIO — la DB representa git byte-a-byte. Flip SEGURO."
      : `SUCIO — ${dirty} repo(s) con diferencias. NO flipear.`,
  );
  return lines.join("\n");
}
