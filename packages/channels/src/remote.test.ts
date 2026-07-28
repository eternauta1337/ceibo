import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ClientFrame,
  createFrameDecoder,
  type ErrorFrame,
  encodeFrame,
  type ServerFrame,
} from "./protocol.ts";
import { type RemotePort, startRemoteChannel } from "./remote.ts";

// Red de seguridad del canal (incidente 2026-06-10 / fix friendly-backend-errors): cuando el
// `handleIncoming` del core rechaza con un error que trae interna (env id, "cold-start",
// "intentos", "fetch failed"), el frame `error` que llega al browser NUNCA debe contener ese
// crudo — sale el fallback amable de `publicErrorReason`. Manejamos un server real sobre un
// socket unix y un cliente mínimo para observar el frame que recibe la web.

const SECRET = "test-secret";

function makePort(reject: unknown): RemotePort {
  return {
    handleIncoming: () => Promise.reject(reject),
    handleControl: () => {},
  };
}

/** Conecta un cliente, hace el handshake, manda `send` y resuelve con el PRIMER frame `error`. */
function exchange(sockPath: string, send: ClientFrame): Promise<ErrorFrame> {
  return new Promise((resolve, reject) => {
    const conn: Socket = createConnection(sockPath);
    const decoder = createFrameDecoder();
    const timer = setTimeout(() => reject(new Error("timeout esperando frame error")), 2000);
    conn.on("data", (chunk) => {
      for (const frame of decoder.push(chunk.toString("utf8")) as ServerFrame[]) {
        if (frame.t === "auth-ok") {
          conn.write(encodeFrame(send));
        } else if (frame.t === "error") {
          clearTimeout(timer);
          conn.end();
          resolve(frame);
        }
      }
    });
    conn.on("error", reject);
    conn.on("connect", () => conn.write(encodeFrame({ t: "hello", auth: SECRET })));
  });
}

describe("startRemoteChannel — el frame de error NUNCA filtra interna al browser", () => {
  let channel: { close(): void } | undefined;
  afterEach(() => channel?.close());

  const sockPath = () => join(tmpdir(), `ceibo-remote-test-${Math.random().toString(36).slice(2)}.sock`);

  it("turno de texto que rechaza con interna → frame error con el fallback amable", async () => {
    const path = sockPath();
    const internal = new Error(
      "opencode cold-start de ceibo-demo-env_013CMPPUUQY4YWv8ZFafECzg falló tras 8 intentos: fetch failed",
    );
    channel = startRemoteChannel({ secret: SECRET, transport: { kind: "unix", path } }, makePort(internal));
    const frame = await exchange(path, { t: "msg", user: "u1", text: "hola" });
    expect(frame.t).toBe("error");
    const msg = frame.error;
    // No filtra NADA de la interna del error.
    expect(msg).not.toContain("env_013");
    expect(msg).not.toContain("cold-start");
    expect(msg).not.toContain("intentos");
    expect(msg).not.toContain("fetch failed");
    expect(msg).not.toContain("opencode");
    // Sale el fallback amable.
    expect(msg).toContain("Probá de nuevo");
  });

  it("turno de audio que rechaza con interna → mismo saneo", async () => {
    const path = sockPath();
    channel = startRemoteChannel(
      { secret: SECRET, transport: { kind: "unix", path } },
      makePort(new Error("cp.sh serve vm1 exit 1: archima no respondió")),
    );
    const frame = await exchange(path, {
      t: "audio",
      user: "u1",
      bytes: Buffer.from("x").toString("base64"),
    });
    const msg = frame.error;
    expect(msg).not.toContain("cp.sh");
    expect(msg).not.toContain("archima");
    expect(msg).toContain("Probá de nuevo");
  });
});
