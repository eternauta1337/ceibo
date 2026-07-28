// Título del chat (tema actual): tras un turno interactivo con sustancia, el gateway le pide a
// haiku un título corto y lo emite por el PostTarget (frame `chat-title` en el canal remoto).
// Acá ejercitamos ese camino llamando handleIncoming directo con:
//  - un fakeBackend en memoria (la costura SessionBackend): su relay.send emite una respuesta y
//    cierra el turno (sink.message → sink.turnComplete), igual que el e2e del cli;
//  - un cliente Anthropic MOCKEADO (NO se llama la API real): captura el call y devuelve un
//    título scripteado;
//  - un PostTarget que captura `chatTitle` (lo que un canal web pintaría en el header).
// Verifica el gate de sustancia, el no-parpadeo (mismo tema → no re-emite) y que un canal sin
// `chatTitle` (telegram/cli) no dispara el call de haiku.

import type { SessionBackend, Sink } from "@ceibo/agent";
import type { ChannelPolicy, PostTarget } from "@ceibo/channels";
import { addChannel, addUser, openDb } from "@ceibo/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGateway } from "./engine.ts";

type Db = ReturnType<typeof openDb>;

// Canal "web" (como el remoto): el PostTarget implementa chatTitle.
const WEB: ChannelPolicy = { name: "web", echoTranscript: false };

// fakeBackend: el agente "responde" un texto fijo y cierra el turno con un usage acumulado.
function makeFakeBackend(reply: string): SessionBackend {
  return {
    createVault: async () => "vault-fake",
    setStaticBearerCredential: async () => {},
    revokeOauthCredential: async () => false,
    setSessionAgentConfig: async () => {},
    createSession: async () => "sess-fake",
    reuseOrCreate: async () => "sess-fake",
    attach: (_sid: string, sink: Sink) => ({
      send: async (_text: string) => {
        await sink.message(reply);
        await sink.turnComplete?.({ input: 10, output: 5, cache5m: 0, cache1h: 0, cacheRead: 0 }, "haiku");
      },
      interrupt: async () => {},
      close: () => {},
    }),
  };
}

// PostTarget que captura lo que el canal pintaría. `withTitle=false` espeja un canal
// texto-nativo (telegram/cli) que NO implementa chatTitle.
function makeTarget(withTitle = true): { target: PostTarget; titles: string[]; posts: string[] } {
  const titles: string[] = [];
  const posts: string[] = [];
  const target: PostTarget = {
    post: async (t) => void posts.push(t),
    startTyping: async () => {},
    ...(withTitle ? { chatTitle: async (t: string) => void titles.push(t) } : {}),
  };
  return { target, titles, posts };
}

let db: Db;
const create = vi.fn();

function makeGw(reply: string) {
  return createGateway({
    env: { AGENT_ID: "agent-test", ENV_ID: "env-test" } as NodeJS.ProcessEnv,
    client: { messages: { create } } as never,
    backendForUser: () => makeFakeBackend(reply),
    db,
    cfg: { agentId: "agent-test", envId: "env-test" },
    wikis: undefined,
    cronTarget: () => undefined,
  });
}

beforeEach(() => {
  create.mockReset();
  db = openDb(":memory:");
  const u = addUser(db, "tester");
  addChannel(db, u.id, "web", "tester");
});

afterEach(() => db.close());

// Deja drenar el .then() async de maybeUpdateChatTitle (no se awaitea en turnComplete).
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("gateway · título del chat (chat-title)", () => {
  it("turno interactivo con sustancia → llama a haiku y emite el título", async () => {
    create.mockResolvedValue({ content: [{ type: "text", text: "Noticias del mundo" }] });
    const gw = makeGw("Hoy pasaron varias cosas importantes.");
    const { target, titles } = makeTarget();

    await gw.handleIncoming(WEB, "tester", "contame las noticias de hoy por favor", target);
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ model: "claude-haiku-4-5", max_tokens: 24 });
    expect(titles).toEqual(["Noticias del mundo"]);
  });

  it("salta turnos triviales (saludo) → ni call de haiku ni título", async () => {
    const gw = makeGw("¡Hola! ¿En qué te ayudo?");
    const { target, titles } = makeTarget();

    await gw.handleIncoming(WEB, "tester", "hola", target);
    await flush();

    expect(create).not.toHaveBeenCalled();
    expect(titles).toEqual([]);
  });

  it("no re-emite si el tema no cambió (haiku devuelve OK)", async () => {
    const gw = makeGw("respuesta con sustancia y contenido");
    const { target, titles } = makeTarget();

    create.mockResolvedValueOnce({ content: [{ type: "text", text: "Plan viaje a Japón" }] });
    await gw.handleIncoming(WEB, "tester", "armemos el viaje a Japón para marzo", target);
    await flush();

    create.mockResolvedValueOnce({ content: [{ type: "text", text: "OK" }] });
    await gw.handleIncoming(WEB, "tester", "y qué ciudades me recomendás visitar", target);
    await flush();

    expect(create).toHaveBeenCalledTimes(2); // se consultó las dos veces…
    expect(titles).toEqual(["Plan viaje a Japón"]); // …pero sólo se emitió una (OK = mantener)
  });

  it("canal sin chatTitle (telegram/cli) → no gasta un call de haiku", async () => {
    const gw = makeGw("una respuesta con bastante sustancia");
    const { target, titles } = makeTarget(false); // PostTarget sin chatTitle

    await gw.handleIncoming(WEB, "tester", "contame algo interesante del universo", target);
    await flush();

    expect(create).not.toHaveBeenCalled();
    expect(titles).toEqual([]);
  });

  it("un error de haiku no rompe el turno (best-effort)", async () => {
    create.mockRejectedValue(new Error("haiku caído"));
    const gw = makeGw("respuesta con sustancia suficiente");
    const { target, titles, posts } = makeTarget();

    await gw.handleIncoming(WEB, "tester", "explicame cómo funciona la fotosíntesis", target);
    await flush();

    expect(posts).toContain("respuesta con sustancia suficiente"); // la respuesta del agente salió igual
    expect(titles).toEqual([]); // sin título, pero sin crashear
  });
});
