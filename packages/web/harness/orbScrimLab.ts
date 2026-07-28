// Lab del scrim radial del orb: monta el orb WebGL REAL (mismo engine y config que la app)
// sobre la réplica estática del dock (greeting + underhint) y permite alternar fondo y
// variante de scrim por URL (?bg=…&v=…) o con los botones. Ver orb-scrim-lab.html.
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/inter-tight/wght-italic.css";
import { createOrb, orbConfig } from "@ceibo/orb";

const BGS = ["white", "light", "medium", "dark"] as const;
const VARIANTS = ["none", "a", "b", "c", "d", "e", "f"] as const;
const NAMES: Record<string, string> = {
  none: "sin scrim (actual)",
  a: "a · halo radial",
  b: "b · scrim amplio",
  c: "c · sombra blur",
  d: "d · viñeta foto",
  e: "e · combo (viñeta suave + halo tenue)",
  f: "f · canon review P0-2 (dock::before + sombra saludo)",
};

const params = new URLSearchParams(location.search);
const bg = (BGS as readonly string[]).includes(params.get("bg") ?? "")
  ? (params.get("bg") as string)
  : "light";
const v = (VARIANTS as readonly string[]).includes(params.get("v") ?? "")
  ? (params.get("v") as string)
  : "none";

document.body.dataset.bg = bg;
document.body.dataset.v = v;
// Saludo liviano (P1-6): ?gw=400 activa weight 400 + tracking -0.03em (default: 600 actual).
document.body.dataset.gw = params.get("gw") === "400" ? "400" : "600";
if (params.has("clean")) document.body.classList.add("clean");

// Orb real, estado idle (anillos blancos topográficos — el caso que se pierde sobre claro).
const canvas = document.getElementById("orb-canvas") as HTMLCanvasElement;
createOrb(canvas, { config: orbConfig, initialState: "idle", getLevel: () => 0 });

// Controles: links que regeneran la URL (recarga = estado limpio, fácil de screenshotear).
const controls = document.getElementById("controls");
const label = document.getElementById("label");
if (controls && label) {
  const link = (k: "bg" | "v", val: string, text: string, on: boolean) => {
    const a = document.createElement("a");
    const p = new URLSearchParams(params);
    p.set(k, val);
    a.href = `?${p.toString()}`;
    a.textContent = text;
    if (on) a.classList.add("on");
    return a;
  };
  for (const b of BGS) controls.appendChild(link("bg", b, b, b === bg));
  for (const vv of VARIANTS) controls.appendChild(link("v", vv, NAMES[vv] ?? vv, vv === v));
  label.textContent = `bg=${bg} · ${NAMES[v] ?? v}`;
}
