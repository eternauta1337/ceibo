// Harness del blame por línea (ver blame.html). Monta el FileEditor real con un fetch
// stubeado: GET /api/file/blame devuelve ranges fijos según el modo (wiki COMPARTIDA con
// varios autores, o PERSONAL con tramos humano/IA) y PUT /api/file responde ok para que el
// autosave no rompa. Los avatares también se stubean (avatarSrc de memberFace.ts): "anni"
// tiene foto (SVG data-URL), el resto cae a las iniciales. El toggle de arriba simula el
// botón de la botonera de la nota (blameOn prop).

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BlameRangeWire } from "../src/blame.ts";
import { FileEditor } from "../src/Editor.tsx";
import { avatarSrc } from "../src/memberFace.ts";
import "../src/index.css";

// Líneas del ARCHIVO (1-based). Las 1-2 son el H1 oculto (el editor no las muestra:
// offset 2); el resto cubre tres autores + un tramo histórico (handle null).
const CONTENT = `# plan

## Plan del viaje

- Vuelos: martes 14
- Hotel: cabaña en el bosque
- Auto: alquiler en el aeropuerto

Notas viejas migradas por el bot.
Otra línea histórica sin autor real.
`;

// Cola larga para validar SCROLL: 60 líneas más, alternando autores cada 3.
const TAIL_LINES = Array.from({ length: 60 }, (_, i) => `Línea extra ${i + 1} para scrollear.`);
const LONG_CONTENT = `${CONTENT}\n${TAIL_LINES.join("\n")}\n`;
const TAIL_START = CONTENT.split("\n").length + 1; // 1-based: primera línea de la cola

const AUTHORS = [
  { handle: "demo", name: "Alicia" },
  { handle: "anni", name: "Anni" },
  { handle: "azul", name: "Azul" },
  { handle: "valentina-larga", name: "Valentina" },
] as const;

// Wiki COMPARTIDA: varios autores + histórico. anni tiene dos ranges seguidos (5 y 7 con
// azul en el medio) y dos shas distintos con sources distintos → tooltip varía por range.
const SHARED_RANGES: BlameRangeWire[] = [
  {
    start: 1,
    end: 4,
    handle: "demo",
    name: "Alicia",
    date: "2026-06-09T12:00:00Z",
    sha: "c1",
    source: "web",
  },
  {
    start: 5,
    end: 5,
    handle: "anni",
    name: "Anni",
    date: "2026-06-08T10:00:00Z",
    sha: "c2",
    source: "agent",
    hasAvatar: true,
  },
  { start: 6, end: 6, handle: "azul", name: "Azul", date: "2026-06-07T09:00:00Z", sha: "c3", source: null },
  {
    start: 7,
    end: 7,
    handle: "anni",
    name: "Anni",
    date: "2026-06-08T10:05:00Z",
    sha: "c4",
    source: "web",
    hasAvatar: true,
  },
  { start: 8, end: 10, handle: null, name: null, date: "2026-05-01T00:00:00Z", sha: "c0", source: null },
  ...Array.from({ length: 20 }, (_, i) => {
    const a = AUTHORS[i % AUTHORS.length] as (typeof AUTHORS)[number];
    return {
      start: TAIL_START + i * 3,
      end: TAIL_START + i * 3 + 2,
      handle: a.handle,
      name: a.name,
      date: "2026-06-05T00:00:00Z",
      sha: `t${i}`,
      source: null,
      hasAvatar: a.handle === "anni",
    };
  }),
];

// Wiki PERSONAL del viewer (demo): tramos "vos" (web) vs "ceibo (IA)" (agent) vs histórico
// (source desconocido — anterior al registro).
const PERSONAL_RANGES: BlameRangeWire[] = [
  {
    start: 1,
    end: 4,
    handle: "demo",
    name: "Alicia",
    date: "2026-06-09T12:00:00Z",
    sha: "p1",
    source: "web",
  },
  {
    start: 5,
    end: 6,
    handle: "demo",
    name: "Alicia",
    date: "2026-06-09T13:00:00Z",
    sha: "p2",
    source: "agent",
  },
  {
    start: 7,
    end: 7,
    handle: "demo",
    name: "Alicia",
    date: "2026-06-09T14:00:00Z",
    sha: "p3",
    source: "web",
  },
  {
    start: 8,
    end: 10,
    handle: "demo",
    name: "Alicia",
    date: "2026-04-01T00:00:00Z",
    sha: "p0",
    source: null,
  },
  ...Array.from({ length: 20 }, (_, i) => ({
    start: TAIL_START + i * 3,
    end: TAIL_START + i * 3 + 2,
    handle: "demo",
    name: "Alicia",
    date: "2026-06-05T00:00:00Z",
    sha: `q${i}`,
    source: (i % 2 === 0 ? "agent" : "web") as "agent" | "web",
  })),
];

// Avatares stubeados: anni tiene foto (SVG data-URL, hasAvatar: true en sus ranges); el
// resto va directo a iniciales (hasAvatar: false, igual que los chips del explorer).
const ANNI_AVATAR = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#5fae3f"/><circle cx="12" cy="9" r="4" fill="#fff"/><path d="M4 22a8 8 0 0 1 16 0z" fill="#fff"/></svg>',
)}`;
avatarSrc.of = (handle) => (handle === "anni" ? ANNI_AVATAR : `/no-avatar/${handle}`);

let mode: "shared" | "personal" = "shared";
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("/api/file/blame")) {
    const shared = mode === "shared";
    return new Response(
      JSON.stringify({ ref: "head1", shared, ranges: shared ? SHARED_RANGES : PERSONAL_RANGES }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (url.startsWith("/api/file") && init?.method === "PUT") {
    return new Response(JSON.stringify({ sha: "s2", path: "plan.md" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input, init);
};

function Harness() {
  const [on, setOn] = useState(false);
  const [wiki, setWiki] = useState<"shared" | "personal">("shared");
  mode = wiki;
  return (
    <div style={{ maxWidth: 720, margin: "1rem auto", padding: "0 2rem" }}>
      <button id="blame-toggle" type="button" onClick={() => setOn((v) => !v)}>
        blame: {on ? "ON" : "OFF"}
      </button>
      <button
        id="mode-toggle"
        type="button"
        onClick={() => {
          setOn(false); // re-fetch limpio al cambiar de modo
          setWiki((w) => (w === "shared" ? "personal" : "shared"));
        }}
      >
        wiki: {wiki}
      </button>
      <FileEditor
        // key por modo: remonta el editor al cambiar (como cambiar de nota en la app)
        key={wiki}
        repo={wiki === "shared" ? "familia" : "demo-personal"}
        path="plan.md"
        initialContent={LONG_CONTENT}
        initialSha="s1"
        blameOn={on}
        selfHandle="demo"
      />
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
}
