// Orquestación de wacli (Fase 9) — la parte STATEFUL de WhatsApp, que NO es el MCP
// (las lecturas viven en @ceibo/mcps). Acá el gateway maneja los subprocesos del
// binario `wacli` que SÍ necesitan socket vivo:
//
//   - enrollment: `wacli auth --phone <n> --events` → parsea NDJSON (pair_code →
//     relay al usuario; connected → el caller mintea el Bearer al vault). Sin
//     `--follow`: paréa, hace el backfill inicial (bootstrap hasta idle) y sale.
//   - follow atado a la sesión (L349): `wacli sync --follow` corre SÓLO mientras el
//     usuario está activo (lo prende `noteActivity` en cada turno; lo apaga un timer
//     de inactividad). Cero follows 24/7. Un follow por usuario (el lock per-store
//     de wacli igual lo garantiza).

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { wacliStoreDirForUser } from "@ceibo/store";

const WACLI_BIN = process.env.WACLI_BIN ?? "wacli";
// Nombre que WhatsApp muestra en "Dispositivos vinculados". wacli lo lee de
// WACLI_DEVICE_LABEL al parear (SetOSInfo); sin él pondría "wacli - <os> (<host>)".
// Default "Ceibo" para que el usuario reconozca el dispositivo como el asistente.
const DEVICE_LABEL = process.env.WACLI_DEVICE_LABEL ?? "Ceibo";
// Cuánto esperar a que el usuario ingrese el código antes de abortar el pairing.
const ENROLL_WAIT_MS = Number(process.env.WACLI_ENROLL_WAIT_MS ?? 240_000);
// Margen tras conectar para que termine el backfill (bootstrap idle-exit ~30s).
const BOOTSTRAP_MS = Number(process.env.WACLI_BOOTSTRAP_MS ?? 120_000);
// Ventana de inactividad: si no hay turnos nuevos, se apaga el follow.
const FOLLOW_IDLE_MS = Number(process.env.WACLI_FOLLOW_IDLE_MS ?? 300_000);

interface WacliEvent {
  event: string;
  data?: Record<string, unknown>;
}

/** Lee NDJSON línea a línea de un stream y llama onEvent por cada evento válido. */
export function onNdjson(stream: NodeJS.ReadableStream, onEvent: (e: WacliEvent) => void): void {
  const rl = createInterface({ input: stream });
  rl.on("line", (line) => {
    const s = line.trim();
    if (!s.startsWith("{")) return;
    try {
      const e = JSON.parse(s) as WacliEvent;
      if (e && typeof e.event === "string") onEvent(e);
    } catch {
      /* línea no-JSON (logs humanos) → ignorar */
    }
  });
}

// --- Enrollment ----------------------------------------------------------

export interface EnrollHandlers {
  /** Código de vinculación a relayar al usuario (lo ingresa en WhatsApp). */
  onPairCode: (code: string) => void;
  /** Conectó: el caller debe mintear el Bearer al vault + marcar la conexión. */
  onConnected: () => void;
}

export interface EnrollResult {
  connected: boolean;
  error?: string;
}

/**
 * Enrola WhatsApp para un usuario por pairing-code. Spawnea `wacli auth --phone …
 * --events`, parsea los eventos NDJSON y resuelve cuando el proceso termina (tras el
 * backfill) o por timeout. NO loguea el código ni números (van por los callbacks).
 */
export function enrollWhatsapp(userId: number, phone: string, h: EnrollHandlers): Promise<EnrollResult> {
  const store = wacliStoreDirForUser(userId);
  return new Promise((resolve) => {
    const child = spawn(WACLI_BIN, ["auth", "--phone", phone, "--store", store, "--events"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, WACLI_DEVICE_LABEL: DEVICE_LABEL },
    });
    let connected = false;
    let settled = false;
    const finish = (r: EnrollResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill("SIGTERM");
      resolve(r);
    };
    // Timer: primero esperamos el scan; al conectar, lo re-armamos corto para el backfill.
    let timer = setTimeout(
      () => finish({ connected, error: "timeout esperando que ingreses el código" }),
      ENROLL_WAIT_MS,
    );

    if (child.stderr) {
      onNdjson(child.stderr, (e) => {
        if (e.event === "pair_code" && typeof e.data?.code === "string") {
          h.onPairCode(e.data.code);
        } else if (e.event === "connected" && !connected) {
          connected = true;
          h.onConnected();
          clearTimeout(timer); // ya conectó: dale al backfill un margen acotado
          timer = setTimeout(() => finish({ connected: true }), BOOTSTRAP_MS);
        }
      });
    }
    child.on("error", (err) => finish({ connected, error: err.message }));
    child.on("exit", () => finish({ connected }));
  });
}

/** Logout de WhatsApp: invalida la sesión del linked-device. Best-effort. */
export function logoutWhatsapp(userId: number): Promise<void> {
  const store = wacliStoreDirForUser(userId);
  return new Promise((resolve) => {
    const child = spawn(WACLI_BIN, ["auth", "logout", "--store", store], { stdio: "ignore" });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}

// --- Follow atado a la sesión (L349) -------------------------------------

const followByUser = new Map<number, ChildProcess>();
const idleTimers = new Map<number, ReturnType<typeof setTimeout>>();

function startFollow(userId: number): void {
  if (followByUser.has(userId)) return;
  const store = wacliStoreDirForUser(userId);
  const child = spawn(WACLI_BIN, ["sync", "--follow", "--store", store], { stdio: "ignore" });
  followByUser.set(userId, child);
  const drop = () => {
    if (followByUser.get(userId) === child) followByUser.delete(userId);
  };
  child.on("exit", drop);
  child.on("error", drop);
}

/**
 * Señal de actividad de un usuario CONECTADO: arranca el follow (si no corría) y
 * resetea la ventana de inactividad. Sin actividad por FOLLOW_IDLE_MS → se apaga.
 * El caller sólo la llama si el usuario tiene WhatsApp conectado.
 */
export function noteActivity(userId: number): void {
  startFollow(userId);
  const prev = idleTimers.get(userId);
  if (prev) clearTimeout(prev);
  idleTimers.set(
    userId,
    setTimeout(() => stopFollow(userId), FOLLOW_IDLE_MS),
  );
}

/** Apaga el follow de un usuario (al desconectar, o por inactividad). */
export function stopFollow(userId: number): void {
  const t = idleTimers.get(userId);
  if (t) {
    clearTimeout(t);
    idleTimers.delete(userId);
  }
  const child = followByUser.get(userId);
  if (child) {
    followByUser.delete(userId);
    child.kill("SIGTERM");
  }
}

/** Apaga todos los follows (shutdown del gateway). */
export function stopAllFollows(): void {
  for (const userId of [...followByUser.keys()]) stopFollow(userId);
}
