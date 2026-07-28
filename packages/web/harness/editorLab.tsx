// Harness del editor de notas para los 4 bugs WIP (ver editor-lab.html). Monta el
// FileEditor real con un fetch stubeado (PUT /api/file responde ok para que el autosave no
// rompa; no hay backend). El doc fixture concentra los cuatro casos:
//   1. autocomplete/autoclosing: texto con `*` y `[` para tipear a mano.
//   2. mail invisible: `hello@example.com` (autolink GFM) debe verse.
//   3. link crudo: una URL pegada sin markup `[txt](url)` debe verse.
//   4. lista con `*` final: un item que termina en `*` debe continuar al Enter.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FileEditor } from "../src/Editor.tsx";
import "../src/index.css";

// El editor oculta un H1 inicial == al nombre del archivo (filename "notas"), así que la
// primera línea visible es el subtítulo. Cada bug tiene su bloque etiquetado.
const CONTENT = `# notas

## Bug 2 — mail (debe verse, no invisible)

Escribime a hello@example.com cuando puedas.

## Bug 3 — link crudo pegado (debe verse, no desaparecer)

Mirá la tx https://etherscan.io/tx/0x2fc34c6e20609cc25e18aa74f6e4ec38f193ebbc72590e586a017d61fb50dfba para confirmar.

Y un link con label normal: [etherscan](https://etherscan.io) para comparar.

## Bug 1 — tipeá acá para probar autocomplete/autoclosing

texto con asterisco suelto: prueba *

## Bug 4 — lista cuyo último item termina en \`*\`

- item normal
- item que termina en *
`;

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("/api/file") && init?.method === "PUT") {
    return new Response(JSON.stringify({ sha: "s2", path: "notas.md" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.startsWith("/api/file")) {
    // GET (rebase post-409, etc.) — devolvemos el mismo contenido para que nada rompa.
    return new Response(JSON.stringify({ content: CONTENT, sha: "s1", path: "notas.md" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input, init);
};

function Harness() {
  return (
    <div style={{ maxWidth: 760, margin: "1rem auto", padding: "0 2rem" }}>
      <h1 style={{ fontSize: "1rem" }}>editor-lab — 4 bugs WIP</h1>
      <FileEditor
        repo="demo-personal"
        path="notas.md"
        initialContent={CONTENT}
        initialSha="s1"
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
