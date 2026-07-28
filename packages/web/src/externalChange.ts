// Cambios EXTERNOS sobre la nota abierta, sin remontar el editor (Fase C de "rock
// solid", síntoma (b) del análisis de conflictos): cuando el canal trae contenido nuevo
// de la MISMA nota (commit del agente/REM, otra pestaña, revalidación SWR), el editor ya
// NO se desmonta — decide qué hacer con la prop nueva:
//
//   - buffer LIMPIO  → el cambio entra como una transacción CM6 (diff doc actual ↔ nuevo
//                      → dispatch con changes). CM6 remapea cursor/selección/folds solo y
//                      el scroll no se toca: nada salta bajo el cursor.
//   - buffer DIRTY   → NO se toca el texto del usuario: banner no-modal "hay una versión
//                      más nueva", que deja aplicar (con confirmación: descarta lo local)
//                      o postergar. El merge fino es terreno de la Fase B.
//
// Acá vive la parte PURA (decisión + diff, testeable sin DOM) y el tap al EditorView.
// El wrapper AtomicCodeMirrorEditor no expone el EditorView en su handle (solo
// focus/undo/search/getMarkdown), así que usamos el mismo patrón que blameController:
// un ViewPlugin registra la vista al montar y la entrega para despachar desde afuera.

import { type Extension, Transaction } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";

/** Qué hacer con el (content, sha) que llegó por props al editor montado.
 *  - "ignore": sha que este editor produjo/adoptó (eco de un save propio, o un edge stale
 *    del CDN sirviendo un save nuestro viejo) → nada; ni siquiera adoptar el sha (un eco
 *    viejo envenenaría el baseSha → 409 fantasma).
 *  - "adopt": el contenido no es novedad (== buffer, o == lo último que el canal empujó:
 *    rename/move propio donde solo cambió el sha) → adoptar el sha como baseSha y seguir.
 *  - "apply": contenido nuevo con buffer limpio → transacción CM6.
 *  - "defer": contenido nuevo con tipeo sin guardar → banner, decide el usuario. */
export type ExternalDecision = "ignore" | "adopt" | "apply" | "defer";

export function decideExternal(opts: {
  /** Contenido COMPLETO (con el H1 oculto) que llegó de afuera. */
  incomingContent: string;
  incomingSha?: string;
  /** Lo último que el canal había empujado (la prop anterior): si el contenido no se
   *  movió, el cambio es solo de metadata (sha por rename/move) → adoptar. */
  prevIncomingContent: string;
  /** Contenido COMPLETO del buffer actual (prefijo oculto + lo tipeado). */
  bufferContent: string;
  /** Hay ediciones sin guardar. */
  dirty: boolean;
  /** Shas que este editor produjo o adoptó (saves, renames, applies previos). */
  knownShas: ReadonlySet<string>;
}): ExternalDecision {
  const { incomingContent, incomingSha, prevIncomingContent, bufferContent, dirty, knownShas } = opts;
  if (incomingSha && knownShas.has(incomingSha)) return "ignore";
  if (incomingContent === bufferContent) return "adopt";
  if (incomingContent === prevIncomingContent) return "adopt";
  return dirty ? "defer" : "apply";
}

/** Un reemplazo puntual para `dispatch({changes})`: [from, to) del doc viejo → insert. */
export interface Hunk {
  from: number;
  to: number;
  insert: string;
}

// Tope de celdas de la tabla LCS (líneas viejas × nuevas tras pelar prefijo/sufijo
// comunes). Por encima, un solo hunk con todo el medio: correcto igual, solo menos fino
// (folds/cursor dentro de esa región no sobreviven). Notas reales no llegan ni cerca.
const MAX_LCS_CELLS = 250_000;

/** Líneas CON su terminador `\n` (la última puede no tenerlo). Igualdad de líneas incluye
 *  el salto → los offsets son sumas directas y los hunks no remiendan newlines a mano. */
function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      if (start < text.length) out.push(text.slice(start));
      return out;
    }
    out.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
}

/** Afina un hunk pelando los caracteres comunes en los bordes (p.ej. cambió una palabra
 *  dentro de una línea → el hunk queda solo sobre esa palabra: el cursor en la misma
 *  línea, fuera del tramo, ni se entera). */
function trimHunk(oldText: string, h: Hunk): Hunk {
  const old = oldText.slice(h.from, h.to);
  const ins = h.insert;
  const max = Math.min(old.length, ins.length);
  let pre = 0;
  while (pre < max && old[pre] === ins[pre]) pre++;
  let suf = 0;
  while (suf < max - pre && old[old.length - 1 - suf] === ins[ins.length - 1 - suf]) suf++;
  return { from: h.from + pre, to: h.to - suf, insert: ins.slice(pre, ins.length - suf) };
}

/** Diff por líneas entre dos textos → hunks mínimos para `dispatch({changes})`. Prefijo y
 *  sufijo comunes se pelan primero; el medio va por LCS de líneas (hunks separados por
 *  cada región distinta — los folds y el cursor entre regiones sobreviven al remapping de
 *  CM6) con fallback a un único hunk si el doc es enorme. Pura, testeable. */
export function diffHunks(oldText: string, newText: string): Hunk[] {
  if (oldText === newText) return [];
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let pre = 0;
  const maxPre = Math.min(a.length, b.length);
  while (pre < maxPre && a[pre] === b[pre]) pre++;
  let suf = 0;
  const maxSuf = Math.min(a.length, b.length) - pre;
  while (suf < maxSuf && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  // Offset de inicio de cada línea vieja (startA[i] = offset de a[i]; último = length).
  const startA: number[] = new Array(a.length + 1);
  startA[0] = 0;
  for (let i = 0; i < a.length; i++) startA[i + 1] = (startA[i] as number) + (a[i] as string).length;

  const hunks: Hunk[] = [];
  const push = (fromLine: number, toLine: number, insertLines: string[]) => {
    const insert = insertLines.join("");
    const from = startA[fromLine] as number;
    const to = startA[toLine] as number;
    if (from === to && insert === "") return;
    const t = trimHunk(oldText, { from, to, insert });
    if (t.from !== t.to || t.insert !== "") hunks.push(t);
  };

  const aMid = a.slice(pre, a.length - suf);
  const bMid = b.slice(pre, b.length - suf);
  const n = aMid.length;
  const m = bMid.length;
  if (n * m > MAX_LCS_CELLS) {
    push(pre, a.length - suf, bMid);
    return hunks;
  }

  // LCS clásico: dp[i][j] = LCS de aMid[i..] vs bMid[j..]; después un walk que agrupa
  // cada corrida de líneas distintas en un hunk.
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        aMid[i] === bMid[j]
          ? (dp[(i + 1) * w + j + 1] as number) + 1
          : Math.max(dp[(i + 1) * w + j] as number, dp[i * w + j + 1] as number);
    }
  }
  let i = 0;
  let j = 0;
  let ri = -1; // inicio (en aMid/bMid) de la región distinta en curso, -1 = no hay
  let rj = -1;
  const flush = (endI: number, endJ: number) => {
    if (ri >= 0) {
      push(pre + ri, pre + endI, bMid.slice(rj, endJ));
      ri = -1;
      rj = -1;
    }
  };
  while (i < n || j < m) {
    if (i < n && j < m && aMid[i] === bMid[j]) {
      flush(i, j);
      i++;
      j++;
    } else if (j < m && (i === n || (dp[i * w + j + 1] as number) >= (dp[(i + 1) * w + j] as number))) {
      if (ri < 0) {
        ri = i;
        rj = j;
      }
      j++;
    } else {
      if (ri < 0) {
        ri = i;
        rj = j;
      }
      i++;
    }
  }
  flush(n, m);
  return hunks;
}

/** Aplica `newBody` sobre la vista como UNA transacción con los hunks del diff: CM6
 *  remapea cursor/selección/folds a través de los changes y el scroll no se fuerza.
 *  Anotada como remota y fuera del historial de undo (Cmd-Z no "deshace" lo de afuera). */
export function applyExternalToView(view: EditorView, newBody: string): void {
  const changes = diffHunks(view.state.doc.toString(), newBody);
  if (changes.length === 0) return;
  view.dispatch({
    changes,
    annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
  });
}

export interface EditorViewTap {
  /** Extensión para el prop `extensions` del atomic (registra el EditorView al montar). */
  extension: Extension;
  /** La vista CM6 montada con `extension`, o null si (todavía) no hay. */
  get(): EditorView | null;
}

/** Crea el par {extensión, getter} para UNA instancia de editor — mismo patrón que
 *  blameController (el handle del atomic no expone el EditorView). Si el view se
 *  reconstruye (resetSeq del descarte de draft), el plugin re-registra el nuevo. */
export function editorViewTap(): EditorViewTap {
  let current: EditorView | null = null;
  const plugin = ViewPlugin.define((view) => {
    current = view;
    return {
      destroy() {
        if (current === view) current = null;
      },
    };
  });
  return { extension: plugin, get: () => current };
}
