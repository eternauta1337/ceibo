// E2E del gateway (Ola 5): un turno real cruzando canal cli → handleIncoming → Sink → canal.
//
// Es hermético, NO toca servicios vivos:
//  - El backend MA (`@ceibo/agent`) está fakeado (`vi.mock`): `attach` captura el Sink y el
//    FakeRelay lo maneja — `send(text)` emite una respuesta scriptada + cierra el turno con un
//    usage fijo. Sin red, sin tokens, sin modelo real.
//  - El store es real sobre `:memory:` (seed con addUser/addChannel; metering en usage_turns).
//  - El driver es el canal cli REAL (unix socket NDJSON), igual que `ceibo chat <handle>`.
//
// Prueba el CABLEADO que los unit no tocan: ruteo por identidad, el pump Relay→Sink, el egress
// de la respuesta al canal, los side-effects en el store (sesión + metering) y un comando (/new).

import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionBackend, Sink } from "@ceibo/agent";
import type { PostTarget } from "@ceibo/channels";
import type { Wikis } from "@ceibo/wikis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capturas compartidas con la factory de vi.mock (hoisteada → vi.hoisted para evitar TDZ).
const h = vi.hoisted(() => ({
  sinks: [] as Sink[], // los Sink que recibió cada attach()
  sent: [] as string[], // los textos que el gateway empujó al agente (relay.send)
  reply: "eco", // qué responde el FakeRelay (prefijo)
  // MA reporta usage ACUMULADO de la sesión; recordTurn guarda el delta. El fake acumula
  // un "step" fijo por turno para que cada turno deje su fila (delta no-cero).
  step: { input: 100, output: 50, cache5m: 0, cache1h: 0, cacheRead: 0 },
  cum: { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheRead: 0 },
  model: "claude-haiku-4-5",
  // Si está seteado, el FakeRelay simula una falla de API en vez de responder: llama
  // sink.error(errorReply) y cierra el turno con turnComplete (como hace el pump real ante un
  // session.error de límite de uso seguido de un status_idle retries_exhausted).
  errorReply: undefined as string | undefined,
}));

// fakeBackend: implementa la costura SessionBackend en memoria (la inyectamos como dep en vez
// de mockear el módulo). attach captura el Sink; ante un send(text) del gateway el agente
// "responde" un eco y el turno "termina" con un usage acumulado fijo. Determinista, en
// microtasks. Sin red, sin tokens, sin modelo real.
const fakeBackend: SessionBackend = {
  createVault: async () => "vault-fake",
  setStaticBearerCredential: async () => {},
  revokeOauthCredential: async () => false,
  setSessionAgentConfig: async () => {},
  createSession: async () => "sess-fake",
  reuseOrCreate: async () => "sess-fake",
  attach: (_sid, sink) => {
    h.sinks.push(sink);
    return {
      send: async (text: string) => {
        h.sent.push(text);
        if (h.errorReply !== undefined) {
          // Falla de API: surfaceamos el error al canal y cerramos el turno (no colgamos).
          await sink.error?.(h.errorReply);
          await sink.turnComplete?.({ ...h.cum }, h.model);
          return;
        }
        h.cum = {
          input: h.cum.input + h.step.input,
          output: h.cum.output + h.step.output,
          cache5m: h.cum.cache5m + h.step.cache5m,
          cache1h: h.cum.cache1h + h.step.cache1h,
          cacheRead: h.cum.cacheRead + h.step.cacheRead,
        };
        await sink.message(`${h.reply}: ${text}`);
        await sink.turnComplete?.({ ...h.cum }, h.model);
      },
      interrupt: async () => {},
      close: () => {},
    };
  },
};

const { createGateway } = await import("./engine.ts");
const { startCliChannel } = await import("@ceibo/channels");
const {
  addChannel,
  addRepo,
  addUser,
  getOauthGrant,
  grantAccess,
  openDb,
  setUserBackendMode,
  setUserLocation,
  setUserVault,
  upsertOauthGrant,
} = await import("@ceibo/store");

type Db = ReturnType<typeof openDb>;

let db: Db;
let channel: { close(): void };
let sock: string;
let sockN = 0;
let gw: ReturnType<typeof createGateway>;
let testerId: number;

beforeEach(() => {
  h.sinks.length = 0;
  h.sent.length = 0;
  h.errorReply = undefined;
  h.cum = { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheRead: 0 };
  db = openDb(":memory:");
  // Un usuario del allowlist con identidad de canal cli "tester".
  const u = addUser(db, "tester");
  testerId = u.id;
  addChannel(db, u.id, "cli", "tester");

  gw = createGateway({
    env: { AGENT_ID: "agent-test", ENV_ID: "env-test" } as NodeJS.ProcessEnv,
    client: {} as never, // sin wikis no se sube wiki-sync → el client no se usa
    backendForUser: () => fakeBackend, // el selector resuelve a este SessionBackend en memoria
    db,
    cfg: { agentId: "agent-test", envId: "env-test" },
    wikis: undefined, // chat pelado: sin vault ni montaje de repos
    cronTarget: () => undefined,
  });

  sock = join(tmpdir(), `ceibo-e2e-${process.pid}-${sockN++}.sock`);
  channel = startCliChannel(sock, {
    handleIncoming: gw.handleIncoming,
    sendBroadcast: gw.sendBroadcast,
  });
});

afterEach(() => {
  channel.close();
  db.close();
});

// Driver: conecta al socket cli, hace hello+msg como `ceibo chat`, junta los frames `out`
// (las respuestas que vuelven por el canal) y resuelve cuando el socket queda en silencio.
function dialog(externalId: string, text: string): Promise<{ out: string[]; typing: number }> {
  return new Promise((resolve, reject) => {
    const out: string[] = [];
    let typing = 0;
    let buf = "";
    let quiet: ReturnType<typeof setTimeout>;
    const conn = net.connect(sock);
    const settle = () => {
      conn.end();
      resolve({ out, typing });
    };
    const bump = () => {
      clearTimeout(quiet);
      quiet = setTimeout(settle, 80); // 80ms sin frames nuevos → el turno terminó
    };
    conn.on("connect", () => conn.write(`${JSON.stringify({ t: "hello", externalId })}\n`));
    conn.on("data", (d) => {
      buf += d.toString("utf8");
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: drain NDJSON
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line) as { t: string; text?: string };
        if (m.t === "ready") {
          conn.write(`${JSON.stringify({ t: "msg", text })}\n`);
          bump();
        } else if (m.t === "out") {
          out.push(m.text ?? "");
          bump();
        } else if (m.t === "typing") {
          typing++;
          bump();
        }
      }
    });
    conn.on("error", reject);
  });
}

function turns(): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM usage_turns ORDER BY id").all() as Array<Record<string, unknown>>;
}

function thread(): PostTarget {
  return {
    post: async () => {},
    startTyping: async () => {},
  };
}

function fakeWikis(filesByRepo: Record<string, Record<string, string>>): Wikis {
  return {
    org: "ceibo-test",
    tree: async (repoName: string) => ({
      ref: "head-fake",
      paths: Object.keys(filesByRepo[repoName] ?? {}),
    }),
    read: async (repoName: string, ref?: string, paths?: string[]) => {
      const files = filesByRepo[repoName] ?? {};
      const selected = paths ?? Object.keys(files);
      return {
        ref: ref ?? "head-fake",
        files: selected
          .filter((path) => files[path] !== undefined)
          .map((path) => ({ path, content: files[path] ?? "", sha: `sha-${path}` })),
      };
    },
  } as unknown as Wikis;
}

describe("gateway e2e — canal cli → motor → Sink", () => {
  it("rutea un turno al agente, emite la respuesta por el canal y contabiliza el metering", async () => {
    const { out, typing } = await dialog("tester", "hola");

    // El gateway le pasó el turno al agente (relay.send) con el texto del usuario, precedido
    // por el tag de hora actual (ancla inequívoca con offset) que se antepone a TODO turno.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(
      /^\[fecha y hora actual: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]\n/,
    );
    expect(h.sent[0]?.endsWith("\nhola")).toBe(true);
    // La respuesta del agente volvió por el canal cli (el eco refleja el turno, que ahora
    // arranca con el tag de hora; nos basta confirmar que terminó con el texto del usuario).
    expect(out.some((o) => o.endsWith("hola"))).toBe(true);
    // Hubo señal de "typing" (el canal arrancó a responder).
    expect(typing).toBeGreaterThanOrEqual(1);
    // Se atachó exactamente un Sink (una sesión MA para el usuario).
    expect(h.sinks).toHaveLength(1);

    // El turno quedó contabilizado en usage_turns (delta = el usage acumulado, snapshot fresco en 0).
    const rows = turns();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.session_id).toBe("sess-fake");
    expect(rows[0]?.model).toBe("claude-haiku-4-5");
    expect(rows[0]?.input_tokens).toBe(100);
    expect(rows[0]?.output_tokens).toBe(50);
  });

  it("inyecta la ubicación del usuario como tag de contexto cuando está seteada", async () => {
    setUserLocation(db, testerId, "Buenos Aires, Argentina");
    await dialog("tester", "hola");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("[ubicación: Buenos Aires, Argentina]");
  });

  it("NO inyecta tag de ubicación cuando el usuario no la configuró (graceful)", async () => {
    await dialog("tester", "hola"); // tester sin location seteada
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).not.toContain("[ubicación:");
  });

  it("inyecta memoria relevante server-side cuando una nota de memoria matchea el turno", async () => {
    const repo = addRepo(db, "ceibo-test", "tester-personal");
    grantAccess(db, repo.id, testerId);
    gw = createGateway({
      env: { AGENT_ID: "agent-test", ENV_ID: "env-test" } as NodeJS.ProcessEnv,
      client: {} as never,
      backendForUser: () => fakeBackend,
      db,
      cfg: { agentId: "agent-test", envId: "env-test" },
      wikis: fakeWikis({
        "tester-personal": {
          "memoria/familia.md": "A Vera le gusta la pasta con pesto los domingos.",
          "notas/suelta.md": "Vera aparece acá, pero no es memoria.",
        },
      }),
      cronTarget: () => undefined,
    });

    await gw.handleIncoming(
      { name: "cli", echoTranscript: false },
      "tester",
      "que le gusta comer a Vera?",
      thread(),
    );
    await new Promise((r) => setTimeout(r, 5));

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("[memoria relevante:");
    expect(h.sent[0]).toContain("personal/memoria/familia.md");
    expect(h.sent[0]).toContain("pasta con pesto");
    expect(h.sent[0]).not.toContain("notas/suelta.md");
  });

  it("ignora una identidad fuera del allowlist (no atacha sesión ni contabiliza)", async () => {
    const { out } = await dialog("intruso", "hola");

    expect(out).toEqual([]); // sin respuesta
    expect(h.sent).toEqual([]); // nunca se le pasó al agente
    expect(h.sinks).toHaveLength(0); // no se atachó relay
    expect(turns()).toHaveLength(0); // sin metering
  });

  it("/new crea una sesión nueva y lo confirma SIN mostrar el session id (interna)", async () => {
    const { out } = await dialog("tester", "/new");

    expect(out).toContain("Listo, sesión nueva: arrancamos de cero.");
    // El sid (en archima: nombre de VM con el env id adentro) NO viaja al canal (owner, 2026-06-10).
    expect(out.join("\n")).not.toContain("sess-fake");
    expect(h.sent).toEqual([]); // /new es un comando: no es un turno del agente
    expect(turns()).toHaveLength(0); // un comando no contabiliza
  });

  it("un error de API (sink.error) se le muestra al usuario por el canal y el turno cierra", async () => {
    h.errorReply = "⚠️ No puedo responder ahora: se alcanzó el límite de uso de la workspace de Anthropic.";
    const { out } = await dialog("tester", "hola");

    // El gateway le pasó el turno al agente, pero la respuesta fue el ERROR (no se colgó mudo).
    // (el texto va precedido por el tag de hora actual que se antepone a todo turno)
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.endsWith("\nhola")).toBe(true);
    expect(out.some((o) => o.includes("límite de uso de la workspace de Anthropic"))).toBe(true);
    // El turno cerró (turnComplete contabilizó): el ctx no quedó `busy` colgado.
    expect(h.sinks).toHaveLength(1);
  });

  it("dos turnos del mismo usuario reusan la sesión y acumulan dos filas de metering", async () => {
    await dialog("tester", "hola");
    await dialog("tester", "de nuevo");

    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]?.endsWith("\nhola")).toBe(true);
    expect(h.sent[1]?.endsWith("\nde nuevo")).toBe(true);
    // Una sola sesión (el segundo turno reusa el relay vivo → un único attach).
    expect(h.sinks).toHaveLength(1);
    expect(turns()).toHaveLength(2);
  });
});

// runCommandForUser: el path que usa el MCP `control` (tool ceibo_command). Corre el MISMO
// dispatch que el canal, pero captura la salida del handler y la devuelve (en vez de postearla
// a un canal), sin pasar por el agente ni contabilizar.
describe("gateway · runCommandForUser (MCP control)", () => {
  it("corre un comando conocido y devuelve la salida del handler (sin tocar al agente)", async () => {
    const out = await gw.runCommandForUser(testerId, "/session");

    expect(out).toBe("(sin sesión todavía)"); // /session sin sesión viva
    expect(h.sent).toEqual([]); // no fue un turno del agente
    expect(turns()).toHaveLength(0); // un comando no contabiliza
  });

  it("acepta la línea sin la barra inicial (la normaliza)", async () => {
    const out = await gw.runCommandForUser(testerId, "session");
    expect(out).toBe("(sin sesión todavía)");
  });

  it("/new recrea la sesión y devuelve la confirmación (sin el session id)", async () => {
    const out = await gw.runCommandForUser(testerId, "/new");

    expect(out).toBe("Listo, sesión nueva: arrancamos de cero.");
    expect(out).not.toContain("sess-fake");
    expect(h.sinks).toHaveLength(1); // se atachó la sesión nueva
    expect(h.sent).toEqual([]); // sin turno del agente
  });

  it("tira si el comando no existe", async () => {
    await expect(gw.runCommandForUser(testerId, "/frobnicate")).rejects.toThrow(/comando desconocido/);
  });

  it("tira si el usuario es desconocido", async () => {
    await expect(gw.runCommandForUser(99999, "/session")).rejects.toThrow(/desconocido/);
  });

  it("/connect reconoce el servicio case-insensitive: 'Gmail' no da 'No conozco' (#484)", async () => {
    // gemma a veces pasa el servicio capitalizado ('Gmail'); knownService es case-sensitive
    // (SERVICES[name], keys minúsculas) → sin normalizar daba "No conozco Gmail", el connect quedaba
    // sin URL y el modelo escupía un placeholder. El /connect ahora lo baja a minúscula.
    const out = await gw.runCommandForUser(testerId, "/connect Gmail trabajo");
    expect(out).not.toMatch(/No conozco/i); // reconocido pese a la mayúscula (llega al paso siguiente)
  });
});

// Clear diario de sesión por timezone (quickboot/sessions §3). El invariante crítico: NUNCA
// dispara en el arranque (lazy-init programa el próximo 4am a futuro) ni toca usuarios 'ma'. Un
// fire positivo depende del reloj de pared (4am del tz), no testeable sin viajar en el tiempo;
// acá fijamos la propiedad de seguridad (no re-resetea de más), que es lo que protege al usuario.
describe("gateway · runDailyClears (clear diario por-tz)", () => {
  it("no dispara en el primer tick: lazy-init programa el próximo 4am (no resetea al arrancar)", async () => {
    setUserBackendMode(db, testerId, "local"); // el clear sólo toca usuarios locales
    await gw.runCommandForUser(testerId, "/new"); // sesión viva (1 attach)
    expect(h.sinks).toHaveLength(1);
    gw.runDailyClears(); // 1er tick: lazy-init → NO dispara
    gw.runDailyClears(); // 2do tick: el 4am sigue en el futuro → NO dispara
    expect(h.sinks).toHaveLength(1); // ninguna sesión recreada
  });

  it("ignora a los usuarios 'ma' (su sesión se compacta server-side, no se clarea)", async () => {
    await gw.runCommandForUser(testerId, "/new"); // tester es 'ma' por default
    expect(h.sinks).toHaveLength(1);
    gw.runDailyClears();
    expect(h.sinks).toHaveLength(1); // no tocó al usuario 'ma'
  });
});

// Muerte de grant (invalid_grant) → notificación out-of-band al canal del usuario con el link de
// reconexión. Cruza oauth (refresh detecta+marca) → gateway (postToUser al canal). Hermético: el
// fetch del refresh se stubbea a un HTTP 400 invalid_grant; el resto es el gateway real sobre cli.
describe("gateway e2e — notificación de grant muerto (invalid_grant)", () => {
  let ndb: Db;
  let nchannel: { close(): void };
  let nsock: string;
  let ngw: ReturnType<typeof createGateway>;
  let uid: number;
  // Spy de la entrega durable (el bootstrap real inserta el item del 🔔; acá capturamos las llamadas
  // y controlamos si la entrega "salió bien" para ejercitar el retry-hasta-entregar + sellado).
  let notifyCalls: Array<{ service: string; profile: string; url: string }>;
  let deliverOk: boolean;

  beforeEach(() => {
    h.sinks.length = 0;
    h.sent.length = 0;
    h.errorReply = undefined;
    notifyCalls = [];
    deliverOk = true;
    ndb = openDb(":memory:");
    const u = addUser(ndb, "brokentester");
    uid = u.id;
    addChannel(ndb, u.id, "cli", "brokentester");
    setUserVault(ndb, u.id, "vault-1"); // el refresh necesita un vault donde (intentaría) pushear
    // Grant vencido (due) → el turno lo intenta refrescar; el fetch stubeado devuelve invalid_grant.
    upsertOauthGrant(ndb, {
      user_id: u.id,
      service: "gmail",
      profile: "personal",
      provider: "google",
      mcp_url: "https://mcp/gmail?profile=personal",
      display_name: "Gmail (personal)",
      account: "yo@gmail.com",
      broken_at: null,
      notified_at: null,
      refresh_token: "rt-muerto",
      access_token: "at-viejo",
      expires_at: "2020-01-01T00:00:00.000Z",
      scope: "s",
    });

    ngw = createGateway({
      env: {
        AGENT_ID: "agent-test",
        ENV_ID: "env-test",
        OAUTH_BASE_URL: "https://oauth.ceibo.test",
        GOOGLE_CLIENT_ID: "cid",
        GOOGLE_CLIENT_SECRET: "secret",
      } as NodeJS.ProcessEnv,
      client: {} as never,
      backendForUser: () => fakeBackend,
      db: ndb,
      cfg: { agentId: "agent-test", envId: "env-test" },
      wikis: undefined,
      cronTarget: () => undefined,
      // Espeja al bootstrap: recibe el grant roto + el link ya armado; devuelve si la entrega
      // durable salió bien (el motor sella notified_at sólo si true).
      notifyGrantBroken: async (_user, grant, url) => {
        notifyCalls.push({ service: grant.service, profile: grant.profile, url });
        return deliverOk;
      },
    });

    nsock = join(tmpdir(), `ceibo-e2e-broken-${process.pid}-${sockN++}.sock`);
    nchannel = startCliChannel(nsock, {
      handleIncoming: ngw.handleIncoming,
      sendBroadcast: ngw.sendBroadcast,
    });

    // Google responde HTTP 400 invalid_grant cuando el refresh token murió (~7 días en Testing).
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 400,
            json: async () => ({ error: "invalid_grant" }),
            text: async () => JSON.stringify({ error: "invalid_grant" }),
          }) as unknown as Response,
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    nchannel.close();
    ndb.close();
  });

  function ndialog(text: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const out: string[] = [];
      let buf = "";
      let quiet: ReturnType<typeof setTimeout>;
      const conn = net.connect(nsock);
      const bump = () => {
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          conn.end();
          resolve(out);
        }, 120);
      };
      conn.on("connect", () => conn.write(`${JSON.stringify({ t: "hello", externalId: "brokentester" })}\n`));
      conn.on("data", (d) => {
        buf += d.toString("utf8");
        let nl: number;
        // biome-ignore lint/suspicious/noAssignInExpressions: drain NDJSON
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const m = JSON.parse(line) as { t: string; text?: string };
          if (m.t === "ready") {
            conn.write(`${JSON.stringify({ t: "msg", text })}\n`);
            bump();
          } else if (m.t === "out") {
            out.push(m.text ?? "");
            bump();
          }
        }
      });
      conn.on("error", reject);
    });
  }

  it("un turno con grant muerto entrega la notif con el link de reconexión y sella (una sola vez)", async () => {
    await ndialog("hola");
    // Se llamó a la entrega durable UNA vez, con el grant correcto + el link OAUTH_BASE_URL/oauth/start.
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.service).toBe("gmail");
    expect(notifyCalls[0]?.profile).toBe("personal");
    expect(notifyCalls[0]?.url).toMatch(/^https:\/\/oauth\.ceibo\.test\/oauth\/start\?t=/);
    // El grant quedó roto Y sellado (entrega OK → notified_at seteado).
    const g = getOauthGrant(ndb, uid, "gmail", "personal");
    expect(g?.broken_at).not.toBeNull();
    expect(g?.notified_at).not.toBeNull();

    // Segundo turno: ya avisado (sellado) → NO re-entrega (anti-spam vía notified_at).
    await ndialog("seguís ahí?");
    expect(notifyCalls).toHaveLength(1);
  });

  it("si la entrega falla, NO sella y REINTENTA el próximo turno (retry-hasta-entregar)", async () => {
    deliverOk = false; // la entrega durable falla (ej. sin vista y sin canal de chat)
    await ndialog("hola");
    expect(notifyCalls).toHaveLength(1);
    // No sellado → sigue necesitando aviso.
    expect(getOauthGrant(ndb, uid, "gmail", "personal")?.notified_at).toBeNull();

    // Ahora la entrega anda → el próximo turno reintenta y sella.
    deliverOk = true;
    await ndialog("y ahora?");
    expect(notifyCalls).toHaveLength(2); // reintentó
    expect(getOauthGrant(ndb, uid, "gmail", "personal")?.notified_at).not.toBeNull();

    // Y ya no reintenta más.
    await ndialog("listo?");
    expect(notifyCalls).toHaveLength(2);
  });
});
