// Canal `cli`: un unix socket local que habla NDJSON con `ceibo chat <handle>` /
// `ceibo broadcast`. Cada conexión es una sesión para un external_id; pasa
// por el MISMO `handleIncoming` que Telegram → ruteo, comandos y metering idénticos.
// Sólo accesible para quien tiene el socket (admin en la box) — superpoder de
// impersonación, consistente con que el CLI ya enrola por cualquier handle.
//
// Es además el PROTOTIPO del canal remoto (Fase 4.2): el mismo framing NDJSON-sobre-socket
// se generaliza a un transporte de red. El boundary es `CliPort`: el canal sólo conoce esa
// interfaz, nunca importa el core del gateway.

import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import type { ChannelPolicy, PostTarget } from "./types.ts";

// Política del canal cli: texto-nativo, eco de transcripción ON.
export const CLI_CHANNEL: ChannelPolicy = { name: "cli", echoTranscript: true };

// Lo que el canal cli necesita del core (boundary tipado). Interface segregation: declara
// exactamente las operaciones que invoca, ni una más. El gateway le inyecta una impl.
export type CliPort = {
  handleIncoming(channel: ChannelPolicy, externalId: string, text: string, thread: PostTarget): Promise<void>;
  // El canal sólo espera a que terminen (resuelve `done`); ignora el valor de retorno
  // → `Promise<unknown>` acepta tanto void como el `{sent,failed}` de sendBroadcast.
  sendBroadcast(text: string, emit: (line: string) => void): Promise<unknown>;
};

export type CliChannel = { close(): void };

export function startCliChannel(sockPath: string, port: CliPort): CliChannel {
  if (existsSync(sockPath)) unlinkSync(sockPath); // socket viejo de un crash previo

  const server = createServer((conn: Socket) => {
    let externalId: string | undefined;
    let buf = "";
    const send = (obj: unknown) => conn.write(`${JSON.stringify(obj)}\n`);
    // PostTarget de esta conexión: las respuestas del agente y los comandos vuelven por el
    // socket (mismo rol que el `thread` de Telegram).
    const target: PostTarget = {
      post: async (text: string) => void send({ t: "out", text }),
      startTyping: async () => void send({ t: "typing" }),
    };

    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: drain de líneas NDJSON
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: { t?: string; externalId?: string; text?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          send({ t: "error", e: "json inválido" });
          continue;
        }
        if (msg.t === "hello") {
          externalId = msg.externalId;
          send({ t: "ready" });
        } else if (msg.t === "msg" && externalId && typeof msg.text === "string") {
          void port
            .handleIncoming(CLI_CHANNEL, externalId, msg.text, target)
            .catch((e) => send({ t: "error", e: (e as Error)?.message ?? String(e) }));
        } else if (msg.t === "broadcast" && typeof msg.text === "string") {
          // Anuncio de la empresa a todos: lo manda `ceibo broadcast` (ya confirmado en la CLI).
          // El gateway hace el envío real (tiene el bot token) y refleja el progreso + cierra
          // con `done`. La CLI ya validó que hay texto y destinatarios.
          const text = msg.text;
          void port
            .sendBroadcast(text, (line) => send({ t: "out", text: line }))
            .then(() => send({ t: "done" }))
            .catch((e) => {
              send({ t: "error", e: (e as Error)?.message ?? String(e) });
              send({ t: "done" });
            });
        }
      }
    });
    conn.on("error", () => conn.destroy());
  });

  server.listen(sockPath);
  return { close: () => server.close() };
}
