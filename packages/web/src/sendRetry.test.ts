// Tests del envío resiliente (sendRetry.ts): timeout + retry/backoff + clasificación de
// fallos. fetch y sleep fakes inyectados — sin red ni timers reales (salvo el test del
// timeout, que usa un AbortSignal real con un timeout de ms).
import { describe, expect, it } from "vitest";
import {
  retryableFailure,
  retryableStatus,
  SEND_RETRY_DELAYS_MS,
  type SendResult,
  sendFailureMessage,
  sendWithRetry,
} from "./sendRetry.ts";

/** fetch fake que responde según un guion: cada entrada es un status HTTP, "network"
 *  (rechaza como fallo de red) o "hang" (no resuelve hasta que el AbortSignal corte). */
function fakeFetch(script: (number | "network" | "hang")[]) {
  const calls: { body: string }[] = [];
  const sleeps: number[] = [];
  const fetchFn = ((_url: string, init?: RequestInit) => {
    calls.push({ body: String(init?.body) });
    const step = script.shift() ?? "network";
    if (step === "network") return Promise.reject(new TypeError("failed to fetch"));
    if (step === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return Promise.resolve({ ok: step >= 200 && step < 300, status: step } as Response);
  }) as typeof fetch;
  const sleep = (ms: number) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  return { fetchFn, sleep, calls, sleeps };
}

const send = (f: ReturnType<typeof fakeFetch>, opts?: { timeoutMs?: number; retryDelaysMs?: number[] }) =>
  sendWithRetry("/api/send", '{"t":"text"}', {
    timeoutMs: opts?.timeoutMs ?? 1_000,
    ...(opts?.retryDelaysMs ? { retryDelaysMs: opts.retryDelaysMs } : {}),
    fetchFn: f.fetchFn,
    sleep: f.sleep,
  });

describe("sendWithRetry", () => {
  it("éxito al primer intento → ok, un solo fetch, sin esperas", async () => {
    const f = fakeFetch([202]);
    expect(await send(f)).toEqual({ ok: true });
    expect(f.calls.length).toBe(1);
    expect(f.sleeps).toEqual([]);
  });

  it("fallo de red transitorio → reintenta con el backoff y termina ok", async () => {
    const f = fakeFetch(["network", "network", 202]);
    expect(await send(f)).toEqual({ ok: true });
    expect(f.calls.length).toBe(3);
    expect(f.sleeps).toEqual(SEND_RETRY_DELAYS_MS);
  });

  it("red caída persistente → agota los reintentos y devuelve el fallo (no lanza)", async () => {
    const f = fakeFetch(["network", "network", "network"]);
    expect(await send(f)).toEqual({ ok: false, reason: "network" });
    expect(f.calls.length).toBe(1 + SEND_RETRY_DELAYS_MS.length);
  });

  it("5xx transitorio → reintenta; si después entra, ok", async () => {
    const f = fakeFetch([502, 202]);
    expect(await send(f)).toEqual({ ok: true });
    expect(f.calls.length).toBe(2);
  });

  it("5xx persistente → devuelve el último status tras agotar", async () => {
    const f = fakeFetch([500, 500, 503]);
    expect(await send(f)).toEqual({ ok: false, reason: "http", status: 503 });
    expect(f.calls.length).toBe(3);
  });

  it("413 (body demasiado grande) → terminal: NO reintenta", async () => {
    const f = fakeFetch([413, 202]);
    expect(await send(f)).toEqual({ ok: false, reason: "http", status: 413 });
    expect(f.calls.length).toBe(1);
    expect(f.sleeps).toEqual([]);
  });

  it("401 (sesión vencida) → terminal: NO reintenta", async () => {
    const f = fakeFetch([401]);
    expect(await send(f)).toEqual({ ok: false, reason: "http", status: 401 });
    expect(f.calls.length).toBe(1);
  });

  it("429 (rate-limit) cuenta como transitorio → reintenta", async () => {
    const f = fakeFetch([429, 202]);
    expect(await send(f)).toEqual({ ok: true });
    expect(f.calls.length).toBe(2);
  });

  it("timeout: un fetch colgado se aborta y cuenta como fallo de red", async () => {
    const f = fakeFetch(["hang", 202]);
    expect(await send(f, { timeoutMs: 5 })).toEqual({ ok: true });
    expect(f.calls.length).toBe(2);
  });

  it("retryDelaysMs [] = sin reintentos (un solo intento)", async () => {
    const f = fakeFetch(["network", 202]);
    expect(await send(f, { retryDelaysMs: [] })).toEqual({ ok: false, reason: "network" });
    expect(f.calls.length).toBe(1);
  });
});

describe("retryableStatus / retryableFailure", () => {
  it("transitorios: 5xx, 408, 429", () => {
    for (const s of [500, 502, 503, 504, 408, 429]) expect(retryableStatus(s)).toBe(true);
  });
  it("terminales: el resto de los 4xx (incl. 413) y los 2xx/3xx", () => {
    for (const s of [400, 401, 403, 404, 413, 200, 302]) expect(retryableStatus(s)).toBe(false);
  });
  it("retryableFailure: red sí, 502 sí, 413 no", () => {
    expect(retryableFailure({ ok: false, reason: "network" })).toBe(true);
    expect(retryableFailure({ ok: false, reason: "http", status: 502 })).toBe(true);
    expect(retryableFailure({ ok: false, reason: "http", status: 413 })).toBe(false);
  });
});

describe("sendFailureMessage", () => {
  const msg = (r: Exclude<SendResult, { ok: true }>, kind: "text" | "audio") => sendFailureMessage(r, kind);
  it("413 de audio dice la verdad: demasiado largo", () => {
    expect(msg({ ok: false, reason: "http", status: 413 }, "audio")).toMatch(/demasiado largo/);
  });
  it("413 de texto apunta a los adjuntos", () => {
    expect(msg({ ok: false, reason: "http", status: 413 }, "text")).toMatch(/demasiado grande/);
  });
  it("fallo de red invita a reintentar", () => {
    expect(msg({ ok: false, reason: "network" }, "text")).toMatch(/reintentá/);
    expect(msg({ ok: false, reason: "network" }, "audio")).toMatch(/audio/);
  });
  it("5xx agotado también invita a reintentar (transitorio)", () => {
    expect(msg({ ok: false, reason: "http", status: 502 }, "text")).toMatch(/reintentá/);
  });
  it("4xx terminal no-413 muestra el código", () => {
    expect(msg({ ok: false, reason: "http", status: 401 }, "text")).toMatch(/401/);
  });
});
