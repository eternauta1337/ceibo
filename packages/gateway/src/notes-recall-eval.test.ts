import {
  type Embedder,
  notesPendingEmbed,
  openDb,
  saveNoteChunks,
  upsertIndexedNote,
  vectorToBlob,
} from "@ceibo/store";
import { describe, expect, it } from "vitest";
import { formatRecallReport, grepBaseline, runRecallEval } from "./notes-recall-eval.ts";

const v = (x: number, y: number) => {
  const n = Math.hypot(x, y);
  return Float32Array.from([x / n, y / n]);
};

describe("notes-recall-eval", () => {
  it("grepBaseline: substring por palabra, sin magia (el punto es que PIERDE con paráfrasis)", () => {
    const notes = [
      { path: "asado.md", content: "costillar a la parrilla con los primos" },
      { path: "otro.md", content: "presupuesto del lunes" },
    ];
    expect(grepBaseline(notes, "parrilla primos", 5)).toEqual(["asado.md"]);
    expect(grepBaseline(notes, "comida con la familia", 5)).not.toContain("asado.md"); // la paráfrasis no matchea
  });

  it("runRecallEval: la semántica encuentra la paráfrasis que grep/léxica pierden", async () => {
    const db = openDb(":memory:");
    upsertIndexedNote(db, {
      repo: "w",
      path: "asado.md",
      content: "# Asado\ncostillar a la parrilla con los primos",
      blobSha: "a",
    });
    upsertIndexedNote(db, {
      repo: "w",
      path: "otro.md",
      content: "# Otro\npresupuesto del lunes",
      blobSha: "b",
    });
    for (const n of notesPendingEmbed(db, 10)) {
      saveNoteChunks(db, n.id, [
        { seq: 0, text: n.content, vector: vectorToBlob(n.path === "asado.md" ? v(1, 0) : v(0, 1)) },
      ]);
    }
    const embedder: Embedder = {
      modelId: "fake",
      embed: async (texts) => texts.map((t) => (t.includes("familia") ? v(1, 0.2) : v(0, 1))),
    };

    // Paráfrasis sin colisiones triviales: ni "comida" ni "familiar" aparecen en la nota
    // (con stopwords tipo "con"/"la" la léxica-OR matchearía por ruido y el test mentiría).
    const results = await runRecallEval(
      db,
      { wikis: ["w"], cases: [{ query: "comida familiar", expected: ["asado.md"] }] },
      5,
      embedder,
    );
    const byMode = Object.fromEntries(results.map((r) => [r.mode, r]));
    expect(byMode.grep!.hitAtK).toBe(0); // el baseline pierde la paráfrasis
    expect(byMode.lexical!.hitAtK).toBe(0);
    expect(byMode.semantic!.hitAtK).toBe(1); // el vector la encuentra
    expect(byMode.hybrid!.hitAtK).toBe(1);
    expect(byMode.hybrid!.mrr).toBeGreaterThan(0);

    const report = formatRecallReport(results, 5, 1);
    expect(report).toContain("hybrid");
    expect(report).toContain("misses de grep");
    db.close();
  });

  it("sin embedder sólo corre grep y léxica", async () => {
    const db = openDb(":memory:");
    upsertIndexedNote(db, { repo: "w", path: "a.md", content: "hola mundo", blobSha: "a" });
    const results = await runRecallEval(
      db,
      { wikis: ["w"], cases: [{ query: "hola", expected: ["a.md"] }] },
      5,
      null,
    );
    expect(results.map((r) => r.mode)).toEqual(["grep", "lexical"]);
    expect(results[0]!.hitAtK).toBe(1);
    db.close();
  });
});
