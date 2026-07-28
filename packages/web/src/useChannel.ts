// Canal web (managed-ui): login + stream SSE (server→cliente) + POST (cliente→server) +
// grabación push-to-talk y reproducción de la respuesta en audio. Hablás manteniendo el
// círculo; al soltar se POSTea el audio; el agente transcribe (STT) y responde en voz
// (TTS); lo estructurado (listas, contenido de archivos) lo muestra en la vista. (SSE en
// vez de WebSocket porque el edge de vps.example.com no proxea upgrades WS; reconecta solo.)

import { useCallback, useEffect, useRef, useState } from "react";
import { appendAgentBubble } from "./agentBubble.ts";
import { readAudioSessionType, setAudioSession } from "./audioSession.ts";
import { parseNoteUrl, parseSystemUrl } from "./deepLink.ts";
import { acceptFrame, streamUrl } from "./frameSeq.ts";
import { createFsOpQueue, type FsOp, pathHasInflightOp } from "./fsOps.ts";
import { replaceOrInsertH1 } from "./h1Title.ts";
import { createLiveness, WATCHDOG_TICK_MS } from "./liveness.ts";
import { evictNote, readNote, writeNote } from "./localCache.ts";
import { streamHasLiveTrack, type TrackState, UNMUTE_TIMEOUT_MS } from "./micReadiness.ts";
import { isSameNote, isStaleNote } from "./noteIdentity.ts";
import { refetchDelays, refreshHitsOpen } from "./refreshTarget.ts";
import {
  MAX_AUDIO_BLOB_BYTES,
  MIN_AUDIO_BLOB_BYTES,
  retryableFailure,
  SEND_TIMEOUT_AUDIO_MS,
  SEND_TIMEOUT_TEXT_MS,
  type SendFailure,
  type SendKind,
  type SendResult,
  sendFailureMessage,
  sendWithRetry,
} from "./sendRetry.ts";
import { type SubAgentState, subAgentFromFrame, subagentCountFromFrame } from "./subAgent.ts";
import { getSystemPageMeta, isSystemPage, type SystemPage } from "./systemPages.ts";
import { decideOpenAction, type OpenTabState } from "./tabFocus.ts";
import { remapPath, remapTabsEntries, remapTabsEntriesCross } from "./tabRemap.ts";
import { shouldAutoplayVoice, type VoicePlayback } from "./voicePlayback.ts";

export type Status = "connecting" | "unauth" | "idle" | "recording" | "thinking" | "speaking";

// WAV mínimo de silencio (1 sample) para "bendecir" el <audio> de respuesta DENTRO de un
// gesto del usuario: iOS Safari/Brave sólo permiten un play() programático diferido (el que
// dispara el SSE con la voz) sobre un elemento que ya sonó por un gesto. El webview in-app de
// Telegram no lo necesita (abre con autoplay habilitado), por eso ahí la voz suena y en
// Safari/Brave no. Se construye en runtime (sin base64 hardcodeado).
function silentWavDataUri(): string {
  const b = new Uint8Array(45);
  const dv = new DataView(b.buffer);
  const s = (o: number, t: string) => {
    for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i));
  };
  s(0, "RIFF");
  dv.setUint32(4, 37, true);
  s(8, "WAVE");
  s(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, 8000, true); // sample rate
  dv.setUint32(28, 8000, true); // byte rate
  dv.setUint16(32, 1, true); // block align
  dv.setUint16(34, 8, true); // bits per sample
  s(36, "data");
  dv.setUint32(40, 1, true);
  dv.setUint8(44, 128); // 1 sample de silencio (8-bit unsigned: 128 = 0)
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return `data:audio/wav;base64,${btoa(bin)}`;
}
const SILENT_WAV = silentWavDataUri();

interface ServerMsg {
  t:
    | "ready"
    | "typing"
    | "text"
    | "heard"
    | "voice"
    | "error"
    | "open"
    | "created"
    | "refresh"
    | "activity"
    | "chat-title"
    | "subagents"
    | "turn-done"
    | "notice" // aviso de sistema (conversación compactada / reiniciada) → línea de sistema atenuada
    | "inbox" // item nuevo en el inbox (feature crons-delivery): sube el badge del FAB 🔔 (no auto-inyecta)
    | "ping" // keep-alive observable del server (25s): sólo marca liveness, no toca UI
    | "resync"; // Fase C: el hueco superó el buffer del server → refrescar estado, no inventar frames
  /** Seq monotónico por-usuario que estampa el server en cada frame entregado (Fase C).
   *  Es la base del dedup del replay (acceptFrame) y del `?since=` del reconnect manual.
   *  ready/ping/resync no lo traen (control de conexión, no replay-ables). */
  seq?: number;
  handle?: string;
  name?: string;
  text?: string;
  mime?: string;
  data?: string;
  error?: string;
  repo?: string;
  path?: string;
  sha?: string; // en `created`: sha del blob recién creado por viewer_create (atómico)
  label?: string; // en `activity`: verbo AMABLE del tool-call, sin params (ej. "actualizando nota")
  detail?: string; // en `activity`: resumen de params (ej. "viajes/japón"), opcional, sólo debug
  kind?: "subagent"; // en `activity`: marca un spawn de sub-agente (indicador dedicado/persistente)
  count?: number; // en `subagents`: cantidad de sub-agentes activos AHORA; en `inbox`: no-leídos absolutos
  title?: string; // en `chat-title`: el resumen semántico del tema actual del chat (2-5 palabras)
  changed?: { repo: string; path: string }[]; // en `refresh`: paths tocados (para saber si la nota abierta cambió)
}

/** Una entrada del log de actividad del turno (modo debug): un tool-call que el agente
 *  disparó, con su texto ya humanizado por el server y un id estable para el render. `label` es
 *  el verbo amable; `detail` (opcional) el resumen de params — el log de debug muestra los dos. */
export interface ActivityEntry {
  id: string;
  label: string;
  detail?: string;
}

// Lo que se muestra en la vista: SIEMPRE un archivo real de la wiki (no hay paneles de
// contenido sintético — la vista es solo archivos). Editable cuando está `ready` con sha.
export interface OpenDoc {
  /** Identificador local del doc abierto en memoria. ESTABLE durante todo el lifecycle
   *  del doc (incluso si se renombra). Permite que el editor no remontea — y conserve
   *  el cursor — cuando un rename cambia `path` (caso Obsidian: edito el H1 y el archivo
   *  se renombra solo). Lo usa App como `key` del editor. */
  id: string;
  title: string;
  repo: string;
  path: string;
  status: "loading" | "ready" | "new" | "error";
  content?: string;
  sha?: string; // blob sha (baseSha para editar)
  error?: string;
}

/** Una entrada del historial de navegación de una pestaña.
 *  - `kind:"note"` (default): un archivo real de la wiki (repo + path).
 *  - `kind:"system"`: una página de sistema (no tiene repo/path ni archivo real).
 *  `kind` ausente en entradas viejas del localStorage ≡ "note" (back-compat). */
export type TabEntry =
  | { kind?: "note"; repo: string; path: string; title: string }
  | { kind: "system"; page: SystemPage; title: string };

/** Una pestaña abierta. Lleva su PROPIO historial back/forward (estilo Obsidian): `entries`
 *  es la pila de navegación y `cursor` apunta a la entrada visible. Sólo la entrada actual
 *  de la pestaña ACTIVA se materializa como `doc` (con contenido/sha); el resto son punteros.
 *  Las pestañas de sistema tienen exactamente UN entry y no usan el historial. */
export interface Tab {
  id: string;
  entries: TabEntry[];
  cursor: number;
}

/** Vista plana de una pestaña para la tira de tabs (la entrada actual + su id).
 *  Discriminada por `kind`: note lleva repo/path; system lleva page. */
export type TabInfo =
  | { kind: "note"; id: string; title: string; repo: string; path: string }
  | { kind: "system"; id: string; title: string; page: SystemPage };

/** Settings de voz que expone /api/me para el panel de config (Fase 10/16). `id` de cada
 *  opción es el valor que se manda al gateway (apodo de voz, o id de idioma). */
export interface VoiceOpt {
  id: string;
  label: string;
}
export interface VoiceCfg {
  enabled: boolean;
  provider?: string;
  lang?: string;
  langs?: VoiceOpt[];
  voices?: VoiceOpt[];
  current?: string; // apodo de la voz activa (marca el <select>)
  rate?: string; // "" = normal; sino "+10%"/"-15%"
  rateSupported?: boolean;
}

/** Settings de modelo de chat que expone /api/me (espeja a VoiceCfg). `current` = clave
 *  del modelo activo (marca el <select>); `options[].id` = lo que se manda a /model. */
export interface ModelCfg {
  current: string;
  options: VoiceOpt[];
}

/** Eco de la última cosa que dijo/escribió el usuario, para mostrarla arriba de la
 *  respuesta del agente. `mode` elige el ícono (✏️ texto / 🎤 voz). Sólo se guarda la
 *  última pregunta (la anterior se reemplaza). */
export interface UserEcho {
  mode: "text" | "voice";
  text: string;
}

/** Un turno del historial del chat popup. A diferencia de `userEcho`/`caption` (que
 *  guardan SÓLO el último intercambio, para el diálogo bajo el orbe), `messages` acumula
 *  toda la conversación de la SESIÓN. `mode`: para el usuario, cómo lo mandó (texto/voz);
 *  para el agente, cómo respondió (voz si llegó algún clip, sino texto). `thinking` =
 *  burbuja del agente todavía generándose (muestra los puntitos). Se espeja a localStorage
 *  (`ceibo_chat:<handle>`) para sobrevivir un reload — solo el texto; el audio no (ver
 *  loadChat). La verdad dura sigue en las wikis. */
/** Adjunto que el usuario mandó por el chat (imagen/PDF). `url` es un data-URL sólo para el
 *  preview EN SESIÓN (no se persiste: el base64 infla localStorage); tras un reload queda el
 *  chip con `kind`/`name` pero sin miniatura. */
export interface ChatAttachment {
  kind: "image" | "document";
  mime: string;
  name?: string;
  url?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "system";
  mode: "text" | "voice";
  text: string;
  thinking?: boolean;
  /** Adjuntos del turno del usuario (imágenes/PDF). Sólo en mensajes role==="user". */
  attachments?: ChatAttachment[];
  /** Para una respuesta de VOZ del agente: blob URL del audio (ogg/opus) para reproducir
   *  inline en la burbuja (un `<audio>` reproducible, además del autoplay del turno). */
  audioUrl?: string;
  /** Envío FALLIDO (Fase B.2): el POST a /api/send agotó timeout + reintentos (o el guard
   *  client-side lo frenó). La burbuja muestra `reason` y, si `retryable`, el botón de
   *  reintentar (resend). Solo-sesión: NO se persiste a localStorage — el payload para
   *  reenviar vive en un ref y un reload lo descarta. */
  failed?: { reason: string; retryable: boolean };
}

/** Item del inbox del agente (feature crons-delivery): lo que alimenta el FAB 🔔 y su panel.
 *  Espeja la fila `inbox` del store (GET /api/inbox). `read_at` null = no leído (cuenta en el
 *  badge); `body` es el texto que se re-inyecta como burbuja del agente al clickear. */
export interface InboxItem {
  id: number;
  kind: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

/** Adjunto crudo listo para mandar por POST /api/send. `data` = base64 (sin el prefijo
 *  data-URL); `mime` el tipo; `name` el nombre del archivo. */
export interface OutboundMedia {
  name?: string;
  mime: string;
  data: string;
}

export interface Channel {
  status: Status;
  booting: boolean; // primer /api/me todavía sin resolver → splash neutro (no flashear el orbe)
  caption: string; // último texto del agente / transcripción / aviso
  /** Actividad EFÍMERA del agente en curso: el último tool-call humanizado del turno (frame
   *  `activity` del canal remoto, ej. "actualizando nota"). Alimenta el hint bajo el orb
   *  mientras el agente trabaja; null cuando no hay nada en vuelo (turno terminado / idle). */
  activity: string | null;
  /** Log de actividad del turno actual (modo debug): TODOS los tool-calls que el agente
   *  disparó, en orden de llegada. Se resetea al empezar un turno nuevo del usuario; persiste
   *  tras el turno para poder leerlo. Lo pinta el panel de debug (toggle local de la web). */
  activityLog: ActivityEntry[];
  /** Readout de debug del pipeline de grabación (solo observabilidad, detrás de `debugMode`): la
   *  última línea compacta con el estado del track/ctx/unmute al adquirir, el pico de nivel del mic,
   *  los chunks/bytes que entregó el recorder y la rama del onstop (enviada / descartada y por qué).
   *  Persiste el último valor (el owner lo lee tras soltar). "" hasta la primera grabación. */
  audioDiag: string;
  /** Sub-agente activo del turno (issue #29): indicador DEDICADO y PERSISTENTE, distinto del
   *  hint efímero. Se enciende cuando el agente delega en un worker del roster (frame `activity`
   *  con `kind:"subagent"`) y se mantiene hasta el fin del turno. `null` = no hay sub-agente. */
  subAgent: SubAgentState;
  /** Cantidad de sub-agentes ACTIVOS del agente AHORA (frame `subagents`): el orb se decora con
   *  N mini-orbs (un satélite por sub-agente vivo). En archima un sub-agente es un tool-call
   *  `task` en `running`; en MA, un thread del roster. 0 = ninguno. Se resetea al fin del turno. */
  subagentCount: number;
  /** Última pregunta del usuario (lo que escribió o lo que se le transcribió de la voz).
   *  Se muestra arriba del `caption` (la respuesta). null = todavía no preguntó nada. */
  userEcho: UserEcho | null;
  /** Historial completo de la conversación (lo consume el chat popup). Crece con cada turno
   *  y se espeja a localStorage por handle → sobrevive un reload (solo texto; ver loadChat). */
  messages: ChatMessage[];
  /** Epoch (ms) de cuándo arrancó el caché de la conversación actual en este browser —
   *  se setea con el primer mensaje y persiste por handle hasta que el chat se vacía. Lo
   *  usa el título del chat popup ("Chat: <fecha>"). undefined si todavía no chateaste. */
  chatStartedAt?: number;
  /** Título del chat = resumen semántico del tema actual (2-5 palabras), generado por el gateway
   *  y empujado por SSE (frame `chat-title`). Se actualiza solo a medida que cambia el tema.
   *  undefined hasta el primer título → el header cae al "Chat: <fecha>" estático. Persiste por
   *  handle (sobrevive un reload, como chatStartedAt). */
  chatTitle?: string;
  /** Inbox del agente (feature crons-delivery): items durables que el agente dejó (hoy, crons
   *  creados en web que dispararon). Los pinta el panel del FAB 🔔; más nuevos primero. */
  inboxItems: InboxItem[];
  /** No-leídos del inbox = el badge del FAB 🔔. Se hidrata al cargar (GET /api/inbox) y sube en
   *  vivo con el frame `inbox`; baja al abrir un item / marcar todo. */
  inboxUnread: number;
  /** Re-lee GET /api/inbox (items + unread). Lo dispara el `ready` inicial y el frame `inbox`. */
  refreshInbox(): Promise<void>;
  /** Abre un item: inyecta su `body` como burbuja del agente en el chat, lo marca leído (POST) y
   *  baja el badge. La burbuja es "de lectura" (re-inyectada del inbox; no rehidrata el contexto
   *  del turno del cron) — si el usuario responde, sigue su sesión actual (OK para v1). */
  openInboxItem(id: number): Promise<void>;
  /** Marca TODOS los items como leídos (botón del panel) y pone el badge en 0. */
  markAllInboxReadLocal(): Promise<void>;
  name?: string;
  /** Ubicación del usuario (perfil, texto libre). undefined = todavía sin /api/me o sin setear.
   *  La edita el panel de perfil; el agente la recibe en su contexto si está seteada. */
  location?: string;
  handle?: string; // identidad del usuario logueado (para aislar UI persistida)
  /** Email de registro (read-only): la identidad `email`/`google` con la que se dio de alta.
   *  Lo muestra el panel de perfil. undefined = todavía sin /api/me o sin email asociado. */
  email?: string;
  /** ¿El usuario tiene contraseña propia en Ceibo? Hidratado desde /api/me (tabla
   *  web_passwords). El panel de perfil lo usa para mostrar/ocultar "Cambiar contraseña".
   *  undefined = /api/me todavía no llegó. */
  hasPassword?: boolean;
  /** ¿El usuario tiene un avatar subido? (perfil web). false = mostrar placeholder. */
  hasAvatar: boolean;
  /** Contador que bumpea al cambiar el avatar — se usa como `?v=` para bustear el cache
   *  del `<img src="/api/me/avatar">` tras un upload/delete. */
  avatarVersion: number;
  /** Re-lee /api/me para refrescar el alias (name) + hasAvatar y bustear el avatar. Lo
   *  llama el panel de perfil tras guardar el alias o cambiar la foto. */
  refreshProfile(): Promise<void>;
  defaultWiki?: string; // wiki donde caen las notas rápidas (active_wiki o fallback)
  doc: OpenDoc | null; // la entrada actual de la pestaña ACTIVA (null = solo el círculo)
  /** Pestañas abiertas (tira de tabs), en orden. Cada una es su archivo actual + id. */
  tabs: TabInfo[];
  /** Id de la pestaña activa (la que materializa `doc`). null = no hay ninguna. */
  activeTabId: string | null;
  /** ¿La pestaña activa tiene historial atrás / adelante para navegar (flechas ← →)? */
  canBack: boolean;
  canForward: boolean;
  /** Pasa a la pestaña `id` (carga su entrada actual en `doc`). */
  selectTab(id: string): void;
  /** Cierra la pestaña `id`. Si era la activa, salta a una vecina; si era la última,
   *  vuelve a la pantalla del orbe (doc → null). */
  closeTab(id: string): void;
  /** Reordena: mueve la pestaña `id` para que quede ANTES de `beforeId` (o al final si
   *  `beforeId` es null). Usado por el drag-and-drop de la tira de pestañas. */
  reorderTab(id: string, beforeId: string | null): void;
  /** Cierra cualquier pestaña cuyo archivo actual sea (repo,path) — p.ej. al borrarlo
   *  desde el explorador. */
  closeByPath(repo: string, path: string): void;
  /** Remapea las pestañas tras un rename/move desde el explorer (fromPath→toPath): las que
   *  apuntaban al path viejo SIGUEN al nuevo en vez de cerrarse. `isFolder` = match por prefijo. */
  remapTabs(repo: string, fromPath: string, toPath: string, isFolder: boolean): void;
  /** Como `remapTabs` pero CROSS-WIKI: la nota pasó de `(fromRepo,fromPath)` a `(toRepo,toPath)`.
   *  Las pestañas que la apuntaban en la wiki vieja la SIGUEN a la nueva (reescribe repo + path). */
  remapTabsCross(fromRepo: string, fromPath: string, toRepo: string, toPath: string): void;
  /** Registra una operación de FS (move/rename) EN VUELO. Mientras dura, el editor NO persiste
   *  ningún archivo cubierto por la op (origen ni destino): la op es la dueña de su ciclo de vida.
   *  Esto evita que el flush/autosave del editor escriba al mismo archivo que el move está leyendo
   *  → el blob sha cambiaba mid-move → 409 "conflict" (caso 4). Lo usan el explorer y renameDoc. */
  beginFsOp(op: FsOp): void;
  /** Cierra una op de FS registrada con `beginFsOp` (por su `id`). Llamar SIEMPRE en el finally. */
  endFsOp(id: string): void;
  /** ¿El archivo (repo,path) está bajo una op de FS en vuelo? Lo consulta el editor antes de
   *  persistir (autosave/flush-on-unmount) para no romper el move con una escritura concurrente. */
  noteHasInflightFsOp(repo: string, path: string): boolean;
  /** Corre una MUTACIÓN de FS dentro de la cola serial por-repo: dos mutaciones del mismo repo
   *  nunca se solapan (evita el 422 non-fast-forward del commit concurrente → 409 espurio). Repos
   *  distintos no se bloquean. Lo usa el explorer para create/move/rename/archive. */
  runFsOp<T>(repo: string, fn: () => Promise<T>): Promise<T>;
  /** Navega el historial de la pestaña activa (no-op en los extremos). Con `newTab`
   *  (⌘/Ctrl-click) abre el destino en pestaña NUEVA en vez de mover el cursor de la activa. */
  navBack(newTab?: boolean): void;
  navForward(newTab?: boolean): void;
  /** Renombra el archivo abierto. `newName` es el título crudo (sin extensión); se
   *  sanitiza y se le agrega `.md`. `fullContent` (opcional) es el contenido COMPLETO vivo del
   *  editor (con el H1 oculto): si viene, el move reescribe el H1 a `# <título crudo>` y lo escribe
   *  ATÓMICAMENTE en el destino (mismo commit que el cambio de path) → el editor NO necesita un
   *  re-save posterior del H1 (ese re-save tardío contra el path viejo duplicaba archivo y H1, caso 6).
   *  Llama al endpoint atómico de move; al volver, el state queda apuntando al nuevo path (mismo
   *  doc.id → el editor sigue montado, con cursor) y devuelve el sha nuevo. Error si no hay doc
   *  abierto o falla la API. */
  renameDoc(newName: string, fullContent?: string): Promise<string | undefined>;
  /** Se incrementa cuando una wiki del user cambió (feed) o el agente creó una nota → el
   *  Explorer recarga su árbol al instante, sin esperar su poll (Fase 3a). */
  treeSeq: number;
  /** Abre un archivo (lo usan el agente y el explorador). Por default reemplaza el contenido
   *  de la pestaña activa (y lo empuja a su historial). `opts.newTab` abre en una pestaña
   *  nueva al final, sin robar foco a la activa salvo que sea la primera. */
  open(repo: string, path: string, opts?: { newTab?: boolean }): void;
  /** Abre una página de sistema (singleton): si ya está abierta la enfoca; si no la crea.
   *  `doc` queda null mientras la pestaña activa es de sistema (no hay archivo real). */
  openSystem(page: SystemPage): void;
  /** Tab activa (la vista plana de la entrada actual), o null si ninguna está activa. */
  activeTab: TabInfo | null;
  // El editor avisa lo guardado (con la identidad de la nota) → state/cache quedan al día. El
  // repo+path evita que un save en vuelo contamine la nota activa si el usuario cambió de pestaña.
  patchDoc(content: string, sha: string, repo: string, path: string): void;
  closeDoc(): void; // cierra la pestaña activa (alias de closeTab(activeTabId))
  /** Vuelve al orbe principal sin cerrar las pestañas. activeTabId → null, doc → null.
   *  Desde "home" se vuelve a cualquier pestaña con selectTab. No-op si ya está en home. */
  goHome(): void;
  startRecording(): void;
  stopRecording(): void;
  /** Aborta la grabación en curso descartándola: no manda STT ni dispara un turno. La usa el orbe
   *  flotante al pasar de hold-to-talk a arrastre. */
  cancelRecording(): void;
  /** Desbloquea, dentro de un gesto del usuario, la reproducción de la respuesta (AudioContext +
   *  blip silencioso). El orbe flotante lo llama en `pointerdown` porque DIFIERE la grabación
   *  (debounce de quietud) y el unlock tiene que ocurrir en el gesto, no en el timer. */
  primeAudioPlayback(): void;
  /** Activa/desactiva el autoplay POR DEFAULT de la respuesta de voz. Con el chat ABIERTO el
   *  owner lo quiere como Telegram: NO autoplay (apretar play en la burbuja). Con el chat cerrado
   *  (orbe) sí. App lo llama según `chatOpen`. EXCEPCIÓN (ver shouldAutoplayVoice): si el turno
   *  lo inició una NOTA DE VOZ del usuario, la respuesta de voz se auto-reproduce igual y la
   *  burbuja espeja la reproducción (`voicePlayback`). */
  setVoiceAutoplay(on: boolean): void;
  /** Estado de la reproducción EN CURSO de una respuesta de voz atada a una burbuja del chat
   *  (la reproducción real es UNA sola: el `<audio>` compartido del canal). El chat lo usa para
   *  espejar el player en la burbuja (progreso avanzando, botón en pausa) en vez de un
   *  `<audio controls>` muerto en 0:00 mientras suena por otro lado. null = nada sonando. */
  voicePlayback: VoicePlayback | null;
  /** Pausa/reanuda la reproducción espejada (el botón del player de la burbuja). */
  toggleVoicePlayback(): void;
  /** Salta a `t` segundos en la reproducción espejada (el seek del player de la burbuja). */
  seekVoicePlayback(t: number): void;
  /** Manda un texto al agente (alternativa al hold-para-hablar). Mismo endpoint que el
   *  audio (POST /api/send), tipo "text". El agente decide la modalidad de su respuesta
   *  con `[[voice]]`/`[[text]]` (espejo por default → texto entrante = texto saliente).
   *  `media` adjunta imágenes/PDF (el modelo las ve); puede mandarse sólo media sin texto. */
  sendText(text: string, media?: OutboundMedia[]): void;
  /** Reintenta un envío FALLIDO (la burbuja del usuario marcada `failed`, botón
   *  "reintentar"). Re-postea el MISMO payload; si vuelve a fallar, re-marca la burbuja.
   *  No-op si el mensaje no tiene un payload pendiente (ej. tras un reload). */
  resend(msgId: string): void;
  /** Tap en el orbe mientras PIENSA: cancela el turno (manda /stop, vuelve a idle). */
  cancelTurn(): void;
  /** Tap en el orbe mientras HABLA: mutea el audio de ese turno (corta la voz y silencia los
   *  clips que sigan llegando), SIN cancelar el turno (no manda /stop). Vuelve a idle. */
  muteAudio(): void;
  mics: { deviceId: string; label: string }[];
  micsAuthorized: boolean; // ¿hay permiso de mic? (si no, la config de mic va grayed-out)
  micId: string; // "" = default del sistema
  setMic(id: string): void;
  /** Settings de voz (idioma/voz/velocidad) para el panel de config; undefined hasta que
   *  llega /api/me o si el feature de voz está apagado en el gateway. */
  voice?: VoiceCfg;
  /** Cambia la voz (manda /voice <apodo>), el idioma (/language <id>) o la velocidad
   *  (/voice rate <val>, "" = normal) por el canal, y actualiza el estado local. */
  setVoice(nick: string): void;
  setVoiceLang(id: string): void;
  setRate(rate: string): void;
  /** Modelo de chat (idem voz): opciones + actual, undefined si la box no ofrece selector. */
  model?: ModelCfg;
  /** Cambia el modelo (manda /model <id> por el canal). Reinicia el contexto de la sesión. */
  setModel(id: string): void;
  /** Prompts del fondo Unsplash EFECTIVOS (los del usuario o el default de la app), para
   *  precargar el campo del cog. undefined = /api/me todavía no llegó. */
  bgQueries?: string[];
  /** Guarda los prompts del fondo (POST /api/me). Vacío = volver al default de la app.
   *  Devuelve éxito; en ok actualiza `bgQueries` con lo efectivo que ecoa el server. */
  saveBgQueries(queries: string[]): Promise<boolean>;
  /** Nivel de audio (RMS 0..1) de la voz que está sonando — lo lee el orbe WebGL para
   *  reaccionar al habla. 0 si no está hablando o no hay analyser disponible. */
  getAudioLevel(): number;
  /** Nivel del micrófono (RMS 0..1) mientras grabás — lo leen los palitos del input. 0 si
   *  no estás grabando. */
  getMicLevel(): number;
  /** Debug (?debug=1): readyState del EventSource (0=CONNECTING,1=OPEN,2=CLOSED,-1=sin es). */
  sseState(): number;
  /** Ms desde el último evento SSE recibido (incluido el keep-alive `ping` de 25s). Es la
   *  señal del watchdog de liveness (liveness.ts) — y la pinta el overlay de ?debug=1. */
  lastEventAgo(): number;
}

// --- Debug log compartido (lo lee el overlay de ?debug=1) -------------------
// Ring de líneas que pinta el DebugOverlay. Lo empujan useChannel (eventos SSE / estado) y
// App (eventos de pointer del orbe), para ver EN MOBILE qué pasa con la grabación y el canal.
export const DEBUG_LOG: { id: number; t: number; msg: string }[] = [];
let debugSeq = 0;
export function dbg(msg: string): void {
  DEBUG_LOG.push({ id: ++debugSeq, t: Date.now(), msg });
  if (DEBUG_LOG.length > 60) DEBUG_LOG.shift();
}

/** Sanitiza un nombre para usar como filename de wiki. Mantiene espacios, mayúsculas
 *  y tildes (la convención del refactor plano permite "Comprar instrumentos.md").
 *  Saca solo los caracteres que rompen filesystems o GitHub. */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Espera a que el track de audio del stream esté DES-MUTEADO (entregando PCM real) antes de dejar
 *  grabar. Tras background / cambio de ruta Bluetooth el track nace `muted` y la fuente tarda en
 *  re-entregar audio (WebKit 180748); marcar "grabando" mientras tanto es la ilusión de grabar.
 *  Resuelve apenas el track ya está des-muteado, al primer evento `unmute`, o al vencer el timeout
 *  (tope de seguridad: nunca dejamos al usuario sin poder grabar — si igual no entró audio, el guard
 *  de blob vacío/corto del onstop lo descarta). No-op (resuelve ya) si no hay track.
 *
 *  El valor resuelto es SOLO para observabilidad (`audioDiag` del readout de debug): los callers lo
 *  ignoran (hacen `await` sin usarlo). `"ready"` = ya estaba des-muteado (no hubo espera); `"unmute"`
 *  = llegó el evento; `"timeout"` = venció el tope sin des-mutearse (sospechoso: probable silencio). */
function waitForUnmute(
  stream: MediaStream,
  timeoutMs = UNMUTE_TIMEOUT_MS,
): Promise<"ready" | "unmute" | "timeout"> {
  const track = stream.getAudioTracks()[0];
  if (!track || track.muted === false) return Promise.resolve("ready");
  return new Promise((resolve) => {
    let done = false;
    const finish = (outcome: "unmute" | "timeout") => {
      if (done) return;
      done = true;
      track.removeEventListener("unmute", onUnmute);
      clearTimeout(timer);
      resolve(outcome);
    };
    const onUnmute = () => finish("unmute");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    track.addEventListener("unmute", onUnmute);
  });
}

// Id de esta vista (pestaña). Estable por carga de página y reusado en cada reconexión del
// EventSource: el server lo usa para entregar la respuesta de un turno SÓLO a la vista que
// preguntó (evita el eco cuando hay varias pestañas/dispositivos abiertos). Dos pestañas =
// dos contextos JS = dos sid distintos. `crypto.randomUUID` existe en contexto seguro
// (https / localhost); el fallback cubre el caso raro de no tenerlo.
const VIEW_SID: string =
  globalThis.crypto?.randomUUID?.() ?? `v${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/** Cliente→server: POST a /api/send (audio grabado o texto). La respuesta vuelve por SSE.
 *  Inyecta `sid` (esta vista) para que la respuesta del turno vuelva sólo acá.
 *  Resiliente (Fase B.2, ver sendRetry.ts): timeout por intento (más aire para audio, que
 *  puede pesar MB) + reintentos con backoff para fallos transitorios. NUNCA lanza — devuelve
 *  el resultado para que el caller dé feedback si el envío se perdió (antes el `.catch(() =>
 *  undefined)` se tragaba todo y un envío fallido desaparecía en silencio). */
function postSend(msg: unknown, kind: SendKind = "text"): Promise<SendResult> {
  return sendWithRetry("/api/send", JSON.stringify({ ...(msg as Record<string, unknown>), sid: VIEW_SID }), {
    timeoutMs: kind === "audio" ? SEND_TIMEOUT_AUDIO_MS : SEND_TIMEOUT_TEXT_MS,
  });
}

const MIC_KEY = "ceibo_mic";
// Duración mínima de grabación para mandarla. Debajo de esto es un tap accidental: el WebM
// queda sin cluster finalizado y ffmpeg falla en el STT. Mejor descartarlo en silencio.
const MIN_REC_MS = 350;
// Tras este tiempo SIN grabar (y con la app en foreground), soltamos el micrófono reusado.
// El stream se reusa entre grabaciones (workaround del cuelgue del 2º getUserMedia en iOS),
// pero un track de mic VIVO mantiene activa la audio-session del SO → en iOS/WebKit CarPlay
// lo interpreta como "llamada en curso". Soltarlo al quedar inactivo corta ese síntoma; la
// próxima grabación re-adquiere (gesto del usuario + gap → no recae en el cuelgue de iOS).
const MIC_IDLE_RELEASE_MS = 60_000;
// Tope de payloads de envíos fallidos retenidos en memoria para "reintentar" (Fase B.2):
// un audio fallido puede pesar MB en base64 — no acumulamos sin límite.
const FAILED_SENDS_MAX = 8;
// Keys de persistencia UI: van prefijadas con el handle del user (`ceibo_doc:<handle>`,
// `ceibo_exp:<handle>`) para aislar entre usuarios que comparten browser. Sin prefijo,
// loguearse como user B heredaba el openDoc de user A y rompía el restore.
const DOC_KEY_PREFIX = "ceibo_doc:";
// Tope del historial back/forward por pestaña (entries). Más que esto no aporta y crece RAM.
const TAB_HISTORY_MAX = 50;
/** Título legible de una pestaña: el nombre del archivo sin carpeta ni extensión `.md`. */
function tabTitleOf(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}
// `ceibo_handle` cachea el handle del último login. Los componentes (Explorer / App)
// lo leen SINCRÓNICAMENTE al inicializar su state para hidratar el tree y el
// open/closed del explorer SIN flash. La fuente de verdad sigue siendo /api/me;
// si el handle de la sesión actual cambia, el effect de re-hidratación corrige.
const HANDLE_KEY = "ceibo_handle";
// `ceibo_chat:<handle>` espeja el historial del chat al browser para que un reload no lo
// vacíe (la sesión MA del gateway sigue viva → el agente ya recuerda; esto realinea lo que
// VES con lo que él sabe). Solo persiste rol/modo/texto: los blob URLs del audio y el flag
// de "pensando" son efímeros de la sesión y se descartan al releer. Es por-browser (no
// sincroniza entre dispositivos como Telegram): la verdad dura sigue en las wikis.
const CHAT_KEY_PREFIX = "ceibo_chat:";
const CHAT_MAX_MSGS = 200; // tope del historial persistido (cap del tamaño en localStorage)
// `ceibo_chat_started:<handle>` recuerda CUÁNDO arrancó el caché de la conversación actual
// (epoch ms). Se escribe con el primer mensaje y vive hasta que el chat se vacía; lo lee el
// título del chat popup. Separado de `ceibo_chat:` para no reescribir el inicio en cada turno.
const CHAT_STARTED_PREFIX = "ceibo_chat_started:";
// `ceibo_chat_title:<handle>` espeja el último título del chat (tema actual) al browser para que
// un reload no lo pierda mientras la sesión sigue viva. Lo escribe el frame `chat-title` y se
// borra cuando el chat se vacía (junto con el inicio del caché). Por-browser (no sincroniza).
const CHAT_TITLE_PREFIX = "ceibo_chat_title:";

/** Lee el epoch de inicio del caché de chat de un handle (o undefined si no hay/!válido). */
function readChatStarted(handle: string | undefined): number | undefined {
  if (!handle) return undefined;
  try {
    const raw = localStorage.getItem(`${CHAT_STARTED_PREFIX}${handle}`);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Lee el último título del chat de un handle (o undefined si no hay / localStorage no va). */
function readChatTitle(handle: string | undefined): string | undefined {
  if (!handle) return undefined;
  try {
    return localStorage.getItem(`${CHAT_TITLE_PREFIX}${handle}`) || undefined;
  } catch {
    return undefined;
  }
}

/** Lee y sanea el historial del chat de un handle desde localStorage. Filtra a burbujas con
 *  texto (descarta la de "pensando" en vuelo) y deja solo rol/modo/texto: el audio (blob URL)
 *  no sobrevive a un reload, así que una respuesta de voz queda como su transcripción. []
 *  si no hay nada, el handle es desconocido o el JSON está corrupto. */
function loadChat(handle: string | undefined): ChatMessage[] {
  if (!handle) return [];
  try {
    const raw = localStorage.getItem(`${CHAT_KEY_PREFIX}${handle}`);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is ChatMessage =>
          !!m &&
          (m.role === "user" || m.role === "agent") &&
          typeof m.text === "string" &&
          (m.text.length > 0 || (Array.isArray(m.attachments) && m.attachments.length > 0)),
      )
      .map((m) => {
        // Adjuntos persistidos: sólo kind/mime/name (el data-URL no sobrevive al reload).
        const attachments = Array.isArray(m.attachments)
          ? m.attachments
              .filter((a): a is ChatAttachment => !!a && (a.kind === "image" || a.kind === "document"))
              .map((a) => ({ kind: a.kind, mime: typeof a.mime === "string" ? a.mime : "", name: a.name }))
          : undefined;
        return {
          id: typeof m.id === "string" ? m.id : crypto.randomUUID(),
          role: m.role,
          mode: m.mode === "voice" ? ("voice" as const) : ("text" as const),
          text: m.text,
          ...(attachments?.length ? { attachments } : {}),
        };
      });
  } catch {
    return [];
  }
}

export function useChannel(): Channel {
  const [status, setStatus] = useState<Status>("connecting");
  // `booting` = todavía no sabemos si hay sesión (el primer /api/me no resolvió). Tapa el
  // primer render con un splash neutro para NO flashear el orbe antes de caer al login.
  // Distinto de `status==="connecting"`, que también se da en reconexiones a mitad de sesión.
  const [booting, setBooting] = useState(true);
  const [caption, setCaption] = useState("");
  // Readout de debug del pipeline de grabación (solo observabilidad, detrás de `debugMode`): última
  // línea compacta con dónde se rompió la captura en el dispositivo (track muted/enabled, estado del
  // ctx, resultado del unmute, pico de nivel, chunks/bytes, y la rama del onstop). El owner lo lee
  // DESPUÉS de soltar (no puede mirar mientras graba), así que PERSISTE el último valor. Ver audioDiagRef.
  const [audioDiag, setAudioDiag] = useState<string>("");
  // Actividad del agente: `activity` = el tool-call en curso (hint efímero bajo el orb);
  // `activityLog` = el historial de tool-calls del turno (panel de debug). Ver frame `activity`.
  const [activity, setActivity] = useState<string | null>(null);
  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([]);
  // Indicador DEDICADO y PERSISTENTE de sub-agente (issue #29): se enciende con un frame
  // `activity` marcado `kind:"subagent"` y se mantiene TODO el turno (no es efímero como el
  // indicador de actividad del chat). Se apaga al fin REAL del turno (frame `turn-done`) o al
  // arrancar uno nuevo.
  const [subAgent, setSubAgent] = useState<SubAgentState>(null);
  // Cantidad de sub-agentes ACTIVOS del agente AHORA (frame `subagents`): la web decora el orb con
  // N mini-orbs (un satélite por sub-agente vivo). Es el conteo absoluto que manda el backend
  // (archima: workers async + tool-calls `task` en `running`; MA: threads vivos) y es la ÚNICA
  // fuente de verdad: NO se resetea localmente en turn-done ni al arrancar un turno — los workers
  // async de archima SOBREVIVEN al turno (delegación v2) y el gateway re-afirma el conteo absoluto
  // en cada borde (tras cada turn-done, al registrar un worker y al terminar). Ver subAgent.ts.
  const [subagentCount, setSubagentCount] = useState(0);
  const [userEcho, setUserEcho] = useState<UserEcho | null>(null);
  const [name, setName] = useState<string>();
  // Ubicación del usuario (perfil): la setea boot()/refreshProfile() desde /api/me. No se cachea
  // (no es identidad de UI; la edita el panel de perfil y se relee). Nombre `userLocation` para
  // NO pisar el global `window.location` que se usa en boot() (deep-links/magic-link).
  const [userLocation, setUserLocation] = useState<string>();
  // Email de registro (read-only): lo setea boot() desde /api/me. No se cachea (no es identidad
  // de UI ni cambia desde la web).
  const [email, setEmail] = useState<string>();
  // hasPassword: ¿tiene contraseña propia en Ceibo? Lo setea boot() desde /api/me; no se cachea.
  const [hasPassword, setHasPassword] = useState<boolean>();
  // El handle arranca con lo cacheado (si hay) para que la UI hidrate síncrono.
  // Se confirma/reemplaza en boot() cuando llega /api/me.
  const [handle, setHandle] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem(HANDLE_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  });
  const [defaultWiki, setDefaultWiki] = useState<string | undefined>();
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  // Tabs (estilo Obsidian): la lista de pestañas + la activa. `doc` es la materialización
  // (con contenido) de la entrada actual de la pestaña activa; el resto de las pestañas son
  // sólo punteros (entries) que se cargan al activarlas. Los refs espejan el state para que
  // los callbacks (open/select/close/nav) lean lo último sin recrearse en cada cambio.
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const tabsRef = useRef<Tab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  // `closeActiveRef` lo setea un efecto más abajo (closeTab ya existe entonces); refetch lo
  // llama cuando el archivo de la pestaña activa se borró afuera (404).
  const closeActiveRef = useRef<() => void>(() => {});
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);
  // Bumpea cuando una wiki del user cambia (feed) o el agente crea una nota → el Explorer
  // recarga su árbol al instante, sin esperar su poll (Fase 3a).
  const [treeSeq, setTreeSeq] = useState(0);
  const [mics, setMics] = useState<{ deviceId: string; label: string }[]>([]);
  const [micsAuthorized, setMicsAuthorized] = useState(false); // ¿ya concediste permiso de mic?
  const [micId, setMicId] = useState<string>(() => localStorage.getItem(MIC_KEY) ?? "");
  const [voice, setVoiceState] = useState<VoiceCfg | undefined>();
  const [model, setModelState] = useState<ModelCfg | undefined>();
  // Prompts del fondo Unsplash (cog de settings). El server manda lo EFECTIVO: los del
  // usuario o el default de la app si no configuró — la UI siempre precarga con algo.
  const [bgQueries, setBgQueriesState] = useState<string[] | undefined>();
  const [hasAvatar, setHasAvatar] = useState(false);
  const [avatarVersion, setAvatarVersion] = useState(0);
  // Historial del chat popup (persistido por handle, ver abajo). Cada mensaje del agente es su
  // PROPIA burbuja, inmutable una vez emitida (append-only): no hay burbuja "en vuelo" que se
  // reuse, así un segundo mensaje del mismo turno (ej. el link out-of-band del sistema + la
  // respuesta del modelo) no pisa al primero. No hay streaming: el gateway postea cada mensaje
  // entero de una.
  // Hidratamos síncrono desde `ceibo_chat:<handle cacheado>` para que el chat aparezca
  // poblado sin flash al recargar. `hydratedHandleRef` recuerda PARA QUÉ handle se cargó:
  // si /api/me confirma otro (browser compartido, user B tras user A), boot() recarga el
  // historial correcto y la persistencia no escribe el chat de A en la key de B.
  const hydratedHandleRef = useRef<string | undefined>(
    (() => {
      try {
        return localStorage.getItem(HANDLE_KEY) ?? undefined;
      } catch {
        return undefined;
      }
    })(),
  );
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadChat(hydratedHandleRef.current));
  // Inicio del caché del chat (epoch ms), hidratado síncrono del handle cacheado para que el
  // título del popup no parpadee en F5. La persistencia (abajo) lo mantiene al día.
  const [chatStartedAt, setChatStartedAt] = useState<number | undefined>(() =>
    readChatStarted(hydratedHandleRef.current),
  );
  // Título del chat (tema actual), hidratado síncrono del handle cacheado para no parpadear en
  // F5. Lo actualiza el frame `chat-title` (SSE) y lo persiste el efecto de abajo.
  const [chatTitle, setChatTitle] = useState<string | undefined>(() =>
    readChatTitle(hydratedHandleRef.current),
  );
  // Inbox del agente (feature crons-delivery): items durables + no-leídos para el FAB 🔔. NO se
  // persiste a localStorage (a diferencia del chat): es estado del server, se hidrata con
  // GET /api/inbox al cargar y se refresca con el frame `inbox`. Arranca vacío.
  const [inboxItems, setInboxItems] = useState<InboxItem[]>([]);
  const [inboxUnread, setInboxUnread] = useState(0);
  // Agrega un turno del usuario al historial del chat.
  // Devuelve el id de la burbuja: el flujo de envío resiliente lo usa para marcarla
  // `failed` si el POST agota los reintentos (ver failSend / resend).
  const pushUserMsg = useCallback(
    (mode: "text" | "voice", text: string, attachments?: ChatAttachment[]): string => {
      // Turno nuevo → arranca un log de actividad limpio (los tool-calls del turno anterior
      // dejan de ser relevantes), se va el indicador efímero de actividad y el indicador de
      // sub-agente del turno previo. El CONTEO de sub-agentes (mini-orbs) NO se toca: los workers
      // async de archima sobreviven al turno y el frame `subagents` (absoluto, server-driven) es
      // su única fuente de verdad — resetearlo acá apagaba el orb del worker vivo en cuanto el
      // usuario volvía a hablar (ver subAgent.ts).
      setActivity(null);
      setActivityLog([]);
      setSubAgent(null);
      const id = crypto.randomUUID();
      setMessages((m) => [
        ...m,
        {
          id,
          role: "user",
          mode,
          text,
          ...(attachments?.length ? { attachments } : {}),
        },
      ]);
      return id;
    },
    [],
  );
  // Appendea un mensaje del agente como una burbuja NUEVA e inmutable. Cada llamada acuña su
  // propio id (no se reusa ninguna burbuja del turno) → dos mensajes del mismo turno (ej. el
  // link out-of-band del sistema + la respuesta del modelo) quedan como dos burbujas y ninguno
  // pisa al otro. El id se acuña ACÁ (no dentro del updater de setMessages, que React puede
  // correr diferido) para que el caller pueda atarlo a la reproducción de voz (voicePlayback)
  // de forma síncrona. Una burbuja ya emitida NO se muta; lo único que la toca después es
  // voicePlayback, que espeja el estado de reproducción por el id capturado.
  const appendAgentMsg = useCallback(
    (patch: { text?: string; mode?: "text" | "voice"; thinking?: boolean; audioUrl?: string }): string => {
      const id = crypto.randomUUID();
      // append-only e inmutable (invariante del web fix): ver agentBubble.ts.
      setMessages((m) => appendAgentBubble(m, id, patch));
      return id;
    },
    [],
  );

  // --- Inbox del agente (feature crons-delivery) -----------------------------
  // Re-lee la bandeja del server (items + no-leídos). La dispara el `ready` inicial y el frame
  // `inbox` (push en vivo). Best-effort: un fallo deja el estado como estaba.
  const refreshInbox = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch("/api/inbox");
      if (!r.ok) return;
      const j = (await r.json()) as { items?: InboxItem[]; unread?: number };
      setInboxItems(j.items ?? []);
      setInboxUnread(j.unread ?? 0);
    } catch {
      /* offline / sin sesión → dejamos el estado */
    }
  }, []);

  // Abre un item: inyecta su `body` como burbuja del agente (re-inyección "de lectura": no
  // rehidrata el contexto del cron — si el usuario responde, sigue su sesión actual, OK v1),
  // lo marca leído en el server y baja el badge local. No-op si el item no está en memoria.
  const openInboxItem = useCallback(
    async (id: number): Promise<void> => {
      const item = inboxItems.find((it) => it.id === id);
      if (!item) return;
      appendAgentMsg({ text: item.body, thinking: false });
      // Optimista: marcá leído local y bajá el badge ya; el POST confirma el unread del server.
      const wasUnread = item.read_at === null;
      setInboxItems((items) =>
        items.map((it) => (it.id === id ? { ...it, read_at: it.read_at ?? new Date().toISOString() } : it)),
      );
      if (wasUnread) setInboxUnread((n) => Math.max(0, n - 1));
      try {
        const r = await fetch(`/api/inbox/${id}/read`, {
          method: "POST",
          headers: { "content-type": "application/json" },
        });
        if (r.ok) {
          const j = (await r.json()) as { unread?: number };
          if (typeof j.unread === "number") setInboxUnread(j.unread);
        }
      } catch {
        /* el marcado optimista ya bajó el badge; un fallo de red se reconcilia en el próximo refresh */
      }
    },
    [inboxItems, appendAgentMsg],
  );

  // Marca todo leído (botón del panel): optimista + POST que reconcilia el unread.
  const markAllInboxReadLocal = useCallback(async (): Promise<void> => {
    setInboxItems((items) =>
      items.map((it) => (it.read_at ? it : { ...it, read_at: new Date().toISOString() })),
    );
    setInboxUnread(0);
    try {
      const r = await fetch("/api/inbox/read-all", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      if (r.ok) {
        const j = (await r.json()) as { unread?: number };
        if (typeof j.unread === "number") setInboxUnread(j.unread);
      }
    } catch {
      /* idem openInboxItem: el optimista ya bajó el badge */
    }
  }, []);

  const esRef = useRef<EventSource>(null);
  // Timestamp del último evento SSE recibido (incluido el `ping` de 25s del server). Señal
  // del watchdog de liveness: "demasiado viejo" = conexión zombie → reconnect forzado.
  const lastEventRef = useRef(0);
  // Último `seq` PROCESADO (Fase C): watermark del replay. Sube solo con frames aceptados;
  // viaja como `?since=` en cada reconnect manual (el nativo manda `Last-Event-ID` solo) y
  // es la vara del dedup (un frame replayed con seq ≤ esto ya se procesó → se descarta).
  // Vive a nivel del hook (NO por conexión): el dedup debe sobrevivir a los reconnects.
  const lastSeqRef = useRef(0);
  const recRef = useRef<MediaRecorder>(null);
  // Timestamp del inicio de la grabación. Una grabación demasiado corta (tap accidental)
  // produce un WebM sin cluster finalizado → ffmpeg no lo puede decodificar en el STT
  // ("error de FFMP"). Si dura menos que el mínimo, la descartamos en vez de mandarla.
  const recStartRef = useRef(0);
  // ¿El usuario SIGUE manteniendo apretado el orbe? Si soltó mientras estaba el prompt de
  // permiso del mic (típico: hay que soltar el orbe para tocar "Permitir"), abortamos en vez
  // de arrancar una grabación que quedaba trabada en "recording" sin forma de pararla.
  const wantRecRef = useRef(false);
  // El próximo `onstop` debe DESCARTAR el audio (no mandarlo), pase lo que pase con la duración.
  // Lo usa cancelRecording: cuando el orbe flotante pasa de hold-to-talk a ARRASTRE, abortamos la
  // grabación en curso sin disparar STT ni un turno. (stopRecording, en cambio, sí manda si superó
  // el mínimo de duración.)
  const discardNextRef = useRef(false);
  const chunksRef = useRef<Blob[]>([]);
  const speakingRef = useRef(false);
  // ¿Auto-reproducir la respuesta de voz al llegar? Con el chat ABIERTO el owner lo quiere como
  // Telegram: NO autoplay, hay que apretar play en el `<audio controls>` de la burbuja. Con el
  // chat cerrado (modo orbe / "llamada" push-to-talk) sí autoplay — la voz suena y el orbe pulsa.
  // App lo setea según `chatOpen` vía `setVoiceAutoplay`. Default true (modo orbe).
  const autoplayVoiceRef = useRef(true);
  // ¿El último turno lo inició una NOTA DE VOZ del usuario? (true al postear audio, false al
  // postear texto.) Excepción del owner al default de arriba: mandaste audio → la respuesta de
  // voz se auto-reproduce SIEMPRE, esté el chat abierto o no (ver shouldAutoplayVoice).
  const voiceTurnRef = useRef(false);
  // ¿Este turno fue MUTEADO por un tap en el orbe mientras hablaba? El tap corta el audio en curso
  // pero NO cancela el turno: si quedaba texto/voz por llegar, el TEXTO se sigue escribiendo en la
  // burbuja, pero los clips de voz que entren NO deben volver a sonar (sin esto, el próximo clip por
  // SSE re-dispara playVoice y la voz vuelve). Se resetea al arrancar un turno nuevo (mandar texto /
  // empezar a grabar) para que el siguiente turno suene normal. Ver shouldAutoplayVoice + muteAudio.
  const mutedTurnRef = useRef(false);
  // Espejo de la reproducción en curso cuando el clip pertenece a una burbuja del chat: el chat
  // pinta el player "vivo" (progreso/pausa) sobre la burbuja. La reproducción real sigue siendo
  // UNA sola (el <audio> compartido de abajo); esto es solo estado para la UI.
  const [voicePlayback, setVoicePlayback] = useState<VoicePlayback | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null); // la nota de voz que se está reproduciendo
  // Cola de audios pendientes; `msgId` ata el clip a su burbuja del chat (para el player espejo).
  const voiceQueueRef = useRef<{ b64: string; mime: string; msgId?: string }[]>([]);
  // El <audio> de la respuesta es UNO solo y reusado. iOS Safari/Brave bloquean play() de un
  // elemento que nunca sonó en un gesto; lo "bendecimos" con un blip silencioso en el gesto del
  // push-to-talk (ver startRecording) y reusamos el mismo elemento para los clips del SSE.
  const voiceElRef = useRef<HTMLAudioElement | null>(null);
  const voiceTapRef = useRef<MediaElementAudioSourceNode | null>(null); // tap al analyser (one-shot/elemento)
  // Audio reactivo: AnalyserNode para que el orbe WebGL reaccione a la voz del agente. Sólo
  // se "tapea" el audio si el AudioContext está corriendo (creado/resumido en un gesto); si
  // no, el clip se reproduce normal y nos quedamos sin nivel ese clip (la voz nunca se rompe).
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  // Analyser del MICRÓFONO mientras grabás → alimenta los palitos del input (feedback de
  // "te estoy escuchando"). NO se conecta a destination (sería eco). Se monta al empezar a
  // grabar y se desmonta al parar.
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const micDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const micSrcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  // --- Diagnóstico de grabación (solo observabilidad, detrás de debugMode) -----
  // Resultado del último `waitForUnmute` (ready/unmute/timeout) — lo deja acquireMicStream para que
  // el probe de startRecording lo lea sin cambiar la firma del flujo.
  const lastUnmuteRef = useRef<"ready" | "unmute" | "timeout" | "?">("?");
  // Acumulador del diagnóstico de la grabación EN CURSO: pico de nivel del mic visto, cuántos
  // `ondataavailable` llegaron y cuántos bytes en total. Se resetea al arrancar a grabar; lo lee
  // rec.onstop para componer la línea final. Pico lo muestrea getMicLevel (que el orbe ya llama
  // cada frame) — sin loop nuevo.
  const recDiagRef = useRef<{ lvlPeak: number; chunks: number; bytes: number }>({
    lvlPeak: 0,
    chunks: 0,
    bytes: 0,
  });
  // Prefijo del probe 1 (`rs=… muted=… en=… ctx=… unmute=…`) guardado para que rec.onstop componga
  // la línea completa con él (el onstop no puede leer el state de forma síncrona en su closure).
  const audioDiagMicRef = useRef<string>("");
  // Categoría EFECTIVA del SO leída al reproducir la respuesta de voz (R1: observabilidad del flip a
  // "auto" en playVoice — el único que queda por turno de voz). Para que el owner confirme en device.
  const audioDiagPlayRef = useRef<string>("");
  // Diagnóstico del ÚLTIMO acquireMicStream (solo observabilidad). Distingue el camino tomado
  // (cached/fresh/fresh-default), si esperó una adquisición en vuelo (waited ms), si el getUserMedia
  // corrió dentro del gesto (navigator.userActivation.isActive antes de llamarlo), y el error
  // (name+message) si falló. Lo lee el probe 1 de startRecording cuando acquire devuelve null para
  // mostrar el DETALLE del fallo (antes solo decía `acquire=null`).
  const acquireDiagRef = useRef<{
    path: "cached" | "fresh" | "fresh-default" | "?";
    waitedMs: number;
    gesture: "active" | "stale" | "n/a";
    errName: string;
    errMsg: string;
  }>({ path: "?", waitedMs: 0, gesture: "n/a", errName: "", errMsg: "" });
  // Stream del micrófono REUSADO entre grabaciones. En iOS/WebKit, llamar getUserMedia en
  // cada grabación cuelga la 2ª (no resuelve) → lo pedimos UNA vez y reusamos el mismo stream.
  const micStreamRef = useRef<MediaStream | null>(null);
  // Timer de inactividad para soltar el mic reusado (ver MIC_IDLE_RELEASE_MS) y un ref a
  // releaseMic para que closures (rec.onstop, listeners de visibilidad) lo llamen sin
  // arrastrar dependencias.
  const micIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const releaseMicRef = useRef<() => void>(() => {});
  // Warm-up proactivo del mic al volver al foreground (lo setea un callback más abajo, vía ref para
  // que los listeners de visibilidad lo llamen sin re-armar el effect del canal).
  const warmUpMicRef = useRef<() => void>(() => {});
  // ¿Hay un `getUserMedia` EN VUELO? Serializa la adquisición: en iOS dos getUserMedia simultáneos
  // cuelgan/mutean al previo. El warm-up y el tap comparten esta guarda (nunca dos en vuelo).
  const acquiringMicRef = useRef(false);
  // ¿Hay una intención de grabar EN VUELO (desde el tap hasta que el status real sea "recording" o se
  // aborte)? Latch SINCRÓNICO anti-encolado: mientras adquirimos el mic el `status` sigue en "idle",
  // así que sin esto cada tap repetido re-entra a startRecording y encola otra adquisición → se SUMAN
  // turnos. Con el latch, los taps durante la ventana de adquisición son no-op (una sola grabación).
  // Distinto de `acquiringMicRef` (que cubre sólo el getUserMedia en vuelo) y de `wantRecRef` (que
  // sigue true durante toda la grabación ya arrancada): este cubre el hueco tap→recording-real.
  const armingRef = useRef(false);
  const openRef = useRef<{ repo: string; path: string } | null>(null); // archivo abierto (para refetch)
  const docShaRef = useRef<string | undefined>(undefined); // último sha conocido (para detectar la propagación)
  const docContentRef = useRef<string | undefined>(undefined); // último contenido conocido (lo usa moveDoc para sembrar el cache)
  // Shas que escribimos NOSOTROS (save / rename). El change feed re-emite un {refresh}
  // por nuestra propia escritura; si el refetch ve un sha nuestro, no hay nada que
  // refrescar (empujarlo pisaría el baseSha del editor con un sha viejo en el caso del
  // edge stale del CDN). Se poda para no crecer.
  const selfShasRef = useRef<Set<string>>(new Set());
  const markSelfSha = useCallback((sha: string) => {
    const s = selfShasRef.current;
    s.add(sha);
    if (s.size > 20) s.delete(s.values().next().value as string); // FIFO, acotado
  }, []);
  const handleRef = useRef<string | undefined>(handle); // espejo de `handle` para usar en callbacks sin re-armar (arranca con el cacheado)
  const micIdRef = useRef(micId);

  // El status real lo manejamos con un ref para que los callbacks (SSE, MediaRecorder)
  // no lean un valor viejo por el closure.
  const statusRef = useRef<Status>("connecting");
  const setStat = useCallback((s: Status) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  // --- Envío resiliente (Fase B.2): fallo definitivo → burbuja "no se pudo enviar" -----
  // Payloads de envíos FALLIDOS por id de la burbuja del usuario, para el reintento manual.
  // Solo-sesión (un reload lo descarta) y acotado (un audio fallido puede pesar MB en
  // base64: no acumulamos sin tope). `placeholder` = la burbuja es un placeholder LOCAL de
  // un audio fallido (el `heard` del server nunca llegó); si el reenvío entra, se saca —
  // el server emite `heard` con la transcripción real y ésa es la burbuja definitiva.
  const failedSendsRef = useRef<
    Map<string, { body: Record<string, unknown>; kind: SendKind; placeholder: boolean }>
  >(new Map());
  /** Fallo DEFINITIVO de un envío (agotó timeout + reintentos, o terminal tipo 413):
   *  marca la burbuja del usuario como `failed` (el texto queda visible + "reintentar" si
   *  aplica), guarda el payload para el reenvío y suelta el "pensando". El caption lleva
   *  el aviso al modo orbe (chat cerrado) — NUNCA más un envío que desaparece en silencio. */
  const failSend = useCallback(
    (
      msgId: string,
      failure: SendFailure,
      entry: { body: Record<string, unknown>; kind: SendKind; placeholder: boolean },
    ) => {
      const retryable = retryableFailure(failure);
      const reason = sendFailureMessage(failure, entry.kind);
      dbg(
        `send FAILED kind=${entry.kind} ${failure.reason === "http" ? `http ${failure.status}` : "network"}`,
      );
      if (retryable) {
        const map = failedSendsRef.current;
        map.set(msgId, entry);
        // FIFO acotado: si el usuario acumula fallos, soltamos el payload más viejo (su
        // burbuja queda `failed` pero el botón pasa a no-op — el texto sigue visible).
        while (map.size > FAILED_SENDS_MAX) map.delete(map.keys().next().value as string);
      }
      setMessages((m) =>
        m.map((msg) => (msg.id === msgId ? { ...msg, failed: { reason, retryable } } : msg)),
      );
      setActivity(null);
      setCaption(reason); // modo orbe (chat cerrado): el aviso se ve bajo el orbe
      if (!speakingRef.current) setStat("idle");
    },
    [setStat],
  );
  /** Reintento manual (botón de la burbuja `failed`): re-postea el MISMO payload. Si entra,
   *  listo (y un placeholder de audio se saca: el `heard` del server trae la burbuja real);
   *  si vuelve a fallar, se re-marca. */
  const resend = useCallback(
    (msgId: string) => {
      const entry = failedSendsRef.current.get(msgId);
      if (!entry) return; // sin payload (reload / evicted): no hay qué reenviar
      setMessages((m) => m.map((msg) => (msg.id === msgId ? { ...msg, failed: undefined } : msg)));
      setCaption("");
      setStat("thinking");
      if (entry.kind === "audio") voiceTurnRef.current = true; // reenvío de nota de voz → la respuesta autoplaya
      void postSend(entry.body, entry.kind).then((res) => {
        if (res.ok) {
          failedSendsRef.current.delete(msgId);
          // El placeholder local del audio se va: el server va a empujar `heard` con la
          // transcripción real (la burbuja definitiva de este turno).
          if (entry.placeholder) setMessages((m) => m.filter((msg) => msg.id !== msgId));
          return;
        }
        failSend(msgId, res, entry);
      });
    },
    [failSend, setStat],
  );

  const refreshMics = useCallback(async () => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const inputs = devs.filter((d) => d.kind === "audioinput");
      // Las labels reales sólo aparecen DESPUÉS de conceder permiso de micrófono. Si
      // ninguna tiene label, todavía no autorizaste el mic → la config queda grayed-out.
      setMicsAuthorized(inputs.some((d) => !!d.label));
      setMics(inputs.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Micrófono ${i + 1}` })));
    } catch {
      /* sin permiso aún: las labels llegan tras el primer getUserMedia */
    }
  }, []);

  const setMic = useCallback((id: string) => {
    micIdRef.current = id;
    setMicId(id);
    if (id) localStorage.setItem(MIC_KEY, id);
    else localStorage.removeItem(MIC_KEY);
    // Cambió el mic → invalidamos el stream cacheado para que la próxima grabación lo re-pida
    // con el device nuevo.
    const s = micStreamRef.current;
    if (s) {
      for (const tr of s.getTracks()) tr.stop();
      micStreamRef.current = null;
    }
  }, []);

  // Materializa una entrada en `doc`: hace el GET del archivo y deja `doc` en ready/error.
  // NO toca las pestañas — eso lo hacen open/selectTab/navBack/navForward antes de llamarla.
  // Retry con delays para sortear el read-after-write de la GitHub Contents API: si
  // acabamos de crear el archivo, el siguiente GET puede ver 404 por unos cientos de
  // ms (write y read pegan a edges distintos del CDN). Mismo patrón que `refetch`.
  const loadEntry = useCallback(async (repo: string, path: string) => {
    openRef.current = { repo, path };
    const title = tabTitleOf(path);
    const id = crypto.randomUUID();
    const handle = handleRef.current;
    // ⚠️ CONTAMINACIÓN CRUZADA (data-corruption): loadEntry tiene awaits (delays + fetch). Si el
    // usuario cambia de pestaña / cierra la nota mientras este GET está en vuelo, openRef ya apunta a
    // OTRA nota (o a null). Sin el guard, el setDoc de abajo aplicaría el contenido de ESTA nota a la
    // pestaña que ahora está activa → la nota B mostraría el contenido de A (y el autosave podría
    // guardar A en B). `stale()` (mismo patrón que refetch) aborta apenas openRef dejó de apuntar acá.
    const stale = () => isStaleNote(openRef.current, { repo, path });
    // Cache local (stale-while-revalidate): si la nota ya se abrió antes, la mostramos AL
    // INSTANTE y editable (sin "abriendo…") y revalidamos en background. El sha cacheado es el
    // baseSha del autosave → editar contenido stale cae en el 409 ya manejado por el editor.
    const cached = readNote(handle, repo, path);
    if (cached) {
      setDoc({ id, title, repo, path, status: "ready", content: cached.content, sha: cached.sha });
    } else {
      setDoc({ id, title, repo, path, status: "loading" });
    }
    // Con cache la nota EXISTE (no es el read-after-write de un archivo recién creado): un solo
    // intento de revalidación. Sin cache, la escalera completa para sortear el CDN de GitHub.
    const delays = cached ? [0] : [0, 300, 700, 1500];
    let lastNotFound = false;
    for (let i = 0; i < delays.length; i++) {
      const d = delays[i] ?? 0;
      if (d > 0) await new Promise((r) => setTimeout(r, d));
      if (stale()) return; // cambió/cerró la nota mientras esperábamos → no contaminar la activa
      try {
        const r = await fetch(`/api/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`);
        if (stale()) return; // cambió/cerró mientras el fetch estaba en vuelo
        if (r.status === 404) {
          lastNotFound = true;
          continue; // reintenta — puede ser propagación pendiente
        }
        if (!r.ok) {
          // Sin cache: error. Con cache: nos quedamos con lo stale ante un fallo transitorio.
          if (!cached) setDoc({ id, title, repo, path, status: "error", error: "No pude abrir el archivo." });
          return;
        }
        const f = (await r.json()) as { content?: string; sha?: string };
        if (stale()) return; // cambió/cerró mientras parseábamos la respuesta
        const content = f.content ?? "";
        // El cache SÍ lo escribimos siempre (es keyed por repo+path, no por la nota activa): es
        // correcto sembrar la nota que pedimos aunque ya no esté en foco.
        if (f.sha) writeNote(handle, repo, path, content, f.sha);
        if (!cached) {
          setDoc({ id, title, repo, path, status: "ready", content, sha: f.sha });
        } else if (content !== cached.content) {
          // Mostramos stale y el server vino distinto → empujamos lo fresco por setDoc (mismo
          // id → SIN remontar, Fase C): el editor lo aplica como transacción CM6 si está
          // limpio, o lo difiere a un banner si ya hay tipeo sin guardar. Si vino igual, no
          // tocamos nada → cero parpadeo en el caso común de reabrir una nota intacta.
          setDoc({ id, title, repo, path, status: "ready", content, sha: f.sha });
        }
        return;
      } catch {
        // error de red transitorio, probamos de nuevo
      }
    }
    if (stale()) return; // escalera agotada pero ya no estamos en foco → no pisar la nota activa
    // Escalera agotada. Con cache + 404 real → la nota se borró/renombró afuera: la sacamos del
    // cache para no servir el fantasma en la próxima.
    if (lastNotFound) evictNote(handle, repo, path);
    else if (cached) return; // sólo fallos de red con cache → seguimos con lo stale, sin error
    setDoc({
      id,
      title,
      repo,
      path,
      status: "error",
      error: lastNotFound ? "No encontré el archivo (todavía)." : "Error de red.",
    });
  }, []);

  // Empuja (repo,path) al historial de la pestaña activa, truncando el "forward" como un
  // navegador. Si no hay pestañas, crea la primera. Devuelve sin materializar (eso lo hace
  // quien llama, con loadEntry o setDoc directo). Mantiene tabsRef/activeTabIdRef al día
  // para que llamadas encadenadas en el mismo tick lean el estado nuevo.
  const pushEntryToActiveTab = useCallback((repo: string, path: string) => {
    const entry: TabEntry = { kind: "note", repo, path, title: tabTitleOf(path) };
    const cur = tabsRef.current;
    const activeId = activeTabIdRef.current;
    if (cur.length === 0 || !activeId) {
      const id = crypto.randomUUID();
      const next = [...cur, { id, entries: [entry], cursor: 0 }];
      tabsRef.current = next;
      activeTabIdRef.current = id;
      setTabs(next);
      setActiveTabId(id);
      return;
    }
    const next = cur.map((t) => {
      if (t.id !== activeId) return t;
      const at = t.entries[t.cursor];
      // Guard defensivo: si la activa fuera una pestaña de sistema, no empujar a su historial
      // (no tiene). En el flujo normal applyOpenPlacement ya enruta este caso a "nueva tab"
      // (decideOpenAction con activeIsSystem), así que esta rama no se alcanza desde ahí.
      if (at?.kind === "system") {
        return t;
      }
      if (at && at.repo === repo && at.path === path) return t; // ya es la actual → sin push
      const entries = t.entries.slice(0, t.cursor + 1);
      entries.push(entry);
      const trimmed = entries.length > TAB_HISTORY_MAX ? entries.slice(-TAB_HISTORY_MAX) : entries;
      return { ...t, entries: trimmed, cursor: trimmed.length - 1 };
    });
    tabsRef.current = next;
    setTabs(next);
  }, []);

  // Aplica SÓLO la decisión de pestaña (enfocar / nueva / reemplazar la activa) para (repo,path),
  // sin materializar `doc` (eso lo hace quien llama: loadEntry, o un setDoc directo en `created`).
  // Devuelve la decisión por si el llamador la necesita. Regla en tabFocus.ts (estilo Obsidian):
  // si la nota ya está abierta en otra pestaña → enfocá esa (no duplicar); si no, reemplazá la
  // pestaña activa y empujá a su historial ← → (de ahí salen las flechas back/forward). `newTab`
  // (⌘-click / menú) fuerza pestaña nueva cuando no está abierta.
  // Las pestañas de sistema se ignoran (no tienen repo/path) para el matching de notas.
  const applyOpenPlacement = useCallback(
    (repo: string, path: string, opts?: { newTab?: boolean }) => {
      const flat: OpenTabState[] = tabsRef.current
        .map((t) => {
          const e = t.entries[t.cursor];
          // Las pestañas de sistema no tienen repo/path: excluirlas del matching de notas.
          if (!e || e.kind === "system") return null;
          return { id: t.id, repo: e.repo, path: e.path };
        })
        .filter((x): x is OpenTabState => x !== null);
      // ¿La pestaña activa es una página de sistema? No se le puede empujar una nota a su
      // historial (no tiene), así que decideOpenAction abre la nota en una pestaña nueva.
      const activeTab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
      const activeIsSystem = activeTab?.entries[activeTab.cursor]?.kind === "system";
      const decision = decideOpenAction(repo, path, flat, {
        forceNewTab: opts?.newTab,
        activeIsSystem,
      });
      if (decision.action === "focus") {
        if (activeTabIdRef.current !== decision.tabId) {
          activeTabIdRef.current = decision.tabId;
          setActiveTabId(decision.tabId);
        }
      } else if (decision.action === "new-tab") {
        const id = crypto.randomUUID();
        const entry: TabEntry = { kind: "note", repo, path, title: tabTitleOf(path) };
        const next = [...tabsRef.current, { id, entries: [entry], cursor: 0 }];
        tabsRef.current = next;
        activeTabIdRef.current = id;
        setTabs(next);
        setActiveTabId(id);
      } else {
        pushEntryToActiveTab(repo, path);
      }
      return decision;
    },
    [pushEntryToActiveTab],
  );

  // Abre una página de sistema (singleton): si ya está abierta como tab activa la enfoca;
  // si no, crea una tab nueva de kind:"system". `doc` queda null (no hay archivo real).
  const openSystem = useCallback((page: SystemPage) => {
    const meta = getSystemPageMeta(page);
    // Buscar si ya hay una tab con esta página de sistema.
    const existing = tabsRef.current.find((t) => {
      const e = t.entries[t.cursor];
      return e?.kind === "system" && e.page === page;
    });
    if (existing) {
      // Ya abierta: enfocarla y limpiar doc (no hay archivo real para esta tab).
      if (activeTabIdRef.current !== existing.id) {
        activeTabIdRef.current = existing.id;
        setActiveTabId(existing.id);
        openRef.current = null;
        setDoc(null);
      }
      return;
    }
    // No abierta: crear tab nueva con entry de sistema.
    const id = crypto.randomUUID();
    const entry: TabEntry = { kind: "system", page, title: meta.title };
    const next = [...tabsRef.current, { id, entries: [entry], cursor: 0 }];
    tabsRef.current = next;
    activeTabIdRef.current = id;
    setTabs(next);
    setActiveTabId(id);
    openRef.current = null;
    setDoc(null);
  }, []);

  // Abrir un archivo. Camino único de agente ({t:open}) y explorador. La ubicación de la pestaña
  // la decide applyOpenPlacement (foco-si-ya-abierta + reemplazar la activa por default). `newTab`
  // fuerza pestaña nueva (⌘-click / menú contextual) salvo que ya esté abierta (ahí enfocar gana).
  const open = useCallback(
    (repo: string, path: string, opts?: { newTab?: boolean }) => {
      applyOpenPlacement(repo, path, opts);
      void loadEntry(repo, path);
    },
    [applyOpenPlacement, loadEntry],
  );

  // Pasar a otra pestaña: activarla y cargar su entrada actual si es de nota.
  // Para pestañas de sistema: activar y limpiar doc (no hay archivo real).
  const selectTab = useCallback(
    (id: string) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab || id === activeTabIdRef.current) return;
      activeTabIdRef.current = id;
      setActiveTabId(id);
      const e = tab.entries[tab.cursor];
      if (!e) return;
      // Guard: pestañas de sistema NO fetchean archivo.
      if (e.kind === "system") {
        openRef.current = null;
        setDoc(null);
        return;
      }
      void loadEntry(e.repo, e.path);
    },
    [loadEntry],
  );

  // Cerrar una pestaña. Si era la activa, saltamos a la vecina derecha (o la última); si era
  // la única, volvemos a la pantalla del orbe (doc → null).
  const closeTab = useCallback(
    (id: string) => {
      const cur = tabsRef.current;
      const idx = cur.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const wasActive = activeTabIdRef.current === id;
      const next = cur.filter((t) => t.id !== id);
      tabsRef.current = next;
      setTabs(next);
      if (!wasActive) return;
      if (next.length === 0) {
        activeTabIdRef.current = null;
        setActiveTabId(null);
        openRef.current = null;
        setDoc(null);
        return;
      }
      const pick = next[Math.min(idx, next.length - 1)];
      if (!pick) return;
      activeTabIdRef.current = pick.id;
      setActiveTabId(pick.id);
      const e = pick.entries[pick.cursor];
      if (!e) return;
      // Guard: si la vecina es una pestaña de sistema, no fetchear archivo.
      if (e.kind === "system") {
        openRef.current = null;
        setDoc(null);
        return;
      }
      void loadEntry(e.repo, e.path);
    },
    [loadEntry],
  );

  // Reordena la tira: saca la pestaña `id` y la reinserta justo ANTES de `beforeId`
  // (o al final si beforeId es null / no existe). No toca cuál está activa ni `doc`:
  // sólo cambia el orden visual. La persistencia (efecto de tabs) lo guarda solo.
  const reorderTab = useCallback((id: string, beforeId: string | null) => {
    const cur = tabsRef.current;
    const from = cur.findIndex((t) => t.id === id);
    if (from < 0 || id === beforeId) return;
    const moved = cur[from];
    if (!moved) return;
    const without = cur.filter((t) => t.id !== id);
    const at = beforeId ? without.findIndex((t) => t.id === beforeId) : -1;
    const insertAt = at < 0 ? without.length : at;
    const next = [...without.slice(0, insertAt), moved, ...without.slice(insertAt)];
    // Si el orden no cambió, no re-renderizamos (evita un setState redundante en cada dragover).
    if (next.every((t, i) => t.id === cur[i]?.id)) return;
    tabsRef.current = next;
    setTabs(next);
  }, []);

  // Cierra toda pestaña cuyo archivo actual sea (repo,path) — al borrarlo desde el explorador.
  // Las pestañas de sistema no tienen repo/path: simplemente no coinciden y quedan intactas.
  const closeByPath = useCallback(
    (repo: string, path: string) => {
      for (const t of tabsRef.current) {
        const e = t.entries[t.cursor];
        if (e && e.kind !== "system" && e.repo === repo && e.path === path) closeTab(t.id);
      }
    },
    [closeTab],
  );

  // Re-mapea las pestañas cuando un archivo/carpeta se renombra o se mueve desde el explorer
  // (fromPath → toPath). En vez de CERRAR las pestañas que apuntaban al path viejo (lo que las
  // perdía: al re-seleccionarlas el server tiraba 404 y se cerraban solas), las SEGUIMOS: toda
  // entrada —activa o de fondo, actual o enterrada en el historial— que caiga bajo la op pasa al
  // path nuevo. Esto arregla a la vez (a) la pestaña de fondo huérfana y (b) la race de cambiar de
  // pestaña mientras la op está in-flight: remapeamos por IDENTIDAD de path, no "la pestaña activa
  // ahora", así no robamos el foco ni ensuciamos el historial de la pestaña a la que el user saltó.
  // `isFolder` decide entre match exacto (archivo) o por prefijo `fromPath/` (carpeta, multi-archivo).
  const remapTabs = useCallback((repo: string, fromPath: string, toPath: string, isFolder: boolean) => {
    const cur = tabsRef.current;
    const next = remapTabsEntries(cur, repo, fromPath, toPath, isFolder);
    if (next !== cur) {
      tabsRef.current = next;
      setTabs(next);
    }
    // Si el archivo abierto (la nota materializada en `doc`) cayó bajo la op, seguilo en vivo:
    // movemos el cache local (contenido + sha) al path nuevo, reapuntamos openRef y parcheamos doc
    // SIN remontar el editor (mismo id de pestaña → cursor preservado, estilo renameDoc).
    const open = openRef.current;
    if (open && open.repo === repo) {
      const np = remapPath(open.path, fromPath, toPath, isFolder);
      if (np !== null && np !== open.path) {
        const content = docContentRef.current ?? "";
        const cached = readNote(handleRef.current, repo, open.path);
        evictNote(handleRef.current, repo, open.path);
        writeNote(handleRef.current, repo, np, content, cached?.sha ?? "");
        openRef.current = { repo, path: np };
        const base = np.split("/").pop() ?? np;
        setDoc((prev) => (prev ? { ...prev, path: np, title: base.replace(/\.md$/, "") } : prev));
      }
    }
  }, []);

  // Como `remapTabs` pero CROSS-WIKI: la nota pasó de `(fromRepo, fromPath)` a `(toRepo, toPath)`.
  // Las pestañas que apuntaban a la nota en la wiki vieja la SIGUEN a la nueva (reescribimos repo +
  // path). Si la nota abierta cayó bajo la op, movemos su cache local a (toRepo,toPath) y reapuntamos
  // openRef/doc SIN remontar el editor (cursor preservado). Sólo archivos (no carpetas).
  const remapTabsCross = useCallback((fromRepo: string, fromPath: string, toRepo: string, toPath: string) => {
    const cur = tabsRef.current;
    const next = remapTabsEntriesCross(cur, fromRepo, fromPath, toRepo, toPath, false);
    if (next !== cur) {
      tabsRef.current = next;
      setTabs(next);
    }
    const open = openRef.current;
    if (open && open.repo === fromRepo && open.path === fromPath) {
      const content = docContentRef.current ?? "";
      const cached = readNote(handleRef.current, fromRepo, fromPath);
      evictNote(handleRef.current, fromRepo, fromPath);
      writeNote(handleRef.current, toRepo, toPath, content, cached?.sha ?? "");
      openRef.current = { repo: toRepo, path: toPath };
      const base = toPath.split("/").pop() ?? toPath;
      setDoc((prev) =>
        prev ? { ...prev, repo: toRepo, path: toPath, title: base.replace(/\.md$/, "") } : prev,
      );
    }
  }, []);

  // Registro de operaciones de FS (move/rename) EN VUELO, keyed por id. Mientras un (repo,path)
  // está cubierto por una op viva, el editor no persiste ese archivo (ver noteHasInflightFsOp):
  // así el flush/autosave del editor no escribe al archivo que el move está leyendo → sin el 409
  // "conflict" de la carrera del caso 4. Vive en un ref (no necesita re-render).
  const inflightFsOpsRef = useRef<Map<string, FsOp>>(new Map());
  const beginFsOp = useCallback((op: FsOp) => {
    inflightFsOpsRef.current.set(op.id, op);
  }, []);
  const endFsOp = useCallback((id: string) => {
    inflightFsOpsRef.current.delete(id);
  }, []);
  const noteHasInflightFsOp = useCallback(
    (repo: string, path: string) => pathHasInflightOp(inflightFsOpsRef.current.values(), repo, path),
    [],
  );

  // Cola serial por-repo para MUTACIONES de FS (move/rename/create/delete/archive). Serializa los
  // commits del MISMO repo → dos no se solapan en la ventana headOf→PATCH-ref(force:false), que es
  // la que producía el 422 non-fast-forward → 409 "conflict" espurio cuando dos ops corrían juntas
  // (la carrera de raíz del caso 4 más allá del flush del editor). Per-repo, NO global: repos
  // distintos siguen en paralelo. La consume renameDoc (acá) y el explorer (vía runFsOp).
  const fsOpQueueRef = useRef(createFsOpQueue());
  const runFsOp = useCallback(
    <T>(repo: string, fn: () => Promise<T>): Promise<T> => fsOpQueueRef.current.run(repo, fn),
    [],
  );

  // closeActiveRef: refetch (dentro del efecto SSE) lo usa para cerrar la pestaña activa
  // cuando su archivo desapareció afuera (404). Lo seteamos acá, una vez closeTab existe.
  useEffect(() => {
    closeActiveRef.current = () => {
      const id = activeTabIdRef.current;
      if (id) closeTab(id);
    };
  }, [closeTab]);

  // Navegación back/forward del historial de la pestaña activa (flechas ← →).
  // Las pestañas de sistema tienen un solo entry (cursor=0) → el guard `cursor<=0`/
  // `>=len-1` las deja como no-op naturalmente. Guard explícito por claridad.
  const navBack = useCallback(
    (newTab?: boolean) => {
      const id = activeTabIdRef.current;
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab || tab.cursor <= 0) return;
      const cursor = tab.cursor - 1;
      const e = tab.entries[cursor];
      // ⌘/Ctrl-click: abrir el destino del historial en pestaña NUEVA, sin mover el cursor
      // de la activa (mismo gesto que ⌘-click en el explorer). Sólo notas reales.
      if (newTab && e && e.kind !== "system") {
        open(e.repo, e.path, { newTab: true });
        return;
      }
      const next = tabsRef.current.map((t) => (t.id === id ? { ...t, cursor } : t));
      tabsRef.current = next;
      setTabs(next);
      if (!e || e.kind === "system") return; // guard: sin archivo real
      void loadEntry(e.repo, e.path);
    },
    [loadEntry, open],
  );
  const navForward = useCallback(
    (newTab?: boolean) => {
      const id = activeTabIdRef.current;
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab || tab.cursor >= tab.entries.length - 1) return;
      const cursor = tab.cursor + 1;
      const e = tab.entries[cursor];
      if (newTab && e && e.kind !== "system") {
        open(e.repo, e.path, { newTab: true });
        return;
      }
      const next = tabsRef.current.map((t) => (t.id === id ? { ...t, cursor } : t));
      tabsRef.current = next;
      setTabs(next);
      if (!e || e.kind === "system") return; // guard: sin archivo real
      void loadEntry(e.repo, e.path);
    },
    [loadEntry, open],
  );

  // Restaura un set de pestañas del localStorage (boot): cada una arranca con UN entry y
  // sin historial. Sólo la activa se materializa; el resto carga al activarse.
  // `active === -1` → home mode: las tabs se restauran VIVAS pero ninguna queda activa.
  // Acepta entradas discriminadas (note o system); una entry sin `kind` ≡ note (back-compat
  // con el formato viejo de #335 que guardaba `{repo,path}` sin discriminante).
  type RestoredEntry = { kind?: "note"; repo: string; path: string } | { kind: "system"; page: SystemPage };
  const restoreTabs = useCallback(
    (entries: RestoredEntry[], active: number) => {
      const built: Tab[] = entries.map((e) => {
        if (e.kind === "system") {
          const meta = getSystemPageMeta(e.page);
          return {
            id: crypto.randomUUID(),
            entries: [{ kind: "system" as const, page: e.page, title: meta.title }],
            cursor: 0,
          };
        }
        // note (explícito) o viejo sin kind → tratar como nota (back-compat)
        return {
          id: crypto.randomUUID(),
          entries: [{ kind: "note" as const, repo: e.repo, path: e.path, title: tabTitleOf(e.path) }],
          cursor: 0,
        };
      });
      if (built.length === 0) return;
      // active === -1: home mode — tabs vivas, ninguna activa, no cargamos ningún archivo.
      if (active === -1) {
        tabsRef.current = built;
        activeTabIdRef.current = null;
        setTabs(built);
        setActiveTabId(null);
        return;
      }
      const idx = Math.min(Math.max(0, active), built.length - 1);
      const act = built[idx];
      if (!act) return;
      tabsRef.current = built;
      activeTabIdRef.current = act.id;
      setTabs(built);
      setActiveTabId(act.id);
      const e = act.entries[0];
      if (!e) return;
      // Guard: pestañas de sistema no fetchean archivo al restaurarse.
      if (e.kind === "system") {
        openRef.current = null;
        setDoc(null);
        return;
      }
      void loadEntry(e.repo, e.path);
    },
    [loadEntry],
  );

  // --- login + stream SSE ------------------------------------------------
  useEffect(() => {
    let closed = false;

    const playVoice = (b64: string, mime: string, msgId?: string) => {
      // Nudge: si el ctx quedó suspendido, intentá resumirlo (ya hubo un gesto al mandar).
      if (audioCtxRef.current?.state === "suspended") void audioCtxRef.current.resume();
      // Salida por el PARLANTE a volumen pleno: con un track de mic vivo (aunque sea de un warm-up,
      // sin grabar) la audio-session se queda en play-and-record y la voz sale floja por el
      // auricular (HFP). Gateamos el mic (enabled=false, instantáneo, no re-adquiere) y pedimos
      // "auto" (NUNCA "playback" — eso clavaba la sesión y bloqueaba la captura) → con el mic en
      // silencio, auto rutea la salida a A2DP/parlante. El próximo tap re-habilita y pide
      // play-and-record. Idempotente: si ya estaba en auto, no re-asigna.
      //
      // R1 (Bluetooth del auto): este flip a "auto" antes de reproducir es el ÚNICO que queda por
      // turno de voz (sacamos los de onstop/cancelRecording: el mic queda caliente en play-and-record
      // entre turnos). No lo tocamos a ciegas — lo dejamos OBSERVABLE: leemos la categoría EFECTIVA
      // del SO acá y la pegamos al readout de debug (detrás de debugMode) para que el owner confirme
      // en el device si el ciclado start↔playback todavía hace ciclar la "llamada" en el auto.
      for (const tr of micStreamRef.current?.getTracks() ?? []) tr.enabled = false;
      setAudioSession("auto");
      audioDiagPlayRef.current = `as=${readAudioSessionType() ?? "n/a"}`;
      setAudioDiag(`voz: reproduciendo | ${audioDiagPlayRef.current}`);
      voiceQueueRef.current.push({ b64, mime, msgId });
      if (!speakingRef.current) {
        // setear el flag ANTES de processQueue para que un playVoice() que
        // entre antes de que processQueue arranque su audio no inicie un
        // segundo procesador en paralelo (dos voces a la vez = el bug original).
        speakingRef.current = true;
        processQueue();
      }
    };

    const processQueue = () => {
      const next = voiceQueueRef.current.shift();
      if (!next) {
        speakingRef.current = false;
        setStat("idle");
        return;
      }
      const { b64, mime, msgId } = next;
      const url = URL.createObjectURL(base64ToBlob(b64, mime));
      // Reusar el <audio> bendecido en el gesto (clave para iOS Safari/Brave). Si no existe
      // (voz sin push-to-talk previo, p.ej. tras un mensaje de texto), creamos uno al vuelo:
      // en browsers estrictos puede quedar mudo, pero es el caso de borde.
      const audio = voiceElRef.current ?? new Audio();
      voiceElRef.current = audio;
      audioRef.current = audio;
      audio.src = url;
      // Tap al analyser UNA sola vez por elemento (createMediaElementSource es one-shot por
      // elemento) y sólo con el ctx corriendo. Queda conectado a destination de forma
      // permanente para el nivel reactivo del orbe; como el elemento se reusa, es UN solo
      // nodo en toda la sesión (no hay leak por clip que justifique desconectar).
      const ctx = audioCtxRef.current;
      if (!voiceTapRef.current && ctx && ctx.state === "running" && analyserRef.current) {
        try {
          const node = ctx.createMediaElementSource(audio);
          node.connect(analyserRef.current);
          voiceTapRef.current = node;
        } catch {
          /* ya tapeado o no soportado → suena igual por el grafo */
        }
      }
      setStat("speaking");

      // Player espejo: si el clip pertenece a una burbuja del chat, publicamos el estado de la
      // reproducción (playing/posición/duración) para que la burbuja lo refleje EN CURSO. Los
      // handlers se re-asignan POR CLIP (el elemento es uno solo y reusado); para clips sin
      // burbuja se limpian para no arrastrar estado del clip anterior.
      if (msgId) {
        setVoicePlayback({ msgId, playing: true, t: 0, dur: 0 });
        audio.ontimeupdate = () =>
          setVoicePlayback((p) =>
            p && p.msgId === msgId
              ? {
                  ...p,
                  t: audio.currentTime,
                  dur: Number.isFinite(audio.duration) ? audio.duration : p.dur,
                }
              : p,
          );
        audio.onplay = () => setVoicePlayback((p) => (p && p.msgId === msgId ? { ...p, playing: true } : p));
        audio.onpause = () =>
          setVoicePlayback((p) => (p && p.msgId === msgId ? { ...p, playing: false } : p));
      } else {
        audio.ontimeupdate = null;
        audio.onplay = null;
        audio.onpause = null;
        setVoicePlayback(null);
      }

      const done = () => {
        URL.revokeObjectURL(url);
        setVoicePlayback((p) => (p && p.msgId === msgId ? null : p)); // terminó → la burbuja vuelve al <audio controls>
        processQueue();
      };

      audio.onended = done;
      audio.onerror = done;
      void audio.play().catch(done);
    };

    // Re-fetch silencioso del archivo abierto (sin "abriendo…"): lo dispara el server con
    // {t:refresh} cuando el agente escribió un archivo, para que la vista no quede vieja.
    // La Contents API de GitHub tiene read-after-write inconsistency: el PUT vuelve OK pero
    // el siguiente GET puede ver el blob viejo por unos cientos de ms (read y write pegan a
    // edges distintos del CDN). Reintentamos con espera mientras el sha no cambie; al
    // último intento aceptamos lo que venga.
    //
    // `expectChange` = el feed nombró ESTA nota entre las cambiadas (no es una revalidación a
    // ciegas): sabemos que el blob DEBE cambiar, así que reintentamos con paciencia (escalera larga)
    // hasta que el sha se mueva. Sin esa señal, la escalera corta de revalidación de siempre.
    const refetch = async (expectChange = false) => {
      const cur = openRef.current;
      if (!cur) return;
      // El refetch tiene awaits (delays + fetch ≤ 2.3s): durante esa ventana el usuario puede
      // CERRAR la nota (openRef→null) o cambiar de pestaña (openRef→otra). Si seguimos con el
      // `cur` capturado, el setDoc de abajo REABRIRÍA la nota que cerró (el updater
      // `prev?.id ?? randomUUID()` crea un doc aunque prev sea null) o pisaría la nota vecina.
      // `stale()` detecta que openRef ya no apunta a `cur` → abortamos sin tocar el estado.
      const stale = () => isStaleNote(openRef.current, cur);
      const prevSha = docShaRef.current;
      // expectChange: escalera larga (~9s) — la edición del agente puede tardar en propagar al
      // edge de lectura del CDN. Si no, la escalera corta de revalidación (~2.3s). Ver refreshTarget.ts.
      const delays = refetchDelays(expectChange);
      for (let i = 0; i < delays.length; i++) {
        const d = delays[i] ?? 0;
        if (d > 0) await new Promise((r) => setTimeout(r, d));
        if (stale()) return; // se cerró/cambió la nota mientras esperábamos → no reabrir
        try {
          const r = await fetch(
            `/api/file?repo=${encodeURIComponent(cur.repo)}&path=${encodeURIComponent(cur.path)}`,
          );
          if (stale()) return; // se cerró/cambió mientras el fetch estaba en vuelo
          if (r.status === 404) {
            // El archivo de la pestaña activa fue borrado/renombrado afuera. Cerramos esa
            // pestaña (salta a una vecina, o al orbe si era la última). Sin esto quedaba con
            // el contenido viejo en pantalla y el F5 caía en error.
            evictNote(handleRef.current, cur.repo, cur.path); // sacá el fantasma del cache
            openRef.current = null;
            closeActiveRef.current();
            return;
          }
          if (!r.ok) return;
          const f = (await r.json()) as { content?: string; sha?: string };
          if (stale()) return; // se cerró/cambió mientras parseábamos la respuesta
          const last = i === delays.length - 1;
          if (f.sha !== prevSha || last) {
            const newContent = f.content ?? "";
            // Escritura NUESTRA re-emitida por el feed (save/rename de esta vista), o un
            // edge stale del CDN sirviendo un save nuestro anterior: nada que refrescar.
            // Empujarla al editor le pisaría el baseSha con un sha viejo (409 fantasma) o
            // le haría "retroceder" el contenido; patchDoc ya dejó doc y cache al día.
            if (f.sha && selfShasRef.current.has(f.sha)) return;
            // Cambio EXTERNO real (agente/REM, otra pestaña, out-of-band): entra por setDoc
            // con el MISMO doc.id → el editor NO se remonta (Fase C); decide él: transacción
            // CM6 si el buffer está limpio, banner si hay tipeo sin guardar (Editor.tsx).
            if (f.sha) writeNote(handleRef.current, cur.repo, cur.path, newContent, f.sha); // refrescá el cache local
            const title = tabTitleOf(cur.path);
            setDoc((prev) => ({
              id: prev?.id ?? crypto.randomUUID(),
              title,
              repo: cur.repo,
              path: cur.path,
              status: "ready",
              content: newContent,
              sha: f.sha,
            }));
            return;
          }
        } catch {
          /* reintentamos */
        }
      }
    };

    // Reconexión manual ante error: en iOS, tras el primer turno el EventSource queda errado
    // y NO reconecta solo (un reload abre uno nuevo y anda → el server/red están bien). Sin
    // esto el cliente quedaba "connecting" para siempre y el orbe se deshabilitaba.
    let reconnectT: ReturnType<typeof setTimeout> | undefined;
    function connect() {
      // Guard StrictMode (dev): el effect monta 2× (mount→cleanup→remount). El `boot()` async del
      // PRIMER run sigue en vuelo cuando corre su cleanup (que setea `closed=true`), y al resolver
      // sus awaits igual llamaba a connect() → spawneaba una EventSource ZOMBIE con el MISMO
      // VIEW_SID (constante de módulo) que la del 2º run. El server dedup-ea por sid (register cierra
      // el stream previo) → las dos se expulsaban mutuamente cada ~3s → tormenta de reconexión: el
      // orbe parpadeaba a "connecting" y el textarea (disabled mientras !canSend) PERDÍA EL FOCO cada
      // pocos segundos. Bailar si el run ya fue limpiado deja UNA sola conexión viva.
      if (closed) return;
      // Baseline de liveness: la conexión nueva arranca con la ventana de gracia completa.
      // Sin esto el watchdog mediría contra el último evento de la conexión ANTERIOR y
      // mataría la nueva apenas nace (loop de reconnects).
      lastEventRef.current = Date.now();
      // `sid` (esta vista) en el query: el server taggea el stream y le entrega la respuesta
      // del turno sólo a la vista que preguntó. Mismo sid en cada reconexión (reapunta el stream).
      // `since` (último seq visto, Fase C): un EventSource NUEVO no manda `Last-Event-ID` (eso
      // es del reconnect nativo) — sin esto, el reconnect del watchdog (justo el caso zombie
      // que motiva el replay) no recuperaría nada. El server replay-ea lo que falte.
      const es = new EventSource(streamUrl(VIEW_SID, lastSeqRef.current)); // misma-origin → cookie sola
      esRef.current = es;
      dbg("sse connect()");
      es.onopen = () => {
        dbg("sse OPEN");
        if (reconnectT) {
          clearTimeout(reconnectT);
          reconnectT = undefined;
        }
        setStat("idle");
      };
      es.onerror = () => {
        dbg(`sse ERROR rs=${es.readyState}`);
        if (closed || es.readyState === EventSource.OPEN) return;
        setStat("connecting");
        // Si en 3s sigue sin abrir (el reconnect nativo no prendió, típico en iOS), forzamos
        // un EventSource nuevo —que es lo que hace un reload, y eso SÍ reconecta.
        if (!reconnectT) {
          reconnectT = setTimeout(() => {
            reconnectT = undefined;
            if (closed || esRef.current?.readyState === EventSource.OPEN) return;
            dbg("sse reconnect (manual, 3s sin abrir)");
            try {
              esRef.current?.close();
            } catch {
              /* ya cerrado */
            }
            connect();
          }, 3000);
        }
      };
      es.onmessage = (ev) => {
        lastEventRef.current = Date.now();
        let msg: ServerMsg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        dbg(`rx ${msg.t}`);
        // Keep-alive observable del server (cada 25s): su ÚNICO propósito es el update de
        // lastEventRef de arriba (la señal del watchdog). No toca UI ni estado.
        if (msg.t === "ping") return;
        // Dedup por seq (Fase C): un frame replayed que ESTA vista ya procesó se descarta acá,
        // ANTES de tocar estado — sin esto el replay duplicaría burbujas (heard/text pushean),
        // re-sonaría audio (voice autoplay) y ensuciaría el log de actividad. Cada vista recibe
        // una subsecuencia estrictamente creciente del seq de su usuario (ver frameSeq.ts).
        const dd = acceptFrame(lastSeqRef.current, msg);
        if (!dd.accept) {
          dbg(`rx dup seq=${msg.seq} (replay ya visto) → skip`);
          return;
        }
        lastSeqRef.current = dd.next;
        // Indicador persistente de sub-agente (#29): una sola transición pura para TODOS los
        // frames — enciende con `activity`+`kind:"subagent"`, apaga al fin REAL del turno
        // (`turn-done`) o un `error` terminal, y no toca nada en los demás. Clave: un `text`/`voice`
        // INTERMEDIO ya NO lo apaga (el bug v1) → el badge dura todo el turno (ver subAgent.ts).
        setSubAgent((prev) => subAgentFromFrame(prev, msg));
        // Conteo de sub-agentes activos → N mini-orbs decorando el orb. Una sola transición pura
        // para TODOS los frames: `subagents` adopta el conteo absoluto (única fuente de verdad,
        // re-afirmada por el gateway en cada borde); el resto NO toca — los workers async de
        // archima sobreviven al turno, así que turn-done/error/turno nuevo ya no resetean.
        setSubagentCount((prev) => subagentCountFromFrame(prev, msg));
        if (msg.t === "ready") {
          setName(msg.name ?? msg.handle);
          // Hidratá el inbox del agente (feature crons-delivery): el badge del FAB 🔔 nace con los
          // no-leídos reales en cuanto la conexión está lista (best-effort, no bloquea nada).
          void refreshInbox();
        } else if (msg.t === "inbox") {
          // Push en vivo: un cron de canal web disparó y dejó un item nuevo. Sólo SUBE el badge
          // (no auto-inyectamos la burbuja — verla es por click). Adoptamos el conteo absoluto del
          // frame y refrescamos la lista para tener el `body` listo cuando el usuario clickee.
          if (typeof msg.count === "number") setInboxUnread(msg.count);
          void refreshInbox();
        } else if (msg.t === "typing") {
          // NO creamos una burbuja de "pensando" en el array (creaba puntitos huérfanos:
          // si `typing` llegaba antes que `heard`, la burbuja quedaba arriba del mensaje del
          // usuario y nunca se llenaba). Los puntitos los pinta el chat como indicador al
          // fondo según `status === "thinking"`. La burbuja real del agente se crea cuando
          // llega `text`/`voice`.
          if (!speakingRef.current) setStat("thinking");
        } else if (msg.t === "activity") {
          // Un tool-call / sub-agente arrancó. `label` (amable) y `detail` (params) ya vienen
          // humanizados server-side → los pintamos directo. El hint efímero bajo el orb usa SÓLO
          // el `label` (amable, sin el comando crudo — visible también con debug off); el log del
          // turno (modo debug) guarda `label` + `detail` y los muestra juntos. Llega SIEMPRE (no
          // sólo en debug). Si todavía no estábamos en thinking (ej. el primer signo de vida del
          // turno), reflejamos que el agente trabaja.
          if (msg.label) {
            setActivity(msg.label);
            setActivityLog((l) => [
              ...l,
              { id: crypto.randomUUID(), label: msg.label as string, detail: msg.detail },
            ]);
            if (!speakingRef.current) setStat("thinking");
          }
        } else if (msg.t === "chat-title") {
          // Título del chat (tema actual): el gateway lo generó tras un turno con sustancia. Lo
          // mostramos en el header del chat (reemplaza el "Chat: <fecha>" estático). Persiste en
          // el efecto de abajo, junto al historial.
          if (msg.title) setChatTitle(msg.title);
        } else if (msg.t === "heard") {
          // El server transcribió lo que dije por voz → es la nueva "pregunta". Reemplaza
          // el eco anterior y limpia la respuesta vieja (sólo última Q + última A a la vez).
          if (msg.text) {
            setUserEcho({ mode: "voice", text: msg.text });
            setCaption("");
            pushUserMsg("voice", msg.text); // turno del usuario en el historial del chat
          }
        } else if (msg.t === "text") {
          if (msg.text) {
            setCaption(msg.text);
            appendAgentMsg({ text: msg.text, thinking: false });
          }
          setActivity(null); // llegó la respuesta → se apaga el hint de actividad en vuelo
          if (!speakingRef.current) setStat("idle");
        } else if (msg.t === "voice" && msg.data) {
          // Además del autoplay del turno, adjuntamos el audio a la burbuja como blob URL
          // para que quede reproducible inline en el chat (un `<audio>`). El URL vive lo que
          // dura la sesión (el historial es solo-sesión; al recargar se descarta todo).
          // La transcripción viaja en el mismo frame (`text`): la mostramos en el chat
          // (burbuja) y en el caption del orbe — así una respuesta de voz también queda
          // como texto en el historial (#1/#2). Para respuestas de voz NO llega un evento
          // `text` aparte; este es el único lugar donde tenemos la transcripción.
          const mime = msg.mime ?? "audio/ogg";
          const audioUrl = URL.createObjectURL(base64ToBlob(msg.data, mime));
          setActivity(null); // llegó la respuesta en voz → se apaga el hint de actividad
          if (msg.text) setCaption(msg.text);
          const voiceMsgId = appendAgentMsg({
            mode: "voice",
            thinking: false,
            audioUrl,
            ...(msg.text ? { text: msg.text } : {}),
          });
          // Autoplay (ver shouldAutoplayVoice): con el chat cerrado (orbe) siempre; con el chat
          // abierto sólo si ESTE turno lo inició una NOTA DE VOZ del usuario — mandaste audio →
          // la respuesta suena sola y la burbuja espeja la reproducción (voicePlayback, vía el
          // msgId que ata el clip a su burbuja). Texto + chat abierto → manual (Telegram-like):
          // la burbuja trae un `<audio controls>` y el user lo dispara a mano.
          // Si el usuario MUTEÓ este turno (tap en el orbe mientras hablaba), o lo CANCELÓ (cancelTurn
          // también prende `mutedTurnRef` como defensa), `muted` manda: el clip que llega NO suena (la
          // transcripción ya se appendeó arriba a la burbuja, con su <audio> para play manual).
          if (shouldAutoplayVoice(autoplayVoiceRef.current, voiceTurnRef.current, mutedTurnRef.current))
            playVoice(msg.data, mime, voiceMsgId);
          else if (!speakingRef.current) setStat("idle"); // no cuelgues el orbe en "pensando"
        } else if (msg.t === "open" && msg.repo && msg.path) {
          void open(msg.repo, msg.path);
        } else if (msg.t === "created" && msg.repo && msg.path) {
          // viewer_create atómico: el agente creó el archivo en la wiki Y nos pasó
          // el sha. Montamos directo en `ready` (sin GET extra, sortea el
          // read-after-write de la Contents API). El content inicial es el mismo
          // que escribió viewer_create: `# <basename>\n\n` para que el editor
          // muestre el título grande de una.
          openRef.current = { repo: msg.repo, path: msg.path };
          // Nota recién creada por el agente → pestaña NUEVA (no clobberea la nota que estabas
          // viendo). Si por casualidad ya estuviera abierta, decideOpenAction la enfoca igual.
          // (Abrir una nota EXISTENTE —msg.t==="open"— sigue siendo replace-active, estilo Obsidian.)
          applyOpenPlacement(msg.repo, msg.path, { newTab: true });
          const title = msg.path.split("/").pop() ?? msg.path;
          const base = title.replace(/\.md$/, "");
          const id = crypto.randomUUID();
          const createdContent = `# ${base}\n\n`;
          if (msg.sha) writeNote(handleRef.current, msg.repo, msg.path, createdContent, msg.sha); // sembrá el cache
          setDoc({
            id,
            title,
            repo: msg.repo,
            path: msg.path,
            status: "ready",
            content: createdContent,
            sha: msg.sha,
          });
          setTreeSeq((s) => s + 1); // nota nueva creada por el agente → refrescá el árbol
        } else if (msg.t === "refresh") {
          // Una wiki del user cambió (feed): refetch del archivo abierto (si lo hay, y lo
          // cierra si fue borrado) + bump de treeSeq → el Explorer recarga su árbol al
          // instante (Fase 3a), sin esperar su poll de 5s.
          // Si el feed nombró la nota ABIERTA entre las cambiadas (típico: el agente la editó),
          // el refetch reintenta con paciencia hasta ver el sha nuevo (sortea el CDN de GitHub).
          void refetch(refreshHitsOpen(openRef.current, msg.changed));
          setTreeSeq((s) => s + 1);
        } else if (msg.t === "turn-done") {
          // Fin REAL del turno. Apaga "pensando" si quedó colgado sin respuesta — ej. el guard de
          // STT que ignora un audio silencioso/corto: el gateway termina el turno sin postear, y sin
          // esto el orb se quedaba trabado en "pensando". No tocamos "speaking" (la nota de voz
          // puede seguir sonando; al terminar, el handler de voz pone idle). En turnos normales es
          // idempotente: el `text`/`voice` ya puso idle antes.
          setActivity(null);
          if (!speakingRef.current) setStat("idle");
        } else if (msg.t === "notice") {
          // Aviso de SISTEMA (conversación compactada / reiniciada): NO es voz del agente ni un
          // error. Lo agregamos al historial como una línea de sistema atenuada (role:"system").
          // NO tocamos el estado del turno (no apaga "pensando" ni el orb): la auto-compaction
          // dispara ANTES del turno del modelo, así que el aviso puede llegar mid-turno y el turno
          // sigue su curso. Tampoco rompe el upsert de la burbuja del agente (usa su propio id).
          if (msg.text) {
            setMessages((m) => [
              ...m,
              { id: crypto.randomUUID(), role: "system", mode: "text", text: msg.text as string },
            ]);
          }
        } else if (msg.t === "resync") {
          // Fase C: la caída fue MÁS larga que lo que el buffer del server conserva → el replay
          // que sigue puede tener huecos. Señal suave de "refrescá el estado": re-fetch de la
          // nota abierta + recarga del árbol (lo mismo que un `refresh`), y soltar un "pensando"
          // colgado — si la respuesta de ese turno cayó en el hueco, no va a llegar nunca y el
          // orbe no debe quedar girando. El chat NO se toca (no inventamos frames perdidos).
          dbg("rx resync (hueco > buffer del server) → refresh de estado");
          setActivity(null);
          if (!speakingRef.current && statusRef.current === "thinking") setStat("idle");
          void refetch(false);
          setTreeSeq((s) => s + 1);
        } else if (msg.t === "error") {
          setCaption(msg.error ?? "error");
          appendAgentMsg({ text: msg.error ?? "error", thinking: false });
          setActivity(null);
          setStat("idle");
        }
      };
    }

    // --- Watchdog de liveness (Fase A, conexión rock-solid) ---------------------------
    // Cubre el modo de caída que `onerror` NO ve: la conexión half-open (sleep / cambio de
    // red) donde el EventSource queda OPEN-zombie para siempre y, como el edge es HTTP/2,
    // arrastra también los POST salientes. Es ADICIONAL al reconnect manual de 3s de arriba
    // (que cubre el "stuck CONNECTING" de iOS, otro modo distinto). La decisión (umbrales,
    // debounce anti-doble-reconnect) es pura y testeada en liveness.ts; acá va sólo el
    // wiring browser (interval + listeners).
    const forceReconnect = () => {
      if (closed) return;
      // Matamos el timer del reconnect-iOS para no encadenar un connect() duplicado en 3s.
      if (reconnectT) {
        clearTimeout(reconnectT);
        reconnectT = undefined;
      }
      try {
        esRef.current?.close();
      } catch {
        /* ya cerrado */
      }
      setStat("connecting");
      connect();
    };
    const liveness = createLiveness({
      getReadyState: () => esRef.current?.readyState ?? -1,
      getLastEventAt: () => lastEventRef.current,
      reconnect: forceReconnect,
    });
    const watchdogT = setInterval(() => {
      if (closed) return;
      if (liveness.check()) dbg("sse watchdog: zombie (sin eventos) → reconnect");
    }, WATCHDOG_TICK_MS);
    // Gatillos rápidos: al volver el tab a visible o la red a online (despertar del sleep,
    // cambio de wifi), si la conexión no está OPEN o el último evento ya es viejo,
    // reconectamos YA — el browser suspende los timers durante el sleep, así que el
    // watchdog solo tardaría un tick entero en enterarse.
    const onOnline = () => {
      if (closed) return;
      if (liveness.wake()) dbg("sse wake (online) → reconnect");
    };
    // Al VOLVER al foreground iOS deja el AudioContext SUSPENDIDO (lo suspende solo al ir a
    // background; NO lo cerramos — ver onHide). Sin recuperarlo el orbe no late (el analyser lee
    // silencio → getAudioLevel ≈ 0) y la voz del chat no suena hasta el próximo gesto. Acá, al volver
    // visible: (1) resumimos el ctx (existe y está suspendido — clave: la respuesta puede AUTOPLAYAR
    // sin gesto, así que el contexto tiene que poder resumirse, por eso no se cierra en background);
    // (2) revalidamos que el analyser de PLAYBACK siga colgado de destination (defensivo, como
    // getMicLevel recrea el del mic); (3) warm-up del mic ANTES del tap (ver warmUpMic) → el primer
    // tap graba audio real de una (esperando el `unmute`) en vez de la ilusión de 2s. NO tocamos
    // `navigator.audioSession`: la salida al parlante se logra NO teniendo mic vivo durante la
    // reproducción, no flippeando el type.
    const recoverAudioOnFocus = () => {
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === "suspended") void ctx.resume();
      // El analyser de playback queda conectado a destination de forma permanente, pero tras un
      // resume iOS a veces lo deja "huérfano"; re-conectar es idempotente (un nodo ya conectado no
      // se duplica) y barato.
      if (ctx && ctx.state !== "closed" && analyserRef.current) {
        try {
          analyserRef.current.connect(ctx.destination);
        } catch {
          /* ya conectado / estado raro → la voz suena igual por el grafo */
        }
      }
      // Warm-up proactivo del mic: re-adquirí (esperando el unmute) mientras estás idle para que el
      // próximo tap sea instantáneo y grabe audio REAL de una. Best-effort y silencioso (sin prompt
      // si ya hay permiso); si el permiso no está concedido no fuerza nada (lo hará el tap).
      if (statusRef.current === "idle") warmUpMicRef.current();
    };
    const onVisible = () => {
      if (closed || document.visibilityState !== "visible") return;
      recoverAudioOnFocus();
      if (liveness.wake()) dbg("sse wake (visible) → reconnect");
    };
    // En iOS/WebKit `visibilitychange` no siempre dispara al volver (sobre todo en PWA/home-app):
    // `focus` (window) y `pageshow` (vuelta del bfcache) cubren esos casos. Solo recuperan el audio;
    // el wake del SSE ya lo hace onVisible/onOnline. Guard `closed` para no tocar nada tras desmontar.
    const onFocusRecover = () => {
      if (!closed) recoverAudioOnFocus();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocusRecover);
    window.addEventListener("pageshow", onFocusRecover);

    // Canje del magic-link (si vino ?t=) → cookie; después /api/me confirma sesión.
    const boot = async () => {
      try {
        const params = new URLSearchParams(location.search);
        const t = params.get("t");
        // Deep-link: el path real `/<repo>/<path…>` (esquema en deepLink.ts) abre ese archivo
        // directo (tiene prioridad sobre el doc cacheado en localStorage). Lo leemos ACÁ, del
        // pathname, antes de cualquier replaceState (el canje del token sólo toca el query, no
        // el path). App.tsx mantiene la URL en sync al abrir/cerrar.
        // Las páginas de sistema tienen prioridad: `/<slug>` (1 segmento) vs `/<repo>/<path…>` (≥2).
        const deepSystemPage = parseSystemUrl(location.pathname);
        const deep = deepSystemPage ? null : parseNoteUrl(location.pathname);
        const deepRepo = deep?.repo ?? null;
        const deepPath = deep?.path ?? null;
        if (t) {
          const r = await fetch("/api/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ t }),
          });
          history.replaceState(null, "", location.pathname); // saca el token de la URL
          if (!r.ok) {
            setStat("unauth");
            return;
          }
        }
        const me = await fetch("/api/me");
        if (!me.ok) {
          setStat("unauth");
          return;
        }
        const who = (await me.json()) as {
          name?: string;
          location?: string | null;
          handle?: string;
          email?: string | null;
          hasPassword?: boolean;
          hasAvatar?: boolean;
          defaultWiki?: string;
          voice?: VoiceCfg;
          model?: ModelCfg;
          bgQueries?: string[];
        };
        setName(who.name ?? who.handle);
        setUserLocation(who.location ?? undefined);
        setEmail(who.email ?? undefined);
        if (who.hasPassword !== undefined) setHasPassword(who.hasPassword);
        setHasAvatar(!!who.hasAvatar);
        setDefaultWiki(who.defaultWiki);
        if (who.voice) setVoiceState(who.voice);
        if (who.model) setModelState(who.model);
        if (who.bgQueries) setBgQueriesState(who.bgQueries);
        if (who.handle) {
          handleRef.current = who.handle;
          setHandle(who.handle);
          // Si el handle confirmado difiere del cacheado con el que hidratamos el chat,
          // recargá el historial del usuario correcto antes de que la persistencia corra
          // (sino escribiríamos el chat del user anterior en la key de este).
          if (who.handle !== hydratedHandleRef.current) {
            hydratedHandleRef.current = who.handle;
            setMessages(loadChat(who.handle));
            setChatStartedAt(readChatStarted(who.handle));
            setChatTitle(readChatTitle(who.handle));
          }
          try {
            localStorage.setItem(HANDLE_KEY, who.handle);
          } catch {
            /* localStorage no disponible */
          }
          // Restauración de pestañas en el F5. Primero leemos las pestañas cacheadas (formato
          // nuevo { tabs:[{repo,path}|{kind:"system",page}], active }; back-compat al viejo
          // { repo, path } de cuando era una sola nota). El deep-link de la URL NO pisa las
          // tabs: sólo elige cuál queda activa (y la agrega si no estaba). Sin pestañas
          // cacheadas, el deep-link abre esa nota sola (caso de un link compartido).
          // Key corrupta → la limpiamos.
          type PersistedEntry =
            | { kind?: "note"; repo: string; path: string }
            | { kind: "system"; page: SystemPage };
          const isNoteEntry = (e: unknown): e is { repo: string; path: string } =>
            !!e &&
            typeof (e as Record<string, unknown>).repo === "string" &&
            typeof (e as Record<string, unknown>).path === "string";
          const isSystemEntry = (e: unknown): e is { kind: "system"; page: SystemPage } =>
            !!e &&
            (e as Record<string, unknown>).kind === "system" &&
            typeof (e as Record<string, unknown>).page === "string" &&
            isSystemPage((e as { page?: unknown }).page);
          let entries: PersistedEntry[] = [];
          let active = 0;
          try {
            const saved = localStorage.getItem(`${DOC_KEY_PREFIX}${who.handle}`);
            if (saved) {
              const parsed = JSON.parse(saved) as {
                tabs?: unknown[];
                active?: number;
                repo?: string;
                path?: string;
              };
              if (Array.isArray(parsed?.tabs)) {
                entries = parsed.tabs.filter((e): e is PersistedEntry => isNoteEntry(e) || isSystemEntry(e));
                active = typeof parsed.active === "number" ? parsed.active : 0;
              } else if (isNoteEntry(parsed)) {
                // back-compat: formato viejo de una sola nota (antes de las tabs)
                entries = [parsed];
              }
            }
          } catch {
            localStorage.removeItem(`${DOC_KEY_PREFIX}${who.handle}`);
          }
          if (entries.length > 0) {
            // Hay pestañas guardadas: el deep-link sólo decide la activa (la agrega si falta).
            if (deepSystemPage) {
              const idx = entries.findIndex((e) => e.kind === "system" && e.page === deepSystemPage);
              if (idx >= 0) {
                active = idx;
              } else {
                entries.push({ kind: "system", page: deepSystemPage });
                active = entries.length - 1;
              }
            } else if (deepRepo && deepPath) {
              const idx = entries.findIndex(
                (e) => e.kind !== "system" && e.repo === deepRepo && e.path === deepPath,
              );
              if (idx >= 0) {
                active = idx;
              } else {
                entries.push({ repo: deepRepo, path: deepPath });
                active = entries.length - 1;
              }
            }
            restoreTabs(entries, active);
          } else if (deepSystemPage) {
            openSystem(deepSystemPage);
          } else if (deepRepo && deepPath) {
            void open(deepRepo, deepPath);
          }
        }
        void refreshMics();
        connect();
      } finally {
        setBooting(false); // sea sesión válida o unauth (o error), el splash de boot se va
      }
    };

    void boot();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshMics);
    return () => {
      closed = true;
      if (reconnectT) clearTimeout(reconnectT);
      clearInterval(watchdogT);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocusRecover);
      window.removeEventListener("pageshow", onFocusRecover);
      esRef.current?.close();
      // Soltar el mic reusado al desmontar (libera el indicador de grabación del SO).
      const ms = micStreamRef.current;
      if (ms) {
        for (const tr of ms.getTracks()) tr.stop();
        micStreamRef.current = null;
      }
      // Drenar audio: si el componente desmonta mientras está hablando, parar
      // lo que suena y descartar la cola pendiente (sin esto el audio seguía
      // sonando y los items en cola se reproducían igual).
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.src = "";
        audioRef.current = null;
      }
      voiceQueueRef.current = [];
      speakingRef.current = false;
      setVoicePlayback(null);
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshMics);
      // Cerrar el AudioContext: el browser tiene un límite duro (~6) y en dev con HMR cada
      // remount dejaba uno vivo → al agotarlo `new AudioContext()` tiraba (y perdías el
      // nivel reactivo). En prod libera el grafo de audio del usuario al cerrar la vista.
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state !== "closed") void ctx.close();
      audioCtxRef.current = null;
      analyserRef.current = null;
      audioDataRef.current = null;
      // El <audio> reusado y su tap mueren con el ctx; soltamos las refs para el próximo mount.
      voiceElRef.current = null;
      voiceTapRef.current = null;
    };
  }, [
    setStat,
    refreshMics,
    open,
    openSystem,
    applyOpenPlacement,
    restoreTabs,
    pushUserMsg,
    appendAgentMsg,
    refreshInbox,
  ]);

  // Espejo del sha del archivo abierto. Lo usa refetch() para distinguir si la
  // Contents API ya propagó el último write o todavía está sirviendo el blob viejo.
  useEffect(() => {
    docShaRef.current = doc?.sha;
  }, [doc?.sha]);

  // Espejo del contenido — moveDoc lo usa para sembrar el cache local del path nuevo.
  useEffect(() => {
    docContentRef.current = doc?.content;
  }, [doc?.content]);

  // --- push-to-talk ------------------------------------------------------
  // Crea (lazy, en un gesto del usuario) el AudioContext + AnalyserNode y lo resume. El
  // analyser queda conectado a destination; los clips de voz se enrutan a él en processQueue.
  const ensureAudioCtx = useCallback(() => {
    try {
      if (!audioCtxRef.current) {
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return null;
        const ctx = new Ctx();
        const an = ctx.createAnalyser();
        an.fftSize = 256;
        an.smoothingTimeConstant = 0.7;
        an.connect(ctx.destination);
        audioCtxRef.current = ctx;
        analyserRef.current = an;
        audioDataRef.current = new Uint8Array(new ArrayBuffer(an.fftSize));
      }
      if (audioCtxRef.current.state === "suspended") void audioCtxRef.current.resume();
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }, []);

  // Suelta el micrófono reusado: corta los tracks (apaga el indicador de "mic en uso" del SO,
  // que en iOS/WebKit hace que CarPlay vea una "llamada en curso") y descarta el analyser y el
  // MediaRecorder reusados → el próximo startRecording re-adquiere stream y recorder limpios.
  // Sólo llamar cuando NO se está grabando.
  const releaseMic = useCallback(() => {
    if (micIdleTimerRef.current) {
      clearTimeout(micIdleTimerRef.current);
      micIdleTimerRef.current = null;
    }
    try {
      micSrcRef.current?.disconnect();
    } catch {
      /* nodo ya desconectado */
    }
    micSrcRef.current = null;
    micAnalyserRef.current = null;
    const rec = recRef.current;
    if (rec) {
      try {
        if (rec.state !== "inactive") rec.stop();
      } catch {
        /* lo descartamos igual */
      }
      recRef.current = null;
    }
    const ms = micStreamRef.current;
    if (ms) {
      for (const tr of ms.getTracks()) tr.stop();
      micStreamRef.current = null;
    }
    // Soltado el track no queda nada capturando → pedimos "auto" (el default compatible con captura
    // futura): rutea la salida a A2DP/parlante y apaga el indicador de "llamada" en CarPlay. NUNCA
    // "playback" (clavaba la sesión y bloqueaba el próximo getUserMedia). Idempotente.
    setAudioSession("auto");
    dbg("mic: released (idle/hidden)");
  }, []);
  releaseMicRef.current = releaseMic;

  // (Re)arma el timer de inactividad: si pasan MIC_IDLE_RELEASE_MS sin grabar (y seguimos
  // idle), soltamos el mic. Se llama al terminar una grabación; startRecording lo cancela.
  const armMicIdleTimer = useCallback(() => {
    if (micIdleTimerRef.current) clearTimeout(micIdleTimerRef.current);
    micIdleTimerRef.current = setTimeout(() => {
      micIdleTimerRef.current = null;
      if (statusRef.current === "idle") releaseMicRef.current();
    }, MIC_IDLE_RELEASE_MS);
  }, []);

  // Cada vez que volvemos a idle con un mic reusado vivo, (re)armamos el timer de inactividad.
  // Cubre los turnos largos (el timer que se hubiera armado al grabar ya habría disparado en
  // medio del "pensando"/"hablando", donde el guard lo ignora) — al cerrar el turno re-arma.
  useEffect(() => {
    if (status === "idle" && micStreamRef.current) armMicIdleTimer();
  }, [status, armMicIdleTimer]);

  // Soltar el mic al pasar a background (pantalla de inicio / cambio de app). Fix del bug de CarPlay:
  // un track de mic VIVO mantiene viva la audio-session del SO → iOS la muestra como "llamada en
  // curso" (CarPlay wireless queda colgado). El stop del track (releaseMic) es lo que la libera.
  // `pagehide` cubre iOS/WebKit cuando congela el tab, donde `visibilitychange` no siempre dispara.
  // No soltamos en medio de una grabación (el usuario sigue hablando).
  //
  // NO cerramos el AudioContext en background: cerrarlo rompía el autoplay de la respuesta al volver
  // —un ctx cerrado se recrea suspendido y NO se puede resumir sin un gesto, así que la voz que
  // autoplaya sonaba a volumen CERO hasta dar play en la burbuja (un gesto)— y dejaba el analyser del
  // mic colgado de un contexto muerto (animación quieta). El SO lo suspende solo en background y
  // recoverAudioOnFocus lo resume al volver (comportamiento de #640). La "llamada" HFP la libera el
  // stop del track, no el cierre del contexto. (Si reapareciera la "llamada pegada" sin mic vivo, se
  // revisa aparte.)
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== "hidden" || statusRef.current === "recording") return;
      releaseMicRef.current();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    };
  }, []);

  // Nivel de audio actual (RMS 0..1) de la voz que suena — lo lee el orbe WebGL cada frame.
  // 0 si no hay analyser o no está hablando.
  const getAudioLevel = useCallback(() => {
    const an = analyserRef.current;
    const data = audioDataRef.current;
    if (!an || !data || !speakingRef.current) return 0;
    an.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = ((data[i] ?? 128) - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / data.length) * 3.2);
  }, []);

  // Nivel del micrófono (RMS 0..1) mientras grabás — lo leen los palitos del input.
  // Robusto: (1) si el AudioContext quedó suspendido (autoplay policy), el analyser lee
  // SILENCIO aunque el MediaRecorder grabe bien → la onda quedaba plana; lo resumimos acá.
  // (2) si el analyser no quedó armado en startRecording (carrera/excepción), lo recreamos
  // del stream vivo. Sin esto la onda no reaccionaba aunque el audio entrara.
  const getMicLevel = useCallback(() => {
    if (statusRef.current !== "recording") return 0;
    const ctx = audioCtxRef.current;
    if (ctx?.state === "suspended") void ctx.resume();
    let an = micAnalyserRef.current;
    let data = micDataRef.current;
    if ((!an || !data) && ctx && micStreamRef.current) {
      try {
        const fresh = ctx.createAnalyser();
        fresh.fftSize = 256;
        fresh.smoothingTimeConstant = 0.6;
        const src = ctx.createMediaStreamSource(micStreamRef.current);
        src.connect(fresh);
        micSrcRef.current?.disconnect();
        micSrcRef.current = src;
        micAnalyserRef.current = fresh;
        micDataRef.current = new Uint8Array(new ArrayBuffer(fresh.fftSize));
        an = fresh;
        data = micDataRef.current;
      } catch {
        return 0;
      }
    }
    if (!an || !data) return 0;
    an.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = ((data[i] ?? 128) - 128) / 128;
      sum += v * v;
    }
    const level = Math.min(1, Math.sqrt(sum / data.length) * 4.5);
    // Probe 2 (debug): guardá el PICO de nivel visto en esta grabación, reusando el muestreo que el
    // orbe ya hace cada frame (sin loop nuevo). lvlPeak≈0 con bytes>0 = recorder captura pero el
    // analyser lee silencio (ctx suspendido / ruteo); bytes=0 = el recorder no entrega nada.
    if (level > recDiagRef.current.lvlPeak) recDiagRef.current.lvlPeak = level;
    return level;
  }, []);

  // Debug (?debug=1): estado del canal SSE para el overlay.
  const sseState = useCallback(() => esRef.current?.readyState ?? -1, []);
  const lastEventAgo = useCallback(() => (lastEventRef.current ? Date.now() - lastEventRef.current : -1), []);

  // "Bendecir" el audio de la respuesta DENTRO de un gesto del usuario: habilita el AudioContext
  // (audio reactivo) y desbloquea el <audio> reproduciendo un blip silencioso, para que el play()
  // diferido que dispara el SSE no quede bloqueado por la policy de autoplay (iOS Safari/Brave).
  // Se llama desde startRecording, PERO también desde el orbe flotante en el `pointerdown` (ahí la
  // grabación se DIFIERE hasta que el dedo se queda quieto; el unlock tiene que pasar igual dentro
  // del gesto, no en el timer). Es idempotente: reusa el mismo <audio>.
  const primeAudioPlayback = useCallback(() => {
    ensureAudioCtx(); // gesto → habilita el AudioContext para el audio reactivo de la respuesta
    let el = voiceElRef.current;
    if (!el) {
      el = new Audio();
      el.preload = "auto";
      voiceElRef.current = el;
      audioRef.current = el;
    }
    try {
      // CRÍTICO: limpiar los handlers de la reproducción anterior ANTES del blip. Este <audio>
      // se reusa para la voz del agente, y processQueue le deja `onended`/`onerror = done`. Si
      // no los borramos, el pause() del blip dispara ese `done` viejo → processQueue() ve la
      // cola vacía → setStat("idle"), que pisa al setStat("recording") de más abajo. Ese era el
      // bug "anda la 1ª vez y nunca más": recién tras la 1ª respuesta de voz queda el handler
      // colgado, y desde ahí cada press se auto-cancela a idle (el recorder seguía grabando
      // huérfano porque stopRecording veía status=idle y no lo frenaba).
      el.onended = null;
      el.onerror = null;
      el.muted = false;
      el.src = SILENT_WAV;
      el.play()
        .then(() => el?.pause())
        .catch(() => {});
    } catch {
      /* sin bless → el primer clip puede quedar mudo en browsers estrictos */
    }
  }, [ensureAudioCtx]);

  const setVoiceAutoplay = useCallback((on: boolean) => {
    autoplayVoiceRef.current = on;
  }, []);

  // Controles del player ESPEJO de la burbuja: operan sobre el <audio> compartido que ya está
  // sonando (audioRef). El estado visible (playing/t) lo actualizan los handlers onplay/onpause/
  // ontimeupdate que processQueue le colgó al clip — acá sólo se comanda el elemento. El play()
  // del resume corre dentro del click del usuario, así que no lo bloquea ninguna autoplay policy.
  // Pausar SUELTA el turno (speaking→idle): sin eso el status quedaba clavado en "speaking" y el
  // mic del chat / el orbe (que exigen idle) quedaban muertos hasta reanudar. Si con el clip
  // pausado llega o se dispara OTRA voz, playVoice ve speakingRef=false y arranca la cola sobre
  // el mismo elemento (pisa el clip pausado; su burbuja cae al <audio controls> para re-escuchar).
  const toggleVoicePlayback = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      speakingRef.current = true;
      setStat("speaking");
      void a.play().catch(() => {});
    } else {
      a.pause();
      speakingRef.current = false;
      setStat("idle");
    }
  }, [setStat]);

  const seekVoicePlayback = useCallback((t: number) => {
    const a = audioRef.current;
    if (!a) return;
    try {
      a.currentTime = t;
    } catch {
      /* metadata todavía no cargó → ignoramos el seek */
    }
    // Reflejo inmediato: con el clip PAUSADO no hay timeupdate que arrastre la posición.
    setVoicePlayback((p) => (p ? { ...p, t } : p));
  }, []);

  // Adquiere un stream de mic LISTO PARA CAPTURAR, serializando el getUserMedia (en iOS dos en
  // vuelo cuelgan/mutean al previo → nunca dos a la vez, guarda `acquiringMicRef`). Reusa el stream
  // cacheado si sigue VIVO (clave en iOS: el 2º getUserMedia se cuelga); si murió o no hay, pide uno
  // nuevo. Tras tenerlo, habilita los tracks (`enabled=true`) y ESPERA a que el track esté
  // des-muteado (evento `unmute`, con tope UNMUTE_TIMEOUT_MS): tras background / cambio de ruta
  // Bluetooth el track nace `muted` y entrega silencio hasta el unmute — devolverlo antes mostraría
  // la ILUSIÓN de grabar. Devuelve el stream listo, o null si falla / nadie lo quiere ya.
  const acquireMicStream = useCallback(async (): Promise<MediaStream | null> => {
    // Diagnóstico (solo observabilidad): reseteamos el del acquire nuevo y leemos si el gesto del
    // usuario sigue activo (hipótesis: getUserMedia fuera del gesto en iOS). userActivation es una
    // lectura barata; no cambia nada del flujo.
    const ua = (navigator as unknown as { userActivation?: { isActive?: boolean } }).userActivation;
    const gesture: "active" | "stale" | "n/a" = ua ? (ua.isActive ? "active" : "stale") : "n/a";
    acquireDiagRef.current = { path: "?", waitedMs: 0, gesture, errName: "", errMsg: "" };
    // Serialización: si ya hay una adquisición en vuelo, esperá a que termine y reusá su resultado.
    const waitStart = Date.now();
    while (acquiringMicRef.current) await new Promise((r) => setTimeout(r, 30));
    acquireDiagRef.current.waitedMs = Date.now() - waitStart; // 0 si no esperó
    const cached = micStreamRef.current;
    if (cached && streamHasLiveTrack(cached.getTracks() as unknown as TrackState[])) {
      acquireDiagRef.current.path = "cached";
      for (const tr of cached.getTracks()) tr.enabled = true;
      lastUnmuteRef.current = await waitForUnmute(cached); // observabilidad (debug readout)
      return cached;
    }
    acquiringMicRef.current = true;
    try {
      const id = micIdRef.current;
      dbg("mic: getUserMedia…");
      let stream: MediaStream;
      // `exact` FUERZA el mic elegido (con deviceId "ideal"/bare el browser lo ignoraba y seguía
      // con el default del SO — ej. el iPhone por Continuity). Si el mic se fue, caemos al default.
      try {
        acquireDiagRef.current.path = "fresh";
        stream = await navigator.mediaDevices.getUserMedia({
          audio: id ? { deviceId: { exact: id } } : true,
        });
      } catch (err) {
        if (!id) throw err;
        acquireDiagRef.current.path = "fresh-default";
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      micStreamRef.current = stream;
      void refreshMics(); // ya con permiso → las labels aparecen
      for (const tr of stream.getTracks()) tr.enabled = true;
      lastUnmuteRef.current = await waitForUnmute(stream); // observabilidad (debug readout)
      return stream;
    } catch (err) {
      // Diagnóstico: capturá el detalle del fallo (name+message) en vez de tragarlo en silencio.
      const e = err as { name?: string; message?: string };
      acquireDiagRef.current.errName = e?.name ?? "Error";
      acquireDiagRef.current.errMsg = (e?.message ?? "").slice(0, 80);
      return null;
    } finally {
      acquiringMicRef.current = false;
    }
  }, [refreshMics]);

  // Warm-up proactivo: al volver al foreground re-adquiere el mic (esperando el unmute) mientras
  // estás idle, para que el próximo tap grabe audio REAL de una en vez de la ilusión de 2s. Sólo si
  // ya hay un track reusable o permiso concedido implícito por el getUserMedia previo — y nunca pisa
  // una adquisición/grabación en curso. Best-effort y silencioso (el stream queda cacheado, no
  // arranca a grabar). Reseteamos los tracks a `enabled=true` para el tap.
  const warmUpMic = useCallback(() => {
    if (statusRef.current !== "idle" || acquiringMicRef.current) return;
    const cached = micStreamRef.current;
    // Sólo warm-up barato: si hay stream cacheado lo revivimos (enabled+unmute). Si NO hay, no
    // forzamos un getUserMedia que podría disparar el prompt fuera de un gesto: el tap lo hará. NO
    // tocamos el timer de inactividad: si calentás y te vas, igual queremos soltar el mic.
    if (!cached || !streamHasLiveTrack(cached.getTracks() as unknown as TrackState[])) return;
    dbg("mic: warm-up");
    void acquireMicStream();
  }, [acquireMicStream]);
  warmUpMicRef.current = warmUpMic;

  const startRecording = useCallback(() => {
    primeAudioPlayback();
    if (statusRef.current !== "idle") return;
    // Latch anti-encolado: si ya hay una intención de grabar en vuelo (tap previo adquiriendo el mic),
    // este tap es NO-OP. Sin esto, como el `status` sigue en "idle" durante la adquisición async, los
    // taps repetidos encolarían varias adquisiciones/turnos. Una sola grabación por ventana.
    if (armingRef.current) return;
    armingRef.current = true;
    // Cancelamos el timer de inactividad: estamos por usar el mic, no hay que soltarlo.
    if (micIdleTimerRef.current) {
      clearTimeout(micIdleTimerRef.current);
      micIdleTimerRef.current = null;
    }
    wantRecRef.current = true;
    // CRÍTICO (fix del InvalidStateError): pedí `play-and-record` SINCRÓNICO, acá, DENTRO del gesto y
    // ANTES de cualquier await (acquireMicStream serializa/espera). Una versión vieja (#640/#643)
    // clavó la sesión en "playback" — categoría INCOMPATIBLE con captura que PERSISTE a nivel SO/PWA
    // (sobrevive reloads) — y desde entonces `getUserMedia` se rechazaba con
    // `InvalidStateError: AudioSession category is not compatible with audio capture.`. Pedir
    // play-and-record acá deshace ese estado clavado. NUNCA seteamos "playback" (es lo que lo clavó);
    // al soltar / antes de reproducir usamos "auto" (compatible con captura futura, rutea al parlante
    // con el mic soltado). Idempotente (memo en audioSession.ts) → no re-dispara A2DP↔HFP en loop.
    setAudioSession("play-and-record");
    // Ilusión de grabar CORTADA: ya NO pintamos "recording" optimista mirando sólo readyState. El
    // track puede estar VIVO pero `muted` (tras background / cambio de ruta) → entra silencio hasta
    // el `unmute`. Marcamos "recording" recién cuando el stream CAPTURA de verdad (vivo +
    // des-muteado), tras el await de acquireMicStream. El tap igual se siente instantáneo cuando el
    // warm-up del foreground ya dejó el track des-muteado (await resuelve sincrónico-ish).
    void (async () => {
      try {
        const stream = await acquireMicStream();
        // Probe 1 (debug): estado del stream/ctx tras adquirir, antes de armar el recorder. Resetea
        // el acumulador de la grabación nueva (pico/chunks/bytes). Solo lectura — no cambia el flujo.
        recDiagRef.current = { lvlPeak: 0, chunks: 0, bytes: 0 };
        // Detalle del acquire (camino + gesto + espera), común a éxito y fallo.
        const aq = acquireDiagRef.current;
        const waited = aq.waitedMs > 0 ? ` waited=${aq.waitedMs}ms` : "";
        const ctxState = audioCtxRef.current?.state ?? "null";
        // Categoría EFECTIVA de la audio-session leída del SO (debug): confirma en el device que ya
        // NO está clavada en "playback" (debería ser `play-and-record` durante la captura).
        const as = `as=${readAudioSessionType() ?? "n/a"}`;
        if (stream) {
          const trk = stream
            .getAudioTracks()
            .map((t) => `rs=${t.readyState} muted=${t.muted} en=${t.enabled}`)
            .join(",");
          audioDiagMicRef.current = `${trk || "no-track"} ${as} path=${aq.path} gesture=${aq.gesture}${waited} ctx=${ctxState} unmute=${lastUnmuteRef.current}`;
        } else {
          // acquire=null → getUserMedia falló: mostramos name (+ message recortado) y el camino/gesto.
          const errMsg = aq.errMsg ? ` "${aq.errMsg}"` : "";
          audioDiagMicRef.current = `acquire=ERR:${aq.errName || "?"}${errMsg} ${as} path=${aq.path} gesture=${aq.gesture}${waited} ctx=${ctxState}`;
        }
        setAudioDiag(`mic: ${audioDiagMicRef.current} | grabando…`);
        // Si soltaste mientras pedías permiso / esperabas el unmute (ej. para tocar "Permitir"), NO
        // arrancamos; volvemos a idle SIN cerrar el stream (lo reusamos en el próximo intento).
        if (!wantRecRef.current || !stream) {
          setStat("idle");
          return;
        }
        // Analyser del mic para los palitos del input. NO se conecta a destination (eco).
        try {
          const ctx = audioCtxRef.current;
          if (ctx) {
            const an = ctx.createAnalyser();
            an.fftSize = 256;
            an.smoothingTimeConstant = 0.6;
            const src = ctx.createMediaStreamSource(stream);
            src.connect(an);
            micSrcRef.current = src;
            micAnalyserRef.current = an;
            micDataRef.current = new Uint8Array(new ArrayBuffer(an.fftSize));
          }
        } catch {
          /* sin nivel de mic → los palitos quedan animados suaves igual */
        }
        // Reuso del MediaRecorder: en iOS/WebKit, crear un MediaRecorder NUEVO sobre un stream
        // que ya se grabó una vez no captura nada (rec.start() corre, onstop dispara enseguida,
        // status vuelve a idle → "anda 1 vez y después no"). El fix es reusar la MISMA instancia:
        // un MediaRecorder inactivo se puede volver a .start(). Sólo creamos uno nuevo la 1ª vez,
        // o si el stream cambió (cambio de mic), o si quedó en un estado raro.
        let rec = recRef.current;
        if (!rec || rec.stream !== stream || rec.state !== "inactive") {
          try {
            if (rec && rec.state !== "inactive") rec.stop();
          } catch {
            /* descartamos el viejo igual */
          }
          rec = new MediaRecorder(stream, { mimeType: "audio/webm" });
          recRef.current = rec;
          dbg("rec: new MediaRecorder");
          rec.ondataavailable = (e) => {
            // Probe 2 (debug): contá los chunks que entrega el recorder + bytes acumulados. Si esto
            // queda en chunks=0/bytes=0 el MediaRecorder no capturó nada (vs. el nivel/pico del mic).
            recDiagRef.current.chunks += 1;
            recDiagRef.current.bytes += e.data.size;
            if (e.data.size) chunksRef.current.push(e.data);
          };
          rec.onstop = async () => {
            // NO paramos los tracks del stream: lo reusamos en la próxima grabación (ver arriba).
            // Sí los GATEAMOS con `enabled=false` (instantáneo, no re-adquiere) → dejan de capturar
            // PCM. NO flipeamos la audio-session a "auto" acá: el mic sigue CALIENTE entre turnos, así
            // que mantenemos `play-and-record` toda la sesión activa. Flipear la categoría POR TURNO
            // (play-and-record↔auto) forzaba HFP↔A2DP en el Bluetooth del auto → la "llamada" ciclaba.
            // Volvemos a "auto" SÓLO cuando el mic se suelta de verdad (releaseMic: idle 60s / background),
            // que es donde importa rutear la salida al parlante/A2DP. Con el track gateado, mantener
            // play-and-record no captura nada indebido y no cicla el ruteo.
            for (const tr of micStreamRef.current?.getTracks() ?? []) tr.enabled = false;
            // Desmontamos el analyser del mic (libera el nodo; getMicLevel vuelve a 0).
            micSrcRef.current?.disconnect();
            micSrcRef.current = null;
            micAnalyserRef.current = null;
            const mime = recRef.current?.mimeType ?? "audio/webm";
            const blob = new Blob(chunksRef.current, { type: mime });
            dbg(`rec.onstop (${blob.size}b)`);
            // Probe 3 (debug): componé la línea final del readout — el pico de nivel del mic + los
            // chunks/bytes vistos + el tamaño del blob + QUÉ RAMA tomó el onstop. Compone sobre el
            // probe 1 (mic/ctx/unmute), que ya quedó en audioDiag al adquirir.
            const d = recDiagRef.current;
            const durMs = Date.now() - recStartRef.current;
            const pushDiag = (branch: string) =>
              setAudioDiag(
                `mic: ${audioDiagMicRef.current} | lvlPeak=${d.lvlPeak.toFixed(2)} chunks=${d.chunks} bytes=${d.bytes} | blob=${blob.size}b dur=${durMs}ms → ${branch}`,
              );
            // Descarte explícito (cancelRecording): el orbe flotante pasó de hold a ARRASTRE, así
            // que esta grabación se aborta sin mandar, dure lo que dure. Además descartamos las
            // vacías o demasiado cortas (tap accidental): un WebM sin cluster finalizado hace
            // fallar a ffmpeg en el STT ("error de FFMP").
            if (discardNextRef.current || !blob.size || Date.now() - recStartRef.current < MIN_REC_MS) {
              pushDiag(
                discardNextRef.current
                  ? "DESCARTADA(cancel)"
                  : !blob.size
                    ? "DESCARTADA(vacía)"
                    : "DESCARTADA(corta)",
              );
              discardNextRef.current = false;
              setStat("idle");
              return;
            }
            // Piso CLIENT-SIDE: el blob duró lo suficiente (pasó MIN_REC_MS) pero pesa casi nada
            // → el MediaRecorder reusado no capturó audio y emitió sólo el header WebM (~5 bytes).
            // El server lo rechazaría en el STT (ffmpeg "Invalid data found") y el turno moriría;
            // lo cortamos acá con feedback inmediato en vez de mandar un audio que no se va a oír.
            if (blob.size < MIN_AUDIO_BLOB_BYTES) {
              dbg(`audio sin contenido (${blob.size}b < ${MIN_AUDIO_BLOB_BYTES}) → ni se sube`);
              pushDiag("DESCARTADA(no-te-escuché)");
              setCaption("No te escuché. Probá grabar de nuevo.");
              setStat("idle");
              return;
            }
            // Guard CLIENT-SIDE de tamaño: feedback INMEDIATO sin subir MB que el server va
            // a rechazar igual (la fuente de verdad es el server: nginx 26m + MAX_SEND_BYTES).
            // El fallo se modela como el 413 que hubiera devuelto → mismo mensaje, no
            // reintentable (el audio nunca va a entrar; hay que grabar uno más corto).
            if (blob.size > MAX_AUDIO_BLOB_BYTES) {
              dbg(`audio demasiado grande (${blob.size}b > ${MAX_AUDIO_BLOB_BYTES}) → ni se sube`);
              pushDiag("DESCARTADA(muy-grande)");
              const tooBigId = pushUserMsg("voice", "Nota de voz");
              failSend(
                tooBigId,
                { ok: false, reason: "http", status: 413 },
                { body: {}, kind: "audio", placeholder: true },
              );
              return;
            }
            pushDiag("ENVIADA→thinking");
            setStat("thinking");
            voiceTurnRef.current = true; // turno iniciado por NOTA DE VOZ → la respuesta de voz autoplaya
            // Envío resiliente (Fase B.2): el audio NO tiene burbuja local hasta que el server
            // ecoa `heard` (la transcripción) — si el POST falla definitivo, creamos un
            // placeholder "Nota de voz" marcado `failed`, con el audio retenido para
            // reintentar. Antes este fallo (típico: el 413 de un audio largo) moría en
            // silencio con el orbe clavado en "pensando".
            const body = {
              t: "audio",
              mime,
              data: await blobToBase64(blob),
              openDoc: openRef.current ?? undefined,
            };
            const res = await postSend(body, "audio");
            if (!res.ok) {
              const phId = pushUserMsg("voice", "Nota de voz");
              failSend(phId, res, { body, kind: "audio", placeholder: true });
            }
          };
        } else {
          dbg("rec: reuse MediaRecorder");
        }
        chunksRef.current = [];
        discardNextRef.current = false; // grabación nueva: limpiamos un descarte pendiente viejo
        mutedTurnRef.current = false; // turno NUEVO → limpiá un mute viejo (la respuesta de voz suena)
        recStartRef.current = Date.now();
        rec.start();
        dbg("rec.start");
        // NO tocamos `navigator.audioSession`: el track vivo ya tiene al SO en play-and-record (vía
        // `auto`). Llegamos acá DESPUÉS del await del unmute → el track captura de verdad: marcar
        // "recording" ahora NO es la ilusión (entra audio real). NO limpiamos el diálogo viejo acá
        // (al apretar): hacerlo dejaba `dialogLen` en 0 de golpe → el orbe saltaba a `--orb-scale:1`
        // y crecía bajo el dedo. El diálogo se limpia al SOLTAR (stopRecording), no al empezar.
        setStat("recording");
      } catch {
        setCaption("No pude acceder al micrófono. Dale permiso y reintentá.");
        setStat("idle");
      } finally {
        // Cierra la ventana del latch anti-encolado: ya sea que arrancó la grabación, se abortó
        // (soltaste durante el prompt) o falló la adquisición, la intención dejó de estar "en vuelo".
        armingRef.current = false;
      }
    })();
  }, [setStat, acquireMicStream, primeAudioPlayback, pushUserMsg, failSend]);

  const stopRecording = useCallback(() => {
    wantRecRef.current = false; // soltaste: si la grabación todavía no arrancó (prompt), se aborta
    // Frenamos según el estado REAL del recorder, no el status: si algún callback async dejó el
    // status desincronizado (idle) mientras el recorder seguía grabando, igual lo paramos —
    // onstop hace el resto (descarta corto/vacío, o postea). Defensa contra grabaciones huérfanas.
    if (recRef.current?.state === "recording") {
      recRef.current.stop();
      // Recién al SOLTAR limpiamos la última pregunta + respuesta (antes se hacía al empezar a
      // grabar, pero eso achicaba el diálogo de golpe y el orbe crecía bajo el dedo). Al soltar,
      // el dedo ya no está sobre el orbe, así que crecer a pizarra limpia no molesta.
      setUserEcho(null);
      setCaption("");
    }
  }, []);

  // Aborta la grabación en curso DESCARTÁNDOLA (no manda STT ni dispara un turno). La usa el orbe
  // flotante cuando, estando grabando, el dedo pasa a ARRASTRAR: el audio capturado hasta ahí se
  // tira. Diferencia con stopRecording: este nunca postea, marque lo que marque la duración. Si
  // todavía no había arrancado la grabación (prompt de permiso), igual cortamos el `wantRec` para
  // que no quede una grabación huérfana arrancando después del arrastre.
  const cancelRecording = useCallback(() => {
    wantRecRef.current = false;
    if (recRef.current?.state === "recording") {
      discardNextRef.current = true; // onstop ve este flag y descarta sin postear
      recRef.current.stop();
      setUserEcho(null);
      setCaption("");
    } else {
      // No había recorder activo (la grabación no llegó a arrancar): nada que descartar luego.
      // Gateamos el track (enabled=false). NO flipeamos la audio-session a "auto": el mic sigue
      // caliente y mantenemos `play-and-record` (no flipear por turno → no cicla el Bluetooth). Vuelve
      // a "auto" sólo al soltar de verdad (releaseMic: idle/background).
      discardNextRef.current = false;
      for (const tr of micStreamRef.current?.getTracks() ?? []) tr.enabled = false;
      if (statusRef.current === "recording") setStat("idle");
    }
  }, [setStat]);

  // Text input (Fase 17): atajo de teclado al hold-para-hablar. El agente recibe el
  // texto (sin tag de voz entrante) y por mirror responde con [[text]]; eventualmente
  // puede decidir voz si la respuesta amerita. Sólo se acepta si estamos idle o speaking
  // (para mandar otro mensaje mientras todavía suena el anterior); en thinking/recording
  // ignoramos para evitar pisar el turno en vuelo.
  const sendText = useCallback(
    (text: string, media?: OutboundMedia[]) => {
      const t = text.trim();
      const atts = media ?? [];
      // Nada que mandar (ni texto ni adjuntos) → no hacemos turno.
      if (!t && atts.length === 0) return;
      const s = statusRef.current;
      // Sólo bloqueamos cuando no se puede mandar: desconectado o grabando. Mientras el
      // agente responde (thinking/speaking) SÍ se puede: mandar INTERRUMPE el turno actual.
      if (s === "connecting" || s === "unauth" || s === "recording") return;
      ensureAudioCtx(); // gesto → habilita el AudioContext para la voz reactiva de la respuesta
      if (s === "thinking" || s === "speaking") {
        // Interrumpir: cortar el audio que suena + vaciar la cola + avisar al server (/stop).
        const a = audioRef.current;
        if (a) {
          a.pause();
          a.src = "";
          audioRef.current = null;
        }
        voiceQueueRef.current = [];
        speakingRef.current = false;
        setVoicePlayback(null); // se interrumpió la voz → la burbuja vuelve al <audio controls>
        void postSend({ t: "text", text: "/stop", openDoc: openRef.current ?? undefined });
      }
      // Adjuntos → chips/miniaturas en la burbuja del usuario (data-URL sólo en sesión).
      const attachments: ChatAttachment[] = atts.map((m) => ({
        kind: m.mime === "application/pdf" ? "document" : "image",
        mime: m.mime,
        name: m.name,
        url: `data:${m.mime};base64,${m.data}`,
      }));
      // Eco local: lo que escribí es la nueva "pregunta". Limpio la respuesta vieja para
      // mostrar sólo última Q + última A. (Para voz, el eco lo manda el server como `heard`.)
      setUserEcho({
        mode: "text",
        text: t || (atts.length === 1 ? "📎 1 adjunto" : `📎 ${atts.length} adjuntos`),
      });
      setCaption("");
      const userMsgId = pushUserMsg("text", t, attachments); // turno del usuario en el historial del chat
      setStat("thinking");
      voiceTurnRef.current = false; // turno iniciado por TEXTO → con el chat abierto, sin autoplay
      mutedTurnRef.current = false; // turno NUEVO → limpiá un mute viejo (este turno suena normal)
      // Envío resiliente (Fase B.2): si el POST agota timeout + reintentos, la burbuja se
      // marca "no se pudo enviar" con el texto intacto y reintentable — nunca silencio.
      const body = {
        t: "text",
        text: t,
        ...(atts.length ? { media: atts } : {}),
        openDoc: openRef.current ?? undefined,
      };
      void postSend(body, "text").then((res) => {
        if (!res.ok) failSend(userMsgId, res, { body, kind: "text", placeholder: false });
      });
    },
    [setStat, ensureAudioCtx, pushUserMsg, failSend],
  );

  // Corta el audio que esté sonando + vacía la cola de voz. Helper compartido por cancelTurn y
  // muteAudio (la parte de "callar la voz ya"); ninguna de las dos manda /stop por su cuenta.
  const silenceVoice = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.src = "";
      audioRef.current = null;
    }
    voiceQueueRef.current = [];
    speakingRef.current = false;
    setVoicePlayback(null); // se cortó la voz → la burbuja vuelve al <audio controls>
  }, []);

  // Tap en el orbe mientras PIENSA: CANCELA el turno. Aborta la generación en el server (/stop) y
  // vuelve a idle. No hay audio (todavía no habla); igual silenciamos por defensa, por si un clip
  // entró justo. NO arranca a grabar (eso lo decide App.tsx: tras cancelar, return).
  const cancelTurn = useCallback(() => {
    if (statusRef.current !== "thinking" && statusRef.current !== "speaking") return;
    // El server cancela el turno —incluso ENCOLADO (STT/prep)— al recibir `/stop` (ver engine.ts:
    // cancelRequested), así que la respuesta no debería despacharse. Defensa del cliente: prendemos
    // `mutedTurnRef` para que, si un clip de voz se colara (el /stop entró con el turno ya corriendo),
    // NO autoplaye por encima (lo calla `shouldAutoplayVoice` vía `muted`). El texto residual, si lo
    // hubiera, sí se appendea a su burbuja. Se resetea al arrancar el próximo turno.
    mutedTurnRef.current = true;
    silenceVoice();
    void postSend({ t: "text", text: "/stop", openDoc: openRef.current ?? undefined }); // interrumpe el turno
    setStat("idle");
  }, [setStat, silenceVoice]);

  // Tap en el orbe mientras HABLA: MUTEA el audio. Corta la voz en curso y marca el turno como
  // muteado para que los clips que sigan llegando por SSE NO suenen (el TEXTO sí se appendea a la
  // burbuja). NO manda /stop: el turno NO se cancela, solo se calla. Vuelve a idle. El flag se
  // resetea al arrancar el próximo turno (mandar texto / grabar) → el siguiente turno suena normal.
  const muteAudio = useCallback(() => {
    if (statusRef.current !== "speaking") return;
    mutedTurnRef.current = true;
    silenceVoice();
    setStat("idle");
  }, [setStat, silenceVoice]);

  // Cerrar "la nota abierta" = cerrar la pestaña activa (salta a vecina o vuelve al orbe).
  const closeDoc = useCallback(() => {
    const id = activeTabIdRef.current;
    if (id) closeTab(id);
    else {
      openRef.current = null;
      setDoc(null);
    }
  }, [closeTab]);

  // Ir a "home": desactiva la pestaña activa y vuelve al orbe principal, PERO las tabs
  // siguen vivas. Es el modo opuesto a closeTab: no cierra ninguna pestaña, solo deja de
  // mostrar la nota activa. Desde home se puede volver a cualquier pestaña con un click.
  const goHome = useCallback(() => {
    if (activeTabIdRef.current === null) return; // ya estamos en home
    activeTabIdRef.current = null;
    setActiveTabId(null);
    openRef.current = null;
    setDoc(null);
  }, []);

  /** Renombra el archivo abierto. `fullContent` (opcional) es el contenido COMPLETO vivo del
   *  editor (con el H1 oculto): si viene, el move reescribe el H1 al título nuevo y lo escribe en el
   *  destino en el MISMO commit que el cambio de path. Sin él, el move copia el contenido vigente
   *  tal cual (rename "puro", ej. desde el explorer no pasa por acá). */
  const renameDoc = useCallback(
    async (newName: string, fullContent?: string) => {
      const cur = openRef.current;
      const curSha = docShaRef.current;
      if (!cur || !curSha) throw new Error("no hay archivo abierto");
      // El newName es el título crudo que tipeó el usuario (sin .md). El FILENAME va saneado
      // (sin caracteres que rompen filesystems); el H1 conserva el crudo (mayúsculas/tildes/espacios),
      // igual que el rename del explorer (doRename). Conservamos el directorio del path actual.
      const titleRaw = newName.replace(/\.md$/i, "").trim();
      const base = sanitizeFilename(titleRaw);
      if (!base) throw new Error("nombre vacío");
      const slash = cur.path.lastIndexOf("/");
      const dir = slash >= 0 ? cur.path.slice(0, slash + 1) : "";
      const filename = `${base}.md`;
      const toPath = `${dir}${filename}`;
      if (toPath === cur.path) return; // sin cambio
      // Contenido a escribir en el destino. Si el editor nos pasó su contenido vivo, reescribimos el
      // H1 al título nuevo y lo mandamos como `newContent` → el move corrige el H1 ATÓMICAMENTE en el
      // mismo commit del cambio de path. Así el editor NO hace un re-save tardío del H1: ese re-save
      // (que corría FUERA de la ventana del guard, contra el path VIEJO) recreaba el archivo viejo y
      // duplicaba el H1 si el usuario cambiaba de solapa mid-op (caso 6 / QA 2026-06-11).
      const newContent = fullContent !== undefined ? replaceOrInsertH1(fullContent, titleRaw) : undefined;
      const seedContent = newContent ?? docContentRef.current ?? "";
      // Registramos la op en vuelo: mientras el move corre, el editor NO debe persistir cur.path
      // (su flush/autosave cambiaría el blob que el server está leyendo → 409). Se libera en finally.
      const opId = crypto.randomUUID();
      beginFsOp({ id: opId, repo: cur.repo, fromPath: cur.path, toPath, isFolder: false });
      let r: Response;
      try {
        // El commit va por la cola serial del repo: no se solapa con otra mutación del mismo repo
        // (evita el 422 non-fast-forward → 409 espurio). Repos distintos no se bloquean.
        r = await runFsOp(cur.repo, () =>
          fetch("/api/file/move", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              repo: cur.repo,
              fromPath: cur.path,
              toPath,
              baseSha: curSha,
              ...(newContent !== undefined ? { newContent } : {}),
            }),
          }),
        );
      } catch (e) {
        endFsOp(opId);
        throw e;
      }
      if (!r.ok) {
        endFsOp(opId);
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `move ${r.status}`);
      }
      const j = (await r.json()) as { sha?: string };
      if (!j.sha) throw new Error("respuesta sin sha");
      markSelfSha(j.sha); // el move es escritura nuestra → el {refresh} del feed no remonta
      // Cache local: la nota se movió de path → sacá la entrada vieja y sembrá la nueva con el
      // contenido YA con el H1 corregido (seedContent) y el sha nuevo.
      evictNote(handleRef.current, cur.repo, cur.path);
      writeNote(handleRef.current, cur.repo, toPath, seedContent, j.sha);
      // Remap por IDENTIDAD (no "la pestaña activa AHORA"): el rename pasó por un await, durante el
      // cual el usuario pudo cambiar de pestaña. Seguimos a la nota cur.path → toPath en TODAS las
      // pestañas e historiales (igual que remapTabs/doRename del explorer). Antes esto reescribía a
      // ciegas la entrada del cursor de la pestaña activa: si cambiabas de solapa mid-op, le pegaba a
      // la pestaña EQUIVOCADA → la nota a la que saltaste "ocupaba el lugar" de la renombrada (caso 6).
      const nextTabs = remapTabsEntries(tabsRef.current, cur.repo, cur.path, toPath, false);
      if (nextTabs !== tabsRef.current) {
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
      }
      // El `doc`/openRef visibles SÓLO se reapuntan si la nota renombrada SIGUE siendo la activa.
      // Si el usuario cambió de pestaña durante el await, este patch pertenece a OTRA nota:
      // aplicarlo movería openRef y el doc visible al path nuevo sobre la nota activa equivocada.
      // El guard por identidad (mismo patrón que patchDoc) lo evita; la pestaña de fondo ya quedó
      // remapeada arriba, así que al volver a ella el path nuevo está correcto. Además del path/sha
      // patcheamos el `content` al H1 corregido: el editor sigue montado (mismo doc.id) y su prefijo
      // ya quedó en sync localmente (commitTitle), pero un refetch/remap futuro parte del contenido bueno.
      if (isSameNote(openRef.current, { repo: cur.repo, path: cur.path })) {
        openRef.current = { repo: cur.repo, path: toPath };
        setDoc((prev) =>
          prev && isSameNote(prev, { repo: cur.repo, path: cur.path })
            ? {
                ...prev,
                path: toPath,
                title: filename,
                sha: j.sha,
                ...(newContent !== undefined ? { content: newContent } : {}),
              }
            : prev,
        );
      }
      // Op terminada: el move ya commiteó CON el H1 corregido. El editor no hace re-save del H1 → no
      // hay write tardío contra el path viejo que pueda recrearlo ni duplicar el H1.
      endFsOp(opId);
      return j.sha; // el editor lo adopta como baseSha (sin 409 en el próximo autosave del cuerpo)
    },
    [markSelfSha, beginFsOp, endFsOp, runFsOp],
  );

  // El editor guardó: actualizamos el doc en memoria (siguiente refetch usa el sha
  // correcto). El título YA NO sale del H1 del contenido (#10): el título es el nombre
  // del archivo y se edita aparte (renameDoc desde el editor).
  const patchDoc = useCallback(
    (content: string, sha: string, repo: string, path: string) => {
      markSelfSha(sha); // escritura nuestra → el {refresh} del feed no tiene nada que refrescar
      // El cache es keyed por (repo,path): SIEMPRE correcto sembrar la nota que se guardó —
      // aunque el usuario ya haya cambiado de pestaña, ese sha es el baseSha real de ESA nota.
      writeNote(handleRef.current, repo, path, content, sha);
      // ⚠️ El `doc` visible y `openRef` SÓLO se parchean si la nota que guardó SIGUE siendo la
      // activa. Si el usuario cambió de pestaña mientras el PUT estaba en vuelo, este eco
      // pertenece a OTRA nota: aplicarlo escribiría su contenido/sha sobre la nota activa
      // (la activa mostraría texto ajeno y su próximo autosave partiría de un sha equivocado →
      // corrupción). El guard por identidad lo evita.
      if (!isSameNote(openRef.current, { repo, path })) return;
      setDoc((prev) => (prev && isSameNote(prev, { repo, path }) ? { ...prev, content, sha } : prev));
    },
    [markSelfSha],
  );

  // Persistencia de las pestañas abiertas (`ceibo_doc:<handle>`): guardamos el archivo actual
  // de cada pestaña + el índice de la activa, así el F5 las restaura. Sin pestañas → borramos
  // (el restore caería en la pantalla del orbe). El historial back/forward NO se persiste (es
  // efímero por sesión); al recargar cada pestaña arranca con un solo entry.
  // CLAVE: no escribir NI borrar hasta que boot() terminó (`booting` false). El handle se
  // hidrata SÍNCRONO del cache al primer render, así que este efecto corría en el mount con
  // `tabs` vacío y BORRABA la key guardada ANTES de que boot() la leyera → las pestañas no
  // sobrevivían el refresh. Gateando con `booting` el restore lee la key intacta.
  //
  // `active === -1` → "home mode": tabs vivas pero ninguna activa (el usuario minimizó las notas).
  // Se restaura en boot() + restoreTabs() soportando ese -1 directamente.
  useEffect(() => {
    if (!handle || booting) return;
    const key = `${DOC_KEY_PREFIX}${handle}`;
    if (tabs.length === 0) {
      localStorage.removeItem(key);
      return;
    }
    const slim = {
      tabs: tabs
        .map((t) => {
          const e = t.entries[t.cursor];
          if (!e) return null;
          // Persistir con discriminante: system tabs guardan {kind:"system",page}; notas {repo,path}.
          if (e.kind === "system") return { kind: "system" as const, page: e.page };
          return { repo: e.repo, path: e.path };
        })
        .filter(
          (e): e is { kind: "system"; page: SystemPage } | { repo: string; path: string } => e !== null,
        ),
      // -1 = home mode (tabs vivas, ninguna activa). Si hay activa, su índice en el array.
      active: activeTabId === null ? -1 : tabs.findIndex((t) => t.id === activeTabId),
    };
    if (slim.tabs.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(slim));
  }, [handle, booting, tabs, activeTabId]);

  // Persistencia del historial del chat (`ceibo_chat:<handle>`): espeja `messages` para que
  // el reload no vacíe la conversación. Solo escribimos cuando `handle` ya está confirmado
  // PARA este historial (hydratedHandleRef) — así un user nuevo no pisa el chat del anterior.
  // Guardamos solo rol/modo/texto (el audio y el "pensando" son efímeros; ver loadChat) y
  // capamos a los últimos CHAT_MAX_MSGS turnos para no inflar localStorage.
  useEffect(() => {
    if (!handle || handle !== hydratedHandleRef.current) return;
    const key = `${CHAT_KEY_PREFIX}${handle}`;
    const startedKey = `${CHAT_STARTED_PREFIX}${handle}`;
    try {
      const slim = messages
        // descartá la burbuja de "pensando" en vuelo (aún sin texto), pero conservá los
        // turnos que son sólo adjuntos (texto vacío + attachments).
        .filter((m) => m.text || m.attachments?.length)
        .slice(-CHAT_MAX_MSGS)
        .map((m) => ({
          id: m.id,
          role: m.role,
          mode: m.mode,
          text: m.text,
          // Sólo metadata liviana (sin el data-URL base64): un chip tras el reload.
          ...(m.attachments?.length
            ? { attachments: m.attachments.map((a) => ({ kind: a.kind, mime: a.mime, name: a.name })) }
            : {}),
        }));
      if (slim.length === 0) {
        // Chat vacío → la próxima conversación es una sesión nueva: olvidamos el inicio y el
        // título (el del tema viejo no aplica al chat nuevo). El efecto de chatTitle borra su key.
        localStorage.removeItem(key);
        localStorage.removeItem(startedKey);
        setChatStartedAt((prev) => (prev === undefined ? prev : undefined));
        setChatTitle((prev) => (prev === undefined ? prev : undefined));
      } else {
        localStorage.setItem(key, JSON.stringify(slim));
        // Sellamos el inicio del caché con el PRIMER mensaje y lo dejamos fijo (no se pisa en
        // cada turno). Persiste hasta que el chat se vacía.
        if (readChatStarted(handle) === undefined) {
          const now = Date.now();
          localStorage.setItem(startedKey, String(now));
          setChatStartedAt(now);
        }
      }
    } catch {
      /* localStorage lleno / no disponible → seguimos sin persistir */
    }
  }, [handle, messages]);

  // Persistencia del título del chat (separada del historial: cambia en otra cadencia). Espeja
  // `chatTitle` a `ceibo_chat_title:<handle>` para sobrevivir un reload; lo borra cuando se va a
  // undefined (chat vaciado). Sólo para el handle con el que hidratamos (no pisa el de otro user).
  useEffect(() => {
    if (!handle || handle !== hydratedHandleRef.current) return;
    const titleKey = `${CHAT_TITLE_PREFIX}${handle}`;
    try {
      if (chatTitle) localStorage.setItem(titleKey, chatTitle);
      else localStorage.removeItem(titleKey);
    } catch {
      /* localStorage no disponible → seguimos sin persistir */
    }
  }, [handle, chatTitle]);

  // --- Settings de voz desde el panel de config (Fase 10/16) -----------------
  // El front no tiene endpoint setter propio: cambia mandando los mismos slash-commands
  // que el bot (/voice, /language) por POST /api/send. Actualizamos el estado local de una
  // (optimista) para que el <select> responda al toque.
  const refetchVoice = useCallback(async () => {
    try {
      const r = await fetch("/api/me");
      if (!r.ok) return;
      const j = (await r.json()) as { voice?: VoiceCfg };
      if (j.voice) setVoiceState(j.voice);
    } catch {
      /* ignore */
    }
  }, []);
  // Perfil (alias + avatar): tras guardar el alias o cambiar la foto, re-leemos /api/me para
  // reflejar el name nuevo + hasAvatar, y bumpeamos avatarVersion para bustear el <img>.
  const refreshProfile = useCallback(async () => {
    try {
      const r = await fetch("/api/me");
      if (!r.ok) return;
      const j = (await r.json()) as {
        name?: string;
        location?: string | null;
        handle?: string;
        hasAvatar?: boolean;
      };
      setName(j.name ?? j.handle);
      setUserLocation(j.location ?? undefined);
      setHasAvatar(!!j.hasAvatar);
      setAvatarVersion((v) => v + 1);
    } catch {
      /* ignore */
    }
  }, []);
  const setVoice = useCallback((nick: string) => {
    void postSend({ t: "text", text: `/voice ${nick}` });
    setVoiceState((v) => (v ? { ...v, current: nick } : v));
  }, []);
  const setVoiceLang = useCallback(
    (id: string) => {
      void postSend({ t: "text", text: `/language ${id}` });
      setVoiceState((v) => (v ? { ...v, lang: id } : v));
      // /language resetea la voz a la default del idioma nuevo y cambia la lista de voces →
      // reconciliamos con el server tras un toque.
      window.setTimeout(() => void refetchVoice(), 600);
    },
    [refetchVoice],
  );
  const setRate = useCallback((rate: string) => {
    void postSend({ t: "text", text: rate ? `/voice rate ${rate}` : "/voice rate off" });
    setVoiceState((v) => (v ? { ...v, rate } : v));
  }, []);
  // Modelo: mismo patrón que voz. /model recrea la sesión (reinicia el contexto) en el gateway.
  const setModel = useCallback((id: string) => {
    void postSend({ t: "text", text: `/model ${id}` });
    setModelState((m) => (m ? { ...m, current: id } : m));
  }, []);
  // Prompts del fondo: van por POST /api/me (misma vía que el alias), no por slash-command.
  // Lista vacía = limpiar la preferencia → el server responde con el default de la app y
  // repoblamos el estado con eso (el campo nunca queda vacío). Devuelve éxito para que el
  // panel muestre el error si falló.
  const saveBgQueries = useCallback(async (queries: string[]): Promise<boolean> => {
    try {
      const r = await fetch("/api/me", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bgQueries: queries }),
      });
      if (!r.ok) return false;
      const j = (await r.json()) as { bgQueries?: string[] };
      if (j.bgQueries) setBgQueriesState(j.bgQueries);
      return true;
    } catch {
      return false;
    }
  }, []);

  // Vista plana de las pestañas para la tira de tabs + flags de navegación de la activa.
  const tabInfos: TabInfo[] = tabs.map((t) => {
    const e = t.entries[t.cursor];
    if (e?.kind === "system") {
      return { kind: "system", id: t.id, title: e.title, page: e.page };
    }
    // note (con kind explícito o sin él, back-compat)
    return { kind: "note", id: t.id, title: e?.title ?? "nota", repo: e?.repo ?? "", path: e?.path ?? "" };
  });
  const activeTabRaw = tabs.find((t) => t.id === activeTabId) ?? null;
  // Vista plana de la tab activa (expuesta como `ch.activeTab` para App y el deep-link).
  const activeTab: TabInfo | null = activeTabRaw
    ? (() => {
        const e = activeTabRaw.entries[activeTabRaw.cursor];
        if (e?.kind === "system") {
          return { kind: "system" as const, id: activeTabRaw.id, title: e.title, page: e.page };
        }
        return {
          kind: "note" as const,
          id: activeTabRaw.id,
          title: e?.title ?? "nota",
          repo: e?.repo ?? "",
          path: e?.path ?? "",
        };
      })()
    : null;
  const canBack = !!activeTabRaw && activeTabRaw.cursor > 0;
  const canForward = !!activeTabRaw && activeTabRaw.cursor < activeTabRaw.entries.length - 1;

  return {
    status,
    booting,
    caption,
    activity,
    activityLog,
    audioDiag,
    subAgent,
    subagentCount,
    userEcho,
    messages,
    chatStartedAt,
    chatTitle,
    inboxItems,
    inboxUnread,
    refreshInbox,
    openInboxItem,
    markAllInboxReadLocal,
    name,
    location: userLocation,
    handle,
    email,
    hasPassword,
    hasAvatar,
    avatarVersion,
    refreshProfile,
    defaultWiki,
    doc,
    tabs: tabInfos,
    activeTabId,
    canBack,
    canForward,
    selectTab,
    closeTab,
    reorderTab,
    closeByPath,
    remapTabs,
    remapTabsCross,
    beginFsOp,
    endFsOp,
    noteHasInflightFsOp,
    runFsOp,
    navBack,
    navForward,
    treeSeq,
    open,
    openSystem,
    activeTab,
    patchDoc,
    closeDoc,
    goHome,
    renameDoc,
    startRecording,
    stopRecording,
    cancelRecording,
    primeAudioPlayback,
    setVoiceAutoplay,
    voicePlayback,
    toggleVoicePlayback,
    seekVoicePlayback,
    sendText,
    resend,
    cancelTurn,
    muteAudio,
    mics,
    micsAuthorized,
    micId,
    setMic,
    voice,
    setVoice,
    setVoiceLang,
    setRate,
    model,
    setModel,
    bgQueries,
    saveBgQueries,
    getAudioLevel,
    getMicLevel,
    sseState,
    lastEventAgo,
  };
}
