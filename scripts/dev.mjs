#!/usr/bin/env node
// Levanta el stack de dev local con UN comando: `pnpm dev`.
//
//   [gw]  gateway      (tsx watch)  ← turnos / agente (archima o MA)
//   [api] web-server   (tsx watch)  ← HTTP/SSE + SPA en :8820
//   [web] web          (vite)       ← frontend en :5173, proxea /api a :8820
//
// CEIBO_ENV=dev ya sale del .env (loadEnvFile lo pisa), pero lo forzamos igual por las dudas.
// Ctrl-C cierra los tres: cada hijo se spawnea en su propio grupo de procesos (detached) y
// matamos el grupo entero con `kill(-pid)` — si no, pnpm→tsx/vite dejan nietos zombis.

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// El `.env` es único y vive en el root del clon principal (gitignored, no viaja). Los
// entry-points lo cargan con `../../../.env` → el root del árbol desde el que corrés. En un
// worktree ese root no tiene `.env` y el stack arranca sin config. Si falta, lo traemos del
// clon principal (lo ubicamos por el git-common-dir, que en un worktree apunta a su `.git`).
function ensureEnv() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  if (existsSync(join(root, ".env"))) return;
  let commonDir;
  try {
    commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return; // no es un repo git → nada que traer
  }
  const mainRoot = dirname(isAbsolute(commonDir) ? commonDir : join(root, commonDir));
  if (mainRoot === root) return; // ya estamos en el clon principal
  const mainEnv = join(mainRoot, ".env");
  if (!existsSync(mainEnv)) return; // el principal tampoco tiene .env
  copyFileSync(mainEnv, join(root, ".env"));
  process.stdout.write(`copié .env del clon principal (${mainEnv}) → este worktree\n`);
}

ensureEnv();

// Cargamos el .env del root en ESTE proceso para poder leer CONTROL_MCP_URL (los hijos lo
// cargan igual por su cuenta; esto es idempotente). Best-effort: si no hay .env, seguimos.
try {
  process.loadEnvFile(resolve(fileURLToPath(new URL("../.env", import.meta.url))));
} catch {
  // sin .env → controlServe queda apagado (CONTROL_MCP_URL ausente)
}

// ── Control MCP por tailscale serve (DEV) ───────────────────────────────────────────────────
// En dev el agente (VM archima) alcanza el control DIRECTO (el MITM del AV no hace HTTPS a
// tailnet → 502, ver feat/dev-faithful-control-c). Para eso el control —que escucha plain-HTTP
// en 127.0.0.1:CONTROL_MCP_PORT— necesita HTTPS en el tailnet de la mac: lo expone `tailscale
// serve` (cert real, SOLO tailnet, NO internet). CLAVE: se ABRE al arrancar dev y se CIERRA al
// pararlo (Ctrl-C / caída de un hijo) → no queda ningún puerto expuesto con dev abajo.
// Best-effort y configurable: si tailscale no está o falla, avisa y dev arranca igual.
//   TAILSCALE_BIN  override del binario (default: `tailscale`)
//   DEV_NO_CONTROL_SERVE=1  saltea el manejo del serve (lo hacés a mano)
const TS_BIN = process.env.TAILSCALE_BIN || "tailscale";
const controlServe = (() => {
  if (process.env.DEV_NO_CONTROL_SERVE === "1") return null;
  const url = process.env.CONTROL_MCP_URL;
  if (!url) return null;
  let host, httpsPort;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !u.hostname.endsWith(".ts.net")) return null; // sólo control tailnet
    host = u.hostname;
    httpsPort = u.port || "443";
  } catch {
    return null;
  }
  const localPort = process.env.CONTROL_MCP_PORT || "8830";
  return { host, httpsPort, target: `http://127.0.0.1:${localPort}` };
})();

function startControlServe() {
  if (!controlServe) return;
  const { host, httpsPort, target } = controlServe;
  try {
    execFileSync(TS_BIN, ["serve", "--bg", `--https=${httpsPort}`, target], { stdio: "ignore" });
    process.stdout.write(`control MCP expuesto en el tailnet: https://${host}:${httpsPort} → ${target}\n`);
  } catch (e) {
    process.stdout.write(
      `⚠️  no pude levantar tailscale serve del control (${e?.message ?? e}). El connect no correrá ` +
        `en dev hasta exponerlo a mano: ${TS_BIN} serve --bg --https=${httpsPort} ${target} ` +
        `(o seteá DEV_NO_CONTROL_SERVE=1 para silenciar).\n`,
    );
  }
}

function stopControlServe() {
  if (!controlServe) return;
  try {
    execFileSync(TS_BIN, ["serve", `--https=${controlServe.httpsPort}`, "off"], { stdio: "ignore" });
    process.stdout.write("control MCP retirado del tailnet (tailscale serve off)\n");
  } catch {
    // best-effort: si no se pudo, lo bajás con `tailscale serve --https=<port> off`
  }
}

const PROCS = [
  { name: "gw ", color: "\x1b[34m", filter: "@ceibo/gateway" },
  { name: "api", color: "\x1b[32m", filter: "@ceibo/web-server" },
  { name: "web", color: "\x1b[35m", filter: "@ceibo/web" },
];
const RESET = "\x1b[0m";
const children = [];
let shuttingDown = false;

startControlServe(); // abre el control en el tailnet (sólo dev; ver controlServe). Cierra en shutdown().

function prefixStream(stream, name, color) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) process.stdout.write(`${color}[${name}]${RESET} ${line}\n`);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write("\ncerrando dev stack…\n");
  stopControlServe(); // cierra el puerto del control en el tailnet (no queda expuesto con dev abajo)
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM"); // grupo entero
    } catch {
      // ya muerto
    }
  }
  setTimeout(() => process.exit(code), 600);
}

for (const p of PROCS) {
  const child = spawn("pnpm", ["--filter", p.filter, "dev"], {
    env: { ...process.env, CEIBO_ENV: "dev", FORCE_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // grupo propio → kill(-pid) baja todo el árbol
  });
  prefixStream(child.stdout, p.name, p.color);
  prefixStream(child.stderr, p.name, p.color);
  child.on("exit", (code) => {
    process.stdout.write(`${p.color}[${p.name}]${RESET} salió (code ${code ?? "?"})\n`);
    if (!shuttingDown) shutdown(code ?? 1); // si uno cae, bajamos todo (lo ves al toque)
  });
  children.push(child);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
