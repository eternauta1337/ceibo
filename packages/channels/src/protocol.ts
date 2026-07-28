// Protocolo del canal remoto (Fase 4.2). Generaliza el framing NDJSON-sobre-socket que ya
// usa el `cli` a un canal de red de primera clase: el gateway lo ve como un canal más
// (telegram, cli), pero el cliente (web-server, y a futuro mobile) se conecta POR RED.
//
// Diferencias con el cli:
//   - AUTH de conexión: una conexión remota es un SERVICIO de confianza (el web-server), no
//     un usuario. Se autentica con un secreto compartido (`REMOTE_CHANNEL_SECRET`). El
//     web-server ya autenticó a sus usuarios (cookie/magic-link) y es de confianza para
//     afirmar "este frame es del usuario X".
//   - MUX por-usuario: UNA conexión multiplexa N usuarios. Cada frame lleva `user`
//     (el externalId), así el gateway rutea a `ctxByUser` y el cliente demultiplexa a sus
//     vistas locales (SSE).
//   - AUDIO binario: el cli es solo texto; acá el audio viaja en el frame (base64), lo que
//     habilita voz por el canal remoto.
//
// Transporte: NDJSON (una línea JSON por frame). El binario (audio) va base64 dentro del
// JSON — mismo criterio que ya usa el canal web (`ogg.toString("base64")`). Simple y
// suficiente; si el volumen de audio lo exige, un framing binario es una optimización futura.

import { createHmac, timingSafeEqual } from "node:crypto";

// --- Frames cliente → servidor (web-server → gateway) ---------------------

/** Handshake de conexión. Primer frame; el servidor responde auth-ok | auth-err. */
export type HelloFrame = { t: "hello"; auth: string };
/** Adjunto entrante (imagen/PDF) que el modelo VE como content block. `data` = base64
 *  estándar; `mediaType` el MIME. Espeja `InboundMedia` de `@ceibo/agent` en el cable. */
export type MediaWire = { kind: "image" | "document"; mediaType: string; data: string; filename?: string };
/** Mensaje de texto entrante de un usuario. `facts` = metadata de turno (canal, vista, …).
 *  `media` adjunta imágenes/PDF (chat web): el modelo las ve junto al texto. Puede venir sin
 *  texto (sólo adjuntos) — el core acepta turno con media y sin línea.
 *  `origin` = id opaco de la vista que originó el turno (ej. el stream SSE del dispositivo que
 *  preguntó). El gateway NO lo interpreta: lo rebota tal cual en los frames de respuesta del
 *  turno para que el cliente entregue la respuesta SÓLO a esa vista (evita el eco multi-device). */
export type MsgFrame = {
  t: "msg";
  user: string;
  text: string;
  media?: MediaWire[];
  facts?: TurnFactWire[];
  origin?: string;
};
/** Audio entrante de un usuario (base64). Sin texto → el gateway transcribe (STT).
 *  `origin`: ver `MsgFrame`. */
export type AudioFrame = {
  t: "audio";
  user: string;
  mime?: string;
  bytes: string;
  facts?: TurnFactWire[];
  origin?: string;
};

/**
 * Frame de CONTROL (web-server → gateway): operaciones fuera del flujo de turnos.
 * No cuenta como turno, no dispara al modelo; es una señal del plano de control.
 *
 * `op: "reset-session"` + `userId` (número): el gateway recrea la sesión MA viva del
 * usuario (si existe). Si hay un turno en vuelo, el reset se difiere al cierre del turno.
 * Si no hay sesión viva, es no-op silencioso.
 */
export type ControlFrame = {
  t: "control";
  op: "reset-session";
  userId: number;
};

export type ClientFrame = HelloFrame | MsgFrame | AudioFrame | ControlFrame;

// --- Frames servidor → cliente (gateway → web-server) ---------------------

export type AuthOkFrame = { t: "auth-ok" };
export type AuthErrFrame = { t: "auth-err"; reason: string };
// `origin` (opcional) en los frames de respuesta: cuando viene, es el `origin` del turno que
// los disparó (rebotado por el canal remoto). El cliente entrega SÓLO a esa vista. Ausente =
// egress proactivo (crons/REM/viewer): se abanica a todas las vistas del usuario.
/** Respuesta del agente (post) para un usuario. */
export type OutFrame = { t: "out"; user: string; text: string; origin?: string };
export type TypingFrame = { t: "typing"; user: string; origin?: string };
/** Eco estructurado de la transcripción STT (lo que dijo el usuario). */
export type HeardFrame = { t: "heard"; user: string; text: string; origin?: string };
/** Respuesta en voz (TTS, base64). `text` = la transcripción (lo que se sintetizó), para
 *  que las vistas que muestran texto junto al audio (web) la pinten en el chat. */
export type VoiceFrame = {
  t: "voice";
  user: string;
  mime: string;
  bytes: string;
  text?: string;
  origin?: string;
};
/** Navegación: "abrí esta nota" (viewer por egress, Fase 4.4). Vistas sin viewer la ignoran. */
export type ViewerFrame = { t: "viewer"; user: string; repo: string; path: string; origin?: string };
/** El agente creó una nota (viewer_create). */
export type CreatedFrame = {
  t: "created";
  user: string;
  repo: string;
  path: string;
  sha: string;
  origin?: string;
};
export type ErrorFrame = { t: "error"; user?: string; error: string; origin?: string };
/**
 * Actividad del agente: un tool-call / sub-agente arrancó en el turno (modo debug + hint
 * always-on de la web). `label` y `detail` vienen YA HUMANIZADOS server-side (ver
 * `activityLabel` de `@ceibo/channels`) → la vista los pinta directo, sin mapear nada.
 *
 * `label` = el verbo amable SIN params ("corriendo un comando"); lo usa el hint always-on bajo
 * el orb (visible también con debug off). `detail` = el resumen de params ("node /mnt/…"),
 * OPCIONAL; sólo se muestra en superficies de debug (el log de la web con el toggle; Telegram
 * con `/debug on`). Separarlos evita filtrar el comando crudo al hint cuando debug está off.
 *
 * Se emite SIEMPRE (no sólo en debug): la web lo usa como indicador efímero en el chat
 * ("buscando en la wiki…"). Telegram, en cambio, sólo lo MUESTRA cuando el usuario tiene
 * `/debug on` (esa decisión es del canal, no del frame). `origin`: ver los otros frames
 * (presente = una vista puntual; ausente = egress proactivo → todas las vistas del usuario).
 *
 * `kind: "subagent"` marca que esta actividad NO es un tool-call normal sino el spawn de un
 * sub-agente del roster (worker-low/mid/high). La web lo usa para encender un indicador DEDICADO
 * y PERSISTENTE (distinto del hint efímero, que se pisa con cada tool-call). Ausente = tool-call
 * normal. Lo deriva el canal del `label` ya humanizado (ver `isSubagentLabel`).
 */
export type ActivityFrame = {
  t: "activity";
  user: string;
  label: string;
  detail?: string;
  kind?: "subagent";
  origin?: string;
};
/** Título del chat (tema actual): resumen semántico corto (2-5 palabras) que el gateway genera
 *  con un modelo barato tras un turno interactivo con sustancia. La vista lo pinta en el header
 *  del chat (reemplaza el "Chat: <fecha>" estático). `origin`: ver los otros frames (presente =
 *  una vista puntual; ausente = todas las vistas del usuario). */
export type ChatTitleFrame = { t: "chat-title"; user: string; title: string; origin?: string };
/** Fin del turno REAL del agente (`session.status_idle` con `end_turn`). Señal limpia de "el
 *  turno terminó", distinta de los frames de respuesta (`out`/`voice`), que pueden ser
 *  intermedios. La web la usa para apagar el indicador persistente de sub-agente recién al
 *  cerrar el turno. `origin`: presente = la vista que preguntó; ausente = todas las del usuario. */
export type TurnDoneFrame = { t: "turn-done"; user: string; origin?: string };
/** Cantidad de sub-agentes ACTIVOS del agente AHORA (concurrentes incluidos). La web la usa para
 *  decorar el orb con N mini-orbs (un satélite por sub-agente vivo). `count` es absoluto (reemplaza
 *  el valor previo); 0 = ninguno. El gateway la deriva de `Sink.subagents` (archima: tool-calls
 *  `task` en `running`; MA: threads vivos). `origin`: presente = la vista que preguntó; ausente =
 *  todas las vistas del usuario. */
export type SubagentsFrame = { t: "subagents"; user: string; count: number; origin?: string };
/** Aviso de SISTEMA neutro del plano de sesión, visible para el usuario: "conversación compactada"
 *  (auto-compaction de opencode) o "conversación reiniciada" (clear diario). Distinto de `out` (voz
 *  del agente) y de `error` (semántica de error). La web lo pinta como una línea de sistema atenuada.
 *  `origin`: presente = la vista que preguntó; ausente = egress proactivo → todas las vistas del
 *  usuario (el clear diario no tiene turno → sin origin → se abanica). */
export type NoticeFrame = { t: "notice"; user: string; text: string; origin?: string };
/** Item nuevo en el inbox del agente (feature crons-delivery): un cron creado en web disparó y
 *  su resultado se persistió en el inbox durable. Este frame es el push EN VIVO para que el badge
 *  del FAB 🔔 suba al instante si la vista está abierta; NO trae el body (la burbuja se baja por
 *  click vía GET /api/inbox). `count` = no-leídos absolutos tras insertar. Egress proactivo (el
 *  cron no tiene turno) → sin `origin` → se abanica a todas las vistas del usuario. */
export type InboxFrame = { t: "inbox"; user: string; count: number; origin?: string };

export type ServerFrame =
  | AuthOkFrame
  | AuthErrFrame
  | OutFrame
  | TypingFrame
  | HeardFrame
  | VoiceFrame
  | ViewerFrame
  | CreatedFrame
  | ActivityFrame
  | ChatTitleFrame
  | TurnDoneFrame
  | SubagentsFrame
  | NoticeFrame
  | InboxFrame
  | ErrorFrame;

export type AnyFrame = ClientFrame | ServerFrame;

/** TurnFact en el cable (mismo shape que el TurnFact del core; copiado para no acoplar). */
export type TurnFactWire = { label: string; value: string };

// --- Serialización NDJSON -------------------------------------------------

/** Serializa un frame a una línea NDJSON (con el `\n` terminador). */
export function encodeFrame(frame: AnyFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Decodificador NDJSON con buffer incremental. Acumulá chunks con `push`; devuelve los
 * frames completos drenados (las líneas mal formadas se saltean). El estado vive en el
 * objeto que devuelve `createFrameDecoder` — uno por conexión.
 */
export function createFrameDecoder(): { push(chunk: string): AnyFrame[] } {
  let buf = "";
  return {
    push(chunk: string): AnyFrame[] {
      buf += chunk;
      const out: AnyFrame[] = [];
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: drain de líneas NDJSON
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const f = JSON.parse(line) as AnyFrame;
          if (f && typeof (f as { t?: unknown }).t === "string") out.push(f);
        } catch {
          /* línea no-JSON → ignorar */
        }
      }
      return out;
    },
  };
}

// --- Auth de conexión -----------------------------------------------------

// El secreto se compara en tiempo constante (evita timing oracle). El "token" del cliente
// es directamente el secreto compartido — no hay userId acá: la conexión es del servicio,
// la identidad de usuario viaja por-frame.

/** ¿El `auth` presentado por el cliente coincide con el secreto del servidor? Constante en t. */
export function checkAuth(presented: string, secret: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Firma opcional para derivar el secreto de conexión de una clave madre (paridad con el
 * patrón viewer/schedule). El cliente y el servidor comparten `key` y usan el mismo `label`.
 */
export function deriveConnSecret(key: string, label = "remote-channel"): string {
  return createHmac("sha256", key).update(label).digest("base64url");
}
