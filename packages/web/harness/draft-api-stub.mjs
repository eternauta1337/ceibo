// Stub del API para validar EN BROWSER REAL la persistencia de drafts (Fase A rock-solid).
// Reemplaza al web-server en dev (vite proxy /api → :8820) con una wiki en memoria y
// endpoints de debug para provocar los escenarios de pérdida de forma determinística:
//
//   node packages/web/harness/draft-api-stub.mjs   # :8820
//   pnpm --filter @ceibo/web dev                   # :5173 (proxy /api → :8820)
//
// Debug:
//   POST /debug/edit          {repo,path,content}  → edición "externa" + broadcast {t:refresh}
//                                                    (simula agente/REM: remount del editor)
//   POST /debug/edit-silent   {repo,path,content}  → edición externa SIN refresh
//                                                    (simula otra pestaña web: próximo PUT → 409)
//   POST /debug/put-delay     {ms}                 → demora los próximos PUT `ms` milisegundos.
//                                                    Congela el autosave "en vuelo" para abrir la
//                                                    ventana L2 de forma determinística: tipear →
//                                                    el PUT cuelga → /debug/edit remonta el editor
//                                                    con el draft todavía vivo. 0 = desactivar.
//   GET  /debug/state                              → dump de la wiki en memoria (contenido + shas)
//
// Sin auth: /api/me siempre responde la sesión de "demo". Solo para el harness local.

import { createServer } from "node:http";

const PORT = 8820;
const HANDLE = "demo";
const REPO = "demo-wiki";

let shaSeq = 0;
let putDelayMs = 0; // /debug/put-delay: demora artificial de los PUT (ventana L2 determinística)
const newSha = () => `stub-sha-${++shaSeq}`;
/** @type {Map<string, {content: string, sha: string}>} */
const files = new Map();
const fkey = (repo, path) => `${repo}\u0000${path}`;
function seed(path, content) {
  files.set(fkey(REPO, path), { content, sha: newSha() });
}
seed("notas/prueba draft.md", "# prueba draft\n\nContenido inicial de la nota de prueba.\n");
seed("notas/otra nota.md", "# otra nota\n\nOtra nota para navegar.\n");

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
    return json(res, 200, { handle: HANDLE, name: "demo (stub)", defaultWiki: REPO });
  }
  if (path === "/api/explorer") {
    const list = [...files.keys()]
      .filter((k) => k.startsWith(`${REPO}\u0000`))
      .map((k) => k.split("\u0000")[1]);
    return json(res, 200, { wikis: [{ repo: REPO, label: "demo", files: list.sort() }] });
  }
  if (path === "/api/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ t: "ready", handle: HANDLE, name: "demo (stub)" })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return;
  }
  if (path === "/api/file" && req.method === "GET") {
    const f = files.get(fkey(url.searchParams.get("repo"), url.searchParams.get("path")));
    if (!f) return json(res, 404, { error: "not-found" });
    return json(res, 200, { content: f.content, sha: f.sha });
  }
  if (path === "/api/file" && req.method === "PUT") {
    const p = await readBody(req);
    if (putDelayMs > 0) {
      console.log(`  … PUT demorado ${putDelayMs}ms (put-delay)`);
      await new Promise((r) => setTimeout(r, putDelayMs));
    }
    const f = files.get(fkey(p.repo, p.path));
    if (!f) return json(res, 404, { error: "not-found" });
    if (p.baseSha !== f.sha) {
      console.log(`  → 409 (baseSha ${p.baseSha} != ${f.sha})`);
      return json(res, 409, { error: "conflict" });
    }
    f.content = p.content;
    f.sha = newSha();
    console.log(`  → 200 (sha ${f.sha})`);
    return json(res, 200, { sha: f.sha });
  }
  if (path === "/debug/edit" || path === "/debug/edit-silent") {
    const p = await readBody(req);
    const k = fkey(p.repo ?? REPO, p.path);
    const f = files.get(k) ?? { content: "", sha: "" };
    f.content = p.content ?? `${f.content}\n[editado afuera ${new Date().toISOString()}]\n`;
    f.sha = newSha();
    files.set(k, f);
    if (path === "/debug/edit") broadcast({ t: "refresh", changed: [p.path] });
    console.log(
      `  → edición externa${path.endsWith("silent") ? " (silenciosa)" : " + refresh"} sha=${f.sha}`,
    );
    return json(res, 200, { sha: f.sha });
  }
  if (path === "/debug/put-delay") {
    const p = await readBody(req);
    putDelayMs = Number(p.ms) || 0;
    console.log(`  → put-delay = ${putDelayMs}ms`);
    return json(res, 200, { putDelayMs });
  }
  if (path === "/debug/state") {
    const dump = {};
    for (const [k, f] of files) dump[k.replace("\u0000", " :: ")] = f;
    return json(res, 200, dump);
  }
  // Lo demás que la SPA toque (avatar, crons, connections…) no afecta al editor.
  return json(res, 404, { error: "stub: not implemented" });
}).listen(PORT, () => console.log(`draft-api-stub en http://127.0.0.1:${PORT}`));
