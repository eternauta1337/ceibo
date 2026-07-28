// Harness DEV-ONLY del chrome de la nota alrededor del blame: replica la estructura .view
// de App.tsx (header con tabs + ✕ de cierre mobile, botonera .view-nav con flechas y el
// toggle de blame) para verificar las DOS reglas de UX:
//   1. el toggle de blame vive en la botonera del margen superior IZQUIERDO de la nota;
//   2. el ✕ de cerrar nota (mobile) queda en el margen superior DERECHO (margin-left:auto),
//      sin que el blame lo desplace.
// Abrir con `pnpm --filter @ceibo/web dev` en http://localhost:5173/harness/blameButton.html
// (achicar el viewport a <32rem para ver el ✕, que es mobile-only).

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { IconArrowLeft, IconArrowRight, IconUsers, IconX } from "../src/icons.tsx";
import "../src/index.css";

function BlameButtonHarness() {
  const [blameOn, setBlameOn] = useState(false);
  return (
    <div style={{ height: "100vh", position: "relative", background: "var(--bg)" }}>
      {/* Simulamos la estructura .view de App.tsx */}
      <section className="view">
        <header className="view-head view-head-tabs" style={{ background: "var(--panel)" }}>
          {/* Tabs stub (en mobile la tira real se oculta por CSS) */}
          <div
            className="tabstrip"
            style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: "0.25rem" }}
          >
            <div
              style={{
                background: "var(--surface)",
                borderRadius: "0.3rem 0.3rem 0 0",
                padding: "0.3rem 0.75rem",
                fontSize: "0.85rem",
                color: "var(--fg)",
              }}
            >
              plan.md ✕
            </div>
          </div>
          {/* ✕ cerrar (mobile-only por CSS; debe quedar arriba a la DERECHA) */}
          <button type="button" className="note-close-head" aria-label="Cerrar nota">
            <IconX />
          </button>
        </header>

        {/* Botonera del margen superior izquierdo: flechas + blame (igual que App.tsx) */}
        <div className="view-nav">
          <button type="button" className="nav-btn" disabled aria-label="Atrás" data-tip="Atrás">
            <IconArrowLeft size={18} />
          </button>
          <button type="button" className="nav-btn" aria-label="Adelante" data-tip="Adelante">
            <IconArrowRight size={18} />
          </button>
          <button
            type="button"
            className={`nav-btn blame-toggle${blameOn ? " blame-toggle-on" : ""}`}
            onClick={() => setBlameOn((v) => !v)}
            aria-pressed={blameOn}
            aria-label={blameOn ? "Ocultar autores por línea" : "Ver quién escribió cada línea"}
            data-tip={blameOn ? "Ocultar autores" : "Quién escribió qué"}
          >
            <IconUsers size={18} />
          </button>
        </div>

        {/* Body de la nota */}
        <div className="view-body" style={{ padding: "4.5rem 2rem 1.5rem" }}>
          <p style={{ color: "var(--fg)", fontSize: "1.1rem", fontWeight: "bold" }}>
            plan.md — nota de ejemplo
          </p>
          <p style={{ color: "var(--fg-soft)", marginTop: "0.5rem" }}>
            El botón de blame (ícono personas) va en la botonera de ARRIBA A LA IZQUIERDA, junto a las
            flechas. Estado: <strong>{blameOn ? "PRENDIDO (acento)" : "APAGADO"}</strong>
          </p>
          <p style={{ color: "var(--fg-soft)", marginTop: "1rem", fontSize: "0.9rem" }}>
            En viewport mobile (&lt;32rem) el ✕ de cerrar nota debe verse arriba a la DERECHA del header.
          </p>
          <ul style={{ color: "var(--fg)", marginTop: "1rem" }}>
            <li>Vuelos: martes 14</li>
            <li>Hotel: cabaña en el bosque</li>
            <li>Auto: alquiler en el aeropuerto</li>
          </ul>
        </div>
      </section>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <BlameButtonHarness />
    </StrictMode>,
  );
}
