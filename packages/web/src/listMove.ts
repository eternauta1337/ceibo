// Extensión CM6 para mover items de lista: Alt+ArrowUp/Down en desktop, botones ↑/↓ en
// mobile. La lógica pura vive en listEdit.ts (moveItemEdits); acá solo el glue con CM6.
//
// Desktop: keymap en Prec.highest (igual que listIndent) — Alt-ArrowUp/Down mueve el item
// bajo el cursor (con su subtree) por encima/debajo del hermano anterior/siguiente del MISMO
// nivel. Si no hay hermano en esa dirección, devuelve false (deja pasar el default de Alt+↑/↓).
//
// Mobile: ViewPlugin que inyecta un par de botones ↑/↓ en el DOM del editor cuando el cursor
// está en un item de lista. Los botones NO se muestran en desktop (pointer:fine via CSS).
// Usan `mousedown`/`touchstart` con preventDefault para no robar el foco del editor.

import type { Text } from "@codemirror/state";
import { type Extension, Prec, type StateCommand } from "@codemirror/state";
import { type EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type LineEdit, moveItem, moveItemEdits, parseItem } from "./listEdit.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function toChanges(doc: Text, edits: LineEdit[]) {
  return edits.map((e) => {
    const l = doc.line(e.line + 1);
    return { from: l.from + e.from, to: l.from + e.to, insert: e.insert };
  });
}

// ── StateCommand (lógica compartida desktop/mobile) ───────────────────────────

/** Mueve el item bajo el cursor en `dir`. Devuelve false si no aplica (sin hermano). */
export const moveListItem =
  (dir: "up" | "down"): StateCommand =>
  ({ state, dispatch }) => {
    const sel = state.selection.main;
    const curLine = state.doc.lineAt(sel.head);
    const lineNo = curLine.number - 1; // 0-based
    const lines = state.doc.toString().split("\n");
    const moved = moveItem(lines, lineNo, dir);
    if (moved === null) return false;
    if (moved.edits.length > 0) {
      // UNA sola transaction con changes + selección. OJO: dispatchar una segunda
      // transaction construida desde `tr.state` (como hacía la primera versión) revienta en
      // el EditorView real — "transaction that doesn't start from the previous state" — porque
      // su startState no es el state actual de la view. El dispatch headless de los tests no
      // validaba startState y por eso no lo agarraba (ahora sí, ver listMove.test.ts).
      //
      // El cursor SIGUE al item movido: misma columna sobre `newLine` (mapear por el
      // changeset no sirve — los edits son reemplazos por línea y el cursor quedaría en su
      // línea original, haciendo que Alt+↑ repetido rebote los items en vez de seguir).
      const changes = state.changes(toChanges(state.doc, moved.edits));
      const newDoc = changes.apply(state.doc);
      const target = newDoc.line(moved.newLine + 1);
      const head = Math.min(target.from + (sel.head - curLine.from), target.to);
      dispatch(
        state.update({
          changes,
          selection: { anchor: head },
          userEvent: dir === "up" ? "move.list.up" : "move.list.down",
          scrollIntoView: true,
        }),
      );
    }
    return true;
  };

// ── Keymap desktop ────────────────────────────────────────────────────────────

const listMoveKeymap = Prec.highest(
  keymap.of([
    { key: "Alt-ArrowUp", run: moveListItem("up") },
    { key: "Alt-ArrowDown", run: moveListItem("down") },
  ]),
);

// ── Botones mobile (ViewPlugin) ───────────────────────────────────────────────

/** Crea un botón de move mobile. */
function makeButton(label: string, dir: "up" | "down"): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = `cm-list-move-btn cm-list-move-${dir}`;
  btn.setAttribute("aria-label", dir === "up" ? "Mover item arriba" : "Mover item abajo");
  btn.setAttribute("tabindex", "-1"); // no participar en el tab-focus del editor
  btn.textContent = label;
  // preventDefault en mousedown/touchstart para NO quitar el foco del editor
  const prevent = (e: Event) => {
    e.preventDefault();
  };
  btn.addEventListener("mousedown", prevent);
  btn.addEventListener("touchstart", prevent, { passive: false });
  return btn;
}

const listMoveButtonsPlugin = ViewPlugin.fromClass(
  class {
    container: HTMLElement;
    upBtn: HTMLButtonElement;
    downBtn: HTMLButtonElement;
    visible = false;

    constructor(private view: EditorView) {
      this.upBtn = makeButton("↑", "up");
      this.downBtn = makeButton("↓", "down");

      this.container = document.createElement("div");
      this.container.className = "cm-list-move-btns";
      this.container.style.display = "none";
      this.container.appendChild(this.upBtn);
      this.container.appendChild(this.downBtn);

      // Click handler: ejecutar el comando y devolverle el foco al editor
      this.upBtn.addEventListener("click", () => {
        moveListItem("up")({ state: view.state, dispatch: view.dispatch.bind(view) });
        view.focus();
      });
      this.downBtn.addEventListener("click", () => {
        moveListItem("down")({ state: view.state, dispatch: view.dispatch.bind(view) });
        view.focus();
      });

      // Insertar los botones en el contenedor del editor (position:relative via CSS en .editor)
      view.dom.appendChild(this.container);

      this.sync();
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.sync();
      }
    }

    sync() {
      // Solo mostrar botones en dispositivos táctiles (pointer:coarse = mobile/tablet)
      const coarse = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
      const sel = this.view.state.selection.main;
      const line = this.view.state.doc.lineAt(sel.head);
      const p = parseItem(line.text);
      const show = coarse && p !== null;

      if (show !== this.visible) {
        this.container.style.display = show ? "flex" : "none";
        this.visible = show;
      }

      if (show) {
        // Actualizar estado disabled de los botones
        const lines = this.view.state.doc.toString().split("\n");
        const lineNo = line.number - 1;
        this.upBtn.disabled = moveItemEdits(lines, lineNo, "up") === null;
        this.downBtn.disabled = moveItemEdits(lines, lineNo, "down") === null;

        // Posicionar los botones junto a la línea activa (esquina derecha)
        const coords = this.view.coordsAtPos(sel.head);
        if (coords) {
          const editorRect = this.view.dom.getBoundingClientRect();
          const top = coords.top - editorRect.top;
          this.container.style.top = `${Math.round(top)}px`;
        }
      }
    }

    destroy() {
      this.container.remove();
    }
  },
);

// ── Export ────────────────────────────────────────────────────────────────────

/** Extensión para el prop `extensions` de AtomicCodeMirrorEditor. */
export function listMove(): Extension {
  return [listMoveKeymap, listMoveButtonsPlugin];
}
