// Extensión CM6 para el atomic editor: Tab/Shift-Tab list-aware, Enter en item vacío
// que desindenta/sale, y renumeración automática por nivel de listas ordenadas. La
// lógica vive en listEdit.ts (pura, testeada); acá solo el glue con CodeMirror:
//
// - Keymap en Prec.highest (gana al `indentWithTab` genérico del keymap base de atomic
//   Y al markdownKeymap que markdown() agrega en Prec.high): Tab en un item lo indenta
//   UN nivel (hijo del hermano anterior, arrastrando su subtree); Shift-Tab lo
//   desindenta al nivel del padre. Fuera de una lista, Tab sigue su curso default.
//   Tab en el primer item de un nivel se CONSUME como no-op (antes metía espacios
//   sueltos que rompían el parseo). Enter en un item VACÍO desindenta un nivel (y en
//   nivel 0 saca el marker = sale de la lista) — el default de lang-markdown metía una
//   línea "en blanco" con espacios colgados (tight→non-tight) antes de desindentar.
//
// - transactionFilter: tras cualquier edición de usuario que toque un bloque de lista,
//   appendea (al MISMO transaction → un solo undo) los reemplazos de números necesarios
//   para que cada nivel quede secuencial. Skip de undo/redo (restaurarían un estado que
//   el filtro volvería a "corregir", rompiendo el undo) y de transacciones propias.

import {
  Annotation,
  EditorState,
  type Extension,
  Prec,
  type StateCommand,
  type Text,
  Transaction,
} from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentListEdits, type LineEdit, parseItem, renumberTouching } from "./listEdit.ts";

const autoRenumbered = Annotation.define<boolean>();

function toChanges(doc: Text, edits: LineEdit[]) {
  return edits.map((e) => {
    const l = doc.line(e.line + 1);
    return { from: l.from + e.from, to: l.from + e.to, insert: e.insert };
  });
}

/** Exportado para tests (headless via StateCommand). */
export const changeListIndent =
  (dir: 1 | -1): StateCommand =>
  ({ state, dispatch }) => {
    const sel = state.selection.main;
    const lines = state.doc.toString().split("\n");
    const fromLine = state.doc.lineAt(sel.from).number - 1;
    const toLine = state.doc.lineAt(sel.to).number - 1;
    const edits = indentListEdits(lines, fromLine, toLine, dir);
    if (edits === null) return false; // no hay item bajo la selección → Tab default
    if (edits.length > 0) {
      dispatch(
        state.update({
          changes: toChanges(state.doc, edits),
          userEvent: dir > 0 ? "input.indent" : "delete.dedent",
          scrollIntoView: true,
        }),
      );
    }
    return true; // consumida igual: el no-op (ej. primer item) es deliberado
  };

/** Enter con el cursor al final de un item VACÍO: desindenta un nivel; si ya está en
 *  nivel 0, borra el marker (sale de la lista). En cualquier otro caso devuelve false
 *  y el Enter sigue su curso (markdownKeymap continúa la lista). */
export const emptyItemEnter: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  if (sel.head !== line.to) return false;
  const p = parseItem(line.text);
  if (!p) return false;
  const afterMarker = line.text.slice(p.indent.length + p.marker.length);
  if (!/^[ \t]*(\[[ xX]\])?[ \t]*$/.test(afterMarker)) return false; // tiene contenido
  const ln = line.number - 1;
  const edits = indentListEdits(state.doc.toString().split("\n"), ln, ln, -1);
  if (edits === null) return false;
  const spec =
    edits.length > 0
      ? { changes: toChanges(state.doc, edits), userEvent: "delete.dedent" }
      : { changes: { from: line.from, to: line.to, insert: "" }, userEvent: "delete.markup" };
  dispatch(state.update({ ...spec, scrollIntoView: true }));
  return true;
};

const listKeymap = Prec.highest(
  keymap.of([
    { key: "Tab", run: changeListIndent(1), shift: changeListIndent(-1) },
    { key: "Enter", run: emptyItemEnter },
  ]),
);

const autoRenumberFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(autoRenumbered)) return tr;
  const userEvent = tr.annotation(Transaction.userEvent);
  // Solo ediciones de usuario. undo/redo quedan afuera: re-renumerar lo restaurado
  // pelearía con la history (el redo dejaría de matchear).
  if (!userEvent || userEvent.startsWith("undo") || userEvent.startsWith("redo")) return tr;
  const lines = tr.newDoc.toString().split("\n");
  const touched = new Set<number>();
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const a = tr.newDoc.lineAt(fromB).number - 1;
    const b = tr.newDoc.lineAt(toB).number - 1;
    for (let i = a; i <= b; i++) touched.add(i);
  });
  const edits = renumberTouching(lines, touched);
  if (edits.length === 0) return tr;
  return [
    tr,
    {
      changes: toChanges(tr.newDoc, edits),
      sequential: true,
      annotations: autoRenumbered.of(true),
    },
  ];
});

/** Extensión para el prop `extensions` de AtomicCodeMirrorEditor. */
export function listIndent(): Extension {
  return [listKeymap, autoRenumberFilter];
}
