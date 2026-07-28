// Harness de validación EN BROWSER REAL de la Fase C (buffer de frames + replay al
// reconectar). Levanta el web-server REAL (con el FrameBuffer de verdad) detrás de un
// proxy "congelable" que simula la conexión half-open (mismo truco que la validación de
// la Fase A): los bytes del SSE se DESCARTAN sin cerrar la conexión → cero `onerror`,
// igual que un sleep/cambio de red. Vite dev (:5173) proxypasea /api → :8820 (este proxy).
//
//   pnpm exec tsx packages/web-server/harness/replay-harness.ts   # :8820 (proxy) + :8831 (server real)
//   pnpm --filter @ceibo/web dev                                  # :5173
//   abrir http://localhost:5173/?debug=1&t=<token de /debug/token>
//
// Agente fake: cada POST /api/send se responde a los RESPOND_DELAY_MS con un eco
// `{t:"text"}` + `{t:"turn-done"}` via pushToUser(origin) — la ventana para "cortar" el
// SSE antes de que llegue la respuesta.
//
// Debug (en el proxy):
//   GET  /debug/token         → URL de login magic-link fresca para el browser
//   POST /debug/zombify       → streams SSE vivos pasan a half-open: bytes al void, sin FIN
//                               (conexiones NUEVAS sí pasan: la "red volvió" pero el socket
//                               viejo está muerto — el caso exacto del watchdog)
//   POST /debug/kill-streams  → destruye abrupto los streams vivos (fuerza el reconnect
//                               NATIVO del EventSource → header Last-Event-ID)
//   POST /debug/rewind {"to":N} → one-shot: al próximo /api/stream le pisa el watermark
//                               (header + ?since=) con N — fuerza un replay de frames YA
//                               vistos para validar el dedup del cliente
//   POST /debug/burst {"n":N} → pushea N broadcasts {t:"refresh"} (con el buffer chico del
//                               harness, N > cap → gap → resync al reconectar)
//
// Buffer del server achicado (maxFrames 8) para poder provocar el gap sin 100 frames.

import { createServer, type IncomingMessage, request, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { addUser, createWebLoginToken, openDb } from "@ceibo/store";
import { startWebServer } from "../src/web.ts";

const PROXY_PORT = 8820; // donde apunta el proxy /api de vite dev
const SERVER_PORT = 8831; // web-server real
const RESPOND_DELAY_MS = 2500;

const db = openDb(":memory:");
const user = addUser(db, "demo");

const server = startWebServer({
  db,
  port: SERVER_PORT,
  staticDir: tmpdir(), // la SPA la sirve vite dev; acá solo /api
  sessionKey: "harness-session-key",
  frameBuffer: { maxFrames: 8 }, // chico a propósito: el caso "gap > buffer" es provocable
  sendToAgent: (u, text, _audio, _facts, _media, origin) => {
    console.log(
      `[agente fake] turno de ${u.handle} (origin=${origin?.slice(0, 8)}): ${JSON.stringify(text)}`,
    );
    server.pushToUser(u.id, { t: "typing" }, origin);
    setTimeout(() => {
      server.pushToUser(u.id, { t: "text", text: `eco del harness: ${text}` }, origin);
      server.pushToUser(u.id, { t: "turn-done" }, origin);
      console.log("[agente fake] respuesta emitida (¿había alguien escuchando?)");
    }, RESPOND_DELAY_MS);
  },
  log: (s) => console.log(`[web-server] ${s}`),
});

// --- Proxy congelable ---------------------------------------------------------------

type Live = { clientRes: ServerResponse; upstream: IncomingMessage; zombie: boolean };
const liveStreams = new Set<Live>();
let rewindTo: number | undefined; // one-shot

const json = (res: ServerResponse, code: number, body: unknown) =>
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));

const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve({});
      }
    });
  });

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PROXY_PORT}`);

  // --- endpoints de debug ---
  if (url.pathname === "/debug/token") {
    const t = createWebLoginToken(db, user.id);
    return json(res, 200, { url: `http://localhost:5173/?debug=1&t=${t}` });
  }
  if (url.pathname === "/debug/zombify") {
    let n = 0;
    for (const s of liveStreams) {
      if (!s.zombie) {
        s.zombie = true;
        n++;
      }
    }
    console.log(`[proxy] ZOMBIFY: ${n} streams half-open (bytes al void, sin FIN)`);
    return json(res, 200, { zombified: n });
  }
  if (url.pathname === "/debug/kill-streams") {
    let n = 0;
    for (const s of liveStreams) {
      s.clientRes.destroy();
      s.upstream.destroy();
      n++;
    }
    liveStreams.clear();
    console.log(`[proxy] KILL: ${n} streams destruidos (el EventSource reconecta solo con Last-Event-ID)`);
    return json(res, 200, { killed: n });
  }
  if (url.pathname === "/debug/rewind") {
    const body = await readBody(req);
    rewindTo = typeof body.to === "number" ? body.to : 1;
    console.log(`[proxy] REWIND one-shot: el próximo /api/stream va con watermark=${rewindTo}`);
    return json(res, 200, { rewindTo });
  }
  if (url.pathname === "/debug/burst") {
    const body = await readBody(req);
    const n = typeof body.n === "number" ? body.n : 20;
    for (let i = 1; i <= n; i++) server.pushToUser(user.id, { t: "refresh" });
    console.log(`[proxy] BURST: ${n} broadcasts {t:"refresh"} pusheados (buffer cap 8 → gap)`);
    return json(res, 200, { pushed: n });
  }

  // --- proxy hacia el web-server real ---
  const isStream = url.pathname === "/api/stream";
  const headers = { ...req.headers, host: `127.0.0.1:${SERVER_PORT}` };
  // Spoof del Origin (mismo truco que el modo REMOTE de vite.config): el check CSRF del
  // server compara Origin.host === Host, y el browser manda origin localhost:5173.
  if (headers.origin) headers.origin = `http://127.0.0.1:${SERVER_PORT}`;
  if (headers.referer) headers.referer = `http://127.0.0.1:${SERVER_PORT}/`;
  let path = req.url ?? "/";
  if (isStream && rewindTo !== undefined) {
    // Pisar el watermark (header Y query) con el valor del rewind → replay de ya-vistos.
    const u = new URL(path, "http://x");
    u.searchParams.set("since", String(rewindTo));
    path = u.pathname + u.search;
    headers["last-event-id"] = String(rewindTo);
    console.log(`[proxy] rewind aplicado: ${path}`);
    rewindTo = undefined;
  }
  const up = request(
    { host: "127.0.0.1", port: SERVER_PORT, path, method: req.method, headers },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      if (isStream) {
        const live: Live = { clientRes: res, upstream, zombie: false };
        liveStreams.add(live);
        upstream.on("data", (c: Buffer) => {
          if (live.zombie) return; // half-open: el byte se pierde en la "red"
          res.write(c);
        });
        upstream.on("end", () => {
          liveStreams.delete(live);
          if (!live.zombie) res.end(); // un zombie ni siquiera propaga el FIN
        });
        req.on("close", () => {
          liveStreams.delete(live);
          upstream.destroy();
        });
      } else {
        upstream.pipe(res);
      }
    },
  );
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(up);
}).listen(PROXY_PORT, () => {
  console.log(`[proxy] congelable en http://127.0.0.1:${PROXY_PORT} → web-server real :${SERVER_PORT}`);
  console.log(`[proxy] login: GET http://127.0.0.1:${PROXY_PORT}/debug/token`);
});
