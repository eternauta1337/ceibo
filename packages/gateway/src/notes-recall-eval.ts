// Eval de recall@k de la búsqueda de notas (feature db F2) — EL GATE de F3.
//
// Compara, sobre el índice REAL de una DB (dev o la box, read-only), cuatro formas de
// encontrar notas: el baseline "grep" (substring, lo que hace hoy el agente), la léxica
// (FTS5), la semántica (vectores) y la híbrida (RRF). Métricas: hit@k (¿algún path
// esperado apareció en el top-k?) y MRR (a qué altura apareció el primero).
//
// Uso:
//   pnpm --filter @ceibo/gateway eval:notes-recall -- --cases eval/notes-recall.json [--k 5] [--db path]
//
// El archivo de casos lo arma un humano con queries REALES contra su wiki:
//   { "wikis": ["demo-personal"], "cases": [ { "query": "...", "expected": ["dir/nota.md"] } ] }
//
// La semántica necesita EMBED_URL en el .env (bi-encoder en gpuhost); sin él corre igual
// y esa columna queda n/a. No escribe NADA en la DB (sólo SELECT).

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  createEmbedder,
  DEFAULT_EMBED_MODEL,
  defaultDbPath,
  type Embedder,
  getIndexedNote,
  indexedNoteRefs,
  openDb,
  searchNotesHybrid,
  searchNotesLexical,
  searchNotesSemantic,
} from "@ceibo/store";

export interface RecallCase {
  query: string;
  /** Paths esperados (relativos a su wiki). Alcanza con que UNO aparezca en el top-k. */
  expected: string[];
}

export interface RecallCasesFile {
  wikis: string[];
  cases: RecallCase[];
}

export interface ModeResult {
  mode: string;
  hitAtK: number;
  mrr: number;
  misses: string[]; // queries que no encontraron nada esperado
}

const rankOfFirstHit = (paths: string[], expected: string[]): number => {
  const i = paths.findIndex((p) => expected.includes(p));
  return i === -1 ? 0 : 1 / (i + 1);
};

/** Baseline "grep": substring case-insensitive de cada palabra CON CONTENIDO de la query
 *  (≥4 chars — un agente greppea "colegio", no "con"/"la"), rankeado por cantidad de
 *  palabras que matchean. Aprox honesta del `grep -rin` de hoy: sin stemming, sin
 *  acentos, sin ranking real. */
export function grepBaseline(notes: { path: string; content: string }[], query: string, k: number): string[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  return notes
    .map((n) => ({
      path: n.path,
      score: words.filter((w) => n.content.toLowerCase().includes(w)).length,
    }))
    .filter((n) => n.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((n) => n.path);
}

export async function runRecallEval(
  db: ReturnType<typeof openDb>,
  file: RecallCasesFile,
  k: number,
  embedder: Embedder | null,
): Promise<ModeResult[]> {
  const wikis = file.wikis;
  // Corpus para el baseline grep: todas las notas indexadas de esas wikis.
  const corpus = wikis.flatMap((w) =>
    indexedNoteRefs(db, w)
      .map((r) => getIndexedNote(db, w, r.path))
      .filter((n): n is NonNullable<typeof n> => n !== null),
  );

  const modes: { mode: string; run: (c: RecallCase) => Promise<string[]> }[] = [
    { mode: "grep", run: async (c) => grepBaseline(corpus, c.query, k) },
    { mode: "lexical", run: async (c) => searchNotesLexical(db, wikis, c.query, k).map((h) => h.path) },
    ...(embedder
      ? [
          {
            mode: "semantic",
            run: async (c: RecallCase) => {
              const vec = (await embedder.embed([c.query], "query"))[0] ?? null;
              return vec ? searchNotesSemantic(db, wikis, vec, k).map((h) => h.path) : [];
            },
          },
          {
            mode: "hybrid",
            run: async (c: RecallCase) => {
              const vec = (await embedder.embed([c.query], "query"))[0] ?? null;
              return searchNotesHybrid(db, wikis, c.query, vec, k).map((h) => h.path);
            },
          },
        ]
      : []),
  ];

  const results: ModeResult[] = [];
  for (const { mode, run } of modes) {
    let hits = 0;
    let mrrSum = 0;
    const misses: string[] = [];
    for (const c of file.cases) {
      const paths = await run(c);
      const rr = rankOfFirstHit(paths, c.expected);
      if (rr > 0) hits++;
      else misses.push(c.query);
      mrrSum += rr;
    }
    results.push({
      mode,
      hitAtK: hits / file.cases.length,
      mrr: mrrSum / file.cases.length,
      misses,
    });
  }
  return results;
}

export function formatRecallReport(results: ModeResult[], k: number, total: number): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const lines = [
    `recall de búsqueda de notas — ${total} queries, k=${k}`,
    "",
    `${"modo".padEnd(10)} ${"hit@k".padEnd(8)} MRR`,
    ...results.map((r) => `${r.mode.padEnd(10)} ${pct(r.hitAtK).padEnd(8)} ${r.mrr.toFixed(2)}`),
  ];
  for (const r of results) {
    if (r.misses.length) lines.push("", `misses de ${r.mode}:`, ...r.misses.map((m) => `  · ${m}`));
  }
  return lines.join("\n");
}

// --- CLI ---------------------------------------------------------------------

async function main(): Promise<void> {
  // `pnpm run … -- --cases x` cuela un `--` al frente, y parseArgs corta ahí el parseo
  // de opciones: se lo sacamos antes.
  const raw = process.argv.slice(2);
  const { values } = parseArgs({
    args: raw[0] === "--" ? raw.slice(1) : raw,
    allowPositionals: true,
    options: {
      cases: { type: "string" },
      db: { type: "string" },
      k: { type: "string", default: "5" },
    },
  });
  if (!values.cases) {
    console.error("uso: eval:notes-recall -- --cases <casos.json> [--k 5] [--db <path>]");
    process.exit(1);
  }
  const file = JSON.parse(readFileSync(values.cases, "utf8")) as RecallCasesFile;
  if (!file.wikis?.length || !file.cases?.length) {
    console.error("el archivo de casos necesita `wikis` y `cases` no vacíos");
    process.exit(1);
  }
  const db = openDb(values.db ?? defaultDbPath());
  const embedder = process.env.EMBED_URL
    ? createEmbedder({ url: process.env.EMBED_URL, modelId: process.env.EMBED_MODEL || DEFAULT_EMBED_MODEL })
    : null;
  if (!embedder) console.error("(sin EMBED_URL: columnas semantic/hybrid omitidas)\n");
  const k = Number(values.k) || 5;
  const results = await runRecallEval(db, file, k, embedder);
  console.log(formatRecallReport(results, k, file.cases.length));
  db.close();
}

const entrypointUrl = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : "";
if (import.meta.url === entrypointUrl) {
  void main();
}
