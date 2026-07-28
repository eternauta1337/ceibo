// Búsqueda sobre el índice derivado de notas (feature db F2): semántica (dot-product
// sobre note_chunks) + fusión híbrida con la léxica (FTS5, notes-index.ts).
//
// Piezas PURAS: el que orquesta (el MCP `notes` del gateway) embebe la query con el
// bi-encoder y decide el modo; acá no hay HTTP ni async. Si no hay vector de query
// (gpuhost caído / EMBED_URL ausente), el caller usa sólo la léxica — degradación, no error.
//
// Los vectores están normalizados (norma 1) ⇒ dot = similitud coseno.

import type { Db } from "./index.ts";
import { blobToVector, dot } from "./notes-embed.ts";
import { type LexicalHit, noteChunksWithVectors, searchNotesLexical } from "./notes-index.ts";

export interface SemanticHit {
  repo: string;
  path: string;
  title: string;
  /** El texto del chunk que mejor matcheó (recortado): sirve de snippet. */
  snippet: string;
  /** Similitud coseno query↔chunk, en [-1, 1]. */
  score: number;
}

const SNIPPET_CHARS = 240;

/** Top-k notas por similitud coseno del MEJOR chunk de cada una. Full scan en memoria:
 *  el volumen esperado (miles de chunks por usuario) se barre en ms; si algún día duele,
 *  el reemplazo es un índice ANN — la firma no cambia. */
export function searchNotesSemantic(
  db: Db,
  repos: string[],
  queryVec: Float32Array,
  limit = 20,
): SemanticHit[] {
  const best = new Map<string, SemanticHit>();
  for (const row of noteChunksWithVectors(db, repos)) {
    const score = dot(queryVec, blobToVector(row.vector));
    const key = `${row.repo}\n${row.path}`;
    const prev = best.get(key);
    if (!prev || score > prev.score) {
      best.set(key, {
        repo: row.repo,
        path: row.path,
        title: row.title,
        snippet: row.text.length > SNIPPET_CHARS ? `${row.text.slice(0, SNIPPET_CHARS)}…` : row.text,
        score,
      });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface HybridHit {
  repo: string;
  path: string;
  title: string;
  snippet: string;
  /** Puntaje RRF (sólo ordena; no es comparable entre queries). */
  score: number;
  /** De qué lado(s) vino: sirve para debuggear la fusión y para la eval. */
  sources: ("lexical" | "semantic")[];
}

// Reciprocal Rank Fusion (Cormack et al.): score = Σ 1/(K + rank). K=60 es el estándar;
// amortigua la cabeza para que un #1 de una lista no aplaste todo lo demás.
const RRF_K = 60;

/** Fusiona resultados léxicos y semánticos por RRF. Cualquiera de las dos listas puede
 *  venir vacía (degradación) — la fusión de una sola lista preserva su orden. */
export function fuseHybrid(lexical: LexicalHit[], semantic: SemanticHit[], limit = 20): HybridHit[] {
  const acc = new Map<string, HybridHit>();
  const add = (
    hits: { repo: string; path: string; title: string; snippet: string }[],
    source: "lexical" | "semantic",
  ) => {
    hits.forEach((h, rank) => {
      const key = `${h.repo}\n${h.path}`;
      const rrf = 1 / (RRF_K + rank + 1);
      const prev = acc.get(key);
      if (prev) {
        prev.score += rrf;
        prev.sources.push(source);
        // El snippet semántico suele ser más útil que el recorte del FTS; si la nota ya
        // estaba por la léxica y ahora llega por semántica, nos quedamos con éste.
        if (source === "semantic") prev.snippet = h.snippet;
      } else {
        acc.set(key, {
          repo: h.repo,
          path: h.path,
          title: h.title,
          snippet: h.snippet,
          score: rrf,
          sources: [source],
        });
      }
    });
  };
  add(lexical, "lexical");
  add(semantic, "semantic");
  return [...acc.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Búsqueda híbrida en una llamada: léxica siempre; semántica si hay vector de query. */
export function searchNotesHybrid(
  db: Db,
  repos: string[],
  query: string,
  queryVec: Float32Array | null,
  limit = 20,
): HybridHit[] {
  // Pedimos más que `limit` de cada lado (barato: el scan semántico ya trae todo);
  // la fusión re-ordena y recorta.
  const lex = searchNotesLexical(db, repos, query, limit * 3);
  const sem = queryVec ? searchNotesSemantic(db, repos, queryVec, limit * 3) : [];
  return fuseHybrid(lex, sem, limit);
}
