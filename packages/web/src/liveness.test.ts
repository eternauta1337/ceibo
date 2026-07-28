// Tests del watchdog de liveness (liveness.ts): la decisión pura de "esta conexión SSE está
// zombie → reconectá". Reloj fake inyectado (deps.now) — sin timers reales ni EventSource.
import { describe, expect, it } from "vitest";
import { createLiveness, RECONNECT_MIN_GAP_MS, SSE_DEAD_MS, SSE_STALE_MS } from "./liveness.ts";

const CONNECTING = 0;
const OPEN = 1;

/** Arma un liveness con estado mutable controlado por el test. */
function harness(init?: { readyState?: number; lastEventAt?: number; now?: number }) {
  const st = {
    readyState: init?.readyState ?? OPEN,
    lastEventAt: init?.lastEventAt ?? 0,
    now: init?.now ?? 1_000_000,
    reconnects: 0,
  };
  const liveness = createLiveness({
    getReadyState: () => st.readyState,
    getLastEventAt: () => st.lastEventAt,
    reconnect: () => {
      st.reconnects++;
      // como connect() real: el reconnect resetea el baseline de liveness a "ahora"
      st.lastEventAt = st.now;
    },
    now: () => st.now,
  });
  return { st, liveness };
}

describe("check (tick del watchdog)", () => {
  it("conexión sana (eventos frescos) → NO reconecta", () => {
    const { st, liveness } = harness({ lastEventAt: 1_000_000 });
    st.now += 30_000; // un ping de 25s acaba de llegar hace 5s... bien adentro del umbral
    st.lastEventAt = st.now - 5_000;
    expect(liveness.check()).toBe(false);
    expect(st.reconnects).toBe(0);
  });

  it("zombie: > SSE_DEAD_MS sin eventos con readyState OPEN → reconecta (el caso half-open)", () => {
    const { st, liveness } = harness({ lastEventAt: 1_000_000 });
    st.now = 1_000_000 + SSE_DEAD_MS + 1;
    expect(liveness.check()).toBe(true);
    expect(st.reconnects).toBe(1);
  });

  it("exactamente en el umbral → todavía NO (estrictamente mayor)", () => {
    const { st, liveness } = harness({ lastEventAt: 1_000_000 });
    st.now = 1_000_000 + SSE_DEAD_MS;
    expect(liveness.check()).toBe(false);
  });

  it("stuck CONNECTING por > SSE_DEAD_MS también cuenta como muerto", () => {
    const { st, liveness } = harness({ readyState: CONNECTING, lastEventAt: 1_000_000 });
    st.now = 1_000_000 + SSE_DEAD_MS + 1;
    expect(liveness.check()).toBe(true);
  });

  it("sin EventSource (readyState -1, ej. unauth) → nunca reconecta", () => {
    const { st, liveness } = harness({ readyState: -1, lastEventAt: 0 });
    st.now += SSE_DEAD_MS * 10;
    expect(liveness.check()).toBe(false);
    expect(st.reconnects).toBe(0);
  });

  it("sin baseline (lastEventAt 0) → no reconecta (defensa)", () => {
    const { st, liveness } = harness({ lastEventAt: 0 });
    st.now += SSE_DEAD_MS * 10;
    expect(liveness.check()).toBe(false);
  });

  it("no loopea: tras el reconnect, el baseline fresco lo frena hasta vencer de nuevo", () => {
    const { st, liveness } = harness({ lastEventAt: 1_000_000 });
    st.now = 1_000_000 + SSE_DEAD_MS + 1;
    expect(liveness.check()).toBe(true);
    // ticks siguientes (cada 10s): el baseline se reseteó al reconectar → sanos
    for (let i = 0; i < 6; i++) {
      st.now += 10_000;
      expect(liveness.check()).toBe(false);
    }
    expect(st.reconnects).toBe(1);
    // si la red sigue muerta (ningún evento llega), eventualmente vuelve a reconectar
    st.now += SSE_DEAD_MS;
    expect(liveness.check()).toBe(true);
    expect(st.reconnects).toBe(2);
  });
});

describe("wake (visibilitychange→visible / online)", () => {
  it("OPEN con eventos frescos → no toca (la conexión sobrevivió al sleep)", () => {
    const { st, liveness } = harness();
    st.lastEventAt = st.now - 1_000;
    expect(liveness.wake()).toBe(false);
    expect(st.reconnects).toBe(0);
  });

  it("OPEN pero stale (> SSE_STALE_MS, un ping perdido) → reconecta ya", () => {
    const { st, liveness } = harness({ lastEventAt: 1_000_000 });
    st.now = 1_000_000 + SSE_STALE_MS + 1;
    expect(liveness.wake()).toBe(true);
    expect(st.reconnects).toBe(1);
  });

  it("no-OPEN (CONNECTING tras despertar) → reconecta aunque el último evento sea fresco", () => {
    const { st, liveness } = harness({ readyState: CONNECTING });
    st.lastEventAt = st.now - 1_000;
    expect(liveness.wake()).toBe(true);
  });

  it("sin EventSource (unauth) → no hace nada", () => {
    const { st, liveness } = harness({ readyState: -1 });
    expect(liveness.wake()).toBe(false);
    expect(st.reconnects).toBe(0);
  });
});

describe("debounce compartido (sin reconexiones duplicadas)", () => {
  it("online + visible casi juntos (despertar típico) → UN solo reconnect", () => {
    const { st, liveness } = harness({ readyState: CONNECTING, lastEventAt: 1_000_000 });
    st.now = 1_000_000 + SSE_DEAD_MS + 1;
    expect(liveness.wake()).toBe(true); // online
    st.now += 50;
    st.readyState = CONNECTING; // el connect() nuevo todavía no abrió
    expect(liveness.wake()).toBe(false); // visibilitychange 50ms después → debounced
    expect(st.reconnects).toBe(1);
  });

  it("watchdog + wake dentro de la ventana → también un solo reconnect", () => {
    const { st, liveness } = harness({ lastEventAt: 1_000_000 });
    st.now = 1_000_000 + SSE_DEAD_MS + 1;
    expect(liveness.check()).toBe(true);
    st.now += RECONNECT_MIN_GAP_MS - 1;
    st.readyState = CONNECTING;
    st.lastEventAt = 1_000_000; // simulá que el baseline NO se hubiera movido (peor caso)
    expect(liveness.wake()).toBe(false);
    expect(st.reconnects).toBe(1);
    // pasada la ventana, si sigue mal, sí puede volver a actuar
    st.now += 2;
    expect(liveness.wake()).toBe(true);
    expect(st.reconnects).toBe(2);
  });
});
