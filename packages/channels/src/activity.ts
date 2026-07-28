// Humanización del label de actividad (modo debug). El relay de `@ceibo/agent` emite, por
// cada tool-call / sub-agente del turno, el nombre técnico de la tool (ej. `schedule_create`,
// `mcp__wiki__write`) o un marcador de sub-agente (`sub-agente: worker-high`), MÁS el `input`
// crudo de la tool (los args con que corre). `activityLabel(name, input)` lo traduce a DOS
// partes separadas: un `label` corto y amable (un verbo amigable SIN params ni jerga, ej.
// `actualizando tu wiki`, `editando una nota`) y un `detail` opcional con el resumen CONCISO
// del/los param(s) más útil(es) (ej. `git status`, `viajes/japón`). Es PURA (sin deps).
//
// El label NUNCA debe filtrar comandos/paths/jerga (alimenta el hint always-on del orb). Para
// `bash` no hay un label fijo: bashLabel() reconoce patrones del comando (wiki-sync pull/push,
// git, …) y devuelve algo amable y específico; el comando crudo va sólo al `detail` (debug).
//
// Por qué DOS partes (no un solo string "label: detail"): el `label` amable alimenta el hint
// always-on bajo el orb de la web (visible SIEMPRE, también con debug off) → ahí NO queremos el
// comando crudo. El `detail` sólo se muestra en las superficies de DEBUG (Telegram con
// `/debug on`; el log de debug de la web con el toggle) → ahí sí se ve `label: detail`. Las
// consume el gateway (al emitir el frame `activity` y al renderizar en Telegram) y, si quiere,
// el web-server. La web (SPA) NO necesita importarla: el frame `activity` ya viaja con `label` y
// `detail` separados.
//
// Para tools desconocidas el fallback usa un genérico amable ("trabajando") como `label` — NUNCA
// muestra el nombre técnico ni jerga en el hint always-on. El nombre técnico limpiado
// (sin prefijo `mcp__server__`, con `_`/`-` → espacios) va al PRINCIPIO del `detail`
// (solo-debug), seguido del resumen de args si los hay. El detalle es un hint de chat de la
// PROPIA sesión del usuario; igual se omiten campos con pinta de secreto.

// Mapa nombre-de-tool → texto amigable (es). Claves = nombre BARE de la tool (ya sin el
// prefijo `mcp__server__`). Mantener corto: es un hint de progreso, no una oración.
const LABELS: Record<string, string> = {
  // Built-in MA / coding. `bash` NO está acá: su label sale de bashLabel() según el comando
  // (reconoce wiki-sync/git/etc.). Los file-ops usan wording de "nota" porque, en este
  // producto, los archivos que el agente toca SON las notas/wiki del usuario.
  edit: "editando una nota",
  str_replace: "editando una nota",
  create: "creando una nota",
  view: "leyendo una nota",
  // agent_toolset_20260401: glob/grep navegan la wiki del usuario (los archivos son sus notas).
  glob: "buscando archivos en tu wiki",
  grep: "buscando en tus notas",
  ls: "explorando tu wiki",
  find: "buscando en tu wiki",
  // Web (built-in MA tools)
  web_search: "buscando en la web",
  websearch: "buscando en la web",
  web_fetch: "leyendo una página web",
  fetch: "leyendo una página web",
  // Wiki / notas (substrato de sync)
  write: "actualizando una nota",
  read: "leyendo la wiki",
  read_file: "leyendo una nota",
  search: "buscando en la wiki",
  // Recordatorios / agenda
  schedule_create: "agendando un recordatorio",
  schedule_cancel: "cancelando un recordatorio",
  schedule_list: "mirando tu agenda",
  schedule: "gestionando la agenda",
  // Comandos de ceibo (el agente corre /connect, /model, …)
  ceibo_command: "ejecutando un comando",
  control: "ejecutando un comando",
  // Gmail
  gmail: "revisando el mail",
  read_message: "leyendo un mail",
  search_messages: "buscando en el mail",
  create_draft: "redactando un mail",
  read_attachment: "abriendo un adjunto",
  // Calendar
  calendar: "mirando el calendario",
  list_events: "mirando el calendario",
  get_event: "mirando un evento",
  create_event: "agendando un evento",
  // Drive / docs / sheets
  drive: "buscando en Drive",
  search_files: "buscando archivos",
  doc: "leyendo un documento",
  sheets: "mirando una planilla",
  read_range: "leyendo una planilla",
  append_values: "escribiendo en una planilla",
  list_tabs: "mirando una planilla",
  // Notion
  notion: "buscando en Notion",
  get_page: "leyendo una página",
  create_page: "creando una página",
  // WhatsApp del usuario
  wacli: "revisando WhatsApp",
  wa_list_chats: "mirando tus chats",
  wa_list_messages: "leyendo mensajes",
  wa_search_messages: "buscando en WhatsApp",
  wa_search_contacts: "buscando un contacto",
  wa_get_media: "abriendo un adjunto",
  wa_transcribe_audio: "transcribiendo un audio",
  // Web / captura
  shot: "sacando una captura",
  // Búsqueda web (Tavily). Nombre amable: "web search" en vez de "tavily search" (jerga del
  // proveedor). El nombre bare ya viene des-duplicado (`tavily_tavily_search`→`tavily_search`).
  tavily_search: "web search",
};

// Para las tools comunes, qué param(s) del input son los más útiles para mostrar — en orden de
// preferencia (se usa el primero presente y no vacío). Para el resto cae al barrido genérico.
const DETAIL_KEYS: Record<string, string[]> = {
  bash: ["command"],
  // file / nota ops
  write: ["file_path", "path", "title", "note"],
  read: ["file_path", "path", "query"],
  read_file: ["file_path", "path"],
  edit: ["file_path", "path"],
  str_replace: ["file_path", "path"],
  create: ["file_path", "path"],
  view: ["file_path", "path"],
  // file-nav built-in MA
  glob: ["pattern", "path", "cwd"],
  grep: ["pattern", "query", "path"],
  ls: ["path"],
  find: ["pattern", "path", "query"],
  // web
  web_search: ["query", "q"],
  websearch: ["query", "q"],
  web_fetch: ["url"],
  fetch: ["url"],
  // búsquedas
  search: ["query", "q", "pattern"],
  search_messages: ["query", "q"],
  search_files: ["query", "q", "name"],
  search_contacts: ["query", "q"],
  wa_search_messages: ["query", "q"],
  wa_search_contacts: ["query", "q"],
  // agenda
  schedule_create: ["title", "what"],
  schedule_cancel: ["id"],
  // mail
  read_message: ["message_id", "id"],
  create_draft: ["subject", "to"],
  // calendar
  create_event: ["summary", "title"],
  get_event: ["event_id", "id"],
  // notion
  get_page: ["title", "page_id", "url", "id"],
  create_page: ["title"],
  // comandos
  ceibo_command: ["command", "cmd"],
  control: ["command", "cmd"],
};

// Orden de preferencia genérico para tools sin entrada en DETAIL_KEYS.
const GENERIC_KEYS = [
  "command",
  "cmd",
  "file_path",
  "filepath",
  "path",
  "query",
  "q",
  "search",
  "what",
  "title",
  "summary",
  "subject",
  "name",
  "note",
  "url",
  "prompt",
  "text",
  "message",
  "pattern",
  "id",
];

/** Largo máximo de la porción de detalle (el resumen de params). */
const MAX_DETAIL = 70;

/** Campos que NO mostramos aunque aparezcan (pinta de secreto). */
const SECRET_RE = /secret|token|password|passwd|api[_-]?key|auth|credential|bearer/i;

/** Marcador de sub-agente que emite el relay: `sub-agente: <nombre del roster>`. Lo dejamos
 *  legible sin exponer el nombre interno (worker-low/mid/high) en el hint always-on. */
const SUBAGENT_PREFIX = "sub-agente:";

/** Labels amables de sub-agente. Son los ÚNICOS strings que produce la rama de sub-agente de
 *  `activityLabel` → sirven como firma para que el canal (`isSubagentLabel`) marque el frame
 *  `activity` con `kind:"subagent"` SIN tener que reenviar el nombre crudo del roster. Si cambiás
 *  estos textos, el predicado los sigue (se derivan del mismo lugar). */
const SUBAGENT_LABEL_GENERICO = "trabajando con un sub-agente";
const SUBAGENT_LABEL_ESPECIALISTA = "consultando a un especialista";

/** Hint de la coreografía MECÁNICA de delegación v2: cuando el gateway despacha un worker async
 *  (archima), emite ESTE label como frame `activity` para que el canal lo marque `kind:"subagent"`
 *  y la web lo muestre como underhint bajo el orb. Copy fijo (contrato UX del owner). NO lo produce
 *  `activityLabel` (no es un tool-call): lo emite el gateway directo en el spawn. */
export const SUBAGENT_SPAWNED_HINT = "subagente creado";

/** Roster de sub-agentes → cómo lo mostramos. `label` es el hint amable always-on (visible bajo
 *  el orb, también con debug off): NO filtra el nombre interno ni el modelo. `tier` (haiku/sonnet/
 *  opus) va sólo al `detail` (superficies de debug), por si alguien quiere saber qué modelo corrió.
 *  `worker-high`=opus es el "especialista" (tarea más pesada); low/mid son asistentes. */
const SUBAGENT_ROSTER: Record<string, { label: string; tier: string }> = {
  "worker-low": { label: SUBAGENT_LABEL_GENERICO, tier: "haiku" },
  "worker-mid": { label: SUBAGENT_LABEL_GENERICO, tier: "sonnet" },
  "worker-high": { label: SUBAGENT_LABEL_ESPECIALISTA, tier: "opus" },
};

/** Conjunto de labels que marcan el frame `activity` como `kind:"subagent"`: los del roster
 *  (`activityLabel`) + el hint de la coreografía mecánica de spawn (`SUBAGENT_SPAWNED_HINT`). */
const SUBAGENT_LABELS: ReadonlySet<string> = new Set([
  SUBAGENT_LABEL_GENERICO,
  SUBAGENT_LABEL_ESPECIALISTA,
  SUBAGENT_SPAWNED_HINT,
]);

/** ¿Este `label` (ya humanizado por `activityLabel`) corresponde a un sub-agente del roster?
 *  El canal remoto lo usa para marcar el frame `activity` con `kind:"subagent"` y que la web
 *  encienda el indicador dedicado/persistente, sin acoplarse al nombre interno (worker-*). */
export function isSubagentLabel(label: string): boolean {
  return SUBAGENT_LABELS.has(label);
}

/** Las dos partes para el marcador de sub-agente. Reconoce el roster (worker-low/mid/high) y le
 *  da un label amable; el modelo (haiku/sonnet/opus) va al detail (debug). Para un nombre fuera
 *  del roster, un genérico amable sin exponer el nombre crudo. */
function subagentParts(raw: string): ActivityParts {
  const name = raw
    .slice(raw.indexOf(":") + 1)
    .trim()
    .toLowerCase();
  const known = SUBAGENT_ROSTER[name];
  if (known) return { label: known.label, detail: known.tier };
  return { label: SUBAGENT_LABEL_GENERICO };
}

/** Pela el prefijo `mcp__server__` de un nombre de tool de MCP (`mcp__wiki__write` → `write`).
 *  Si no tiene ese formato, devuelve el nombre tal cual. */
function bareToolName(raw: string): string {
  const m = raw.match(/^mcp__[^_]+(?:_[^_]+)*?__(.+)$/);
  if (m?.[1]) return m[1];
  // Forma alternativa: cualquier `a__b__c` → último segmento.
  if (raw.includes("__")) {
    const parts = raw.split("__").filter(Boolean);
    return parts[parts.length - 1] ?? raw;
  }
  return raw;
}

/** Colapsa el nombre del server duplicado al frente de un tool name aplanado.
 *
 *  MA aplana las tools de un MCP server hosted como `<server>_<tool>`. Cuando la tool de ese
 *  server YA arranca con el nombre del server (Tavily expone su tool como `tavily_search` bajo
 *  el server `tavily`), el aplanado da `tavily_tavily_search` → "tavily tavily search". Acá
 *  colapsamos SOLO esa palabra-prefijo repetida inmediata: `tavily_tavily_search` → `tavily_search`.
 *  No toca `gmail_search` (server distinto del prefijo de la tool → "gmail search" aporta contexto)
 *  ni nombres sin repetición. Es deliberadamente conservador: dedup sólo ante solapamiento exacto. */
function dedupServerPrefix(bare: string): string {
  return bare.replace(/^([^_-]+)[_-]\1(?=[_-]|$)/, "$1");
}

/** Nombre técnico limpiado para el `detail` de fallback: `_`/`-` → espacios. El label
 *  del hint always-on usa en cambio "trabajando" (genérico amable, sin jerga). */
function prettyName(bare: string): string {
  return bare.replace(/[_-]+/g, " ").trim() || bare;
}

/** Colapsa whitespace a una sola línea, recorta y trunca a `max` con elipsis. */
function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** ¿Es un valor primitivo que vale la pena mostrar (string no vacío o número finito)? */
function primitive(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length ? t : undefined;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  return undefined;
}

/** Saca el string del comando de un input de `bash` (input suelto string, o `{ command }`). */
function bashCommand(input: unknown): string | undefined {
  if (typeof input === "string") return input.trim() || undefined;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const c = (input as Record<string, unknown>).command;
    if (typeof c === "string") return c.trim() || undefined;
  }
  return undefined;
}

/** Traduce un comando de shell a un label amable y NO técnico, reconociendo patrones comunes.
 *  Nunca devuelve el comando crudo: eso va al `detail` (sólo debug). Para comandos que no
 *  reconocemos, un genérico amable ("corriendo una tarea") en vez de jerga ni el comando. */
function bashLabel(command: string | undefined): string {
  const cmd = (command ?? "").toLowerCase();
  if (!cmd) return "corriendo una tarea";
  // Sync de la wiki/notas: el agente corre `node …/wiki-sync.mjs pull|push …` para leer/guardar.
  if (cmd.includes("wiki-sync") || /\bwiki[ -]?sync\b/.test(cmd)) {
    if (/\bpush\b/.test(cmd)) return "guardando en tu wiki";
    if (/\bpull\b/.test(cmd)) return "actualizando tu wiki";
    return "sincronizando tu wiki";
  }
  // git → en amable es "guardar cambios" (commit/push/add/…); read-only igual no se muestra crudo.
  if (/(^|[\s;&|(])git\b/.test(cmd)) return "guardando cambios";
  return "corriendo una tarea";
}

/** Saca un resumen corto del input según la tool. Devuelve "" si no hay nada útil/seguro. */
function extractDetail(bare: string, input: unknown): string {
  // El input puede ser un string suelto (algunas tools) → mostralo tal cual.
  if (typeof input === "string") return clip(input, MAX_DETAIL);
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const obj = input as Record<string, unknown>;

  // 1) Claves preferidas para esta tool, después el orden genérico.
  const preferred = DETAIL_KEYS[bare] ?? [];
  for (const key of [...preferred, ...GENERIC_KEYS]) {
    if (SECRET_RE.test(key)) continue;
    const val = primitive(obj[key]);
    if (val) return clip(val, MAX_DETAIL);
  }

  // 2) Fallback genérico: el primer string significativo de cualquier campo no-secreto…
  for (const [key, raw] of Object.entries(obj)) {
    if (SECRET_RE.test(key)) continue;
    if (typeof raw === "string") {
      const val = primitive(raw);
      if (val) return clip(val, MAX_DETAIL);
    }
  }
  // …o, si no hay strings, `key=value` de hasta 2 campos primitivos.
  const pairs: string[] = [];
  for (const [key, raw] of Object.entries(obj)) {
    if (SECRET_RE.test(key)) continue;
    const val = primitive(raw);
    if (val) pairs.push(`${key}=${val}`);
    if (pairs.length === 2) break;
  }
  return pairs.length ? clip(pairs.join(", "), MAX_DETAIL) : "";
}

/** Las dos partes de un label de actividad: el `label` amable/corto (sin params, para el hint
 *  always-on bajo el orb) y el `detail` opcional con el resumen de params (sólo para debug). */
export type ActivityParts = { label: string; detail?: string };

/**
 * Traduce el `name` crudo de una tool-call (o el marcador de sub-agente) a DOS partes: un
 * `label` corto y legible en español (verbo amigable, SIN params) y un `detail` opcional con un
 * resumen conciso del `input` (los args con que corre la tool). Para tools conocidas usa el mapa
 * de verbos; para el resto usa "trabajando" como label genérico amable (sin jerga en el hint
 * always-on) y pone el nombre técnico limpiado al principio del `detail` (solo-debug). El
 * detalle se trunca a una sola línea. `label` nunca es vacío; `detail` se omite si no hay
 * nada útil/seguro que mostrar.
 */
export function activityLabel(raw: string, input?: unknown): ActivityParts {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { label: "trabajando" };
  if (trimmed.toLowerCase().startsWith(SUBAGENT_PREFIX)) return subagentParts(trimmed);
  const bare = dedupServerPrefix(bareToolName(trimmed));
  // `bash` no está en LABELS: su label amable se deriva del comando (wiki-sync/git/…).
  if (bare === "bash") {
    const base = bashLabel(bashCommand(input));
    const detail = extractDetail(bare, input);
    return detail ? { label: base, detail } : { label: base };
  }
  const knownLabel = LABELS[bare];
  if (knownLabel !== undefined) {
    const detail = extractDetail(bare, input);
    return detail ? { label: knownLabel, detail } : { label: knownLabel };
  }
  // Fallback para tool desconocida: label genérico amable (sin jerga en el hint always-on);
  // el nombre técnico limpiado va al principio del `detail` (solo-debug), seguido del
  // resumen de args si los hay.
  const pretty = prettyName(bare);
  const argsDetail = extractDetail(bare, input);
  const detail = argsDetail ? clip(`${pretty}: ${argsDetail}`, MAX_DETAIL) : pretty;
  return { label: "trabajando", detail };
}
