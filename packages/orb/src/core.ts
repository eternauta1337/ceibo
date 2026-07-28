// Core de la orbe — WebGL vanilla (sin framework). Anillos de contorno topográficos
// deformados por ruido 3D domain-warped (ondulación) + picos de frecuencia (visualizador de
// audio). TODO está parametrizado por estado vía OrbConfig; el orbe interpola entre los sets
// al transicionar. La app (React) y el harness (sandbox) usan este mismo core.
//
// Perf en prod: buffer fijo chico, una sola pasada (sin post/FBO), y el loop se PAUSA cuando
// la pestaña/orbe no está visible. El costo de iterar vive en el harness, no en prod.

import { pickDirection, pickRotationStep } from "./rotation.ts";
import {
  ORB_SHAPES,
  type OrbConfig,
  type OrbShape,
  type OrbState,
  type ShapeGeom,
  type StateParams,
} from "./types.ts";

export function orbWebGLSupported(): boolean {
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl") || c.getContext("experimental-webgl"));
  } catch {
    return false;
  }
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const NBINS = 64;

const VS = "attribute vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }";

const FS = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform vec2  iResolution;
uniform float u_phase; // fase acumulada del campo (NO iTime·spd → cambiar spd no salta)
uniform float u_amp, u_freq, u_warp, u_con;
uniform float u_scale, u_rInner, u_rOuter, u_gap, u_lineW;
uniform float u_comp, u_glow, u_micGain, u_micW;
uniform float u_poly, u_sides; // morph a polígono + nº de lados (ciclado por JS)
uniform float u_star;          // 0=forma limpia; >0 agrega puntas/pétalos (estrellas, flores)
uniform float u_rot;           // ángulo de rotación acumulado
uniform float u_mask;          // 1 = máscara redonda (el glow no pega contra el cuadrado)
uniform float u_lwFloor;       // piso de ancho de línea (×aa); 0 = líneas finas (orbe principal)
uniform vec2  u_offset;        // satélite: centro del mini-orb en espacio p0 ([-1,1]); (0,0)=centrado
uniform float u_satScale;      // satélite: radio del mini-orb en p0 (1=orbe principal a tamaño full)
uniform float u_alpha;         // multiplicador global de alpha (fade in/out de los mini-orbs; 1=full)
uniform float u_disc;          // 1 = mini-orb SÓLIDO (disco + glow), sin anillos/ruido/forma (barato)
uniform vec3  u_color;
uniform float u_fft[64];
uniform float u_fang[64];

const float PI = 3.14159265;
const float TWO_PI = 6.2831853;

float hash3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123); }
float noise3(vec3 x){
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i + vec3(0.0,0.0,0.0)), hash3(i + vec3(1.0,0.0,0.0)), f.x),
        mix(hash3(i + vec3(0.0,1.0,0.0)), hash3(i + vec3(1.0,1.0,0.0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0.0,0.0,1.0)), hash3(i + vec3(1.0,0.0,1.0)), f.x),
        mix(hash3(i + vec3(0.0,1.0,1.0)), hash3(i + vec3(1.0,1.0,1.0)), f.x), f.y),
    f.z);
}
float fbm3(vec3 p){
  // 2 octavas (antes 3): la octava más fina casi no se nota en el orbe pero es ~1/3 del costo del
  // ruido — la operación MÁS cara del shader (corre por píxel, cada frame). Menos octavas = frames
  // más baratos en mobile sin cambiar la silueta de la ondulación.
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 2; i++){ v += a * noise3(p); p *= 2.0; a *= 0.5; }
  return v;
}
float warpField(vec2 sp, float tt){
  vec3 P = vec3(sp, tt);
  vec2 q = vec2(fbm3(P), fbm3(P + vec3(5.2, 1.3, 0.0)));
  float f = fbm3(P + vec3(u_warp * q, 0.0));
  return clamp((f - 0.5) * u_con + 0.5, 0.0, 1.0);
}
float spikeField(float ang){
  float v = 0.0;
  for (int i = 0; i < 64; i++){
    float d = mod(ang - u_fang[i] + PI, TWO_PI) - PI;
    v += u_fft[i] * exp(-(d * d) / (u_micW * u_micW));
  }
  return v;
}
// "radio" de un n-gono regular circunscrito en length(q): iso-valor const -> n-gono.
float polyR(vec2 q, float n){
  float seg = TWO_PI / n;
  float ang = atan(q.y, q.x);
  float tm = ang - seg * floor(0.5 + ang / seg); // ángulo al vértice más cercano [-seg/2,seg/2]
  return length(q) * cos(tm) / cos(seg * 0.5);
}

void main(){
  float res = min(iResolution.x, iResolution.y);
  vec2 p0raw = (gl_FragCoord.xy * 2.0 - iResolution.xy) / res;
  // Espacio LOCAL del orb: el principal usa offset=0, satScale=1 → p0 = p0raw (idéntico a antes).
  // Un mini-orb (satélite) se dibuja con offset != 0 y satScale < 1: trasladamos y "zoomeamos"
  // dentro de su disco, así TODO el resto del shader (forma, anillos, glow, máscara) computa como
  // si el orb estuviera centrado, a su tamaño chico. La máscara redonda usa este p0 local.
  vec2 p0 = (p0raw - u_offset) / max(u_satScale, 0.0001);

  // Mini-orb SÓLIDO (sub-agente): disco lleno + halo radial. Sale ACÁ, antes del ruido fbm y del
  // loop de frecuencias → un mini-orb cuesta unos pocos ops por píxel (no la pasada completa). El
  // tamaño/posición ya vienen por u_offset/u_satScale; el color y el fade por u_color/u_alpha.
  if (u_disc > 0.5) {
    float rd = length(p0);
    float aad = fwidth(rd);
    float R = 0.62;                                   // radio del disco en espacio p0 local
    float discA = 1.0 - smoothstep(R - aad, R + aad, rd);
    float halo = exp(-pow((rd - R) / 0.20, 2.0)) * (u_glow * 0.6); // "poquito de glow"
    float aDisc = max(clamp(discA, 0.0, 1.0), clamp(halo, 0.0, 1.0));
    float maskD = 1.0 - smoothstep(0.86, 1.0, rd);   // se desvanece antes del borde del sub-canvas
    gl_FragColor = vec4(u_color, aDisc * maskD * u_alpha);
    return;
  }

  float effScale = u_scale * (1.0 + 1.2 * u_comp); // compresión achica el orbe
  vec2 p = p0 * effScale;
  float cs = cos(u_rot), sn = sin(u_rot); // rotación del orbe (al pensar)
  p = mat2(cs, -sn, sn, cs) * p;
  float a = atan(p.y, p.x);
  // forma base: círculo o n-gono (morph entre lados consecutivos para transición suave)…
  float ns = max(3.0, u_sides);
  float pr = mix(polyR(p, floor(ns)), polyR(p, floor(ns) + 1.0), fract(ns));
  float r = mix(length(p), pr, u_poly);
  // …+ modulación de pétalos/puntas (u_star): bulto hacia afuera en cada vértice → estrellas
  // (sobre n-gono) y flores (sobre círculo). u_star=0 → forma limpia.
  r *= 1.0 - u_star * 0.5 * cos(u_sides * a);

  vec2 sp = p * u_freq;
  float field = warpField(sp, u_phase);
  float wDisp = (field - 0.5) * u_amp;
  // El visualizador de frecuencias (loop de 64 iter por píxel) SÓLO aporta cuando hay audio
  // (micGain>0). En reposo/pensando micGain=0 → saltamos el loop entero en vez de multiplicar por 0.
  float sDisp = u_micGain > 0.0001 ? spikeField(a) * u_micGain : 0.0;
  float disp = (wDisp + sDisp) * (0.35 + 0.65 * r);

  float rr = r - disp;

  float rinner = u_rInner * (1.0 - u_comp);
  float gap = u_gap * (1.0 - 0.45 * u_comp);
  float g = (rr - rinner) / gap;
  float aa = fwidth(g);
  float dl = abs(fract(g) - 0.5);
  // piso de ancho en espacio-pantalla (SOLO mini): la línea no baja de ~aa·u_lwFloor px, así no
  // aliasa al achicarse. En el orbe principal u_lwFloor=0 → líneas finas originales.
  float lw = min(0.42, max(u_lineW, aa * u_lwFloor));
  float line = 1.0 - smoothstep(lw, lw + aa * 1.2, dl);
  float er = fwidth(rr);
  float band = smoothstep(rinner - er, rinner + er, rr) * (1.0 - smoothstep(u_rOuter - er, u_rOuter + er, rr));
  line *= band;

  float solidDisc = 1.0 - smoothstep(u_rOuter - er, u_rOuter + er * 1.5, rr);
  float cover = mix(line, solidDisc, smoothstep(0.78, 1.0, u_comp));

  // glow: halo por línea + bloom radial que se extiende más allá del borde.
  float lineHalo = exp(-(dl * dl) / 0.14) * band;
  float rb = r / u_rOuter - 1.0;
  float ringBloom = exp(-(rb * rb) / 0.15);
  float glowA = (lineHalo * 0.45 + ringBloom * 0.7) * (u_glow * 0.11); // -50% (era 0.22)

  float alpha = max(clamp(cover, 0.0, 1.0), clamp(glowA, 0.0, 1.0));

  // máscara redonda (mini): todo se desvanece en un círculo antes del borde del canvas, así
  // el glow no se corta como un cuadrado. En el orbe principal u_mask=0 (no hace falta).
  float maskF = mix(1.0, 1.0 - smoothstep(0.82, 0.99, length(p0)), u_mask);
  gl_FragColor = vec4(u_color, alpha * maskF * u_alpha);
}
`;

const NUM_KEYS: (keyof StateParams)[] = [
  "amp",
  "freq",
  "spd",
  "warp",
  "con",
  "scale",
  "rInner",
  "rOuter",
  "rings",
  "lineW",
  "comp",
  "glow",
  "micGain",
  "micW",
  "spkWidth",
  "poly",
  "rot",
  "rotRand",
  "rotSpeed",
];

function cloneParams(p: StateParams): StateParams {
  return { ...p, color: [...p.color] as StateParams["color"] };
}

export type Orb = {
  setState(s: OrbState): void;
  setShape(shape: OrbShape): void; // forma geométrica = estado del agente (ya no es random)
  setSubagents(count: number): void; // N mini-orbs decorando el orb = N sub-agentes activos
  setConfig(c: OrbConfig): void;
  current(): StateParams; // params interpolados ahora mismo (para el panel)
  dispose(): void;
};

export function createOrb(
  canvas: HTMLCanvasElement,
  opts: {
    config: OrbConfig;
    getLevel?: (s: OrbState) => number;
    initialState?: OrbState;
    buf?: number;
    scaleOverride?: number; // mini: fuerza un tamaño consistente (ignora el scale por estado)
    mask?: boolean; // mini: máscara redonda para que el glow no pegue contra el cuadrado
    ringsOverride?: number; // mini: menos anillos (más espaciados) que el config por estado
    lineWScale?: number; // mini: engrosa la línea (×) sobre el lineW por estado
    lwFloor?: number; // mini: piso de ancho (×aa) anti-aliasing; 0/undef = líneas finas
    motionSeed?: number; // sincroniza rotación/forma entre canvas de líneas y canvas de fondo
    maxDpr?: number; // tope del multiplicador de DPR del backbuffer (default 2). El fragment shader
    // es O(píxeles): bajar el cap reduce el trabajo por frame SIN tocar la fluidez (60fps) ni la
    // latencia. En mobile ~1.5 alcanza para el tamaño real del orbe y baja bastante el costo.
    onFps?: (fps: number) => void; // diagnóstico: fps de cuadros DIBUJADOS, ~2×/seg (HUD de debug)
  },
): Orb | null {
  const o = { antialias: true, alpha: true, premultipliedAlpha: false };
  const gl = (canvas.getContext("webgl", o) ||
    canvas.getContext("experimental-webgl", o)) as WebGLRenderingContext | null;
  if (!gl) return null;
  gl.getExtension("OES_standard_derivatives");
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) throw new Error("no shader");
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "compile");
    return s;
  };

  let prog: WebGLProgram;
  try {
    prog = gl.createProgram() as WebGLProgram;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link");
  } catch {
    return null;
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = (n: string) => gl.getUniformLocation(prog, n);
  const uRes = u("iResolution"),
    uPhase = u("u_phase");
  const uAmp = u("u_amp"),
    uFreq = u("u_freq"),
    uWarp = u("u_warp"),
    uCon = u("u_con");
  const uScale = u("u_scale"),
    uRInner = u("u_rInner"),
    uROuter = u("u_rOuter"),
    uGap = u("u_gap"),
    uLineW = u("u_lineW");
  const uComp = u("u_comp"),
    uGlow = u("u_glow"),
    uMicGain = u("u_micGain"),
    uMicW = u("u_micW");
  const uPoly = u("u_poly"),
    uSides = u("u_sides"),
    uStar = u("u_star"),
    uRot = u("u_rot"),
    uMask = u("u_mask"),
    uLwFloor = u("u_lwFloor");
  const uOffset = u("u_offset"),
    uSatScale = u("u_satScale"),
    uAlpha = u("u_alpha"),
    uDisc = u("u_disc");
  const uColor = u("u_color"),
    uFft = u("u_fft"),
    uFang = u("u_fang");

  // ángulos aleatorios por banda (permutación → sin clusters)
  const fang = new Float32Array(NBINS);
  const idx = Array.from({ length: NBINS }, (_, i) => i);
  for (let i = NBINS - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = idx[i] as number;
    idx[i] = idx[j] as number;
    idx[j] = t;
  }
  for (let i = 0; i < NBINS; i++) fang[i] = ((idx[i] as number) / NBINS) * Math.PI * 2;
  gl.uniform1fv(uFang, fang);

  const BUF = Math.round((opts.buf ?? 512) * Math.min(window.devicePixelRatio || 1, opts.maxDpr ?? 2));
  canvas.width = BUF;
  canvas.height = BUF;
  gl.viewport(0, 0, BUF, BUF);
  // Limpieza SÍNCRONA del backbuffer (transparente) ya, antes de devolver el orbe y antes de
  // que el browser componga el canvas por primera vez. El primer gl.clear/draw "real" vive en
  // el rAF (≥1 frame después de montar); en ese hueco algunos drivers muestran el backbuffer
  // recién creado como un cuadrado OPACO (blanco) → ése es el flash. Clarear acá garantiza que
  // cualquier composición previa al primer frame sea transparente, no blanca.
  gl.clear(gl.COLOR_BUFFER_BIT);

  let config = opts.config;
  let state: OrbState = opts.initialState ?? "unavailable";
  const getLevel = opts.getLevel ?? (() => 0);
  const cur = cloneParams(config[state]); // params interpolados (mutable)
  const fftArr = new Float32Array(NBINS);
  let level = 0;
  let first = true;
  let raf = 0;
  let running = true;
  let phase = 0; // fase acumulada del campo de ruido (continua aunque cambie spd)
  let lastT = 0;
  let fpsFrames = 0; // cuadros dibujados desde el último reporte (medidor de fps de diagnóstico)
  let fpsWinT = 0; // inicio (s) de la ventana de medición de fps
  // Settle: tras unos segundos SIN actividad en reposo, la ondulación se desvanece a 0 → círculo
  // perfecto y quieto. NO congelamos el loop (sigue a 60fps → responde al toque al instante); sólo
  // dejamos de mover el campo de ruido. Reactivos (recording/speaking), pensando o con sub-agentes
  // resetean el cronómetro (nunca se asientan).
  const SETTLE_DELAY = 1.6; // seg sin actividad antes de empezar a aquietarse
  const SETTLE_RAMP = 1.4; // seg que tarda la ondulación en irse a 0
  let calm = 0; // 0 = ondulación full · 1 = quieto (círculo perfecto)
  let lastActivityT = 0; // nowT() de la última actividad (driver del settle)
  // El canvas arranca invisible (opacity:0 inline + CSS) y se revela recién cuando YA hay un
  // frame del orbe presentado en pantalla, para no ver el "cuadrado blanco" del lienzo. Revelamos
  // al SEGUNDO frame pintado, no al primero: si flipeáramos opacity en el mismo frame del primer
  // draw, el compositor puede tomar el cambio de opacity ANTES del swap del backbuffer de WebGL
  // → un frame de "opacity:1 + buffer todavía sin pintar" = el flash blanco intermitente.
  let painted = 0;
  // Figura geométrica = ESTADO del agente (NO random). La forma objetivo la setea quien usa el
  // orbe vía setShape() (la web la deriva de status/activity/sub-agente; ver agentShape.ts). Al
  // cambiar de forma el orbe morfea entre la actual y la nueva con ease-in-out + un paso de
  // rotación. Cada forma = {poly: 0 círculo / 1 n-gono, sides, star (0 en las formas-por-estado)}.
  const t0 = performance.now();
  const nowT = () => (performance.now() - t0) / 1000;
  const TWEEN_DUR = 0.45; // morph de forma (poly/sides/star), ease-in-out
  const ROT_STEP_DUR = 0.55; // duración del giro rápido (seg). "Rápido" = esta vez corta + ease-out.

  // --- Maquinaria de FORMA + ROTACIÓN del estado "pensando" -----------------------------------
  // Una instancia por orbe: la usa el orb PRINCIPAL y TAMBIÉN cada satélite (sub-agente vivo) — la
  // MISMA lógica, no una aproximación. Combina:
  //  · morph de forma (poly/sides/star) hacia la forma objetivo con ease-in-out (shapeTween);
  //  · giro RÁPIDO random (ease-OUT) en cada cambio de sub-fase: un DELTA con signo, sumado → el
  //    camino respeta el sentido (no va por "el lado más corto"); magnitud/signo al azar (kick);
  //  · deriva LENTA continua dentro de la fase, sentido CW/CCW re-sorteado en cada kick (step()).
  // El consumidor llama shapeTween()/kick() en cada transición y step() una vez por frame.
  type Motion = {
    readonly curShape: ShapeGeom;
    shapeTween(sh: ShapeGeom): void;
    kick(rotMag: number, rotRand: number): void;
    step(t: number, dt: number, rotSpeed: number): { poly: number; sides: number; star: number; rot: number };
  };
  // `seedRot`: orientación de rotación inicial (fase). El orb principal arranca en 0; cada satélite
  // con una fase random → no giran sincronizados.
  const motionRandom = opts.motionSeed === undefined ? Math.random : seededRandom(opts.motionSeed);
  const makeMotion = (seedRot = 0, rng: () => number = Math.random): Motion => {
    let polyFrom = 0,
      polyTo = 0,
      polyEased = 0;
    let sidesFrom = 3,
      sidesTo = 3,
      sidesEased = 3;
    let starFrom = 0,
      starTo = 0,
      starEased = 0;
    let tweenStart = -10;
    let rotStepFrom = 0,
      rotStepTo = 0,
      rotStepEased = 0;
    let rotStepStart = -10;
    let drift = seedRot;
    let driftDir: 1 | -1 = 1;
    let curShape: ShapeGeom = ORB_SHAPES.circle; // arranca en círculo (reposo)
    return {
      get curShape() {
        return curShape;
      },
      // Morph hacia `sh`: el "desde" es el valor EASED actual (continuo, sin saltos aunque cambie a
      // mitad de transición). La rotación va por separado (kick).
      shapeTween(sh) {
        polyFrom = polyEased;
        polyTo = sh.poly;
        sidesFrom = sidesEased;
        sidesTo = sh.sides;
        starFrom = starEased;
        starTo = sh.star;
        tweenStart = nowT();
        curShape = sh;
      },
      // Giro rápido hacia una posición random + re-sorteo del sentido de la deriva. Magnitud
      // rotMag/rotRand (0 en estados sin rotación → step 0 = sin giro). Idempotente dentro del mismo
      // frame (rotStepEased no avanzó): setState+setShape pueden llamarlo juntos y se ve UN solo giro.
      kick(rotMag, rotRand) {
        const step = pickRotationStep(rng, rotMag, rotRand);
        rotStepFrom = rotStepEased;
        rotStepTo = rotStepEased + step;
        rotStepStart = nowT();
        driftDir = pickDirection(rng);
      },
      // Avanza un frame y devuelve los valores eased que consume el shader.
      step(t, dt, rotSpeed) {
        const tw = Math.min(1, Math.max(0, (t - tweenStart) / TWEEN_DUR));
        const easeIO = tw * tw * (3 - 2 * tw); // smoothstep = ease-in-out
        polyEased = polyFrom + (polyTo - polyFrom) * easeIO;
        sidesEased = sidesFrom + (sidesTo - sidesFrom) * easeIO;
        starEased = starFrom + (starTo - starFrom) * easeIO;
        const rtw = Math.min(1, Math.max(0, (t - rotStepStart) / ROT_STEP_DUR));
        const easeOut = 1 - (1 - rtw) * (1 - rtw); // cuadrática ease-out: rápido al inicio
        rotStepEased = rotStepFrom + (rotStepTo - rotStepFrom) * easeOut;
        drift += dt * rotSpeed * driftDir; // lenta mientras está en el estado (rotSpeed=0 → quieta)
        return { poly: polyEased, sides: sidesEased, star: starEased, rot: rotStepEased + drift };
      },
    };
  };
  const motion = makeMotion(0, motionRandom); // forma + rotación del orb principal

  // --- Mini-orbs (satélites) = sub-agentes activos --------------------------------------------
  // N mini-orbs decoran el orb principal: uno por sub-agente vivo. Aparecen al spawnear (fade-in +
  // pop de escala) y se van al terminar (fade-out). Se dibujan en el MISMO canvas/shader, en pasadas
  // extra con offset/escala/alpha por satélite (ver `frame`). El conteo lo setea setSubagents().
  const SAT_SIZE = 0.038; // radio de cada mini-orb en p0 (disco satélite) — 20% del tamaño previo (0.19)
  const SAT_R_MIN = 0.56; // radio mínimo de órbita en espacio p0
  const SAT_R_MAX = 0.94; // radio máximo de órbita en espacio p0
  const SAT_R_JIT = 0.015; // jitter dentro de cada estrato (toque orgánico; pequeño para no colapsar la separación)
  const SAT_DRIFT = 0.18; // velocidad de la deriva angular de la órbita (rad/seg)
  const SAT_GLOW = 1.3; // intensidad del halo del disco (u_glow de la pasada del mini-orb)
  // Cada sub-agente vivo = un disco sólido con glow que orbita el orb. Estado mínimo: ángulo base
  // (posición en la órbita), radio de órbita propio y estable, y el alpha del fade-in/out hacia
  // `target` (1/0). Cada satélite recibe un orbitR distinto al spawnear (estratificado con jitter)
  // → las órbitas se ven a distancias notoriamente distintas, no agrupadas en un único anillo.
  type Sat = {
    baseAngle: number;
    orbitR: number; // radio de la órbita asignado al spawnear (estable durante la vida del satélite)
    alpha: number;
    target: number;
  };
  let sats: Sat[] = [];
  let subTarget = 0; // cantidad deseada de mini-orbs (= sub-agentes activos)
  let satDrift = 0; // ángulo acumulado de la deriva de la órbita
  // Asigna radios de órbita estratificados al conjunto completo de satélites activos: divide el
  // rango [SAT_R_MIN, SAT_R_MAX] en N estratos iguales y da uno a cada satélite (con jitter dentro
  // del estrato). Resultado: con 2–4 satélites las órbitas siempre se ven claramente separadas, sin
  // chance de que dos caigan casi al mismo radio (lo que ocurre con puro random).
  const reassignOrbitRadii = () => {
    const active = sats.filter((s) => s.target === 1);
    const n = active.length;
    if (n === 0) return;
    const span = SAT_R_MAX - SAT_R_MIN;
    const stride = span / n;
    // Baraja los índices de estrato → el orden no es siempre "el más cercano al 1er satélite
    // es el más chico"; evita que el primer satélite que aparece siempre orbite más cerca.
    const indices = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = indices[i] as number;
      indices[i] = indices[j] as number;
      indices[j] = tmp;
    }
    for (let i = 0; i < n; i++) {
      const stratum = indices[i] as number;
      const base = SAT_R_MIN + stratum * stride + stride * 0.5; // centro del estrato
      const jit = (Math.random() * 2 - 1) * SAT_R_JIT; // jitter orgánico dentro del estrato
      (active[i] as Sat).orbitR = Math.min(SAT_R_MAX, Math.max(SAT_R_MIN, base + jit));
    }
  };
  // Reconcilia la lista de satélites con `subTarget`: agrega los que falten (fade-in desde alpha 0)
  // o marca para fade-out (target 0) los sobrantes. Redistribuye los radios en cada cambio para
  // mantener la separación visual con cualquier cantidad de satélites activos.
  const reconcileSats = () => {
    const active = sats.filter((s) => s.target === 1).length;
    if (subTarget > active) {
      for (let i = 0; i < subTarget - active; i++) {
        sats.push({
          baseAngle: Math.random() * Math.PI * 2,
          orbitR: (SAT_R_MIN + SAT_R_MAX) / 2, // placeholder: reassignOrbitRadii lo reemplaza
          alpha: 0,
          target: 1,
        });
      }
      reassignOrbitRadii(); // redistribuye radios con el nuevo conjunto
    } else if (subTarget < active) {
      let toRemove = active - subTarget;
      // Fade-out de los últimos activos (LIFO): el último en aparecer es el primero en irse.
      for (let i = sats.length - 1; i >= 0 && toRemove > 0; i--) {
        const s = sats[i] as Sat;
        if (s.target === 1) {
          s.target = 0;
          toRemove--;
        }
      }
      reassignOrbitRadii(); // redistribuye los que quedan activos
    }
  };

  const frame = () => {
    if (!running) return;
    const t = (performance.now() - t0) / 1000;
    // Dibujamos en CADA rAF (la pantalla pone el techo por vsync). Antes había un cap "30fps" en
    // reposo con un umbral de tiempo contra el rAF de 60Hz que, por el jitter, degeneraba a dibujar
    // 1 de cada 3 frames → ~20fps entrecortados (peor que no capear). El idle hace menos trabajo que
    // hablar (sin el loop de frecuencias), y hablar ya corre a 60 → reposo también: queda parejo.
    // Medidor de fps (diagnóstico): cuenta cuadros DIBUJADOS y reporta ~2×/seg vía onFps.
    if (opts.onFps) {
      fpsFrames++;
      if (fpsWinT === 0) fpsWinT = t;
      else if (t - fpsWinT >= 0.5) {
        opts.onFps(fpsFrames / (t - fpsWinT));
        fpsFrames = 0;
        fpsWinT = t;
      }
    }
    const tgt = config[state];

    // Settle: ¿hay "actividad" (no debe aquietarse)? Reactivos (audio), pensando, o con sub-agentes
    // vivos animan siempre → reseteamos el cronómetro. En reposo, tras SETTLE_DELAY la ondulación se
    // desvanece (calm 0→1 en SETTLE_RAMP) hasta el círculo perfecto. El loop sigue corriendo.
    const animated =
      state === "recording" ||
      state === "speaking" ||
      state === "thinking" ||
      subTarget > 0 ||
      sats.length > 0;
    if (animated || first) lastActivityT = t;
    calm = Math.min(1, Math.max(0, (t - lastActivityT - SETTLE_DELAY) / SETTLE_RAMP));

    // ease todos los params numéricos + color hacia el estado actual (snap en el 1er frame)
    const c = cur as unknown as Record<string, number>;
    const tg = tgt as unknown as Record<string, number>;
    for (const k of NUM_KEYS) {
      const a = c[k] ?? 0;
      const b = tg[k] ?? 0;
      c[k] = first ? b : a + (b - a) * 0.08;
    }
    for (let i = 0; i < 3; i++) {
      const a = cur.color[i] ?? 0;
      const b = tgt.color[i] ?? 0;
      cur.color[i] = first ? b : a + (b - a) * 0.08;
    }
    const lvl = getLevel(state);
    level = first ? lvl : level + (lvl - level) * 0.18;
    first = false;

    // fase acumulada: el ritmo lo da la velocidad EASED, sin saltar al cambiar de estado.
    // dt clampeado para no pegar un salto al volver de una pausa (visibility).
    const dt = Math.min(0.05, t - lastT);
    lastT = t;
    phase += dt * cur.spd * (1 - calm); // al aquietarse, la ondulación deja de avanzar

    // Figura geométrica + rotación del orb principal (morfea hacia la forma de setShape + giro/
    // deriva): la MISMA maquinaria que después corre cada satélite (ver makeMotion).
    const m = motion.step(t, dt, cur.rotSpeed);
    satDrift += dt * SAT_DRIFT; // deriva continua de la órbita de los mini-orbs

    // espectro sintético desde el nivel escalar (shimmer por banda → se ve rico en frecuencias)
    for (let i = 0; i < NBINS; i++) {
      const shimmer = 0.5 + 0.5 * Math.sin(t * 6.0 + i * 1.3) * Math.sin(t * 2.7 + i * 0.7);
      const v = Math.min(1, level * (0.3 + 1.5 * shimmer));
      const prev = fftArr[i] ?? 0;
      fftArr[i] = prev + (v - prev) * 0.4;
    }

    const rings = opts.ringsOverride ?? cur.rings;
    const gapV = (cur.rOuter - cur.rInner) / Math.max(1, rings);
    const effLineW = Math.min(0.3, cur.lineW * (opts.lineWScale ?? 1) * (1 + level * cur.spkWidth));

    gl.uniform2f(uRes, BUF, BUF);
    gl.uniform1f(uPhase, phase);
    gl.uniform1f(uAmp, cur.amp * (1 - calm)); // settle: la ondulación cae a 0 → círculo perfecto
    gl.uniform1f(uFreq, cur.freq);
    gl.uniform1f(uWarp, cur.warp);
    gl.uniform1f(uCon, cur.con);
    gl.uniform1f(uScale, opts.scaleOverride ?? cur.scale);
    gl.uniform1f(uRInner, cur.rInner);
    gl.uniform1f(uROuter, cur.rOuter);
    gl.uniform1f(uGap, gapV);
    gl.uniform1f(uLineW, effLineW);
    gl.uniform1f(uComp, cur.comp);
    gl.uniform1f(uGlow, cur.glow);
    gl.uniform1f(uMicGain, cur.micGain);
    gl.uniform1f(uMicW, cur.micW);
    // gate por estado: solo los estados con poly>0 (pensando) ciclan formas; el resto = círculo.
    gl.uniform1f(uPoly, cur.poly * m.poly);
    gl.uniform1f(uSides, m.sides);
    gl.uniform1f(uStar, cur.poly * m.star);
    gl.uniform1f(uRot, m.rot);
    gl.uniform1f(uMask, opts.mask ? 1 : 0);
    gl.uniform1f(uLwFloor, opts.lwFloor ?? 0);
    gl.uniform3f(uColor, cur.color[0], cur.color[1], cur.color[2]);
    gl.uniform1fv(uFft, fftArr);

    gl.clear(gl.COLOR_BUFFER_BIT);

    // Orb principal: sin offset, tamaño full, alpha full, disc OFF (anillos completos).
    gl.uniform1f(uDisc, 0);
    gl.uniform2f(uOffset, 0, 0);
    gl.uniform1f(uSatScale, 1);
    gl.uniform1f(uAlpha, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // --- Mini-orbs (satélites) = sub-agentes vivos -------------------------------------------
    // Cada sub-agente = un DISCO sólido con un poco de glow que orbita el orb principal. Animación
    // mínima: orbitan (deriva lenta compartida) y hacen fade-in/out; SIN anillos, ruido, morph de
    // forma ni rotación → la pasada del disco (u_disc=1) cuesta unos pocos ops por píxel. El color
    // lo heredan de la pasada principal (`cur.color`) → respeta el tema. Scissor a su bbox.
    if (sats.length) {
      for (const s of sats) s.alpha += (s.target - s.alpha) * 0.12;
      sats = sats.filter((s) => s.target === 1 || s.alpha > 0.01);
    }
    if (sats.length) {
      gl.uniform1f(uDisc, 1);
      gl.uniform1f(uGlow, SAT_GLOW);
      gl.enable(gl.SCISSOR_TEST);
      for (const s of sats) {
        const ang = s.baseAngle + satDrift;
        const R = s.orbitR;
        const sx = Math.cos(ang) * R;
        const sy = Math.sin(ang) * R;
        // pop: el disco crece un poco al aparecer (escala ligada al alpha) → entrada orgánica.
        const satScale = SAT_SIZE * (0.55 + 0.45 * s.alpha);
        gl.uniform2f(uOffset, sx, sy);
        gl.uniform1f(uSatScale, satScale);
        gl.uniform1f(uAlpha, s.alpha);
        // scissor a la bbox del satélite en píxeles (origen abajo-izq en WebGL). p0 unidad = BUF/2 px.
        const prPix = satScale * (BUF / 2) * 1.08;
        const cxPix = ((sx + 1) / 2) * BUF;
        const cyPix = ((sy + 1) / 2) * BUF;
        gl.scissor(
          Math.floor(cxPix - prPix),
          Math.floor(cyPix - prPix),
          Math.ceil(prPix * 2),
          Math.ceil(prPix * 2),
        );
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.SCISSOR_TEST);
      gl.uniform1f(uDisc, 0);
    }
    if (painted < 2) {
      painted++;
      // recién con el 1er frame YA presentado (en el 2º) revelamos → la CSS hace el fade
      if (painted === 2) canvas.style.opacity = "1";
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  const onVis = () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(raf);
    } else if (!running) {
      running = true;
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener("visibilitychange", onVis);

  return {
    setState(s) {
      // Cambio de estado → giro rápido a una posición random (no-op si el estado no rota).
      if (s !== state) {
        state = s;
        motion.kick(config[s].rot, config[s].rotRand);
      }
    },
    setShape(shape) {
      const sh = ORB_SHAPES[shape] ?? ORB_SHAPES.circle;
      const cs = motion.curShape;
      // Sin cambio real → no re-disparamos morph ni giro (evita "temblar" si el consumidor llama
      // setShape con la misma forma en cada render).
      if (sh.poly === cs.poly && sh.sides === cs.sides && sh.star === cs.star) return;
      motion.shapeTween(sh);
      motion.kick(config[state].rot, config[state].rotRand); // cambio de sub-fase → otro giro random
    },
    setSubagents(count) {
      const n = Math.max(0, Math.floor(count));
      if (n === subTarget) return; // sin cambio → no re-reconciliamos
      subTarget = n;
      reconcileSats();
    },
    setConfig(c) {
      config = c;
    },
    current() {
      return cur;
    },
    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
    },
  };
}
