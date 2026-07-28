// E2E del canal de control F3: reset de sesión MA vía `resetSessionForUser`.
//
// Tests clave:
//   1. Sin sesión viva (sin ctx / sin sessionId): no-op limpio.
//   2. Con sesión viva y gateway libre: recrea la sesión (se crea un sessionId nuevo).
//   3. Con turno en vuelo (busy): el reset se difiere y no corta el turno; se aplica al cerrar.
//
// Igual que engine.e2e.test.ts: backend MA fakeado, store en :memory:, sin red real.

import type { SessionBackend, Sink } from "@ceibo/agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capturas compartidas (hoisted para evitar TDZ con vi.mock).
const h = vi.hoisted(() => ({
  sinks: [] as Sink[],
  sent: [] as string[],
  sessions: [] as string[], // IDs creados por createSession
  step: { input: 10, output: 5, cache5m: 0, cache1h: 0, cacheRead: 0 },
  cum: { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheRead: 0 },
  model: "claude-haiku-4-5",
  // Si está definida, `send` llama esta función UNA VEZ y la borra, ANTES de responder.
  // Permite detectar "el relay está dentro del turno" para tests de concurrencia.
  onSendEntered: undefined as (() => void) | undefined,
  // Si está definida, `send` espera a que esta promesa resuelva antes de continuar.
  waitForUnblock: undefined as Promise<void> | undefined,
  // Si > 0, las próximas N llamadas a createSession TIRAN (simula backend/VM unreachable),
  // decrementando el contador. Sirve para el test de atomicidad: un /new que cae en la ventana
  // unreachable no debe dejar la sesión muda (el relay viejo tiene que seguir vivo).
  failCreateSession: 0,
  // Si > 0, las próximas N llamadas a createSession TIRAN con `createSessionErrMsg` (mensaje crudo
  // con interna del backend local, p.ej. cold-start). Sirve para verificar que el error del comando
  // NUNCA llega crudo al canal: handleIncoming lo captura y postea la frase amable.
  failCreateSessionDirty: 0,
  createSessionErrMsg:
    "opencode cold-start de ceibo-tester-env_013CMPPUUQY4YWv8ZFafECzg falló tras 8 intentos: fetch failed",
  // Orden de close() de relays: cada FakeRelay empuja su índice (en h.sinks) al cerrarse.
  // Permite verificar que el relay viejo se cierra exactamente una vez en el swap atómico.
  closedRelayIdx: [] as number[],
}));

let sessionCounter = 0;

const fakeBackend: SessionBackend = {
  createVault: async () => "vault-fake",
  setStaticBearerCredential: async () => {},
  revokeOauthCredential: async () => false,
  setSessionAgentConfig: async () => {},
  createSession: async () => {
    if (h.failCreateSessionDirty > 0) {
      h.failCreateSessionDirty -= 1;
      throw new Error(h.createSessionErrMsg);
    }
    if (h.failCreateSession > 0) {
      h.failCreateSession -= 1;
      throw new Error("backend unreachable (fake)");
    }
    const sid = `sess-${++sessionCounter}`;
    h.sessions.push(sid);
    return sid;
  },
  reuseOrCreate: async () => {
    const sid = `sess-${++sessionCounter}`;
    h.sessions.push(sid);
    return sid;
  },
  attach: (_sid, sink) => {
    const idx = h.sinks.length;
    h.sinks.push(sink);
    return {
      send: async (text: string) => {
        h.sent.push(text);
        // Señalamos que estamos dentro del turno (busy).
        const cb = h.onSendEntered;
        h.onSendEntered = undefined;
        cb?.();
        // Si hay un bloqueo, esperamos.
        if (h.waitForUnblock) {
          await h.waitForUnblock;
          h.waitForUnblock = undefined;
        }
        h.cum = {
          input: h.cum.input + h.step.input,
          output: h.cum.output + h.step.output,
          cache5m: 0,
          cache1h: 0,
          cacheRead: 0,
        };
        await sink.message(`pong: ${text}`);
        await sink.turnComplete?.({ ...h.cum }, h.model);
      },
      interrupt: async () => {},
      close: () => {
        h.closedRelayIdx.push(idx);
      },
    };
  },
};

const { createGateway } = await import("./engine.ts");
const { isInternalDetail } = await import("@ceibo/agent");
const { addChannel, addUser, openDb, setUserBackendMode } = await import("@ceibo/store");

type Db = ReturnType<typeof openDb>;

let db: Db;
let gw: ReturnType<typeof createGateway>;
let testerId: number;

beforeEach(() => {
  sessionCounter = 0;
  h.sinks.length = 0;
  h.sent.length = 0;
  h.sessions.length = 0;
  h.cum = { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheRead: 0 };
  h.onSendEntered = undefined;
  h.waitForUnblock = undefined;
  h.failCreateSession = 0;
  h.failCreateSessionDirty = 0;
  h.closedRelayIdx.length = 0;

  db = openDb(":memory:");
  const u = addUser(db, "tester");
  testerId = u.id;
  addChannel(db, u.id, "cli", "tester");

  gw = createGateway({
    env: { AGENT_ID: "agent-test", ENV_ID: "env-test" } as NodeJS.ProcessEnv,
    client: {} as never,
    backendForUser: () => fakeBackend,
    db,
    cfg: { agentId: "agent-test", envId: "env-test" },
    wikis: undefined,
    cronTarget: () => undefined,
  });
});

afterEach(() => {
  db.close();
});

/** Dispara un turno por handleIncoming con un PostTarget mínimo (sin canal real). */
async function sendTurn(text: string): Promise<string[]> {
  const out: string[] = [];
  await gw.handleIncoming({ name: "cli", echoTranscript: false }, "tester", text, {
    post: async (t) => void out.push(t),
    startTyping: async () => {},
    postHeard: async () => {},
    activity: async () => {},
    chatTitle: async () => {},
    turnDone: async () => {},
    subagents: async () => {},
  });
  return out;
}

/** Igual que sendTurn pero para un externalId/canal arbitrario (no el "tester" por default). */
async function sendTurnAs(externalId: string, text: string): Promise<string[]> {
  const out: string[] = [];
  await gw.handleIncoming({ name: "cli", echoTranscript: false }, externalId, text, {
    post: async (t) => void out.push(t),
    startTyping: async () => {},
    postHeard: async () => {},
    activity: async () => {},
    chatTitle: async () => {},
    turnDone: async () => {},
    subagents: async () => {},
  });
  return out;
}

describe("comandos: un error del backend NUNCA llega crudo al canal (frase amable + log)", () => {
  it("/new (backend local en cold-start) → frase amable, sin interna; no rethrow", async () => {
    // Usuario LOCAL (archima): sus errores no son de Anthropic. Lo creamos y le abrimos sesión.
    const local = addUser(db, "local-user");
    setUserBackendMode(db, local.id, "local");
    addChannel(db, local.id, "cli", "local-user");
    await sendTurnAs("local-user", "hola");

    // El próximo createSession (que dispara /new → recreateSession) tira con la interna cruda del
    // backend local (cold-start de la VM). Antes del fix, este throw escapaba de handleIncoming y
    // caía en el `.catch()` del canal, que mandaba el `.message` CRUDO al browser.
    h.failCreateSessionDirty = 1;
    const out = await sendTurnAs("local-user", "/new");

    // El comando NO tiró (no hubo rethrow) y el usuario recibió una respuesta.
    expect(out.length).toBeGreaterThan(0);
    const posted = out.join("\n");
    // La frase es amable y de 'local' (no menciona Anthropic) — el origin se clasificó bien.
    expect(posted).toContain("despertando");
    expect(posted).not.toContain("Anthropic");
    // Y NO contiene NADA de la interna: ni env id, ni "cold-start", ni "intentos", ni "fetch failed".
    expect(isInternalDetail(posted)).toBe(false);
    expect(posted).not.toContain("env_013");
    expect(posted).not.toContain("intentos");
    expect(posted).not.toContain("fetch failed");
  });
});

describe("resetSessionForUser — plano de control F3", () => {
  it("no-op limpio cuando no hay sesión viva (usuario sin ctx anterior)", () => {
    // Nunca se envió un turno → no existe ctx para el usuario.
    expect(() => gw.resetSessionForUser(testerId)).not.toThrow();
    // No se creó ninguna sesión.
    expect(h.sessions).toHaveLength(0);
  });

  it("no-op limpio cuando userId es desconocido", () => {
    expect(() => gw.resetSessionForUser(99999)).not.toThrow();
    expect(h.sessions).toHaveLength(0);
  });

  it("recrea la sesión cuando el gateway está libre (sin turno en vuelo)", async () => {
    // Primer turno: crea la sesión base.
    await sendTurn("hola");
    const sessionsAfterFirstTurn = h.sessions.length;
    expect(sessionsAfterFirstTurn).toBeGreaterThanOrEqual(1);

    // Reset con el gateway libre → recreateSession (async).
    gw.resetSessionForUser(testerId);

    // Necesitamos un tick para que recreateSession (async) complete.
    await new Promise<void>((r) => setTimeout(r, 30));

    // Se creó al menos una sesión extra (la nueva).
    expect(h.sessions.length).toBeGreaterThan(sessionsAfterFirstTurn);
  });

  it("el siguiente turno tras un reset usa la sesión nueva (no la anterior)", async () => {
    await sendTurn("primer turno");
    const sidBeforeReset = h.sessions[h.sessions.length - 1];

    gw.resetSessionForUser(testerId);
    await new Promise<void>((r) => setTimeout(r, 30));

    // El reset creó una sesión nueva.
    const sidAfterReset = h.sessions[h.sessions.length - 1];
    expect(sidAfterReset).not.toBe(sidBeforeReset);

    // Un turno posterior corre sobre la sesión recreada.
    await sendTurn("segundo turno");
    expect(h.sent).toHaveLength(2);
  });

  it("difiere el reset cuando hay un turno en vuelo: no corta el turno y recrea la sesión al cerrar", async () => {
    // Primer turno: establece sesión.
    await sendTurn("setup");
    const sessionsBeforeReset = h.sessions.length;

    // Preparamos el bloqueo del siguiente turno.
    let unblock!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      h.onSendEntered = resolveEntered;
    });
    h.waitForUnblock = new Promise<void>((r) => (unblock = r));

    // Arrancamos el turno en vuelo (no awaiteamos — se bloquea dentro de `send`).
    const responses: string[] = [];
    const inflight = gw.handleIncoming({ name: "cli", echoTranscript: false }, "tester", "turno en vuelo", {
      post: async (t) => void responses.push(t),
      startTyping: async () => {},
      postHeard: async () => {},
      activity: async () => {},
      chatTitle: async () => {},
      turnDone: async () => {},
      subagents: async () => {},
    });

    // Esperamos a que el relay esté dentro del `send` (turno busy).
    await entered;

    // En este punto hay un turno en vuelo. Pedimos el reset.
    gw.resetSessionForUser(testerId);

    // El reset fue diferido → todavía no se creó sesión extra.
    expect(h.sessions.length).toBe(sessionsBeforeReset);

    // El turno NO fue cortado: todavía no hubo respuesta.
    expect(responses).toHaveLength(0);

    // Desbloqueamos el turno para que complete.
    unblock();
    await inflight;

    // egressTail es async; esperamos unos ticks para que la respuesta llegue al PostTarget.
    await new Promise<void>((r) => setTimeout(r, 30));

    // Ahora el turno completó → llegó al menos una respuesta al PostTarget.
    expect(responses.length).toBeGreaterThan(0);

    // Tras el cierre del turno, el reset diferido se aplica (async).
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(h.sessions.length).toBeGreaterThan(sessionsBeforeReset);
  }, 10000);

  it("resetear dos veces (idempotente): recrea la sesión; no rompe el gateway", async () => {
    await sendTurn("setup");
    const n0 = h.sessions.length;

    gw.resetSessionForUser(testerId);
    await new Promise<void>((r) => setTimeout(r, 30));
    gw.resetSessionForUser(testerId);
    await new Promise<void>((r) => setTimeout(r, 30));

    // Hubo al menos 2 recreaciones (puede ser más por reuseOrCreate internas).
    expect(h.sessions.length).toBeGreaterThan(n0 + 1);

    // El gateway sigue respondiendo.
    const out = await sendTurn("después del reset doble");
    expect(out.some((r) => r.includes("después del reset doble"))).toBe(true);
  });
});

const tick = () => new Promise<void>((r) => setTimeout(r, 30));

describe("recreateSession — atómico respecto del relay (no quedar mudo)", () => {
  it("createSession tira (backend unreachable) → el relay viejo sigue VIVO y la sesión NO queda muda", async () => {
    // Sesión base: un turno establece el relay #0 y deja una respuesta (egress es async → tick).
    // El fake echoea `pong: <mensaje al agente>` (el mensaje lleva tags del gateway → chequeamos
    // que la respuesta llegó y contiene lo que dijo el usuario, no el string exacto).
    const out0 = await sendTurn("hola");
    await tick();
    expect(out0.some((r) => r.startsWith("pong:") && r.includes("hola"))).toBe(true);
    const sessionsAntes = h.sessions.length;
    expect(h.sinks).toHaveLength(1); // un solo attach hasta acá

    // El backend está unreachable: el próximo createSession TIRA. Disparamos /new (que llama
    // recreateSession). Con el fix atómico, createSession tira ANTES de tocar el relay viejo →
    // la sesión vieja queda intacta. handleIncoming CAPTURA el error del comando (no lo deja
    // burbujear al canal crudo): postea una frase amable y el crudo va al log.
    h.failCreateSession = 1;
    const newOut = await sendTurn("/new");
    // El comando NO tiró (handleIncoming lo capturó): el usuario recibió un aviso, no una excepción.
    // (Acá el user es 'ma', así que un mensaje inocuo se muestra; el saneo de interna lo cubre el
    // test del backend LOCAL de arriba.)
    expect(newOut.some((t) => t.startsWith("⚠️"))).toBe(true);

    // No se creó ninguna sesión nueva (createSession falló) ni se attacheó un relay nuevo.
    expect(h.sessions.length).toBe(sessionsAntes);
    expect(h.sinks).toHaveLength(1);
    // El relay viejo NO fue cerrado por el intento fallido (el bug era cerrarlo primero).
    expect(h.closedRelayIdx).not.toContain(0);

    // Prueba de que NO quedó muda: con el backend ya recuperado, un turno normal vuelve a
    // responder sobre la MISMA sesión vieja (no hubo /new exitoso → mismo relay).
    const out1 = await sendTurn("seguís ahí?");
    await tick();
    expect(out1.some((r) => r.startsWith("pong:") && r.includes("seguís ahí?"))).toBe(true);
  });

  it("camino feliz: /new cierra el relay viejo y deja el nuevo activo (sin pump huérfano)", async () => {
    // Relay #0.
    await sendTurn("hola");
    expect(h.sinks).toHaveLength(1);
    const sessionsAntes = h.sessions.length;

    // /new exitoso → recreateSession crea sesión nueva, attachea relay #1 y cierra el #0.
    const out = await sendTurn("/new");
    expect(out.some((r) => r.toLowerCase().includes("sesión nueva"))).toBe(true);

    // Se creó exactamente una sesión nueva y se attacheó exactamente un relay nuevo.
    expect(h.sessions.length).toBe(sessionsAntes + 1);
    expect(h.sinks).toHaveLength(2);
    // El relay viejo (#0) se cerró exactamente una vez; el nuevo (#1) sigue abierto.
    expect(h.closedRelayIdx).toEqual([0]);

    // El siguiente turno corre sobre el relay nuevo (#1), no el viejo: una sola respuesta.
    const before = h.sent.length;
    const out2 = await sendTurn("turno post-new");
    await tick();
    expect(out2.filter((r) => r.startsWith("pong:") && r.includes("turno post-new"))).toHaveLength(1);
    // Un solo `send` se despachó (no hay dos pumps entregando) → exactamente un texto nuevo.
    expect(h.sent.length).toBe(before + 1);
  });
});
