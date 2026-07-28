// Wrapper React fino sobre @ceibo/orb. La lógica/shader vive en el package (una sola fuente
// de verdad, tuneable en el harness standalone). Acá solo: montar el canvas, mapear el estado
// del canal a un estado de orbe, y proveer el nivel de audio (mic al grabar, agente al hablar).
import { createOrb, type Orb, type OrbState, orbConfig, orbWebGLSupported } from "@ceibo/orb";
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import { shapeForAgent } from "./agentShape.ts";
import type { Status } from "./useChannel.ts";

// Handle imperativo del orbe: deja al consumidor (App) disparar el cambio de estado VISUAL
// SINCRÓNICO dentro del gesto (pointerdown), sin esperar el ciclo React→re-render→useEffect.
// `cue` llama directo al `setState` del engine: el orbe arranca a morfear en el MISMO frame del
// toque. El effect de `status` sigue siendo la fuente de verdad (re-aplica el estado real cuando
// React confirma); como `setState` es idempotente (no-op si el estado no cambió), no se duplica.
export type OrbHandle = { cue: (state: OrbState) => void };

// Diagnóstico de framerate del orbe: con el modo debug ON (localStorage ceibo_debugmode="1")
// mostramos un HUD con los fps reales de cuadros dibujados → para comparar números, no sensaciones.
function orbFpsDebugEnabled(): boolean {
  try {
    return localStorage.getItem("ceibo_debugmode") === "1";
  } catch {
    return false;
  }
}

export { orbWebGLSupported };

function toOrbState(status: Status): OrbState {
  if (status === "recording") return "recording";
  if (status === "thinking") return "thinking";
  if (status === "speaking") return "speaking";
  return "idle";
}

const ORB_MOTION_SEED = 0xce1b0;

export function OrbCanvas({
  status,
  activity = null,
  subAgentActive = false,
  subagentCount = 0,
  audioLevel,
  micLevel,
  handleRef,
}: {
  status: Status;
  // Ref que App posee: OrbCanvas la rellena con un handle imperativo ({ cue }) al montar el orbe,
  // para reaccionar al toque en el mismo frame sin pasar por un re-render. null mientras no hay orbe.
  handleRef?: MutableRefObject<OrbHandle | null>;
  pressed?: boolean; // (lo cubre status="recording"; se acepta por compat de la API)
  // Forma-por-estado: el tool-call en curso (`activity`) y si hay un sub-agente del roster activo
  // (`subAgentActive`) afinan QUÉ forma muestra el orbe al pensar (triángulo/cuadrado/pentágono).
  activity?: string | null;
  subAgentActive?: boolean;
  // Cantidad de sub-agentes ACTIVOS ahora → N mini-orbs decorando el orb (uno por sub-agente vivo).
  // Lo alimenta el frame `subagents` del backend (ver useChannel). 0 = ninguno (sin satélites).
  subagentCount?: number;
  audioLevel: () => number;
  micLevel?: () => number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const orbRef = useRef<Orb | null>(null);
  const fns = useRef({ audioLevel, micLevel });
  fns.current = { audioLevel, micLevel };
  const fpsDebug = orbFpsDebugEnabled();
  const [fps, setFps] = useState(0);

  // Chrome Android dispara el menú "guardar imagen" al mantener apretado un <canvas>: es un
  // gesto a nivel browser que NO siempre se previene con el onContextMenu del <button> padre
  // (el canvas va con pointer-events:none → la delegación de React puede no engancharlo).
  // Un listener NATIVO directo en el canvas lo corta de raíz.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const block = (e: Event) => e.preventDefault();
    el.addEventListener("contextmenu", block);
    return () => el.removeEventListener("contextmenu", block);
  }, []);

  useEffect(() => {
    if (!ref.current) return;
    // En mobile el orbe se ve a ~200px pero el DPR suele ser 2–3 → el backbuffer se iba a 1024²+.
    // Capamos el DPR a 1.5 (nítido para ese tamaño) y bajamos el costo por frame SIN tocar la
    // fluidez (sigue a 60fps) ni la respuesta al toque. Desktop queda full (2).
    const mobile = window.matchMedia("(max-width: 32rem)").matches;
    const orb = createOrb(ref.current, {
      config: orbConfig,
      initialState: "idle",
      buf: 512,
      maxDpr: mobile ? 1.5 : 2,
      motionSeed: ORB_MOTION_SEED,
      onFps: orbFpsDebugEnabled() ? (v) => setFps(v) : undefined,
      getLevel: (st) =>
        st === "recording"
          ? (fns.current.micLevel?.() ?? 0)
          : st === "speaking"
            ? fns.current.audioLevel()
            : 0,
    });
    orbRef.current = orb;
    // Publicamos el handle imperativo: App lo usa en el pointerdown para cuequear el estado del orbe
    // SIN esperar el re-render. Lo limpiamos al desmontar para no llamar a un engine ya disposed.
    if (handleRef) {
      handleRef.current = orb ? { cue: (s) => orb.setState(s) } : null;
    }
    return () => {
      if (handleRef) handleRef.current = null;
      orb?.dispose();
    };
  }, [handleRef]);

  useEffect(() => {
    orbRef.current?.setState(toOrbState(status));
  }, [status]);

  // Forma geométrica = estado del agente (ya no es random; ver agentShape.ts). El permiso de mic no
  // afecta la forma: si el agente piensa o tiene un sub-agente, el orbe lo refleja igual.
  useEffect(() => {
    const shape = shapeForAgent(status, activity, subAgentActive);
    orbRef.current?.setShape(shape);
  }, [status, activity, subAgentActive]);

  // Mini-orbs = sub-agentes activos: N satélites decorando el orb. No depende del permiso de mic:
  // los workers vivos se muestran aunque el usuario todavía no haya autorizado grabación.
  useEffect(() => {
    orbRef.current?.setSubagents(subagentCount);
  }, [subagentCount]);

  // opacity:0 INLINE (además del CSS): el estado oculto inicial no depende de que la hoja de
  // estilos ya esté aplicada al montar. El engine lo pone en "1" recién con el primer frame del
  // orbe ya presentado (core.ts). Así no se ve el cuadrado blanco del lienzo antes de pintar.
  return (
    <>
      <canvas ref={ref} className="orb-canvas" style={{ opacity: 0 }} />
      {fpsDebug && (
        <div
          // Debug readout: esquina SUPERIOR-DERECHA (antes top-center, donde pisaba el head
          // centrado del .debug-overlay). Los readouts de debug viven arriba; el bottom queda
          // libre para la UI real (versión/unsplash abajo-izq, FABs abajo-der).
          style={{
            position: "fixed",
            top: "calc(env(safe-area-inset-top) + 4px)",
            right: "max(0.5rem, env(safe-area-inset-right))",
            zIndex: 9999,
            font: "600 12px ui-monospace, monospace",
            color: "#fff",
            background: "rgba(0,0,0,0.55)",
            padding: "2px 6px",
            borderRadius: "6px",
            pointerEvents: "none",
          }}
        >
          orb {Math.round(fps)} fps
        </div>
      )}
    </>
  );
}
