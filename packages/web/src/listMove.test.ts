// Tests de moveItemEdits (lógica pura) y del StateCommand moveListItem (headless CM6).
import { EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { type LineEdit, moveItemEdits, renumberTouching } from "./listEdit.ts";
import { listIndent } from "./listIndent.ts";
import { moveListItem } from "./listMove.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Aplica LineEdits (a lo sumo uno por línea) y devuelve las líneas resultantes. */
function apply(lines: string[], edits: LineEdit[]): string[] {
  const out = [...lines];
  for (const e of edits) {
    const text = out[e.line] ?? "";
    out[e.line] = text.slice(0, e.from) + e.insert + text.slice(e.to);
  }
  return out;
}

/** Pipeline completo: move + renumeración (simula lo que hace el autoRenumberFilter). */
function moveOn(lines: string[], line: number, dir: "up" | "down"): string[] {
  const edits = moveItemEdits(lines, line, dir);
  if (edits === null) return lines;
  const moved = apply(lines, edits);
  // Renumerar los bloques tocados (igual que el filtro CM6)
  const touched = edits.map((e) => e.line);
  return apply(moved, renumberTouching(moved, touched));
}

/** Corre un StateCommand headless y devuelve el doc resultante. El dispatch valida
 *  `startState` igual que el EditorView real — sin esto, un comando que dispatcha una
 *  transaction construida desde un state intermedio pasa headless pero revienta en el
 *  browser con "transaction that doesn't start from the previous state" (el bug que
 *  rompió Alt+↑/↓ en prod). */
function runCmd(cmd: ReturnType<typeof moveListItem>, doc: string, cursor: number) {
  let s = EditorState.create({ doc, selection: { anchor: cursor }, extensions: [listIndent()] });
  const handled = cmd({
    state: s,
    dispatch: (tr: Transaction) => {
      if (tr.startState !== s) {
        throw new RangeError(
          "Trying to update state with a transaction that doesn't start from the previous state.",
        );
      }
      s = tr.state;
    },
  });
  // selLine: texto de la línea donde quedó el cursor (el cursor debe SEGUIR al item movido)
  return { handled, doc: s.doc.toString(), selLine: s.doc.lineAt(s.selection.main.head).text };
}

// ── moveItemEdits — lógica pura ───────────────────────────────────────────────

describe("moveItemEdits — casos básicos", () => {
  it("mueve el segundo item hacia arriba (swap simple)", () => {
    const lines = ["- a", "- b", "- c"];
    expect(moveOn(lines, 1, "up")).toEqual(["- b", "- a", "- c"]);
  });

  it("mueve el primer item hacia abajo", () => {
    const lines = ["- a", "- b", "- c"];
    expect(moveOn(lines, 0, "down")).toEqual(["- b", "- a", "- c"]);
  });

  it("mover el primer item hacia arriba → null (no hay hermano)", () => {
    expect(moveItemEdits(["- a", "- b"], 0, "up")).toBeNull();
  });

  it("mover el último item hacia abajo → null (no hay hermano)", () => {
    expect(moveItemEdits(["- a", "- b"], 1, "down")).toBeNull();
  });

  it("línea que no es item → null", () => {
    expect(moveItemEdits(["texto normal", "- b"], 0, "up")).toBeNull();
    expect(moveItemEdits(["texto normal", "- b"], 0, "down")).toBeNull();
  });

  it("línea de continuación (no marker) → null", () => {
    const lines = ["- a", "  continuación de a", "- b"];
    // línea 1 es continuación, no marker
    expect(moveItemEdits(lines, 1, "up")).toBeNull();
    expect(moveItemEdits(lines, 1, "down")).toBeNull();
  });
});

describe("moveItemEdits — con subtrees", () => {
  it("arrastra el subtree del item al mover hacia arriba", () => {
    const lines = ["- a", "- b", "  - hijo de b", "- c"];
    // mover 'b' (línea 1, con su hijo línea 2) hacia arriba
    expect(moveOn(lines, 1, "up")).toEqual(["- b", "  - hijo de b", "- a", "- c"]);
  });

  it("arrastra el subtree del item al mover hacia abajo", () => {
    const lines = ["- a", "  - hijo de a", "- b", "- c"];
    // mover 'a' (línea 0, con su hijo línea 1) hacia abajo
    expect(moveOn(lines, 0, "down")).toEqual(["- b", "- a", "  - hijo de a", "- c"]);
  });

  it("swap entre dos items ambos con subtrees", () => {
    const lines = ["- a", "  - hijo a1", "  - hijo a2", "- b", "  - hijo b1"];
    // mover b (línea 3) hacia arriba → intercambia con a (líneas 0-2)
    const result = moveOn(lines, 3, "up");
    expect(result).toEqual(["- b", "  - hijo b1", "- a", "  - hijo a1", "  - hijo a2"]);
  });

  it("mover hacia abajo con subtree profundo", () => {
    const lines = ["- a", "  - hijo a", "    - nieto a", "- b"];
    expect(moveOn(lines, 0, "down")).toEqual(["- b", "- a", "  - hijo a", "    - nieto a"]);
  });
});

describe("moveItemEdits — listas ordenadas y renumeración", () => {
  // Nota sobre renumeración: moveItemEdits hace el swap de líneas crudas (conservando los
  // números originales). La renumeración la hace autoRenumberFilter (CM6) o renumberTouching
  // (en moveOn). En nivel 0, CommonMark respeta el número de arranque del PRIMER item —
  // tras el swap, el primer item puede tener un número distinto de 1 y CONSERVA ESE número.
  it("mover en lista ordenada → swap de líneas; renumeración respeta el arranque del nuevo primer item", () => {
    const lines = ["1. a", "2. b", "3. c"];
    // mover '2. b' hacia arriba: swap → ["2. b", "1. a", "3. c"]
    // renumber nivel 0: primer item = 2 (seed) → 2, 3, 4
    expect(moveOn(lines, 1, "up")).toEqual(["2. b", "3. a", "4. c"]);
  });

  it("mover el primer item hacia abajo → swap; el nuevo primer item era '2. b'", () => {
    const lines = ["1. a", "2. b", "3. c"];
    // swap → ["2. b", "1. a", "3. c"] → renumera desde 2
    expect(moveOn(lines, 0, "down")).toEqual(["2. b", "3. a", "4. c"]);
  });

  it("mover el último item hacia arriba → el primer item conserva su número de arranque", () => {
    const lines = ["1. a", "2. b", "3. c"];
    // swap c y b → ["1. a", "3. c", "2. b"] → renumera: 1(seed), 2, 3
    expect(moveOn(lines, 2, "up")).toEqual(["1. a", "2. c", "3. b"]);
  });
});

describe("moveItemEdits — todos (task items)", () => {
  it("conserva el estado checked/unchecked al mover", () => {
    const lines = ["- [x] done", "- [ ] todo", "- [ ] otra"];
    expect(moveOn(lines, 0, "down")).toEqual(["- [ ] todo", "- [x] done", "- [ ] otra"]);
  });

  it("conserva todos anidados al mover el padre", () => {
    const lines = ["- [ ] a", "  - [x] hijo de a", "- [ ] b"];
    expect(moveOn(lines, 0, "down")).toEqual(["- [ ] b", "- [ ] a", "  - [x] hijo de a"]);
  });
});

describe("moveItemEdits — niveles anidados (solo mueve entre hermanos del mismo nivel)", () => {
  it("primer item de un nivel anidado → up devuelve null (sin hermano)", () => {
    const lines = ["- a", "  - hijo1", "  - hijo2", "- b"];
    // hijo1 (línea 1) es el primer hijo → no hay hermano anterior en su nivel
    expect(moveItemEdits(lines, 1, "up")).toBeNull();
  });

  it("mueve entre hermanos del nivel anidado", () => {
    const lines = ["- a", "  - hijo1", "  - hijo2", "- b"];
    // mover hijo2 (línea 2) hacia arriba → swap con hijo1 (línea 1)
    expect(moveOn(lines, 2, "up")).toEqual(["- a", "  - hijo2", "  - hijo1", "- b"]);
  });

  it("un item anidado NO sube al nivel del padre (no cruza nivel)", () => {
    const lines = ["- a", "  - hijo1", "- b"];
    // hijo1 es único hijo → up devuelve null
    expect(moveItemEdits(lines, 1, "up")).toBeNull();
  });

  it("items de bloques distintos NO se intercambian", () => {
    // dos bloques separados por un párrafo
    const lines = ["- a", "", "párrafo", "", "- b"];
    // 'a' es el único item de su bloque → no hay hermano
    expect(moveItemEdits(lines, 0, "down")).toBeNull();
  });
});

describe("moveItemEdits — con líneas en blanco internas al bloque", () => {
  it("el blank interno viaja con el subtree del item que lo 'posee'", () => {
    // bloque con blank interno: ["- a", "", "- b", "- c"]
    // analyzeBlock: subtreeEnd de 'a' = 1 (incluye el blank), subtreeEnd de 'b' = 2.
    // mover b (línea 2) hacia arriba → topItem=a (líneas 0-1), botItem=b (línea 2)
    // reordered = [botLines, midLines, topLines] = ["- b", "- a", ""]
    const lines = ["- a", "", "- b", "- c"];
    const result = moveOn(lines, 2, "up");
    // El blank es parte del subtree de 'a' → viaja con a al bajar
    expect(result).toEqual(["- b", "- a", "", "- c"]);
  });
});

// ── moveListItem — StateCommand headless ──────────────────────────────────────

describe("moveListItem StateCommand (headless CM6)", () => {
  it("mueve item hacia arriba y renumera (vía autoRenumberFilter)", () => {
    const doc = "1. a\n2. b\n3. c";
    // cursor en "2. b"
    const cursor = doc.indexOf("2. b") + 2;
    const r = runCmd(moveListItem("up"), doc, cursor);
    expect(r.handled).toBe(true);
    // swap → ["2. b", "1. a", "3. c"]; renumber: 2 (seed), 3, 4
    expect(r.doc).toBe("2. b\n3. a\n4. c");
  });

  it("mueve item hacia abajo", () => {
    const doc = "- a\n- b\n- c";
    const cursor = doc.indexOf("- a") + 1;
    const r = runCmd(moveListItem("down"), doc, cursor);
    expect(r.handled).toBe(true);
    expect(r.doc).toBe("- b\n- a\n- c");
  });

  it("primer item hacia arriba → handled=false (deja pasar el default)", () => {
    const doc = "- a\n- b";
    const r = runCmd(moveListItem("up"), doc, 1);
    expect(r.handled).toBe(false);
    expect(r.doc).toBe(doc); // sin cambios
  });

  it("último item hacia abajo → handled=false", () => {
    const doc = "- a\n- b";
    const r = runCmd(moveListItem("down"), doc, doc.length - 1);
    expect(r.handled).toBe(false);
    expect(r.doc).toBe(doc);
  });

  it("cursor fuera de un item → handled=false", () => {
    const doc = "texto normal\n- a";
    const r = runCmd(moveListItem("down"), doc, 2);
    expect(r.handled).toBe(false);
  });

  it("mueve con subtree y renumera", () => {
    const doc = "1. a\n2. b\n   1. hijo de b\n3. c";
    // cursor en "2. b"
    const cursor = doc.indexOf("2. b") + 2;
    const r = runCmd(moveListItem("up"), doc, cursor);
    expect(r.handled).toBe(true);
    // swap b(+hijo) con a → ["2. b", "   1. hijo de b", "1. a", "3. c"]
    // renumber nivel 0: 2(seed), 3, 4; nivel 1: sigue siendo 1
    expect(r.doc).toBe("2. b\n   1. hijo de b\n3. a\n4. c");
  });

  // El cursor SIGUE al item movido (queda sobre su línea nueva): Alt+↑/↓ repetido tiene
  // que seguir moviendo EL MISMO item, no rebotar los dos (el bug del mapeo por changeset).
  it("el cursor sigue al item al mover hacia arriba", () => {
    const doc = "- a\n- b\n- c";
    const r = runCmd(moveListItem("up"), doc, doc.indexOf("- b") + 2);
    expect(r.doc).toBe("- b\n- a\n- c");
    expect(r.selLine).toBe("- b");
  });

  it("el cursor sigue al item al mover hacia abajo (con subtree de por medio)", () => {
    const doc = "- a\n  - hijo de a\n- b\n  - hijo de b\n- c";
    const r = runCmd(moveListItem("down"), doc, 2); // cursor en "- a"
    expect(r.doc).toBe("- b\n  - hijo de b\n- a\n  - hijo de a\n- c");
    expect(r.selLine).toBe("- a");
  });
});
