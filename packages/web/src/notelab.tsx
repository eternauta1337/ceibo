// Harness de browser para las Fases B y C de notas (ver notelab.html). Monta el
// FileEditor REAL (Editor.tsx completo: autosave, draft, banners, externalChange, rebase
// en 409) con un backend stubbeado (window.fetch intercepta /api/file) y botones que
// simulan a los otros escritores:
//
//  - Fase C (cambio externo VÍA FEED): setDoc con contenido+sha nuevos, mismo doc.id →
//    el editor lo aplica como transacción (limpio) o lo difiere a banner (dirty).
//  - Fase B (commit externo SIN feed — REM, otra pestaña: el feed ignora source 'web'):
//    el stub avanza contenido+sha del "server" SIN avisarle al editor → el próximo
//    autosave da 409 → rebase transparente (merge limpio, sin cartel) o panel de
//    conflicto con opciones si tocaron las MISMAS líneas.
//
// El stub ahora es un server de verdad en miniatura: guarda {content, sha} por path,
// el PUT exige baseSha == sha actual (si no → 409, como GitHub) y el GET devuelve lo
// vigente (lo que consume el rebase).
// Uso: pnpm --filter @ceibo/web dev → http://localhost:5173/notelab.html

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FileEditor } from "./Editor.tsx";
import "./index.css";

function logLine(s: string): void {
  const el = document.getElementById("lab-log");
  if (el) el.textContent = `${new Date().toISOString().slice(11, 19)} ${s}\n${el.textContent ?? ""}`;
}

const seccion = (n: number, lineas: number) =>
  `## sección ${n}\n\n${Array.from({ length: lineas }, (_, k) => `línea ${n}.${k + 1} de relleno para scrollear`).join("\n")}\n`;

const NOTE_A = `# nota A\n\n${seccion(1, 12)}\n${seccion(2, 12)}\n${seccion(3, 12)}\n${seccion(4, 12)}`;
const NOTE_B = `# nota B\n\notra nota, otro doc.id: abrirla SÍ remonta el editor (correcto).\n`;

// ── Stub de /api/file: server en miniatura con concurrencia optimista por sha ──────────
// Los shas van salteados con un id de sesión: en prod son blob-shas de git (únicos
// globalmente), pero acá un "sha-ext-3" regenerado tras un reload colisionaría con el que
// el draft persistido (IDB) le hizo adoptar al editor en la sesión anterior → el editor
// lo trataría de eco propio ("ignore") y el harness mentiría.
const SES = Date.now().toString(36).slice(-4);
const server = new Map<string, { content: string; sha: string }>([
  ["nota-a.md", { content: NOTE_A, sha: `sha-${SES}-0` }],
  ["nota-b.md", { content: NOTE_B, sha: `sha-${SES}-b0` }],
]);
let saveSeq = 0;
let extSeq = 0;

/** Commit externo directo al "server" (REM / otra pestaña): avanza contenido y sha. El
 *  caller decide si además se lo cuenta al editor (setDoc = vía feed) o no (silencioso). */
function externalCommit(path: string, mutate: (c: string) => string): { content: string; sha: string } {
  const cur = server.get(path);
  if (!cur) throw new Error(`stub: no existe ${path}`);
  extSeq++;
  const next = { content: mutate(cur.content), sha: `sha-${SES}-ext-${extSeq}` };
  server.set(path, next);
  return next;
}

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.startsWith("/api/file")) {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { path: string; content: string; baseSha?: string };
      const cur = server.get(body.path);
      if (!cur) return json(404, {});
      if (body.baseSha !== cur.sha) {
        logLine(`PUT /api/file (base=${body.baseSha}) → 409 (el server está en ${cur.sha})`);
        return json(409, { error: "conflict" });
      }
      saveSeq++;
      const sha = `sha-${SES}-save-${saveSeq}`;
      server.set(body.path, { content: body.content, sha });
      logLine(`PUT /api/file (base=${body.baseSha}) → 200 {sha: "${sha}"}`);
      return json(200, { sha });
    }
    const path = new URL(url, location.href).searchParams.get("path") ?? "";
    const cur = server.get(path);
    if (!cur) return json(404, {});
    logLine(`GET /api/file → {sha: "${cur.sha}"}`);
    return json(200, { content: cur.content, sha: cur.sha });
  }
  return realFetch(input, init);
}) as typeof fetch;

type Doc = { id: string; repo: string; path: string; content: string; sha: string };
const DOC_A: Doc = { id: "doc-a", repo: "lab", path: "nota-a.md", content: NOTE_A, sha: `sha-${SES}-0` };
const DOC_B: Doc = { id: "doc-b", repo: "lab", path: "nota-b.md", content: NOTE_B, sha: `sha-${SES}-b0` };

function NoteLab() {
  const [doc, setDoc] = useState<Doc>(DOC_A);

  // Cambio externo VÍA FEED (Fase C): commit al stub + setDoc con el mismo doc.id → el
  // editor montado recibe props nuevas, sin remount (transacción o banner según dirty).
  const externalViaFeed = (mutate: (c: string) => string) => {
    const next = externalCommit(doc.path, mutate);
    logLine(`cambio EXTERNO vía feed → ${next.sha} (setDoc, mismo doc.id)`);
    setDoc((d) => ({ ...d, content: next.content, sha: next.sha }));
  };

  // Commit externo SIN feed (Fase B): el server avanza, el editor NO se entera (como las
  // ediciones source:'web' de otra pestaña, que el feed ignora) → próximo autosave: 409.
  const externalSilent = (mutate: (c: string) => string) => {
    const next = externalCommit(doc.path, mutate);
    logLine(`commit externo SILENCIOSO → ${next.sha} (el editor no se entera hasta el 409)`);
  };

  return (
    <div style={{ maxWidth: 880, margin: "1rem auto", padding: "0 1rem" }}>
      <h1 style={{ fontSize: "1rem" }}>notelab — Fases B y C: 409-rebase y cambios externos</h1>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "0.5rem 0" }}>
        <button
          type="button"
          onClick={() =>
            externalSilent((c) =>
              c.replace(/^línea 3\.1 .*$/m, `línea 3.1 EDITADA AFUERA sin feed (#${extSeq + 1})`),
            )
          }
        >
          B: commit silencioso, edita sección 3 (mergeable)
        </button>
        <button
          type="button"
          onClick={() =>
            externalSilent((c) => `${c}\n## sección del REM (#${extSeq + 1})\nconsolidado del día\n`)
          }
        >
          B: commit silencioso, agrega sección (mergeable)
        </button>
        <button
          type="button"
          onClick={() =>
            externalSilent((c) => c.replace(/^línea 1\.1 .*$/m, `línea 1.1 PISADA AFUERA (#${extSeq + 1})`))
          }
        >
          B: commit silencioso, pisa la línea 1.1 (conflicto si tipeás ahí)
        </button>
        <button
          type="button"
          onClick={() =>
            externalViaFeed((c) =>
              c.replace(/^línea 3\.2 .*$/m, `línea 3.2 EDITADA vía feed (#${extSeq + 1})`),
            )
          }
        >
          C: cambio vía feed, edita sección 3
        </button>
        <button type="button" onClick={() => setDoc((d) => (d.id === "doc-a" ? DOC_B : DOC_A))}>
          abrir la otra nota (cambia doc.id → remount)
        </button>
      </div>
      <p style={{ fontSize: ".75rem", opacity: 0.7 }}>
        doc.id <code>{doc.id}</code> · sha (feed) <code>{doc.sha}</code> — <b>Fase B</b>: tipeá en la sección
        1, disparé un commit silencioso mergeable y esperá el autosave (2.5s): PUT→409→GET→merge→ re-PUT 200,
        SIN cartel, tu texto y lo de afuera conviven. Pisá la línea 1.1 mientras tipeás EN esa línea → panel
        de conflicto con opciones. <b>Fase C</b>: el cambio vía feed con buffer limpio entra como transacción;
        con tipeo sin guardar, banner.
      </p>
      <div style={{ border: "1px solid #ccc", borderRadius: 8 }}>
        <FileEditor
          key={doc.id}
          repo={doc.repo}
          path={doc.path}
          initialContent={doc.content}
          initialSha={doc.sha}
          selfHandle="lab"
          onSaved={(content, sha) => setDoc((d) => ({ ...d, content, sha }))}
          onRename={async () => undefined}
          onOpen={() => {}}
        />
      </div>
      <pre id="lab-log" style={{ fontSize: ".7rem", whiteSpace: "pre-wrap", opacity: 0.8 }} />
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<NoteLab />);
