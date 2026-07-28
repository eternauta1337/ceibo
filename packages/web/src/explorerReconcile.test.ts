import { describe, expect, it } from "vitest";
import { pendKey, reconcileTree, splitPendKey } from "./explorerReconcile.ts";

const W = (repo: string, files: string[]) => ({ repo, files });

describe("pendKey / splitPendKey", () => {
  it("round-trip", () => {
    const k = pendKey("repo-x", "a/b/c.md");
    expect(splitPendKey(k)).toEqual(["repo-x", "a/b/c.md"]);
  });
});

describe("reconcileTree — lado REMOVIDO (archivar/borrar, origen de un move)", () => {
  it("esconde un path removido aunque el server stale todavía lo traiga", () => {
    const removed = new Set([pendKey("r", "a.md")]);
    const added = new Set<string>();
    const out = reconcileTree([W("r", ["a.md", "b.md"])], removed, added);
    expect(out[0]?.files).toEqual(["b.md"]);
    expect(removed.has(pendKey("r", "a.md"))).toBe(true); // sigue pendiente: el server aún lo trae
  });

  it("auto-purga el removido cuando el server ya NO lo trae (delete confirmado)", () => {
    const removed = new Set([pendKey("r", "a.md")]);
    const out = reconcileTree([W("r", ["b.md"])], removed, new Set());
    expect(out[0]?.files).toEqual(["b.md"]);
    expect(removed.size).toBe(0); // confirmado → dejó de filtrarse
  });
});

describe("reconcileTree — lado AGREGADO (destino de move/rename, crear) [FIX del parpadeo]", () => {
  it("INYECTA un path agregado que el server stale todavía no trae (no parpadea)", () => {
    // El bug: tras mover/crear, el refresh stale no trae toPath → el add optimista se borraba →
    // la nota desaparecía. Ahora la inyectamos hasta que el server la confirme.
    const added = new Set([pendKey("r", "carpeta/nueva.md")]);
    const out = reconcileTree([W("r", ["vieja.md"])], new Set(), added);
    expect(out[0]?.files).toEqual(["carpeta/nueva.md", "vieja.md"]); // sorted
    expect(added.has(pendKey("r", "carpeta/nueva.md"))).toBe(true); // sigue pendiente
  });

  it("auto-purga el agregado cuando el server YA lo trae (add confirmado)", () => {
    const added = new Set([pendKey("r", "n.md")]);
    const out = reconcileTree([W("r", ["n.md", "x.md"])], new Set(), added);
    expect(out[0]?.files).toEqual(["n.md", "x.md"]);
    expect(added.size).toBe(0); // confirmado
  });

  it("no duplica si el server ya trae el agregado", () => {
    const added = new Set([pendKey("r", "n.md")]);
    const out = reconcileTree([W("r", ["n.md"])], new Set(), added);
    expect(out[0]?.files).toEqual(["n.md"]);
  });
});

describe("reconcileTree — MOVE completo (remove from + add to), simulando refresh stale", () => {
  it("un refresh con el árbol VIEJO no hace parpadear: from oculto, to inyectado", () => {
    // Estado optimista ya aplicado: from removido, to agregado. Llega /api/explorer STALE (árbol
    // viejo: trae `from`, no trae `to`). Resultado esperado: el árbol se ve como el destino final.
    const removed = new Set([pendKey("r", "a/nota.md")]);
    const added = new Set([pendKey("r", "b/nota.md")]);
    const staleTree = [W("r", ["a/nota.md", "otra.md"])]; // server aún no propagó el move
    const out = reconcileTree(staleTree, removed, added);
    expect(out[0]?.files).toEqual(["b/nota.md", "otra.md"]); // from oculto, to inyectado
    // ambos siguen pendientes: el server todavía no confirmó ninguno de los dos lados
    expect(removed.size).toBe(1);
    expect(added.size).toBe(1);
  });

  it("cuando el server YA propagó el move, ambos lados se purgan y el árbol pasa tal cual", () => {
    const removed = new Set([pendKey("r", "a/nota.md")]);
    const added = new Set([pendKey("r", "b/nota.md")]);
    const freshTree = [W("r", ["b/nota.md", "otra.md"])];
    const out = reconcileTree(freshTree, removed, added);
    expect(out[0]?.files).toEqual(["b/nota.md", "otra.md"]);
    expect(removed.size).toBe(0);
    expect(added.size).toBe(0);
  });
});

describe("reconcileTree — varargs", () => {
  it("devuelve el mismo array si no hay pendientes (sin trabajo)", () => {
    const tree = [W("r", ["a.md"])];
    expect(reconcileTree(tree, new Set(), new Set())).toBe(tree);
  });

  it("identidad estable por-wiki cuando una wiki no cambia", () => {
    const wA = W("rA", ["x.md"]);
    const wB = W("rB", ["y.md"]);
    const removed = new Set([pendKey("rB", "y.md")]);
    const out = reconcileTree([wA, wB], removed, new Set());
    expect(out[0]).toBe(wA); // rA intacta → misma referencia
    expect(out[1]).not.toBe(wB); // rB cambió
  });

  it("inyecta el agregado en la wiki correcta (no cruza repos)", () => {
    const added = new Set([pendKey("rB", "n.md")]);
    const out = reconcileTree([W("rA", ["a.md"]), W("rB", ["b.md"])], new Set(), added);
    expect(out[0]?.files).toEqual(["a.md"]); // rA intacta
    expect(out[1]?.files).toEqual(["b.md", "n.md"]); // rB recibe el inject
  });
});
