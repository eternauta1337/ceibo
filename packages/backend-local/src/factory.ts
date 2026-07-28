// Factory de deps REALES del ArchimaBackend: arma el `exec` (ssh a la box por el tailnet) y el
// `HttpOpencodeClient` (resuelve la VM por cp.sh y le habla HTTP/SSE). Es el equivalente prod de
// lo que `sim/vm.ts` hace en el sandbox. El gateway llama `makeArchimaBackend(cfg)` en su bootstrap.
//
// Acceso: ssh con una llave dedicada a gpuhost (100.64.0.10 por el tailnet). En gpuhost esa
// llave tiene un forced-command que sólo deja correr cp.sh + agent-vault → el `cmd` que mandamos es
// el token que el wrapper valida ("cp.sh"/"agent-vault"), no una ruta. El data path a opencode en la
// VM (192.168.122.x:14420) va por el subnet route del tailnet.

import { spawn } from "node:child_process";
import { ArchimaBackend, type Exec } from "./archima-backend.ts";
import { HttpOpencodeClient } from "./http-opencode-client.ts";

export interface ArchimaConfig {
  /** Target ssh de la box, ej. "demo@100.64.0.10" (IP de tailnet de gpuhost). */
  sshTarget: string;
  /** Llave ssh dedicada (scopeada por forced-command en la box), ej. "~/.ssh/gpuhost_cp". */
  sshKey: string;
  /** Token del control plane que el forced-command reconoce. Default "cp.sh". */
  cp?: string;
  /** Token del binario de vault que el forced-command reconoce. Default "agent-vault". */
  av?: string;
  /** Provider/model de opencode que reciben las VMs (el agente no elige modelo). */
  providerID: string;
  modelID: string;
  /** Modelo del coordinador conversacional. Default: modelID. */
  coordinatorModelID?: string;
  /** Modelo del worker/sub-agente. Default: modelID. */
  workerModelID?: string;
  /** Agente de opencode del COORDINADOR (campo `agent` del prompt/sesión). Selecciona el agente
   *  custom de opencode.json (su prompt propio + `permission` deny). Default `ARCHIMA_AGENT` o "ceibo". */
  agent?: string;
  /** Agente de opencode del WORKER (sub-agente asíncrono). Default `ARCHIMA_WORKER_AGENT` o "ceibo-worker". */
  workerAgent?: string;
  /** Puerto de opencode serve en la VM. Default 14420. */
  vmPort?: number;
  /** Timeout (ms) por cada exec ssh a la box. Default `ARCHIMA_EXEC_TIMEOUT_MS` o 120000
   *  (cubre el peor caso legítimo de `cp.sh serve` en cold-boot; ver DEFAULT_EXEC_TIMEOUT_MS). */
  execTimeoutMs?: number;
  /** Techo de PARED (ms) por turno archima (guardrail anti-runaway): al vencer se aborta la
   *  sesión opencode en la VM. Default `ARCHIMA_TURN_TIMEOUT_MS` o 10 min; ≤0 desactiva. */
  turnTimeoutMs?: number;
}

// IdentitiesOnly: fuerza ssh a usar SOLO la -i <key> explícita, ignorando el agente y los
// defaults (~/.ssh/id_*). En una máquina con varias keys a archima (ej. la mac del owner
// tiene una key full-shell además de la scopeada), sin esto ssh puede caer a la wrong key,
// saltear el forced-command wrapper y fallar con "cp.sh: command not found". En la box es
// no-op (única key de archima). Robustez garantizada en cualquier entorno.
const SSH_OPTS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "IdentitiesOnly=yes",
  // ControlMaster (quickboot): multiplexa TODAS las llamadas gateway→gpuhost (cp.sh state/serve/
  // wiki-setup + las 5 del AV de prepareSession) sobre UNA conexión persistente. El handshake ssh
  // (~2s/llamada, medido) se pagaba en cada exec → ~16s del cold-open eran handshakes seriales.
  // Con esto la 1ª llamada abre el master y el resto lo reusa (~0). %C = un solo socket por target
  // (mismo gpuhost para todos los users → conexión compartida). ControlPersist lo mantiene caliente
  // entre llamadas del mismo reopen y entre turnos cercanos. Si el master muere, `auto` lo re-crea.
  "-o",
  "ControlMaster=auto",
  "-o",
  "ControlPath=/tmp/ceibo-cm-%C",
  "-o",
  "ControlPersist=180s",
];

/** Default del timeout de cada exec ssh. Tiene que CUBRIR el peor caso legítimo de `cp.sh serve`
 *  en un cold-boot real (vip_wait hasta 30s + scp + health-wait de opencode ~40-60s ≈ 100s):
 *  con el techo viejo de 60s el exec mataba un serve que iba a terminar bien y obligaba a otra
 *  vuelta entera de retry. 120s cubre el cold-boot y sigue acotando un ssh colgado de verdad. */
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

/** Resuelve el timeout efectivo: cfg.execTimeoutMs > ARCHIMA_EXEC_TIMEOUT_MS > default. */
function resolveExecTimeoutMs(cfg: ArchimaConfig): number {
  if (typeof cfg.execTimeoutMs === "number" && cfg.execTimeoutMs > 0) return cfg.execTimeoutMs;
  const env = Number(process.env.ARCHIMA_EXEC_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_EXEC_TIMEOUT_MS;
}

/** Techo de pared por turno (anti-runaway): cfg.turnTimeoutMs > ARCHIMA_TURN_TIMEOUT_MS > default
 *  (10 min, en ArchimaBackend). ≤0 (explícito) = desactivado; undefined = el backend usa su default. */
function resolveTurnTimeoutMs(cfg: ArchimaConfig): number | undefined {
  if (typeof cfg.turnTimeoutMs === "number") return cfg.turnTimeoutMs;
  const env = Number(process.env.ARCHIMA_TURN_TIMEOUT_MS);
  return Number.isFinite(env) ? env : undefined;
}

function readJsonEnv(name: string): Record<string, unknown> | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} debe ser un objeto JSON`);
  }
  return parsed as Record<string, unknown>;
}

/** argv de ssh para correr `<cmd> <args>` en la box. El comando remoto va como UN solo string
 *  → el forced-command de gpuhost lo recibe tal cual en SSH_ORIGINAL_COMMAND y lo valida. */
export function sshArgv(target: string, key: string, cmd: string, args: string[]): string[] {
  return ["-i", key, ...SSH_OPTS, target, [cmd, ...args].join(" ")];
}

/** Corre `bin argv` y devuelve stdout (trim); rechaza con stderr si el exit != 0.
 *  Si `opts.timeoutMs > 0` y el proceso no cierra a tiempo, lo mata (SIGKILL) y rechaza con un
 *  error claro (`opts.label` describe el comando lógico, no el argv crudo de ssh). El timer se
 *  limpia tanto en éxito como en error → no quedan handles colgados. */
export function run(
  bin: string,
  argv: string[],
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<string> {
  const { timeoutMs = 0, label } = opts;
  return new Promise((resolve, reject) => {
    const p = spawn(bin, argv);
    let out = "";
    let err = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        p.kill("SIGKILL");
      }, timeoutMs);
    }
    const clear = () => {
      if (timer) clearTimeout(timer);
    };
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.stderr.on("data", (d) => {
      err += d;
    });
    p.on("error", (e) => {
      clear();
      reject(e);
    });
    p.on("close", (code) => {
      clear();
      if (timedOut)
        reject(new Error(`archima exec timeout (${timeoutMs}ms): ${label ?? `${bin} ${argv.join(" ")}`}`));
      else if (code === 0) resolve(out.trim());
      else {
        // cp.sh / agent-vault imprimen sus errores por STDOUT (no stderr) → con `err` solo el mensaje
        // quedaba "ssh exit 1:" MUDO (nos costó una hora de arqueología). Caemos a stdout si stderr
        // viene vacío, y usamos `label` (cmd+args lógicos) en vez del `ssh` crudo. El log server-side
        // deja el fallo COMPLETO (stderr + stdout) en el journal para diagnóstico.
        const who = label ?? `${bin} ${argv.join(" ")}`;
        const detail = (err.trim() || out.trim()).slice(0, 200);
        console.log(
          `[archima exec] FALLÓ «${who}» exit ${code} · stderr: ${err.trim().slice(0, 500) || "(vacío)"} · stdout: ${out.trim().slice(0, 500) || "(vacío)"}`,
        );
        reject(new Error(`${who} exit ${code}: ${detail}`));
      }
    });
  });
}

/** Construye el resolveBase real: asegura el serve en la VM (`cp.sh serve`, idempotente) y
 *  resuelve su IP. Exportado para testearlo sin ssh real.
 *
 *  Auto-recuperación del token AV (incidente 2026-06-10): si el host (y con él el broker
 *  agent-vault) se reinicia, el token guardado en la VM queda RECHAZADO → `opencode serve`
 *  (envuelto en `agent-vault run`) muere al arrancar con 401 y `cp.sh serve` agota su
 *  health-wait y falla — en loop, hasta que un humano corría `assign`. Ahora, si serve falla y
 *  conocemos el vault de la VM (`vaultFor`, poblado por el backend en cada ensure), corremos
 *  `cp.sh assign` (re-mintea el token con rotate y lo pushea a la VM) y reintentamos serve UNA
 *  vez. assign es seguro de re-correr (idempotente por diseño) y serve re-wrappea opencode al
 *  detectar el mismatch de token. Sin vault conocido → propagamos el error original. */
/** Config por defecto que pasa `serve` cuando manda `--require-vault`. DEBE coincidir con el
 *  default de `cp.sh serve` (`opencode-delegv2.json`): se pasa explícita en $3 para que el flag
 *  vaya en $4 y un cp.sh viejo (pre-deploy) lo ignore en vez de tratarlo como config. Hoy nadie
 *  pasa una config por tier (lever diferido); si se implementa, se plumbea por acá. */
const DEFAULT_SERVE_CFG = "opencode-delegv2.json";

export function makeResolveBase(opts: {
  exec: Exec;
  cp: string;
  port: number;
  vaultFor: (vmName: string) => string | undefined;
}): (name: string) => Promise<string> {
  return async (name) => {
    // --require-vault cuando conocemos el vault de la VM: serve falla en vez de levantar opencode
    // PELADO (sin agent-vault → sin egress → MCP externos muertos en silencio y sin auto-heal). El
    // fallo dispara el mismo retry de abajo (assign re-mintea/pushea el token → serve lo re-wrappea),
    // así que un assign que no llegó a correr (VM sin IP en un respawn) se auto-cura en vez de dejar
    // la VM degradada para siempre.
    //
    // ORDEN DE DEPLOY: el flag va en $4 con la config explícita en $3 (DEFAULT_SERVE_CFG, == default
    // de cp.sh). Así un cp.sh VIEJO (gateway deployado antes que el runtime de gpuhost) toma $3 como
    // config válida e IGNORA el $4 que no conoce — en vez de tomar `--require-vault` como nombre de
    // config y fallar todos los serve. Los dos lados se deployan en cualquier orden, sin coordinar.
    const serveArgs = opts.vaultFor(name)
      ? ["serve", name, DEFAULT_SERVE_CFG, "--require-vault"]
      : ["serve", name];
    try {
      await opts.exec(opts.cp, serveArgs);
    } catch (e) {
      const vault = opts.vaultFor(name);
      if (!vault) throw e;
      console.warn(
        `[archima] serve de ${name} falló (${(e as Error)?.message ?? e}) → re-assign del vault y retry de serve`,
      );
      await opts.exec(opts.cp, ["assign", name, vault]);
      await opts.exec(opts.cp, serveArgs);
    }
    const ip = (await opts.exec(opts.cp, ["ip", name])).split("\n").pop()?.trim();
    if (!ip) throw new Error(`archima: VM ${name} sin IP`);
    return `http://${ip}:${opts.port}`;
  };
}

/** Construye un ArchimaBackend con deps reales (ssh + opencode HTTP) desde la config del env. */
export function makeArchimaBackend(cfg: ArchimaConfig): ArchimaBackend {
  const cp = cfg.cp ?? "cp.sh";
  const av = cfg.av ?? "agent-vault";
  const port = cfg.vmPort ?? 14420;
  const timeoutMs = resolveExecTimeoutMs(cfg);
  const exec = (cmd: string, args: string[]) =>
    run("ssh", sshArgv(cfg.sshTarget, cfg.sshKey, cmd, args), { timeoutMs, label: [cmd, ...args].join(" ") });
  const agent = cfg.agent ?? process.env.ARCHIMA_AGENT ?? "ceibo";
  const workerAgent = cfg.workerAgent ?? process.env.ARCHIMA_WORKER_AGENT ?? "ceibo-worker";
  // Pacing entre connects de MCP (bug D): el MITM del AV rate-limita ~10 req/40s por agente.
  const paceEnv = Number(process.env.ARCHIMA_MCP_PACE_MS);
  const mcpPaceMs = Number.isFinite(paceEnv) && paceEnv >= 0 ? paceEnv : undefined; // undefined → default 1500
  // Concurrencia de connects de MCP (reemplaza el pacing serial): cap < 10 (bucket per-agente del AV).
  const concEnv = Number(process.env.ARCHIMA_MCP_CONCURRENCY);
  const mcpConnectConcurrency = Number.isFinite(concEnv) && concEnv >= 1 ? concEnv : undefined; // undefined → default 8
  // Watchdog del SSE de eventos (cuelgue silencioso post-reboot): undefined → default 45s.
  const idleEnv = Number(process.env.ARCHIMA_EVENT_IDLE_TIMEOUT_MS);
  const idleTimeoutMs = Number.isFinite(idleEnv) ? idleEnv : undefined;
  // Registro vm → vault para el retry de assign de makeResolveBase. Lo puebla el backend en cada
  // ensure de sesión (createSession/reuseOrCreate) vía deps.registerVault.
  const vaultByVm = new Map<string, string>();
  const opencode = new HttpOpencodeClient({
    providerID: cfg.providerID,
    modelID: cfg.modelID,
    coordinatorModelID: cfg.coordinatorModelID,
    workerModelID: cfg.workerModelID,
    coordinatorOptions: readJsonEnv("ARCHIMA_COORDINATOR_OPTIONS_JSON"),
    workerOptions: readJsonEnv("ARCHIMA_WORKER_OPTIONS_JSON"),
    agent,
    workerAgent,
    mcpPaceMs,
    mcpConnectConcurrency,
    idleTimeoutMs,
    // El sessionId lógico = nombre de VM (de cp.sh). Aseguramos el serve (idempotente, con
    // retry de assign si el token AV fue rechazado) y resolvemos la IP de la VM; el gateway
    // en vps.example.com la alcanza directo por el subnet route.
    resolveBase: makeResolveBase({ exec, cp, port, vaultFor: (name) => vaultByVm.get(name) }),
  });
  return new ArchimaBackend({
    exec,
    cp,
    av,
    opencode,
    turnTimeoutMs: resolveTurnTimeoutMs(cfg),
    registerVault: (name, vaultId) => vaultByVm.set(name, vaultId),
  });
}
