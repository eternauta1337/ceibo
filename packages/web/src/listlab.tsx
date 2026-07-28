// Harness de browser para el editor de notas (ver listlab.html). Monta el editor REAL
// (AtomicCodeMirrorEditor + EDITOR_EXTENSIONS de Editor.tsx, el mismo stack que prod)
// con un doc de prueba de listas. Sirve para verificar a mano keymaps (Tab, Alt+↑/↓),
// renumeración y subtrees — cosas que los tests headless no ejercitan contra un
// EditorView de verdad. El doc vive solo en memoria (no hay backend ni autosave).

import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { EDITOR_EXTENSIONS } from "./Editor.tsx";

const DOC = `# listlab

Lista simple:

- alfa
- beta
- gamma

Ordenada con subtree:

1. uno
2. dos
   1. hijo de dos
   2. otro hijo
3. tres

- [ ] tarea a
- [x] tarea b
`;

function ListLab() {
  const [current, setCurrent] = useState(DOC);
  return (
    <div style={{ maxWidth: 720, margin: "2rem auto", fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: "1rem" }}>listlab — editor real con EDITOR_EXTENSIONS</h1>
      <p style={{ fontSize: ".8rem", color: "#666" }}>
        Probá: Tab/Shift-Tab en items, Alt+↑/↓ para mover items (con subtree), drag con el handle ⠿ (hover
        sobre un item), renumeración.
      </p>
      <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: 8 }}>
        <AtomicCodeMirrorEditor
          documentId="listlab"
          markdownSource={DOC}
          onMarkdownChange={setCurrent}
          extensions={EDITOR_EXTENSIONS}
        />
      </div>
      <h2 style={{ fontSize: ".9rem" }}>markdown actual</h2>
      <pre
        id="md-out"
        style={{ background: "#f4f4f4", padding: 8, fontSize: ".75rem", whiteSpace: "pre-wrap" }}
      >
        {current}
      </pre>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<ListLab />);
