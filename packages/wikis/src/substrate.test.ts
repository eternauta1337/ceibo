import { describe, expect, it } from "vitest";
import { type Change, conflictingChanges, conflictPaths } from "./substrate.ts";

const tree = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("conflictPaths (Decisión 1-A: conflicto por-path)", () => {
  it("base y HEAD iguales → sin conflicto", () => {
    const t = tree({ "a.md": "s1", "b.md": "s2" });
    expect(conflictPaths(["a.md"], t, t)).toEqual([]);
  });

  it("auto-merge: tocar A mientras otro tocó B (path distinto) no conflictúa", () => {
    const base = tree({ "a.md": "s1", "b.md": "s2" });
    const head = tree({ "a.md": "s1", "b.md": "s2-mod" }); // otro escritor modificó b
    expect(conflictPaths(["a.md"], base, head)).toEqual([]);
  });

  it("conflicto: el mismo path fue modificado en HEAD", () => {
    expect(conflictPaths(["a.md"], tree({ "a.md": "s1" }), tree({ "a.md": "s1-mod" }))).toEqual(["a.md"]);
  });

  it("conflicto: el path fue agregado en HEAD (no existía en base)", () => {
    expect(conflictPaths(["a.md"], tree({}), tree({ "a.md": "s1" }))).toEqual(["a.md"]);
  });

  it("conflicto: el path fue borrado en HEAD", () => {
    expect(conflictPaths(["a.md"], tree({ "a.md": "s1" }), tree({}))).toEqual(["a.md"]);
  });

  it("crear un path nuevo, ausente también en HEAD, no conflictúa", () => {
    expect(conflictPaths(["new.md"], tree({}), tree({ "other.md": "s9" }))).toEqual([]);
  });

  it("reporta sólo los paths en conflicto, no los limpios", () => {
    const base = tree({ "a.md": "s1", "b.md": "s2", "c.md": "s3" });
    const head = tree({ "a.md": "s1", "b.md": "s2-mod", "c.md": "s3" });
    expect(conflictPaths(["a.md", "b.md", "c.md"], base, head)).toEqual(["b.md"]);
  });

  it("commit multi-archivo: todos limpios → sin conflicto", () => {
    const base = tree({ "a.md": "s1", "b.md": "s2" });
    const head = tree({ "a.md": "s1", "b.md": "s2", "z.md": "s9" }); // otro agregó z
    expect(conflictPaths(["a.md", "b.md"], base, head)).toEqual([]);
  });
});

// REGRESIÓN del invariante "la edición manual SIEMPRE gana" (bug 02, 2026-06-09).
// Modela el escenario del "BUM, versión vieja": baseRef declarado VIEJO/al-día + edición web en
// el medio + push del agente con contenido VIEJO → DEBE conflictúar, NUNCA clobbear.
describe("conflictingChanges (invariante: la edición manual gana)", () => {
  // shaX0 = versión que el agente vio al hidratar; shaX1 = la que dejó la edición manual web.
  const put = (path: string, base: string | null): Change => ({ op: "put", path, content: "x", base });

  it("CLOBBER PREVENIDO: el agente declara base viejo (shaX0) pero HEAD ya es la edición web (shaX1) → conflicto", () => {
    const head = tree({ "nota.md": "shaX1" }); // el usuario editó a mano: HEAD avanzó
    // base del agente = shaX0 (lo que tenía en su working copy, PRE edición del usuario).
    expect(conflictingChanges([put("nota.md", "shaX0")], head, head)).toEqual(["nota.md"]);
  });

  it("la grieta que cierra el fix: con baseRef ya al-día (baseTree==headTree) el modelo VIEJO no lo detecta", () => {
    // Reproduce la desincronización estado-vs-disco: el ref del agente avanzó al HEAD, así que
    // baseTree == headTree y `conflictPaths` (modelo viejo) devuelve [] → habría clobbeado.
    const head = tree({ "nota.md": "shaX1" });
    expect(conflictPaths(["nota.md"], head, head)).toEqual([]); // ← el bug: no ve el conflicto
    // El modelo nuevo SÍ lo ve porque compara el `base` por-path del cambio contra el HEAD real.
    expect(conflictingChanges([put("nota.md", "shaX0")], head, head)).toEqual(["nota.md"]);
  });

  it("edición legítima del agente (vio la última versión, base==HEAD) → sin conflicto", () => {
    const head = tree({ "nota.md": "shaX1" });
    expect(conflictingChanges([put("nota.md", "shaX1")], head, head)).toEqual([]);
  });

  it("crear nota nueva (base null = espero ausente) y el path no existe en HEAD → sin conflicto", () => {
    const head = tree({ "otra.md": "s9" });
    expect(conflictingChanges([put("nueva.md", null)], head, head)).toEqual([]);
  });

  it("crear nota nueva pero otro escritor ya creó ese path en HEAD → conflicto (no pisar)", () => {
    const head = tree({ "nueva.md": "ajena" });
    expect(conflictingChanges([put("nueva.md", null)], head, head)).toEqual(["nueva.md"]);
  });

  it("delete con base del blob que se borra, pero el usuario lo editó en el medio → conflicto", () => {
    const head = tree({ "nota.md": "shaX1" }); // el usuario lo modificó
    const del: Change = { op: "delete", path: "nota.md", base: "shaX0" };
    expect(conflictingChanges([del], head, head)).toEqual(["nota.md"]);
  });

  it("auto-merge: el agente toca A (base correcto) mientras el usuario tocó B → sin conflicto en A", () => {
    const head = tree({ "a.md": "sa", "b.md": "sb-web" });
    expect(conflictingChanges([put("a.md", "sa")], head, head)).toEqual([]);
  });

  it("cliente legacy (sin `base`) → fallback al modelo baseRef-vs-HEAD (sin regresión)", () => {
    const base = tree({ "nota.md": "shaX0" });
    const head = tree({ "nota.md": "shaX1" }); // el usuario editó → baseTree != headTree
    const legacy: Change = { op: "put", path: "nota.md", content: "x" }; // sin base
    expect(conflictingChanges([legacy], base, head)).toEqual(["nota.md"]);
  });
});
