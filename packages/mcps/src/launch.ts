// Launcher de MCPs — UN proceso que sirve todos los MCP servers stateless de la
// familia (gmail, calendar, sheets, …) detrás del ingress nginx.
//
// Cada server se monta en /<name>/<secret> y se sirve sólo si tiene su path-secret
// configurado (`GMAIL_MCP_PATH_SECRET`, …; fallback al viejo `GMAIL_MCP_SECRET`) — así
// habilitás un subconjunto por qué secretos pongas. Detrás del ingress la URL pública queda
// `https://<box>/mcp/<name>/<secret>` (nginx: /mcp/ → este launcher, strippeado).
//
// C1 (auditoría 2026-06-08): el path-secret (que va en la URL y se filtra en logs de nginx)
// está desacoplado de la clave HMAC de identidad. Los servers que firman Bearer (schedule,
// wacli) leen su `<NAME>_MCP_HMAC_KEY` aparte; el path-secret SÓLO gatea el acceso.
//
// Agregar un MCP nuevo = importarlo y sumarlo al REGISTRY.
//
// Nota (Fase 9): el MCP `wacli` SÍ va acá. Las lecturas de WhatsApp son stateless
// (spawnean el binario contra el SQLite ya sincronizado); lo único stateful es el
// `sync --follow`, que NO es un MCP — lo orquesta el gateway atado a la sesión MA.
//
//   pnpm start   (PORT/HOST/<NAME>_MCP_SECRET por env; carga ../.env si existe)

import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { handleMcpPost, type McpServer } from "./core/transport.ts";
import { calendar } from "./servers/calendar.ts";
import { drive } from "./servers/drive.ts";
import { gmail } from "./servers/gmail.ts";
import { notion_server } from "./servers/notion.ts";
import { schedule } from "./servers/schedule.ts";
import { sheets } from "./servers/sheets.ts";
import { wacli } from "./servers/wacli.ts";

/** Compara secretos en tiempo constante. El chequeo de largo corta antes (fuga de
 *  largo aceptable para un secreto random de 24 bytes); el contenido es timing-safe. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const ENV_PATH = new URL("../../../.env", import.meta.url); // .env único en el root del monorepo
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH); // Node 22+; opcional (systemd puede pasar el env)

const PORT = Number(process.env.PORT ?? 8810);
const HOST = process.env.HOST ?? "127.0.0.1";

// Registry de MCP servers stateless. Sumar uno acá lo hace montables.
const REGISTRY: McpServer[] = [gmail, calendar, drive, sheets, notion_server, schedule, wacli];

// Montamos sólo los que tienen secreto de path. El gate de la URL (`/<name>/<secret>`) sale
// de `${NAME}_MCP_PATH_SECRET` (C1: desacoplado de la clave HMAC de identidad, que para los
// servers que firman Bearer — schedule/wacli — es `${NAME}_MCP_HMAC_KEY`, leída por el server).
// Fallback al viejo `${NAME}_MCP_SECRET` para los servers que sólo gatean por path y no firman
// tokens (gmail/calendar/drive/sheets/notion): no tienen el dual-rol, no hace falta renombrarlos.
const mounted = new Map<string, { server: McpServer; secret: string }>();
for (const server of REGISTRY) {
  const NAME = server.name.toUpperCase();
  const secret = process.env[`${NAME}_MCP_PATH_SECRET`] ?? process.env[`${NAME}_MCP_SECRET`];
  if (!secret) {
    console.warn(`[mcps] ${server.name}: sin ${NAME}_MCP_PATH_SECRET → no montado`);
    continue;
  }
  mounted.set(server.name, { server, secret });
}

const httpServer = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";

  if (req.method === "GET" && path === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "text/plain" }).end("MCP: usá POST con JSON-RPC");
    return;
  }

  // `/<name>/<secret>` (perfil default) o `/<name>/<perfil>/<secret>` (multi-cuenta):
  // el name es el PRIMER segmento y el secret SIEMPRE el ÚLTIMO. El/los segmento(s)
  // del medio (perfil) son sólo scope para el matcher del proxy archima — el server
  // los ignora. Sirve para URLs viejas (`?profile=` ya stripeada, secret en idx 2) y
  // nuevas (perfil en el path) sin ramificar.
  const segs = path.split("/").filter(Boolean);
  const name = segs[0];
  const secret = segs[segs.length - 1];
  const m = segs.length >= 2 && name ? mounted.get(name) : undefined;
  if (!m || !safeEqual(secret ?? "", m.secret)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  void handleMcpPost(m.server, req, res);
});

httpServer.listen(PORT, HOST, () => {
  console.log(
    `[mcps] escuchando en ${HOST}:${PORT} · montados: ${[...mounted.keys()].join(", ") || "(ninguno)"}`,
  );
});

const shutdown = () => {
  httpServer.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
