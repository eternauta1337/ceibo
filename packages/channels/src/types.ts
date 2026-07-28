// Contrato compartido de la capa de canales. Channel-agnostic: lo usan el canal Telegram,
// el `cli` (unix socket), el `web` (HTTP+SSE) y, a futuro, el canal remoto + viewer por
// egress. El núcleo del gateway despacha contra estos tipos sin saber qué canal es.

// Destino de respuesta de un canal (el "thread"). El núcleo `handleIncoming` postea acá
// sin saber qué canal es. `postVoice` es opcional: Telegram y web lo implementan, el
// `cli` no (cae a texto).
export type PostTarget = {
  post(text: string): Promise<unknown>;
  startTyping(): Promise<unknown>;
  /** `text` = la transcripción de la respuesta (lo que se sintetizó). Los canales que
   *  muestran texto junto al audio (web) la usan; los texto-nativos (telegram) la ignoran. */
  postVoice?(ogg: Buffer, text?: string): Promise<unknown>;
  /** Eco estructurado de la transcripción STT (lo que dijo el usuario), separado de la
   *  respuesta del agente. Lo implementa el canal web (lo muestra arriba de la respuesta);
   *  los canales texto-nativos (telegram/cli) no lo tienen y caen al eco por `post` vía
   *  `echoTranscript`. */
  postHeard?(text: string): Promise<unknown>;
  /** Señal de progreso: el agente arrancó un tool-call / sub-agente. `label` (verbo amable, SIN
   *  params) y `opts.detail` (resumen de params, opcional) vienen YA humanizados (ver
   *  `activityLabel`). `opts.debug` = el usuario tiene el modo debug on.
   *
   *  Cada canal decide cuán "ruidoso" ser:
   *   - canal remoto (web): emite SIEMPRE el frame `activity` con `label` + `detail` (ignora
   *     `debug`); la web usa `label` como hint always-on bajo el orb y `label`+`detail` en el
   *     log del modo debug;
   *   - telegram: sólo POSTEA cuando `opts.debug` (sino, no-op — evita spam), y ahí muestra
   *     `label: detail` (con el detalle, porque es una superficie de debug);
   *   - cli: no lo implementa (opcional).
   *  El typing/sendChatAction lo sigue manejando el gateway por separado (no acá). */
  activity?(label: string, opts?: { debug?: boolean; detail?: string }): Promise<unknown> | void;
  /** Título del chat (tema actual): un resumen semántico corto del tema en curso, generado por
   *  el gateway tras un turno interactivo. Lo implementa el canal remoto (web) → emite el frame
   *  `chat-title`; los canales sin header de chat (telegram/cli) no lo implementan (no-op). */
  chatTitle?(title: string): Promise<unknown> | void;
  /** Fin del turno REAL (`session.status_idle` con `end_turn`): la señal limpia de "el agente
   *  terminó". Lo implementa el canal remoto (web) → emite el frame `turn-done`; la web la usa
   *  para APAGAR el indicador persistente de sub-agente (no antes — un `text` intermedio del
   *  turno NO es fin de turno). Los canales sin indicador persistente (telegram/cli) no lo
   *  implementan (no-op). */
  turnDone?(): Promise<unknown> | void;
  /** Cantidad de sub-agentes ACTIVOS del agente AHORA (concurrentes incluidos). La alimenta el
   *  backend vía `Sink.subagents` (archima: tool-calls `task` en `running`; MA: threads vivos del
   *  roster). Lo implementa el canal remoto (web) → emite el frame `subagents`; la web dibuja N
   *  mini-orbs decorando el orb. Es un conteo absoluto (reemplaza el valor previo); 0 = ninguno.
   *  Los canales sin orb (telegram/cli) no lo implementan (no-op). */
  subagents?(count: number): Promise<unknown> | void;
  /** Aviso de SISTEMA neutro, visible para el usuario (NO es voz del agente como `post`): un hecho
   *  del plano de sesión que el usuario debe ver — "conversación compactada" (auto-compaction) o
   *  "conversación reiniciada" (clear diario). Lo alimenta `Sink.notice`. Lo implementa el canal
   *  remoto (web) → emite el frame `notice`; la web lo pinta como una línea de sistema atenuada,
   *  distinta de una burbuja. Los canales texto-nativos (telegram/cli) caen a `post` con un prefijo
   *  (es lo más cercano a un aviso de sistema que tienen). */
  notice?(text: string): Promise<unknown> | void;
  /** Item nuevo en el inbox del agente (feature crons-delivery): el gateway ya persistió el
   *  resultado de un cron de canal `web` en el inbox durable y avisa, con `count` = no-leídos
   *  absolutos, para que el badge del FAB 🔔 suba al instante. Lo implementa SÓLO el canal remoto
   *  (web) → emite el frame `inbox`; los canales texto-nativos (telegram/cli) no lo tienen (no-op:
   *  su entrega es Telegram/WhatsApp, no inbox). NO trae el body — la burbuja se baja por click. */
  inbox?(count: number): Promise<unknown> | void;
};

// Audio entrante normalizado por el canal (Fase 10 · STT). `fetchData` baja los bytes
// (lazy: sólo si vamos a transcribir). channel-agnostic: cualquier canal que traiga audio.
export type InboundAudio = { fetchData(): Promise<Buffer>; mime?: string };

// Política estática de un canal. El núcleo (`handleIncoming`) despacha mirando estos
// campos en vez de ramificar por nombre (`if (channel === "web")`). Cada canal construye
// el suyo y lo pasa al núcleo.
export type ChannelPolicy = {
  /** Nombre del canal: clave en la tabla `channels` y en los logs. */
  name: string;
  /** ¿Eco de la transcripción STT al usuario? telegram/cli sí (texto-nativo, ayuda a
   *  corregir); web no (orbe de voz pura, sin transcripciones en pantalla). */
  echoTranscript: boolean;
};

// Metadata de contexto que un canal adjunta a un turno; el núcleo la renderiza como tag
// `[label: value]` antepuesto al mensaje del agente. Genérica: reemplaza params hardcodeados
// como `openDoc`. Ej. web manda { canal: web } y, si hay nota abierta, { vista: <repo>/<path> };
// un canal mobile podría mandar { ubicación: Hawaii } o { hora local: 14:30 }.
export type TurnFact = { label: string; value: string };
