// Tests de moveItemTo / moveItemToEdits / dragTargets (lógica pura del drag & drop de
// items, v2 del reordenamiento) y del StateCommand dropListItem (headless CM6 con
// dispatch que valida startState, igual que listMove.test.ts).
import { EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { dropListItem } from "./listDrag.ts";
import { dragTargets, type LineEdit, moveItemTo, moveItemToEdits, renumberTouching } from "./listEdit.ts";
import { listIndent } from "./listIndent.ts";

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

/** Pipeline completo: drop + renumeración (simula lo que hace el autoRenumberFilter). */
function dropOn(lines: string[], from: number, target: number, level?: number): string[] {
  const edits = moveItemToEdits(lines, from, target, level);
  if (edits === null) return lines;
  const moved = apply(lines, edits);
  return apply(
    moved,
    renumberTouching(
      moved,
      edits.map((e) => e.line),
    ),
  );
}

/** Corre un StateCommand headless con dispatch que valida startState (lección de v1:
 *  una transaction derivada de un state intermedio pasa headless "naive" pero revienta
 *  en el EditorView real). */
function runCmd(cmd: ReturnType<typeof dropListItem>, doc: string, cursor = 0) {
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
  return { handled, doc: s.doc.toString(), selLine: s.doc.lineAt(s.selection.main.head).text };
}

// ── moveItemTo — movimientos básicos ──────────────────────────────────────────

describe("moveItemTo — gaps básicos (mismo nivel)", () => {
  const lines = ["- a", "- b", "- c"];

  it("mueve el último item al tope (gap 0)", () => {
    expect(dropOn(lines, 2, 0)).toEqual(["- c", "- a", "- b"]);
  });

  it("mueve el primer item al final (gap end+1)", () => {
    expect(dropOn(lines, 0, 3)).toEqual(["- b", "- c", "- a"]);
  });

  it("mueve el primer item al medio (antes del tercero)", () => {
    expect(dropOn(lines, 0, 2)).toEqual(["- b", "- a", "- c"]);
  });

  it("newLine sigue al marker: arriba = targetLine, abajo = targetLine - largo del subtree", () => {
    expect(moveItemTo(lines, 2, 0)?.newLine).toBe(0);
    expect(moveItemTo(lines, 0, 3)?.newLine).toBe(2);
  });
});

describe("moveItemTo — no-ops y rechazos", () => {
  it("gap pegado al propio item (antes del marker o después del subtree) → edits []", () => {
    const lines = ["- a", "  - a1", "- b"];
    expect(moveItemToEdits(lines, 0, 0)).toEqual([]); // justo antes de sí mismo
    expect(moveItemToEdits(lines, 0, 2)).toEqual([]); // justo después de su subtree
  });

  it("soltar DENTRO del propio subtree → null", () => {
    const lines = ["- a", "  - a1", "  - a2", "    - a21", "- b"];
    expect(moveItemToEdits(lines, 0, 1)).toBeNull();
    expect(moveItemToEdits(lines, 0, 2)).toBeNull();
    expect(moveItemToEdits(lines, 0, 3)).toBeNull();
    // el gap después del subtree completo (línea 4) es el no-op, no un rechazo
    expect(moveItemToEdits(lines, 0, 4)).toEqual([]);
  });

  it("fromLine que no es marker de item → null", () => {
    expect(moveItemToEdits(["texto", "- a", "- b"], 0, 3)).toBeNull();
    expect(moveItemToEdits(["- a", "  continuación", "- b"], 1, 0)).toBeNull();
  });

  it("targetLine que no es un gap del bloque → null", () => {
    const lines = ["- a", "  continuación de a", "- b"];
    expect(moveItemToEdits(lines, 2, 1)).toBeNull(); // línea de continuación, no gap
    const two = ["- a", "- b", "", "párrafo", "", "- x", "- y"];
    expect(moveItemToEdits(two, 0, 5)).toBeNull(); // gap de OTRO bloque
    expect(moveItemToEdits(two, 0, 3)).toBeNull(); // línea fuera de todo bloque
    expect(moveItemToEdits(two, 0, 99)).toBeNull(); // fuera del doc
  });

  it("bloque de un solo item → solo no-ops", () => {
    const lines = ["- solo"];
    expect(moveItemToEdits(lines, 0, 0)).toEqual([]);
    expect(moveItemToEdits(lines, 0, 1)).toEqual([]);
  });
});

describe("moveItemTo — el subtree viaja completo", () => {
  it("arrastra descendientes al mover arriba", () => {
    const lines = ["- a", "- b", "  - b1", "    - b11", "- c"];
    expect(dropOn(lines, 1, 0)).toEqual(["- b", "  - b1", "    - b11", "- a", "- c"]);
  });

  it("arrastra descendientes al mover al final", () => {
    const lines = ["- a", "  - a1", "- b", "- c"];
    expect(dropOn(lines, 0, 4)).toEqual(["- b", "- c", "- a", "  - a1"]);
  });

  it("las líneas de continuación viajan con el item", () => {
    const lines = ["- a", "  continuación de a", "- b"];
    expect(dropOn(lines, 0, 3)).toEqual(["- b", "- a", "  continuación de a"]);
  });

  it("los blanks internos del subtree viajan con su dueño", () => {
    const lines = ["- a", "", "- b", "- c"];
    // el blank pertenece al subtree de 'a' (igual que en v1)
    expect(dropOn(lines, 0, 4)).toEqual(["- b", "- c", "- a", ""]);
  });
});

// ── nivel destino (regla: el del item de ARRIBA del gap) ─────────────────────

describe("moveItemTo — nivel destino según el gap", () => {
  it("cae después de un item anidado → adopta SU nivel (el de arriba)", () => {
    const lines = ["- a", "  - a1", "- b", "- c"];
    // gap antes de b (línea 2): arriba está a1 (nivel 1) → c se indenta a nivel 1
    expect(dropOn(lines, 3, 2)).toEqual(["- a", "  - a1", "  - c", "- b"]);
  });

  it("el subtree del item se re-indenta con el mismo delta", () => {
    const lines = ["- a", "  - a1", "- b", "- c", "  - c1"];
    expect(dropOn(lines, 3, 2)).toEqual(["- a", "  - a1", "  - c", "    - c1", "- b"]);
  });

  it("cae al tope del bloque → nivel del item de abajo (nivel 0)", () => {
    const lines = ["- a", "  - a1", "- b"];
    expect(dropOn(lines, 2, 0)).toEqual(["- b", "- a", "  - a1"]);
  });

  it("un item anidado soltado entre items de nivel 0 se DESANIDA", () => {
    const lines = ["- a", "  - a1", "  - a2", "- b", "- c"];
    // gap antes de c (línea 4): arriba está b (nivel 0) → a1 baja a nivel 0
    expect(dropOn(lines, 1, 4)).toEqual(["- a", "  - a2", "- b", "- a1", "- c"]);
  });

  it("REGLA DOCUMENTADA: entre un padre y su primer hijo cae al nivel del PADRE y adopta los hijos que siguen", () => {
    const lines = ["- a", "- b", "  - b1"];
    // gap antes de b1 (línea 2): arriba está b (nivel 0) → a queda nivel 0 y b1 cuelga de a
    expect(dropOn(lines, 0, 2)).toEqual(["- b", "- a", "  - b1"]);
  });

  it("indent con tabs se normaliza a espacios al re-indentar", () => {
    const lines = ["- a", "\t- a1", "- b", "- c"];
    // gap antes de b (línea 2): arriba a1 (nivel 1, col 4 por tab) → c a col 4 en espacios
    expect(dropOn(lines, 3, 2)).toEqual(["- a", "\t- a1", "    - c", "- b"]);
  });
});

// ── targetLevel explícito ─────────────────────────────────────────────────────

describe("moveItemTo — targetLevel explícito", () => {
  const lines = ["- a", "  - a1", "- b"];

  it("hermano del de arriba (nivel del ref)", () => {
    // gap antes de a1 (línea 1) con nivel 0 → entre a y a1 al nivel de a
    expect(dropOn(lines, 2, 1, 0)).toEqual(["- a", "- b", "  - a1"]);
  });

  it("hijo directo del de arriba (ref.level + 1 → contentCol)", () => {
    expect(dropOn(lines, 2, 1, 1)).toEqual(["- a", "  - b", "  - a1"]);
  });

  it("nivel más profundo que ref.level+1 → null", () => {
    expect(moveItemToEdits(lines, 2, 1, 2)).toBeNull();
  });

  it("resuelve la columna por la cadena de ancestros", () => {
    const deep = ["- a", "  - a1", "    - a11", "- b"];
    // mover b al final con nivel 1 → col de a1
    expect(dropOn(deep, 3, 4, 1)).toEqual(["- a", "  - a1", "    - a11", "  - b"]);
    // nivel 3 = hijo de a11 (contentCol)
    expect(dropOn(deep, 3, 4, 3)).toEqual(["- a", "  - a1", "    - a11", "      - b"]);
    // nivel 4 → inalcanzable
    expect(moveItemToEdits(deep, 3, 4, 4)).toBeNull();
  });

  it("re-indenta IN PLACE en un gap no-op si el nivel difiere", () => {
    const doc = ["- a", "- b"];
    // gap 2 = después del subtree de b (no-op de posición) con nivel 1 → b hijo de a
    expect(dropOn(doc, 1, 2, 1)).toEqual(["- a", "  - b"]);
  });

  it("gap al tope con nivel != el del primer item → null", () => {
    expect(moveItemToEdits(lines, 2, 0, 1)).toBeNull();
  });
});

// ── ordenadas, todos ──────────────────────────────────────────────────────────

describe("moveItemTo — listas ordenadas y todos", () => {
  it("la renumeración (delegada) respeta el arranque del nuevo primer item", () => {
    const lines = ["1. a", "2. b", "3. c"];
    // c al tope: swap crudo ["3. c","1. a","2. b"] → renumera 3, 4, 5
    expect(dropOn(lines, 2, 0)).toEqual(["3. c", "4. a", "5. b"]);
  });

  it("ordenada anidada renumera por nivel", () => {
    const lines = ["1. a", "2. b", "   1. b1", "   2. b2", "   3. b3", "3. c"];
    // mover b3 (línea 4) al gap antes de b2 (línea 3) — hermanos de nivel 1
    expect(dropOn(lines, 4, 3)).toEqual(["1. a", "2. b", "   1. b1", "   2. b3", "   3. b2", "3. c"]);
  });

  it("conserva el estado checked/unchecked de los todos", () => {
    const lines = ["- [x] done", "- [ ] todo", "- [ ] otra"];
    expect(dropOn(lines, 0, 2)).toEqual(["- [ ] todo", "- [x] done", "- [ ] otra"]);
  });
});

// ── dragTargets ───────────────────────────────────────────────────────────────

describe("dragTargets", () => {
  it("null si fromLine no es un item", () => {
    expect(dragTargets(["texto", "- a"], 0)).toBeNull();
    expect(dragTargets(["- a", "  continuación"], 1)).toBeNull();
  });

  it("expone subtree y gaps con niveles según la regla", () => {
    const lines = ["- a", "  - a1", "- b", "- c"];
    const m = dragTargets(lines, 3); // arrastrando c
    expect(m).not.toBeNull();
    expect(m?.fromLine).toBe(3);
    expect(m?.subtreeEnd).toBe(3);
    expect(m?.targets).toEqual([
      { line: 0, level: 0, col: 0, refLine: 0, noop: false }, // tope: nivel del de abajo (a)
      { line: 1, level: 0, col: 0, refLine: 0, noop: false }, // entre a y a1: nivel de a
      { line: 2, level: 1, col: 2, refLine: 1, noop: false }, // entre a1 y b: nivel de a1
      { line: 3, level: 0, col: 0, refLine: 3, noop: true }, // antes de sí mismo
      { line: 4, level: 0, col: 0, refLine: 3, noop: true }, // después de sí mismo
    ]);
  });

  it("excluye los gaps dentro del propio subtree y los anclados en él", () => {
    const lines = ["- a", "  - a1", "- b", "- c"];
    const m = dragTargets(lines, 0); // arrastrando a (subtree 0..1)
    expect(m?.subtreeEnd).toBe(1);
    expect(m?.targets).toEqual([
      { line: 0, level: 0, col: 0, refLine: 0, noop: true }, // antes de sí mismo
      // línea 1 (dentro del subtree) NO aparece
      { line: 2, level: 0, col: 0, refLine: 0, noop: true }, // después de su subtree
      { line: 3, level: 0, col: 0, refLine: 2, noop: false }, // antes de c: nivel de b
      { line: 4, level: 0, col: 0, refLine: 3, noop: false }, // al final: nivel de c
    ]);
  });

  it("bloque de un solo item → solo no-ops (nada movible)", () => {
    const m = dragTargets(["- solo"], 0);
    expect(m?.targets.every((t) => t.noop)).toBe(true);
  });

  it("consistencia: el default de moveItemTo coincide con el target del gap", () => {
    const lines = ["- a", "  - a1", "- b", "- c", "  - c1"];
    const m = dragTargets(lines, 3);
    for (const t of m?.targets ?? []) {
      if (t.noop) continue;
      const r = moveItemTo(lines, 3, t.line);
      const explicit = moveItemTo(lines, 3, t.line, t.level);
      expect(r).not.toBeNull();
      expect(explicit?.edits).toEqual(r?.edits);
    }
  });

  it("un '- item' dentro de un code fence no es arrastrable", () => {
    const lines = ["```", "- no soy lista", "```"];
    expect(dragTargets(lines, 1)).toBeNull();
  });
});

// ── dropListItem — StateCommand headless ──────────────────────────────────────

describe("dropListItem (headless CM6, valida startState)", () => {
  it("mueve y renumera en UNA transaction (autoRenumberFilter appendea)", () => {
    const r = runCmd(dropListItem(2, 0), "1. a\n2. b\n3. c");
    expect(r.handled).toBe(true);
    expect(r.doc).toBe("3. c\n4. a\n5. b");
  });

  it("mueve con subtree y re-indenta al nivel del gap", () => {
    const r = runCmd(dropListItem(3, 2), "- a\n  - a1\n- b\n- c\n  - c1");
    expect(r.handled).toBe(true);
    expect(r.doc).toBe("- a\n  - a1\n  - c\n    - c1\n- b");
  });

  it("el cursor queda sobre la línea-marker movida", () => {
    const r = runCmd(dropListItem(2, 0), "- a\n- b\n- c");
    expect(r.doc).toBe("- c\n- a\n- b");
    expect(r.selLine).toBe("- c");
  });

  it("drop no-op → handled=false, doc intacto", () => {
    const doc = "- a\n- b";
    const r = runCmd(dropListItem(0, 0), doc);
    expect(r.handled).toBe(false);
    expect(r.doc).toBe(doc);
  });

  it("drop inválido (dentro del propio subtree) → handled=false", () => {
    const doc = "- a\n  - a1\n- b";
    const r = runCmd(dropListItem(0, 1), doc);
    expect(r.handled).toBe(false);
    expect(r.doc).toBe(doc);
  });

  it("un solo dispatch = un solo undo: move + renumeración van en LA MISMA transaction", () => {
    let s = EditorState.create({ doc: "1. a\n2. b\n3. c", extensions: [listIndent()] });
    let dispatches = 0;
    const handled = dropListItem(
      2,
      0,
    )({
      state: s,
      dispatch: (tr: Transaction) => {
        dispatches++;
        s = tr.state;
      },
    });
    expect(handled).toBe(true);
    expect(dispatches).toBe(1); // el autoRenumberFilter appendea al mismo tr (sequential)
    expect(s.doc.toString()).toBe("3. c\n4. a\n5. b");
  });
});
