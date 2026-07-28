// E2E de la CANCELACIÓN de un turno de usuario (orb tap mientras "pensando" → `/stop`).
//
// El bug (reportado en staging, #634): `/stop` corre CONCURRENTE con la prep del turno (STT → build
// de tags → `relay.send`). `relay.interrupt()` solo frena un turno YA corriendo; si el `/stop` llega
// ANTES del `relay.send` (turno ENCOLADO/en-prep), el interrupt es no-op y el turno se despachaba
// igual y contestaba (por voz, si lo inició una nota de voz). El fix: `/stop` marca `cancelRequested`
// y el dispatch lo chequea JUSTO antes de `relay.send` y NO despacha.
//
// Hermético: backend de sesión fakeado (costura SessionBackend en memoria), igual que subagent.e2e.
// Para reproducir la VENTANA de prep de forma DETERMINISTA, "gateamos" la primera lectura de wikis
// (la del lookup de memoria relevante, que corre DESPUÉS de beginTurn y ANTES de relay.send): con la
// prep pausada ahí, inyectamos el `/stop` y recién entonces la soltamos → el dispatch ve el flag.

import type { SessionBackend, Sink } from "@ceibo/agent";
import type { ChannelPolicy, PostTarget } from "@ceibo/channels";
import { addChannel, addRepo, addUser, grantAccess, openDb, setUserBackendMode } from "@ceibo/store";
import type { Wikis } from "@ceibo/wikis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGateway } from "./engine.ts";

const USAGE = { input: 100, output: 50, cache5m: 0, cache1h: 0, cacheRead: 0 };
const MODEL = "claude-haiku-4-5";
const CLI: ChannelPolicy = { name: "cli", echoTranscript: false };

type Db = ReturnType<typeof openDb>;
type Session = { sid: string; sink: Sink; sent: string[]; interrupts: number };

function makeFake(): {
  backend: SessionBackend;
  sessions: Session[];
  onSend: { fn?: (s: Session, t: string) => void | Promise<void> };
} {
  const sessions: Session[] = [];
  let nextSid = 0;
  const onSend: { fn?: (s: Session, t: string) => void | Promise<void> } = {};
  const backend: SessionBackend = {
    createVault: async () => "vault-fake",
    setStaticBearerCredential: async () => {},
    revokeOauthCredential: async () => false,
    setSessionAgentConfig: async () => {},
    createSession: async () => `sess-${nextSid++}`,
    reuseOrCreate: async (_c, _t, existing) => existing ?? `sess-${nextSid++}`,
    attach: (sid, sink) => {
      const s: Session = { sid, sink, sent: [], interrupts: 0 };
      sessions.push(s);
      return {
        send: async (t: string) => {
          s.sent.push(t);
          await onSend.fn?.(s, t);
        },
        interrupt: async () => {
          s.interrupts++;
        },
        close: () => {},
      };
    },
  };
  return { backend, sessions, onSend };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

let db: Db;
let testerId: number;

function makeGateway(fake: SessionBackend, wikis?: Wikis) {
  return createGateway({
    env: { AGENT_ID: "agent-test", ENV_ID: "env-test" } as NodeJS.ProcessEnv,
    client: {} as never,
    backendForUser: () => fake,
    db,
    cfg: { agentId: "agent-test", envId: "env-test" },
    wikis,
    cronTarget: () => undefined,
  });
}

function makeThread(): { thread: PostTarget; posts: string[]; turnDones: number } {
  const posts: string[] = [];
  const state = { turnDones: 0 };
  const thread: PostTarget = {
    post: async (t) => void posts.push(t),
    startTyping: async () => {},
    turnDone: () => {
      state.turnDones++;
    },
  };
  return {
    thread,
    posts,
    get turnDones() {
      return state.turnDones;
    },
  };
}

// Wikis fake cuyo PRIMER `tree` (el del lookup de memoria, en plena ventana de prep del turno) se
// puede pausar con `release()`: así inyectamos el `/stop` con el turno todavía encolado.
function gatedWikis(): { wikis: Wikis; gate: Promise<void>; release: () => void; treeCalls: number } {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const state = { treeCalls: 0 };
  const wikis = {
    org: "ceibo-test",
    tree: async (_repoName: string) => {
      state.treeCalls++;
      if (state.treeCalls === 1) await gate; // 1ª lectura (prep del turno) → pausada hasta release()
      return { ref: "head-fake", paths: [] as string[] };
    },
    read: async (_repoName: string, ref?: string) => ({ ref: ref ?? "head-fake", files: [] }),
  } as unknown as Wikis;
  return {
    wikis,
    gate,
    release,
    get treeCalls() {
      return state.treeCalls;
    },
  };
}

beforeEach(() => {
  db = openDb(":memory:");
  const u = addUser(db, "tester");
  testerId = u.id;
  addChannel(db, u.id, "cli", "tester");
  setUserBackendMode(db, u.id, "local");
  // El lookup de memoria recorre las wikis del usuario → necesita al menos un repo accesible para
  // que `wikis.tree` se llame (ahí está nuestro gate de la ventana de prep).
  const repo = addRepo(db, "ceibo-test", "tester-personal");
  grantAccess(db, repo.id, testerId);
});

afterEach(() => db.close());

describe("gateway — cancelación de turno (/stop)", () => {
  it("/stop ANTES del relay.send (turno encolado) → el turno NO se despacha y se cierra", async () => {
    const { backend, sessions, onSend } = makeFake();
    const g = gatedWikis();
    const gw = makeGateway(backend, g.wikis);
    const t = makeThread();
    onSend.fn = (s) => s.sink.turnComplete?.(USAGE, MODEL);

    // Turno A: arranca y queda PAUSADO en la prep (gate del tree de memoria), sin despachar todavía.
    const turnA = gw.handleIncoming(CLI, "tester", "hola, contame algo", t.thread);
    await flush();
    expect(g.treeCalls).toBe(1); // llegó al lookup de memoria → estamos en plena ventana de prep
    expect(sessions[0]?.sent ?? []).toHaveLength(0); // todavía NO se despachó nada

    // Tap en el orbe mientras "pensaba" → `/stop` (turno encolado). Corre concurrente con la prep.
    await gw.handleIncoming(CLI, "tester", "/stop", t.thread);
    expect(sessions[0]?.interrupts).toBe(1); // el /stop intentó interrumpir (no-op acá: nada corriendo)

    // Soltamos la prep: el dispatch ve `cancelRequested` y NO manda el turno al agente.
    g.release();
    await turnA;
    await flush();

    expect(sessions[0]?.sent ?? []).toHaveLength(0); // el turno NUNCA se despachó (no contestó)
    expect(t.turnDones).toBeGreaterThanOrEqual(1); // el orb se cerró (no quedó colgado en "pensando")
  });

  it("/stop sobre un turno YA corriendo → interrumpe vía relay.interrupt (sin regresión)", async () => {
    const { backend, sessions, onSend } = makeFake();
    const gw = makeGateway(backend); // sin wikis: la prep no se gatea, el turno despacha normal
    const t = makeThread();
    // El turno se despacha pero NO cierra solo (simula un turno largo en vuelo).
    onSend.fn = () => {};

    await gw.handleIncoming(CLI, "tester", "hola", t.thread);
    await flush();
    expect(sessions[0]?.sent).toHaveLength(1); // el turno SÍ se despachó (está corriendo)

    await gw.handleIncoming(CLI, "tester", "/stop", t.thread);
    expect(sessions[0]?.interrupts).toBe(1); // /stop interrumpió el turno en vuelo
  });

  it("un turno NUEVO tras un cancel se despacha normal (el flag no se arrastra)", async () => {
    const { backend, sessions, onSend } = makeFake();
    const g = gatedWikis();
    const gw = makeGateway(backend, g.wikis);
    const t = makeThread();
    onSend.fn = (s) => s.sink.turnComplete?.(USAGE, MODEL);

    // Turno A: encolado → cancelado (mismo flujo que el 1er test).
    const turnA = gw.handleIncoming(CLI, "tester", "primero", t.thread);
    await flush();
    await gw.handleIncoming(CLI, "tester", "/stop", t.thread);
    g.release();
    await turnA;
    await flush();
    expect(sessions[0]?.sent ?? []).toHaveLength(0); // A no se despachó

    // Turno B (nuevo, sin /stop): el reset al tope de handleIncoming limpió cancelRequested → despacha.
    await gw.handleIncoming(CLI, "tester", "segundo", t.thread);
    await flush();
    const dispatched = sessions[0]?.sent ?? [];
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.endsWith("\nsegundo")).toBe(true);
  });
});
