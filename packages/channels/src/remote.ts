// Servidor del canal remoto (Fase 4.2). Acepta conexiones de un cliente de confianza
// (el web-server), las autentica con un secreto compartido, y traduce frames del protocolo
// ↔ el core del gateway:
//   - entrante: frame `msg`/`audio` (con `user`) → `port.handleIncoming(REMOTE_CHANNEL, user, …)`
//   - saliente: el core postea a un PostTarget por-usuario → frames `out`/`typing`/`heard`/`voice`
//
// MUX: una conexión multiplexa N usuarios (el `user` de cada frame los separa). El servidor
// guarda la conexión activa para poder EMPUJAR egress proactivo (crons/REM/viewer) a un
// usuario aunque no haya un turno en vuelo — `postTarget(user)` es la "ventanilla" remota,
// equivalente a la de telegram.
//
// El canal NO importa el core: recibe un `RemotePort`. Transporte abstraído (`unix` |
// `tls-tcp`); por ahora sólo `unix` (misma box). `tls-tcp` queda para cuando se separen cajas
// (Fase 4.6) — la superficie del protocolo ya lo contempla.

import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { type InboundMedia, publicErrorReason } from "@ceibo/agent";
import { isSubagentLabel } from "./activity.ts";
import {
  type AudioFrame,
  type ControlFrame,
  checkAuth,
  createFrameDecoder,
  encodeFrame,
  type MediaWire,
  type MsgFrame,
  type ServerFrame,
} from "./protocol.ts";
import type { ChannelPolicy, InboundAudio, PostTarget, TurnFact } from "./types.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

// Política del canal remoto: como el web, NO eco-por-texto de la transcripción (la vista
// muestra el `heard` estructurado). El `name` matchea la clave en la tabla `channels`.
export const REMOTE_CHANNEL: ChannelPolicy = { name: "web", echoTranscript: false };

// Lo que el canal remoto necesita del core (boundary tipado). `handleIncoming` para los
// turnos de usuario; `handleControl` para los frames de control fuera del flujo de turnos.
export type RemotePort = {
  handleIncoming(
    channel: ChannelPolicy,
    externalId: string,
    text: string,
    thread: PostTarget,
    extras?: { audio?: InboundAudio; media?: InboundMedia[]; facts?: TurnFact[] },
  ): Promise<void>;
  /**
   * Procesa un frame de control del canal remoto. No cuenta como turno, no dispara al modelo.
   * Hoy sólo `op: "reset-session"` está definido.
   */
  handleControl(frame: ControlFrame): void;
};

/** Adjuntos del cable → InboundMedia (los bytes ya viajan base64 en el frame; no hay fetch
 *  lazy como en audio). El kind/mime ya vienen validados por el web-server. */
function mediaFromWire(wire: MediaWire[] | undefined): InboundMedia[] | undefined {
  if (!wire?.length) return undefined;
  return wire.map((m) => ({
    kind: m.kind,
    data: m.data,
    mediaType: m.mediaType,
    ...(m.filename ? { filename: m.filename } : {}),
  }));
}

export type RemoteOpts = {
  /** Secreto compartido que el cliente presenta en el handshake `hello`. */
  secret: string;
  /** Transporte. `unix`: socket path local (default). `tls-tcp`: pendiente (Fase 4.6). */
  transport?: { kind: "unix"; path: string } | { kind: "tls-tcp"; port: number };
  log?: (s: string) => void;
};

export type RemoteChannel = {
  /** Egress proactivo hacia un usuario por la conexión activa (crons/REM/viewer). Si no hay
   *  cliente conectado, los posts se descartan silenciosamente (la vista está offline). */
  postTarget(user: string): PostTarget;
  close(): void;
};

export function startRemoteChannel(opts: RemoteOpts, port: RemotePort): RemoteChannel {
  const log = opts.log ?? (() => {});
  const transport = opts.transport ?? { kind: "unix", path: "/tmp/ceibo-remote.sock" };
  if (transport.kind === "tls-tcp") {
    throw new Error("transporte tls-tcp del canal remoto: pendiente (Fase 4.6)");
  }

  // Conexiones autenticadas vivas. Para el mux de egress proactivo basta con poder escribir
  // a CUALQUIER conexión autenticada (el cliente demultiplexa por `user`); guardamos el set.
  const live = new Set<Socket>();
  const sendTo = (conn: Socket, frame: ServerFrame) => conn.write(encodeFrame(frame));
  const broadcast = (frame: ServerFrame) => {
    for (const conn of live) conn.write(encodeFrame(frame));
  };

  // PostTarget que emite frames de respuesta para `user` por una conexión dada (turno) o por
  // todas las vivas (egress proactivo). `origin` (opcional) se estampa en cada frame: cuando
  // viene de un turno, es el id de la vista que preguntó → el cliente entrega sólo a ésa.
  // En el egress proactivo no hay turno → sin origin → el cliente abanica a todas las vistas.
  const makeTarget = (user: string, emit: (f: ServerFrame) => void, origin?: string): PostTarget => {
    const o = origin ? { origin } : {};
    return {
      post: async (text) => void emit({ t: "out", user, text, ...o }),
      startTyping: async () => void emit({ t: "typing", user, ...o }),
      // Actividad: SIEMPRE emitimos el frame (la web lo usa como indicador efímero en el chat);
      // `debug` se ignora acá — la web no spamea, sólo refleja lo que pasa. Mandamos `label`
      // (amable, para el indicador) y `detail` (params, opcional) por separado: la web decide qué
      // pintar dónde (indicador = label; log de debug = label + detail). Si el label corresponde a
      // un sub-agente del roster, marcamos `kind:"subagent"` para que la web encienda el indicador
      // dedicado/persistente (en vez del hint efímero que se pisa con cada tool-call).
      activity: async (label, opts) =>
        void emit({
          t: "activity",
          user,
          label,
          ...(opts?.detail ? { detail: opts.detail } : {}),
          ...(isSubagentLabel(label) ? { kind: "subagent" as const } : {}),
          ...o,
        }),
      // Título del chat (tema actual): el gateway lo genera tras un turno con sustancia; lo
      // emitimos como frame `chat-title` y el cliente (web-server → SSE) lo pinta en el header.
      chatTitle: async (title) => void emit({ t: "chat-title", user, title, ...o }),
      // Fin del turno real (`turnComplete`): emitimos `turn-done` con el `origin` del turno → la
      // web cierra el indicador efímero de actividad del chat SÓLO acá (no con un `out` intermedio).
      turnDone: async () => void emit({ t: "turn-done", user, ...o }),
      // Conteo de sub-agentes vivos → frame `subagents`: la web dibuja N mini-orbs en el orb.
      subagents: async (count) => void emit({ t: "subagents", user, count, ...o }),
      // Aviso de sistema (compactada / reiniciada) → frame `notice`: la web lo pinta como una línea
      // de sistema atenuada. El clear diario lo emite sin turno → sin `origin` → a todas las vistas.
      notice: async (text) => void emit({ t: "notice", user, text, ...o }),
      // Inbox (feature crons-delivery): el gateway persistió un cron de canal `web` y avisa con el
      // conteo de no-leídos → frame `inbox`: la web sube el badge del FAB 🔔. Egress proactivo (sin
      // turno) → sin `origin` → a todas las vistas del usuario.
      inbox: async (count) => void emit({ t: "inbox", user, count, ...o }),
      postHeard: async (text) => void emit({ t: "heard", user, text, ...o }),
      postVoice: async (ogg, text) =>
        void emit({ t: "voice", user, mime: "audio/ogg", bytes: ogg.toString("base64"), text, ...o }),
    };
  };

  const onMsg = (conn: Socket, f: MsgFrame) => {
    const target = makeTarget(f.user, (fr) => sendTo(conn, fr), f.origin);
    void port
      .handleIncoming(REMOTE_CHANNEL, f.user, f.text, target, {
        media: mediaFromWire(f.media),
        facts: f.facts,
      })
      .catch((e) =>
        sendTo(conn, {
          t: "error",
          user: f.user,
          // Red de seguridad: si un error escapa hasta acá, NUNCA mandamos el `.message` crudo al
          // browser (traería interna: env id, "cold-start", "intentos", "fetch failed"). El gateway
          // ya redacta sus errores, pero esta capa cubre cualquier fuga futura por otra vía.
          error: publicErrorReason(e, "⚠️ Algo falló procesando tu pedido. Probá de nuevo en unos segundos."),
          ...(f.origin ? { origin: f.origin } : {}),
        }),
      );
  };

  const onAudio = (conn: Socket, f: AudioFrame) => {
    const target = makeTarget(f.user, (fr) => sendTo(conn, fr), f.origin);
    // El audio llega base64 en el frame; lo exponemos como InboundAudio (fetchData lazy).
    const audio: InboundAudio = { fetchData: async () => Buffer.from(f.bytes, "base64"), mime: f.mime };
    void port.handleIncoming(REMOTE_CHANNEL, f.user, "", target, { audio, facts: f.facts }).catch((e) =>
      sendTo(conn, {
        t: "error",
        user: f.user,
        // Misma red de seguridad que el path de texto: nunca el `.message` crudo al browser.
        error: publicErrorReason(e, "⚠️ Algo falló procesando tu pedido. Probá de nuevo en unos segundos."),
        ...(f.origin ? { origin: f.origin } : {}),
      }),
    );
  };

  const server: Server = createServer((conn: Socket) => {
    let authed = false;
    const decoder = createFrameDecoder();
    conn.on("data", (chunk) => {
      for (const frame of decoder.push(chunk.toString("utf8"))) {
        if (!authed) {
          // Hasta autenticar, sólo se acepta el hello.
          if (frame.t === "hello" && checkAuth(frame.auth, opts.secret)) {
            authed = true;
            live.add(conn);
            sendTo(conn, { t: "auth-ok" });
            log(dim("canal remoto: cliente autenticado"));
          } else {
            sendTo(conn, { t: "auth-err", reason: "auth inválida" });
            conn.destroy();
          }
          continue;
        }
        if (frame.t === "msg") onMsg(conn, frame);
        else if (frame.t === "audio") onAudio(conn, frame);
        else if (frame.t === "control") port.handleControl(frame);
        // otros tipos cliente→servidor: se ignoran.
      }
    });
    const drop = () => {
      live.delete(conn);
    };
    conn.on("close", drop);
    conn.on("error", () => {
      drop();
      conn.destroy();
    });
  });

  if (existsSync(transport.path)) unlinkSync(transport.path); // socket viejo de un crash
  server.listen(transport.path);
  log(dim(`canal remoto escuchando en ${transport.path}`));

  return {
    postTarget: (user: string) => makeTarget(user, (fr) => broadcast(fr)),
    close: () => {
      for (const conn of live) conn.destroy();
      live.clear();
      server.close();
      try {
        if (existsSync(transport.path)) unlinkSync(transport.path);
      } catch {}
    },
  };
}
