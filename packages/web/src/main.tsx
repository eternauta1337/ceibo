import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Fuente self-hosted (Fontsource → woff2 bundleado por Vite, sin CDN externo): Inter Tight,
// la misma que la landing (www.example.com) → marca unificada. Una sola familia para todo
// (display + body); la itálica es "la voz" (caption / tagline / hint), igual que la landing.
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/inter-tight/wght-italic.css"; // itálica real (la "voz")
import { App } from "./App.tsx";
import { installViewportRotateFix } from "./viewportRotateFix.ts";
import "./index.css";

// Aplicá el tema guardado ANTES del primer paint para no flashear claro→oscuro (#24).
// "auto" no setea atributo (la media query del CSS sigue al sistema sin flash).
try {
  const t = localStorage.getItem("ceibo_theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch {
  /* localStorage no disponible */
}

// Al rotar en mobile, iOS Safari deja el viewport “pegado” al ancho anterior → fondo fuera de
// cuadro + banda gris a la derecha. Re-afirmamos el meta viewport en la rotación para forzar el
// re-layout al ancho correcto. Ver viewportRotateFix.ts.
installViewportRotateFix();

const root = document.getElementById("root");
if (!root) throw new Error("no #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
