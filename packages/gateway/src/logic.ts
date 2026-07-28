// Lógica pura del gateway, extraída de index.ts (que es el proceso always-on, inimportable
// en tests: loadEnvFile + abre DB + canales). Acá vive lo determinista — sin DB, sin red,
// sin env-side-effects — para poder testearlo aparte. index.ts envuelve estas funciones
// inyectando su estado (db/env/cfg).

import { createHash } from "node:crypto";
import type { WikiChangeOp } from "@ceibo/store";
import type { ChatModel } from "./models.ts";

// --- Higiene de mensajes al usuario (no filtrar interna) -------------------
// `isInternalDetail`/`publicErrorReason` viven ahora en `@ceibo/agent` (paquete hoja) para que
// los canales puedan sanear errores sin que `channels` dependa de `gateway`. Los re-exportamos
// acá para no romper los imports/tests existentes del gateway.
export { isInternalDetail, publicErrorReason } from "@ceibo/agent";

/** Extrae el path-secret embebido en una CONTROL_MCP_URL (`…/mcp/control/<secret>`), sin slash/query/
 *  fragment. "" si la URL no tiene ese path. Lo usa el fail-fast del gateway: ese secret DEBE ser ==
 *  CONTROL_MCP_SECRET, o el listener del control da 404 a todo y el connect queda roto EN SILENCIO
 *  (incidente staging 2026-06-20: la URL traía el secret de prod y el SECRET se regeneró aparte). */
export function controlUrlSecret(url: string): string {
  return url.split("/mcp/control/")[1]?.split(/[/?#]/)[0] ?? "";
}

/** Huella pública de un session id para `/session`: el id real es interna (nombre de VM con el
 *  env id en archima; `sesn_…` en MA) → mostramos un fingerprint corto NO reversible, estable
 *  por sesión, que alcanza para soporte (el gateway loguea el mapeo completo al abrir sesión). */
export function sessionFingerprint(sid: string): string {
  return `#${createHash("sha256").update(sid).digest("hex").slice(0, 8)}`;
}

// --- Modalidad de respuesta (Fase 10) ------------------------------------
// El AGENTE marca su mensaje con `[[voice]]`/`[[text]]`; el bridge lo detecta, lo quita y
// responde en esa modalidad. Sin marcador → texto.
const VOICE_MARKER = /^\s*\[\[\s*voice\s*\]\]\s*/i;
const TEXT_MARKER = /^\s*\[\[\s*text\s*\]\]\s*/i;

export function parseModalityDirective(text: string): { voice: boolean; text: string } {
  if (VOICE_MARKER.test(text)) return { voice: true, text: text.replace(VOICE_MARKER, "") };
  if (TEXT_MARKER.test(text)) return { voice: false, text: text.replace(TEXT_MARKER, "") };
  return { voice: false, text };
}

// --- Idioma (Fase 15) ----------------------------------------------------
const LANG_TAGS: Record<string, string> = {
  en: "[respondé en inglés (the user's language is English)]",
};

/** Tag de idioma que el gateway antepone al turno, o undefined si no aplica (es = default). */
export function langTag(lang: string): string | undefined {
  return LANG_TAGS[lang];
}

// --- Hora actual (ancla para tiempos relativos) --------------------------
// El agente no tiene reloj propio: para resolver "en 1 minuto", "mañana 9am" o agendar un
// recordatorio (MCP schedule) necesita saber la fecha/hora actual de forma INEQUÍVOCA. Sin
// esto, modelos como Gemma (archima) tratan la hora del sistema (UTC) como si fuera local y
// erran por el offset de la tz. Inyectamos un tag con un ISO 8601 que SIEMPRE lleva offset
// explícito, calculado en la MISMA tz que usa el MCP schedule (DEFAULT_TZ) para que coincidan.

/** tz por defecto, igual que el MCP schedule (`packages/mcps/.../schedule.ts`). v1: Argentina/UY. */
export const DEFAULT_TZ = "America/Argentina/Buenos_Aires";

/** Formatea un `Date` como ISO 8601 con offset explícito en la `tz` dada (ej.
 *  `2026-06-08T14:17:03-03:00`). Deriva el wall-clock y el offset reales con `Intl`, así
 *  respeta la tz (y eventual DST) sin libs ni hardcodear el offset. */
export function isoWithOffset(date: Date, tz: string = DEFAULT_TZ): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // Algunos runtimes emiten "24" para medianoche con hour12:false → normalizá a "00".
  const hour = get("hour") === "24" ? "00" : get("hour");
  // `longOffset` da "GMT-03:00" (o "GMT" en UTC) → quedate con "-03:00" / "+00:00".
  const off = get("timeZoneName").replace(/^GMT/, "");
  const offset = /^[+-]\d{2}:\d{2}$/.test(off) ? off : "+00:00";
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}${offset}`;
}

/** Tag de fecha/hora actual que el gateway antepone a TODO turno: ancla inequívoca (con offset)
 *  para que el agente calcule tiempos relativos y agende recordatorios en la hora correcta. */
export function currentTimeTag(now: Date, tz: string = DEFAULT_TZ): string {
  return `[fecha y hora actual: ${isoWithOffset(now, tz)}]`;
}

// --- Resolución de agente por modelo (MA: el modelo es atributo del agente) ----
/** agentId del coordinador del modelo elegido por el usuario; cae al principal (fallback)
 *  si el modelo no está publicado en esta box. `modelKey` null = sin preferencia → default. */
export function resolveAgentId(
  modelKey: string | null,
  modelByKey: Map<string, ChatModel>,
  env: NodeJS.ProcessEnv,
  fallbackAgentId: string,
  defaultKey: string,
): string {
  const key = modelKey ?? defaultKey;
  const m = modelByKey.get(key) ?? modelByKey.get(defaultKey);
  return (m && env[m.envKey]) || fallbackAgentId;
}

// --- Perfil default multi-cuenta (Fase 7) --------------------------------
/** Perfil default efectivo: el explícito del usuario; si no, y todos sus grants son de UN
 *  perfil con nombre, ése; si no, el default. `grantProfiles` = profiles de sus grants. */
export function pickDefaultProfile(
  userDefaultProfile: string | null,
  grantProfiles: string[],
  defaultProfile: string,
): string {
  if (userDefaultProfile) return userDefaultProfile;
  if (grantProfiles.length === 0) return defaultProfile;
  const profiles = new Set(grantProfiles);
  if (profiles.size === 1) {
    const [only] = profiles;
    if (only && only !== defaultProfile) return only;
  }
  return defaultProfile;
}

// --- Matching de wiki por lo que tipeó el usuario ------------------------
/** ¿La wiki (dado su nombre/label/dueño/display) matchea lo que el usuario tipeó en
 *  `/wiki set <x>` o `/rem <x>`? Tolerante: nombre del repo, label pelado, `dueño-label`,
 *  o el display name efectivo — todo case-insensitive. */
export function wikiMatches(
  meta: { name: string; label: string; ownerHandle: string; display?: string },
  typed: string,
): boolean {
  const t = typed.trim().toLowerCase();
  const label = meta.label.toLowerCase();
  return (
    meta.name.toLowerCase() === t ||
    label === t ||
    `${meta.ownerHandle}-${label}` === t ||
    meta.display?.toLowerCase() === t
  );
}

// --- Resumen de cambios de wiki del turno (en la voz del agente) ----------
// Cuando un turno INTERACTIVO termina y el agente tocó la wiki durante él, el gateway cierra
// con un resumen conciso en PRIMERA PERSONA del agente ("creé…", "borré…", "edité…"). La
// conjugación + el formato viven acá (puro, testeable); el motor junta los cambios
// source='agent' del turno y llama a `formatTurnSummary`.

export interface WikiTurnChange {
  op: WikiChangeOp;
  /** Path de la nota (puede traer carpetas); el resumen muestra sólo el nombre, sin `.md`. */
  path: string;
}

// Verbo en 1ª persona del agente ("yo").
const VERB_I: Record<WikiChangeOp, string> = {
  create: "creé",
  edit: "edité",
  delete: "borré",
  archive: "archivé",
  move: "moví",
};

// Orden en que aparecen las cláusulas en el resumen (estable, independiente del orden de
// llegada de los cambios).
const OP_ORDER: WikiChangeOp[] = ["create", "edit", "delete", "archive", "move"];

// Precedencia para coalescer varias ops sobre la MISMA nota en el turno: el cambio más
// "fuerte" gana (borrar/archivar > crear > mover > editar). Así "creé y edité X" se reporta
// como "creé X", y "edité y borré X" como "borré X".
const OP_WEIGHT: Record<WikiChangeOp, number> = { edit: 0, move: 1, create: 2, archive: 3, delete: 3 };

// Cuántos nombres de nota listar por cláusula antes de cortar con "…y N más".
const MAX_NAMES = 4;

/** Nombre de archivo de un path (sin carpetas). No técnico: nada de rutas absolutas. */
export function noteName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Nombre para mostrar: el de archivo sin la extensión `.md` (las notas son markdown). */
function displayName(path: string): string {
  return noteName(path).replace(/\.md$/i, "");
}

function nameList(names: string[]): string {
  if (names.length <= MAX_NAMES) return names.join(", ");
  return `${names.slice(0, MAX_NAMES).join(", ")} …y ${names.length - MAX_NAMES} más`;
}

function clause(op: WikiChangeOp, names: string[]): string {
  const verb = VERB_I[op];
  if (names.length === 1) return `${verb} «${names[0]}»`;
  return `${verb} ${names.length} notas (${nameList(names)})`;
}

/** Resumen del turno en la voz del agente (o "" si no tocó ninguna nota). Coalesce por nota
 *  quedándose con la op de mayor precedencia, agrupa por op (en `OP_ORDER`) preservando el
 *  orden de aparición de las notas, y arma una frase concisa en 1ª persona. */
export function formatTurnSummary(items: WikiTurnChange[]): string {
  if (items.length === 0) return "";
  // 1) Coalesce por nombre de nota: la op más fuerte gana; conserva el primer orden visto.
  const byName = new Map<string, { op: WikiChangeOp; i: number }>();
  let i = 0;
  for (const it of items) {
    const key = noteName(it.path);
    const prev = byName.get(key);
    if (!prev) byName.set(key, { op: it.op, i: i++ });
    else if (OP_WEIGHT[it.op] >= OP_WEIGHT[prev.op]) byName.set(key, { op: it.op, i: prev.i });
  }
  // 2) Agrupa por op preservando el orden de aparición de las notas dentro de cada op.
  const namesByOp = new Map<WikiChangeOp, { name: string; i: number }[]>();
  for (const [name, { op, i: idx }] of byName) {
    const arr = namesByOp.get(op) ?? [];
    arr.push({ name, i: idx });
    namesByOp.set(op, arr);
  }
  // 3) Una cláusula por op presente, en OP_ORDER.
  const clauses: string[] = [];
  for (const op of OP_ORDER) {
    const arr = namesByOp.get(op);
    if (!arr || arr.length === 0) continue;
    arr.sort((a, b) => a.i - b.i);
    clauses.push(
      clause(
        op,
        arr.map((x) => displayName(x.name)),
      ),
    );
  }
  if (clauses.length === 0) return "";
  const joined =
    clauses.length === 1 ? clauses[0] : `${clauses.slice(0, -1).join(", ")} y ${clauses[clauses.length - 1]}`;
  return `Listo: ${joined}.`;
}

// --- Resultado estructurado de sub-agentes --------------------------------
// Los workers pueden terminar con un bloque JSON fenced. El coordinador recibe una síntesis
// estable y compacta, pero mantenemos fallback al texto libre viejo para no romper workers
// existentes ni corridas en curso.

export type WorkerResultStatus = "done" | "blocked" | "partial";
export type WorkerChangedNoteAction = "created" | "edited" | "moved" | "archived" | "deleted";

export interface WorkerChangedNote {
  path: string;
  action: WorkerChangedNoteAction;
}

export interface WorkerStructuredResult {
  status: WorkerResultStatus;
  pushed?: boolean;
  commit_message?: string;
  changed_notes?: WorkerChangedNote[];
  opened_note?: string;
  blockers?: string[];
  summary_for_user: string;
}

export interface WorkerVerificationIssue {
  code:
    | "not_pushed"
    | "unsafe_path"
    | "too_many_deletions"
    | "real_changes_not_reported_pushed"
    | "reported_push_missing"
    | "real_too_many_deletions";
  message: string;
}

const WORKER_STATUSES = new Set<WorkerResultStatus>(["done", "blocked", "partial"]);
const WORKER_NOTE_ACTIONS = new Set<WorkerChangedNoteAction>([
  "created",
  "edited",
  "moved",
  "archived",
  "deleted",
]);

function capText(text: string, cap: number): string {
  const clean = text.trim();
  if (clean.length <= cap) return clean;
  return `${clean.slice(0, cap).trimEnd()}\n[…resumen recortado]`;
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}

function asChangedNotes(v: unknown): WorkerChangedNote[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: WorkerChangedNote[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const path = asOptionalString(rec.path);
    const action = rec.action;
    if (!path || typeof action !== "string" || !WORKER_NOTE_ACTIONS.has(action as WorkerChangedNoteAction))
      continue;
    out.push({ path, action: action as WorkerChangedNoteAction });
  }
  return out.length ? out : undefined;
}

function extractLastJsonFence(text: string): string | undefined {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)\s*```/giu)];
  const last = matches.at(-1);
  const body = last?.[1]?.trim();
  return body || undefined;
}

/** Parsea el bloque JSON final de un worker. Devuelve undefined si falta o si no cumple el
 *  contrato mínimo (`status` válido + `summary_for_user`). */
export function parseWorkerStructuredResult(text: string): WorkerStructuredResult | undefined {
  const body = extractLastJsonFence(text);
  if (!body) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const status = rec.status;
  const summary = asOptionalString(rec.summary_for_user);
  if (typeof status !== "string" || !WORKER_STATUSES.has(status as WorkerResultStatus) || !summary)
    return undefined;
  const out: WorkerStructuredResult = {
    status: status as WorkerResultStatus,
    summary_for_user: summary,
  };
  if (typeof rec.pushed === "boolean") out.pushed = rec.pushed;
  const commitMessage = asOptionalString(rec.commit_message);
  if (commitMessage) out.commit_message = commitMessage;
  const changedNotes = asChangedNotes(rec.changed_notes);
  if (changedNotes) out.changed_notes = changedNotes;
  const openedNote = asOptionalString(rec.opened_note);
  if (openedNote) out.opened_note = openedNote;
  const blockers = asStringArray(rec.blockers);
  if (blockers) out.blockers = blockers;
  return out;
}

const STATUS_LABEL: Record<WorkerResultStatus, string> = {
  done: "terminado",
  blocked: "bloqueado",
  partial: "parcial",
};

const NOTE_ACTION_LABEL: Record<WorkerChangedNoteAction, string> = {
  created: "creada",
  edited: "editada",
  moved: "movida",
  archived: "archivada",
  deleted: "borrada",
};

function formatStructuredWorkerResult(result: WorkerStructuredResult): string {
  const issues = verifyWorkerStructuredResult(result);
  const lines = [
    `Estado: ${STATUS_LABEL[result.status]}.`,
    `Resumen para usuario: ${result.summary_for_user}`,
  ];
  if (typeof result.pushed === "boolean") lines.push(`Cambios subidos: ${result.pushed ? "sí" : "no"}.`);
  if (result.commit_message) lines.push(`Commit: ${result.commit_message}`);
  if (result.opened_note) lines.push(`Nota abierta: ${result.opened_note}`);
  if (result.changed_notes?.length) {
    lines.push(
      `Notas tocadas: ${result.changed_notes.map((n) => `${n.path} (${NOTE_ACTION_LABEL[n.action]})`).join(", ")}`,
    );
  }
  if (result.blockers?.length) lines.push(`Bloqueos: ${result.blockers.join("; ")}`);
  if (issues.length) lines.push(`Verificación: ${issues.map((i) => i.message).join("; ")}`);
  return lines.join("\n");
}

function appendWorkerVerificationIssues(text: string, issues: WorkerVerificationIssue[] | undefined): string {
  if (!issues?.length) return text;
  return `${text}\nVerificación real: ${issues.map((i) => i.message).join("; ")}`;
}

function isUnsafeWorkerPath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("~")) return true;
  return path.split("/").some((part) => part === ".." || part === "");
}

/** Verificación mecánica de la metadata reportada por el worker. No reemplaza comparar el diff
 *  real del repo, pero evita pasarle al coordinador señales claramente peligrosas o incompletas
 *  como si fueran limpias. */
export function verifyWorkerStructuredResult(
  result: WorkerStructuredResult,
  opts: { maxDeletedNotes?: number } = {},
): WorkerVerificationIssue[] {
  const maxDeletedNotes = opts.maxDeletedNotes ?? 10;
  const issues: WorkerVerificationIssue[] = [];
  const changed = result.changed_notes ?? [];
  if (result.pushed === false && (changed.length > 0 || result.commit_message)) {
    issues.push({
      code: "not_pushed",
      message: "el worker reportó cambios que no fueron subidos",
    });
  }
  const unsafe =
    changed.find((n) => isUnsafeWorkerPath(n.path)) ??
    (result.opened_note && isUnsafeWorkerPath(result.opened_note) ? { path: result.opened_note } : undefined);
  if (unsafe) {
    issues.push({
      code: "unsafe_path",
      message: `path sospechoso reportado: ${unsafe.path}`,
    });
  }
  const deletions = changed.filter((n) => n.action === "deleted").length;
  if (deletions > maxDeletedNotes) {
    issues.push({
      code: "too_many_deletions",
      message: `el worker reportó ${deletions} borrados (máximo ${maxDeletedNotes})`,
    });
  }
  return issues;
}

interface WorkerObservedFile {
  path: string;
  sha?: string;
}

export interface WorkerObservedWikiDiff {
  repo: string;
  added: WorkerObservedFile[];
  removed: WorkerObservedFile[];
  renamed: { from: string; to: string }[];
  modified: string[];
}

function workerObservedChangedPaths(diff: WorkerObservedWikiDiff): string[] {
  return [
    ...diff.added.map((f) => f.path),
    ...diff.removed.map((f) => f.path),
    ...diff.renamed.flatMap((r) => [r.from, r.to]),
    ...diff.modified,
  ];
}

/** Verifica el diff real observado en las wikis visibles del usuario contra lo reportado por el
 *  worker. Sigue siendo no destructivo: sólo agrega advertencias al coordinador. */
export function verifyWorkerObservedDiff(
  result: WorkerStructuredResult | undefined,
  diffs: WorkerObservedWikiDiff[],
  opts: { maxDeletedNotes?: number } = {},
): WorkerVerificationIssue[] {
  const maxDeletedNotes = opts.maxDeletedNotes ?? 10;
  const issues: WorkerVerificationIssue[] = [];
  const changedPaths = diffs.flatMap(workerObservedChangedPaths);
  const addedShas = new Set(diffs.flatMap((d) => d.added.map((f) => f.sha).filter((s): s is string => !!s)));
  const netDeleted = diffs.flatMap((d) =>
    d.removed
      .filter((f) => f.path.endsWith(".md") && (!f.sha || !addedShas.has(f.sha)))
      .map((f) => `${d.repo}/${f.path}`),
  );

  if (result?.pushed === false && changedPaths.length > 0) {
    issues.push({
      code: "real_changes_not_reported_pushed",
      message: `se detectaron cambios reales en ${diffs.length} wiki(s), aunque el worker reportó pushed:false`,
    });
  }
  if (result?.pushed === true && changedPaths.length === 0) {
    issues.push({
      code: "reported_push_missing",
      message: "el worker reportó pushed:true, pero no detecté cambios nuevos en las wikis visibles",
    });
  }
  if (netDeleted.length > maxDeletedNotes) {
    issues.push({
      code: "real_too_many_deletions",
      message: `se detectaron ${netDeleted.length} borrados reales de notas .md (máximo ${maxDeletedNotes})`,
    });
  }
  return issues;
}

/** Destila lo que devolvió el worker a lo que se reinyecta al coordinador: toma el último mensaje
 *  no vacío, prefiere el JSON estructurado si existe y si no cae al texto libre capado. */
export function parseWorkerStructuredResultFromParts(parts: string[]): WorkerStructuredResult | undefined {
  const last = [...parts].reverse().find((p) => p.trim());
  const text = (last ?? "").trim();
  return text ? parseWorkerStructuredResult(text) : undefined;
}

export function formatWorkerResultForCoordinator(
  parts: string[],
  cap: number,
  opts: { verificationIssues?: WorkerVerificationIssue[] } = {},
): string {
  const last = [...parts].reverse().find((p) => p.trim());
  const text = (last ?? "").trim();
  if (!text) return "";
  const structured = parseWorkerStructuredResult(text);
  const base = structured ? formatStructuredWorkerResult(structured) : text;
  return capText(appendWorkerVerificationIssues(base, opts.verificationIssues), cap);
}

// --- Título del chat (resumen semántico del tema actual) ------------------
// Tras un turno interactivo CON SUSTANCIA, el gateway le pide a un modelo barato (haiku) un
// título corto (2-5 palabras) del tema en curso y lo emite como frame `chat-title` (la web lo
// pinta en el header del chat). Acá viven las piezas PURAS — el gate de sustancia, el prompt y
// el saneo de la respuesta —; la llamada al modelo y la cadencia viven en engine.ts.

// Mensajes triviales que NO ameritan (re)generar un título: saludos, gracias, confirmaciones,
// despedidas, risas. Se comparan sobre el texto del usuario NORMALIZADO (minúsculas, sin
// puntuación/emoji en los bordes). Saltearlos evita gastar un call de haiku y el parpadeo del
// título cuando el tema real no cambió.
const TRIVIAL_TITLE_MSGS = new Set([
  "hola",
  "holis",
  "buenas",
  "buen dia",
  "buenas tardes",
  "buenas noches",
  "hey",
  "que tal",
  "como va",
  "como estas",
  "gracias",
  "muchas gracias",
  "mil gracias",
  "ok gracias",
  "gracias totales",
  "ok",
  "oka",
  "okay",
  "okey",
  "dale",
  "listo",
  "perfecto",
  "genial",
  "joya",
  "barbaro",
  "buenisimo",
  "de una",
  "bien",
  "claro",
  "obvio",
  "si",
  "sip",
  "no",
  "nop",
  "nope",
  "jaja",
  "jajaja",
  "jeje",
  "chau",
  "chao",
  "adios",
  "nos vemos",
  "hasta luego",
  "saludos",
]);

/** Normaliza el texto del usuario para el gate de trivialidad: minúsculas, sin tildes y sin
 *  puntuación/emoji/espacios en los bordes (conserva los espacios internos, ej. "buen dia"). */
function normalizeForTitleGate(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // saca diacríticos combinantes (tildes)
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "");
}

/** ¿El intercambio (último user + agente) amerita (re)generar el título del chat? Saltea los
 *  turnos triviales (saludos/gracias/confirmaciones) y los sin sustancia (texto muy corto o sin
 *  respuesta del agente). Puro: la cadencia y el llamado al modelo viven en engine.ts. */
export function isSubstantialForTitle(userMsg: string, agentMsg: string): boolean {
  const u = normalizeForTitleGate(userMsg);
  if (u.length < 6) return false; // demasiado corto para tener un tema
  if (TRIVIAL_TITLE_MSGS.has(u)) return false; // saludo/confirmación/despedida
  if (!agentMsg.trim()) return false; // el agente no respondió nada → no hay tema cerrado
  return true;
}

/** System + user para pedirle a haiku el título del tema actual. `prev` (si hay) le permite
 *  MANTENER el título cuando el tema no cambió (responde el sentinel OK) → no parpadea. */
export function buildTitlePrompt(
  userMsg: string,
  agentMsg: string,
  prev?: string,
): { system: string; user: string } {
  const system =
    "Sos un asistente que titula conversaciones de chat. Te paso el último intercambio " +
    "(usuario y asistente) y devolvés un título MUY corto, de 2 a 5 palabras, que resuma el " +
    "TEMA del que se está hablando, como el título de un chat. Ejemplos: «Noticias del mundo», " +
    "«Plan viaje a Japón», «Receta de ñoquis». Reglas: devolvé SÓLO el título, sin comillas, " +
    "sin punto final y sin prefijos como «Título:». Usá el idioma del usuario." +
    (prev
      ? ` El título actual es «${prev}»: si el tema NO cambió, respondé exactamente «OK» para mantenerlo.`
      : "");
  const user =
    `Usuario: ${userMsg.slice(0, 800)}\n\nAsistente: ${agentMsg.slice(0, 800)}\n\n` +
    "Título del tema (2-5 palabras):";
  return { system, user };
}

/** Sanea la respuesta cruda de haiku a un título usable, o undefined si hay que MANTENER el
 *  previo (respuesta vacía, el sentinel OK, o un título idéntico al que ya teníamos). Saca el
 *  prefijo «Título:», las comillas/asteriscos de envoltura y la puntuación de borde, colapsa
 *  espacios y capa el largo. */
export function sanitizeTitle(raw: string, prev?: string): string | undefined {
  let t = (raw ?? "").trim();
  if (!t) return undefined;
  t = t.replace(/^(t[ií]tulo|title)\s*:\s*/iu, ""); // prefijo "Título:" / "Title:"
  t = t
    .replace(/^[\s"'«»`*_]+/u, "")
    .replace(/[\s"'«».,;:!¡¿?*_]+$/u, "")
    .trim(); // envoltura + borde
  if (!t) return undefined;
  if (/^ok$/iu.test(t)) return undefined; // sentinel "mantené el previo"
  t = t.replace(/\s+/g, " ");
  if (t.length > 48) t = t.slice(0, 48).trim(); // capá títulos largos (haiku se desbordó)
  if (!t) return undefined;
  if (prev && t.toLowerCase() === prev.toLowerCase()) return undefined; // sin cambio → no re-emitir
  return t;
}

// --- Guardrail de REM: tope de borrado por pasada (incidente 2026-06-09) --
// Una pasada de REM "consolidó" archivando 37 notas reales de una wiki (history rewrite previo
// había dejado el cursor roto → contexto confuso para el modelo). Independiente de la causa:
// una pasada no puede borrar en masa sin freno MECÁNICO. El gateway compara HEAD antes/después
// del turno (diffFiles de @ceibo/wikis) y, si las deletions netas superan el tope, revierte.

/** Deletions NETAS de notas (`.md`) en el diff de una pasada de REM. El criterio (documentado
 *  también en el PR del guardrail):
 *  - sólo cuentan archivos `.md` con status "removed" (D en name-status);
 *  - los renames/moves que git detectó (status R) NO cuentan: el contenido sigue vivo;
 *  - un move que git NO detectó como rename (D de un path + A de otro con EL MISMO blob sha)
 *    tampoco cuenta: el blob borrado reaparece agregado en otro lado → no se perdió contenido.
 *  Lo que queda son los D "de verdad": contenido que dejó de existir en HEAD. */
export function remNetDeletions(diff: {
  added: { path: string; sha: string }[];
  removed: { path: string; sha: string }[];
}): string[] {
  const addedShas = new Set(diff.added.map((a) => a.sha).filter((s) => s !== ""));
  return diff.removed.filter((f) => f.path.endsWith(".md") && !addedShas.has(f.sha)).map((f) => f.path);
}

/** Parsea el tope `REM_MAX_DELETIONS` del env (default 10). Acepta 0 (= revertir ante
 *  cualquier deletion neta); ante un valor no numérico o negativo cae al default. */
export function remMaxDeletions(raw: string | undefined, def = 10): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

// --- Guardrail de REM: atribución de commits del rango (review 2026-06-10) ----------------
// El diff del guardrail (`headBefore..headAfter`) abarca TODO lo que entró a la wiki durante
// la pasada, no sólo lo que escribió REM. Si otro escritor (el usuario por la web, otra
// pestaña, un push git directo) commiteó en el medio, sus borrados se le imputaban a REM y
// — peor — el auto-revert a `headBefore` deshacía también ESE trabajo ajeno. Filtrar "por
// autor git" NO alcanza: desde #296 los commits de agentes llevan la identidad git del
// USUARIO dueño (gitAuthorFor), indistinguible de un edit web del mismo usuario.
//
// La fuente confiable es el change feed (`wiki_changes`, compartido por SQLite entre
// procesos): todo commit MEDIADO por ceibo registra ahí su sha resultante con `source` y
// `userId` — la web con source 'web' (web.ts), los agentes (chat y REM, vía
// /api/sync/commit) con source 'agent' + el userId dueño de la sesión, y el watcher de
// HEADs out-of-band con source NULL. Lo que NO está en el feed entró por fuera (push git
// directo). Un commit es atribuible a la sesión de REM si su fila dice agente + el usuario
// de la corrida, registrada DESPUÉS del arranque (el caller pasa el feed desde el cursor
// capturado al inicio de la pasada).
//
// Limitación conocida (residual aceptado): un commit del agente de CHAT del MISMO usuario
// durante la ventana es indistinguible (mismo source+userId). Mitigantes: el cron corre
// 04:00 BA (chat concurrente improbable), el revert queda anclado a `expectedHead` (aborta
// si HEAD se movió después), y el aviso lista los commits revertidos (nada se pierde: el
// revert es sin force).

/** Fila mínima del change feed para la atribución (proyección de `WikiChange` del store). */
export interface RemFeedEntry {
  ref: string;
  source: string | null;
  userId: number | null;
}

/** Commits del rango del guardrail que NO se pueden atribuir con certeza a la sesión de REM
 *  del usuario `remUserId`, con el motivo. Si devuelve alguno, el caller NO debe auto-revertir
 *  (revertir pisaría trabajo ajeno): degrada a alertar al dueño. Lista vacía = todos los
 *  commits son de esta sesión → el auto-revert es seguro. Tolera filas duplicadas para el
 *  mismo sha (race watcher/sync): alcanza con que UNA lo atribuya al agente del usuario. */
export function remForeignCommits(
  commits: { sha: string; message: string }[],
  feed: RemFeedEntry[],
  remUserId: number,
): { sha: string; message: string; why: string }[] {
  const out: { sha: string; message: string; why: string }[] = [];
  for (const c of commits) {
    const rows = feed.filter((f) => f.ref === c.sha);
    // 'rem' está reservado en WikiChangeSource (hoy nadie lo escribe); lo aceptamos para que
    // el día que el sync distinga REM explícitamente, esto siga atribuyendo bien.
    if (rows.some((f) => (f.source === "agent" || f.source === "rem") && f.userId === remUserId)) continue;
    const why =
      rows.length === 0
        ? "no pasó por ceibo en esta corrida (¿push directo / fuera de ventana?)"
        : rows.some((f) => f.source === "web")
          ? "edición web del usuario"
          : rows.some((f) => (f.source === "agent" || f.source === "rem") && f.userId !== remUserId)
            ? "agente de OTRO usuario"
            : "origen desconocido (watcher out-of-band)";
    out.push({ sha: c.sha, message: c.message, why });
  }
  return out;
}

// --- REM planner/executor: contrato estructurado --------------------------
// Primer paso de Fase F: separar el "pensar el plan" de "ejecutarlo". Estas piezas son puras para
// poder probar el contrato antes de cambiar la corrida real de REM.

export type RemPlanRisk = "low" | "medium" | "high";
export type RemPlanActionType = "create" | "edit" | "move" | "archive" | "delete" | "merge" | "none";

export interface RemPlanAction {
  type: RemPlanActionType;
  path: string;
  target?: string;
  reason: string;
}

export interface RemStructuredPlan {
  risk: RemPlanRisk;
  should_execute: boolean;
  requires_user_confirmation: boolean;
  summary: string;
  actions: RemPlanAction[];
  blockers?: string[];
  report_for_user?: string;
}

const REM_PLAN_RISKS = new Set<RemPlanRisk>(["low", "medium", "high"]);
const REM_PLAN_ACTIONS = new Set<RemPlanActionType>([
  "create",
  "edit",
  "move",
  "archive",
  "delete",
  "merge",
  "none",
]);

/** Prompt para un planner REM fuerte: analiza y devuelve plan, pero NO edita ni pushea. */
export function buildRemPlannerPrompt(repoName: string, scope: string): string {
  return (
    `Planificá REM para la wiki "${repoName}". NO edites archivos, NO ejecutes scripts y NO hagas push. ` +
    `Tu única tarea es leer el contexto necesario y devolver un plan final en JSON fenced, sin texto después.\n\n` +
    `${scope}\n\n` +
    "Contrato del bloque final:\n" +
    "```json\n" +
    `{"risk":"low|medium|high","should_execute":true,"requires_user_confirmation":false,"summary":"qué conviene hacer","actions":[{"type":"create|edit|move|archive|delete|merge|none","path":"ruta.md","target":"ruta destino si aplica","reason":"motivo"}],"blockers":[],"report_for_user":"resumen breve opcional"}\n` +
    "```\n" +
    `Marcá risk:"high" o requires_user_confirmation:true si el plan implica borrados masivos, ` +
    `reorganización ambigua, tocar muchas notas, o inferencias débiles.\n` +
    // No-op guard (incidente 2026-06-14): un delta sin trabajo real de consolidación (nada que
    // fusionar/dedup/corregir; ej. el único cambio es un borrado intencional YA reflejado, o
    // cambios triviales/cosméticos ya consistentes) NO debe generar acciones inventadas. Si las
    // emite, el executor intenta "ejecutar" algo ya satisfecho y entra en loop de edit/commit/push.
    `IMPORTANTE: si el delta NO requiere trabajo de consolidación (no hay nada que fusionar, ` +
    `deduplicar ni corregir — p.ej. el único cambio es un borrado intencional ya reflejado, o ` +
    `son cambios triviales/cosméticos ya consistentes), devolvé should_execute:false con actions:[] ` +
    `(o un solo {"type":"none",...}) y un report_for_user corto tipo "sin consolidación necesaria". ` +
    `NUNCA inventes acciones para un delta que ya está bien.`
  );
}

export type RemRoutingTier = "low" | "medium" | "high";

export interface RemRoutingInput {
  firstRun: boolean;
  weekly?: boolean;
  changedPaths: string[];
  deletedPaths: string[];
  threshold: number;
}

export interface RemRoutingDecision {
  score: number;
  tier: RemRoutingTier;
  usePlanner: boolean;
  reasons: string[];
}

export function scoreRemRouting(input: RemRoutingInput): RemRoutingDecision {
  const reasons: string[] = [];
  let score = 0;
  if (input.firstRun) {
    score += 10;
    reasons.push("primera corrida");
  }
  if (input.weekly) {
    score += 4;
    reasons.push("pasada semanal");
  }
  if (input.changedPaths.length > 0) {
    score += input.changedPaths.length;
    reasons.push(`${input.changedPaths.length} modificada(s)`);
  }
  if (input.deletedPaths.length > 0) {
    score += input.deletedPaths.length * 5;
    reasons.push(`${input.deletedPaths.length} borrada(s)`);
  }
  const memoryTouched = input.changedPaths
    .concat(input.deletedPaths)
    .filter((p) => p.startsWith("memoria/")).length;
  if (memoryTouched > 0) {
    score += memoryTouched * 2;
    reasons.push(`${memoryTouched} memoria`);
  }
  const tier: RemRoutingTier = score >= 12 ? "high" : score >= 6 ? "medium" : "low";
  return {
    score,
    tier,
    usePlanner: score >= input.threshold,
    reasons: reasons.length ? reasons : ["sin cambios relevantes"],
  };
}

function extractLastJsonFenceText(text: string): string | undefined {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)\s*```/giu)];
  const last = matches.at(-1);
  const body = last?.[1]?.trim();
  return body || undefined;
}

/** Repara escapes octales de bytes UTF-8 (`\303\261` → "ñ") que los modelos locales (Gemma) a
 *  veces emiten dentro de strings JSON. Es JSON inválido (JSON solo admite `\uXXXX`), así que
 *  `JSON.parse` tiraría. Solo tocamos runs de bytes altos (`\200`–`\377` = 128–255, lead/cont de
 *  UTF-8): un `\` seguido de dígito nunca aparece en JSON válido, y los bajos (control ASCII) no
 *  se convierten para no inyectar caracteres de control crudos en un string. */
function repairOctalUtf8Escapes(body: string): string {
  return body.replace(/(?:\\[23][0-7][0-7])+/g, (run) => {
    const bytes = (run.match(/\\([0-3][0-7][0-7])/g) ?? []).map((o) => Number.parseInt(o.slice(1), 8));
    return Buffer.from(bytes).toString("utf8");
  });
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asRemPlanActions(v: unknown): RemPlanAction[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: RemPlanAction[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const type = rec.type;
    const path = asOptionalString(rec.path);
    const reason = asOptionalString(rec.reason);
    if (typeof type !== "string" || !REM_PLAN_ACTIONS.has(type as RemPlanActionType) || !path || !reason)
      continue;
    const action: RemPlanAction = { type: type as RemPlanActionType, path, reason };
    const target = asOptionalString(rec.target);
    if (target) action.target = target;
    out.push(action);
  }
  return out;
}

/** Parsea el plan REM estructurado. Devuelve undefined si falta el contrato mínimo. */
export function parseRemStructuredPlan(text: string): RemStructuredPlan | undefined {
  const body = extractLastJsonFenceText(text);
  if (!body) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    // Reintento tolerante: reparar escapes octales de UTF-8 que emiten los modelos locales.
    try {
      raw = JSON.parse(repairOctalUtf8Escapes(body));
    } catch {
      return undefined;
    }
  }
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const risk = rec.risk;
  const shouldExecute = asBool(rec.should_execute);
  const requiresUserConfirmation = asBool(rec.requires_user_confirmation);
  const summary = asOptionalString(rec.summary);
  const actions = asRemPlanActions(rec.actions);
  if (
    typeof risk !== "string" ||
    !REM_PLAN_RISKS.has(risk as RemPlanRisk) ||
    shouldExecute === undefined ||
    requiresUserConfirmation === undefined ||
    !summary ||
    !actions
  ) {
    return undefined;
  }
  const plan: RemStructuredPlan = {
    risk: risk as RemPlanRisk,
    should_execute: shouldExecute,
    requires_user_confirmation: requiresUserConfirmation,
    summary,
    actions,
  };
  const blockers = asStringArray(rec.blockers);
  if (blockers) plan.blockers = blockers;
  const report = asOptionalString(rec.report_for_user);
  if (report) plan.report_for_user = report;
  return plan;
}

/**
 * ¿El plan tiene trabajo REAL para el executor? Guard mecánico anti-loop (incidente 2026-06-14):
 * el planner local (Gemma) a veces emite should_execute:true con acciones vacías o sólo {type:"none"}
 * para un delta que NO requiere consolidación. El executor lee "ejecutá SOLAMENTE este plan", no
 * encuentra nada accionable y entra en loop de edit/commit/push hasta el abort anti-runaway. Tratamos
 * un plan sin acciones accionables como no-op DURO en código (no de prompt): no se invoca al executor.
 * "none" es explícitamente un no-op en el contrato (RemPlanActionType incluye "none").
 */
export function remPlanHasWork(plan: RemStructuredPlan): boolean {
  return plan.actions.some((a) => a.type !== "none");
}

export function formatRemPlanForExecutor(plan: RemStructuredPlan): string {
  const lines = [
    `Riesgo: ${plan.risk}`,
    `Ejecutar: ${plan.should_execute ? "sí" : "no"}`,
    `Requiere confirmación: ${plan.requires_user_confirmation ? "sí" : "no"}`,
    `Resumen: ${plan.summary}`,
    "Acciones:",
    ...plan.actions.map((a) => `- ${a.type} ${a.path}${a.target ? ` -> ${a.target}` : ""}: ${a.reason}`),
  ];
  if (plan.blockers?.length) lines.push(`Bloqueos: ${plan.blockers.join("; ")}`);
  if (plan.report_for_user) lines.push(`Reporte sugerido: ${plan.report_for_user}`);
  return lines.join("\n");
}
