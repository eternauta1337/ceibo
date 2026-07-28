// Harness del sandbox: drivea el orbe a mano (botones de estado en el panel) y un "nivel" de
// audio (slider o mic real) para los estados reactivos. El panel edita la config POR ESTADO y
// "Guardar" la escribe en orb.config.json (POST → plugin de Vite), que la app consume directo.

import { buildPanel, createOrb, type OrbConfig, orbConfig } from "../src/index.ts";

const canvas = document.getElementById("orb") as HTMLCanvasElement;
const lvlInput = document.getElementById("lvl") as HTMLInputElement;
const micCb = document.getElementById("mic") as HTMLInputElement;

// clon editable de la config (el panel lo muta; "Guardar" lo persiste)
const config: OrbConfig = JSON.parse(JSON.stringify(orbConfig));
const MOTION_SEED = 0xce1b0;

// nivel de audio: del slider, o del mic real si está tildado
let analyser: AnalyserNode | null = null;
let micData: Uint8Array<ArrayBuffer> | null = null;
micCb.addEventListener("change", async () => {
  if (micCb.checked && !analyser) {
    try {
      const ctx = new AudioContext();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      micData = new Uint8Array(analyser.fftSize);
      src.connect(analyser);
    } catch {
      micCb.checked = false;
    }
  }
});
function readMic(): number {
  if (!analyser || !micData) return 0;
  analyser.getByteTimeDomainData(micData);
  let sum = 0;
  for (const v of micData) {
    const x = (v - 128) / 128;
    sum += x * x;
  }
  return Math.min(1, Math.sqrt(sum / micData.length) * 2.4);
}

const orb = createOrb(canvas, {
  config,
  initialState: "idle",
  motionSeed: MOTION_SEED,
  getLevel: (st) =>
    st === "recording" || st === "speaking"
      ? micCb.checked
        ? readMic()
        : Number.parseFloat(lvlInput.value)
      : 0,
});

buildPanel({
  config,
  initialState: "idle",
  onState: (s) => {
    orb?.setState(s);
  },
  onShape: (s) => {
    orb?.setShape(s);
  },
  onSave: async (cfg) => {
    const configRes = await fetch("/orb-config", { method: "POST", body: JSON.stringify(cfg) });
    if (!configRes.ok) throw new Error(await configRes.text());
  },
});

// Botones de sub-agentes: 0–4 satélites para testear los radios de órbita
const satBtns = document.getElementById("sat-btns") as HTMLElement;
let satCount = 0;
for (let n = 0; n <= 4; n++) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = String(n);
  b.style.cssText =
    "padding:3px 7px;border:none;border-radius:5px;cursor:pointer;font:inherit;background:#2a2a32;color:#cdcdd6";
  const nn = n;
  b.addEventListener("click", () => {
    satCount = nn;
    orb?.setSubagents(nn);
    for (const el of satBtns.children) {
      (el as HTMLElement).style.background = "#2a2a32";
      (el as HTMLElement).style.color = "#cdcdd6";
    }
    b.style.background = "#3b6ef5";
    b.style.color = "#fff";
  });
  if (n === 0) {
    b.style.background = "#3b6ef5";
    b.style.color = "#fff";
  }
  satBtns.append(b);
}
