import { describe, expect, it } from "vitest";
import { type DocSlice, type LinkSyntaxNode, linkUrlFromNode } from "./linkClick.ts";

// `linkUrlFromNode` es la lógica pura detrás del click en links del editor: dado el nodo Link
// del árbol de sintaxis (lezer) + el doc, devuelve la URL destino. Acá la testeamos con nodos
// fakeados sobre offsets reales de un string (sin CM6/DOM) — modela exactamente lo que la
// extensión hace con `view.state.doc` y `node.getChildren("URL")`.

/** Doc = el string crudo; cortar por offsets es `String.slice`. */
function docOf(src: string): DocSlice {
  return { sliceString: (from, to) => src.slice(from, to) };
}
/** Arma un LinkSyntaxNode fake: rango = todo el src; los hijos URL son los rangos pasados (en el
 *  orden del documento, que es como los emite lezer: label primero, destino después). */
function linkNode(src: string, urlRanges: Array<[number, number]>): LinkSyntaxNode {
  return {
    from: 0,
    to: src.length,
    getChildren: (type) => (type === "URL" ? urlRanges.map(([from, to]) => ({ from, to })) : []),
  };
}

describe("linkUrlFromNode", () => {
  it("saca el destino de un link markdown normal `[texto](url)`", () => {
    const src = "[texto](https://example.com/x)";
    const node = linkNode(src, [[8, 29]]); // la URL del destino
    expect(linkUrlFromNode(node, docOf(src))).toBe("https://example.com/x");
  });

  it("label==URL `[https://x](https://x)`: usa el ÚLTIMO hijo URL (destino), no el label", () => {
    // GFM autolinkea el label → hay DOS hijos URL (label y destino). Acá son iguales.
    const url = "https://spf.sistarbanc.com.uy/spfdebitos/PagoMAPFRE.jsp";
    const src = `[${url}](${url})`;
    const labelFrom = 1;
    const labelTo = 1 + url.length;
    const destFrom = labelTo + 2; // tras `](`
    const destTo = destFrom + url.length;
    const node = linkNode(src, [
      [labelFrom, labelTo],
      [destFrom, destTo],
    ]);
    expect(linkUrlFromNode(node, docOf(src))).toBe(url);
  });

  it("label es una URL pero el destino es OTRO: abre el destino, no el label", () => {
    const label = "https://other.example.com/x";
    const dest = "https://real.example.com/y";
    const src = `[${label}](${dest})`;
    const destFrom = 1 + label.length + 2;
    const node = linkNode(src, [
      [1, 1 + label.length],
      [destFrom, destFrom + dest.length],
    ]);
    expect(linkUrlFromNode(node, docOf(src))).toBe(dest);
  });

  it("link wiki sin destino `[[nota|alias]]`: el texto sin alias es el destino interno", () => {
    const src = "[[nota|Mostrar]]";
    expect(linkUrlFromNode(linkNode(src, []), docOf(src))).toBe("nota");
  });

  it("link wiki simple `[nota]`: el texto entre corchetes es el destino", () => {
    const src = "[nota]";
    expect(linkUrlFromNode(linkNode(src, []), docOf(src))).toBe("nota");
  });

  it("link vacío → null (nada que abrir)", () => {
    const src = "[]";
    expect(linkUrlFromNode(linkNode(src, []), docOf(src))).toBeNull();
  });
});
