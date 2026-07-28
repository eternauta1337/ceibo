// Panel de control del harness: botones de ESTADO (transicionan el orbe + eligen qué estado
// editás) y sliders/color que editan los params de ESE estado. "Guardar" escribe la config
// que la app usa directo; "Copiar" la manda al portapapeles. Toggle con la tecla `.
// (Vive solo en el harness/sandbox; prod no monta el panel → liviano.)

import {
  ORB_SHAPES,
  ORB_STATES,
  type OrbConfig,
  type OrbShape,
  type OrbState,
  PARAM_META,
  type StateParams,
} from "./types.ts";

const hex2rgb = (h: string): StateParams["color"] => {
  const n = Number.parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const rgb2hex = (c: StateParams["color"]) =>
  `#${c
    .map((x) =>
      Math.round(Math.min(1, Math.max(0, x)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

export function buildPanel(opts: {
  config: OrbConfig;
  onState: (s: OrbState) => void;
  onShape?: (s: OrbShape) => void; // previsualizar formas-por-estado (las formas ya no son random)
  onSave?: (config: OrbConfig) => void | Promise<void>;
  initialState?: OrbState;
}): () => void {
  const { config, onState, onShape, onSave } = opts;
  let sel: OrbState = opts.initialState ?? "idle";

  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;top:10px;left:10px;z-index:99;padding:8px 10px;max-height:94vh;overflow:auto;" +
    "background:rgba(16,16,20,0.85);color:#e8e6f0;font:11px ui-monospace,monospace;border-radius:9px;" +
    "backdrop-filter:blur(6px);width:268px;user-select:none;line-height:1.5";

  // --- botones de estado ---
  const states = document.createElement("div");
  states.style.cssText = "display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-bottom:6px";
  const stateBtns: Record<string, HTMLButtonElement> = {};
  for (const s of ORB_STATES) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s;
    b.style.cssText =
      "padding:4px 4px;border:none;border-radius:6px;cursor:pointer;font:inherit;font-size:10px;" +
      "background:#2a2a32;color:#cdcdd6";
    b.addEventListener("click", () => {
      sel = s;
      onState(s);
      syncSel();
      rebuildRows();
    });
    stateBtns[s] = b;
    states.append(b);
  }
  panel.append(states);

  // --- botones de FORMA (preview de las formas-por-estado; en prod la web las setea sola) ---
  if (onShape) {
    const shapes = document.createElement("div");
    shapes.style.cssText =
      "display:grid;grid-template-columns:repeat(5,1fr);gap:4px;margin-bottom:6px;opacity:0.92";
    for (const s of Object.keys(ORB_SHAPES) as OrbShape[]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = s.slice(0, 4); // circ/tria/squa/pent/hexa
      b.title = s;
      b.style.cssText =
        "padding:4px 2px;border:none;border-radius:6px;cursor:pointer;font:inherit;font-size:9px;" +
        "background:#26323f;color:#bcd";
      b.addEventListener("click", () => onShape(s));
      shapes.append(b);
    }
    panel.append(shapes);
  }

  const syncSel = () => {
    for (const s of ORB_STATES) {
      stateBtns[s]!.style.background = s === sel ? "#3b6ef5" : "#2a2a32";
      stateBtns[s]!.style.color = s === sel ? "#fff" : "#cdcdd6";
    }
  };

  // --- sliders + color (se reconstruyen al cambiar de estado) ---
  const rowsBox = document.createElement("div");
  panel.append(rowsBox);
  const fmt = (v: number) => v.toFixed(3);
  const rebuildRows = () => {
    rowsBox.replaceChildren();
    const sp = config[sel];
    for (const m of PARAM_META) {
      const row = document.createElement("label");
      row.style.cssText = "display:grid;grid-template-columns:62px 1fr 40px;gap:7px;align-items:center";
      const name = document.createElement("span");
      name.textContent = m.label;
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(m.min);
      input.max = String(m.max);
      input.step = String(m.step);
      input.value = String(sp[m.key] as number);
      input.style.width = "100%";
      const val = document.createElement("span");
      val.style.cssText = "text-align:right;opacity:0.8";
      val.textContent = fmt(sp[m.key] as number);
      input.addEventListener("input", () => {
        (config[sel][m.key] as number) = Number.parseFloat(input.value);
        val.textContent = fmt(Number.parseFloat(input.value));
      });
      row.append(name, input, val);
      rowsBox.append(row);
    }
    // color
    const crow = document.createElement("label");
    crow.style.cssText =
      "display:grid;grid-template-columns:62px 1fr;gap:7px;align-items:center;margin-top:2px";
    const cname = document.createElement("span");
    cname.textContent = "color";
    const cinput = document.createElement("input");
    cinput.type = "color";
    cinput.value = rgb2hex(sp.color);
    cinput.style.cssText = "width:100%;height:20px;padding:0;border:none;background:none";
    cinput.addEventListener("input", () => {
      config[sel].color = hex2rgb(cinput.value);
    });
    crow.append(cname, cinput);
    rowsBox.append(crow);
  };

  // --- guardar / copiar ---
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:6px;margin-top:8px";
  const mkBtn = (txt: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = txt;
    b.style.cssText =
      "flex:1;padding:5px;border:none;border-radius:6px;cursor:pointer;font:inherit;background:#3b6ef5;color:#fff";
    return b;
  };
  if (onSave) {
    const save = mkBtn("Guardar");
    save.addEventListener("click", async () => {
      save.textContent = "…";
      try {
        await onSave(config);
        save.textContent = "✓ guardado";
      } catch {
        save.textContent = "✗ error";
      }
      setTimeout(() => (save.textContent = "Guardar"), 1400);
    });
    actions.append(save);
  }
  const copy = mkBtn("Copiar JSON");
  copy.style.background = "#2a2a32";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
      copy.textContent = "✓ copiado";
    } catch {
      copy.textContent = "✗";
    }
    setTimeout(() => (copy.textContent = "Copiar JSON"), 1400);
  });
  actions.append(copy);
  panel.append(actions);

  const hint = document.createElement("div");
  hint.style.cssText = "opacity:0.45;margin-top:6px;font-size:10px";
  hint.textContent = "` oculta · botones = estado del orbe";
  panel.append(hint);

  syncSel();
  rebuildRows();
  document.body.append(panel);
  onState(sel);

  const onKey = (e: KeyboardEvent) => {
    const el = document.activeElement;
    const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    if (e.key === "`" && !typing) {
      e.preventDefault();
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    }
  };
  window.addEventListener("keydown", onKey);

  return () => {
    window.removeEventListener("keydown", onKey);
    panel.remove();
  };
}
