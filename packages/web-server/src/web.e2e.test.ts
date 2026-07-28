// E2E del web-server (Ola 5): el ciclo completo del canal web sobre HTTP real, hermético.
//
//  - Server REAL: `startWebServer` en un puerto efímero; los requests van por `fetch`.
//  - Gateway fakeado: `sendToAgent` (la costura — un callback, no un import) captura lo que el
//    usuario postea, en vez de despacharlo por el canal remoto a un gateway vivo.
//  - Store real sobre `:memory:` (login magic-link real → cookie de sesión firmada real).
//  - Egress (la respuesta del agente) se simula con `webServer.pushToUser`, igual que hace el
//    entry-point al recibir un frame del canal remoto → debe llegar por SSE.
//
// Prueba el cableado del server que los unit no tocan: auth por cookie, CSRF (origin check),
// ingress (POST /api/send → sendToAgent con sus facts), egress (pushToUser → SSE) y el
// puente handle↔userId que rutea los frames del gateway a los streams del usuario.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundAudio, MediaWire, TurnFact } from "@ceibo/channels";
import { SERVICE_NAMES } from "@ceibo/oauth";
import {
  addAuthorizedEmail,
  addChannel,
  addInboxItem,
  addInvite,
  addRepo,
  addToWaitingList,
  addUser,
  archiveForUser,
  createWebLoginToken,
  getAuthorizedEmail,
  getRepoByName,
  getUser,
  getUserAvatar,
  getUserBackendMode,
  getWaitingEntry,
  grantAccess,
  listPendingInvitesForEmail,
  listReposForUser,
  openDb,
  recordConnection,
  recordWikiChange,
  resolveUser,
  roleOf,
  setUserAvatar,
  setUserBgQueries,
  setUserPassword,
  setUserStatus,
  softDeleteRepo,
  upsertOauthGrant,
} from "@ceibo/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetBgCacheForTests,
  BG_MAX_QUERIES,
  BG_MAX_QUERY_LEN,
  normalizeBgQueries,
  SSE_MAX_PER_USER,
  startWebServer,
  type WebServer,
} from "./web.ts";

type Db = ReturnType<typeof openDb>;
type Sent = {
  user: { id: number; handle: string };
  text: string;
  audio?: InboundAudio;
  facts: TurnFact[];
  media?: MediaWire[];
  origin?: string;
};

const SESSION_KEY = "test-session-key-e2e";

let db: Db;
let server: WebServer;
let base: string;
let origin: string;
let sent: Sent[];
let sentMail: { to: string; url: string }[];
let userId: number;

// Un puerto libre: bind efímero, leelo, cerralo. startWebServer no devuelve el puerto, así que
// se lo pasamos fijo (la ventana de carrera entre close→listen es despreciable en CI).
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

beforeEach(async () => {
  sent = [];
  sentMail = [];
  db = openDb(":memory:");
  userId = addUser(db, "alice").id;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  origin = base; // same-origin: pasa el CSRF origin-check
  server = startWebServer({
    db,
    port,
    staticDir: tmpdir(), // no servimos el SPA en el e2e; sólo /api/*
    sessionKey: SESSION_KEY,
    sendToAgent: (user, text, audio, facts, media, origin) =>
      sent.push({ user, text, audio, facts, media, origin }),
    // Magic link por mail: capturamos el envío en vez de tocar Resend (I/O real).
    webPublicOrigin: base,
    sendMagicLink: async ({ to, url }) => {
      sentMail.push({ to, url });
    },
    log: () => {},
  });
});

afterEach(() => {
  server.close();
  db.close();
});

/** Hace el login magic-link real y devuelve el header Cookie a reusar. */
async function login(): Promise<string> {
  const token = createWebLoginToken(db, userId);
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ t: token }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("ceibo_session="));
  expect(setCookie).toBeDefined();
  return (setCookie as string).split(";")[0] as string; // "ceibo_session=<token>"
}

describe("web-server e2e — HTTP real, gateway fakeado", () => {
  it("login + POST /api/send → despacha al agente con los facts del canal web", async () => {
    const cookie = await login();
    // El login registró la identidad de canal web → el puente handle↔userId resuelve.
    expect(server.userIdByHandle("alice")).toBe(userId);

    const res = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ t: "text", text: "hola desde la web" }),
    });
    expect(res.status).toBe(202);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.user).toEqual({ id: userId, handle: "alice" });
    expect(sent[0]?.text).toBe("hola desde la web");
    // El server adjunta el fact de canal (el núcleo lo renderiza como [canal: web]).
    expect(sent[0]?.facts).toContainEqual({ label: "canal", value: "web" });
  });

  it("POST /api/send con sid → propaga el origin al agente (ruteo anti-eco)", async () => {
    const cookie = await login();
    const res = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ t: "text", text: "desde el iphone", sid: "view-iphone" }),
    });
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
    // El sid de la vista viaja como `origin` → el gateway lo rebota → la respuesta vuelve sólo acá.
    expect(sent[0]?.origin).toBe("view-iphone");
  });

  it("POST /api/send con adjuntos → clasifica imagen/PDF y descarta lo no soportado", async () => {
    const cookie = await login();
    const b64 = Buffer.from("x").toString("base64"); // payload nominal; el server no decodifica acá
    const res = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({
        t: "text",
        text: "mirá esto",
        media: [
          { name: "foto.png", mime: "image/png", data: b64 },
          { name: "doc.pdf", mime: "application/pdf", data: b64 },
          { name: "raro.exe", mime: "application/x-msdownload", data: b64 }, // descartado
        ],
      }),
    });
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("mirá esto");
    expect(sent[0]?.media).toEqual([
      { kind: "image", mediaType: "image/png", data: b64, filename: "foto.png" },
      { kind: "document", mediaType: "application/pdf", data: b64, filename: "doc.pdf" },
    ]);
  });

  it("POST /api/send solo adjuntos (sin texto) → 202 y despacha", async () => {
    const cookie = await login();
    const b64 = Buffer.from("y").toString("base64");
    const res = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({
        t: "text",
        text: "",
        media: [{ name: "a.webp", mime: "image/webp", data: b64 }],
      }),
    });
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("");
    expect(sent[0]?.media).toHaveLength(1);
  });

  it("POST /api/send vacío (sin texto, sin audio, sin media) → 400", async () => {
    const cookie = await login();
    const res = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ t: "text", text: "" }),
    });
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("POST /api/send con body > MAX_SEND_BYTES → 413 honesto (no conexión destruida)", async () => {
    const cookie = await login();
    // > 25MB de body (audio enorme). Antes el server hacía req.destroy() mudo → el cliente
    // veía un fallo de red genérico; ahora responde 413 y el cliente lo traduce a "audio
    // demasiado largo" sin reintentar (Fase B.2).
    const res = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ t: "audio", mime: "audio/webm", data: "x".repeat(26 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too-large" });
    expect(sent).toHaveLength(0);
  });

  it("POST /api/send sin cookie → 401 y no despacha nada", async () => {
    const res = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ t: "text", text: "hola" }),
    });
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("POST /api/send con Origin cruzado → 403 (CSRF) aunque haya cookie", async () => {
    const cookie = await login();
    const res = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example", cookie },
      body: JSON.stringify({ t: "text", text: "hola" }),
    });
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("login email+password → cookie de sesión y puente handle↔userId", async () => {
    addChannel(db, userId, "email", "alice@example.com");
    setUserPassword(db, userId, "secreta-123");
    const res = await fetch(`${base}/api/login/password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "alice@example.com", password: "secreta-123" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handle: "alice" });
    expect(res.headers.getSetCookie().some((c) => c.startsWith("ceibo_session="))).toBe(true);
    expect(server.userIdByHandle("alice")).toBe(userId);
  });

  it("login email+password normaliza el email (mayúsculas + espacios)", async () => {
    addChannel(db, userId, "email", "alice@example.com");
    setUserPassword(db, userId, "secreta-123");
    const res = await fetch(`${base}/api/login/password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "  Alice@Example.COM ", password: "secreta-123" }),
    });
    expect(res.status).toBe(200);
  });

  it("login password incorrecta → 401, sin cookie", async () => {
    addChannel(db, userId, "email", "alice@example.com");
    setUserPassword(db, userId, "secreta-123");
    const res = await fetch(`${base}/api/login/password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "alice@example.com", password: "mala" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("ceibo_session="))).toBe(false);
  });

  it("login email sin identidad allowlisteada → 401 (mismo error genérico)", async () => {
    setUserPassword(db, userId, "secreta-123"); // password seteada pero sin canal email
    const res = await fetch(`${base}/api/login/password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "alice@example.com", password: "secreta-123" }),
    });
    expect(res.status).toBe(401);
  });

  it("login password con Origin cruzado → 403 (CSRF)", async () => {
    addChannel(db, userId, "email", "alice@example.com");
    setUserPassword(db, userId, "secreta-123");
    const res = await fetch(`${base}/api/login/password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ email: "alice@example.com", password: "secreta-123" }),
    });
    expect(res.status).toBe(403);
  });

  it("magic-link por mail: email autorizado → 200, crea cuenta y manda el link", async () => {
    addAuthorizedEmail(db, "nuevo@example.com", { handle: "nuevo" });
    const res = await fetch(`${base}/api/auth/email/start`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "  Nuevo@Example.com " }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]?.to).toBe("nuevo@example.com");
    // El link es <origin>/<handle>?t=<token>; el token canjea en /api/login.
    expect(sentMail[0]?.url).toMatch(new RegExp(`^${base}/nuevo\\?t=.+`));
    const token = new URL(sentMail[0]?.url ?? "").searchParams.get("t");
    const redeem = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ t: token }),
    });
    expect(redeem.status).toBe(200);
  });

  it("magic-link por mail: email NO autorizado → 200 ok:false reason:waitlisted + fila en waitlist", async () => {
    const res = await fetch(`${base}/api/auth/email/start`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "intruso@example.com" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "waitlisted" });
    expect(sentMail).toHaveLength(0);
    expect(resolveUser(db, "email", "intruso@example.com")).toBeUndefined();
    // P3: agrega a waitlist (self-signup)
    const entry = getWaitingEntry(db, "intruso@example.com");
    expect(entry).toBeDefined();
    expect(entry?.source).toBe("self-signup");
    expect(entry?.status).toBe("pending");
  });

  it("magic-link por mail: email NO autorizado 2do intento → already-waitlisted (idempotente)", async () => {
    addToWaitingList(db, "intruso@example.com");
    const res = await fetch(`${base}/api/auth/email/start`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "intruso@example.com" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "already-waitlisted" });
    expect(sentMail).toHaveLength(0);
  });

  it("magic-link por mail: email con invite pendiente → waitlist source=invited (accept implícito)", async () => {
    const repo = addRepo(db, "ceibo-test", "wiki-test", "Wiki Test");
    addInvite(db, repo.id, "invitado@example.com", userId);
    const res = await fetch(`${base}/api/auth/email/start`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "invitado@example.com" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "waitlisted" });
    const entry = getWaitingEntry(db, "invitado@example.com");
    expect(entry?.source).toBe("invited");
    expect(entry?.invited_by).toBe(userId);
  });

  it("magic-link por mail: email autorizado → login normal, no toca waitlist", async () => {
    addAuthorizedEmail(db, "autorizado@example.com", { handle: "autorizado" });
    const res = await fetch(`${base}/api/auth/email/start`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "autorizado@example.com" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sentMail).toHaveLength(1);
    expect(getWaitingEntry(db, "autorizado@example.com")).toBeUndefined();
  });

  it("magic-link por mail: email mal formado → 200 ok:false (invalid) sin envío (no mina tokens)", async () => {
    const res = await fetch(`${base}/api/auth/email/start`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "no-es-un-email" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "invalid" });
    expect(sentMail).toHaveLength(0);
  });

  it("magic-link por mail: Origin cruzado → 403 (CSRF)", async () => {
    addAuthorizedEmail(db, "x@example.com");
    const res = await fetch(`${base}/api/auth/email/start`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ email: "x@example.com" }),
    });
    expect(res.status).toBe(403);
    expect(sentMail).toHaveLength(0);
  });

  it("magic-link por mail: sin Resend configurado → 503", async () => {
    // Server aparte SIN sendMagicLink/webPublicOrigin → el endpoint queda apagado.
    const port = await freePort();
    const b2 = `http://127.0.0.1:${port}`;
    const srv2 = startWebServer({
      db,
      port,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      log: () => {},
    });
    try {
      const res = await fetch(`${b2}/api/auth/email/start`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b2 },
        body: JSON.stringify({ email: "x@example.com" }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "email-not-configured" });
    } finally {
      srv2.close();
    }
  });

  it("GET /api/stream (SSE): recibe ready y luego lo que el gateway empuja con pushToUser", async () => {
    const cookie = await login();
    const ac = new AbortController();
    const res = await fetch(`${base}/api/stream`, { headers: { cookie }, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    // Lee el próximo evento SSE (`data: {...}`), con tope de tiempo para no colgar el test.
    const nextData = async (): Promise<Record<string, unknown>> => {
      const deadline = async () => {
        await new Promise((r) => setTimeout(r, 2000));
        throw new Error("timeout esperando evento SSE");
      };
      const pump = async (): Promise<Record<string, unknown>> => {
        for (;;) {
          const nl = buf.indexOf("\n\n");
          if (nl >= 0) {
            const frame = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (line) return JSON.parse(line.slice(6));
            continue; // comentario/retry → seguir leyendo
          }
          const { value, done } = await reader.read();
          if (done) throw new Error("stream cerrado");
          buf += dec.decode(value, { stream: true });
        }
      };
      return Promise.race([pump(), deadline()]);
    };

    try {
      // El primer evento del stream es el saludo.
      expect(await nextData()).toMatchObject({ t: "ready", handle: "alice" });
      // El entry-point hace esto al recibir un frame del canal remoto: la respuesta del agente.
      const n = server.pushToUser(userId, { t: "text", text: "respuesta del agente" });
      expect(n).toBe(1); // llegó a un stream
      expect(await nextData()).toMatchObject({ t: "text", text: "respuesta del agente" });
    } finally {
      ac.abort();
      reader.cancel().catch(() => {});
    }
  });

  // El bug del eco: con dos vistas abiertas (ej. Mac + iPhone) la respuesta de un turno iba a
  // las dos. Con el sid por vista, la respuesta del turno vuelve SÓLO a la que preguntó; el
  // egress proactivo (sin origin) sigue abanicando a todas.
  it("GET /api/stream con sid: la respuesta de turno va sólo al origen; el proactivo a todas", async () => {
    const cookie = await login();
    const ac = new AbortController();

    // Abre un stream con un sid dado y devuelve un lector de eventos SSE (con tope de tiempo).
    const openStream = async (sid: string) => {
      const res = await fetch(`${base}/api/stream?sid=${sid}`, { headers: { cookie }, signal: ac.signal });
      expect(res.status).toBe(200);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let buf = "";
      const nextData = (): Promise<Record<string, unknown>> => {
        const deadline = async () => {
          await new Promise((r) => setTimeout(r, 2000));
          throw new Error(`timeout esperando evento SSE (sid=${sid})`);
        };
        const pump = async (): Promise<Record<string, unknown>> => {
          for (;;) {
            const nl = buf.indexOf("\n\n");
            if (nl >= 0) {
              const frame = buf.slice(0, nl);
              buf = buf.slice(nl + 2);
              const line = frame.split("\n").find((l) => l.startsWith("data: "));
              if (line) return JSON.parse(line.slice(6));
              continue;
            }
            const { value, done } = await reader.read();
            if (done) throw new Error("stream cerrado");
            buf += dec.decode(value, { stream: true });
          }
        };
        return Promise.race([pump(), deadline()]);
      };
      return { reader, nextData };
    };

    try {
      const a = await openStream("view-mac");
      const b = await openStream("view-iphone");
      expect(await a.nextData()).toMatchObject({ t: "ready" });
      expect(await b.nextData()).toMatchObject({ t: "ready" });

      // Respuesta de turno del iPhone → entrega sólo a esa vista (1 destinatario).
      expect(server.pushToUser(userId, { t: "text", text: "para-iphone" }, "view-iphone")).toBe(1);
      // Mensaje proactivo (sin origin) → a las dos vistas (2 destinatarios).
      expect(server.pushToUser(userId, { t: "text", text: "proactivo" })).toBe(2);

      // El iPhone ve primero su respuesta de turno y luego el proactivo.
      expect(await b.nextData()).toMatchObject({ t: "text", text: "para-iphone" });
      expect(await b.nextData()).toMatchObject({ t: "text", text: "proactivo" });
      // El Mac NUNCA vio "para-iphone": su primer evento post-ready es el proactivo (sin eco).
      expect(await a.nextData()).toMatchObject({ t: "text", text: "proactivo" });

      a.reader.cancel().catch(() => {});
      b.reader.cancel().catch(() => {});
    } finally {
      ac.abort();
    }
  });

  it("GET /api/stream: deduplica voice repetido inmediato para la misma vista", async () => {
    const cookie = await login();
    const ac = new AbortController();
    const res = await fetch(`${base}/api/stream?sid=view-voice`, { headers: { cookie }, signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    const nextData = (): Promise<Record<string, unknown>> => {
      const deadline = async () => {
        await new Promise((r) => setTimeout(r, 2000));
        throw new Error("timeout esperando evento SSE");
      };
      const pump = async (): Promise<Record<string, unknown>> => {
        for (;;) {
          const nl = buf.indexOf("\n\n");
          if (nl >= 0) {
            const frame = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (line) return JSON.parse(line.slice(6));
            continue;
          }
          const { value, done } = await reader.read();
          if (done) throw new Error("stream cerrado");
          buf += dec.decode(value, { stream: true });
        }
      };
      return Promise.race([pump(), deadline()]);
    };

    try {
      expect(await nextData()).toMatchObject({ t: "ready" });
      const msg = { t: "voice", mime: "audio/ogg", data: "YQ==", text: "misma respuesta" };
      expect(server.pushToUser(userId, msg, "view-voice")).toBe(1);
      expect(server.pushToUser(userId, msg, "view-voice")).toBe(0);
      expect(await nextData()).toMatchObject({ t: "voice", text: "misma respuesta" });
    } finally {
      ac.abort();
      reader.cancel().catch(() => {});
    }
  });

  // Fase A (watchdog de liveness): el keep-alive del server tiene que ser un evento SSE REAL
  // (`{t:"ping"}`), no el comentario `:keep-alive` de antes — los comentarios SSE no disparan
  // `onmessage` en el browser, así que el cliente no tenía NINGUNA señal de vida observable
  // para detectar una conexión half-open zombie. Server propio con el intervalo acelerado
  // (ssePingMs, override de test): el default de 25s es inesperable en un test.
  it("GET /api/stream: el keep-alive llega como evento {t:'ping'} observable (no comentario)", async () => {
    const port2 = await freePort();
    const base2 = `http://127.0.0.1:${port2}`;
    const srv2 = startWebServer({
      db,
      port: port2,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      ssePingMs: 40,
      log: () => {},
    });
    const ac = new AbortController();
    try {
      // La cookie del login en el server principal vale acá: misma db + misma sessionKey.
      const cookie = await login();
      const res = await fetch(`${base2}/api/stream`, { headers: { cookie }, signal: ac.signal });
      expect(res.status).toBe(200);

      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let buf = "";
      // Próximo EVENTO SSE real (línea `data:`); los comentarios/retry se saltean.
      const nextData = (): Promise<Record<string, unknown>> => {
        const deadline = async () => {
          await new Promise((r) => setTimeout(r, 2000));
          throw new Error("timeout esperando evento SSE");
        };
        const pump = async (): Promise<Record<string, unknown>> => {
          for (;;) {
            const nl = buf.indexOf("\n\n");
            if (nl >= 0) {
              const frame = buf.slice(0, nl);
              buf = buf.slice(nl + 2);
              const line = frame.split("\n").find((l) => l.startsWith("data: "));
              if (line) return JSON.parse(line.slice(6));
              continue;
            }
            const { value, done } = await reader.read();
            if (done) throw new Error("stream cerrado");
            buf += dec.decode(value, { stream: true });
          }
        };
        return Promise.race([pump(), deadline()]);
      };

      expect(await nextData()).toMatchObject({ t: "ready" });
      // Sin que nadie haga push: lo próximo que llega es el ping del interval, como
      // `data:` parseable (lo que el EventSource del browser entrega a onmessage)…
      expect(await nextData()).toEqual({ t: "ping" });
      // …y es periódico (el watchdog del cliente lo recibe mientras la conexión viva).
      expect(await nextData()).toEqual({ t: "ping" });
      reader.cancel().catch(() => {});
    } finally {
      ac.abort();
      srv2.close();
    }
  });

  // --- Fase C (buffer de frames + replay al reconectar) -------------------------------
  // El holy grail de conexión rock-solid: si el SSE estaba caído cuando el server emitió la
  // respuesta de un turno, antes se perdía para siempre. Ahora cada frame de `deliver` lleva
  // `id: <seq>` (resumption nativa de SSE) + el seq en el JSON, queda en un ring buffer por
  // usuario, y al reconectar (header `Last-Event-ID` del reconnect nativo, o `?since=` del
  // reconnect manual del watchdog) el server re-emite lo que falte respetando el sid-routing.
  // Hueco más grande que el buffer → frame `{t:"resync"}` honesto antes del best-effort.

  /** Abre un stream SSE y devuelve un lector de eventos CRUDOS: data parseada + la línea
   *  `id:` si vino (los tests de Fase C verifican el id, no solo el payload). */
  const openSseRaw = async (url: string, headers: Record<string, string>) => {
    const ac = new AbortController();
    const res = await fetch(url, { headers, signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    const nextEvent = (): Promise<{ id?: string; data: Record<string, unknown> }> => {
      const deadline = async () => {
        await new Promise((r) => setTimeout(r, 2000));
        throw new Error("timeout esperando evento SSE");
      };
      const pump = async (): Promise<{ id?: string; data: Record<string, unknown> }> => {
        for (;;) {
          const nl = buf.indexOf("\n\n");
          if (nl >= 0) {
            const frame = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
            if (dataLine) {
              const idLine = frame.split("\n").find((l) => l.startsWith("id: "));
              return { id: idLine?.slice(4), data: JSON.parse(dataLine.slice(6)) };
            }
            continue; // retry/comentario → seguir
          }
          const { value, done } = await reader.read();
          if (done) throw new Error("stream cerrado");
          buf += dec.decode(value, { stream: true });
        }
      };
      return Promise.race([pump(), deadline()]);
    };
    const close = () => {
      ac.abort();
      reader.cancel().catch(() => {});
    };
    return { nextEvent, close };
  };
  /** El close del fetch tarda un tick en llegarle al server (`req.on("close")` es async):
   *  esperarlo antes de pushear "durante la caída" — si no, el push todavía ve el stream
   *  viejo registrado y "entrega" al socket muerto (igual queda bufferedo, pero el test
   *  quiere el caso límpio de cero streams). */
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it("Fase C: los frames de deliver llevan `id:` = seq monotónico y el seq embebido; ready va sin id", async () => {
    const cookie = await login();
    const s = await openSseRaw(`${base}/api/stream?sid=v1`, { cookie });
    try {
      const ready = await s.nextEvent();
      expect(ready.data).toMatchObject({ t: "ready" });
      expect(ready.id).toBeUndefined(); // ready no es replay-able: no mueve el watermark
      server.pushToUser(userId, { t: "text", text: "uno" }, "v1");
      server.pushToUser(userId, { t: "turn-done" }, "v1");
      const a = await s.nextEvent();
      const b = await s.nextEvent();
      expect(a.data).toMatchObject({ t: "text", text: "uno" });
      expect(a.id).toBeDefined();
      expect(a.data.seq).toBe(Number(a.id)); // el JSON y la línea id: dicen lo mismo
      expect(Number(b.id)).toBe(Number(a.id) + 1); // seq monotónico por usuario
    } finally {
      s.close();
    }
  });

  it("Fase C (el caso clave): la respuesta emitida con el SSE caído se re-emite al reconectar con Last-Event-ID", async () => {
    const cookie = await login();
    // Vista conectada que ve un primer frame (su watermark) y se cae.
    const s1 = await openSseRaw(`${base}/api/stream?sid=view-a`, { cookie });
    let watermark = "";
    try {
      expect((await s1.nextEvent()).data).toMatchObject({ t: "ready" });
      server.pushToUser(userId, { t: "text", text: "antes de la caída" }, "view-a");
      const seen = await s1.nextEvent();
      watermark = seen.id as string;
      expect(watermark).toBeDefined();
    } finally {
      s1.close();
    }
    await settle();
    // SSE caído: el server emite la respuesta del turno (origin view-a), un broadcast y
    // un frame de OTRA vista. pushToUser devuelve 0 (nadie escucha) pero queda bufferedo.
    expect(server.pushToUser(userId, { t: "text", text: "respuesta perdida" }, "view-a")).toBe(0);
    expect(server.pushToUser(userId, { t: "refresh" })).toBe(0);
    expect(server.pushToUser(userId, { t: "text", text: "de otra vista" }, "view-b")).toBe(0);
    // Reconnect nativo: el browser manda Last-Event-ID. Replay = seq > watermark, SOLO los
    // frames de esta vista (origin view-a) + broadcasts; el de view-b NO (sid-routing).
    const s2 = await openSseRaw(`${base}/api/stream?sid=view-a`, { cookie, "last-event-id": watermark });
    try {
      expect((await s2.nextEvent()).data).toMatchObject({ t: "ready" });
      const r1 = await s2.nextEvent();
      expect(r1.data).toMatchObject({ t: "text", text: "respuesta perdida", seq: Number(watermark) + 1 });
      expect(r1.id).toBeDefined(); // el replay también lleva id (re-resumible)
      expect((await s2.nextEvent()).data).toMatchObject({ t: "refresh" });
      // Lo próximo que llega NO es el frame de view-b: empujamos uno vivo y es ÉSE.
      server.pushToUser(userId, { t: "turn-done" }, "view-a");
      expect((await s2.nextEvent()).data).toMatchObject({ t: "turn-done" });
    } finally {
      s2.close();
    }
  });

  it("Fase C: `?since=` (reconnect manual del watchdog, sin header) replay-ea igual", async () => {
    const cookie = await login();
    const s1 = await openSseRaw(`${base}/api/stream?sid=w1`, { cookie });
    let watermark = "";
    try {
      expect((await s1.nextEvent()).data).toMatchObject({ t: "ready" });
      server.pushToUser(userId, { t: "text", text: "visto" }, "w1");
      watermark = (await s1.nextEvent()).id as string;
    } finally {
      s1.close();
    }
    await settle();
    server.pushToUser(userId, { t: "text", text: "perdido" }, "w1");
    const s2 = await openSseRaw(`${base}/api/stream?sid=w1&since=${watermark}`, { cookie });
    try {
      expect((await s2.nextEvent()).data).toMatchObject({ t: "ready" });
      expect((await s2.nextEvent()).data).toMatchObject({ t: "text", text: "perdido" });
    } finally {
      s2.close();
    }
  });

  it("Fase C: hueco más grande que el buffer → {t:'resync'} antes del best-effort (no miente)", async () => {
    // Server propio con buffer diminuto (2 frames) para forzar la evicción.
    const port2 = await freePort();
    const base2 = `http://127.0.0.1:${port2}`;
    const srv2 = startWebServer({
      db,
      port: port2,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      frameBuffer: { maxFrames: 2 },
      log: () => {},
    });
    try {
      const cookie = await login();
      const s1 = await openSseRaw(`${base2}/api/stream?sid=g1`, { cookie });
      let watermark = "";
      try {
        expect((await s1.nextEvent()).data).toMatchObject({ t: "ready" });
        srv2.pushToUser(userId, { t: "text", text: "viejo" }, "g1");
        watermark = (await s1.nextEvent()).id as string;
      } finally {
        s1.close();
      }
      // Caída larga: 3 frames más → el buffer (cap 2) ya evictó parte del hueco.
      srv2.pushToUser(userId, { t: "text", text: "p1" }, "g1");
      srv2.pushToUser(userId, { t: "text", text: "p2" }, "g1");
      srv2.pushToUser(userId, { t: "text", text: "p3" }, "g1");
      const s2 = await openSseRaw(`${base2}/api/stream?sid=g1&since=${watermark}`, { cookie });
      try {
        expect((await s2.nextEvent()).data).toMatchObject({ t: "ready" });
        // PRIMERO la señal honesta de gap…
        expect((await s2.nextEvent()).data).toEqual({ t: "resync" });
        // …después lo que el buffer SÍ conserva (los 2 últimos).
        expect((await s2.nextEvent()).data).toMatchObject({ t: "text", text: "p2" });
        expect((await s2.nextEvent()).data).toMatchObject({ t: "text", text: "p3" });
      } finally {
        s2.close();
      }
    } finally {
      srv2.close();
    }
  });

  it("Fase C: conexión fresca (sin watermark) no recibe replay ni resync", async () => {
    const cookie = await login();
    server.pushToUser(userId, { t: "text", text: "histórico" }, "f1");
    const s = await openSseRaw(`${base}/api/stream?sid=f1`, { cookie });
    try {
      expect((await s.nextEvent()).data).toMatchObject({ t: "ready" });
      // Lo próximo es lo VIVO (no el histórico): un push nuevo llega primero.
      server.pushToUser(userId, { t: "turn-done" }, "f1");
      expect((await s.nextEvent()).data).toMatchObject({ t: "turn-done" });
    } finally {
      s.close();
    }
  });

  it("GET /api/frames (esbozo long-polling): mismos frames por HTTP normal; sin cookie → 401", async () => {
    const cookie = await login();
    server.pushToUser(userId, { t: "text", text: "lp" }, "lp-view");
    server.pushToUser(userId, { t: "refresh" });
    const res = await fetch(`${base}/api/frames?since=0&sid=lp-view`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { frames: { t: string; text?: string; seq: number }[]; gap: boolean };
    expect(body.gap).toBe(false);
    const mine = body.frames.filter((f) => f.t === "text" || f.t === "refresh");
    expect(mine.map((f) => f.text ?? f.t)).toEqual(["lp", "refresh"]);
    expect(mine.every((f) => typeof f.seq === "number")).toBe(true);
    const unauth = await fetch(`${base}/api/frames?since=0`);
    expect(unauth.status).toBe(401);
  });

  // --- Dedup de streams por sid (fix "mobile mudo", 2026-06-11) ------------------------
  // Una pestaña que reconecta reusa su sid. Antes cada reconexión SUMABA una entrada al set
  // del user (el res viejo quedaba hasta que su `close` — tardío o nunca en mobile/HTTP/2
  // zombie — disparara) → el cap LRU se llenaba de streams stale de UNA pestaña y evictaba
  // streams VIVOS de otros dispositivos. Ahora `register` reemplaza: mismo sid = 1 entrada.

  it("dedup por sid: la reconexión REEMPLAZA al stream viejo (set queda en 1, no N)", async () => {
    const cookie = await login();
    // La "pestaña" conecta y reconecta SIN cerrar la conexión anterior (simula el close
    // que nunca llega: red mobile que flapea / HTTP/2 zombie del edge).
    const s1 = await openSseRaw(`${base}/api/stream?sid=tab-1`, { cookie });
    expect((await s1.nextEvent()).data).toMatchObject({ t: "ready" });
    const s2 = await openSseRaw(`${base}/api/stream?sid=tab-1`, { cookie });
    expect((await s2.nextEvent()).data).toMatchObject({ t: "ready" });
    try {
      // El server CERRÓ el stream viejo al registrarse el nuevo bajo el mismo sid.
      await expect(s1.nextEvent()).rejects.toThrow("stream cerrado");
      // Fanout (sin origin): entrega a 1 solo stream — la entrada vieja ya no cuenta.
      expect(server.pushToUser(userId, { t: "refresh" })).toBe(1);
      expect((await s2.nextEvent()).data).toMatchObject({ t: "refresh" });
      // La respuesta de turno (origin = el sid) llega al stream NUEVO.
      expect(server.pushToUser(userId, { t: "text", text: "para la pestaña" }, "tab-1")).toBe(1);
      expect((await s2.nextEvent()).data).toMatchObject({ t: "text", text: "para la pestaña" });
    } finally {
      s1.close();
      s2.close();
    }
  });

  it("dedup por sid: N reconexiones de un dispositivo NO evictan el stream vivo del otro", async () => {
    const cookie = await login();
    // Dispositivo B (el "mobile" de la historia): un stream vivo, quieto.
    const sB = await openSseRaw(`${base}/api/stream?sid=device-b`, { cookie });
    expect((await sB.nextEvent()).data).toMatchObject({ t: "ready" });
    // Dispositivo A reconecta MÁS veces que el cap, siempre bajo su mismo sid, sin que
    // ningún close llegue al server. Antes esto inflaba el set hasta el cap y evictaba a B.
    const aStreams: Awaited<ReturnType<typeof openSseRaw>>[] = [];
    for (let i = 0; i < SSE_MAX_PER_USER + 2; i++) {
      const s = await openSseRaw(`${base}/api/stream?sid=device-a`, { cookie });
      expect((await s.nextEvent()).data).toMatchObject({ t: "ready" });
      aStreams.push(s);
    }
    const aLive = aStreams[aStreams.length - 1] as Awaited<ReturnType<typeof openSseRaw>>;
    try {
      // B sigue vivo: su respuesta de turno le llega a ÉL (no hubo eviction ni fanout).
      expect(server.pushToUser(userId, { t: "text", text: "para b" }, "device-b")).toBe(1);
      expect((await sB.nextEvent()).data).toMatchObject({ t: "text", text: "para b" });
      // Y el set del user quedó en 2 (a + b), no en 2 + N stale.
      expect(server.pushToUser(userId, { t: "refresh" })).toBe(2);
      expect((await aLive.nextEvent()).data).toMatchObject({ t: "refresh" });
      expect((await sB.nextEvent()).data).toMatchObject({ t: "refresh" });
    } finally {
      for (const s of aStreams) s.close();
      sB.close();
    }
  });

  it("el cap sigue protegiendo contra sids DISTINTOS de verdad (LRU evicta el más viejo)", async () => {
    const cookie = await login();
    const streams: Awaited<ReturnType<typeof openSseRaw>>[] = [];
    for (let i = 0; i < SSE_MAX_PER_USER + 1; i++) {
      const s = await openSseRaw(`${base}/api/stream?sid=distinct-${i}`, { cookie });
      expect((await s.nextEvent()).data).toMatchObject({ t: "ready" });
      streams.push(s);
    }
    try {
      // El más viejo (distinct-0) fue evictado al abrir el (cap+1)-ésimo…
      await expect((streams[0] as Awaited<ReturnType<typeof openSseRaw>>).nextEvent()).rejects.toThrow(
        "stream cerrado",
      );
      // …y el fanout entrega exactamente al cap de streams vivos.
      expect(server.pushToUser(userId, { t: "refresh" })).toBe(SSE_MAX_PER_USER);
    } finally {
      for (const s of streams) s.close();
    }
  });

  it("dedup por sid: el close TARDÍO del stream reemplazado no rompe el vínculo sid→stream nuevo", async () => {
    const cookie = await login();
    const s1 = await openSseRaw(`${base}/api/stream?sid=tab-z`, { cookie });
    expect((await s1.nextEvent()).data).toMatchObject({ t: "ready" });
    const s2 = await openSseRaw(`${base}/api/stream?sid=tab-z`, { cookie });
    expect((await s2.nextEvent()).data).toMatchObject({ t: "ready" });
    try {
      // Ahora SÍ llega el close del viejo (la guarda de unregister no debe borrar el
      // streamBySid que ya apunta al res nuevo).
      s1.close();
      await settle();
      expect(server.pushToUser(userId, { t: "text", text: "sigue ruteando" }, "tab-z")).toBe(1);
      expect((await s2.nextEvent()).data).toMatchObject({ t: "text", text: "sigue ruteando" });
    } finally {
      s2.close();
    }
  });

  // --- Usuario disabled: la sesión web deja de valer (no más limbo mudo) ---------------
  // El gateway descarta los turnos de users no-active (`resolveUser`) — si la web siguiera
  // aceptando la cookie, el usuario "manda y nada responde, ni con refresh" (2026-06-11).

  it("user disabled: 401 en toda la API con la cookie vieja, y el magic-link no mintea sesión", async () => {
    const cookie = await login();
    // Sanidad: con el user activo, la cookie vale.
    expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(200);
    setUserStatus(db, userId, "disabled");
    // La cookie (stateless, 30 días) deja de valer al instante: 401 → la SPA cae al login.
    expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(401);
    expect((await fetch(`${base}/api/stream?sid=x`, { headers: { cookie } })).status).toBe(401);
    const send = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ t: "text", text: "al vacío" }),
    });
    expect(send.status).toBe(401);
    expect(sent).toHaveLength(0); // no se despachó nada al gateway
    // Y un magic-link minteado para el user disabled tampoco abre sesión.
    const token = createWebLoginToken(db, userId);
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ t: token }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error?: string }).toEqual({ error: "disabled" });
  });

  // --- GET /api/connections (conexiones v2) -----------------------------------
  // El endpoint devuelve el CATÁLOGO de conectables marcando lo conectado (no sólo lo activo),
  // separado en Canales (conversacionales) y Conexiones (servicios OAuth + whatsapp si WACLI).

  it("GET /api/connections sin cookie → 401", async () => {
    const res = await fetch(`${base}/api/connections`, { headers: { origin } });
    expect(res.status).toBe(401);
  });

  it("GET /api/connections: catálogo de conectables marcando lo conectado", async () => {
    const cookie = await login();
    // Dos perfiles de gmail conectados; notion queda disponible (no conectado).
    recordConnection(db, userId, "gmail", "work");
    recordConnection(db, userId, "gmail", "personal");
    // El grant del perfil "work" tiene cuenta real; "personal" no (probamos el fallback null).
    upsertOauthGrant(db, {
      user_id: userId,
      service: "gmail",
      profile: "work",
      provider: "google",
      mcp_url: "https://mcp/gmail?profile=work",
      display_name: "Gmail (work)",
      account: "trabajo@empresa.com",
      broken_at: null,
      notified_at: null,
      refresh_token: "rt",
      access_token: "at",
      expires_at: null,
      scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
    });

    const res = await fetch(`${base}/api/connections`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channels: { type: string; connected: boolean; identities: string[] }[];
      connections: {
        service: string;
        displayName: string;
        connected: boolean;
        broken: boolean;
        profiles: { profile: string; account: string | null; permissions: string[]; broken: boolean }[];
      }[];
    };

    // Todos los SERVICE_NAMES aparecen como conectables.
    const services = body.connections.map((c) => c.service);
    for (const s of SERVICE_NAMES) expect(services).toContain(s);
    // whatsapp NO está cuando WACLI no está configurado (whatsappEnabled por defecto false).
    expect(services).not.toContain("whatsapp");

    // gmail: conectado, perfiles ordenados con cuenta real (null si falta) + permisos legibles.
    // "work" deriva los permisos del scope otorgado; "personal" (sin grant) del catálogo. Ambos
    // resuelven al mismo texto humano de los scopes de gmail. Sanos → broken:false.
    const gmailPerms = ["Leer tu correo", "Redactar y enviar correo"];
    const gmail = body.connections.find((c) => c.service === "gmail");
    expect(gmail).toMatchObject({
      connected: true,
      broken: false,
      displayName: "Gmail",
      profiles: [
        { profile: "personal", account: null, permissions: gmailPerms, broken: false },
        { profile: "work", account: "trabajo@empresa.com", permissions: gmailPerms, broken: false },
      ],
    });
    // notion: disponible (no conectado, sin perfiles).
    const notion = body.connections.find((c) => c.service === "notion");
    expect(notion).toMatchObject({ connected: false, broken: false, profiles: [] });
  });

  it("GET /api/connections: un grant roto (broken_at) marca broken en el perfil y el servicio", async () => {
    const cookie = await login();
    // Dos perfiles: "personal" roto (invalid_grant), "work" sano → tri-estado por perfil.
    recordConnection(db, userId, "gmail", "personal");
    recordConnection(db, userId, "gmail", "work");
    upsertOauthGrant(db, {
      user_id: userId,
      service: "gmail",
      profile: "personal",
      provider: "google",
      mcp_url: "https://mcp/gmail?profile=personal",
      display_name: "Gmail (personal)",
      account: "yo@gmail.com",
      broken_at: "2026-06-30T00:00:00.000Z", // grant muerto
      notified_at: "2026-06-30T00:00:00.000Z",
      refresh_token: "rt",
      access_token: "at",
      expires_at: "2020-01-01T00:00:00.000Z",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    });
    upsertOauthGrant(db, {
      user_id: userId,
      service: "gmail",
      profile: "work",
      provider: "google",
      mcp_url: "https://mcp/gmail?profile=work",
      display_name: "Gmail (work)",
      account: "trabajo@empresa.com",
      broken_at: null, // sano
      notified_at: null,
      refresh_token: "rt",
      access_token: "at",
      expires_at: "2099-01-01T00:00:00.000Z",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    });

    const res = await fetch(`${base}/api/connections`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connections: {
        service: string;
        connected: boolean;
        broken: boolean;
        profiles: { profile: string; broken: boolean }[];
      }[];
    };
    const gmail = body.connections.find((c) => c.service === "gmail");
    // Servicio conectado y con al menos un perfil roto → broken:true a nivel service.
    expect(gmail?.connected).toBe(true);
    expect(gmail?.broken).toBe(true);
    // Por perfil: "personal" roto, "work" sano (ordenados por nombre: personal, work).
    expect(gmail?.profiles).toMatchObject([
      { profile: "personal", broken: true },
      { profile: "work", broken: false },
    ]);
  });

  it("GET /api/connections: Canales excluye la identidad 'google' del login OIDC", async () => {
    const cookie = await login(); // el login registra el canal web (external_id = handle)
    addChannel(db, userId, "telegram", "12345");
    // Identidad de allowlist del login Google — NO es un canal de mensajería; no debe listarse.
    addChannel(db, userId, "google", "alice@example.com");

    const res = await fetch(`${base}/api/connections`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channels: { type: string; connected: boolean; identities: string[] }[];
    };

    const types = body.channels.map((c) => c.type);
    expect(types).toContain("web");
    expect(types).toContain("telegram");
    expect(types).not.toContain("google"); // el bug de la v1
    // telegram trae su identidad y queda marcado conectado.
    expect(body.channels.find((c) => c.type === "telegram")).toMatchObject({
      connected: true,
      identities: ["12345"],
    });
  });

  it("GET /api/connections: whatsapp es conectable sólo si WACLI está configurado", async () => {
    // Server dedicado con whatsappEnabled: true (espeja env.WACLI_MCP_URL del entry-point).
    const port = await freePort();
    const base2 = `http://127.0.0.1:${port}`;
    const srv2 = startWebServer({
      db,
      port,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      whatsappEnabled: true,
      log: () => {},
    });
    try {
      const token = createWebLoginToken(db, userId);
      const lr = await fetch(`${base2}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base2 },
        body: JSON.stringify({ t: token }),
      });
      const cookie = (lr.headers.getSetCookie().find((c) => c.startsWith("ceibo_session=")) as string).split(
        ";",
      )[0] as string;

      const res = await fetch(`${base2}/api/connections`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        connections: { service: string; displayName: string; connected: boolean }[];
      };
      const wa = body.connections.find((c) => c.service === "whatsapp");
      expect(wa).toMatchObject({ displayName: "WhatsApp", connected: false });
    } finally {
      srv2.close();
    }
  });

  // --- Edición de perfil (alias + avatar) -------------------------------------
  // Header PNG válido (magic bytes) + relleno, para pasar el sniff por magic bytes.
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, 7),
  ]);
  const b64 = (buf: Buffer) => buf.toString("base64");

  it("POST /api/me setea el alias; vacío → null (cae al handle)", async () => {
    const cookie = await login();
    const res = await fetch(`${base}/api/me`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ name: "  Alicia  " }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Alicia" }); // trim aplicado
    expect(getUser(db, userId)?.name).toBe("Alicia");
    // Vacío → null; el endpoint devuelve el handle como fallback.
    const res2 = await fetch(`${base}/api/me`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ name: "   " }),
    });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({ name: "alice" });
    expect(getUser(db, userId)?.name).toBeNull();
  });

  it("POST /api/me setea la ubicación; vacío → null; GET la devuelve; no pisa el alias", async () => {
    const cookie = await login();
    // Default: sin ubicación → null en el GET.
    const me0 = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as {
      location?: string | null;
    };
    expect(me0.location).toBeNull();
    // Setear alias primero, después SOLO location: el alias no se toca (campos opcionales).
    await fetch(`${base}/api/me`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ name: "Alicia" }),
    });
    const res = await fetch(`${base}/api/me`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ location: "  Buenos Aires, Argentina  " }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Alicia", location: "Buenos Aires, Argentina" });
    expect(getUser(db, userId)?.location).toBe("Buenos Aires, Argentina");
    expect(getUser(db, userId)?.name).toBe("Alicia"); // el alias sobrevivió
    const me1 = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as {
      location?: string | null;
    };
    expect(me1.location).toBe("Buenos Aires, Argentina");
    // Vacío → null (limpia la ubicación).
    const clear = await fetch(`${base}/api/me`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ location: "   " }),
    });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toMatchObject({ location: null });
    expect(getUser(db, userId)?.location).toBeNull();
  });

  it("POST /api/me ubicación demasiado larga → 400", async () => {
    const cookie = await login();
    const res = await fetch(`${base}/api/me`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ location: "x".repeat(121) }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/me alias demasiado largo → 400", async () => {
    const cookie = await login();
    const res = await fetch(`${base}/api/me`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ name: "x".repeat(61) }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/me bgQueries: guarda normalizado, no pisa el alias, y GET /api/me lo precarga", async () => {
    const cookie = await login();
    // Sin preferencia: GET /api/me precarga el default de la app (campo editable, no vacío).
    const me0 = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as {
      bgQueries?: string[];
      bgIsDefault?: boolean;
    };
    expect(me0.bgIsDefault).toBe(true);
    expect(me0.bgQueries?.length).toBeGreaterThan(0);
    // Setear el alias primero, después SOLO bgQueries: el alias no se toca (campos opcionales).
    await fetch(`${base}/api/me`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ name: "Alicia" }),
    });
    const res = await fetch(`${base}/api/me`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ bgQueries: ["  monte nativo ", "", "río al alba"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: "Alicia",
      bgQueries: ["monte nativo", "río al alba"],
      bgIsDefault: false,
    });
    expect(getUser(db, userId)?.name).toBe("Alicia"); // el alias sobrevivió
    const me1 = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as {
      bgQueries?: string[];
      bgIsDefault?: boolean;
    };
    expect(me1.bgQueries).toEqual(["monte nativo", "río al alba"]);
    expect(me1.bgIsDefault).toBe(false);
    // Lista vacía → limpia la preferencia → vuelve el default de la app.
    const clear = await fetch(`${base}/api/me`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ bgQueries: [] }),
    });
    expect(clear.status).toBe(200);
    expect((await clear.json()) as object).toMatchObject({ bgIsDefault: true });
    const me2 = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as {
      bgIsDefault?: boolean;
    };
    expect(me2.bgIsDefault).toBe(true);
  });

  it("POST /api/me bgQueries inválidas → 400 (no-array, query demasiado larga)", async () => {
    const cookie = await login();
    const notArray = await fetch(`${base}/api/me`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ bgQueries: "bosque" }),
    });
    expect(notArray.status).toBe(400);
    const tooLong = await fetch(`${base}/api/me`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ bgQueries: ["x".repeat(BG_MAX_QUERY_LEN + 1)] }),
    });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: "query-too-long" });
  });

  it("POST /api/me sin cookie → 401; Origin cruzado → 403", async () => {
    const noCookie = await fetch(`${base}/api/me`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ name: "x" }),
    });
    expect(noCookie.status).toBe(401);
    const cookie = await login();
    const csrf = await fetch(`${base}/api/me`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example", cookie },
      body: JSON.stringify({ name: "x" }),
    });
    expect(csrf.status).toBe(403);
  });

  it("avatar: upload PNG → 200; GET lo devuelve con su mime; /api/me marca hasAvatar; DELETE lo quita", async () => {
    const cookie = await login();
    // Antes de subir: GET → 404, /api/me hasAvatar=false.
    expect((await fetch(`${base}/api/me/avatar`, { headers: { cookie } })).status).toBe(404);
    const me0 = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    expect(me0).toMatchObject({ hasAvatar: false });
    // Upload.
    const up = await fetch(`${base}/api/me/avatar`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ data: b64(PNG), mime: "image/png" }),
    });
    expect(up.status).toBe(200);
    expect(getUserAvatar(db, userId)?.mime).toBe("image/png");
    // GET devuelve los bytes con el content-type correcto.
    const get = await fetch(`${base}/api/me/avatar`, { headers: { cookie } });
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await get.arrayBuffer()).equals(PNG)).toBe(true);
    // /api/me ahora marca hasAvatar=true.
    const me1 = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    expect(me1).toMatchObject({ hasAvatar: true });
    // DELETE → vuelve a sin avatar.
    const del = await fetch(`${base}/api/me/avatar`, { method: "DELETE", headers: { origin, cookie } });
    expect(del.status).toBe(200);
    expect(getUserAvatar(db, userId)).toBeNull();
    expect((await fetch(`${base}/api/me/avatar`, { headers: { cookie } })).status).toBe(404);
  });

  it("avatar upload: formato no-imagen → 415; vacío → 400; gigante → 413", async () => {
    const cookie = await login();
    // Bytes que no matchean ningún magic byte de imagen → 415.
    const bad = await fetch(`${base}/api/me/avatar`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ data: b64(Buffer.from("no soy una imagen")) }),
    });
    expect(bad.status).toBe(415);
    // data vacío → 400.
    const empty = await fetch(`${base}/api/me/avatar`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ data: "" }),
    });
    expect(empty.status).toBe(400);
    // > 512KB → 413 (PNG header + relleno por encima del tope).
    const huge = Buffer.concat([PNG, Buffer.alloc(512 * 1024 + 1, 9)]);
    const big = await fetch(`${base}/api/me/avatar`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ data: b64(huge) }),
    });
    expect(big.status).toBe(413);
  });

  it("GET /api/me: hasPassword refleja la existencia de contraseña en web_passwords", async () => {
    const cookie = await login();
    // Sin contraseña asignada: hasPassword = false (canal email tampoco implica contraseña).
    const me0 = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as {
      hasPassword?: boolean;
    };
    expect(me0.hasPassword).toBe(false);
    // Con canal email pero sin contraseña → sigue en false (magic-link puro).
    addChannel(db, userId, "email", "alice@example.com");
    const me1 = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as {
      hasPassword?: boolean;
    };
    expect(me1.hasPassword).toBe(false);
    // Al asignar contraseña → hasPassword = true.
    setUserPassword(db, userId, "secreta-123");
    const me2 = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as {
      hasPassword?: boolean;
    };
    expect(me2.hasPassword).toBe(true);
  });

  it("avatar upload sin cookie → 401; Origin cruzado → 403", async () => {
    const noCookie = await fetch(`${base}/api/me/avatar`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ data: b64(PNG) }),
    });
    expect(noCookie.status).toBe(401);
    const cookie = await login();
    const csrf = await fetch(`${base}/api/me/avatar`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example", cookie },
      body: JSON.stringify({ data: b64(PNG) }),
    });
    expect(csrf.status).toBe(403);
  });

  // --- Cambio de contraseña (POST /api/me/password) ---------------------------
  it("cambio de contraseña exitoso → 200 y la nueva sirve para loguear", async () => {
    addChannel(db, userId, "email", "alice@example.com");
    setUserPassword(db, userId, "vieja-1234");
    const cookie = await login();
    const res = await fetch(`${base}/api/me/password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ current: "vieja-1234", new: "nueva-5678" }),
    });
    expect(res.status).toBe(200);
    // La vieja ya no loguea; la nueva sí.
    const conVieja = await fetch(`${base}/api/login/password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "alice@example.com", password: "vieja-1234" }),
    });
    expect(conVieja.status).toBe(401);
    const conNueva = await fetch(`${base}/api/login/password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "alice@example.com", password: "nueva-5678" }),
    });
    expect(conNueva.status).toBe(200);
  });

  it("cambio de contraseña con la actual incorrecta → 403 wrong-password (no cambia)", async () => {
    setUserPassword(db, userId, "vieja-1234");
    const cookie = await login();
    const res = await fetch(`${base}/api/me/password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ current: "incorrecta", new: "nueva-5678" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "wrong-password" });
  });

  it("cambio de contraseña con la nueva demasiado corta → 400 too-short", async () => {
    setUserPassword(db, userId, "vieja-1234");
    const cookie = await login();
    const res = await fetch(`${base}/api/me/password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ current: "vieja-1234", new: "corta" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "too-short" });
  });

  it("cambio de contraseña sin tener una seteada → 400 no-password", async () => {
    const cookie = await login();
    const res = await fetch(`${base}/api/me/password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ current: "loquesea", new: "nueva-5678" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no-password" });
  });

  it("cambio de contraseña sin cookie → 401; Origin cruzado → 403", async () => {
    setUserPassword(db, userId, "vieja-1234");
    const noCookie = await fetch(`${base}/api/me/password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ current: "vieja-1234", new: "nueva-5678" }),
    });
    expect(noCookie.status).toBe(401);
    const cookie = await login();
    const csrf = await fetch(`${base}/api/me/password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example", cookie },
      body: JSON.stringify({ current: "vieja-1234", new: "nueva-5678" }),
    });
    expect(csrf.status).toBe(403);
  });

  // --- Avatar de OTRO usuario por handle (chips del explorer) ------------------
  it("GET /api/avatar/<handle>: 200 con el mime si tiene avatar; 404 si no; 401 sin cookie", async () => {
    const cookie = await login();
    const bob = addUser(db, "bob");
    setUserAvatar(db, bob.id, PNG, "image/png");
    // Con avatar → 200 + los bytes con su content-type.
    const ok = await fetch(`${base}/api/avatar/bob`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await ok.arrayBuffer()).equals(PNG)).toBe(true);
    // Usuario sin avatar → 404.
    addUser(db, "carol");
    expect((await fetch(`${base}/api/avatar/carol`, { headers: { cookie } })).status).toBe(404);
    // Handle inexistente → 404.
    expect((await fetch(`${base}/api/avatar/nadie`, { headers: { cookie } })).status).toBe(404);
    // Sin cookie (no autenticado) → 401.
    expect((await fetch(`${base}/api/avatar/bob`)).status).toBe(401);
  });

  it("GET /api/explorer: cada member trae hasAvatar (true para quien subió foto, false si no) y el flag blame", async () => {
    // Repo compartido: alice (viewer) + bob (con avatar) + carol (sin avatar).
    const repo = addRepo(db, "ceibofamily", "shared", "Compartida");
    grantAccess(db, repo.id, userId); // alice
    const bob = addUser(db, "bob");
    const carol = addUser(db, "carol");
    grantAccess(db, repo.id, bob.id);
    grantAccess(db, repo.id, carol.id);
    setUserAvatar(db, bob.id, PNG, "image/png");
    // Wikis personales de alice: una con sources registrados (blame disponible) y otra sin.
    const solaFeed = addRepo(db, "ceibofamily", "sola-feed", "Sola con feed");
    grantAccess(db, solaFeed.id, userId);
    recordWikiChange(db, { repo: "sola-feed", ref: "s1", paths: ["n.md"], source: "web", userId });
    const solaVieja = addRepo(db, "ceibofamily", "sola-vieja", "Sola sin feed");
    grantAccess(db, solaVieja.id, userId);

    // El explorer requiere `wikis`; el server del beforeEach no lo tiene → server propio con un
    // stub mínimo (sólo `listFiles`, que es lo que arma el árbol). La cookie del login sirve acá
    // también (misma sessionKey + misma db).
    const port2 = await freePort();
    const srv2 = startWebServer({
      db,
      port: port2,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      wikis: { listFiles: async () => ["nota.md"] } as unknown as Parameters<
        typeof startWebServer
      >[0]["wikis"],
      log: () => {},
    });
    try {
      const cookie = await login();
      const r = await fetch(`http://127.0.0.1:${port2}/api/explorer`, { headers: { cookie } });
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        wikis: { repo: string; members: { handle: string; hasAvatar?: boolean }[]; blame?: boolean }[];
      };
      const shared = body.wikis.find((w) => w.repo === "shared");
      expect(shared).toBeDefined();
      const byHandle = Object.fromEntries((shared?.members ?? []).map((m) => [m.handle, m.hasAvatar]));
      expect(byHandle.bob).toBe(true);
      expect(byHandle.carol).toBe(false);
      expect(byHandle.alice).toBe(false);
      // Flag blame: compartida siempre; personal sólo si tiene sources registrados.
      expect(shared?.blame).toBe(true);
      expect(body.wikis.find((w) => w.repo === "sola-feed")?.blame).toBe(true);
      expect(body.wikis.find((w) => w.repo === "sola-vieja")?.blame).toBe(false);
    } finally {
      srv2.close();
    }
  });

  // --- Renombrar alias de wiki (POST /api/wiki/label) -------------------------
  // F2 (Q8): el label ahora es un slug validado (minúsculas, dígitos, guiones).
  // En wikis con un solo miembro (o si el user es owner), el rename pasa;
  // en wikis compartidas solo el owner puede renombrar.
  it("POST /api/wiki/label: renombra el alias (slug) del repo del usuario; gating origin/cookie", async () => {
    const repo = addRepo(db, "ceibofamily", "alpha", "alpha");
    grantAccess(db, repo.id, userId, "owner"); // alice es owner de alpha (F2: solo owner puede renombrar shared)
    addRepo(db, "ceibofamily", "ajena", "ajena"); // sin grant a alice
    // El endpoint gatea por userRepoNames; el server del beforeEach no lo pasa → server propio.
    const port2 = await freePort();
    const srv2 = startWebServer({
      db,
      port: port2,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      userRepoNames: (uid) => listReposForUser(db, uid).map((r) => r.name),
      log: () => {},
    });
    const b2 = `http://127.0.0.1:${port2}`;
    try {
      const cookie = await login();
      // Happy path: slug válido, trim aplicado, label persiste.
      const ok = await fetch(`${b2}/api/wiki/label`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b2, cookie },
        body: JSON.stringify({ repo: "alpha", label: "  mi-alpha  " }),
      });
      expect(ok.status).toBe(200);
      expect(getRepoByName(db, "ceibofamily", "alpha")?.label).toBe("mi-alpha");
      // Label vacío → 400, no cambia.
      const empty = await fetch(`${b2}/api/wiki/label`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b2, cookie },
        body: JSON.stringify({ repo: "alpha", label: "   " }),
      });
      expect(empty.status).toBe(400);
      expect(getRepoByName(db, "ceibofamily", "alpha")?.label).toBe("mi-alpha");
      // Slug inválido (tiene mayúsculas/espacios) → 400.
      const badSlug = await fetch(`${b2}/api/wiki/label`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b2, cookie },
        body: JSON.stringify({ repo: "alpha", label: "Mi Alpha" }),
      });
      expect(badSlug.status).toBe(400);
      // Repo ajeno (no en userRepoNames) → 400, no cambia.
      const foreign = await fetch(`${b2}/api/wiki/label`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b2, cookie },
        body: JSON.stringify({ repo: "ajena", label: "hack" }),
      });
      expect(foreign.status).toBe(400);
      expect(getRepoByName(db, "ceibofamily", "ajena")?.label).toBe("ajena");
      // Sin cookie → 401.
      const noCookie = await fetch(`${b2}/api/wiki/label`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b2 },
        body: JSON.stringify({ repo: "alpha", label: "x" }),
      });
      expect(noCookie.status).toBe(401);
      // Origin cruzado → 403.
      const csrf = await fetch(`${b2}/api/wiki/label`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example", cookie },
        body: JSON.stringify({ repo: "alpha", label: "x" }),
      });
      expect(csrf.status).toBe(403);
    } finally {
      srv2.close();
    }
  });

  // Regresion (QA #7): el alias renombrado tiene que SOBREVIVIR al F5. El Explorer relee el label
  // de GET /api/explorer, no del store directo — este test cierra ese hueco: POST label → el
  // /api/explorer subsiguiente devuelve el nombre NUEVO (no el viejo).
  it("POST /api/wiki/label → GET /api/explorer refleja el alias nuevo (persiste tras F5)", async () => {
    const repo = addRepo(db, "ceibofamily", "alpha", "alpha");
    grantAccess(db, repo.id, userId, "owner"); // owner para poder renombrar (F2 Q8)
    const port2 = await freePort();
    // /api/explorer exige opts.wikis (lee files); stub minimo.
    const fakeWikis = { listFiles: async () => ["a.md"] } as unknown as Parameters<
      typeof startWebServer
    >[0]["wikis"];
    const srv2 = startWebServer({
      db,
      port: port2,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      wikis: fakeWikis,
      userRepoNames: (uid) => listReposForUser(db, uid).map((r) => r.name),
      log: () => {},
    });
    const b2 = `http://127.0.0.1:${port2}`;
    try {
      const cookie = await login();
      const post = await fetch(`${b2}/api/wiki/label`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b2, cookie },
        body: JSON.stringify({ repo: "alpha", label: "mi-alpha" }),
      });
      expect(post.status).toBe(200);
      // El read-path que usa el Explorer (lo que verias tras un F5).
      const exp = await fetch(`${b2}/api/explorer`, { headers: { cookie } });
      expect(exp.status).toBe(200);
      const body = (await exp.json()) as { wikis: { repo: string; label: string }[] };
      expect(body.wikis.find((w) => w.repo === "alpha")?.label).toBe("mi-alpha");
    } finally {
      srv2.close();
    }
  });

  // --- Inbox del agente (feature crons-delivery) ------------------------------
  // El FAB 🔔 lee GET /api/inbox al cargar y marca leído con los POST. Reusa el `db`/`userId`/
  // `login` del setup principal de este describe.
  describe("GET/POST /api/inbox", () => {
    it("GET lista los items del usuario + el conteo de no-leídos", async () => {
      const cookie = await login();
      addInboxItem(db, { userId, kind: "cron", sourceId: 5, title: "Dentista", body: "te toca" });
      addInboxItem(db, { userId, kind: "cron", title: "Otro", body: "más" });
      const res = await fetch(`${base}/api/inbox`, { headers: { origin, cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { title: string; read_at: string | null }[];
        unread: number;
      };
      expect(body.items).toHaveLength(2);
      expect(body.items[0]?.title).toBe("Otro"); // más nuevo primero
      expect(body.unread).toBe(2);
    });

    it("GET sin cookie → 401", async () => {
      const res = await fetch(`${base}/api/inbox`, { headers: { origin } });
      expect(res.status).toBe(401);
    });

    it("POST /api/inbox/:id/read marca uno leído y baja el unread", async () => {
      const cookie = await login();
      const item = addInboxItem(db, { userId, kind: "cron", title: "x", body: "y" });
      const res = await fetch(`${base}/api/inbox/${item.id}/read`, {
        method: "POST",
        headers: { origin, cookie },
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as { unread: number }).toEqual({ unread: 0 });
    });

    it("POST /api/inbox/read-all marca todos y devuelve cuántos", async () => {
      const cookie = await login();
      addInboxItem(db, { userId, kind: "cron", title: "1", body: "y" });
      addInboxItem(db, { userId, kind: "cron", title: "2", body: "y" });
      const res = await fetch(`${base}/api/inbox/read-all`, {
        method: "POST",
        headers: { origin, cookie },
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as { marked: number; unread: number }).toEqual({ marked: 2, unread: 0 });
    });

    it("POST con Origin cruzado → 403 (CSRF)", async () => {
      const cookie = await login();
      const res = await fetch(`${base}/api/inbox/read-all`, {
        method: "POST",
        headers: { origin: "http://evil.example", cookie },
      });
      expect(res.status).toBe(403);
    });
  });
});

// --- GET /api/me: campo `model` para el cog ----------------------------------
// El cog del front muestra el modelo a partir de `model` en /api/me. La regla: con ≥1 opción
// mandamos `model` (con 1 sola el front la muestra read-only, NO la oculta); con 0 opciones
// `model` es undefined. Antes el gate era ≥2 (un usuario local con un único modelo no veía nada).
describe("web-server: GET /api/me — campo model", () => {
  type MeBody = { model?: { current: string; options: { id: string; label: string }[] } };

  async function meWith(
    chatModels: (userId: number) => { id: string; label: string }[],
    userModel?: (userId: number) => string,
  ): Promise<MeBody> {
    const port = await freePort();
    const srv = startWebServer({
      db,
      port,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      chatModels,
      userModel,
      log: () => {},
    });
    try {
      const cookie = await login();
      const r = await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { cookie } });
      expect(r.status).toBe(200);
      return (await r.json()) as MeBody;
    } finally {
      srv.close();
    }
  }

  it("0 opciones → no manda `model`", async () => {
    const me = await meWith(() => []);
    expect(me.model).toBeUndefined();
  });

  it("1 sola opción (ej. local con Gemma) → manda `model` con esa única opción (read-only en el front)", async () => {
    const me = await meWith(() => [{ id: "gemma", label: "Gemma 4 31B — local" }]);
    expect(me.model).toBeDefined();
    expect(me.model?.options).toEqual([{ id: "gemma", label: "Gemma 4 31B — local" }]);
    expect(me.model?.current).toBe("gemma"); // sin userModel → cae a la 1ra opción
  });

  it("≥2 opciones → manda `model` con todas y respeta el userModel actual", async () => {
    const me = await meWith(
      () => [
        { id: "haiku", label: "Haiku" },
        { id: "sonnet", label: "Sonnet" },
        { id: "opus", label: "Opus" },
      ],
      () => "sonnet",
    );
    expect(me.model?.options).toHaveLength(3);
    expect(me.model?.current).toBe("sonnet");
  });
});

// --- GET /api/me: campo `email` (email de registro) para el panel de perfil --
// El cog muestra el mail con el que entrás. Sale de la identidad `email` (magic-link) o
// `google` (OIDC); con `email` presente se prefiere ésa. Sin ninguna → null.
describe("web-server: GET /api/me — campo email", () => {
  type MeBody = { handle?: string; email?: string | null };
  async function me(cookie: string): Promise<MeBody> {
    const r = await fetch(`${base}/api/me`, { headers: { cookie } });
    expect(r.status).toBe(200);
    return (await r.json()) as MeBody;
  }

  it("identidad `email` → devuelve ese mail", async () => {
    addChannel(db, userId, "email", "alice@example.com");
    const cookie = await login();
    const body = await me(cookie);
    expect(body.handle).toBe("alice");
    expect(body.email).toBe("alice@example.com");
  });

  it("sólo identidad `google` → cae al mail del grant Google", async () => {
    addChannel(db, userId, "google", "alice@gmail.com");
    const cookie = await login();
    expect((await me(cookie)).email).toBe("alice@gmail.com");
  });

  it("`email` y `google` presentes → prefiere la identidad `email`", async () => {
    addChannel(db, userId, "google", "alice@gmail.com");
    addChannel(db, userId, "email", "alice@example.com");
    const cookie = await login();
    expect((await me(cookie)).email).toBe("alice@example.com");
  });

  it("sin identidad de email (sólo web/telegram) → email null", async () => {
    addChannel(db, userId, "telegram", "12345");
    const cookie = await login();
    expect((await me(cookie)).email).toBeNull();
  });
});

// --- SPA fallback (deep-links de nota como path real) -------------------------
// Un refresh/visita directa a `/<repo>/<path…>` debe devolver la SPA (index.html), no 404,
// para que el cliente parsee el pathname y abra la nota. Pero /api/* y los assets siguen como
// están. Server propio con un staticDir REAL (index.html + un asset hasheado).
describe("web-server: SPA fallback para deep-links de nota", () => {
  let dir: string;
  let db2: ReturnType<typeof openDb>;
  let srv: WebServer;
  let base2: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ceibo-web-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>ceibo SPA</title>");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log('bundle')");
    db2 = openDb(":memory:");
    const port = await freePort();
    base2 = `http://127.0.0.1:${port}`;
    srv = startWebServer({
      db: db2,
      port,
      staticDir: dir,
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      log: () => {},
    });
  });

  afterEach(() => {
    srv.close();
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET a un deep-link de nota `/<repo>/<path>` → 200 con el index.html (sin auth)", async () => {
    const res = await fetch(`${base2}/demo-personal/2026/junio/nota.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("ceibo SPA");
  });

  it("GET `/` (raíz) → 200 con el index.html", async () => {
    const res = await fetch(`${base2}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ceibo SPA");
  });

  it("GET de un asset hasheado existente → 200 con su JS (no el index)", async () => {
    const res = await fetch(`${base2}/assets/index-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("bundle");
  });

  it("GET de una ruta /api/* inexistente → 404 JSON (NO la SPA)", async () => {
    const res = await fetch(`${base2}/api/no-existe`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ error: "not-found" });
  });

  it("GET /health sigue respondiendo ok (no lo come el fallback)", async () => {
    const res = await fetch(`${base2}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

// Signup por Google con allowlist (registración invite-only). Mockea el token endpoint de
// Google (exchangeCode usa globalThis.fetch) → el id_token es un JWT no-firmado con los claims
// que valida emailFromClaims (no verificamos firma, ver cabecera de google-auth.ts). El cliente
// `wikis` se fakea (capturamos createRepo) → no toca GitHub. Cubre el cableado del callback:
// gate de allowlist → alta automática (backend local + identidad google) → wiki personal.
describe("web-server e2e — signup por Google (allowlist)", () => {
  const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
  let d: ReturnType<typeof openDb>;
  let srv: WebServer;
  let b: string;
  let createdRepos: string[];
  let seededNotes: { repo: string; to: string; content: string }[];
  let realFetch: typeof globalThis.fetch;

  function fakeIdToken(email: string): string {
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        aud: CLIENT_ID,
        iss: "https://accounts.google.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
        email,
        email_verified: true,
      }),
    ).toString("base64url");
    return `${header}.${payload}.sig`;
  }

  beforeEach(async () => {
    d = openDb(":memory:");
    createdRepos = [];
    seededNotes = [];
    const port = await freePort();
    b = `http://127.0.0.1:${port}`;
    realFetch = globalThis.fetch;
    srv = startWebServer({
      db: d,
      port,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      googleAuth: {
        clientId: CLIENT_ID,
        clientSecret: "secret",
        redirectUri: `${b}/api/auth/google/callback`,
      },
      wikis: {
        org: "ceibo-test",
        createRepo: async (name: string) => {
          createdRepos.push(name);
          return { fullName: `ceibo-test/${name}`, htmlUrl: "", cloneUrl: "" };
        },
        // Simulamos el README pelado de auto_init; la siembra lo mueve a Bienvenida.md con contenido.
        getFile: async (_repo: string, _path: string) => ({ content: "# repo", sha: "sha0" }),
        moveFile: async (
          repo: string,
          _from: string,
          to: string,
          _baseSha: string,
          _msg: string,
          o?: { newContent?: string },
        ) => {
          seededNotes.push({ repo, to, content: o?.newContent ?? "" });
          return { sha: "sha1", path: to };
        },
      } as unknown as Parameters<typeof startWebServer>[0]["wikis"],
      userRepoNames: (uid) => listReposForUser(d, uid).map((r) => r.name),
      log: () => {},
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    srv.close();
    d.close();
  });

  // Hace /start (captura el state cookie), mockea el token endpoint, y completa /callback.
  async function googleLogin(email: string): Promise<Response> {
    const start = await realFetch(`${b}/api/auth/google/start`, { redirect: "manual" });
    const setCookie = start.headers.get("set-cookie") ?? "";
    const state = /ceibo_gstate=([^;]+)/.exec(setCookie)?.[1] ?? "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ id_token: fakeIdToken(email) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(url as Parameters<typeof realFetch>[0]);
    }) as typeof globalThis.fetch;
    return realFetch(`${b}/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: { cookie: `ceibo_gstate=${state}` },
    });
  }

  it("email autorizado sin cuenta → crea user local + identidad google + wiki personal", async () => {
    addAuthorizedEmail(d, "usuario42@gmail.com", { name: "Ether" });
    const res = await googleLogin("usuario42@gmail.com");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie") ?? "").toContain("ceibo_session=");
    const user = resolveUser(d, "google", "usuario42@gmail.com");
    expect(user).toBeDefined();
    if (!user) throw new Error("sin user");
    expect(user.name).toBe("Ether");
    expect(getUserBackendMode(d, user.id)).toBe("local");
    // wiki personal auto-creada (invariante): repo `<handle>-personal` en GitHub + grant al dueño
    expect(createdRepos).toEqual([`${user.handle}-personal`]);
    const repo = getRepoByName(d, "ceibo-test", `${user.handle}-personal`);
    expect(repo).toBeDefined();
    expect(listReposForUser(d, user.id).map((r) => r.name)).toContain(`${user.handle}-personal`);
    // El README pelado se convirtió en la nota Bienvenida.md (normal, editable después).
    expect(seededNotes).toHaveLength(1);
    expect(seededNotes[0]?.repo).toBe(`${user.handle}-personal`);
    expect(seededNotes[0]?.to).toBe("Bienvenida.md");
    expect(seededNotes[0]?.content).toContain("Hola, soy Ceibo");
  });

  it("email NO autorizado → /?waitlisted=1 + fila en waitlist, no crea usuario ni wiki", async () => {
    const res = await googleLogin("intruso@evil.com");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?waitlisted=1");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("ceibo_session=");
    expect(resolveUser(d, "google", "intruso@evil.com")).toBeUndefined();
    expect(createdRepos).toEqual([]);
    // P3: se agrega a la waitlist (self-signup)
    const entry = getWaitingEntry(d, "intruso@evil.com");
    expect(entry).toBeDefined();
    expect(entry?.source).toBe("self-signup");
    expect(entry?.status).toBe("pending");
  });

  it("email NO autorizado que ya estaba en waitlist → /?waitlisted=already", async () => {
    addToWaitingList(d, "intruso@evil.com");
    const res = await googleLogin("intruso@evil.com");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?waitlisted=already");
  });

  it("email NO autorizado con invite pendiente → waitlist source=invited (accept implícito)", async () => {
    const inviter = addUser(d, "inviterx");
    const someRepo = addRepo(d, "ceibo-test", "some-wiki", "Some Wiki");
    addInvite(d, someRepo.id, "invited-google@example.com", inviter.id);
    const res = await googleLogin("invited-google@example.com");
    expect(res.headers.get("location")).toBe("/?waitlisted=1");
    const entry = getWaitingEntry(d, "invited-google@example.com");
    expect(entry?.source).toBe("invited");
    expect(entry?.invited_by).toBe(inviter.id);
  });

  it("usuario existente con identidad google → login, sin recrear wiki", async () => {
    const u = addUser(d, "ya", { name: "Ya Existe" });
    addChannel(d, u.id, "google", "ya@x.com");
    const res = await googleLogin("ya@x.com");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(createdRepos).toEqual([]); // no es alta → no auto-provisiona wiki
  });
});

// --- POST /api/folder/archive: borrar carpeta entera (fix del zombie) -------------------
// El archivado por-nota escribía el `_archivado.md` ADENTRO de la carpeta que se borraba →
// la carpeta renacía anclada por su índice y (como los índices se saltean) no se podía
// volver a borrar. El endpoint de carpeta borra TODO bajo el prefijo en UN commit e indexa
// en el manifest del PADRE. Acá cubrimos el cableado HTTP (gating + wiring a archiveFolder).
describe("web-server e2e — POST /api/folder/archive", () => {
  let db: ReturnType<typeof openDb>;
  let server: WebServer;
  let base: string;
  let userId: number;
  // Repo fake en memoria: path → contenido. commit() lo MUTA (aplica los changes), así el
  // segundo request ve el estado nuevo (suficiente para el wiring; la semántica fina del
  // changeset está en archive.test.ts).
  let repoFiles: Record<string, string>;

  beforeEach(async () => {
    db = openDb(":memory:");
    userId = addUser(db, "alice").id;
    const repo = addRepo(db, "ceibofamily", "alice-personal", "Personal");
    grantAccess(db, repo.id, userId);
    repoFiles = {
      "tecnico/delete-me/nota.md": "# Nota\n\nAsistimos 9 vecinos.",
      "tecnico/delete-me/_index.md": "# Índice",
      "tecnico/otra.md": "# Otra",
    };
    const fakeWikis = {
      listFiles: async () => Object.keys(repoFiles),
      read: async (_r: string, _ref?: string, paths?: string[]) => ({
        ref: "head",
        files: (paths ?? Object.keys(repoFiles))
          .filter((p) => p in repoFiles)
          .map((p) => ({ path: p, content: repoFiles[p] ?? "", sha: "s" })),
      }),
      getFile: async (_r: string, path: string) => {
        const content = repoFiles[path];
        if (content === undefined) throw new Error("404");
        return { content, sha: "s", path };
      },
      headSha: async () => "head",
      commit: async (
        _r: string,
        _base: string,
        changes: Array<{ op: string; path: string; content?: string }>,
      ) => {
        for (const c of changes) {
          if (c.op === "delete") delete repoFiles[c.path];
          else repoFiles[c.path] = c.content ?? "";
        }
        return { ok: true as const, ref: "newref" };
      },
    } as unknown as Parameters<typeof startWebServer>[0]["wikis"];
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = startWebServer({
      db,
      port,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      wikis: fakeWikis,
      userRepoNames: (uid) => listReposForUser(db, uid).map((r) => r.name),
      log: () => {},
    });
  });

  afterEach(() => {
    server.close();
    db.close();
  });

  async function login2(): Promise<string> {
    const token = createWebLoginToken(db, userId);
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ t: token }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("ceibo_session="));
    return (setCookie as string).split(";")[0] as string;
  }

  it("borra la carpeta entera (notas + índices) e indexa en el .archived.md del padre; la carpeta NO renace", async () => {
    const cookie = await login2();
    const res = await fetch(`${base}/api/folder/archive`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, cookie },
      body: JSON.stringify({ repo: "alice-personal", path: "tecnico/delete-me" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ archived: 1 });
    // Nada quedó bajo el prefijo — sin manifest interno que reviva la carpeta.
    expect(Object.keys(repoFiles).filter((p) => p.startsWith("tecnico/delete-me/"))).toEqual([]);
    expect(repoFiles["tecnico/.archived.md"]).toContain("- [nota](delete-me/nota.md)");
    expect(repoFiles["tecnico/otra.md"]).toBeDefined(); // hermana intacta
    // Segundo intento (la carpeta ya no existe) → idempotente, 200 sin cambios.
    const again = await fetch(`${base}/api/folder/archive`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, cookie },
      body: JSON.stringify({ repo: "alice-personal", path: "tecnico/delete-me" }),
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ archived: 0 });
  });

  it("gating: sin cookie → 401; origin cruzado → 403; repo ajeno o path inseguro → 400", async () => {
    const noCookie = await fetch(`${base}/api/folder/archive`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ repo: "alice-personal", path: "tecnico/delete-me" }),
    });
    expect(noCookie.status).toBe(401);
    const cookie = await login2();
    const badOrigin = await fetch(`${base}/api/folder/archive`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example", cookie },
      body: JSON.stringify({ repo: "alice-personal", path: "tecnico/delete-me" }),
    });
    expect(badOrigin.status).toBe(403);
    const foreignRepo = await fetch(`${base}/api/folder/archive`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, cookie },
      body: JSON.stringify({ repo: "ajena", path: "tecnico/delete-me" }),
    });
    expect(foreignRepo.status).toBe(400);
    const badPath = await fetch(`${base}/api/folder/archive`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, cookie },
      body: JSON.stringify({ repo: "alice-personal", path: "../fuera" }),
    });
    expect(badPath.status).toBe(400);
    // Nada se tocó.
    expect(repoFiles["tecnico/delete-me/nota.md"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GET /api/bg — endpoint público de fondo Unsplash
// ---------------------------------------------------------------------------
describe("GET /api/bg — fondo desde Unsplash", () => {
  let bgDb: Db;
  let bgServer: WebServer;
  let bgBase: string;

  // Respuesta canónica de Unsplash que mockearemos.
  const fakeUnsplashResponse = {
    urls: {
      regular: "https://images.unsplash.com/photo-fake?w=1080",
      raw: "https://images.unsplash.com/photo-fake?ixid=abc123&ixlib=rb-4.0.3",
    },
    user: {
      name: "Forest Photographer",
      links: { html: "https://unsplash.com/@forest" },
    },
    links: {
      html: "https://unsplash.com/photos/fake",
      download_location: "https://api.unsplash.com/photos/fake/download",
    },
  };

  beforeEach(async () => {
    bgDb = openDb(":memory:");
    const port = await freePort();
    bgBase = `http://127.0.0.1:${port}`;
    bgServer = startWebServer({
      db: bgDb,
      port,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      log: () => {},
    });
    // Resetear el caché de Unsplash y la key entre tests para aislar completamente.
    _resetBgCacheForTests();
    delete process.env.UNSPLASH_ACCESS_KEY;
  });

  afterEach(() => {
    bgServer.close();
    bgDb.close();
    vi.restoreAllMocks();
    _resetBgCacheForTests();
    delete process.env.UNSPLASH_ACCESS_KEY;
  });

  it("sin UNSPLASH_ACCESS_KEY → { url: null } (usa locales)", async () => {
    const res = await fetch(`${bgBase}/api/bg`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: null });
  });

  it("es público (no requiere cookie)", async () => {
    // Sin cookie, sin token → 200 (no 401)
    const res = await fetch(`${bgBase}/api/bg`);
    expect(res.status).toBe(200);
  });

  it("con key + Unsplash OK → devuelve url y atribución", async () => {
    process.env.UNSPLASH_ACCESS_KEY = "test-key-abc";
    // Mockeamos fetch global para la llamada a Unsplash.
    // El primer fetch es el de Unsplash (photos/random); el segundo es el
    // download trigger (fire-and-forget). Los separamos por URL.
    const origFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | Request | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.includes("api.unsplash.com/photos/random")) {
        return new Response(JSON.stringify(fakeUnsplashResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("api.unsplash.com/photos/fake/download")) {
        // trigger download — fire-and-forget, ignorar
        return new Response("{}", { status: 200 });
      }
      // Otras URLs (la del propio server) van por fetch real.
      return origFetch(input as Parameters<typeof origFetch>[0], init);
    });
    const res = await fetch(`${bgBase}/api/bg`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url?: string;
      placeholder?: string;
      author?: string;
      authorLink?: string;
      link?: string;
    };
    // URL proxied same-origin: WebGL puede cargar la textura sin CORS, conservando la raw hi-res.
    expect(body.url).toBe(
      "/api/bg-image?url=https%3A%2F%2Fimages.unsplash.com%2Fphoto-fake%3Fixid%3Dabc123%26ixlib%3Drb-4.0.3%26w%3D2560%26q%3D80%26auto%3Dformat%26fit%3Dmax",
    );
    // Placeholder LQIP: la MISMA raw a 32px + blur, también proxeada same-origin.
    expect(body.placeholder).toBe(
      "/api/bg-image?url=https%3A%2F%2Fimages.unsplash.com%2Fphoto-fake%3Fixid%3Dabc123%26ixlib%3Drb-4.0.3%26w%3D32%26q%3D40%26blur%3D200%26auto%3Dformat%26fit%3Dmax",
    );
    expect(body.author).toBe("Forest Photographer");
    expect(body.authorLink).toBe("https://unsplash.com/@forest");
    expect(body.link).toBe("https://unsplash.com/photos/fake");
  });

  it("con key + Unsplash falla (500) → { url: null }", async () => {
    process.env.UNSPLASH_ACCESS_KEY = "test-key-xyz";
    const origFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | Request | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.includes("api.unsplash.com")) {
        return new Response("error", { status: 500 });
      }
      return origFetch(input as Parameters<typeof origFetch>[0], init);
    });
    const res = await fetch(`${bgBase}/api/bg`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: null });
  });

  // --- Prompts por usuario (cog de settings) + cache por pool -----------------
  // Mockea Unsplash capturando la `query` de cada llamada; el login real (magic-link) da
  // la cookie. Cubre: user con queries propias vs default, pre-login = default, y que el
  // cache de un pool NO se sirve a otro pool (pero sí se reusa dentro del mismo).
  const DEFAULT_QUERY = "forest trees light sunrays";

  /** Stub de fetch que responde Unsplash OK y anota la query de cada llamada. */
  function stubUnsplash(seenQueries: string[]): void {
    const origFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | Request | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.includes("api.unsplash.com/photos/random")) {
        seenQueries.push(new URL(url).searchParams.get("query") ?? "");
        return new Response(JSON.stringify(fakeUnsplashResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("api.unsplash.com")) return new Response("{}", { status: 200 });
      return origFetch(input as Parameters<typeof origFetch>[0], init);
    });
  }

  /** Login magic-link real contra el server del describe → header Cookie. */
  async function bgLogin(uid: number): Promise<string> {
    const token = createWebLoginToken(bgDb, uid);
    const res = await fetch(`${bgBase}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: bgBase },
      body: JSON.stringify({ t: token }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("ceibo_session="));
    return (setCookie as string).split(";")[0] as string;
  }

  it("usuario con queries propias → Unsplash recibe la SUYA; sin login → default", async () => {
    process.env.UNSPLASH_ACCESS_KEY = "test-key-abc";
    const uid = addUser(bgDb, "fondista").id;
    setUserBgQueries(bgDb, uid, ["atardecer en la pampa"]);
    const cookie = await bgLogin(uid);
    const seen: string[] = [];
    stubUnsplash(seen);
    // Pre-login (sin cookie) → query default de la app.
    const anon = await fetch(`${bgBase}/api/bg`);
    expect(anon.status).toBe(200);
    expect(((await anon.json()) as { url: string }).url).toContain("images.unsplash.com");
    // Logueado con preferencia → SU query.
    const own = await fetch(`${bgBase}/api/bg`, { headers: { cookie } });
    expect(own.status).toBe(200);
    expect(seen).toEqual([DEFAULT_QUERY, "atardecer en la pampa"]);
  });

  it("usuario logueado SIN preferencia (o con basura guardada) → query default", async () => {
    process.env.UNSPLASH_ACCESS_KEY = "test-key-abc";
    const uid = addUser(bgDb, "sinpref").id;
    const cookie = await bgLogin(uid);
    const seen: string[] = [];
    stubUnsplash(seen);
    const res = await fetch(`${bgBase}/api/bg`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(seen).toEqual([DEFAULT_QUERY]);
    // Basura directa en la columna (bypass del setter) → getter sanea → default, sin 500.
    bgDb.prepare("UPDATE users SET bg_queries = ? WHERE id = ?").run("{rotura", uid);
    _resetBgCacheForTests();
    const res2 = await fetch(`${bgBase}/api/bg`, { headers: { cookie } });
    expect(res2.status).toBe(200);
    expect(seen).toEqual([DEFAULT_QUERY, DEFAULT_QUERY]);
  });

  it("cache POR POOL: pools distintos no comparten entrada; el mismo pool sí (dentro del TTL)", async () => {
    process.env.UNSPLASH_ACCESS_KEY = "test-key-abc";
    const uid = addUser(bgDb, "cacheado").id;
    setUserBgQueries(bgDb, uid, ["faro en la tormenta"]);
    const cookie = await bgLogin(uid);
    const seen: string[] = [];
    stubUnsplash(seen);
    await fetch(`${bgBase}/api/bg`); // default → fetch a Unsplash (1)
    await fetch(`${bgBase}/api/bg`); // default de nuevo → cache hit, NO refetchea
    await fetch(`${bgBase}/api/bg`, { headers: { cookie } }); // pool propio → fetch (2)
    await fetch(`${bgBase}/api/bg`, { headers: { cookie } }); // pool propio → cache hit
    await fetch(`${bgBase}/api/bg`); // default sigue cacheado
    expect(seen).toEqual([DEFAULT_QUERY, "faro en la tormenta"]);
  });
});

// --- normalizeBgQueries: validación del setting de prompts del fondo ----------
describe("normalizeBgQueries", () => {
  it("trim + descarta vacías; lista vacía o null → queries null (default)", () => {
    expect(normalizeBgQueries(["  bosque  ", "", "   ", "mar"])).toEqual({ queries: ["bosque", "mar"] });
    expect(normalizeBgQueries([])).toEqual({ queries: null });
    expect(normalizeBgQueries(["", "  "])).toEqual({ queries: null });
    expect(normalizeBgQueries(null)).toEqual({ queries: null });
  });

  it("no-array → error; entradas no-string se ignoran", () => {
    expect(normalizeBgQueries("bosque")).toEqual({ error: "bad-request" });
    expect(normalizeBgQueries({ q: "x" })).toEqual({ error: "bad-request" });
    expect(normalizeBgQueries([1, true, "ok", {}])).toEqual({ queries: ["ok"] });
  });

  it("tope de cantidad (descarta el resto) y de longitud (rechaza)", () => {
    const many = Array.from({ length: BG_MAX_QUERIES + 5 }, (_, i) => `q${i}`);
    const norm = normalizeBgQueries(many);
    expect("queries" in norm && norm.queries?.length).toBe(BG_MAX_QUERIES);
    expect(normalizeBgQueries(["x".repeat(BG_MAX_QUERY_LEN + 1)])).toEqual({ error: "query-too-long" });
    expect(normalizeBgQueries(["x".repeat(BG_MAX_QUERY_LEN)])).toEqual({
      queries: ["x".repeat(BG_MAX_QUERY_LEN)],
    });
  });
});

// --- GET /api/file/blame: blame por línea, SOLO wikis compartidas -------------
// Gate server-side: sesión + repo del usuario + repo COMPARTIDO (>1 usuario activo con
// acceso). La resolución de autoría: email canónico `<handle>@users.example.com` → handle
// (+ display name vigente del store); cualquier otro email (bot del App, historia previa a
// #296) → handle null (la UI lo pinta "histórico"). Cache por (repo, path) keyed al HEAD.
describe("web-server e2e — GET /api/file/blame", () => {
  let db: ReturnType<typeof openDb>;
  let server: WebServer;
  let base: string;
  let aliceId: number;
  let repoId: number;
  let blameCalls: number;
  let headShaValue: string;

  beforeEach(async () => {
    db = openDb(":memory:");
    aliceId = addUser(db, "alice", { name: "Alicia" }).id;
    const repo = addRepo(db, "ceibofamily", "alice-viaje", "Viaje");
    repoId = repo.id;
    grantAccess(db, repoId, aliceId);
    blameCalls = 0;
    headShaValue = "head1";
    const fakeWikis = {
      headSha: async () => headShaValue,
      blame: async (_repo: string, path: string) => {
        blameCalls++;
        if (path === "no-existe.md") throw new Error("Path 'no-existe.md' does not exist");
        return {
          ref: headShaValue,
          ranges: [
            {
              startLine: 1,
              endLine: 2,
              authorEmail: "anni@users.example.com",
              authorName: "anni",
              sha: "c1",
              date: "2026-06-09T12:00:00Z",
            },
            {
              startLine: 3,
              endLine: 3,
              authorEmail: "12345+ceibo-app[bot]@users.noreply.github.com",
              authorName: "ceibo-app[bot]",
              sha: "c0",
              date: "2026-05-01T00:00:00Z",
            },
            {
              startLine: 4,
              endLine: 6,
              authorEmail: "fantasma@users.example.com", // handle que ya no existe en el store
              authorName: "Casper",
              sha: "c2",
              date: "2026-06-01T00:00:00Z",
            },
          ],
        };
      },
    } as unknown as Parameters<typeof startWebServer>[0]["wikis"];
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = startWebServer({
      db,
      port,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      wikis: fakeWikis,
      userRepoNames: (uid) => listReposForUser(db, uid).map((r) => r.name),
      log: () => {},
    });
  });

  afterEach(() => {
    server.close();
    db.close();
  });

  async function loginBlame(): Promise<string> {
    const token = createWebLoginToken(db, aliceId);
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ t: token }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("ceibo_session="));
    return (setCookie as string).split(";")[0] as string;
  }

  const blameUrl = (repo: string, path: string) =>
    `${base}/api/file/blame?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`;

  it("sin cookie → 401", async () => {
    const r = await fetch(blameUrl("alice-viaje", "plan.md"));
    expect(r.status).toBe(401);
  });

  it("wiki NO compartida y SIN sources registrados → 403 not-shared, sin pegarle al blame", async () => {
    const cookie = await loginBlame();
    const r = await fetch(blameUrl("alice-viaje", "plan.md"), { headers: { cookie } });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "not-shared" });
    expect(blameCalls).toBe(0);
  });

  it("wiki personal CON sources → 200 shared:false y source por sha (web/agent/null)", async () => {
    // La distinción humano/IA está disponible: hay commits registrados con source.
    recordWikiChange(db, {
      repo: "alice-viaje",
      ref: "c1",
      paths: ["plan.md"],
      source: "web",
      userId: aliceId,
    });
    recordWikiChange(db, {
      repo: "alice-viaje",
      ref: "c2",
      paths: ["plan.md"],
      source: "rem",
      userId: aliceId,
    });
    const cookie = await loginBlame();
    const r = await fetch(blameUrl("alice-viaje", "plan.md"), { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      shared: boolean;
      ranges: Array<{ sha: string; source: string | null }>;
    };
    expect(body.shared).toBe(false);
    const bySha = new Map(body.ranges.map((x) => [x.sha, x.source]));
    expect(bySha.get("c1")).toBe("web"); // edición humana en la web
    expect(bySha.get("c2")).toBe("agent"); // 'rem' se colapsa a 'agent' en el wire
    expect(bySha.get("c0")).toBeNull(); // sha sin registro → desconocido
  });

  it("compartida con un usuario DISABLED no cuenta → sigue 403", async () => {
    const otherId = addUser(db, "bob").id;
    grantAccess(db, repoId, otherId);
    setUserStatus(db, otherId, "disabled");
    const cookie = await loginBlame();
    const r = await fetch(blameUrl("alice-viaje", "plan.md"), { headers: { cookie } });
    expect(r.status).toBe(403);
  });

  it("repo ajeno o path inseguro → 404", async () => {
    const cookie = await loginBlame();
    expect((await fetch(blameUrl("ajena", "plan.md"), { headers: { cookie } })).status).toBe(404);
    expect((await fetch(blameUrl("alice-viaje", "../fuga.md"), { headers: { cookie } })).status).toBe(404);
  });

  it("compartida → 200 con handles resueltos: canónico → handle+name, bot → null, handle borrado → authorName", async () => {
    const anniId = addUser(db, "anni", { name: "Anni" }).id;
    grantAccess(db, repoId, anniId);
    // anni subió foto → sus ranges llevan hasAvatar:true (mismo gating que los chips del explorer).
    setUserAvatar(
      db,
      anniId,
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 7)]),
      "image/png",
    );
    const cookie = await loginBlame();
    const r = await fetch(blameUrl("alice-viaje", "plan.md"), { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ref: string; shared: boolean; ranges: unknown[] };
    expect(body.ref).toBe("head1");
    expect(body.shared).toBe(true);
    expect(body.ranges).toEqual([
      // source null: shas sin registro en wiki_commit_sources (historia previa al feed).
      {
        start: 1,
        end: 2,
        handle: "anni",
        name: "Anni",
        date: "2026-06-09T12:00:00Z",
        sha: "c1",
        source: null,
        hasAvatar: true,
      },
      {
        start: 3,
        end: 3,
        handle: null,
        name: null,
        date: "2026-05-01T00:00:00Z",
        sha: "c0",
        source: null,
        hasAvatar: false,
      },
      // El handle existe como autor pero ya no en el store → conservamos el name del commit.
      {
        start: 4,
        end: 6,
        handle: "fantasma",
        name: "Casper",
        date: "2026-06-01T00:00:00Z",
        sha: "c2",
        source: null,
        hasAvatar: false,
      },
    ]);
  });

  it("cachea por HEAD: mismo head → 1 sola llamada a blame; head nuevo → recomputa", async () => {
    const anniId = addUser(db, "anni", { name: "Anni" }).id;
    grantAccess(db, repoId, anniId);
    const cookie = await loginBlame();
    expect((await fetch(blameUrl("alice-viaje", "plan.md"), { headers: { cookie } })).status).toBe(200);
    expect((await fetch(blameUrl("alice-viaje", "plan.md"), { headers: { cookie } })).status).toBe(200);
    expect(blameCalls).toBe(1); // el 2do salió del cache (HEAD sin cambios)
    headShaValue = "head2"; // el repo avanzó
    expect((await fetch(blameUrl("alice-viaje", "plan.md"), { headers: { cookie } })).status).toBe(200);
    expect(blameCalls).toBe(2);
  });

  it("path inexistente (GitHub tira en el GraphQL) → 404", async () => {
    const anniId = addUser(db, "anni").id;
    grantAccess(db, repoId, anniId);
    const cookie = await loginBlame();
    const r = await fetch(blameUrl("alice-viaje", "no-existe.md"), { headers: { cookie } });
    expect(r.status).toBe(404);
  });

  it("author email = email de login (push desde clone local) → resuelve handle+name", async () => {
    // Escenario: el usuario "bob" firmó commits con su email personal personal@example.com
    // (git config user.email), que es su email de login web — NO el canónico
    // `bob@users.example.com`. El resolver debe matchearlo y devolver handle+name.
    const bobId = addUser(db, "bob", { name: "Roberto" }).id;
    grantAccess(db, repoId, bobId);
    // Registramos el email de login como canal "email" (igual que registerEmailUserIfAuthorized).
    addChannel(db, bobId, "email", "personal@example.com");

    // Sobreescribimos el fake wikis para este test: autor con email personal de login.
    server.close();
    const fakeWikisLogin = {
      headSha: async () => "head-login",
      blame: async () => ({
        ref: "head-login",
        ranges: [
          {
            startLine: 1,
            endLine: 3,
            authorEmail: "personal@example.com", // email personal, no canónico
            authorName: "Bob Git",
            sha: "c10",
            date: "2026-06-10T10:00:00Z",
          },
          {
            startLine: 4,
            endLine: 4,
            authorEmail: "PERSONAL@EXAMPLE.COM", // misma dirección, mayúsculas → insensible
            authorName: "Bob Git Upper",
            sha: "c11",
            date: "2026-06-10T11:00:00Z",
          },
          {
            startLine: 5,
            endLine: 5,
            authorEmail: "desconocido@example.com", // no es nadie → handle null
            authorName: "Unknown",
            sha: "c12",
            date: "2026-06-09T00:00:00Z",
          },
        ],
      }),
    } as unknown as Parameters<typeof startWebServer>[0]["wikis"];
    const port2 = await freePort();
    const base2 = `http://127.0.0.1:${port2}`;
    const server2 = startWebServer({
      db,
      port: port2,
      staticDir: (await import("node:os")).tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      wikis: fakeWikisLogin,
      userRepoNames: (uid) => listReposForUser(db, uid).map((r) => r.name),
      log: () => {},
    });
    const blameUrl2 = (repo: string, path: string) =>
      `${base2}/api/file/blame?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`;
    const token = createWebLoginToken(db, aliceId);
    const loginRes = await fetch(`${base2}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base2 },
      body: JSON.stringify({ t: token }),
    });
    const setCookie2 = loginRes.headers.getSetCookie().find((c) => c.startsWith("ceibo_session="));
    const cookie2 = (setCookie2 as string).split(";")[0] as string;

    const r = await fetch(blameUrl2("alice-viaje", "plan.md"), { headers: { cookie: cookie2 } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ref: string; ranges: unknown[] };
    expect(body.ranges).toEqual([
      // Email personal matched → handle+name del store
      {
        start: 1,
        end: 3,
        handle: "bob",
        name: "Roberto",
        date: "2026-06-10T10:00:00Z",
        sha: "c10",
        source: null,
        hasAvatar: false,
      },
      // Mismo email en mayúsculas → insensible, mismo resultado
      {
        start: 4,
        end: 4,
        handle: "bob",
        name: "Roberto",
        date: "2026-06-10T11:00:00Z",
        sha: "c11",
        source: null,
        hasAvatar: false,
      },
      // Email desconocido → handle null
      {
        start: 5,
        end: 5,
        handle: null,
        name: null,
        date: "2026-06-09T00:00:00Z",
        sha: "c12",
        source: null,
        hasAvatar: false,
      },
    ]);
    server2.close();
  });
});

// ---------------------------------------------------------------------------
// F2 — Wiki management ops: crear/invitar/archivar/desarchivar/irse/borrar
// ---------------------------------------------------------------------------
// Fixture helpers reutilizables en todos los describe de F2.
// startWikiServer: levanta un server con wikis stub + userRepoNames. Captura logs.
async function startWikiServer(
  db: ReturnType<typeof openDb>,
  opts: {
    createRepo?: () => Promise<void>;
    logCapture?: string[];
    seedCapture?: { repo: string; to: string; content: string }[];
  } = {},
): Promise<{ srv: WebServer; b: string; logs: string[] }> {
  const logs: string[] = opts.logCapture ?? [];
  const port = await freePort();
  const fakeWikis = {
    org: "ceibofamily",
    listFiles: async () => [],
    createRepo: opts.createRepo ?? (async (_name: string) => ({ name: _name })),
    // README pelado de auto_init → la siembra lo mueve a Bienvenida.md. Capturamos el move.
    getFile: async (_repo: string, _path: string) => ({ content: "# repo", sha: "sha0" }),
    moveFile: async (
      repo: string,
      _from: string,
      to: string,
      _baseSha: string,
      _msg: string,
      o?: { newContent?: string },
    ) => {
      opts.seedCapture?.push({ repo, to, content: o?.newContent ?? "" });
      return { sha: "sha1", path: to };
    },
  } as unknown as Parameters<typeof startWebServer>[0]["wikis"];
  const srv = startWebServer({
    db,
    port,
    staticDir: tmpdir(),
    sessionKey: SESSION_KEY,
    sendToAgent: () => {},
    wikis: fakeWikis,
    userRepoNames: (uid) => listReposForUser(db, uid, { includeArchived: true }).map((r) => r.name),
    // En tests no hay gateway; simulamos el log de requestSessionReset(client=undefined) para
    // que los tests que verifican [session-reset] funcionen sin canal remoto real.
    resetSessions: (userIds) =>
      logs.push(
        `[session-reset] gateway no conectado — reset diferido para users [${userIds.join(", ")}] (se aplicará en la próxima sesión)`,
      ),
    log: (s) => logs.push(s),
  });
  return { srv, b: `http://127.0.0.1:${port}`, logs };
}

/** Login para un userId dado. Asume que el db ya tiene el usuario. */
async function loginAs(b: string, db: ReturnType<typeof openDb>, uid: number): Promise<string> {
  const token = createWebLoginToken(db, uid);
  const res = await fetch(`${b}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: b },
    body: JSON.stringify({ t: token }),
  });
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("ceibo_session="));
  return (setCookie as string).split(";")[0] as string;
}

// POST /api/wiki — crear wiki nueva
describe("web-server F2: POST /api/wiki — crear wiki", () => {
  it("happy path: crea el repo en wikis y lo registra en el store como owner", async () => {
    const seedCapture: { repo: string; to: string; content: string }[] = [];
    const { srv, b } = await startWikiServer(db, { seedCapture });
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ label: "trabajo" }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { repo: string };
      expect(body.repo).toBe("alice-trabajo");
      // Store: repo creado con role owner
      const repo = getRepoByName(db, "ceibofamily", "alice-trabajo");
      expect(repo).toBeDefined();
      expect(roleOf(db, repo?.id ?? 0, userId)).toBe("owner");
      // El README pelado se convirtió en la nota Bienvenida.md (normal, editable después).
      expect(seedCapture).toHaveLength(1);
      expect(seedCapture[0]?.repo).toBe("alice-trabajo");
      expect(seedCapture[0]?.to).toBe("Bienvenida.md");
      expect(seedCapture[0]?.content).toContain("Hola, soy Ceibo");
    } finally {
      srv.close();
    }
  });

  it("slug inválido (mayúsculas/espacios) → 400", async () => {
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ label: "Mi Trabajo" }),
      });
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("invalid-label");
    } finally {
      srv.close();
    }
  });

  it("sin cookie → 401", async () => {
    const { srv, b } = await startWikiServer(db);
    try {
      const r = await fetch(`${b}/api/wiki`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b },
        body: JSON.stringify({ label: "trabajo" }),
      });
      expect(r.status).toBe(401);
    } finally {
      srv.close();
    }
  });

  it("sin wikis configurado → 503", async () => {
    const port = await freePort();
    const srv = startWebServer({
      db,
      port,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      log: () => {},
    });
    const b = `http://127.0.0.1:${port}`;
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ label: "trabajo" }),
      });
      expect(r.status).toBe(503);
    } finally {
      srv.close();
    }
  });

  it("ya existe → 422", async () => {
    const { srv, b } = await startWikiServer(db, {
      createRepo: async () => {
        throw new Error("422: already exists");
      },
    });
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ label: "trabajo" }),
      });
      expect(r.status).toBe(422);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("already-exists");
    } finally {
      srv.close();
    }
  });

  it("NO llama requestSessionReset (crear es aditivo)", async () => {
    const logs: string[] = [];
    const { srv, b } = await startWikiServer(db, { logCapture: logs });
    try {
      const cookie = await loginAs(b, db, userId);
      await fetch(`${b}/api/wiki`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ label: "trabajo" }),
      });
      expect(logs.some((l) => l.includes("[session-reset]"))).toBe(false);
    } finally {
      srv.close();
    }
  });
});

// POST /api/wiki/invite — invitar usuario existente
describe("web-server F2: POST /api/wiki/invite — invitar miembro", () => {
  let bobId: number;
  let repoId: number;

  beforeEach(() => {
    bobId = addUser(db, "bob").id;
    const repo = addRepo(db, "ceibofamily", "alice-trabajo", "trabajo");
    repoId = repo.id;
    grantAccess(db, repoId, userId, "owner");
  });

  it("happy path: owner invita a usuario existente activo", async () => {
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", handle: "bob" }),
      });
      expect(r.status).toBe(200);
      expect(roleOf(db, repoId, bobId)).toBe("member");
    } finally {
      srv.close();
    }
  });

  it("miembro (no owner) intenta invitar → 403 owner-only", async () => {
    const carolId = addUser(db, "carol").id;
    grantAccess(db, repoId, carolId, "member");
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, carolId);
      const r = await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", handle: "bob" }),
      });
      expect(r.status).toBe(403);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("owner-only");
    } finally {
      srv.close();
    }
  });

  it("handle desconocido → 404 user-not-found", async () => {
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", handle: "nadie" }),
      });
      expect(r.status).toBe(404);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("user-not-found");
    } finally {
      srv.close();
    }
  });

  it("NO llama requestSessionReset (invitar es aditivo)", async () => {
    const logs: string[] = [];
    const { srv, b } = await startWikiServer(db, { logCapture: logs });
    try {
      const cookie = await loginAs(b, db, userId);
      await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", handle: "bob" }),
      });
      expect(logs.some((l) => l.includes("[session-reset]"))).toBe(false);
    } finally {
      srv.close();
    }
  });
});

// DELETE /api/wiki/member — quitar miembro
describe("web-server F2: DELETE /api/wiki/member — quitar miembro", () => {
  let bobId: number;
  let repoId: number;

  beforeEach(() => {
    bobId = addUser(db, "bob").id;
    const repo = addRepo(db, "ceibofamily", "alice-trabajo", "trabajo");
    repoId = repo.id;
    grantAccess(db, repoId, userId, "owner");
    grantAccess(db, repoId, bobId, "member");
  });

  it("happy path: owner quita a bob", async () => {
    const logs: string[] = [];
    const { srv, b } = await startWikiServer(db, { logCapture: logs });
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki/member`, {
        method: "DELETE",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", handle: "bob" }),
      });
      expect(r.status).toBe(200);
      expect(roleOf(db, repoId, bobId)).toBeUndefined();
      // Reset de sesión del removido (F3 shim)
      expect(logs.some((l) => l.includes("[session-reset]") && l.includes(String(bobId)))).toBe(true);
    } finally {
      srv.close();
    }
  });

  it("no-owner (bob) intenta quitar a carol → 403 owner-only", async () => {
    const carolId = addUser(db, "carol").id;
    grantAccess(db, repoId, carolId, "member");
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, bobId);
      const r = await fetch(`${b}/api/wiki/member`, {
        method: "DELETE",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", handle: "carol" }),
      });
      expect(r.status).toBe(403);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("owner-only");
    } finally {
      srv.close();
    }
  });

  it("owner intenta quitarse a sí mismo → 403 cannot-remove-self", async () => {
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki/member`, {
        method: "DELETE",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", handle: "alice" }),
      });
      expect(r.status).toBe(403);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("cannot-remove-self");
    } finally {
      srv.close();
    }
  });
});

// POST /api/wiki/archive — archivar para sí
describe("web-server F2: POST /api/wiki/archive — archivar wiki", () => {
  let bobId: number;
  let repoId: number;

  beforeEach(() => {
    bobId = addUser(db, "bob").id;
    const repo = addRepo(db, "ceibofamily", "alice-trabajo", "trabajo");
    repoId = repo.id;
    grantAccess(db, repoId, userId, "owner");
    grantAccess(db, repoId, bobId, "member");
  });

  it("happy path: alice archiva la wiki compartida — desaparece de SU explorer pero no del de bob", async () => {
    const fakeWikis = {
      org: "ceibofamily",
      listFiles: async () => [],
    } as unknown as Parameters<typeof startWebServer>[0]["wikis"];
    const port = await freePort();
    const logs: string[] = [];
    const srv = startWebServer({
      db,
      port,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      wikis: fakeWikis,
      userRepoNames: (uid) => listReposForUser(db, uid, { includeArchived: true }).map((r) => r.name),
      resetSessions: (userIds) =>
        logs.push(
          `[session-reset] gateway no conectado — reset diferido para users [${userIds.join(", ")}] (se aplicará en la próxima sesión)`,
        ),
      log: (s) => logs.push(s),
    });
    const b = `http://127.0.0.1:${port}`;
    try {
      const cookieAlice = await loginAs(b, db, userId);
      const cookieBob = await loginAs(b, db, bobId);
      // Alice archiva
      const r = await fetch(`${b}/api/wiki/archive`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie: cookieAlice },
        body: JSON.stringify({ repo: "alice-trabajo" }),
      });
      expect(r.status).toBe(200);
      // Reset de sesión propio
      expect(logs.some((l) => l.includes("[session-reset]") && l.includes(String(userId)))).toBe(true);
      // Explorer de alice NO debe incluir la wiki archivada
      const expAlice = await fetch(`${b}/api/explorer`, { headers: { cookie: cookieAlice } });
      const bodyAlice = (await expAlice.json()) as { wikis: { repo: string }[] };
      expect(bodyAlice.wikis.some((w) => w.repo === "alice-trabajo")).toBe(false);
      // Explorer de bob SÍ la sigue viendo (él no archivó)
      const expBob = await fetch(`${b}/api/explorer`, { headers: { cookie: cookieBob } });
      const bodyBob = (await expBob.json()) as { wikis: { repo: string }[] };
      expect(bodyBob.wikis.some((w) => w.repo === "alice-trabajo")).toBe(true);
    } finally {
      srv.close();
    }
  });

  it("archivar wiki personal → 403 personal-not-archivable", async () => {
    const repo = addRepo(db, "ceibofamily", "alice-personal", "personal");
    db.prepare("UPDATE repos SET personal = 1 WHERE id = ?").run(repo.id);
    grantAccess(db, repo.id, userId, "owner");
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki/archive`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-personal" }),
      });
      expect(r.status).toBe(403);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("personal-not-archivable");
    } finally {
      srv.close();
    }
  });
});

// POST /api/wiki/unarchive — desarchivar
describe("web-server F2: POST /api/wiki/unarchive — desarchivar wiki", () => {
  it("happy path: desarchivar devuelve la wiki al explorer; NO resetea sesión", async () => {
    const repo = addRepo(db, "ceibofamily", "alice-trabajo", "trabajo");
    grantAccess(db, repo.id, userId, "owner");
    archiveForUser(db, repo.id, userId); // pre-archivada
    const logs: string[] = [];
    const { srv, b } = await startWikiServer(db, { logCapture: logs });
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki/unarchive`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo" }),
      });
      expect(r.status).toBe(200);
      // NO reset (aditivo)
      expect(logs.some((l) => l.includes("[session-reset]"))).toBe(false);
      // La wiki vuelve al listado sin archivadas
      const repos = listReposForUser(db, userId);
      expect(repos.some((r) => r.name === "alice-trabajo")).toBe(true);
    } finally {
      srv.close();
    }
  });
});

// DELETE /api/wiki/leave — irse de una wiki compartida
describe("web-server F2: DELETE /api/wiki/leave — salir de wiki", () => {
  let bobId: number;
  let repoId: number;

  beforeEach(() => {
    bobId = addUser(db, "bob").id;
    const repo = addRepo(db, "ceibofamily", "alice-trabajo", "trabajo");
    repoId = repo.id;
    grantAccess(db, repoId, userId, "owner");
    grantAccess(db, repoId, bobId, "member");
  });

  it("happy path: bob (miembro) se va; llama requestSessionReset con su id", async () => {
    const logs: string[] = [];
    const { srv, b } = await startWikiServer(db, { logCapture: logs });
    try {
      const cookie = await loginAs(b, db, bobId);
      const r = await fetch(`${b}/api/wiki/leave`, {
        method: "DELETE",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo" }),
      });
      expect(r.status).toBe(200);
      expect(roleOf(db, repoId, bobId)).toBeUndefined();
      // Reset de sesión propio del que se va
      expect(logs.some((l) => l.includes("[session-reset]") && l.includes(String(bobId)))).toBe(true);
    } finally {
      srv.close();
    }
  });

  it("owner intenta irse → 403 owner-cannot-leave", async () => {
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki/leave`, {
        method: "DELETE",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo" }),
      });
      expect(r.status).toBe(403);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("owner-cannot-leave");
    } finally {
      srv.close();
    }
  });
});

// DELETE /api/wiki — borrar wiki (soft-delete)
describe("web-server F2: DELETE /api/wiki — borrar wiki", () => {
  let bobId: number;
  let repoId: number;

  beforeEach(() => {
    bobId = addUser(db, "bob").id;
    const repo = addRepo(db, "ceibofamily", "alice-trabajo", "trabajo");
    repoId = repo.id;
    grantAccess(db, repoId, userId, "owner");
    grantAccess(db, repoId, bobId, "member");
  });

  it("happy path: owner borra con confirmName correcto; resetea sesión de todos los miembros", async () => {
    const logs: string[] = [];
    const { srv, b } = await startWikiServer(db, { logCapture: logs });
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki`, {
        method: "DELETE",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", confirmName: "trabajo" }),
      });
      expect(r.status).toBe(200);
      // Wiki soft-borrada
      const repo = getRepoByName(db, "ceibofamily", "alice-trabajo");
      expect(repo?.deleted_at).not.toBeNull();
      // Reset de sesión de todos los miembros (alice + bob)
      const resetLog = logs.find((l) => l.includes("[session-reset]"));
      expect(resetLog).toBeDefined();
      expect(resetLog).toContain(String(userId));
      expect(resetLog).toContain(String(bobId));
    } finally {
      srv.close();
    }
  });

  it("no-owner (bob) intenta borrar → 403 owner-only", async () => {
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, bobId);
      const r = await fetch(`${b}/api/wiki`, {
        method: "DELETE",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", confirmName: "trabajo" }),
      });
      expect(r.status).toBe(403);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("owner-only");
    } finally {
      srv.close();
    }
  });

  it("borrar wiki personal → 403 personal-not-deletable", async () => {
    const personal = addRepo(db, "ceibofamily", "alice-personal", "personal");
    db.prepare("UPDATE repos SET personal = 1 WHERE id = ?").run(personal.id);
    grantAccess(db, personal.id, userId, "owner");
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki`, {
        method: "DELETE",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-personal", confirmName: "personal" }),
      });
      expect(r.status).toBe(403);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("personal-not-deletable");
    } finally {
      srv.close();
    }
  });

  it("confirmName incorrecto → 400 confirm-mismatch", async () => {
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki`, {
        method: "DELETE",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", confirmName: "nombre-equivocado" }),
      });
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("confirm-mismatch");
    } finally {
      srv.close();
    }
  });
});

// GET /api/users/directory — directorio restringido a co-miembros (P6, decisión #1)
describe("web-server P6: GET /api/users/directory — directorio restringido a co-miembros", () => {
  it("devuelve co-miembros de wikis compartidas, excluye al requester", async () => {
    const bobId = addUser(db, "bob").id;
    const repo = addRepo(db, "ceibofamily", "alice-compartida");
    grantAccess(db, repo.id, userId, "owner");
    grantAccess(db, repo.id, bobId, "member");
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/users/directory`, { headers: { cookie } });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { users: { handle: string; name: string; hasAvatar: boolean }[] };
      // Bob aparece (co-miembro), alice (el requester) no
      expect(body.users.some((u) => u.handle === "bob")).toBe(true);
      expect(body.users.some((u) => u.handle === "alice")).toBe(false);
    } finally {
      srv.close();
    }
  });

  it("usuario sin wikis compartidas → directorio vacío", async () => {
    addUser(db, "bob"); // activo pero sin wiki en común con alice
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/users/directory`, { headers: { cookie } });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { users: unknown[] };
      expect(body.users).toHaveLength(0);
    } finally {
      srv.close();
    }
  });

  it("excluye co-miembros de wikis soft-borradas", async () => {
    const bobId = addUser(db, "bob").id;
    const repo = addRepo(db, "ceibofamily", "alice-borrada");
    grantAccess(db, repo.id, userId, "owner");
    grantAccess(db, repo.id, bobId, "member");
    softDeleteRepo(db, repo.id);
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/users/directory`, { headers: { cookie } });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { users: unknown[] };
      expect(body.users).toHaveLength(0);
    } finally {
      srv.close();
    }
  });

  it("sin cookie → 401", async () => {
    const { srv, b } = await startWikiServer(db);
    try {
      const r = await fetch(`${b}/api/users/directory`);
      expect(r.status).toBe(401);
    } finally {
      srv.close();
    }
  });
});

// GET /api/explorer — verifica que devuelve role/personal/isOwner (F2 → F4 UI)
describe("web-server F2: GET /api/explorer — campos role/personal/isOwner", () => {
  it("devuelve role, personal e isOwner correctos para cada wiki", async () => {
    const bobId = addUser(db, "bob").id;
    // Wiki propia (owner, no personal)
    const trabajoRepo = addRepo(db, "ceibofamily", "alice-trabajo", "trabajo");
    grantAccess(db, trabajoRepo.id, userId, "owner");
    grantAccess(db, trabajoRepo.id, bobId, "member");
    // Wiki personal (owner, personal=1)
    const personalRepo = addRepo(db, "ceibofamily", "alice-personal", "personal");
    db.prepare("UPDATE repos SET personal = 1 WHERE id = ?").run(personalRepo.id);
    grantAccess(db, personalRepo.id, userId, "owner");
    // Wiki compartida donde alice es member
    const sharedRepo = addRepo(db, "ceibofamily", "bob-proyecto", "proyecto");
    grantAccess(db, sharedRepo.id, bobId, "owner");
    grantAccess(db, sharedRepo.id, userId, "member");

    const fakeWikis = {
      org: "ceibofamily",
      listFiles: async () => [],
    } as unknown as Parameters<typeof startWebServer>[0]["wikis"];
    const port = await freePort();
    const srv = startWebServer({
      db,
      port,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      wikis: fakeWikis,
      userRepoNames: (uid) => listReposForUser(db, uid).map((r) => r.name),
      log: () => {},
    });
    const b = `http://127.0.0.1:${port}`;
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/explorer`, { headers: { cookie } });
      expect(r.status).toBe(200);
      type WikiEntry = { repo: string; role: string; personal: boolean; isOwner: boolean };
      const body = (await r.json()) as { wikis: WikiEntry[] };
      const trabajo = body.wikis.find((w) => w.repo === "alice-trabajo");
      const personal = body.wikis.find((w) => w.repo === "alice-personal");
      const shared = body.wikis.find((w) => w.repo === "bob-proyecto");
      expect(trabajo?.role).toBe("owner");
      expect(trabajo?.personal).toBe(false);
      expect(trabajo?.isOwner).toBe(true);
      expect(personal?.role).toBe("owner");
      expect(personal?.personal).toBe(true);
      expect(personal?.isOwner).toBe(true);
      expect(shared?.role).toBe("member");
      expect(shared?.personal).toBe(false);
      expect(shared?.isOwner).toBe(false);
    } finally {
      srv.close();
    }
  });
});

// POST /api/wiki/label — gates de slug y owner-only (F2 Q8)
describe("web-server F2: POST /api/wiki/label — slug + owner-only en shared", () => {
  it("miembro (no owner) en wiki compartida no puede renombrar → 403 owner-only", async () => {
    const bobId = addUser(db, "bob").id;
    const repo = addRepo(db, "ceibofamily", "bob-proyecto", "proyecto");
    grantAccess(db, repo.id, bobId, "owner");
    grantAccess(db, repo.id, userId, "member"); // alice es member, NO owner
    const port = await freePort();
    const srv = startWebServer({
      db,
      port,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      userRepoNames: (uid) => listReposForUser(db, uid).map((r) => r.name),
      log: () => {},
    });
    const b = `http://127.0.0.1:${port}`;
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki/label`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "bob-proyecto", label: "nuevo-nombre" }),
      });
      expect(r.status).toBe(403);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("owner-only");
    } finally {
      srv.close();
    }
  });

  it("owner puede renombrar wiki compartida con slug válido", async () => {
    const bobId = addUser(db, "bob").id;
    const repo = addRepo(db, "ceibofamily", "alice-trabajo", "trabajo");
    grantAccess(db, repo.id, userId, "owner");
    grantAccess(db, repo.id, bobId, "member");
    const port = await freePort();
    const srv = startWebServer({
      db,
      port,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      userRepoNames: (uid) => listReposForUser(db, uid).map((r) => r.name),
      log: () => {},
    });
    const b = `http://127.0.0.1:${port}`;
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki/label`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", label: "proyecto2" }),
      });
      expect(r.status).toBe(200);
      expect(getRepoByName(db, "ceibofamily", "alice-trabajo")?.label).toBe("proyecto2");
    } finally {
      srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// F6: POST /api/wiki/invite {email} — invitación por email
// ---------------------------------------------------------------------------

describe("web-server F6: POST /api/wiki/invite — invitar por email (sin cuenta)", () => {
  let repoId: number;

  beforeEach(() => {
    const repo = addRepo(db, "ceibofamily", "alice-trabajo", "trabajo");
    repoId = repo.id;
    grantAccess(db, repoId, userId, "owner");
  });

  it("P2: email desconocido crea invite pendiente + manda mail; NO siembra authorized_emails", async () => {
    // Capturamos el mail de invitación (override de sendInviteEmail en el server).
    const sentInvites: { to: string; inviterName: string; wikiLabel: string; acceptUrl: string }[] = [];
    const port = await freePort();
    const fakeWikis = {
      org: "ceibofamily",
      listFiles: async () => [],
      createRepo: async (_name: string) => ({ name: _name }),
    } as unknown as Parameters<typeof startWebServer>[0]["wikis"];
    const srv = startWebServer({
      db,
      port,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      wikis: fakeWikis,
      userRepoNames: (uid) => listReposForUser(db, uid, { includeArchived: true }).map((r) => r.name),
      resetSessions: () => {},
      webPublicOrigin: `http://127.0.0.1:${port}`,
      sendInviteEmail: async (args) => {
        sentInvites.push(args);
      },
      log: () => {},
    });
    const b = `http://127.0.0.1:${port}`;
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "nueva@example.com" }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as Record<string, unknown>;
      expect(body.pending).toBe(true);
      // Invite pendiente en la DB
      const pending = listPendingInvitesForEmail(db, "nueva@example.com");
      expect(pending).toHaveLength(1);
      expect(pending[0]?.repo_id).toBe(repoId);
      expect(pending[0]?.accepted_at).toBeNull();
      // P2: authorized_emails NO se siembra (auto-whitelist eliminado)
      expect(getAuthorizedEmail(db, "nueva@example.com")).toBeUndefined();
      // P2: se mandó el mail de invitación con el token
      // (el mail es fire-and-forget; esperamos un tick para que se procese)
      await new Promise((r) => setTimeout(r, 10));
      expect(sentInvites).toHaveLength(1);
      expect(sentInvites[0]?.to).toBe("nueva@example.com");
      expect(sentInvites[0]?.acceptUrl).toContain("/invitacion?i=");
    } finally {
      srv.close();
    }
  });

  it("email ya tiene cuenta (canal email) → grant directo, sin invite pendiente", async () => {
    const bobId = addUser(db, "bob").id;
    addChannel(db, bobId, "email", "bob@example.com");
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "bob@example.com" }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as Record<string, unknown>;
      expect(body.granted).toBe(true);
      // Grant inmediato
      expect(roleOf(db, repoId, bobId)).toBe("member");
      // NO invite pendiente
      expect(listPendingInvitesForEmail(db, "bob@example.com")).toHaveLength(0);
    } finally {
      srv.close();
    }
  });

  it("email ya tiene cuenta (canal google) → grant directo", async () => {
    const carolId = addUser(db, "carol").id;
    addChannel(db, carolId, "google", "carol@gmail.com");
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "carol@gmail.com" }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as Record<string, unknown>;
      expect(body.granted).toBe(true);
      expect(roleOf(db, repoId, carolId)).toBe("member");
    } finally {
      srv.close();
    }
  });

  it("email inválido → 400 invalid-email", async () => {
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "no-es-email" }),
      });
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("invalid-email");
    } finally {
      srv.close();
    }
  });

  it("miembro (no owner) no puede invitar por email → 403 owner-only", async () => {
    const bobId = addUser(db, "bob").id;
    grantAccess(db, repoId, bobId, "member");
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, bobId);
      const r = await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "nueva@example.com" }),
      });
      expect(r.status).toBe(403);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("owner-only");
    } finally {
      srv.close();
    }
  });

  it("doble invite (repo,email) es no-op — idempotente", async () => {
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      // Primera invitación
      await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "nueva@example.com" }),
      });
      // Segunda invitación al mismo email en el mismo repo
      const r2 = await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "nueva@example.com" }),
      });
      expect(r2.status).toBe(200);
      // Sigue siendo solo un invite pendiente
      expect(listPendingInvitesForEmail(db, "nueva@example.com")).toHaveLength(1);
    } finally {
      srv.close();
    }
  });

  it("si admin ya sembró authorized_emails, el invite NO pisa el entry existente", async () => {
    // El admin lo sembró primero con datos específicos
    addAuthorizedEmail(db, "nueva@example.com", { note: "autorizada por admin", name: "Admin Name" });
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "nueva@example.com" }),
      });
      // El note original del admin se preserva (no se pisa)
      const entry = getAuthorizedEmail(db, "nueva@example.com");
      expect(entry?.note).toBe("autorizada por admin");
      expect(entry?.name).toBe("Admin Name");
    } finally {
      srv.close();
    }
  });
});

describe("web-server F6: DELETE /api/wiki/invite — revocar invitación pendiente", () => {
  let repoId: number;

  beforeEach(() => {
    const repo = addRepo(db, "ceibofamily", "alice-trabajo", "trabajo");
    repoId = repo.id;
    grantAccess(db, repoId, userId, "owner");
    addAuthorizedEmail(db, "nueva@example.com");
  });

  it("happy path: owner revoca invite pendiente — desaparece del store", async () => {
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      // Primero invitar
      await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "nueva@example.com" }),
      });
      expect(listPendingInvitesForEmail(db, "nueva@example.com")).toHaveLength(1);
      // Luego revocar
      const r = await fetch(`${b}/api/wiki/invite`, {
        method: "DELETE",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "nueva@example.com" }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { removed: boolean };
      expect(body.removed).toBe(true);
      expect(listPendingInvitesForEmail(db, "nueva@example.com")).toHaveLength(0);
      // authorized_emails NO se toca
      expect(getAuthorizedEmail(db, "nueva@example.com")).toBeDefined();
    } finally {
      srv.close();
    }
  });

  it("revocar invite inexistente → 200 removed:false (no-op)", async () => {
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      const r = await fetch(`${b}/api/wiki/invite`, {
        method: "DELETE",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "nadie@example.com" }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { removed: boolean };
      expect(body.removed).toBe(false);
    } finally {
      srv.close();
    }
  });

  it("miembro (no owner) no puede revocar → 403 owner-only", async () => {
    const bobId = addUser(db, "bob").id;
    grantAccess(db, repoId, bobId, "member");
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, bobId);
      const r = await fetch(`${b}/api/wiki/invite`, {
        method: "DELETE",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "nueva@example.com" }),
      });
      expect(r.status).toBe(403);
    } finally {
      srv.close();
    }
  });
});

describe("web-server F6: materialización al login — invite→register→grant", () => {
  let repoId: number;

  beforeEach(() => {
    const repo = addRepo(db, "ceibofamily", "alice-trabajo", "trabajo");
    repoId = repo.id;
    grantAccess(db, repoId, userId, "owner");
  });

  it("login por magic-link materializa invites pendientes — wiki aparece en listReposForUser", async () => {
    // Allowlist + invite pendiente
    addAuthorizedEmail(db, "invitada@example.com");
    const { srv, b } = await startWikiServer(db);
    try {
      // Owner invita por email
      const ownerCookie = await loginAs(b, db, userId);
      await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie: ownerCookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "invitada@example.com" }),
      });
      expect(listPendingInvitesForEmail(db, "invitada@example.com")).toHaveLength(1);

      // La persona se registra / loguea (ya está en allowlist)
      // Simular: crear usuario con identidad email (como lo haría email-start + login)
      const invitadaId = addUser(db, "invitada").id;
      addChannel(db, invitadaId, "email", "invitada@example.com");

      // Login vía magic-link → debe materializar el invite
      const token = createWebLoginToken(db, invitadaId);
      await fetch(`${b}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b },
        body: JSON.stringify({ t: token }),
      });

      // El invite fue aceptado → grant
      expect(roleOf(db, repoId, invitadaId)).toBe("member");
      // La wiki está en listReposForUser
      const repos = listReposForUser(db, invitadaId);
      expect(repos.some((r) => r.id === repoId)).toBe(true);
      // El invite quedó marcado como aceptado (ya no está pendiente)
      expect(listPendingInvitesForEmail(db, "invitada@example.com")).toHaveLength(0);
    } finally {
      srv.close();
    }
  });

  it("login por password materializa invites pendientes", async () => {
    // Escenario: el invite fue creado ANTES de que bob tuviera canal email
    // (ej. el owner lo invitó cuando bob aún no existía, luego bob se registró
    // por otro camino y quedó con una password). Creamos el invite directamente
    // en la DB para simular ese estado previo.
    const { addInvite: _addInvite, setUserPassword: _setUserPassword } = await import("@ceibo/store");

    // Bob existe pero al momento del invite no tenía canal email
    const bobId = addUser(db, "bob").id;
    // Seed del invite pendiente (simula el estado "invitado antes de registrarse")
    _addInvite(db, repoId, "bob@example.com", userId);
    expect(listPendingInvitesForEmail(db, "bob@example.com")).toHaveLength(1);

    // Ahora bob se registra (tiene canal email y password)
    addChannel(db, bobId, "email", "bob@example.com");
    _setUserPassword(db, bobId, "secreto123");

    const { srv, b } = await startWikiServer(db);
    try {
      // Bob loguea por password → debe materializar el invite
      const r = await fetch(`${b}/api/login/password`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b },
        body: JSON.stringify({ email: "bob@example.com", password: "secreto123" }),
      });
      expect(r.status).toBe(200);

      // Grant materializado
      expect(roleOf(db, repoId, bobId)).toBe("member");
      expect(listPendingInvitesForEmail(db, "bob@example.com")).toHaveLength(0);
    } finally {
      srv.close();
    }
  });

  it("re-login no duplica grants (idempotencia)", async () => {
    const bobId = addUser(db, "bob").id;
    addChannel(db, bobId, "email", "bob@example.com");
    addAuthorizedEmail(db, "bob@example.com");

    const { srv, b } = await startWikiServer(db);
    try {
      // Owner invita
      const ownerCookie = await loginAs(b, db, userId);
      await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie: ownerCookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "bob@example.com" }),
      });

      // Primer login de bob
      const token1 = createWebLoginToken(db, bobId);
      await fetch(`${b}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b },
        body: JSON.stringify({ t: token1 }),
      });
      expect(roleOf(db, repoId, bobId)).toBe("member");

      // Segundo login — no debe duplicar ni romper
      const token2 = createWebLoginToken(db, bobId);
      const r2 = await fetch(`${b}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b },
        body: JSON.stringify({ t: token2 }),
      });
      expect(r2.status).toBe(200);
      // Sigue siendo member (no duplica acceso ni falla)
      expect(roleOf(db, repoId, bobId)).toBe("member");
      // No hay invites pendientes nuevos
      expect(listPendingInvitesForEmail(db, "bob@example.com")).toHaveLength(0);
    } finally {
      srv.close();
    }
  });
});

describe("web-server F6: /api/explorer incluye pendingInvites para el owner", () => {
  let repoId: number;

  beforeEach(() => {
    const repo = addRepo(db, "ceibofamily", "alice-trabajo", "trabajo");
    repoId = repo.id;
    grantAccess(db, repoId, userId, "owner");
  });

  it("owner ve pendingInvites en la wiki con invites activos", async () => {
    addAuthorizedEmail(db, "pendiente@example.com");
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      // Crear invite
      await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "pendiente@example.com" }),
      });
      // Explorer debe incluir el invite
      const r = await fetch(`${b}/api/explorer`, { headers: { cookie } });
      expect(r.status).toBe(200);
      const data = (await r.json()) as {
        wikis: Array<{ repo: string; pendingInvites: Array<{ email: string }> }>;
      };
      const wiki = data.wikis.find((w) => w.repo === "alice-trabajo");
      expect(wiki).toBeDefined();
      expect(wiki?.pendingInvites).toHaveLength(1);
      expect(wiki?.pendingInvites[0]?.email).toBe("pendiente@example.com");
    } finally {
      srv.close();
    }
  });

  it("miembro (no owner) ve pendingInvites vacío aunque haya invites", async () => {
    addAuthorizedEmail(db, "pendiente@example.com");
    const bobId = addUser(db, "bob").id;
    grantAccess(db, repoId, bobId, "member");
    const { srv, b } = await startWikiServer(db);
    try {
      // Owner crea el invite
      const ownerCookie = await loginAs(b, db, userId);
      await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie: ownerCookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "pendiente@example.com" }),
      });
      // Bob (member) consulta el explorer
      const bobCookie = await loginAs(b, db, bobId);
      const r = await fetch(`${b}/api/explorer`, { headers: { cookie: bobCookie } });
      expect(r.status).toBe(200);
      const data = (await r.json()) as {
        wikis: Array<{ repo: string; pendingInvites: Array<{ email: string }> }>;
      };
      const wiki = data.wikis.find((w) => w.repo === "alice-trabajo");
      expect(wiki?.pendingInvites).toHaveLength(0);
    } finally {
      srv.close();
    }
  });

  it("after revocar invite, ya no aparece en pendingInvites del explorer", async () => {
    addAuthorizedEmail(db, "pendiente@example.com");
    const { srv, b } = await startWikiServer(db);
    try {
      const cookie = await loginAs(b, db, userId);
      await fetch(`${b}/api/wiki/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "pendiente@example.com" }),
      });
      await fetch(`${b}/api/wiki/invite`, {
        method: "DELETE",
        headers: { "content-type": "application/json", origin: b, cookie },
        body: JSON.stringify({ repo: "alice-trabajo", email: "pendiente@example.com" }),
      });
      const r = await fetch(`${b}/api/explorer`, { headers: { cookie } });
      const data = (await r.json()) as {
        wikis: Array<{ repo: string; pendingInvites: Array<{ email: string }> }>;
      };
      const wiki = data.wikis.find((w) => w.repo === "alice-trabajo");
      expect(wiki?.pendingInvites).toHaveLength(0);
    } finally {
      srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// P2: GET /api/invite + POST /api/invite/accept — flujo de aceptación
// ---------------------------------------------------------------------------

/** Levanta un server con sendInviteEmail interceptado. */
async function startInviteServer(
  db: ReturnType<typeof openDb>,
  opts: {
    sentInvites?: { to: string; inviterName: string; wikiLabel: string; acceptUrl: string }[];
  } = {},
): Promise<{ srv: WebServer; b: string }> {
  const port = await freePort();
  const fakeWikis = {
    org: "ceibofamily",
    listFiles: async () => [],
    createRepo: async (_name: string) => ({ name: _name }),
  } as unknown as Parameters<typeof startWebServer>[0]["wikis"];
  const srv = startWebServer({
    db,
    port,
    staticDir: tmpdir(),
    sessionKey: SESSION_KEY,
    sendToAgent: () => {},
    wikis: fakeWikis,
    userRepoNames: (uid) => listReposForUser(db, uid, { includeArchived: true }).map((r) => r.name),
    resetSessions: () => {},
    webPublicOrigin: `http://127.0.0.1:${port}`,
    sendInviteEmail: async (args) => {
      opts.sentInvites?.push(args);
    },
    log: () => {},
  });
  return { srv, b: `http://127.0.0.1:${port}` };
}

describe("web-server P2: GET /api/invite — info de la invitación (sin sesión)", () => {
  let repoId: number;
  let inviteToken: string;

  beforeEach(() => {
    const repo = addRepo(db, "ceibofamily", "alice-trabajo", "trabajo");
    repoId = repo.id;
    grantAccess(db, repoId, userId, "owner");
    addInvite(db, repoId, "invitado@example.com", userId);
    const row = db
      .prepare("SELECT accept_token FROM wiki_invites WHERE repo_id = ? AND email = ?")
      .get(repoId, "invitado@example.com") as { accept_token: string } | undefined;
    inviteToken = row?.accept_token ?? "";
  });

  it("token válido → state=valid + inviter + wikiLabel", async () => {
    const { srv, b } = await startInviteServer(db);
    try {
      const r = await fetch(`${b}/api/invite?i=${inviteToken}`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { state: string; inviter: string; wikiLabel: string };
      expect(body.state).toBe("valid");
      expect(body.inviter).toBe("alice");
      expect(body.wikiLabel).toBe("trabajo");
    } finally {
      srv.close();
    }
  });

  it("token inválido / revocado → state=invalid", async () => {
    const { srv, b } = await startInviteServer(db);
    try {
      const r = await fetch(`${b}/api/invite?i=tokeninexistente`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { state: string };
      expect(body.state).toBe("invalid");
    } finally {
      srv.close();
    }
  });

  it("GET no tiene side-effects (no crea waiting_list)", async () => {
    const { srv, b } = await startInviteServer(db);
    try {
      await fetch(`${b}/api/invite?i=${inviteToken}`);
      expect(getWaitingEntry(db, "invitado@example.com")).toBeUndefined();
    } finally {
      srv.close();
    }
  });

  it("email ya autorizado → state=ready", async () => {
    addAuthorizedEmail(db, "invitado@example.com");
    const { srv, b } = await startInviteServer(db);
    try {
      const r = await fetch(`${b}/api/invite?i=${inviteToken}`);
      const body = (await r.json()) as { state: string };
      expect(body.state).toBe("ready");
    } finally {
      srv.close();
    }
  });
});

describe("web-server P2: POST /api/invite/accept — aceptar invitación", () => {
  let repoId: number;
  let inviteToken: string;

  beforeEach(() => {
    const repo = addRepo(db, "ceibofamily", "alice-trabajo", "trabajo");
    repoId = repo.id;
    grantAccess(db, repoId, userId, "owner");
    addInvite(db, repoId, "invitado@example.com", userId);
    const row = db
      .prepare("SELECT accept_token FROM wiki_invites WHERE repo_id = ? AND email = ?")
      .get(repoId, "invitado@example.com") as { accept_token: string } | undefined;
    inviteToken = row?.accept_token ?? "";
  });

  it("token válido, email sin cuenta → waiting_list source=invited", async () => {
    const { srv, b } = await startInviteServer(db);
    try {
      const r = await fetch(`${b}/api/invite/accept`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b },
        body: JSON.stringify({ token: inviteToken }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { state: string };
      expect(body.state).toBe("waitlisted");
      const entry = getWaitingEntry(db, "invitado@example.com");
      expect(entry).toBeDefined();
      expect(entry?.source).toBe("invited");
      expect(entry?.status).toBe("pending");
    } finally {
      srv.close();
    }
  });

  it("token inválido → state=invalid", async () => {
    const { srv, b } = await startInviteServer(db);
    try {
      const r = await fetch(`${b}/api/invite/accept`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b },
        body: JSON.stringify({ token: "tokeninexistente" }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { state: string };
      expect(body.state).toBe("invalid");
    } finally {
      srv.close();
    }
  });

  it("idempotente: doble accept → already-waitlisted", async () => {
    addToWaitingList(db, "invitado@example.com", { source: "invited", invitedBy: userId });
    const { srv, b } = await startInviteServer(db);
    try {
      const r = await fetch(`${b}/api/invite/accept`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b },
        body: JSON.stringify({ token: inviteToken }),
      });
      const body = (await r.json()) as { state: string };
      expect(body.state).toBe("already-waitlisted");
    } finally {
      srv.close();
    }
  });

  it("email ya autorizado → ready (sin pasar por waitlist)", async () => {
    addAuthorizedEmail(db, "invitado@example.com");
    const { srv, b } = await startInviteServer(db);
    try {
      const r = await fetch(`${b}/api/invite/accept`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: b },
        body: JSON.stringify({ token: inviteToken }),
      });
      const body = (await r.json()) as { state: string };
      expect(body.state).toBe("ready");
      // No crea fila en waitlist
      expect(getWaitingEntry(db, "invitado@example.com")).toBeUndefined();
    } finally {
      srv.close();
    }
  });

  it("bad origin → 403", async () => {
    const { srv, b } = await startInviteServer(db);
    try {
      const r = await fetch(`${b}/api/invite/accept`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example.com" },
        body: JSON.stringify({ token: inviteToken }),
      });
      expect(r.status).toBe(403);
    } finally {
      srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Mover documentos ENTRE wikis (drag cross-wiki): POST /api/file/move con fromRepo/toRepo
// ---------------------------------------------------------------------------
// El server compone getFile(A)→createFile(B)→deleteFile(A) (sin atomicidad: dos repos git).
// Fakeamos wikis para observar el ORDEN de las llamadas y forzar fallos a mitad.
describe("web-server: POST /api/file/move cross-wiki", () => {
  let dbX: Db;
  let srvX: WebServer;
  let bX: string;
  let aliceX: number;
  // Registro de llamadas observadas para asertar orden/efectos. Cada wiki es un Map path→{content,sha}.
  let calls: string[];
  let stores: Map<string, Map<string, { content: string; sha: string }>>;
  // Inyectables por test para forzar fallos puntuales sin reescribir todo el fake.
  let failCreate: { exists?: boolean; boom?: boolean } | null;
  let failDelete: { conflict?: boolean; boom?: boolean } | null;

  beforeEach(async () => {
    dbX = openDb(":memory:");
    aliceX = addUser(dbX, "alice").id;
    // Dos wikis a las que alice tiene acceso activo + una AJENA (sin grant) para el test de permisos.
    grantAccess(dbX, addRepo(dbX, "ceibofamily", "alice-a", "Wiki A").id, aliceX);
    grantAccess(dbX, addRepo(dbX, "ceibofamily", "alice-b", "Wiki B").id, aliceX);
    addRepo(dbX, "ceibofamily", "ajena", "Ajena"); // sin grant a alice

    calls = [];
    stores = new Map([
      ["alice-a", new Map([["nota.md", { content: "# Nota\ncuerpo", sha: "sha-a-1" }]])],
      ["alice-b", new Map()],
      ["ajena", new Map()],
    ]);
    failCreate = null;
    failDelete = null;

    const fakeWikis = {
      org: "ceibofamily",
      listFiles: async (repo: string) => [...(stores.get(repo)?.keys() ?? [])],
      headSha: async () => "head-sha",
      getFile: async (repo: string, path: string) => {
        calls.push(`getFile:${repo}/${path}`);
        const f = stores.get(repo)?.get(path);
        if (!f) throw new Error(`no existe ${repo}/${path}`);
        return { content: f.content, sha: f.sha, path };
      },
      createFile: async (repo: string, path: string, content: string) => {
        calls.push(`createFile:${repo}/${path}`);
        if (failCreate?.exists) throw Object.assign(new Error("ya existe"), { exists: true });
        if (failCreate?.boom) throw new Error("boom create");
        if (stores.get(repo)?.has(path)) throw Object.assign(new Error("ya existe"), { exists: true });
        const sha = `sha-${repo}-${path}`;
        stores.get(repo)?.set(path, { content, sha });
        return { sha, path };
      },
      deleteFile: async (repo: string, path: string) => {
        calls.push(`deleteFile:${repo}/${path}`);
        if (failDelete?.conflict) throw Object.assign(new Error("conflicto"), { conflict: true });
        if (failDelete?.boom) throw new Error("boom delete");
        stores.get(repo)?.delete(path);
      },
    } as unknown as Parameters<typeof startWebServer>[0]["wikis"];

    const port = await freePort();
    bX = `http://127.0.0.1:${port}`;
    srvX = startWebServer({
      db: dbX,
      port,
      staticDir: tmpdir(),
      sessionKey: SESSION_KEY,
      sendToAgent: () => {},
      wikis: fakeWikis,
      userRepoNames: (uid) => listReposForUser(dbX, uid).map((r) => r.name),
      log: () => {},
    });
  });

  afterEach(() => {
    srvX.close();
    dbX.close();
  });

  const move = (cookie: string, body: Record<string, unknown>) =>
    fetch(`${bX}/api/file/move`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: bX, cookie },
      body: JSON.stringify(body),
    });

  it("happy path: getFile(A) → createFile(B) → deleteFile(A) en ese orden; nota migra", async () => {
    const cookie = await loginAs(bX, dbX, aliceX);
    const r = await move(cookie, {
      fromRepo: "alice-a",
      toRepo: "alice-b",
      fromPath: "nota.md",
      toPath: "nota.md",
      baseSha: "sha-a-1",
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ path: "nota.md" });
    // Orden exacto: leer origen, crear destino, recién después borrar origen.
    expect(calls).toEqual([
      "getFile:alice-a/nota.md",
      "createFile:alice-b/nota.md",
      "deleteFile:alice-a/nota.md",
    ]);
    // La nota está en B y ya NO en A.
    expect(stores.get("alice-b")?.has("nota.md")).toBe(true);
    expect(stores.get("alice-a")?.has("nota.md")).toBe(false);
  });

  it("baseSha desactualizado → 409 conflict, sin crear nada en el destino (no toca A)", async () => {
    const cookie = await loginAs(bX, dbX, aliceX);
    const r = await move(cookie, {
      fromRepo: "alice-a",
      toRepo: "alice-b",
      fromPath: "nota.md",
      toPath: "nota.md",
      baseSha: "sha-VIEJA",
    });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "conflict" });
    // Sólo se leyó el origen; no se creó ni borró nada.
    expect(calls).toEqual(["getFile:alice-a/nota.md"]);
    expect(stores.get("alice-a")?.has("nota.md")).toBe(true);
    expect(stores.get("alice-b")?.has("nota.md")).toBe(false);
  });

  it("destino ocupado → 409 exists, origen intacto (cero pérdida)", async () => {
    stores.get("alice-b")?.set("nota.md", { content: "ya hay algo", sha: "sha-b-x" });
    const cookie = await loginAs(bX, dbX, aliceX);
    const r = await move(cookie, {
      fromRepo: "alice-a",
      toRepo: "alice-b",
      fromPath: "nota.md",
      toPath: "nota.md",
      baseSha: "sha-a-1",
    });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "exists" });
    expect(calls).toEqual(["getFile:alice-a/nota.md", "createFile:alice-b/nota.md"]);
    // El origen sigue vivo: no se borró porque el create falló antes del delete.
    expect(stores.get("alice-a")?.has("nota.md")).toBe(true);
  });

  it("fallo a mitad (delete del origen falla DESPUÉS de crear destino) → 200 warning, queda duplicado", async () => {
    failDelete = { boom: true };
    const cookie = await loginAs(bX, dbX, aliceX);
    const r = await move(cookie, {
      fromRepo: "alice-a",
      toRepo: "alice-b",
      fromPath: "nota.md",
      toPath: "nota.md",
      baseSha: "sha-a-1",
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ warning: "source-not-deleted", path: "nota.md" });
    // El destino SÍ se creó; el origen quedó (duplicado, mejor que perdido).
    expect(stores.get("alice-b")?.has("nota.md")).toBe(true);
    expect(stores.get("alice-a")?.has("nota.md")).toBe(true);
  });

  it("sin acceso a la wiki DESTINO → 400 bad-request, no toca nada", async () => {
    const cookie = await loginAs(bX, dbX, aliceX);
    const r = await move(cookie, {
      fromRepo: "alice-a",
      toRepo: "ajena", // alice no tiene grant
      fromPath: "nota.md",
      toPath: "nota.md",
      baseSha: "sha-a-1",
    });
    expect(r.status).toBe(400);
    expect(calls).toEqual([]); // ni siquiera leyó el origen
  });

  it("sin acceso a la wiki ORIGEN → 400 bad-request", async () => {
    const cookie = await loginAs(bX, dbX, aliceX);
    const r = await move(cookie, {
      fromRepo: "ajena",
      toRepo: "alice-b",
      fromPath: "nota.md",
      toPath: "nota.md",
      baseSha: "sha-a-1",
    });
    expect(r.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("sin cookie → 401", async () => {
    const r = await fetch(`${bX}/api/file/move`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: bX },
      body: JSON.stringify({
        fromRepo: "alice-a",
        toRepo: "alice-b",
        fromPath: "nota.md",
        toPath: "nota.md",
        baseSha: "sha-a-1",
      }),
    });
    expect(r.status).toBe(401);
  });

  it("fromRepo === toRepo (mismo repo) NO usa la rama cross", async () => {
    // Con fromRepo===toRepo el endpoint delega en moveFile (intra-wiki). Nuestro fake no implementa
    // moveFile → tira y da 500, pero lo importante es que NO pasó por la composición cross.
    const cookie = await loginAs(bX, dbX, aliceX);
    const r = await move(cookie, {
      fromRepo: "alice-a",
      toRepo: "alice-a",
      fromPath: "nota.md",
      toPath: "sub/nota.md",
      baseSha: "sha-a-1",
    });
    expect(r.status).toBe(500); // moveFile no está en el fake
    expect(calls).toEqual([]); // la composición cross (getFile/createFile/deleteFile) NO corrió
  });
});
