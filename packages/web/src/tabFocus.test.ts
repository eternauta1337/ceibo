import { describe, expect, it } from "vitest";
import { decideOpenAction, type OpenTabState } from "./tabFocus.ts";

const TABS: OpenTabState[] = [
  { id: "a", repo: "wiki", path: "notes/uno.md" },
  { id: "b", repo: "wiki", path: "notes/dos.md" },
  { id: "c", repo: "otra", path: "notes/uno.md" }, // mismo path, distinto repo
];

describe("decideOpenAction — foco si ya está abierta", () => {
  it("enfoca la pestaña cuya entrada actual coincide (repo+path)", () => {
    expect(decideOpenAction("wiki", "notes/dos.md", TABS)).toEqual({
      action: "focus",
      tabId: "b",
    });
  });

  it("desambigua por repo: mismo path en otra wiki no matchea", () => {
    expect(decideOpenAction("otra", "notes/uno.md", TABS)).toEqual({
      action: "focus",
      tabId: "c",
    });
  });

  it("enfocar gana sobre forceNewTab (no duplicar)", () => {
    expect(decideOpenAction("wiki", "notes/uno.md", TABS, { forceNewTab: true })).toEqual({
      action: "focus",
      tabId: "a",
    });
  });

  it("usa el PRIMER match si hubiera duplicados", () => {
    const dup: OpenTabState[] = [
      { id: "x", repo: "wiki", path: "n.md" },
      { id: "y", repo: "wiki", path: "n.md" },
    ];
    expect(decideOpenAction("wiki", "n.md", dup)).toEqual({
      action: "focus",
      tabId: "x",
    });
  });
});

describe("decideOpenAction — nota no abierta (estilo Obsidian)", () => {
  it("click simple → reemplaza la pestaña activa (NO abre pestaña nueva)", () => {
    // Regresión #239: esto devolvía new-tab en desktop → cada click abría pestaña, ningún
    // historial crecía y las flechas back/forward desaparecían. El default es replace-active.
    expect(decideOpenAction("wiki", "notes/tres.md", TABS)).toEqual({
      action: "replace-active",
    });
  });

  it("forceNewTab (⌘-click / menú) → pestaña nueva", () => {
    expect(decideOpenAction("wiki", "notes/tres.md", TABS, { forceNewTab: true })).toEqual({
      action: "new-tab",
    });
  });

  it("sin pestañas: replace-active (pushEntryToActiveTab crea la primera)", () => {
    expect(decideOpenAction("wiki", "n.md", [])).toEqual({ action: "replace-active" });
  });

  it("sin pestañas + forceNewTab: pestaña nueva", () => {
    expect(decideOpenAction("wiki", "n.md", [], { forceNewTab: true })).toEqual({
      action: "new-tab",
    });
  });
});

describe("decideOpenAction — pestaña activa de sistema (config/agenda/…)", () => {
  // Bug: con una página de sistema (ej. Configuración) como tab activa, clickear una nota
  // no hacía nada (el push se descartaba). Una tab de sistema no tiene historial de notas
  // para "reemplazar", así que la nota se abre en pestaña nueva.
  it("nota no abierta + activeIsSystem → pestaña nueva (no replace, no no-op)", () => {
    expect(decideOpenAction("wiki", "notes/tres.md", TABS, { activeIsSystem: true })).toEqual({
      action: "new-tab",
    });
  });

  it("nota YA abierta + activeIsSystem → enfocar gana (no duplicar)", () => {
    expect(decideOpenAction("wiki", "notes/dos.md", TABS, { activeIsSystem: true })).toEqual({
      action: "focus",
      tabId: "b",
    });
  });

  it("activeIsSystem false/ausente → comportamiento normal (replace-active)", () => {
    expect(decideOpenAction("wiki", "notes/tres.md", TABS, { activeIsSystem: false })).toEqual({
      action: "replace-active",
    });
  });

  it("forceNewTab y activeIsSystem ambos → pestaña nueva (consistente)", () => {
    expect(
      decideOpenAction("wiki", "notes/tres.md", TABS, { forceNewTab: true, activeIsSystem: true }),
    ).toEqual({ action: "new-tab" });
  });
});
