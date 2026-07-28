// Cliente del canal remoto (Fase 4.2). Lo usa el web-server (Fase 4.3) para conectarse al
// gateway "como un canal más" por red. Encapsula: conexión + handshake auth + (re)envío de
// frames + demux de los frames servidor→cliente hacia callbacks por-usuario.
//
// El web-server ya autenticó a sus usuarios (cookie/magic-link); este cliente afirma al
// gateway "este frame es del usuario X" presentando el secreto compartido en el hello.

import { connect, type Socket } from "node:net";
import {
  type AudioFrame,
  type ControlFrame,
  createFrameDecoder,
  encodeFrame,
  type MediaWire,
  type MsgFrame,
  type ServerFrame,
  type TurnFactWire,
} from "./protocol.ts";

export type RemoteClientOpts = {
  secret: string;
  transport?: { kind: "unix"; path: string } | { kind: "tls-tcp"; host: string; port: number };
  /** Frames servidor→cliente, ya parseados. El web-server los abanica a sus SSE por `user`. */
  onFrame(frame: ServerFrame): void;
  /** Conexión lista (auth-ok). */
  onReady?(): void;
  /** Conexión caída (close/error). El web-server puede reintentar. */
  onClose?(): void;
  log?: (s: string) => void;
};

export type RemoteClient = {
  /** Manda texto de un usuario al agente. `media` adjunta imágenes/PDF (chat web). `origin` =
   *  id opaco de la vista que originó el turno (el gateway lo rebota en la respuesta). */
  sendText(user: string, text: string, facts?: TurnFactWire[], media?: MediaWire[], origin?: string): void;
  /** Manda audio (Buffer) de un usuario; el gateway transcribe. `origin`: ver `sendText`. */
  sendAudio(user: string, bytes: Buffer, mime?: string, facts?: TurnFactWire[], origin?: string): void;
  /**
   * Envía un frame de CONTROL al gateway (fuera del flujo de turnos).
   * `op: "reset-session"` + `userId`: el gateway recrea la sesión MA del usuario si existe.
   * Best-effort: si la conexión no está autenticada, el frame se descarta silenciosamente.
   */
  sendControl(op: ControlFrame["op"], userId: number): void;
  close(): void;
};

export function connectRemoteChannel(opts: RemoteClientOpts): RemoteClient {
  const log = opts.log ?? (() => {});
  const transport = opts.transport ?? { kind: "unix", path: "/tmp/ceibo-remote.sock" };
  if (transport.kind === "tls-tcp") {
    throw new Error("transporte tls-tcp del canal remoto: pendiente (Fase 4.6)");
  }

  let authed = false;
  const decoder = createFrameDecoder();
  const conn: Socket = connect(transport.path);

  const write = (frame: MsgFrame | AudioFrame | ControlFrame) => {
    if (!authed) {
      log("canal remoto: descarto frame (todavía no autenticado)");
      return;
    }
    conn.write(encodeFrame(frame));
  };

  conn.on("connect", () => {
    conn.write(encodeFrame({ t: "hello", auth: opts.secret }));
  });

  conn.on("data", (chunk) => {
    for (const frame of decoder.push(chunk.toString("utf8"))) {
      if (frame.t === "auth-ok") {
        authed = true;
        opts.onReady?.();
        log("canal remoto: conectado");
        continue;
      }
      if (frame.t === "auth-err") {
        log(`canal remoto: auth rechazada (${frame.reason})`);
        conn.destroy();
        continue;
      }
      opts.onFrame(frame as ServerFrame);
    }
  });

  // `onClose` se dispara cuando la conexión TERMINA o FALLA — incluso si nunca llegó a
  // autenticar (ej. el servidor todavía no levantó el socket en un arranque-en-frío). El
  // entry-point reintenta. Guard `down` para no dispararlo dos veces (close + error juntos).
  let down = false;
  const onDown = () => {
    if (down) return;
    down = true;
    authed = false;
    opts.onClose?.();
  };
  conn.on("close", onDown);
  conn.on("error", () => {
    onDown();
    conn.destroy();
  });

  return {
    sendText: (user, text, facts, media, origin) =>
      write({
        t: "msg",
        user,
        text,
        ...(media?.length ? { media } : {}),
        facts,
        ...(origin ? { origin } : {}),
      }),
    sendAudio: (user, bytes, mime, facts, origin) =>
      write({
        t: "audio",
        user,
        mime,
        bytes: bytes.toString("base64"),
        facts,
        ...(origin ? { origin } : {}),
      }),
    sendControl: (op, userId) => write({ t: "control", op, userId }),
    close: () => conn.destroy(),
  };
}
