import { describe, expect, it } from "vitest";
import {
  fuseHybrid,
  type LexicalHit,
  notesPendingEmbed,
  openDb,
  type SemanticHit,
  saveNoteChunks,
  searchNotesHybrid,
  searchNotesSemantic,
  upsertIndexedNote,
  vectorToBlob,
} from "./index.ts";

// Vectores sintéticos normalizados en R³: la "semántica" acá es geometría controlada.
const v = (x: number, y: number, z: number) => {
  const n = Math.hypot(x, y, z);
  return Float32Array.from([x / n, y / n, z / n]);
};

function seedNote(
  db: ReturnType<typeof openDb>,
  repo: string,
  path: string,
  content: string,
  vecs: Float32Array[],
) {
  upsertIndexedNote(db, { repo, path, content, blobSha: `sha-${path}` });
  const note = notesPendingEmbed(db, 100).find((n) => n.repo === repo && n.path === path)!;
  saveNoteChunks(
    db,
    note.id,
    vecs.map((vec, seq) => ({ seq, text: `chunk ${seq} de ${path}`, vector: vectorToBlob(vec) })),
  );
}

describe("searchNotesSemantic", () => {
  it("rankea por el MEJOR chunk de cada nota y scopea por repo", () => {
    const db = openDb(":memory:");
    // asado.md: un chunk cerca de la query, otro lejos → gana por su mejor chunk.
    seedNote(db, "w1", "asado.md", "# Asado", [v(1, 0.1, 0), v(0, 0, 1)]);
    seedNote(db, "w1", "impuestos.md", "# Impuestos", [v(0, 1, 0)]);
    seedNote(db, "w2", "otro.md", "# Otro", [v(1, 0, 0)]); // repo fuera de scope

    const hits = searchNotesSemantic(db, ["w1"], v(1, 0, 0), 10);
    expect(hits.map((h) => h.path)).toEqual(["asado.md", "impuestos.md"]);
    expect(hits[0]!.score).toBeGreaterThan(0.9);
    expect(hits[0]!.snippet).toContain("chunk 0"); // el chunk que matcheó, no el otro
    expect(hits.every((h) => h.repo === "w1")).toBe(true);
    db.close();
  });

  it("sin chunks embebidos devuelve vacío (no explota)", () => {
    const db = openDb(":memory:");
    upsertIndexedNote(db, { repo: "w", path: "a.md", content: "sin vectores", blobSha: "s" });
    expect(searchNotesSemantic(db, ["w"], v(1, 0, 0), 5)).toEqual([]);
    db.close();
  });
});

describe("fuseHybrid (RRF)", () => {
  const lex = (path: string): LexicalHit => ({
    repo: "w",
    path,
    title: path,
    snippet: `lex ${path}`,
    rank: 0,
  });
  const sem = (path: string, score = 0.9): SemanticHit => ({
    repo: "w",
    path,
    title: path,
    snippet: `sem ${path}`,
    score,
  });

  it("una nota presente en AMBAS listas le gana a las que están en una sola", () => {
    const hits = fuseHybrid([lex("a.md"), lex("b.md")], [sem("c.md"), sem("b.md")], 10);
    expect(hits[0]!.path).toBe("b.md"); // #2 léxico + #2 semántico > cualquier #1 solo
    expect(hits[0]!.sources.sort()).toEqual(["lexical", "semantic"]);
    expect(hits[0]!.snippet).toBe("sem b.md"); // el snippet semántico pisa al léxico
    expect(hits.map((h) => h.path).sort()).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("degradación: con una sola lista preserva su orden", () => {
    const only = fuseHybrid([lex("x.md"), lex("y.md")], [], 10);
    expect(only.map((h) => h.path)).toEqual(["x.md", "y.md"]);
    expect(only[0]!.sources).toEqual(["lexical"]);
    expect(fuseHybrid([], [], 10)).toEqual([]);
  });

  it("respeta el límite", () => {
    const many = Array.from({ length: 30 }, (_, i) => lex(`n${i}.md`));
    expect(fuseHybrid(many, [], 5)).toHaveLength(5);
  });
});

describe("searchNotesHybrid (integración)", () => {
  it("léxica + semántica juntas encuentran lo que cada una sola no", () => {
    const db = openDb(":memory:");
    // "asado.md" habla de comida pero NO contiene la palabra "cena" → sólo lo trae el vector.
    seedNote(db, "w", "asado.md", "# Asado\ncostillar a la parrilla con los primos", [v(1, 0.1, 0)]);
    // "agenda.md" contiene el literal "cena" → lo trae la léxica.
    seedNote(db, "w", "agenda.md", "# Agenda\ncena de trabajo el jueves", [v(0, 1, 0)]);

    const queryVec = v(1, 0, 0); // "cerca" de asado.md
    const hits = searchNotesHybrid(db, ["w"], "cena", queryVec, 10);
    expect(hits.map((h) => h.path).sort()).toEqual(["agenda.md", "asado.md"]);

    // Sin vector de query (gpuhost caído): degrada a léxica pura y sigue respondiendo.
    const lexOnly = searchNotesHybrid(db, ["w"], "cena", null, 10);
    expect(lexOnly.map((h) => h.path)).toEqual(["agenda.md"]);
    db.close();
  });
});
