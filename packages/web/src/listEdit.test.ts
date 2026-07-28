import { describe, expect, it } from "vitest";
import {
  analyzeBlock,
  indentListEdits,
  type LineEdit,
  parseItem,
  renumberEdits,
  renumberTouching,
  scanBlocks,
} from "./listEdit.ts";

/** Aplica LineEdits (a lo sumo uno por línea en nuestras ops) y devuelve las líneas. */
function apply(lines: string[], edits: LineEdit[]): string[] {
  const out = [...lines];
  for (const e of edits) {
    const text = out[e.line] ?? "";
    out[e.line] = text.slice(0, e.from) + e.insert + text.slice(e.to);
  }
  return out;
}

/** Pipeline completo de una pulsación de Tab/Shift-Tab: indent + renumeración. */
function tabOn(lines: string[], line: number, dir: 1 | -1): string[] {
  const edits = indentListEdits(lines, line, line, dir);
  if (edits === null) return lines;
  const indented = apply(lines, edits);
  return apply(indented, renumberTouching(indented, [line]));
}

describe("parseItem", () => {
  it("parsea bullets, ordenadas y todos", () => {
    expect(parseItem("- hola")).toMatchObject({ col: 0, ordered: false, marker: "-", contentCol: 2 });
    expect(parseItem("12. x")).toMatchObject({
      ordered: true,
      number: 12,
      contentCol: 4,
      numFrom: 0,
      numTo: 2,
    });
    expect(parseItem("  3) y")).toMatchObject({ col: 2, number: 3, contentCol: 5, numFrom: 2, numTo: 3 });
    expect(parseItem("- [x] done")).toMatchObject({ marker: "-", task: "[x]", contentCol: 2 });
    expect(parseItem("1. [ ] todo")).toMatchObject({ number: 1, task: "[ ]", contentCol: 3 });
  });
  it("expande tabs a columnas de 4", () => {
    expect(parseItem("\t- x")).toMatchObject({ col: 4, contentCol: 6 });
  });
  it("rechaza no-items", () => {
    expect(parseItem("texto normal")).toBeNull();
    expect(parseItem("-sin espacio")).toBeNull();
    expect(parseItem("1.sin espacio")).toBeNull();
    expect(parseItem("")).toBeNull();
  });
  it("acepta item vacío (marker a fin de línea)", () => {
    expect(parseItem("- ")).toMatchObject({ marker: "-" });
    expect(parseItem("1.")).toMatchObject({ number: 1 });
  });
});

describe("scanBlocks + analyzeBlock", () => {
  it("asigna niveles por columnas (hijo = columna de contenido del padre)", () => {
    const lines = ["1. a", "   1. b", "      1. c", "2. d"];
    const [block] = scanBlocks(lines);
    expect(block).toBeDefined();
    const items = analyzeBlock(block as NonNullable<typeof block>);
    expect(items.map((i) => i.level)).toEqual([0, 1, 2, 0]);
  });
  it("item ordenado con 2 espacios sigue siendo HERMANO (CommonMark)", () => {
    const lines = ["1. a", "  2. b"];
    const items = analyzeBlock(scanBlocks(lines)[0] as NonNullable<ReturnType<typeof scanBlocks>[0]>);
    expect(items.map((i) => i.level)).toEqual([0, 0]);
  });
  it("separa bloques por contenido no-lista y banca blancos internos", () => {
    const lines = ["- a", "", "- b", "", "párrafo", "- c"];
    const blocks = scanBlocks(lines);
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toMatchObject({ start: 0, end: 2 });
    expect(blocks[1]).toMatchObject({ start: 5, end: 5 });
  });
  it("ignora 'items' adentro de un fence dentro del item", () => {
    const lines = ["1. a", "   ```", "   1. no soy item", "   ```", "2. b"];
    const [block] = scanBlocks(lines);
    expect(block?.items.map((i) => i.line)).toEqual([0, 4]);
  });
  it("subtree incluye descendientes y continuaciones", () => {
    const lines = ["- a", "  cont de a", "  - hijo", "    cont de hijo", "- b"];
    const items = analyzeBlock(scanBlocks(lines)[0] as NonNullable<ReturnType<typeof scanBlocks>[0]>);
    expect(items[0]?.subtreeEnd).toBe(3);
    expect(items[1]?.subtreeEnd).toBe(3);
  });
});

describe("indent (Tab)", () => {
  it("el ejemplo del owner: indentar renumera por nivel", () => {
    // 1. Lorem / 2. Lorem←Tab / 3. Ipsum / 4. Ipsum
    const lines = ["1. Lorem", "2. Lorem", "3. Ipsum", "4. Ipsum"];
    expect(tabOn(lines, 1, 1)).toEqual(["1. Lorem", "   1. Lorem", "2. Ipsum", "3. Ipsum"]);
  });
  it("indentar bajo bullet usa la columna de contenido del bullet (2)", () => {
    const lines = ["- a", "- b"];
    expect(tabOn(lines, 1, 1)).toEqual(["- a", "  - b"]);
  });
  it("no indenta el primer item de un nivel (no hay hermano anterior)", () => {
    expect(indentListEdits(["1. a", "2. b"], 0, 0, 1)).toEqual([]);
    // primer hijo tampoco (no tiene hermano en su nivel)
    expect(indentListEdits(["1. a", "   1. b", "2. c"], 1, 1, 1)).toEqual([]);
  });
  it("devuelve null fuera de una lista (Tab sigue su curso default)", () => {
    expect(indentListEdits(["un párrafo"], 0, 0, 1)).toBeNull();
    expect(indentListEdits([""], 0, 0, -1)).toBeNull();
  });
  it("arrastra el subtree (hijos + continuaciones) al indentar", () => {
    const lines = ["1. a", "2. b", "   cont de b", "   1. hijo", "3. c"];
    expect(tabOn(lines, 1, 1)).toEqual(["1. a", "   1. b", "      cont de b", "      1. hijo", "2. c"]);
  });
  it("todos anidados conservan marcador y estado checked", () => {
    const lines = ["- [ ] uno", "- [x] dos", "- [ ] tres"];
    expect(tabOn(lines, 1, 1)).toEqual(["- [ ] uno", "  - [x] dos", "- [ ] tres"]);
  });
  it("mixto: bullet se indenta bajo item numerado a su columna de contenido", () => {
    const lines = ["1. num", "- bala", "2. num"];
    const out = tabOn(lines, 1, 1);
    expect(out).toEqual(["1. num", "   - bala", "2. num"]);
  });
  it("normaliza un indent raro (2 espacios, medio nivel) al indentar", () => {
    const lines = ["1. a", "  2. b"]; // hermano ragged, herencia del Tab viejo
    expect(tabOn(lines, 1, 1)).toEqual(["1. a", "   1. b"]);
  });
  it("selección multi-línea: dos hermanos seleccionados quedan padre/hijo bajo el anterior", () => {
    const lines = ["1. a", "2. b", "3. c"];
    const edits = indentListEdits(lines, 1, 2, 1);
    const out = apply(lines, edits ?? []);
    expect(apply(out, renumberTouching(out, [1, 2]))).toEqual(["1. a", "   1. b", "   2. c"]);
  });
});

describe("outdent (Shift-Tab)", () => {
  it("desindenta al nivel del padre y renumera ambos niveles", () => {
    const lines = ["1. a", "   1. b", "   2. c", "2. d"];
    expect(tabOn(lines, 1, -1)).toEqual(["1. a", "2. b", "   1. c", "3. d"]);
  });
  it("en nivel 0 normaliza indent residual a columna 0", () => {
    const lines = ["1. a", "  2. b"];
    expect(tabOn(lines, 1, -1)).toEqual(["1. a", "2. b"]);
  });
  it("en nivel 0 sin indent es no-op (pero consume la tecla)", () => {
    expect(indentListEdits(["- a"], 0, 0, -1)).toEqual([]);
  });
  it("arrastra el subtree al desindentar", () => {
    const lines = ["1. a", "   1. b", "      1. nieto", "2. c"];
    expect(tabOn(lines, 1, -1)).toEqual(["1. a", "2. b", "   1. nieto", "3. c"]);
  });
});

describe("renumber", () => {
  it("cada nivel es secuencial; las corridas anidadas arrancan en 1", () => {
    const lines = ["1. a", "   3. b", "   7. c", "5. d"];
    const [block] = scanBlocks(lines);
    expect(apply(lines, renumberEdits(block as NonNullable<typeof block>))).toEqual([
      "1. a",
      "   1. b",
      "   2. c",
      "2. d",
    ]);
  });
  it("el nivel 0 respeta el número de arranque (start deliberado)", () => {
    const lines = ["7. a", "9. b"];
    const [block] = scanBlocks(lines);
    expect(apply(lines, renumberEdits(block as NonNullable<typeof block>))).toEqual(["7. a", "8. b"]);
  });
  it("un bullet corta la corrida (lista nueva después)", () => {
    const lines = ["1. a", "2. b", "- bala", "5. c", "6. d"];
    const [block] = scanBlocks(lines);
    // "5." arranca corrida nueva (seed) y "6." la sigue
    expect(apply(lines, renumberEdits(block as NonNullable<typeof block>))).toEqual([
      "1. a",
      "2. b",
      "- bala",
      "5. c",
      "6. d",
    ]);
  });
  it("volver a un nivel retoma su counter", () => {
    const lines = ["1. a", "   1. x", "9. b"];
    const [block] = scanBlocks(lines);
    expect(apply(lines, renumberEdits(block as NonNullable<typeof block>))).toEqual([
      "1. a",
      "   1. x",
      "2. b",
    ]);
  });
  it("renumberTouching solo toca bloques alcanzados", () => {
    const lines = ["9. a", "8. b", "", "x", "", "9. c", "8. d"];
    const out = apply(lines, renumberTouching(lines, [0]));
    expect(out).toEqual(["9. a", "10. b", "", "x", "", "9. c", "8. d"]);
  });
  it("no toca números dentro de fences", () => {
    const lines = ["1. a", "   ```", "   7. fake", "   ```", "9. b"];
    const out = apply(lines, renumberTouching(lines, [4]));
    expect(out).toEqual(["1. a", "   ```", "   7. fake", "   ```", "2. b"]);
  });
});
