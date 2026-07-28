// Stub del API para validar EN BROWSER REAL los POSTs salientes resilientes (Fase B.2
// rock-solid). Reemplaza al web-server en dev (vite proxy /api → :8820) con un eco simple
// y un modo de fallo conmutable para provocar los escenarios de forma determinística:
//
//   node packages/web/harness/send-api-stub.mjs   # :8820
//   pnpm --filter @ceibo/web dev                  # :5173 (proxy /api → :8820)
//
// Debug:
//   POST /debug/send-mode {mode}  → cómo responde el próximo /api/send:
//       "ok"      (default) 202 + eco por SSE (heard para audio, text, turn-done)
//       "network" destruye el socket sin responder (fallo de red puro → el cliente reintenta)
//       "500"     responde 500 (transitorio → el cliente reintenta)
//       "413"     responde 413 (terminal → el cliente NO reintenta, mensaje claro)
//   GET  /debug/sends             → log de los POST recibidos (para contar reintentos)
//
// Sin auth: /api/me siempre responde la sesión de "demo". Solo para el harness local.

import { createServer } from "node:http";

const PORT = 8820;
const HANDLE = "demo";

let sendMode = "ok";
/** @type {{t: string, at: string, mode: string}[]} */
const sends = [];

/** @type {Set<import("node:http").ServerResponse>} */
const sseClients = new Set();
function broadcast(msg) {
  const frame = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

const json = (res, code, body) =>
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  console.log(`${req.method} ${path}`);

  if (path === "/api/me") {
    return json(res, 200, { handle: HANDLE, name: "demo (stub)", defaultWiki: "demo-wiki" });
  }
  if (path === "/api/explorer") {
    return json(res, 200, { wikis: [{ repo: "demo-wiki", label: "demo", files: [] }] });
  }
  if (path === "/api/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ t: "ready", handle: HANDLE, name: "demo (stub)" })}\n\n`);
    sseClients.add(res);
    // Keep-alive observable (como el web-server real post-Fase A): {t:"ping"} cada 10s.
    const ping = setInterval(() => res.write(`data: ${JSON.stringify({ t: "ping" })}\n\n`), 10_000);
    req.on("close", () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return;
  }
  if (path === "/api/send" && req.method === "POST") {
    sends.push({ t: "?", at: new Date().toISOString(), mode: sendMode });
    if (sendMode === "network") {
      console.log("  → socket destroy (fallo de red simulado)");
      req.socket.destroy();
      return;
    }
    const p = await readBody(req);
    sends[sends.length - 1].t = p.t ?? "?";
    if (sendMode === "500") {
      console.log("  → 500");
      return json(res, 500, { error: "stub-500" });
    }
    if (sendMode === "413") {
      console.log("  → 413");
      return json(res, 413, { error: "too-large" });
    }
    console.log(
      `  → 202 (t=${p.t}, ${p.t === "audio" ? `${(p.data ?? "").length}b b64` : JSON.stringify(p.text)})`,
    );
    res.writeHead(202, { "content-type": "application/json" }).end("{}");
    // Eco diferido por SSE, como el turno real: heard (si fue audio) → text → turn-done.
    setTimeout(() => {
      if (p.t === "audio") broadcast({ t: "heard", text: "(transcripción stub del audio)" });
      broadcast({ t: "text", text: `eco del stub: ${p.t === "audio" ? "recibí tu audio" : p.text}` });
      broadcast({ t: "turn-done" });
    }, 600);
    return;
  }
  if (path === "/debug/send-mode" && req.method === "POST") {
    const p = await readBody(req);
    sendMode = p.mode ?? "ok";
    console.log(`  → send-mode = ${sendMode}`);
    return json(res, 200, { sendMode });
  }
  if (path === "/debug/sends") {
    return json(res, 200, sends);
  }
  return json(res, 404, { error: "stub: not implemented" });
}).listen(PORT, () => console.log(`send-api-stub en http://127.0.0.1:${PORT}`));
