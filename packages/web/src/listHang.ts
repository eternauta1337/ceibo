// Overlay CM6 para atomic-editor: cuelga (hanging-indent) las líneas de CONTINUACIÓN
// de un item de lista a la columna de contenido del item.
//
// Por qué: atomic aplica su hanging-indent (padding-left + text-indent negativo) SOLO en
// la línea que arranca con el marker (`- `, `1.`). Cuando un item está partido en varias
// líneas físicas en el markdown (hard-wrap / lazy continuation, ej. lo que escribe el agente
// o una edición a mano), las líneas de continuación no reciben decoración → quedan con
// padding 0 y caen al margen izquierdo. Acá les damos el mismo padding que su item, usando
// la misma fórmula que atomic (BASE + ALCOVE + depth*LEVEL em), para que cuelguen alineadas
// bajo el texto. Las line-decorations DEBEN venir de un StateField (no de un ViewPlugin):
// CM6 prohíbe replaces que crucen newlines desde plugins, y el padding por-línea es estado.
//
// No toca el Bug B (whitespace literal: tabs/espacios/ordenadas anidadas) — eso es la
// heurística de depth interna de atomic (issue upstream) + contenido limpio.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

// Constantes espejo de atomic-editor (inline-preview.ts, rama ListMark).
const BASE_EM = 0.8;
const ALCOVE_EM = 1.2;
const LEVEL_EM = 0.6;

const startsWithMarker = (text: string) => /^\s*([-*+]\s|\d+\.\s)/.test(text);

function build(state: EditorState): DecorationSet {
  const doc = state.doc;
  // Para cada línea física, el padding más profundo (gana el item más anidado que la contiene).
  const padByLineFrom = new Map<number, number>();
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "ListItem") return;
      const first = doc.lineAt(node.from);
      // depth desde el ÁRBOL (ListItem ancestros), igual que el patch de atomic
      // (inline-preview): la heurística vieja floor(indent/2) asumía 2 espacios por nivel
      // y desalineaba ordenadas anidadas (3 espacios por nivel) y tabs.
      let depth = 0;
      for (let p = node.node.parent; p; p = p.parent) if (p.name === "ListItem") depth++;
      const pad = BASE_EM + ALCOVE_EM + depth * LEVEL_EM;
      for (let n = first.number + 1; n <= doc.lines; n++) {
        const line = doc.line(n);
        if (line.from >= node.to) break;
        // saltear líneas vacías y las que arrancan un (sub)item — esas ya las decora atomic
        if (line.text.trim() === "" || startsWithMarker(line.text)) continue;
        const prev = padByLineFrom.get(line.from) ?? 0;
        if (pad > prev) padByLineFrom.set(line.from, pad);
      }
    },
  });
  const ranges = [...padByLineFrom.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([from, pad]) => Decoration.line({ attributes: { style: `padding-left:${pad}em` } }).range(from));
  return Decoration.set(ranges, true);
}

/** Extensión para el prop `extensions` de AtomicCodeMirrorEditor. */
export function listContinuationHang(): Extension {
  return StateField.define<DecorationSet>({
    create: build,
    update(value, tr) {
      return tr.docChanged ? build(tr.state) : value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
