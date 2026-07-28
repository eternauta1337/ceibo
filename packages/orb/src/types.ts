// Tipos y metadata de la orbe. La config es POR ESTADO: cada estado tiene su set completo de
// parámetros; el orbe interpola entre sets al transicionar. El harness (sandbox) edita por
// estado y guarda `orb.config.json`, que la app importa directo (una sola fuente de verdad).

export type OrbState = "idle" | "recording" | "thinking" | "speaking" | "unavailable";

export const ORB_STATES: OrbState[] = ["idle", "recording", "thinking", "speaking", "unavailable"];

export type Rgb = [number, number, number];

export type StateParams = {
  amp: number; // amplitud de la ondulación (ruido)
  freq: number; // frecuencia del campo de ruido
  spd: number; // velocidad de evolución del campo
  warp: number; // domain-warp
  con: number; // contraste del campo
  scale: number; // tamaño⁻¹ (más alto = orbe más chico)
  rInner: number; // radio interno (el hueco)
  rOuter: number; // radio externo (borde del orbe)
  rings: number; // número de anillos (densidad)
  lineW: number; // grosor de línea (fracción del periodo)
  comp: number; // compresión 0..1 (1 = disco sólido)
  glow: number; // intensidad del glow
  micGain: number; // amplitud de los picos de audio (0 = sin reacción)
  micW: number; // ancho/foco de cada pico
  spkWidth: number; // cuánto engrosa la línea con el volumen
  poly: number; // 0=círculo, 1=polígono; los lados ciclan triángulo→cuadrado→pentágono
  rot: number; // magnitud BASE del giro rápido por cambio de estado/forma (rad; +rotRand random; signo random)
  rotRand: number; // rango EXTRA random del giro rápido (rad): el step real = rot + random·rotRand
  rotSpeed: number; // deriva LENTA continua mientras está en el estado (rad/seg; signo random por transición)
  color: Rgb; // color de las líneas (y del glow)
};

export type OrbConfig = Record<OrbState, StateParams>;

// --- Formas geométricas POR ESTADO -------------------------------------------------------
// La figura del orbe ya NO es random: cada forma comunica QUÉ está haciendo el agente (mapeo en
// `@ceibo/web` → agentShape.ts). Preferencia del owner: GEOMÉTRICAS de líneas rectas (triángulo,
// cuadrado, …), nunca pétalos/estrellas → `star` es SIEMPRE 0 acá. El nº de lados crece con la
// "carga" de lo que ocurre: círculo en reposo/IO, polígonos al computar (más vértices = trabajo
// más pesado). El orbe morfea entre formas con ease-in-out + un giro rápido random (ver core.ts).
// El vocabulario es por TIERS (rangos de lados, sin solaparse) para dar variabilidad sin perder
// la lectura de "más pesado = más vértices": pensar 3–4 · tool 5–6 · sub-agente 7–8 (ver
// `@ceibo/web` → agentShape.ts, que elige random dentro del tier en cada transición).
export type OrbShape = "circle" | "triangle" | "square" | "pentagon" | "hexagon" | "heptagon" | "octagon";

/** Geometría de una forma: `poly` 0=círculo / 1=polígono, `sides` nº de lados (≥3), `star`
 *  puntas/pétalos (0 en todas las formas-por-estado: líneas rectas, sin curvas). */
export interface ShapeGeom {
  poly: number;
  sides: number;
  star: number;
}

/** Registro de formas → geometría. Es la fuente de verdad de "qué forma es cada cosa"; el
 *  mapeo estado-del-agente → nombre-de-forma vive en `@ceibo/web` (agentShape.ts, testeable). */
export const ORB_SHAPES: Record<OrbShape, ShapeGeom> = {
  circle: { poly: 0, sides: 3, star: 0 }, // reposo / escuchando / hablando (estados de I/O)
  triangle: { poly: 1, sides: 3, star: 0 }, // tier "pensar puro" (3–4)
  square: { poly: 1, sides: 4, star: 0 }, // tier "pensar puro" (3–4)
  pentagon: { poly: 1, sides: 5, star: 0 }, // tier "tool" (5–6)
  hexagon: { poly: 1, sides: 6, star: 0 }, // tier "tool" (5–6)
  heptagon: { poly: 1, sides: 7, star: 0 }, // tier "sub-agente" (7–8)
  octagon: { poly: 1, sides: 8, star: 0 }, // tier "sub-agente" (7–8)
};

// Metadata para el panel: rango y label de cada slider (color va aparte).
export const PARAM_META: { key: keyof StateParams; min: number; max: number; step: number; label: string }[] =
  [
    { key: "amp", min: 0, max: 0.8, step: 0.01, label: "amplitud" },
    { key: "freq", min: 0.3, max: 3.0, step: 0.05, label: "frecuencia" },
    { key: "spd", min: 0, max: 0.8, step: 0.005, label: "velocidad" },
    { key: "warp", min: 0, max: 3.0, step: 0.05, label: "warp" },
    { key: "con", min: 0.3, max: 3.5, step: 0.05, label: "contraste" },
    { key: "scale", min: 1.0, max: 3.0, step: 0.02, label: "tamaño⁻¹" },
    { key: "rInner", min: 0.0, max: 0.7, step: 0.01, label: "radio int" },
    { key: "rOuter", min: 0.4, max: 1.3, step: 0.01, label: "radio ext" },
    { key: "rings", min: 3, max: 40, step: 1, label: "anillos" },
    { key: "lineW", min: 0.01, max: 0.2, step: 0.005, label: "grosor" },
    { key: "comp", min: 0, max: 1.0, step: 0.02, label: "compresión" },
    { key: "glow", min: 0, max: 5.0, step: 0.05, label: "glow" },
    { key: "micGain", min: 0, max: 0.8, step: 0.01, label: "mic amp" },
    { key: "micW", min: 0.04, max: 0.4, step: 0.01, label: "mic foco" },
    { key: "spkWidth", min: 0, max: 6.0, step: 0.1, label: "grosor×voz" },
    { key: "poly", min: 0, max: 1.0, step: 0.05, label: "polígono" },
    { key: "rot", min: 0, max: 6.3, step: 0.05, label: "giro base" },
    { key: "rotRand", min: 0, max: 6.3, step: 0.05, label: "giro random" },
    { key: "rotSpeed", min: 0, max: 1.0, step: 0.01, label: "deriva/seg" },
  ];

// Base compartida (los valores tuneados); cada estado parte de acá y cambia lo suyo.
const BASE: StateParams = {
  amp: 0.43,
  freq: 0.85,
  spd: 0.225,
  warp: 3.0,
  con: 0.8,
  scale: 2.01,
  rInner: 0.3,
  rOuter: 0.96,
  rings: 15,
  lineW: 0.05,
  comp: 0,
  glow: 0,
  micGain: 0,
  micW: 0.11,
  spkWidth: 0,
  poly: 0,
  rot: 0,
  rotRand: 0,
  rotSpeed: 0,
  color: [1, 1, 1],
};

// Config por defecto (fallback si falta orb.config.json). Mapea el comportamiento actual de
// prod a params explícitos por estado.
export const DEFAULT_CONFIG: OrbConfig = {
  idle: { ...BASE },
  recording: { ...BASE, micGain: 0.22, spkWidth: 3 },
  thinking: { ...BASE, spd: 0.765, comp: 0.88, poly: 1, rot: 0.8, rotRand: 3.2, rotSpeed: 0.18 },
  speaking: { ...BASE, glow: 3.2, micGain: 0.22, spkWidth: 3 },
  unavailable: { ...BASE, amp: 0.258, spd: 0.0675, comp: 1 },
};
