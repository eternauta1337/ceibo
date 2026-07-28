// Drag handle (⠿) para reordenar items de lista con mouse (v2 del reordenamiento —
// DESKTOP only; en touch quedan los botones ↑/↓ de listMove.ts). La lógica pura vive en
// listEdit.ts (dragTargets / moveItemTo); acá solo el glue con CM6.
//
// Approach: OVERLAY, no gutter. El handle y el indicador de drop son DIVs absolutos
// colgados de view.dom (.cm-editor, position:relative) — FUERA del contenteditable, así
// no pelean con la selección de texto. Se descartó el gutter de CM6 porque:
//   1. ya hay un fold-gutter de 1.6rem cuyo ancho está ACOPLADO al padding-left del
//      título (.editor-title compensa exactamente 1.6rem); otro gutter corre el cuerpo
//      y desalinea título/cuerpo en prod,
//   2. un gutter es una columna fija al margen: el handle quedaría lejos del marker de
//      los items anidados (el pedido es "a la izquierda del marcador"),
//   3. el hover-por-línea (mostrar el handle al pasar por el TEXTO del item, estilo
//      Notion) igual necesita un mousemove en JS — el gutter no lo regala.
//
// Mecánica del drag (una vista, cero transactions hasta el drop):
//   - mousemove sobre el editor (pointer:fine only) → si la línea bajo el puntero es un
//     item de lista movible, el handle aparece a la izquierda de su marker.
//   - mousedown en el handle (preventDefault → no roba foco ni arranca selección) →
//     snapshot del doc + dragTargets. Los targets/coords se recalculan por mousemove.
//   - durante el drag: el subtree arrastrado se atenúa (StateField de line-decorations,
//     efectos dragDim — un ViewPlugin no puede "empujar" decorations fuera de update) y
//     el gap válido más cercano al puntero muestra la línea indicadora, arrancando en la
//     columna del nivel destino.
//   - drop → UNA sola transaction (lección de v1: jamás dispatchar una transaction
//     derivada de un state intermedio): changes + selección siguiendo al item +
//     userEvent "move.list.drag"; la renumeración la appendea el autoRenumberFilter al
//     MISMO transaction → un solo undo.
//   - Escape, soltar fuera del editor, o cualquier cambio del doc → cancela.

import { type Extension, type StateCommand, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type DropTarget, dragTargets, type LineEdit, moveItemTo, parseItem } from "./listEdit.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function toChanges(doc: Text, edits: LineEdit[]) {
  return edits.map((e) => {
    const l = doc.line(e.line + 1);
    return { from: l.from + e.from, to: l.from + e.to, insert: e.insert };
  });
}

// ── StateCommand del drop (testeable headless con dispatch que valida startState) ──

/** Suelta el item de `fromLine` en el gap `targetLine` (ver moveItemTo). false si no
 *  aplica o si el drop es un no-op. El cursor queda al final de la línea-marker movida. */
export const dropListItem =
  (fromLine: number, targetLine: number): StateCommand =>
  ({ state, dispatch }) => {
    const lines = state.doc.toString().split("\n");
    const moved = moveItemTo(lines, fromLine, targetLine);
    if (moved === null || moved.edits.length === 0) return false;
    const changes = state.changes(toChanges(state.doc, moved.edits));
    const newDoc = changes.apply(state.doc);
    const target = newDoc.line(moved.newLine + 1);
    dispatch(
      state.update({
        changes,
        selection: { anchor: target.to },
        userEvent: "move.list.drag",
        scrollIntoView: true,
      }),
    );
    return true;
  };

// ── Dim del subtree arrastrado (StateField + efectos) ─────────────────────────

/** from/to = rango de líneas 0-based a atenuar; null = limpiar. */
const dragDim = StateEffect.define<{ from: number; to: number } | null>();

const dimLine = Decoration.line({ class: "cm-drag-dim" });

const dimField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    if (tr.docChanged) value = Decoration.none; // cualquier edición cancela el drag
    for (const e of tr.effects) {
      if (!e.is(dragDim)) continue;
      if (e.value === null) {
        value = Decoration.none;
      } else {
        const ranges = [];
        for (let ln = e.value.from; ln <= e.value.to && ln < tr.state.doc.lines; ln++) {
          ranges.push(dimLine.range(tr.state.doc.line(ln + 1).from));
        }
        value = Decoration.set(ranges);
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ── ViewPlugin: handle + indicador + sesión de drag ───────────────────────────

const HANDLE_GAP = 4; // px entre el handle y el marker
const DRAG_SLOP = 4; // px de movimiento antes de considerar que ES un drag
const OUTSIDE_MARGIN = 32; // px de tolerancia alrededor del editor antes de "estás afuera"

type DragSession = {
  fromLine: number;
  subtreeEnd: number;
  targets: DropTarget[];
  startDoc: Text;
  startY: number;
  moved: boolean;
  active: DropTarget | null;
};

class DragHandlePlugin {
  handle: HTMLDivElement;
  indicator: HTMLDivElement;
  hoverLine = -1; // línea 0-based bajo el handle; -1 = oculto
  drag: DragSession | null = null;

  constructor(readonly view: EditorView) {
    this.handle = document.createElement("div");
    this.handle.className = "cm-drag-handle";
    this.handle.textContent = "⠿";
    this.handle.style.display = "none";
    this.handle.setAttribute("aria-hidden", "true");
    this.indicator = document.createElement("div");
    this.indicator.className = "cm-drop-indicator";
    this.indicator.style.display = "none";
    view.dom.appendChild(this.handle);
    view.dom.appendChild(this.indicator);
    view.dom.addEventListener("mousemove", this.onHover);
    view.dom.addEventListener("mouseleave", this.onLeave);
    this.handle.addEventListener("mousedown", this.onHandleDown);
  }

  // ── hover: mostrar/ocultar el handle ──
  onHover = (e: MouseEvent) => {
    if (this.drag) return;
    if (typeof window !== "undefined" && !window.matchMedia("(pointer: fine)").matches) return;
    const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
    const ln = this.view.state.doc.lineAt(pos).number - 1;
    if (ln !== this.hoverLine) this.showHandle(ln);
  };

  onLeave = () => {
    if (!this.drag) this.hideHandle();
  };

  showHandle(ln: number) {
    const doc = this.view.state.doc;
    const line = doc.line(ln + 1);
    const p = parseItem(line.text);
    // Solo items de lista con algún lugar real adónde ir (dragTargets también descarta
    // "items" dentro de code fences, que parseItem solo no distingue).
    const model = p ? dragTargets(doc.toString().split("\n"), ln) : null;
    if (!p || !model?.targets.some((t) => !t.noop)) {
      this.hideHandle();
      return;
    }
    const coords = this.view.coordsAtPos(line.from + p.indent.length);
    if (!coords) {
      this.hideHandle();
      return;
    }
    const box = this.view.dom.getBoundingClientRect();
    this.handle.style.display = "flex";
    const w = this.handle.offsetWidth || 16;
    this.handle.style.left = `${Math.round(coords.left - box.left - w - HANDLE_GAP)}px`;
    this.handle.style.top = `${Math.round((coords.top + coords.bottom) / 2 - box.top)}px`;
    this.hoverLine = ln;
  }

  hideHandle() {
    this.handle.style.display = "none";
    this.hoverLine = -1;
  }

  // ── drag ──
  onHandleDown = (e: MouseEvent) => {
    if (e.button !== 0 || this.drag || this.hoverLine < 0) return;
    e.preventDefault(); // no robar el foco del editor ni arrancar una selección
    e.stopPropagation();
    const model = dragTargets(this.view.state.doc.toString().split("\n"), this.hoverLine);
    if (!model) return;
    if (!model.targets.some((t) => !t.noop)) return;
    this.drag = {
      fromLine: model.fromLine,
      subtreeEnd: model.subtreeEnd,
      targets: model.targets,
      startDoc: this.view.state.doc,
      startY: e.clientY,
      moved: false,
      active: null,
    };
    window.addEventListener("mousemove", this.onDragMove, true);
    window.addEventListener("mouseup", this.onDrop, true);
    window.addEventListener("keydown", this.onKey, true);
    document.body.style.cursor = "grabbing";
    this.view.dispatch({ effects: dragDim.of({ from: model.fromLine, to: model.subtreeEnd }) });
  };

  onDragMove = (e: MouseEvent) => {
    const d = this.drag;
    if (!d) return;
    e.preventDefault();
    if (Math.abs(e.clientY - d.startY) > DRAG_SLOP) d.moved = true;
    if (!d.moved) return;
    const rect = this.view.dom.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left - OUTSIDE_MARGIN &&
      e.clientX <= rect.right + OUTSIDE_MARGIN &&
      e.clientY >= rect.top - OUTSIDE_MARGIN &&
      e.clientY <= rect.bottom + OUTSIDE_MARGIN;
    if (!inside || this.view.state.doc !== d.startDoc) {
      d.active = null;
      this.indicator.style.display = "none";
      return;
    }
    // gap válido más cercano al puntero (por Y)
    let best: DropTarget | null = null;
    let bestY = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const t of d.targets) {
      const y = this.gapY(t.line);
      if (y === null) continue;
      const dist = Math.abs(e.clientY - y);
      if (dist < bestDist) {
        best = t;
        bestY = y;
        bestDist = dist;
      }
    }
    d.active = best;
    if (!best) {
      this.indicator.style.display = "none";
      return;
    }
    const left = this.targetX(best);
    const right = this.view.contentDOM.getBoundingClientRect().right;
    this.indicator.style.display = "block";
    this.indicator.style.top = `${Math.round(bestY - rect.top)}px`;
    this.indicator.style.left = `${Math.round(left - rect.left)}px`;
    this.indicator.style.width = `${Math.max(0, Math.round(right - left))}px`;
  };

  /** Y (en pantalla) del gap "antes de la línea L" (L == doc.lines → después de la última). */
  gapY(L: number): number | null {
    const doc = this.view.state.doc;
    try {
      if (L >= doc.lines) {
        const blk = this.view.lineBlockAt(doc.line(doc.lines).from);
        return blk.bottom + this.view.documentTop;
      }
      const blk = this.view.lineBlockAt(doc.line(L + 1).from);
      return blk.top + this.view.documentTop;
    } catch {
      return null;
    }
  }

  /** X (en pantalla) del marker del item de referencia del target (= columna destino). */
  targetX(t: DropTarget): number {
    const doc = this.view.state.doc;
    const line = doc.line(t.refLine + 1);
    const p = parseItem(line.text);
    const coords = this.view.coordsAtPos(line.from + (p?.indent.length ?? 0));
    return coords ? coords.left : this.view.contentDOM.getBoundingClientRect().left;
  }

  onDrop = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const d = this.drag;
    if (!d) return;
    const ok = d.moved && d.active !== null && !d.active.noop && this.view.state.doc === d.startDoc;
    const fromLine = d.fromLine;
    const target = d.active;
    this.endDrag();
    if (ok && target) {
      dropListItem(
        fromLine,
        target.line,
      )({
        state: this.view.state,
        dispatch: this.view.dispatch.bind(this.view),
      });
      this.view.focus();
    }
  };

  onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.drag) {
      e.preventDefault();
      e.stopPropagation();
      this.endDrag();
    }
  };

  endDrag(clearDim = true) {
    if (!this.drag) return;
    this.drag = null;
    window.removeEventListener("mousemove", this.onDragMove, true);
    window.removeEventListener("mouseup", this.onDrop, true);
    window.removeEventListener("keydown", this.onKey, true);
    document.body.style.cursor = "";
    this.indicator.style.display = "none";
    this.hideHandle();
    // Fuera del ciclo de update de CM6 (no se puede dispatchar desde update()).
    if (clearDim) this.view.dispatch({ effects: dragDim.of(null) });
  }

  update(u: ViewUpdate) {
    if (u.docChanged) {
      // el dimField ya se limpió solo (docChanged) → no dispatchar desde update()
      if (this.drag) this.endDrag(false);
      this.hideHandle(); // posición potencialmente stale; el próximo mousemove lo repone
    }
  }

  destroy() {
    this.endDrag(false);
    this.view.dom.removeEventListener("mousemove", this.onHover);
    this.view.dom.removeEventListener("mouseleave", this.onLeave);
    this.handle.remove();
    this.indicator.remove();
  }
}

// ── theme (baseTheme: viaja con la extensión → funciona también en listlab) ───

const dragTheme = EditorView.baseTheme({
  ".cm-drag-handle": {
    position: "absolute",
    zIndex: "20",
    width: "1.05em",
    height: "1.3em",
    transform: "translateY(-50%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "4px",
    cursor: "grab",
    color: "currentColor",
    opacity: "0.32",
    fontSize: "0.8em",
    lineHeight: "1",
    userSelect: "none",
    WebkitUserSelect: "none",
  },
  ".cm-drag-handle:hover": {
    opacity: "0.85",
    backgroundColor: "rgba(128, 128, 128, 0.18)",
  },
  ".cm-drag-handle:active": { cursor: "grabbing" },
  ".cm-drop-indicator": {
    position: "absolute",
    zIndex: "19",
    height: "2px",
    marginTop: "-1px", // centrar la línea de 2px sobre el borde del gap
    borderRadius: "1px",
    backgroundColor: "var(--accent, #5b8def)",
    pointerEvents: "none",
  },
  ".cm-drag-dim": { opacity: "0.35" },
});

// ── Export ────────────────────────────────────────────────────────────────────

/** Extensión para el prop `extensions` de AtomicCodeMirrorEditor. */
export function listDrag(): Extension {
  return [dimField, ViewPlugin.fromClass(DragHandlePlugin), dragTheme];
}
