// E2E del FIRE-path de crons (item C): cuando un cron vencido se dispara, el gateway tiene
// que spawnear/restaurar la sesión del usuario VÍA SU PROPIO BACKEND (`backendForUser(user)`),
// igual que un turno interactivo — NO asumir un backend MA global. Para un usuario
// `backend_mode='local'` eso significa que el disparo va por el backend archima (que en prod
// levanta/revive la VM del usuario), no por MA.
//
// Hermético, sin servicios vivos:
//  - Dos `SessionBackend` fakeados (uno 'local', uno 'ma') que graban a qué backend se le pidió
//    `reuseOrCreate`/`attach`/`send`. El selector inyectado (`backendForUser`) elige por
//    `user.backend_mode`, igual que `makeBackendForUser` en prod.
//  - El store es real sobre `:memory:`; el cron se siembra con `createCron` (next_fire en el
//    pasado → vencido) y se dispara con `gw.fireDueCrons()` (el mismo tick del scheduler).
//  - El egress del cron va a un `cronTarget` capturador (en vez de Telegram/WhatsApp).
//
// La aserción central: un cron de un user LOCAL usa el backend LOCAL (su `reuseOrCreate` →
// spawn/restore de la VM) y NUNCA toca el backend MA; y simétricamente para un user MA.

import type { SessionBackend, Sink } from "@ceibo/agent";
import type { PostTarget } from "@ceibo/channels";
import {
  addInboxItem,
  addUser,
  type CronRow,
  countUnread,
  createCron,
  type Db,
  getCron,
  listInbox,
  openDb,
  setUserBackendMode,
} from "@ceibo/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { createGateway } = await import("./engine.ts");

// Grabador de un backend: registra las llamadas que el fire-path le hace. `reuseOrCreate`
// modela el "asegurá la sesión" (en archima = spawn/restore de la VM del usuario).
interface Rec {
  reuseOrCreate: number;
  createSession: number;
  attached: number;
  sent: string[];
}
function newRec(): Rec {
  return { reuseOrCreate: 0, createSession: 0, attached: 0, sent: [] };
}

// Un SessionBackend en memoria que graba en `rec`. Ante un `send` del gateway, el "agente"
// responde un eco y cierra el turno con un usage fijo (determinista, en microtasks).
function recordingBackend(rec: Rec): SessionBackend {
  return {
    createVault: async () => "vault-fake",
    setStaticBearerCredential: async () => {},
    revokeOauthCredential: async () => false,
    setSessionAgentConfig: async () => {},
    createSession: async () => {
      rec.createSession++;
      return "sess-fake";
    },
    reuseOrCreate: async () => {
      rec.reuseOrCreate++;
      return "sess-fake";
    },
    attach: (_sid, sink: Sink) => {
      rec.attached++;
      return {
        send: async (text: string) => {
          rec.sent.push(text);
          await sink.message(`ok: ${text}`);
          await sink.turnComplete?.(
            { input: 100, output: 50, cache5m: 0, cache1h: 0, cacheRead: 0 },
            "claude-haiku-4-5",
          );
        },
        interrupt: async () => {},
        close: () => {},
      };
    },
  };
}

// Drena los microtasks: el fire-path hace `ctx.relay.send(...)` fire-and-forget (no lo
// awaitea), y el egress (sink.message → emitReply → target.post) se encadena en microtasks.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

let db: Db;
let local: Rec;
let ma: Rec;
let posts: string[];
let gw: ReturnType<typeof createGateway>;

beforeEach(() => {
  db = openDb(":memory:");
  local = newRec();
  ma = newRec();
  posts = [];

  const localBackend = recordingBackend(local);
  const maBackend = recordingBackend(ma);

  // Capturador para canales persistentes (telegram/whatsapp): junta lo posteado.
  const telegramTarget: PostTarget = {
    post: async (t: string) => {
      posts.push(t);
    },
    startTyping: async () => {},
  };

  gw = createGateway({
    env: { AGENT_ID: "agent-test", ENV_ID: "env-test" } as NodeJS.ProcessEnv,
    client: {} as never,
    // El selector real: elige el backend por `user.backend_mode` (igual que makeBackendForUser).
    backendForUser: (user) => (user.backend_mode === "local" ? localBackend : maBackend),
    db,
    cfg: { agentId: "agent-test", envId: "env-test" },
    wikis: undefined, // chat pelado: prepareSession no necesita vault
    // Espeja la lógica de cronTarget de index.ts: `web` → inbox durable (acumula y persiste en
    // turnDone, SIN tocar telegram); cualquier otro canal → el capturador telegram.
    cronTarget: (user, cron: CronRow) => {
      if (cron.channel !== "web") return telegramTarget;
      const acc: string[] = [];
      return {
        post: async (t: string) => {
          if (t.trim()) acc.push(t);
        },
        startTyping: async () => {},
        turnDone: () => {
          const body = acc.join("\n\n").trim();
          if (!body) return;
          addInboxItem(db, {
            userId: user.id,
            kind: "cron",
            sourceId: cron.id,
            title: cron.title?.trim() || cron.what.slice(0, 60),
            body,
          });
          void countUnread(db, user.id); // el frame en vivo (no asertable acá sin canal remoto)
        },
      } satisfies PostTarget;
    },
  });
});

afterEach(() => {
  db.close();
});

// Siembra un cron one-shot YA vencido (next_fire en el pasado) para `userId`.
function seedDueCron(userId: number, channel = "telegram"): number {
  const c = createCron(db, {
    userId,
    channel,
    what: "regá las plantas",
    report: "always",
    kind: "once",
    nextFire: "2000-01-01T00:00:00.000Z", // vencido hace rato
  });
  return c.id;
}

describe("gateway · fireDueCrons rutea por el backend del usuario", () => {
  it("un cron de un user LOCAL spawnea/revive vía el backend local, NO el MA", async () => {
    const u = addUser(db, "vecina");
    setUserBackendMode(db, u.id, "local");
    const cronId = seedDueCron(u.id);

    await gw.fireDueCrons();
    await flush();

    // El fire-path aseguró la sesión por el backend LOCAL (en prod = spawn/restore de la VM).
    expect(local.reuseOrCreate).toBe(1);
    expect(local.attached).toBe(1);
    // El backend MA NUNCA se tocó para este usuario.
    expect(ma.reuseOrCreate).toBe(0);
    expect(ma.attached).toBe(0);
    expect(ma.sent).toEqual([]);

    // El prompt del cron se inyectó por el relay LOCAL…
    expect(local.sent).toHaveLength(1);
    expect(local.sent[0]).toContain("regá las plantas");
    // …y la respuesta del agente salió al canal de egress del cron.
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("ok: ");
    expect(posts[0]).toContain("regá las plantas");

    // El one-shot quedó completado (no se re-dispara).
    expect(getCron(db, cronId)?.status).toBe("done");
  });

  it("un cron de un user MA usa el backend MA, NO el local (simetría del selector)", async () => {
    const u = addUser(db, "owner"); // backend_mode default = 'ma'
    seedDueCron(u.id);

    await gw.fireDueCrons();
    await flush();

    expect(ma.reuseOrCreate).toBe(1);
    expect(ma.attached).toBe(1);
    expect(ma.sent).toHaveLength(1);
    // El backend local nunca se tocó.
    expect(local.reuseOrCreate).toBe(0);
    expect(local.attached).toBe(0);
    expect(local.sent).toEqual([]);
  });
});

describe("gateway · fireDueCrons — canal web (feature crons-delivery)", () => {
  it("un cron de canal `web` persiste el resultado en el INBOX y NO va a Telegram", async () => {
    const u = addUser(db, "web-user"); // backend MA por default; el canal del cron es lo que importa
    const cronId = seedDueCron(u.id, "web");

    await gw.fireDueCrons();
    await flush();

    // La respuesta del agente quedó DURABLE en el inbox (no efímera).
    const items = listInbox(db, u.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("cron");
    expect(items[0]?.source_id).toBe(cronId);
    expect(items[0]?.body).toContain("regá las plantas");
    expect(items[0]?.read_at).toBeNull(); // nace no leído → sube el badge
    expect(countUnread(db, u.id)).toBe(1);

    // SIN fallback a Telegram: el capturador de canales persistentes quedó vacío.
    expect(posts).toEqual([]);

    // El one-shot quedó completado.
    expect(getCron(db, cronId)?.status).toBe("done");
  });
});
