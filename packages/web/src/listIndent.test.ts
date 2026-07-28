// Tests headless (EditorState, sin DOM) del glue CM6: los comandos (StateCommand) y el
// transactionFilter de renumeración automática — que compone en el MISMO update.
// El keybinding real (Prec sobre el keymap de atomic) se verificó en el browser.
import { EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { changeListIndent, emptyItemEnter, listIndent } from "./listIndent.ts";

function state(doc: string) {
  return EditorState.create({ doc, extensions: [listIndent()] });
}

/** Corre un StateCommand y devuelve el doc resultante (null si devolvió false). */
function run(cmd: typeof emptyItemEnter, doc: string, cursor: number) {
  let s = EditorState.create({ doc, selection: { anchor: cursor }, extensions: [listIndent()] });
  const handled = cmd({
    state: s,
    dispatch: (tr: Transaction) => {
      s = tr.state;
    },
  });
  return { handled, doc: s.doc.toString() };
}

describe("changeListIndent (Tab/Shift-Tab) + filtro, headless", () => {
  it("Tab indenta y el filtro renumera en el mismo update (ejemplo del owner)", () => {
    const doc = "1. Lorem\n2. Lorem\n3. Ipsum\n4. Ipsum";
    const r = run(changeListIndent(1), doc, doc.indexOf("2. Lorem") + 8);
    expect(r.handled).toBe(true);
    expect(r.doc).toBe("1. Lorem\n   1. Lorem\n2. Ipsum\n3. Ipsum");
  });
  it("Shift-Tab desindenta y renumera ambos niveles", () => {
    const doc = "1. a\n   1. b\n   2. c\n2. d";
    const r = run(changeListIndent(-1), doc, doc.indexOf("1. b") + 4);
    expect(r.doc).toBe("1. a\n2. b\n   1. c\n3. d");
  });
  it("Tab fuera de una lista devuelve false (sigue el default)", () => {
    const r = run(changeListIndent(1), "párrafo normal", 3);
    expect(r.handled).toBe(false);
    expect(r.doc).toBe("párrafo normal");
  });
  it("Tab en el primer item consume la tecla sin cambios", () => {
    const doc = "1. a\n2. b";
    const r = run(changeListIndent(1), doc, 2);
    expect(r.handled).toBe(true);
    expect(r.doc).toBe(doc);
  });
});

describe("emptyItemEnter (Enter en item vacío)", () => {
  it("desindenta un nivel un item anidado vacío", () => {
    const doc = "1. a\n   1. b\n   2. ";
    const r = run(emptyItemEnter, doc, doc.length);
    expect(r.handled).toBe(true);
    expect(r.doc).toBe("1. a\n   1. b\n2. ");
  });
  it("en nivel 0 saca el marker (sale de la lista) y renumera lo que sigue", () => {
    const doc = "1. a\n2. \n3. b";
    const r = run(emptyItemEnter, doc, doc.indexOf("2. ") + 3);
    expect(r.handled).toBe(true);
    expect(r.doc).toBe("1. a\n\n2. b");
  });
  it("item vacío de todo (- [ ] ) también desindenta", () => {
    const doc = "- [ ] a\n  - [ ] ";
    const r = run(emptyItemEnter, doc, doc.length);
    expect(r.handled).toBe(true);
    expect(r.doc).toBe("- [ ] a\n- [ ] ");
  });
  it("item con contenido devuelve false (Enter normal continúa la lista)", () => {
    const doc = "1. a\n2. b";
    const r = run(emptyItemEnter, doc, doc.length);
    expect(r.handled).toBe(false);
  });
  it("item cuyo último char es '*' NO se trata como vacío (continúa la lista, bug WIP #4)", () => {
    // El '*' final hacía dudar de la continuación cuando el autoclosing convertía `*`→`**`
    // (ya desactivado en el patch del atomic). emptyItemEnter NO debe consumir el Enter:
    // el item tiene contenido, así que devuelve false y markdownKeymap continúa el bullet.
    for (const doc of ["- item dos *", "* beta *", "- [ ] tarea *"]) {
      const r = run(emptyItemEnter, doc, doc.length);
      expect(r.handled).toBe(false);
    }
  });
  it("cursor en el medio (no a fin de línea) devuelve false", () => {
    const doc = "1. a\n2. ";
    const r = run(emptyItemEnter, doc, doc.indexOf("2. ") + 2);
    expect(r.handled).toBe(false);
  });
});

describe("autoRenumberFilter", () => {
  it("renumera al borrar un item del medio", () => {
    const s = state("1. a\n2. b\n3. c\n4. d");
    // borrar la línea "2. b\n" como lo haría el usuario
    const tr = s.update({ changes: { from: 5, to: 10, insert: "" }, userEvent: "delete" });
    expect(tr.state.doc.toString()).toBe("1. a\n2. c\n3. d");
  });
  it("renumera al insertar un item en el medio", () => {
    const s = state("1. a\n2. b");
    const tr = s.update({ changes: { from: 4, to: 4, insert: "\n2. nuevo" }, userEvent: "input" });
    expect(tr.state.doc.toString()).toBe("1. a\n2. nuevo\n3. b");
  });
  it("no toca transacciones sin userEvent (programáticas)", () => {
    const s = state("1. a\n7. b");
    const tr = s.update({ changes: { from: 0, to: 0, insert: "x" } });
    expect(tr.state.doc.toString()).toBe("x1. a\n7. b");
  });
  it("no genera cambios si la numeración ya es canónica (sin loop)", () => {
    const s = state("1. a\n2. b");
    const tr = s.update({ changes: { from: 4, to: 4, insert: "x" }, userEvent: "input.type" });
    expect(tr.state.doc.toString()).toBe("1. ax\n2. b");
  });
  it("mapea la selección a través de la renumeración", () => {
    const s = state("1. a\n9. bcd");
    // cursor al final de "9. bcd"; el "9"→"2" no lo mueve relativo al texto
    const tr = s.update({
      changes: { from: 11, to: 11, insert: "e" },
      selection: { anchor: 12 },
      userEvent: "input.type",
    });
    expect(tr.state.doc.toString()).toBe("1. a\n2. bcde");
    expect(tr.state.selection.main.head).toBe(12);
  });
});
