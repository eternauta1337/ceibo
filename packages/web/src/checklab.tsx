// Harness de browser para el bug del PRIMER checkbox en una nota nueva (ver checklab.html).
//
// Síntoma reportado: en una nota recién creada (vacía), al tipear "- [ ] " en la 1er línea
// A VECES aparece el checkbox y A VECES queda como markdown crudo; en la 2da línea SIEMPRE
// aparece. DIAGNÓSTICO (confirmado con la sonda en una falla real): el doc queda en "- [ ]"
// (docLen=5) — se DROPEA el ESPACIO FINAL. Sin ese espacio el parser GFM no emite TaskMarker
// (`/^\[[ xX]\][ \t]/` exige espacio/tab tras `]`) → queda markdown, correcto. O sea NO es
// staleness de decoración: es una TECLA que se pierde en la 1er línea con el editor frío.
// El package trae `closeBrackets` activo (con `[`), que se mete en el tipeo de `[ ]`; su
// decisión depende del syntaxTree, incompleto en la 1er línea cold → candidato del char comido.
//
// Este harness monta el editor REAL (AtomicCodeMirrorEditor + EDITOR_EXTENSIONS, el mismo
// stack que prod) sobre una nota VACÍA, y permite:
//   - tipear "- [ ] " a mano (verdad de campo) o por el botón (programático, aproximación);
//   - una SONDA que separa las dos preguntas: ¿el árbol tiene TaskMarker? ¿el checkbox está
//     en el DOM? — así distinguimos "no parseó" de "parseó pero no renderizó";
//   - correr N pruebas (remonta nota vacía + tipea + sonda) y contar hits/misses;
//   - togglear un FIX candidato (forceParseRebuild) y una CARGA de main-thread (provoca race).
//
// Todo vive en memoria: no hay backend ni autosave.

import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";
import { ensureSyntaxTree } from "@codemirror/language";
import { type Extension, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { EDITOR_EXTENSIONS } from "./Editor.tsx";

// ── Fix candidato (ceibo-side, toggle-able) ──────────────────────────────────
// OJO: dado que el bug real es una TECLA DROPEADA (no staleness de decoración), este fix NO
// ataca la causa raíz — fuerza, tras cada edición, un parse completo + un dispatch extra que
// FLUSHEA la vista entre teclas, lo que cambia el timing y parece evitar el drop. Útil como
// señal ("si esto lo tapa, el problema es de timing/flush del input"), no como fix definitivo.
// Guardado contra loop: ignora updates sin docChanged (nuestro re-dispatch no tiene docChanged).
function forceParseRebuild(): Extension {
  return [
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const view = update.view;
      queueMicrotask(() => {
        const st = view.state;
        // Parse completo, sin el budget chico del package (en docs cortos es casi gratis).
        ensureSyntaxTree(st, st.doc.length, 1e9);
        // Re-set de la MISMA selección → update.selectionSet = true → rebuild de decoraciones.
        view.dispatch({ selection: st.selection });
      });
    }),
  ];
}

/** Quema el main-thread al MONTAR el editor (en el constructor del ViewPlugin) y en cada
 *  update temprano, para contender con el parse inicial y exponer la race. */
function mountLoad(ms: number): Extension {
  return ViewPlugin.fromClass(
    class {
      burns = 0;
      constructor() {
        burnMainThread(ms);
      }
      update() {
        // contiende también durante las primeras teclas (el parse inicial sigue calentando)
        if (this.burns < 6) {
          this.burns++;
          burnMainThread(ms);
        }
      }
    },
  );
}

// Log de transacciones por tecla (módulo, lo lee la UI). Cada edición registra qué se insertó
// y borró y cómo quedó el doc → en una falla se ve exactamente qué tecla no aterrizó (o si
// closeBrackets se comió/overtypeó un char).
const EDIT_LOG: string[] = [];
function logEdits(): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    for (const tr of update.transactions) {
      if (!tr.docChanged) continue;
      let ins = "";
      let del = "";
      tr.changes.iterChanges((_fa, _ta, _fb, _tb, inserted) => {
        ins += inserted.toString();
      });
      tr.changes.iterChanges((fa, ta, _fb, _tb) => {
        del += tr.startState.doc.sliceString(fa, ta);
      });
      const ev = tr.annotation(Transaction.userEvent) ?? "?";
      EDIT_LOG.push(
        `${ev}: +${JSON.stringify(ins)} -${JSON.stringify(del)} → ${JSON.stringify(tr.newDoc.toString())}`,
      );
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const CHECKLIST = "- [ ] ";
const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Quema el main-thread ~ms para provocar la race (parser frío compitiendo con el render). */
function burnMainThread(ms: number): void {
  const end = performance.now() + ms;
  let spins = 0;
  while (performance.now() < end) spins++;
  void spins;
}

type Probe = { docLen: number; doc: string; taskInTree: boolean; checkboxInDom: boolean };

function ChecklistLab() {
  const hostRef = useRef<HTMLDivElement>(null);
  // mountSeq fuerza remontaje (nota vacía fresca = parser frío). fix/load van en el id para
  // que togglearlos también remonte (el editor captura `extensions` al montar).
  const [mountSeq, setMountSeq] = useState(0);
  const [fixOn, setFixOn] = useState(false);
  const [loadOn, setLoadOn] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [runResult, setRunResult] = useState<string>("");
  const [editLog, setEditLog] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // El editor captura `extensions` al montar; el `key`/documentId (con fixOn/loadOn) fuerza
  // remontaje al togglear, así que pasar un array nuevo por render es inocuo.
  const exts: Extension[] = [
    ...EDITOR_EXTENSIONS,
    logEdits(),
    ...(loadOn ? [mountLoad(120)] : []),
    ...(fixOn ? [forceParseRebuild()] : []),
  ];

  const getView = useCallback((): EditorView | null => {
    const dom = hostRef.current?.querySelector<HTMLElement>(".cm-content");
    return dom ? (EditorView.findFromDOM(dom) ?? null) : null;
  }, []);

  const probeNow = useCallback((): Probe | null => {
    const view = getView();
    if (!view) return null;
    const st = view.state;
    const tree = ensureSyntaxTree(st, st.doc.length, 50) ?? null;
    let taskInTree = false;
    tree?.iterate({
      enter: (n) => {
        if (n.name === "TaskMarker") taskInTree = true;
      },
    });
    const checkboxInDom = (hostRef.current?.querySelectorAll(".cm-atomic-task-checkbox").length ?? 0) > 0;
    return { docLen: st.doc.length, doc: st.doc.toString(), taskInTree, checkboxInDom };
  }, [getView]);

  /** Tipea CHECKLIST char por char (con gaps de rAF para que el editor renderice entre teclas,
   *  más fiel a la realidad que un loop sincrónico). */
  const typeChecklist = useCallback(async () => {
    const view = getView();
    if (!view) return;
    view.focus();
    for (const ch of CHECKLIST) {
      const head = view.state.selection.main.head;
      view.dispatch({
        changes: { from: head, insert: ch },
        selection: { anchor: head + ch.length },
        userEvent: "input.type",
      });
      await raf();
    }
  }, [getView]);

  const remountEmpty = useCallback(() => {
    EDIT_LOG.length = 0;
    setEditLog("");
    setMountSeq((s) => s + 1);
  }, []);

  // Una prueba: remonta nota vacía → (carga opcional) → tipea → sonda.
  const runOnce = useCallback(async (): Promise<Probe | null> => {
    remountEmpty();
    await raf();
    await raf(); // dar tiempo a que el editor monte (la contención la mete mountLoad)
    await typeChecklist();
    await sleep(60); // ventana para que un rebuild tardío (si lo hubiera) ocurra
    return probeNow();
  }, [remountEmpty, typeChecklist, probeNow]);

  const onProbe = useCallback(() => {
    setProbe(probeNow());
    setEditLog(EDIT_LOG.join("\n"));
  }, [probeNow]);

  const onTypeManualHelper = useCallback(async () => {
    setBusy(true);
    await typeChecklist();
    await sleep(60);
    setProbe(probeNow());
    setEditLog(EDIT_LOG.join("\n"));
    setBusy(false);
  }, [typeChecklist, probeNow]);

  const onRunN = useCallback(
    async (n: number) => {
      setBusy(true);
      setRunResult("corriendo…");
      let renders = 0;
      let taskOk = 0;
      const misses: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = await runOnce();
        if (!p) continue;
        if (p.taskInTree) taskOk++;
        if (p.checkboxInDom) renders++;
        else misses.push(i + 1);
      }
      setRunResult(
        `pruebas=${n} · fix=${fixOn ? "ON" : "off"} · carga=${loadOn ? "ON" : "off"}\n` +
          `checkbox RENDERIZÓ: ${renders}/${n}  (misses: ${misses.length ? misses.join(",") : "ninguno"})\n` +
          `TaskMarker en árbol: ${taskOk}/${n}  → si árbol=OK pero render<n ⇒ bug de view-layer (no parser)`,
      );
      setProbe(probeNow());
      setBusy(false);
    },
    [runOnce, fixOn, loadOn, probeNow],
  );

  const mono = { fontFamily: "ui-monospace, monospace", fontSize: ".8rem" } as const;
  return (
    <div style={{ maxWidth: 760, margin: "1.5rem auto", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "1.05rem" }}>checklab — bug del 1er checkbox en nota nueva</h1>
      <p style={{ fontSize: ".8rem", color: "#666" }}>
        Nota VACÍA, editor real. Tipeá <code>- [ ] </code> (con espacio final) en la 1er línea y mirá si sale
        el checkbox o queda markdown. La sonda separa "¿árbol tiene TaskMarker?" de "¿checkbox en el DOM?".
      </p>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", margin: "10px 0" }}>
        <label style={mono}>
          <input type="checkbox" checked={fixOn} onChange={(e) => setFixOn(e.target.checked)} /> fix
          (forceParseRebuild)
        </label>
        <label style={mono}>
          <input type="checkbox" checked={loadOn} onChange={(e) => setLoadOn(e.target.checked)} /> carga
          main-thread al montar (provoca race)
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
        <button type="button" disabled={busy} onClick={remountEmpty}>
          Reset (nota vacía)
        </button>
        <button type="button" disabled={busy} onClick={() => void onTypeManualHelper()}>
          Tipear "- [ ] "
        </button>
        <button type="button" onClick={onProbe}>
          Sonda
        </button>
        <button type="button" disabled={busy} onClick={() => void onRunN(50)}>
          Correr 50 pruebas
        </button>
      </div>

      <div
        ref={hostRef}
        style={{ border: "1px solid #ccc", borderRadius: 8, padding: 8, minHeight: 80 }}
        // documentId cambia con mountSeq+fix+load → remonta editor frío
        key={`m${mountSeq}-${fixOn ? "fix" : "nofix"}-${loadOn ? "load" : "noload"}`}
      >
        <AtomicCodeMirrorEditor
          documentId={`checklab-m${mountSeq}-${fixOn ? "fix" : "nofix"}-${loadOn ? "load" : "noload"}`}
          markdownSource=""
          extensions={exts}
        />
      </div>

      <h2 style={{ fontSize: ".85rem", marginTop: 16 }}>sonda (última)</h2>
      <pre style={{ ...mono, background: "#f4f4f4", padding: 8, whiteSpace: "pre-wrap" }}>
        {probe
          ? `doc=${JSON.stringify(probe.doc)}  (docLen=${probe.docLen})\n` +
            `TaskMarker en árbol: ${probe.taskInTree ? "SÍ" : "NO"}\ncheckbox en DOM:     ${probe.checkboxInDom ? "SÍ" : "NO"}` +
            (probe.docLen < 6
              ? "\n⚠️ doc INCOMPLETO (faltó un char, ¿el espacio final?) ⇒ tecla dropeada"
              : "") +
            (probe.taskInTree && !probe.checkboxInDom ? "\n⚠️ árbol OK pero NO renderiza ⇒ view-layer" : "")
          : "—"}
      </pre>

      <h2 style={{ fontSize: ".85rem" }}>log de teclas (transacciones, esta nota)</h2>
      <pre style={{ ...mono, background: "#f4f4f4", padding: 8, whiteSpace: "pre-wrap" }}>
        {editLog || "—"}
      </pre>

      <h2 style={{ fontSize: ".85rem" }}>resultado de las pruebas</h2>
      <pre style={{ ...mono, background: "#f4f4f4", padding: 8, whiteSpace: "pre-wrap" }}>
        {runResult || "—"}
      </pre>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<ChecklistLab />);
