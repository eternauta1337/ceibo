// Plegado de títulos estilo Obsidian para el editor atomic (CM6). Click en el chevron al
// lado de un heading (o Ctrl/Cmd-Shift-[) colapsa todo lo que cuelga de él hasta el próximo
// heading de nivel igual o mayor (o el fin del doc), dejando "…" inline. Es estado de VISTA
// (no toca el markdown): el doc sigue siendo la fuente de verdad y el autosave no se entera.
//
// Atomic no trae folding propio (no configura codeFolding/foldGutter), así que lo sumamos
// como extensión vía el prop `extensions`. Detectamos headings por el syntax tree
// (ATXHeading1..6 / SetextHeading1..2), no por regex, para no confundir un `#` dentro de un
// code fence con un título.

import { codeFolding, foldGutter, foldKeymap, foldService, syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";

/** Nivel de un heading según el nombre del nodo del syntax tree, o null si no es heading. */
function headingLevel(nodeName: string): number | null {
  const m = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(nodeName);
  return m ? Number(m[1]) : null;
}

type Heading = { from: number; to: number; level: number };

/** Todos los headings del doc, en orden de aparición. */
function collectHeadings(state: EditorState): Heading[] {
  const heads: Heading[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      const level = headingLevel(node.name);
      if (level != null) heads.push({ from: node.from, to: node.to, level });
    },
  });
  return heads;
}

// foldService: dado el rango de una línea, devolvemos qué colapsar si esa línea arranca un
// heading. El fold va desde el fin de la última línea del heading hasta justo antes de la
// línea del próximo heading de nivel <= (mismo o más alto), preservando ese salto de línea
// para que el próximo título quede visible en su propia línea (no se pega al colapsado).
const headingFoldService = foldService.of((state, lineStart, lineEnd) => {
  const heads = collectHeadings(state);
  const idx = heads.findIndex((h) => state.doc.lineAt(h.from).from === lineStart);
  if (idx === -1) return null;
  const cur = heads[idx];
  if (!cur) return null;

  // Fin de la última línea del heading (en ATX coincide con lineEnd; en setext es la línea
  // del subrayado). Es donde arranca lo plegable.
  const from = state.doc.lineAt(cur.to).to;

  // Fin de la sección: justo antes de la línea del próximo heading que cierra (nivel <=),
  // o el fin del doc.
  let to = state.doc.length;
  for (let j = idx + 1; j < heads.length; j++) {
    const next = heads[j];
    if (next && next.level <= cur.level) {
      to = state.doc.lineAt(next.from).from - 1;
      break;
    }
  }

  // lineEnd se referencia para alinear con la firma del facet aunque usemos `from` (igual en
  // ATX); sin contenido para plegar, no ofrecemos fold (evita un chevron muerto).
  void lineEnd;
  if (to <= from) return null;
  return { from, to };
});

/** Chevron del gutter: "›" que rota a apuntar abajo cuando la sección está abierta. */
function foldMarkerDOM(open: boolean): HTMLElement {
  const el = document.createElement("span");
  el.className = open ? "cm-fold-chevron" : "cm-fold-chevron cm-fold-chevron-closed";
  el.setAttribute("aria-hidden", "true");
  el.textContent = "›"; // ›
  return el;
}

/** Extensión para el prop `extensions` de AtomicCodeMirrorEditor. */
export function headingFold(): Extension {
  return [
    codeFolding({ placeholderText: "…" }), // …
    headingFoldService,
    foldGutter({ markerDOM: foldMarkerDOM }),
    keymap.of(foldKeymap),
  ];
}
