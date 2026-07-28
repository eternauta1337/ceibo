// E2E de los SUB-AGENTES ASÍNCRONOS (archima): el coordinador despacha un worker con
// `spawnSubagentForUser` (lo que invoca la tool MCP `subagent_spawn`), su turno se libera, y al
// terminar el worker su resultado se inyecta al coordinador como turno sintético.
//
// Hermético: el backend de sesión está fakeado (costura SessionBackend en memoria). Distinguimos
// la sesión del COORDINADOR (la primera, atachada en el turno interactivo) de la(s) del WORKER
// (las que crea runWorker). El `onSend` por-test maneja la respuesta del coordinador; al worker lo
// manejamos a mano (drive de su Sink) para controlar su ciclo de vida (fin/timeout).

import type { SessionBackend, Sink } from "@ceibo/agent";
import type { ChannelPolicy, PostTarget } from "@ceibo/channels";
import { addChannel, addRepo, addUser, grantAccess, openDb, setUserBackendMode } from "@ceibo/store";
import type { Wikis } from "@ceibo/wikis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGateway } from "./engine.ts";

const USAGE = { input: 100, output: 50, cache5m: 0, cache1h: 0, cacheRead: 0 };
const MODEL = "claude-haiku-4-5";
const CLI: ChannelPolicy = { name: "cli", echoTranscript: false };

type Db = ReturnType<typeof openDb>;
type Session = { sid: string; sink: Sink; sent: string[]; interrupts: number };

// Backend fake controlable: cada attach registra {sid, sink, sent}. `onSend(session, text)` es el
// hook por-test que simula al modelo (responder + cerrar turno). Sin red, sin tokens.
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
    // El worker corre como sesión APARTE en la MISMA VM del coordinador → sid derivado del vm, distinto.
    createWorkerSession: async (vm) => `${vm}#worker-${nextSid++}`,
    attach: (sid, sink) => {
      const s: Session = { sid, sink, sent: [], interrupts: 0 };
      sessions.push(s);
      return {
        send: async (t: string) => {
          s.sent.push(t);
          await onSend.fn?.(s, t);
        },
        // Trackea los aborts remotos (kill/timeout abortan el turno opencode del worker EN la VM).
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

/** Narrowing helper: falla claro si el índice no existe (noUncheckedIndexedAccess). */
function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`esperaba ${what} pero no existe`);
  return v;
}

let db: Db;
let testerId: number;

function makeGateway(fake: SessionBackend, env: Partial<NodeJS.ProcessEnv> = {}, wikis?: Wikis) {
  return createGateway({
    env: { AGENT_ID: "agent-test", ENV_ID: "env-test", ...env } as NodeJS.ProcessEnv,
    client: {} as never,
    backendForUser: () => fake,
    db,
    cfg: { agentId: "agent-test", envId: "env-test" },
    wikis,
    cronTarget: () => undefined,
  });
}

function makeThread(): {
  thread: PostTarget;
  posts: string[];
  counts: number[];
  activities: string[];
  turnDones: number;
} {
  const posts: string[] = [];
  const counts: number[] = [];
  const activities: string[] = [];
  const state = { turnDones: 0 };
  const thread: PostTarget = {
    post: async (t) => void posts.push(t),
    startTyping: async () => {},
    turnDone: () => {
      state.turnDones++;
    },
    subagents: (n) => void counts.push(n),
    activity: (label) => void activities.push(label),
  };
  // `turnDones` se lee por getter (cuenta acumulada al momento de leer).
  return {
    thread,
    posts,
    counts,
    activities,
    get turnDones() {
      return state.turnDones;
    },
  };
}

/** Thread etiquetado que separa `post` (texto) de `postVoice` (nota de voz), para distinguir A QUÉ
 *  canal y EN QUÉ modalidad salió una respuesta. Modela el caso multi-canal del bug del ruteo: una
 *  vista web (con `postVoice`) y un chat de Telegram (con `postVoice` = nota de voz) compitiendo por
 *  ser el destino del resultado de un sub-agente. */
function makeChannelThread(): { thread: PostTarget; posts: string[]; voices: string[] } {
  const posts: string[] = [];
  const voices: string[] = [];
  const thread: PostTarget = {
    post: async (t) => void posts.push(t),
    startTyping: async () => {},
    turnDone: () => {},
    subagents: () => {},
    activity: () => {},
    postVoice: async (_ogg, text) => void voices.push(text ?? ""),
  };
  return { thread, posts, voices };
}

beforeEach(() => {
  db = openDb(":memory:");
  const u = addUser(db, "tester");
  testerId = u.id;
  addChannel(db, u.id, "cli", "tester");
  setUserBackendMode(db, u.id, "local"); // archima: los sub-agentes async sólo corren acá
});

afterEach(() => db.close());

describe("sub-agentes async — despacho, conteo e inyección", () => {
  it("despacha un worker, lo cuenta (1), inyecta su resultado al coordinador y vuelve a 0", async () => {
    const { backend, sessions, onSend } = makeFake();
    const gw = makeGateway(backend);
    const { thread, posts, counts } = makeThread();

    // El coordinador, al recibir la inyección del resultado, responde al usuario y cierra el turno.
    // (El turno inicial "hola" también cae acá: responde un eco y cierra.)
    onSend.fn = async (s, t) => {
      if (t.includes("[resultado del sub-agente")) {
        await s.sink.message?.("Listo, reorganicé tu wiki.");
        s.sink.turnComplete?.(USAGE, MODEL);
      } else if (!t.includes("[sos un SUB-AGENTE")) {
        // turno interactivo normal (no el prompt del worker): eco + cierre.
        await s.sink.message?.("ok");
        s.sink.turnComplete?.(USAGE, MODEL);
      }
      // El prompt del worker ([sos un SUB-AGENTE …]) NO se autorresponde: lo driveamos a mano.
    };

    // 1) Turno interactivo: establece el ctx, lastThread y el relay del coordinador (sessions[0]).
    await gw.handleIncoming(CLI, "tester", "hola", thread);
    await flush();
    const coordinator = need(sessions[0], "sesión del coordinador");

    // 2) El coordinador despacha el worker (== la tool subagent_spawn). Respuesta inmediata + conteo 1.
    const ack = await gw.spawnSubagentForUser(testerId, "reorganizá la wiki de viajes", "reorg wiki");
    expect(ack).toMatch(/despachado \(id 1\): reorg wiki/);
    await flush();
    expect(counts.at(-1)).toBe(1); // un worker vivo → 1 mini-orb

    // El worker se creó en una sesión APARTE y recibió el encargo COMPLETO (prompt de sub-agente).
    const worker = need(sessions[1], "sesión del worker");
    expect(worker.sid).not.toBe(coordinator.sid);
    expect(worker.sent[0]).toMatch(/sos un SUB-AGENTE de ceibo/);
    expect(worker.sent[0]).toMatch(/reorganizá la wiki de viajes/);

    // 3) El worker termina: produce un resumen y cierra su turno.
    await worker.sink.message?.("Reorganicé 12 notas por destino.");
    worker.sink.turnComplete?.(USAGE, MODEL);
    await flush();

    // Su resultado se inyectó al coordinador como turno sintético (sessions[0]).
    expect(coordinator.sent.some((t) => /\[resultado del sub-agente "reorg wiki"/.test(t))).toBe(true);
    expect(coordinator.sent.some((t) => /Reorganicé 12 notas por destino/.test(t))).toBe(true);
    expect(coordinator.sent.some((t) => /Verificalo e informale al usuario/.test(t))).toBe(true);

    // El coordinador integró e informó al usuario, y el conteo volvió a 0 (no quedan workers).
    expect(posts.some((p) => /reorganicé tu wiki/i.test(p))).toBe(true);
    expect(counts.at(-1)).toBe(0);
  });

  it("RUTEO: el resultado del worker vuelve al canal/vista que lo DESPACHÓ, aunque otro canal pise lastThread mientras corre", async () => {
    // Reproduce el bug: el usuario pide algo desde la WEB con sub-agente; mientras el worker corre,
    // llega actividad por OTRO canal (telegram) que pisa `ctx.lastThread`; al terminar el worker, su
    // resultado se inyecta y DEBE volver a la web (la vista que preguntó), NO a telegram.
    const WEB: ChannelPolicy = { name: "web", echoTranscript: false };
    const TELEGRAM: ChannelPolicy = { name: "telegram", echoTranscript: true };
    addChannel(db, testerId, "web", "tester-web");
    addChannel(db, testerId, "telegram", "tester-tg");

    const { backend, sessions, onSend } = makeFake();
    const gw = makeGateway(backend);
    const web = makeChannelThread();
    const telegram = makeChannelThread();

    onSend.fn = async (s, t) => {
      if (t.includes("[resultado del sub-agente")) {
        await s.sink.message?.("Listo, terminé lo que pediste por la web.");
        s.sink.turnComplete?.(USAGE, MODEL);
      } else if (!t.includes("[sos un SUB-AGENTE")) {
        await s.sink.message?.("ok");
        s.sink.turnComplete?.(USAGE, MODEL);
      }
    };

    // 1) Turno desde la WEB: fija el ctx y el lastThread = web (la vista que preguntó).
    await gw.handleIncoming(WEB, "tester-web", "reorganizá mi wiki", web.thread);
    await flush();

    // 2) El coordinador despacha el worker (la web es el thread de origen capturado).
    await gw.spawnSubagentForUser(testerId, "reorganizá la wiki", "reorg wiki");
    await flush();
    const worker = need(sessions[1], "sesión del worker");

    // 3) Mientras el worker corre, el usuario manda un mensaje por TELEGRAM → pisa ctx.lastThread.
    await gw.handleIncoming(TELEGRAM, "tester-tg", "hola por otro lado", telegram.thread);
    await flush();
    expect(telegram.posts.some((p) => /ok/i.test(p))).toBe(true); // el turno de telegram respondió por telegram

    // 4) El worker termina → su resultado se inyecta al coordinador.
    await worker.sink.message?.("Reorganicé 12 notas.");
    worker.sink.turnComplete?.(USAGE, MODEL);
    await flush();

    // El resultado del sub-agente volvió a la WEB (la vista que lo pidió), NO a telegram.
    expect(web.posts.some((p) => /terminé lo que pediste por la web/i.test(p))).toBe(true);
    expect(telegram.posts.some((p) => /terminé lo que pediste por la web/i.test(p))).toBe(false);
    // Y no salió como nota de voz por ningún canal (el turno no fue por voz).
    expect(telegram.voices).toEqual([]);
    expect(web.voices).toEqual([]);
  });

  it("RUTEO · origen DESCONECTADO: la inyección sigue yendo al thread web de origen (best-effort) y NUNCA cae a telegram", async () => {
    // Edge del lead: la vista web que pidió el trabajo se desconectó (SSE caído / pestaña cerrada)
    // mientras el worker corría. El resultado NO debe re-rutearse a telegram (eso reintroduce la
    // sorpresa). Contrato del gateway: SIEMPRE postea al thread de ORIGEN (el canal web), aunque su
    // entrega en vivo falle/no-op — la persistencia para el reconnect vive aguas abajo (frameBuffer
    // del web-server, que bufferea TODO frame entregado aunque no haya stream vivo). Acá verificamos
    // el invariante en el límite del gateway: el post va al web, telegram queda intacto, sin voz.
    const WEB: ChannelPolicy = { name: "web", echoTranscript: false };
    const TELEGRAM: ChannelPolicy = { name: "telegram", echoTranscript: true };
    addChannel(db, testerId, "web", "tester-web");
    addChannel(db, testerId, "telegram", "tester-tg");

    const { backend, sessions, onSend } = makeFake();
    const gw = makeGateway(backend);
    const telegram = makeChannelThread();

    // Web de ORIGEN cuya entrega en vivo está CAÍDA: `post`/`postVoice` rechazan (socket muerto al
    // browser). Igual contamos los intentos: el gateway DEBE intentar entregar acá, no en telegram.
    const webPostAttempts: string[] = [];
    const webVoiceAttempts: string[] = [];
    const deadWeb: PostTarget = {
      post: async (t) => {
        webPostAttempts.push(t);
        throw new Error("SSE caído: vista offline");
      },
      startTyping: async () => {},
      turnDone: () => {},
      subagents: () => {},
      activity: () => {},
      postVoice: async (_o, text) => {
        webVoiceAttempts.push(text ?? "");
        throw new Error("SSE caído: vista offline");
      },
    };

    onSend.fn = async (s, t) => {
      if (t.includes("[resultado del sub-agente")) {
        await s.sink.message?.("Listo, terminé lo que pediste por la web.");
        s.sink.turnComplete?.(USAGE, MODEL);
      } else if (!t.includes("[sos un SUB-AGENTE")) {
        await s.sink.message?.("ok");
        s.sink.turnComplete?.(USAGE, MODEL);
      }
    };

    // 1) Turno desde la WEB (vista que luego se cae): captura deadWeb como thread de origen.
    await gw.handleIncoming(WEB, "tester-web", "reorganizá mi wiki", deadWeb);
    await flush();
    // 2) Despacha el worker.
    await gw.spawnSubagentForUser(testerId, "reorganizá la wiki", "reorg wiki");
    await flush();
    const worker = need(sessions[1], "sesión del worker");
    // 3) Mientras corre, telegram pisa lastThread.
    await gw.handleIncoming(TELEGRAM, "tester-tg", "hola por otro lado", telegram.thread);
    await flush();
    // 4) El worker termina → inyección.
    await worker.sink.message?.("Reorganicé 12 notas.");
    worker.sink.turnComplete?.(USAGE, MODEL);
    await flush();

    // El gateway INTENTÓ entregar el resultado por el thread web de origen (aunque su entrega en vivo
    // falle: aguas abajo lo bufferea el web-server para el reconnect).
    expect(webPostAttempts.some((p) => /terminé lo que pediste por la web/i.test(p))).toBe(true);
    // Y NO se filtró a telegram (ni texto ni voz), pese a que telegram era el `lastThread` vigente.
    expect(telegram.posts.some((p) => /terminé lo que pediste por la web/i.test(p))).toBe(false);
    expect(telegram.voices).toEqual([]);
    // Tampoco se sintetizó voz por el web (el turno no fue por voz).
    expect(webVoiceAttempts).toEqual([]);
  });

  it("coreografía del anuncio: underhint+count por spawn, CERO template del gateway; el anuncio lo escribe el MODELO, cierra el turno y lo posterior se SUPRIME", async () => {
    const { backend, sessions, onSend } = makeFake();
    const gw = makeGateway(backend);
    const t = makeThread();
    // El "hola" inicial cierra su turno; el prompt del worker NO se autorresponde (lo driveamos).
    onSend.fn = (s, txt) => {
      if (!txt.includes("[sos un SUB-AGENTE") && !txt.includes("[resultado del sub-agente")) {
        s.sink.turnComplete?.(USAGE, MODEL);
      }
    };
    await gw.handleIncoming(CLI, "tester", "hola", t.thread);
    await flush();
    const coordinator = need(sessions[0], "sesión del coordinador");
    const postsBefore = t.posts.length;
    const turnDonesBefore = t.turnDones;

    // Despacho del worker = tool subagent_spawn. El tool-result guía la coreografía nueva.
    const ack = await gw.spawnSubagentForUser(testerId, "reorganizá la wiki", "reorg wiki");
    await flush();
    expect(ack).toMatch(/AÚN NO recibió ningún aviso/);
    expect(ack).toMatch(/UNA sola frase natural/);

    // (a) el GATEWAY ya NO postea el template — el anuncio es del modelo.
    expect(t.posts.length).toBe(postsBefore);
    // (b) underhint del orb: el copy EXACTO del contrato; (c) mini-orb del worker vivo (conteo 1).
    expect(t.activities).toContain("subagente creado");
    expect(t.counts.at(-1)).toBe(1);
    // (d) el turno NO se cerró todavía: se cierra DESPUÉS del anuncio del modelo.
    expect(t.turnDones).toBe(turnDonesBefore);

    // El MODELO redacta su anuncio (su voz): SE POSTEA, y recién ahí sale el turn-done + el
    // conteo re-afirmado DESPUÉS del turn-done (los mini-orbs persisten).
    await coordinator.sink.message?.("Listo, mandé un ayudante a reorganizar tu wiki. Seguime contando.");
    await flush();
    expect(t.posts.some((p) => /mandé un ayudante a reorganizar/.test(p))).toBe(true);
    expect(t.turnDones).toBeGreaterThan(turnDonesBefore);
    expect(t.counts.at(-1)).toBe(1);

    // Lo que el coordinador diga DESPUÉS de su anuncio en el mismo turno se DESCARTA.
    await coordinator.sink.message?.("Dale, ya quedó todo encaminado por si te lo preguntás…");
    await flush();
    expect(t.posts.some((p) => /ya quedó todo encaminado/.test(p))).toBe(false);

    // Al cerrar el turno del coordinador, la supresión se levanta (turnos futuros postean normal)
    // y NO sale ningún fallback duplicado (el anuncio ya está hecho).
    const postsAtClose = t.posts.length;
    coordinator.sink.turnComplete?.(USAGE, MODEL);
    await flush();
    expect(t.posts.length).toBe(postsAtClose); // sin "Disparé un sub-agente..." mecánico de más
    await coordinator.sink.message?.("(otro turno) hola de nuevo");
    await flush();
    expect(t.posts.some((p) => /otro turno/.test(p))).toBe(true);
  });

  it("multi-spawn: N spawns en el MISMO turno → un underhint y un count por spawn, y UN SOLO anuncio (del modelo) que cierra el turno", async () => {
    const { backend, sessions, onSend } = makeFake();
    const gw = makeGateway(backend);
    const t = makeThread();
    onSend.fn = (s, txt) => {
      if (!txt.includes("[sos un SUB-AGENTE") && !txt.includes("[resultado del sub-agente")) {
        s.sink.turnComplete?.(USAGE, MODEL);
      }
    };
    await gw.handleIncoming(CLI, "tester", "ordename tres cosas", t.thread);
    await flush();
    const coordinator = need(sessions[0], "sesión del coordinador");
    const postsBefore = t.posts.length;
    const turnDonesBefore = t.turnDones;
    const hintsBefore = t.activities.filter((a) => a === "subagente creado").length;

    // Tres despachos seguidos en el mismo turno (== tres tool-calls subagent_spawn).
    await gw.spawnSubagentForUser(testerId, "tarea 1", "contar hasta 30");
    await gw.spawnSubagentForUser(testerId, "tarea 2", "contar hasta 60");
    await gw.spawnSubagentForUser(testerId, "tarea 3", "contar hasta 90");
    await flush();

    // Un underhint POR spawn, el chip subió 1→2→3, y NINGÚN post intermedio ni turn-done todavía.
    expect(t.activities.filter((a) => a === "subagente creado").length).toBe(hintsBefore + 3);
    expect(t.counts).toContain(1);
    expect(t.counts).toContain(2);
    expect(t.counts.at(-1)).toBe(3);
    expect(t.posts.length).toBe(postsBefore);
    expect(t.turnDones).toBe(turnDonesBefore);

    // El modelo emite SU único anuncio cubriendo a los tres → se postea, turn-done, count re-afirmado.
    await coordinator.sink.message?.(
      "Disparé tres sub-agentes a contar (30, 60 y 90). Seguí hablando tranquilo.",
    );
    await flush();
    const announces = t.posts.slice(postsBefore);
    expect(announces).toHaveLength(1); // UN solo anuncio para los tres spawns
    expect(announces[0]).toMatch(/tres sub-agentes/);
    expect(t.turnDones).toBeGreaterThan(turnDonesBefore);
    expect(t.counts.at(-1)).toBe(3);
  });

  it("rechaza un sub-agente duplicado mientras el original sigue vivo", async () => {
    const { backend, onSend } = makeFake();
    const gw = makeGateway(backend);
    const t = makeThread();
    onSend.fn = (s, txt) => {
      if (!txt.includes("[sos un SUB-AGENTE") && !txt.includes("[resultado del sub-agente")) {
        s.sink.turnComplete?.(USAGE, MODEL);
      }
    };
    await gw.handleIncoming(CLI, "tester", "buscá mi vuelo", t.thread);
    await flush();

    const first = await gw.spawnSubagentForUser(
      testerId,
      "Buscar número de vuelo Bariloche",
      "Buscar número de vuelo Bariloche",
    );
    const duplicate = await gw.spawnSubagentForUser(
      testerId,
      "buscar   numero de vuelo bariloche",
      "buscar numero de vuelo bariloche",
    );
    await flush();

    expect(first).toMatch(/despachado \(id 1\)/);
    expect(duplicate).toMatch(/Ya hay un sub-agente corriendo/);
    expect(duplicate).toMatch(/id 1/);
    expect(t.counts.at(-1)).toBe(1);
    expect(t.activities.filter((a) => a === "subagente creado")).toHaveLength(1);
  });

  it("anti-silencio (timer): si el modelo no anuncia a tiempo, el gateway postea la línea mínima que cubre a TODOS y cierra el turno; el anuncio tardío se traga", async () => {
    const { backend, sessions, onSend } = makeFake();
    const gw = makeGateway(backend, { SUBAGENT_ANNOUNCE_TIMEOUT_MS: "40" });
    const t = makeThread();
    onSend.fn = (s, txt) => {
      if (!txt.includes("[sos un SUB-AGENTE") && !txt.includes("[resultado del sub-agente")) {
        s.sink.turnComplete?.(USAGE, MODEL);
      }
    };
    await gw.handleIncoming(CLI, "tester", "hola", t.thread);
    await flush();
    const coordinator = need(sessions[0], "sesión del coordinador");
    const turnDonesBefore = t.turnDones;

    await gw.spawnSubagentForUser(testerId, "tarea 1", "ordenar viajes");
    await gw.spawnSubagentForUser(testerId, "tarea 2", "armar resumen");
    // …el modelo se queda MUDO. Vence el timer → fallback mecánico con el TOTAL.
    await new Promise((r) => setTimeout(r, 80));

    const fallback = t.posts.find((p) => /Disparé 2 sub-agentes/.test(p));
    expect(fallback).toMatch(/ordenar viajes/);
    expect(fallback).toMatch(/armar resumen/);
    expect(t.turnDones).toBeGreaterThan(turnDonesBefore);
    expect(t.counts.at(-1)).toBe(2);

    // El anuncio LENTO del modelo, cuando al fin llega, se DESCARTA (el fallback ya salió).
    await coordinator.sink.message?.("Disparé dos sub-agentes, uno para viajes y otro para el resumen.");
    await flush();
    expect(t.posts.some((p) => /uno para viajes y otro/.test(p))).toBe(false);
  });

  it("anti-silencio (turno cerrado): si el coordinador cierra el turno sin texto, el fallback sale en el turnComplete (no espera al timer)", async () => {
    const { backend, sessions, onSend } = makeFake();
    const gw = makeGateway(backend); // timeout default (30s): NO debería hacer falta esperarlo
    const t = makeThread();
    onSend.fn = (s, txt) => {
      if (!txt.includes("[sos un SUB-AGENTE") && !txt.includes("[resultado del sub-agente")) {
        s.sink.turnComplete?.(USAGE, MODEL);
      }
    };
    await gw.handleIncoming(CLI, "tester", "hola", t.thread);
    await flush();
    const coordinator = need(sessions[0], "sesión del coordinador");

    await gw.spawnSubagentForUser(testerId, "reorganizá la wiki", "reorg wiki");
    // El modelo termina su turno con la tool-call y CERO texto (caso real de modelos chicos).
    coordinator.sink.turnComplete?.(USAGE, MODEL);
    await flush();

    expect(t.posts.some((p) => /Disparé un sub-agente para reorg wiki/.test(p))).toBe(true);
    expect(t.counts.at(-1)).toBe(1); // el worker sigue vivo (el fallback no toca el conteo)
  });

  it("coreografía OPTIMISTA: underhint + count salen ANTES de que el worker exista (startWorker lento); el anuncio espera al modelo", async () => {
    const { backend, sessions, onSend } = makeFake();
    // createWorkerSession lento (como el real: ~9s en la VM). La señal visible NO debe esperarlo.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const okWorker = need(backend.createWorkerSession, "createWorkerSession del fake");
    backend.createWorkerSession = async (vm) => {
      await gate;
      return okWorker(vm);
    };
    const gw = makeGateway(backend);
    const t = makeThread();
    onSend.fn = (s, txt) => {
      if (!txt.includes("[sos un SUB-AGENTE")) s.sink.turnComplete?.(USAGE, MODEL);
    };
    await gw.handleIncoming(CLI, "tester", "hola", t.thread);
    await flush();
    const postsBefore = t.posts.length;

    const spawning = gw.spawnSubagentForUser(testerId, "reorganizá la wiki", "reorg wiki");
    await flush();

    // La señal OPTIMISTA ya salió (underhint + count provisional 1) — sin post (el anuncio en
    // texto es del MODELO, después del despacho)…
    expect(t.activities).toContain("subagente creado");
    expect(t.counts.at(-1)).toBe(1);
    expect(t.posts.length).toBe(postsBefore);
    // …pero el worker AÚN NO existe (solo la sesión del coordinador).
    expect(sessions).toHaveLength(1);
    const emitsBeforeStart = t.counts.length;

    // El tool-result al modelo SÍ espera al startWorker real.
    release();
    const ack = await spawning;
    expect(ack).toMatch(/despachado \(id 1\): reorg wiki/);
    await flush();
    const worker = need(sessions[1], "sesión del worker");
    expect(worker.sent[0]).toMatch(/sos un SUB-AGENTE de ceibo/);

    // RE-AFIRMACIÓN del conteo al registrarse el worker REAL (post-startWorker): aunque el frame
    // optimista se hubiera perdido o pisado, este re-emit deja el mini-orb correcto (≥1).
    expect(t.counts.length).toBeGreaterThan(emitsBeforeStart);
    expect(t.counts.at(-1)).toBe(1);
  });

  it("rechaza despachar un 4º worker con 3 vivos (techo por usuario)", async () => {
    const { backend, onSend } = makeFake();
    const gw = makeGateway(backend, { SUBAGENT_MAX: "3", SUBAGENT_TIMEOUT_MS: "40" });
    const { thread } = makeThread();
    // Cierra cualquier turno que NO sea el prompt del worker (el "hola" y las inyecciones) para
    // que el coordinador no quede `busy` y los workers que expiren puedan drenar limpio.
    onSend.fn = (s, t) => {
      if (!t.includes("[sos un SUB-AGENTE")) s.sink.turnComplete?.(USAGE, MODEL);
    };
    await gw.handleIncoming(CLI, "tester", "hola", thread);

    const a = await gw.spawnSubagentForUser(testerId, "tarea 1", "t1");
    const b = await gw.spawnSubagentForUser(testerId, "tarea 2", "t2");
    const c = await gw.spawnSubagentForUser(testerId, "tarea 3", "t3");
    expect(a).toMatch(/despachado/);
    expect(b).toMatch(/despachado/);
    expect(c).toMatch(/despachado/);

    const d = await gw.spawnSubagentForUser(testerId, "tarea 4", "t4");
    expect(d).toMatch(/No pude despachar/);
    expect(d).toMatch(/3 sub-agentes/);

    await flush(); // dejá que los 3 workers expiren (timeout corto) y limpien
    await new Promise((r) => setTimeout(r, 60));
  });

  it("al vencer el timeout, ABORTA el turno remoto del worker, lo limpia del conteo e inyecta 'no terminó a tiempo'", async () => {
    const { backend, sessions, onSend } = makeFake();
    const gw = makeGateway(backend, { SUBAGENT_TIMEOUT_MS: "30" });
    const t = makeThread();
    // El worker NUNCA cierra su turno (no lo driveamos) → debe vencer el timeout. Cualquier OTRO
    // turno (el "hola" y la inyección del resultado) sí se cierra para no dejar al coordinador busy.
    onSend.fn = async (s, txt) => {
      if (txt.includes("[sos un SUB-AGENTE")) return; // worker: no lo cerramos → timeout
      if (txt.includes("[resultado del sub-agente")) await s.sink.message?.("avisé que quedó pendiente");
      s.sink.turnComplete?.(USAGE, MODEL);
    };
    await gw.handleIncoming(CLI, "tester", "hola", t.thread);
    await gw.spawnSubagentForUser(testerId, "tarea eterna", "eterna");

    await new Promise((r) => setTimeout(r, 60)); // > timeout
    const coordinator = need(sessions[0], "sesión del coordinador");
    const worker = need(sessions[1], "sesión del worker");
    expect(coordinator.sent.some((s) => /no terminó a tiempo/.test(s))).toBe(true);
    // El abort remoto salió (no dejamos la generación corriendo de fondo en la VM)…
    expect(worker.interrupts).toBeGreaterThanOrEqual(1);
    // …y el worker salió del registro/conteo (chip en 0, sin mini-orb fantasma).
    expect(t.counts.at(-1)).toBe(0);
  });

  it("subagent_kill por ID: aborta el turno remoto, baja el conteo YA y NO inyecta ningún resultado", async () => {
    const { backend, sessions, onSend } = makeFake();
    const gw = makeGateway(backend);
    const t = makeThread();
    onSend.fn = (s, txt) => {
      if (!txt.includes("[sos un SUB-AGENTE") && !txt.includes("[resultado del sub-agente")) {
        s.sink.turnComplete?.(USAGE, MODEL);
      }
    };
    await gw.handleIncoming(CLI, "tester", "hola", t.thread);
    await flush();
    const coordinator = need(sessions[0], "sesión del coordinador");

    await gw.spawnSubagentForUser(testerId, "contá despacio hasta 120", "contador lento");
    await flush();
    const worker = need(sessions[1], "sesión del worker");
    expect(t.counts.at(-1)).toBe(1);

    const out = await gw.killSubagentForUser(testerId, "1");
    await flush();
    expect(out).toMatch(/Cancelado el sub-agente \(id 1\): contador lento/);
    expect(out).toMatch(/Confirmale al usuario/);
    // Abort remoto del turno opencode del worker (su VM/sesión, no la del coordinador).
    expect(worker.interrupts).toBeGreaterThanOrEqual(1);
    expect(coordinator.interrupts).toBe(0);
    // Chip abajo YA (si era el último, desaparece) y SIN inyección de resultado al coordinador.
    expect(t.counts.at(-1)).toBe(0);
    expect(coordinator.sent.some((s) => /\[resultado del sub-agente/.test(s))).toBe(false);

    // Aunque el worker "termine" tarde (su turno remoto cierra después del abort), NO se inyecta
    // nada ni se re-registra: el kill ya lo resolvió.
    await worker.sink.message?.("…llegué a 87");
    worker.sink.turnComplete?.(USAGE, MODEL);
    await flush();
    expect(coordinator.sent.some((s) => /\[resultado del sub-agente/.test(s))).toBe(false);
    expect(t.counts.at(-1)).toBe(0);
  });

  it("subagent_kill por TÍTULO (substring único) — y con varios vivos sólo mata ése", async () => {
    const { backend, sessions, onSend } = makeFake();
    const gw = makeGateway(backend);
    const t = makeThread();
    onSend.fn = (s, txt) => {
      if (!txt.includes("[sos un SUB-AGENTE") && !txt.includes("[resultado del sub-agente")) {
        s.sink.turnComplete?.(USAGE, MODEL);
      }
    };
    await gw.handleIncoming(CLI, "tester", "hola", t.thread);
    await flush();

    await gw.spawnSubagentForUser(testerId, "contá hasta 120", "contador lento");
    await gw.spawnSubagentForUser(testerId, "ordená viajes", "reorg viajes");
    await flush();
    expect(t.counts.at(-1)).toBe(2);

    const out = await gw.killSubagentForUser(testerId, "contador");
    await flush();
    expect(out).toMatch(/Cancelado el sub-agente \(id 1\): contador lento/);
    const counter = need(sessions[1], "worker contador");
    const reorg = need(sessions[2], "worker reorg");
    expect(counter.interrupts).toBeGreaterThanOrEqual(1);
    expect(reorg.interrupts).toBe(0); // el otro worker sigue intacto
    expect(t.counts.at(-1)).toBe(1); // queda UNO trabajando
  });

  it("subagent_kill: ref ambigua lista los vivos; ref inexistente o sin workers responde claro", async () => {
    const { backend, onSend } = makeFake();
    const gw = makeGateway(backend);
    const t = makeThread();
    onSend.fn = (s, txt) => {
      if (!txt.includes("[sos un SUB-AGENTE") && !txt.includes("[resultado del sub-agente")) {
        s.sink.turnComplete?.(USAGE, MODEL);
      }
    };
    await gw.handleIncoming(CLI, "tester", "hola", t.thread);
    await flush();

    // Sin workers vivos → respuesta clara, sin throw.
    expect(await gw.killSubagentForUser(testerId, "1")).toMatch(/No hay ningún sub-agente/);

    await gw.spawnSubagentForUser(testerId, "tarea 1", "contar manzanas");
    await gw.spawnSubagentForUser(testerId, "tarea 2", "contar naranjas");
    await flush();

    // Substring que matchea a los dos → pide el id y lista los vivos.
    const ambiguo = await gw.killSubagentForUser(testerId, "contar");
    expect(ambiguo).toMatch(/varios sub-agentes/);
    expect(ambiguo).toMatch(/id 1: «contar manzanas»/);
    expect(ambiguo).toMatch(/id 2: «contar naranjas»/);
    expect(t.counts.at(-1)).toBe(2); // no mató a ninguno

    // Ref inexistente → lista los vivos.
    const nada = await gw.killSubagentForUser(testerId, "regar el jardín");
    expect(nada).toMatch(/No encontré ese sub-agente/);
    expect(nada).toMatch(/id 1: «contar manzanas»/);

    // Usuario desconocido → throw (como spawn).
    await expect(gw.killSubagentForUser(99999, "1")).rejects.toThrow(/desconocido/);
  });

  it("inyecta SOLO el último mensaje del worker, capado (no el crudo completo)", async () => {
    const { backend, sessions, onSend } = makeFake();
    const gw = makeGateway(backend, { SUBAGENT_SUMMARY_CAP: "120" });
    const { thread } = makeThread();
    onSend.fn = (s, t) => {
      if (!t.includes("[sos un SUB-AGENTE") && !t.includes("[resultado del sub-agente")) {
        s.sink.turnComplete?.(USAGE, MODEL);
      }
    };
    await gw.handleIncoming(CLI, "tester", "hola", thread);
    await flush();
    const coordinator = need(sessions[0], "sesión del coordinador");

    await gw.spawnSubagentForUser(testerId, "tarea", "tarea");
    await flush();
    const worker = need(sessions[1], "sesión del worker");

    // El worker narra (mensaje intermedio) y después cierra con un resumen LARGO (> cap).
    await worker.sink.message?.("voy a hidratar y reorganizar… [narración intermedia ruidosa]");
    const longSummary = `RESUMEN: ${"x".repeat(300)} FIN`;
    await worker.sink.message?.(longSummary);
    worker.sink.turnComplete?.(USAGE, MODEL);
    await flush();

    const injected = need(
      coordinator.sent.find((t) => /\[resultado del sub-agente "tarea"/.test(t)),
      "inyección del resultado",
    );
    // El intermedio NO viaja; sí el resumen (último), recortado y marcado.
    expect(injected).not.toMatch(/narración intermedia/);
    expect(injected).toMatch(/RESUMEN: x+/);
    expect(injected).toMatch(/…resumen recortado/);
    expect(injected).not.toContain("x".repeat(300)); // no entró el resumen entero
  });

  it("anexa verificación de diff real cuando el worker reporta pushed:false pero la wiki cambió", async () => {
    const repo = addRepo(db, "org", "wiki");
    grantAccess(db, repo.id, testerId, "owner");
    const { backend, sessions, onSend } = makeFake();
    const headSha = vi.fn(async () => (headSha.mock.calls.length === 1 ? "before" : "after"));
    const wikis = {
      headSha,
      diffFiles: vi.fn(async () => ({
        added: [{ path: "nota.md", sha: "a" }],
        removed: [],
        renamed: [],
        modified: [],
        commits: [{ sha: "c1", message: "agent: edit" }],
      })),
    } as unknown as Wikis;
    const gw = makeGateway(backend, {}, wikis);
    const { thread } = makeThread();
    onSend.fn = (s, t) => {
      if (!t.includes("[sos un SUB-AGENTE") && !t.includes("[resultado del sub-agente")) {
        s.sink.turnComplete?.(USAGE, MODEL);
      }
    };

    await gw.handleIncoming(CLI, "tester", "hola", thread);
    await flush();
    const coordinator = need(sessions[0], "sesión del coordinador");

    await gw.spawnSubagentForUser(testerId, "editá nota", "editar nota");
    await flush();
    const worker = need(sessions[1], "sesión del worker");

    await worker.sink.message?.(`\`\`\`json
{"status":"done","pushed":false,"summary_for_user":"Edité la nota."}
\`\`\``);
    worker.sink.turnComplete?.(USAGE, MODEL);
    await flush();

    const injected = need(
      coordinator.sent.find((t) => /\[resultado del sub-agente "editar nota"/.test(t)),
      "inyección del resultado",
    );
    expect(injected).toContain("Verificación real:");
    expect(injected).toContain(
      "se detectaron cambios reales en 1 wiki(s), aunque el worker reportó pushed:false",
    );
    expect(wikis.diffFiles).toHaveBeenCalledWith("wiki", "before", "after");
  });

  it("spawn FALLIDO: señal optimista + CORRECCIÓN honesta (error mecánico, count baja, la explicación del modelo se postea)", async () => {
    const { backend, sessions, onSend } = makeFake();
    // El backend no puede crear la sesión del worker (caso real medido: el MCP/AV rebota).
    const boom = async (): Promise<string> => {
      throw new Error("Falta el token de autorización.");
    };
    const okWorker = backend.createWorkerSession;
    backend.createWorkerSession = boom;
    const gw = makeGateway(backend);
    const t = makeThread();
    onSend.fn = (s, txt) => {
      if (!txt.includes("[sos un SUB-AGENTE") && !txt.includes("[resultado del sub-agente")) {
        s.sink.turnComplete?.(USAGE, MODEL);
      }
    };
    await gw.handleIncoming(CLI, "tester", "hola", t.thread);
    await flush();
    const coordinator = need(sessions[0], "sesión del coordinador");

    const out = await gw.spawnSubagentForUser(testerId, "reorganizá la wiki", "reorg wiki");
    await flush();

    // El tool result le dice la VERDAD al modelo (que NO bluffee "disparé un sub-agente").
    expect(out).toMatch(/NO se pudo crear el sub-agente/);
    expect(out).toMatch(/Falta el token de autorización/);
    expect(out).not.toMatch(/despachado/);

    // La corrección honesta sale mecánica (el usuario vio el underhint/count optimistas).
    expect(
      t.posts.some((p) => /No pude crear el sub-agente \(Falta el token de autorización\.\)/.test(p)),
    ).toBe(true);
    expect(t.posts.some((p) => /Probá de nuevo en un momento/.test(p))).toBe(true);
    // El count provisional subió a 1 con la señal y VOLVIÓ a bajar a 0 con la corrección.
    expect(t.counts).toContain(1);
    expect(t.counts.at(-1)).toBe(0); // ningún mini-orb fantasma

    // El texto tardío del modelo NO se suprime tras el fallo (su explicación es legítima): el
    // ÚNICO spawn del turno falló → la coreografía de anuncio se canceló entera.
    await coordinator.sink.message?.("No pude despachar el sub-agente, hubo un problema de permisos.");
    await flush();
    expect(t.posts.some((p) => /problema de permisos/.test(p))).toBe(true);

    // El registro quedó limpio: el fallo NO cuenta contra el techo y un reintento sano despacha.
    backend.createWorkerSession = okWorker;
    const retry = await gw.spawnSubagentForUser(testerId, "reorganizá la wiki", "reorg wiki");
    expect(retry).toMatch(/despachado \(id 2\)/);
    await flush();
  });

  it("el usage del worker se asienta al usuario bajo la SESIÓN DEL WORKER, no como turno del coordinador", async () => {
    const { backend, sessions, onSend } = makeFake();
    const gw = makeGateway(backend);
    const { thread } = makeThread();
    onSend.fn = (s, txt) => {
      if (!txt.includes("[sos un SUB-AGENTE") && !txt.includes("[resultado del sub-agente")) {
        s.sink.turnComplete?.(USAGE, MODEL);
      }
    };
    await gw.handleIncoming(CLI, "tester", "hola", thread);
    await flush();
    const coordinator = need(sessions[0], "sesión del coordinador");

    await gw.spawnSubagentForUser(testerId, "tarea", "tarea");
    await flush();
    const worker = need(sessions[1], "sesión del worker");

    await worker.sink.message?.("resumen del laburo");
    worker.sink.turnComplete?.({ input: 7000, output: 30, cache5m: 0, cache1h: 0, cacheRead: 0 }, MODEL);
    await flush();

    // La fila del worker existe, bajo SU session_id (ledger del usuario, sesión propia).
    const rows = db
      .prepare("SELECT session_id, input_tokens, output_tokens FROM usage_turns ORDER BY id")
      .all() as Array<{ session_id: string; input_tokens: number; output_tokens: number }>;
    const workerRows = rows.filter((r) => r.session_id === worker.sid);
    expect(workerRows).toEqual([{ session_id: worker.sid, input_tokens: 7000, output_tokens: 30 }]);
    // Ninguna fila del worker quedó asentada a la sesión del coordinador con esos tokens.
    expect(rows.filter((r) => r.session_id === coordinator.sid && r.input_tokens === 7000)).toEqual([]);
    // Y el snapshot de metering del chat sigue apuntando a la sesión del COORDINADOR (recordTurn
    // acá lo habría pisado con la sesión del worker → metering roto).
    const sess = db.prepare("SELECT session_id FROM sessions WHERE user_id = ?").get(testerId) as {
      session_id: string;
    };
    expect(sess.session_id).toBe(coordinator.sid);
  });

  it("un usuario MA (no archima) recibe el rechazo y no despacha nada", async () => {
    const { backend, sessions } = makeFake();
    const gw = makeGateway(backend);
    setUserBackendMode(db, testerId, "ma"); // de vuelta a MA

    const out = await gw.spawnSubagentForUser(testerId, "lo que sea", "x");
    expect(out).toMatch(/sólo están disponibles en archima/);
    await flush();
    expect(sessions).toHaveLength(0); // no se creó ninguna sesión worker
  });

  it("tira si el usuario es desconocido", async () => {
    const { backend } = makeFake();
    const gw = makeGateway(backend);
    await expect(gw.spawnSubagentForUser(99999, "x")).rejects.toThrow(/desconocido/);
  });
});

describe("relay del coordinador — sin pumps duplicados (bug E)", () => {
  it("dos turnos CONCURRENTES con relay frío attachean UN solo pump (dedup de ensureRelay)", async () => {
    const { backend, sessions, onSend } = makeFake();
    // reuseOrCreate lento (como el cp.sh real): es la ventana donde dos ensureRelay concurrentes
    // pasaban ambos el `if (ctx.relay)` y attacheaban DOS pumps al mismo canal — el perdedor
    // quedaba vivo para siempre duplicando frames y contabilidad.
    const orig = backend.reuseOrCreate;
    backend.reuseOrCreate = async (c, t, existing) => {
      await new Promise((r) => setTimeout(r, 20));
      return orig(c, t, existing);
    };
    const gw = makeGateway(backend);
    const { thread } = makeThread();
    onSend.fn = (s) => s.sink.turnComplete?.(USAGE, MODEL);

    await Promise.all([
      gw.handleIncoming(CLI, "tester", "uno", thread),
      gw.handleIncoming(CLI, "tester", "dos", thread),
    ]);
    await flush();

    // UNA sola sesión attacheada (antes: 2 — un pump por llamada) y AMBOS mensajes por ella.
    expect(sessions).toHaveLength(1);
    const s = need(sessions[0], "sesión única");
    expect(s.sent.some((t) => /uno/.test(t))).toBe(true);
    expect(s.sent.some((t) => /dos/.test(t))).toBe(true);
  });
});
