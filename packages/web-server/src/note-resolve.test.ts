import { describe, expect, it } from "vitest";
import { resolveNote } from "./note-resolve.ts";

const repos = [
  {
    repo: "demo-personal",
    files: ["backlog-ceibo.md", "backlog-save.md", "projects/compras.md", "ideas/cafe.md", "CLAUDE.md"],
  },
  { repo: "demo-trabajo", files: ["reuniones.md", "okrs-2026.md"] },
];

describe("resolveNote", () => {
  it("abre el path exacto cuando existe tal cual en el repo nombrado", () => {
    expect(resolveNote("demo-personal", "backlog-ceibo.md", repos)).toEqual({
      kind: "open",
      repo: "demo-personal",
      path: "backlog-ceibo.md",
    });
  });

  it("completa el .md faltante en un match exacto", () => {
    expect(resolveNote("demo-personal", "projects/compras", repos)).toEqual({
      kind: "open",
      repo: "demo-personal",
      path: "projects/compras.md",
    });
  });

  it("resuelve por prefijo cuando hay un único candidato (backlog → backlog-ceibo)", () => {
    // El bug reportado: el agente pide "backlog" y la nota real es "backlog-ceibo.md".
    // Acá hay DOS notas backlog-* → ambiguo (no inventa una).
    const res = resolveNote("demo-personal", "backlog", repos);
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") {
      expect(res.candidates).toEqual([
        { repo: "demo-personal", path: "backlog-ceibo.md" },
        { repo: "demo-personal", path: "backlog-save.md" },
      ]);
    }
  });

  it("CASO REAL del bug: dropea '-ceibo' en un path con carpeta (demo-ceibo/tecnico/backlog.md)", () => {
    // Logs de prod: el agente mandó repo correcto + nombre aproximado (dropeó el sufijo
    // "-ceibo"): path="tecnico/backlog.md" cuando la nota real es "tecnico/backlog-ceibo.md".
    // Único match → abre el path REAL (así coincide con la solapa ya abierta → enfoca).
    const real = [
      { repo: "demo-ceibo", files: ["tecnico/backlog-ceibo.md", "tecnico/roadmap.md", "diario.md"] },
    ];
    expect(resolveNote("demo-ceibo", "tecnico/backlog.md", real)).toEqual({
      kind: "open",
      repo: "demo-ceibo",
      path: "tecnico/backlog-ceibo.md",
    });
  });

  it("resuelve por prefijo único cuando sólo hay una nota que matchea", () => {
    const only = [{ repo: "w", files: ["backlog-ceibo.md", "otra.md"] }];
    expect(resolveNote("w", "backlog", only)).toEqual({
      kind: "open",
      repo: "w",
      path: "backlog-ceibo.md",
    });
  });

  it("normaliza separadores y mayúsculas: 'Backlog Save' → backlog-save.md", () => {
    expect(resolveNote("demo-personal", "Backlog Save", repos)).toEqual({
      kind: "open",
      repo: "demo-personal",
      path: "backlog-save.md",
    });
  });

  it("matchea por sufijo de path: 'compras' → projects/compras.md", () => {
    expect(resolveNote("demo-personal", "compras", repos)).toEqual({
      kind: "open",
      repo: "demo-personal",
      path: "projects/compras.md",
    });
  });

  it("ignora acentos: 'café' → ideas/cafe.md", () => {
    expect(resolveNote("demo-personal", "café", repos)).toEqual({
      kind: "open",
      repo: "demo-personal",
      path: "ideas/cafe.md",
    });
  });

  it("devuelve none cuando no hay ninguna nota parecida", () => {
    expect(resolveNote("demo-personal", "inexistente-xyz", repos)).toEqual({ kind: "none" });
  });

  it("cae a todas las wikis cuando el repo nombrado no tiene match", () => {
    // El agente adivinó mal el repo (puso personal) pero la nota vive en trabajo.
    expect(resolveNote("demo-personal", "okrs-2026.md", repos)).toEqual({
      kind: "open",
      repo: "demo-trabajo",
      path: "okrs-2026.md",
    });
  });

  it("nombre suelto (sin path, vino como repo) resuelve contra todas las wikis", () => {
    // parsePath("reuniones") → { repo: "reuniones", path: "" }: tratamos repo como query.
    expect(resolveNote("reuniones", "", repos)).toEqual({
      kind: "open",
      repo: "demo-trabajo",
      path: "reuniones.md",
    });
  });

  it("prefiere el repo nombrado ante un empate de nombre entre wikis", () => {
    const two = [
      { repo: "a", files: ["notas.md"] },
      { repo: "b", files: ["notas.md"] },
    ];
    expect(resolveNote("b", "notas.md", two)).toEqual({ kind: "open", repo: "b", path: "notas.md" });
  });

  it("query vacía → none (no abre cualquier cosa)", () => {
    expect(resolveNote("", "", repos)).toEqual({ kind: "none" });
  });
});
