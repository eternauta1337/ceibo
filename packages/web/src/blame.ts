// Blame por línea (etapa 2 del "quién tocó qué"): decoraciones CM6 que pintan una franja
// de color en el borde izquierdo de cada línea según QUIÉN la escribió (color estable por
// handle) + el AVATAR del autor al inicio de cada tramo contiguo (foto si subió una,
// inicial en su color si no). El hover sobre una línea (o el tap en el avatar, en touch)
// abre un tooltip PROPIO con toda la info: nombre, handle, fecha y cómo se originó la
// edición (vía web / por ceibo). NO usamos el `title` nativo: Chrome no lo muestra de
// forma confiable sobre el contenteditable del editor (y en touch no existe).
//
// Identidades visuales:
//  - autor real (`handle`)     → color estable de PALETTE + avatar/inicial.
//  - "ceibo (IA)"              → color ember de marca + avatar-orbe propio. Solo en wikis
//                                PERSONALES (shared=false), para los commits con source
//                                'agent': ahí la pregunta es "¿esto lo escribí yo o ceibo?".
//  - histórico                 → gris, sin avatar. Cubre commits del bot pre-#296 y, en
//                                personales, shas anteriores al registro de sources (la
//                                distinción humano/IA no es reconstruible).
//
// Los datos vienen de GET /api/file/blame; acá no hay fetch: el Editor inyecta los ranges
// vía un CONTROLLER (ver blameController) porque el wrapper AtomicCodeMirrorEditor no
// expone el EditorView — el ViewPlugin del controller registra la vista al montar y el
// Editor le despacha los datos cuando llegan.
//
// LIMITACIÓN (documentada): el blame es una foto del HEAD al activarlo. Si editás con el
// blame prendido, las líneas tocadas PIERDEN su franja (quedan "sin datos") hasta
// desactivar/reactivar — preferible a mostrar autoría stale sobre texto nuevo. Las líneas
// no tocadas se remapean solas con el documento (mapping de decorations de CM6).

import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
// El avatar del blame REUSA el mecanismo de los member chips del explorer (mismas clases
// CSS, misma URL de foto, mismo fallback a iniciales grises) — ver memberFace.ts.
import "./memberChips.css";
import { avatarSrc, chipMix, initials } from "./memberFace.ts";

/** Un rango de blame como lo manda el server (líneas 1-based, inclusive, del ARCHIVO).
 *  `handle` null = histórico (bot del App / email no-canónico). `source`: cómo se originó
 *  el commit — 'web' = edición humana en la web, 'agent' = el agente (chat/REM), null =
 *  anterior al registro de sources (desconocido). `hasAvatar`: si el autor subió foto de
 *  perfil (mismo gating que los member chips del explorer: sin foto no se pega al GET). */
export interface BlameRangeWire {
  start: number;
  end: number;
  handle: string | null;
  name: string | null;
  date: string;
  sha: string;
  source?: "web" | "agent" | null;
  hasAvatar?: boolean;
}

/** Datos que el Editor inyecta: los ranges + el offset de líneas del prefijo oculto
 *  (el H1 redundante que splitTitle separa del cuerpo — el editor no lo muestra, así que
 *  la línea N del editor es la línea N+offset del archivo) + si la wiki es compartida
 *  (false = personal: los commits del agente se pintan como "ceibo (IA)") + el handle del
 *  viewer (para marcar "(vos)" en el tooltip). */
export interface BlameData {
  ranges: BlameRangeWire[];
  offset: number;
  shared: boolean;
  selfHandle?: string;
}

// Paleta de franjas: colores distinguibles entre sí y visibles sobre los temas claro y
// oscuro (saturación media, luminancia intermedia). El color de un handle es ESTABLE
// (hash del handle → índice), así "anni" es siempre el mismo verde en todas las notas.
const PALETTE = [
  "#d9534f", // rojo
  "#e0823c", // naranja
  "#b8a000", // mostaza
  "#5fae3f", // verde
  "#2fa39a", // teal
  "#3f87d6", // azul
  "#7a6fe0", // violeta
  "#b95fc2", // magenta
  "#d65f96", // rosa
  "#7d9655", // oliva
] as const;

/** Gris de las líneas históricas (sin autor atribuible). */
export const BLAME_HISTORIC_COLOR = "#9aa0a6";

/** Color de la identidad "ceibo (IA)": el ember de marca (la var CSS sigue el tema). */
export const BLAME_AI_COLOR = "var(--ember)";

/** Hash djb2 — barato y estable (no criptográfico; sólo elige un color). */
function hashHandle(handle: string): number {
  let h = 5381;
  for (let i = 0; i < handle.length; i++) h = (h * 33) ^ handle.charCodeAt(i);
  return h >>> 0;
}

/** Color ESTABLE de la franja para un handle (mismo handle → mismo color, siempre). */
export function blameColor(handle: string): string {
  return PALETTE[hashHandle(handle) % PALETTE.length] as string;
}

/** Identidad VISUAL de un range: quién se muestra como autor de esas líneas. */
export type BlameIdentity =
  | { kind: "user"; handle: string; name: string; color: string; hasAvatar: boolean }
  | { kind: "ai"; color: string }
  | { kind: "historic"; color: string };

/** Resuelve la identidad visual de un range según el modo de la wiki. En PERSONALES
 *  (shared=false) los commits del agente son "ceibo (IA)" y los de source desconocido van
 *  a histórico (no se puede saber si los escribió el humano o la IA: el git author es el
 *  mismo). En COMPARTIDAS el autor manda (la IA de cada uno commitea con su identidad);
 *  el source se muestra igual en el tooltip. */
export function rangeIdentity(r: BlameRangeWire, shared: boolean): BlameIdentity {
  if (!shared && r.source === "agent") return { kind: "ai", color: BLAME_AI_COLOR };
  if (r.handle && (shared || r.source === "web")) {
    return {
      kind: "user",
      handle: r.handle,
      name: r.name ?? r.handle,
      color: blameColor(r.handle),
      hasAvatar: r.hasAvatar ?? false,
    };
  }
  return { kind: "historic", color: BLAME_HISTORIC_COLOR };
}

/** Clave de agrupación de una identidad: tramos contiguos con la misma clave comparten
 *  avatar (uno al inicio del tramo, no uno por línea). */
export function identityKey(id: BlameIdentity): string {
  return id.kind === "user" ? `u:${id.handle}` : id.kind;
}

/** Líneas del tooltip (primera = quién; el resto, metadata). Pura, testeable. */
export function blameTipLines(r: BlameRangeWire, shared: boolean, selfHandle?: string): string[] {
  const id = rangeIdentity(r, shared);
  const day = r.date.slice(0, 10); // ISO → YYYY-MM-DD alcanza (no formateamos locale)
  if (id.kind === "ai") return ["ceibo (IA)", day];
  if (id.kind === "historic") return ["histórico", "anterior al registro de autoría"];
  const who = id.handle === selfHandle ? `${id.name} (vos)` : id.name;
  const via = r.source === "web" ? "vía web" : r.source === "agent" ? "por ceibo (IA)" : "";
  return [who, `@${id.handle}`, via ? `${day} · ${via}` : day];
}

/** Mapea los ranges (líneas del ARCHIVO) a líneas del EDITOR (descontando `offset` líneas
 *  del prefijo oculto), acotado a `lineCount`. Devuelve Map línea-editor → range. Pura
 *  (testeable sin CM). */
export function lineBlame(
  ranges: BlameRangeWire[],
  offset: number,
  lineCount: number,
): Map<number, BlameRangeWire> {
  const out = new Map<number, BlameRangeWire>();
  for (const r of ranges) {
    for (let file = r.start; file <= r.end; file++) {
      const line = file - offset;
      if (line >= 1 && line <= lineCount) out.set(line, r);
    }
  }
  return out;
}

/** Líneas del editor que llevan avatar: el INICIO de cada tramo contiguo de la misma
 *  identidad (no uno por línea; histórico no lleva). Pura (testeable sin CM). */
export function avatarAnchors(byLine: Map<number, BlameRangeWire>, shared: boolean): number[] {
  const lines = [...byLine.keys()].sort((a, b) => a - b);
  const out: number[] = [];
  let prevKey: string | null = null;
  let prevLine = Number.NEGATIVE_INFINITY;
  for (const line of lines) {
    const r = byLine.get(line) as BlameRangeWire;
    const id = rangeIdentity(r, shared);
    const key = identityKey(id);
    if (id.kind !== "historic" && (key !== prevKey || line !== prevLine + 1)) out.push(line);
    prevKey = key;
    prevLine = line;
  }
  return out;
}

const setBlame = StateEffect.define<BlameData | null>();

/** Avatar al inicio de un tramo: el MISMO chip que los member chips del explorer
 *  (memberFace.ts + memberChips.css): foto si `hasAvatar` (fallback a iniciales si el GET
 *  falla), iniciales grises si no. La IA lleva su chip propio (el orbe ember de ceibo).
 *  Widget side -1 al from de la línea; el wrapper .cm-blame-avatar solo posiciona. */
class AvatarWidget extends WidgetType {
  constructor(readonly identity: Exclude<BlameIdentity, { kind: "historic" }>) {
    super();
  }
  override eq(other: AvatarWidget): boolean {
    return identityKey(other.identity) === identityKey(this.identity);
  }
  toDOM(): HTMLElement {
    const id = this.identity;
    const el = document.createElement("span");
    el.className = "cm-blame-avatar";
    el.setAttribute("aria-hidden", "true");
    if (id.kind === "ai") {
      const orb = document.createElement("span");
      orb.className = "exp-member-chip cm-blame-chip-ai";
      el.appendChild(orb);
      return el;
    }
    const fallback = () => {
      const chip = document.createElement("span");
      chip.className = "exp-member-chip";
      chip.style.setProperty("--chip-mix", chipMix(id.handle));
      chip.textContent = initials(id.name);
      el.replaceChildren(chip);
    };
    if (id.hasAvatar) {
      const img = document.createElement("img");
      img.className = "exp-member-chip exp-member-photo";
      img.alt = "";
      img.loading = "lazy";
      img.src = avatarSrc.of(id.handle);
      img.onerror = fallback; // foto rota / 404 → iniciales (igual que MemberFace)
      el.appendChild(img);
    } else {
      fallback();
    }
    return el;
  }
  override ignoreEvent(): boolean {
    // CM no procesa el evento (no mueve el cursor / no abre teclado en touch); el DOM event
    // burbujea igual hasta el listener del tooltip en view.dom.
    return true;
  }
}

// Una Decoration.line por range (los attrs del tooltip varían por range, no por autor),
// reusada entre las líneas del range (no se crean miles de objetos idénticos).
function lineDeco(r: BlameRangeWire, data: BlameData): Decoration {
  const id = rangeIdentity(r, data.shared);
  const cls =
    id.kind === "historic"
      ? "cm-blame cm-blame-historic"
      : id.kind === "ai"
        ? "cm-blame cm-blame-ai"
        : "cm-blame";
  return Decoration.line({
    class: cls,
    attributes: {
      style: `--blame-color: ${id.color}`,
      // El tooltip propio lee estas líneas ya compuestas. Viajan EN el DOM de la línea a
      // propósito: sobreviven al remapping de decorations cuando el doc cambia.
      "data-blame-tip": blameTipLines(r, data.shared, data.selfHandle).join("\n"),
    },
  });
}

function buildDecorations(
  data: BlameData,
  doc: { lines: number; line(n: number): { from: number } },
): DecorationSet {
  const byLine = lineBlame(data.ranges, data.offset, doc.lines);
  const decos: { from: number; deco: Decoration }[] = [];
  const decoByRange = new Map<BlameRangeWire, Decoration>();
  for (const [line, r] of byLine) {
    let deco = decoByRange.get(r);
    if (!deco) {
      deco = lineDeco(r, data);
      decoByRange.set(r, deco);
    }
    decos.push({ from: doc.line(line).from, deco });
  }
  for (const line of avatarAnchors(byLine, data.shared)) {
    const r = byLine.get(line) as BlameRangeWire;
    const id = rangeIdentity(r, data.shared);
    if (id.kind === "historic") continue;
    decos.push({
      from: doc.line(line).from,
      deco: Decoration.widget({ widget: new AvatarWidget(id), side: -1 }),
    });
  }
  // `Decoration.set(…, true)` ordena por posición/startSide (línea y widget comparten from).
  return Decoration.set(
    decos.map((d) => d.deco.range(d.from)),
    true,
  );
}

const blameField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco;
    if (tr.docChanged) {
      // Remapear las decoraciones al doc nuevo y BORRAR las de las líneas tocadas: el blame
      // ya no describe ese texto (ver limitación arriba). filter por rango de línea nueva.
      next = next.map(tr.changes);
      const drop: { from: number; to: number }[] = [];
      tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        const from = tr.newDoc.lineAt(Math.min(fromB, tr.newDoc.length)).from;
        const to = tr.newDoc.lineAt(Math.min(toB, tr.newDoc.length)).to;
        drop.push({ from, to });
      });
      for (const d of drop) {
        next = next.update({ filterFrom: d.from, filterTo: d.to, filter: () => false });
      }
    }
    for (const e of tr.effects) {
      if (e.is(setBlame)) next = e.value ? buildDecorations(e.value, tr.newDoc) : Decoration.none;
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ── Tooltip propio ────────────────────────────────────────────────────────────────
// Un solo div reutilizado (singleton del módulo), position:fixed sobre el body. Desktop:
// hover sobre cualquier línea blameada. Touch: tap en el avatar (toggle). Se esconde al
// salir de la línea, scrollear, editar (la línea pierde la decoración) o apagar el blame.

let tipEl: HTMLDivElement | null = null;
let tipLine: Element | null = null; // la .cm-line que ancla el tooltip visible

function hideTip(): void {
  if (tipEl) tipEl.style.display = "none";
  tipLine = null;
}

function showTip(line: Element, anchor: Element): void {
  const text = line.getAttribute("data-blame-tip");
  if (!text) return;
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "blame-tip";
    tipEl.setAttribute("role", "tooltip");
    document.body.appendChild(tipEl);
  }
  tipEl.replaceChildren(
    ...text.split("\n").map((t, i) => {
      const row = document.createElement("div");
      row.className = i === 0 ? "blame-tip-who" : "blame-tip-meta";
      row.textContent = t;
      return row;
    }),
  );
  // Mostrar fuera de vista para medir, después posicionar pegado al ancla (arriba si entra,
  // abajo si no), clampeado al viewport.
  tipEl.style.display = "block";
  tipEl.style.left = "0px";
  tipEl.style.top = "-9999px";
  const rect = anchor.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
  const top = rect.top - h - 6 >= 4 ? rect.top - h - 6 : rect.bottom + 6;
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
  tipLine = line;
}

/** Listeners del tooltip sobre UNA vista. Devuelve el cleanup. */
function attachTip(view: EditorView): () => void {
  const lineOf = (t: EventTarget | null): Element | null =>
    t instanceof Element ? t.closest(".cm-line.cm-blame") : null;
  const over = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return; // touch va por tap en el avatar
    const line = lineOf(e.target);
    if (line && line !== tipLine) showTip(line, line.querySelector(".cm-blame-avatar") ?? line);
    else if (!line) hideTip();
  };
  const out = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    if (lineOf(e.relatedTarget) !== tipLine) hideTip();
  };
  const click = (e: MouseEvent) => {
    const avatar = e.target instanceof Element ? e.target.closest(".cm-blame-avatar") : null;
    if (!avatar) {
      hideTip();
      return;
    }
    const line = avatar.closest(".cm-line.cm-blame");
    if (!line || line === tipLine) hideTip();
    else showTip(line, avatar);
  };
  const scroll = () => hideTip();
  view.dom.addEventListener("pointerover", over);
  view.dom.addEventListener("pointerout", out);
  view.dom.addEventListener("click", click);
  view.scrollDOM.addEventListener("scroll", scroll, { passive: true });
  return () => {
    view.dom.removeEventListener("pointerover", over);
    view.dom.removeEventListener("pointerout", out);
    view.dom.removeEventListener("click", click);
    view.scrollDOM.removeEventListener("scroll", scroll);
    hideTip();
  };
}

export interface BlameController {
  extension: Extension;
  /** Inyecta (o limpia, con null) los datos de blame en las vistas montadas con `extension`. */
  set(data: BlameData | null): void;
}

/** Crea el par {extensión CM6, setter} para UNA instancia de editor. El wrapper de atomic
 *  no expone el EditorView, así que el ViewPlugin registra la vista al montar y `set`
 *  despacha el efecto sobre las vistas vivas (y re-aplica el último dato a vistas que
 *  monten después, p.ej. si el editor remonta por un refresh externo). */
export function blameController(): BlameController {
  const views = new Set<EditorView>();
  let last: BlameData | null = null;
  const registrar = ViewPlugin.define((view) => {
    views.add(view);
    const detachTip = attachTip(view);
    if (last) {
      const data = last;
      // No se puede despachar durante la construcción de la vista → microtask.
      queueMicrotask(() => {
        if (views.has(view)) view.dispatch({ effects: setBlame.of(data) });
      });
    }
    return {
      destroy() {
        detachTip();
        views.delete(view);
      },
    };
  });
  return {
    extension: [blameField, registrar],
    set(data) {
      last = data;
      if (!data) hideTip();
      for (const view of views) view.dispatch({ effects: setBlame.of(data) });
    },
  };
}
