// DB de ceibo (Fase 2). SQLite síncrona (better-sqlite3), un archivo en la box.
//
// Modela: usuario → N identidades de canal (= allowlist + router) + N repos.
// Una sesión MA activa por usuario, con snapshot del usage acumulado para poder
// computar el costo de cada turno por diferencia. `usage_turns` es el ledger
// fuente de verdad para facturar: guarda SIEMPRE tokens crudos + un cost_usd
// derivado (precio público × markup).

import {
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { CronExpressionParser } from "cron-parser";
// cronstrue/i18n (no el entrypoint default, que es solo inglés) trae los locales → 'es'.
import cronstrue from "cronstrue/i18n";
import { decryptToken, encryptToken } from "./crypto.ts";
import { NOTES_INDEX_SCHEMA } from "./notes-index.ts";
import { ensureNotesVersionColumn, NOTES_WRITE_SCHEMA } from "./notes-write.ts";

export type Db = Database.Database;

/** Entorno lógico. `CEIBO_ENV` selecciona el set coherente de recursos (DB, sockets,
 * puertos). Ausente o inválido = `prod` (invariante: prod se comporta como siempre). */
export type CeiboEnv = "dev" | "staging" | "prod";
export function ceiboEnv(): CeiboEnv {
  const v = process.env.CEIBO_ENV;
  return v === "dev" || v === "staging" || v === "prod" ? v : "prod";
}

/** Ruta del archivo SQLite. CEIBO_DB_PATH la overridea (la box la fija). Sin override,
 * deriva por entorno: prod → ceibo.db (sin cambio); dev/staging → ceibo.<env>.db. */
export function defaultDbPath(): string {
  if (process.env.CEIBO_DB_PATH) return process.env.CEIBO_DB_PATH;
  const name = ceiboEnv() === "prod" ? "ceibo.db" : `ceibo.${ceiboEnv()}.db`;
  return fileURLToPath(new URL(`../data/${name}`, import.meta.url));
}

/** Path de un socket unix al lado de la DB, con nombre namespaceado por entorno para que
 * dev/staging/prod no colisionen en la misma máquina: prod → `<base>.sock`;
 * dev/staging → `<base>.<env>.sock`. */
export function sockPath(base: string): string {
  const name = ceiboEnv() === "prod" ? `${base}.sock` : `${base}.${ceiboEnv()}.sock`;
  return join(dirname(defaultDbPath()), name);
}

// Stores de wacli (Fase 9). El `--store <dir>` ES la frontera de tenant de WhatsApp:
// cada dir = DB + sesión whatsmeow + lock aislados, uno por usuario bajo
// WACLI_STORE_ROOT. Estado propio de wacli en disco (NO es nuestra DB). Compartido
// entre el MCP de lectura (en @ceibo/mcps) y el follow/pairing (en el gateway).

/** Raíz de los stores de wacli por usuario. La box la fija; default razonable para dev. */
export function wacliStoreRoot(): string {
  return resolve(process.env.WACLI_STORE_ROOT ?? join(homedir(), ".wacli-ceibo"));
}

/** Directorio de store de wacli de un usuario: <root>/<userId>. Determinístico. */
export function wacliStoreDirForUser(userId: number): string {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error(`userId inválido: ${userId}`);
  return join(wacliStoreRoot(), String(userId));
}

/**
 * Directorio de store del **bot de ceibo** (el número propio del canal WhatsApp), separado
 * de los stores per-usuario (`<root>/<userId>`, siempre numéricos → no colisiona con `_bot`).
 * Es el número que la gente le escribe a ceibo, no el WhatsApp que un usuario conecta para
 * que el agente lo lea. WHATSAPP_BOT_STORE lo overridea (la box lo fija).
 */
export function wacliBotStoreDir(): string {
  return resolve(process.env.WHATSAPP_BOT_STORE ?? join(wacliStoreRoot(), "_bot"));
}

/**
 * Material de un adjunto de WhatsApp, leído DIRECTO de la `wacli.db` en modo
 * **read-only**. A diferencia de `wacli media download` (comando de escritura que toma
 * el lock exclusivo del store, el mismo que retiene el `sync --follow` del gateway), esto
 * sólo lee la SQLite: no toma el lock ni abre un socket de WhatsApp, así que corre
 * concurrente con el follow. El caller baja el blob del CDN (`direct_path`) y lo
 * desencripta con `media_key` (esquema whatsmeow). `media_key`/sha256 son BLOB → Buffer.
 */
export interface WacliMediaInfo {
  mediaType: string; // "image" | "audio" | "ptt" | "video" | "document" | "sticker" | …
  mimeType: string;
  filename: string;
  caption: string;
  directPath: string; // path firmado del CDN (sin host); "" si no hay
  mediaKey: Buffer | null;
  fileEncSha256: Buffer | null;
  fileSha256: Buffer | null;
  fileLength: number | null;
  localPath: string; // si wacli ya lo bajó a disco → fast-path, sin red
}

/**
 * Lee el material de un adjunto desde la `wacli.db` de un store **arbitrario** (read-only).
 * El canal del bot (`wacliBotStoreDir()`) y el MCP per-usuario (`wacliStoreDirForUser`)
 * comparten esta lectura — sólo cambia el `storeDir`.
 */
const MEDIA_COLS =
  "SELECT media_type, mime_type, filename, media_caption, direct_path, media_key, " +
  "file_enc_sha256, file_sha256, file_length, local_path FROM messages ";

function mapMediaRow(row: Record<string, unknown> | undefined): WacliMediaInfo | undefined {
  if (!row) return undefined;
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  const buf = (v: unknown): Buffer | null => (Buffer.isBuffer(v) ? v : null);
  return {
    mediaType: s(row.media_type),
    mimeType: s(row.mime_type),
    filename: s(row.filename),
    caption: s(row.media_caption),
    directPath: s(row.direct_path),
    mediaKey: buf(row.media_key),
    fileEncSha256: buf(row.file_enc_sha256),
    fileSha256: buf(row.file_sha256),
    fileLength: typeof row.file_length === "number" ? row.file_length : null,
    localPath: s(row.local_path),
  };
}

/** Abre la `wacli.db` de un store en read-only y corre `fn`, o undefined si no existe. */
function withWacliDb<T>(storeDir: string, fn: (db: Database.Database) => T): T | undefined {
  const dbPath = join(storeDir, "wacli.db");
  if (!existsSync(dbPath)) return undefined;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 4000"); // tolera un write en curso del follow
    return fn(db);
  } finally {
    db.close();
  }
}

export function readWacliMediaInfoAt(
  storeDir: string,
  chatJid: string,
  msgId: string,
): WacliMediaInfo | undefined {
  return withWacliDb(storeDir, (db) =>
    mapMediaRow(
      db.prepare(`${MEDIA_COLS}WHERE chat_jid = ? AND msg_id = ?`).get(chatJid, msgId) as
        | Record<string, unknown>
        | undefined,
    ),
  );
}

/**
 * Igual que `readWacliMediaInfoAt` pero ubica la fila **sólo por `msg_id`** (stanza id de
 * WhatsApp, único en la tabla). Lo necesita el canal del bot: el webhook entrega el chat como
 * **LID anónimo** (`<id>@lid`), mientras la `wacli.db` indexa por el phone JID — el `chat_jid`
 * no matchea, pero el `msg_id` sí. Ver memory `whatsapp-owner-lid`.
 */
export function readWacliMediaInfoByMsgId(storeDir: string, msgId: string): WacliMediaInfo | undefined {
  return withWacliDb(storeDir, (db) =>
    mapMediaRow(
      db.prepare(`${MEDIA_COLS}WHERE msg_id = ? LIMIT 1`).get(msgId) as Record<string, unknown> | undefined,
    ),
  );
}

/** Variante per-usuario: resuelve el store por userId. Wrapper sobre `readWacliMediaInfoAt`. */
export function readWacliMediaInfo(
  userId: number,
  chatJid: string,
  msgId: string,
): WacliMediaInfo | undefined {
  return readWacliMediaInfoAt(wacliStoreDirForUser(userId), chatJid, msgId);
}

// --- Bajada + descifrado de media de WhatsApp ----------------------------
// Compartido por el MCP de lectura (per-usuario) y el canal del bot. Trae los BYTES de un
// adjunto SIN tomar el lock del store ni abrir socket de WhatsApp: fast-path si wacli ya lo
// bajó a disco (`--download-media` → `localPath`), si no GET del CDN + descifrado.

// Host del CDN de media de WhatsApp (override por env por las dudas).
const WA_MEDIA_HOST = process.env.WACLI_MEDIA_HOST ?? "mmg.whatsapp.net";
// Bajar el blob pega al CDN de WhatsApp por HTTPS: más lento que leer el SQLite.
const WA_MEDIA_TIMEOUT_MS = Number(process.env.WACLI_MEDIA_TIMEOUT_MS ?? 90_000);

// Info-string de HKDF por tipo de media (esquema de whatsmeow). Los stickers usan las
// keys de imagen. El audio y las notas de voz (ptt) comparten las de audio.
const HKDF_INFO: Record<string, string> = {
  image: "WhatsApp Image Keys",
  sticker: "WhatsApp Image Keys",
  video: "WhatsApp Video Keys",
  audio: "WhatsApp Audio Keys",
  ptt: "WhatsApp Audio Keys",
  document: "WhatsApp Document Keys",
};

/**
 * Desencripta un blob de media de WhatsApp (esquema whatsmeow): HKDF-SHA256(mediaKey,
 * salt=32×0, info=`<Tipo> Keys`, 112B) → [iv|cipherKey|macKey|ref]; el archivo es
 * `ciphertext || mac(10B)`; valida HMAC-SHA256(macKey, iv||ciphertext)[:10] y descifra
 * AES-256-CBC. Devuelve el plaintext (ej. OGG/Opus de una nota de voz).
 */
export function decryptWacliMedia(enc: Buffer, mediaKey: Buffer, mediaType: string): Buffer {
  const info = HKDF_INFO[mediaType];
  if (!info) throw new Error(`no sé desencriptar media de tipo "${mediaType}"`);
  if (enc.length <= 10) throw new Error("blob de media demasiado corto");
  const exp = Buffer.from(hkdfSync("sha256", mediaKey, Buffer.alloc(32), Buffer.from(info), 112));
  const iv = exp.subarray(0, 16);
  const cipherKey = exp.subarray(16, 48);
  const macKey = exp.subarray(48, 80);
  const ciphertext = enc.subarray(0, enc.length - 10);
  const mac = enc.subarray(enc.length - 10);
  const expectMac = createHmac("sha256", macKey).update(iv).update(ciphertext).digest().subarray(0, 10);
  if (mac.length !== expectMac.length || !timingSafeEqual(mac, expectMac)) {
    throw new Error("falló la validación HMAC del adjunto (blob corrupto o media_key inválida)");
  }
  const decipher = createDecipheriv("aes-256-cbc", cipherKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Trae los BYTES de un adjunto: fast-path `localPath`, si no GET del CDN + `decryptWacliMedia`.
 * El caller ya validó que `info` tiene media (`info.mediaType`).
 */
export async function fetchWacliMediaBytes(info: WacliMediaInfo): Promise<Buffer> {
  if (info.localPath && existsSync(info.localPath)) return readFile(info.localPath);
  if (!info.directPath || !info.mediaKey) {
    throw new Error(
      "no tengo los datos para bajar este adjunto (sin direct_path/media_key; el link pudo expirar)",
    );
  }
  // `directPath` viene del protobuf del mensaje (lo controla el remitente) → NO lo
  // concatenamos crudo: lo resolvemos relativo al host del CDN y exigimos que el host
  // resultante siga siendo el del CDN. Así un `directPath` tipo `@evil.com/x` o
  // `.evil.com/x` (que reescribiría el authority) no nos manda a otro host (SSRF).
  // `redirect: "error"` cierra el SSRF vía redirect del CDN: el blob se sirve directo.
  let mediaUrl: URL;
  try {
    mediaUrl = new URL(info.directPath, `https://${WA_MEDIA_HOST}`);
  } catch {
    throw new Error("el adjunto tiene un direct_path inválido");
  }
  if (mediaUrl.protocol !== "https:" || mediaUrl.host !== WA_MEDIA_HOST) {
    throw new Error("el direct_path del adjunto apunta fuera del CDN de WhatsApp");
  }
  const res = await fetch(mediaUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(WA_MEDIA_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`el CDN de WhatsApp devolvió HTTP ${res.status} (el link del adjunto pudo expirar)`);
  }
  return decryptWacliMedia(Buffer.from(await res.arrayBuffer()), info.mediaKey, info.mediaType);
}

// --- Pricing -------------------------------------------------------------
// Precios públicos de Anthropic en USD por millón de tokens (MTok). El ledger
// guarda tokens crudos (la verdad); cost_usd es derivado y se multiplica por
// CEIBO_BILLING_MARKUP (default 1.0) para tener un número facturable ya.
interface ModelPrice {
  input: number; // por MTok
  output: number;
  cache5m: number; // escritura de cache efímera 5min
  cache1h: number; // escritura de cache efímera 1h
  cacheRead: number; // lectura de cache
}

const MTOK = 1_000_000;

// Keyed por model id. Haiku 4.5 es el modelo de Fase 1/2; los otros están para
// que el reporte siga andando si cambiamos de modelo.
const PRICES: Record<string, ModelPrice> = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cache5m: 1.25, cache1h: 2, cacheRead: 0.1 },
  "claude-haiku-4-5": { input: 1, output: 5, cache5m: 1.25, cache1h: 2, cacheRead: 0.1 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache5m: 3.75, cache1h: 6, cacheRead: 0.3 },
  "claude-opus-4-7": { input: 15, output: 75, cache5m: 18.75, cache1h: 30, cacheRead: 1.5 },
};

const FALLBACK_PRICE: ModelPrice = PRICES["claude-haiku-4-5-20251001"] as ModelPrice;

export const MARKUP = Number(process.env.CEIBO_BILLING_MARKUP ?? "1") || 1;

// Familias de inferencia LOCAL (archima, infra propia). La fuente de verdad del roster local es
// `LOCAL_MODELS` en @ceibo/gateway
// (models.ts), pero store es hoja (gateway depende de store, no al revés) y no puede
// importarlo; espejamos acá las FAMILIAS — no ids exactos. El id que se graba para un turno local es el modelID
// de opencode (ej. `gemma4-31b`), sin prefijo de provider; `local/` cubre el caso defensivo
// en que llegara provider-qualified. Los modelos de Anthropic (MA) son todos `claude-*` y
// NO matchean → siguen pagando su tarifa (o el fallback si el id driftó).
const LOCAL_MODEL_PREFIXES = ["gemma", "qwen", "local/"];

/** ¿El turno corrió en inferencia LOCAL (archima)? Esos modelos viven en infra propia y NO
 *  se facturan con tarifa de Anthropic → costo 0. Reconoce las familias del roster local. */
export function isLocalModel(model: string): boolean {
  const m = model.toLowerCase();
  return LOCAL_MODEL_PREFIXES.some((p) => m.startsWith(p));
}

export interface TurnTokens {
  input: number;
  output: number;
  cache5m: number;
  cache1h: number;
  cacheRead: number;
}

/** Costo en USD (ya con markup) de un turno, según el modelo. Los modelos locales (archima)
 *  no pagan tarifa de Anthropic → 0; el resto se cobra por su precio (o el fallback). */
export function costOf(model: string, t: TurnTokens): number {
  if (isLocalModel(model)) return 0; // infra propia: no se factura tarifa Anthropic
  const p = PRICES[model] ?? FALLBACK_PRICE;
  const usd =
    (t.input * p.input +
      t.output * p.output +
      t.cache5m * p.cache5m +
      t.cache1h * p.cache1h +
      t.cacheRead * p.cacheRead) /
    MTOK;
  return usd * MARKUP;
}

// --- Schema --------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL UNIQUE,   -- identificador humano (slug). Lo que se usa en la CLI.
  name TEXT,                     -- nombre para mostrar, opcional
  location TEXT,                 -- ubicación del usuario (texto libre, ej. "Buenos Aires, Argentina"), opcional. La inyecta el gateway en el contexto del agente si está seteada
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  anthropic_api_key TEXT,
  vault_id TEXT,                 -- vault MA del usuario (cred del GitHub MCP). Lazy. Sólo backend 'ma'.
  local_vault_id TEXT,           -- vault del agent-vault LOCAL (backend 'local'/archima). Lazy, IDs propios (UUID/slug). Independiente de vault_id → cada backend su vault.
  voice_reply TEXT NOT NULL DEFAULT 'auto', -- DEPRECADO (Fase 10): el modo voz/texto lo decide el agente, no el bridge
  lang TEXT NOT NULL DEFAULT 'es', -- idioma del usuario (Fase 15): 'es'|'en'. Afecta el prompt (tag por turno) y qué voces muestra /voice
  model TEXT,                    -- modelo de chat elegido (/model): clave estable (haiku|sonnet|opus). NULL = default. Resuelve a qué agente coordinador apunta la sesión
  active_wiki TEXT,              -- wiki en foco (Fase 16, /wiki set): NULL = todas montadas (default); si no, el chat monta sólo ésa
  backend_mode TEXT NOT NULL DEFAULT 'ma' CHECK (backend_mode IN ('ma','local')), -- backend de sesión por usuario (archima): 'ma' = Managed Agents de Anthropic (default), 'local' = archima en infra propia. Hoy sólo 'ma' está cableado
  timezone TEXT NOT NULL DEFAULT 'UTC', -- timezone IANA del usuario (quickboot/sessions): el clear diario de sesión corre a las 4am de esta tz. Default 'UTC'; los usuarios actuales se backfillean a GMT-3 en la migración
  default_profile TEXT,             -- multi-cuenta (Fase 7): perfil a usar cuando no se especifica uno
  tts_voice TEXT,                -- voz edge-tts (NULL = DEFAULT_VOICE de @ceibo/speech)
  tts_rate TEXT,                 -- prosodia edge-tts: rate (ej. +10%), NULL = default
  tts_pitch TEXT,                -- pitch (ej. -5Hz), NULL = default
  tts_volume TEXT,               -- volume (ej. +10%), NULL = default
  debug_mode INTEGER NOT NULL DEFAULT 0, -- modo debug (/debug): 1 = el canal muestra los tool-calls del agente en vivo; 0 = off (default)
  admin INTEGER NOT NULL DEFAULT 0,   -- flag admin (invitaciones P1): 1 = el usuario puede gestionar la waitlist + ve la system-page de admin
  avatar_blob BLOB,              -- foto de perfil (edición web): bytes de la imagen, NULL = sin avatar
  avatar_mime TEXT,              -- mime del avatar (image/png|jpeg|webp), NULL = sin avatar
  bg_queries TEXT,               -- queries del fondo Unsplash (cog de settings): JSON array de strings. NULL = default de la app
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channel_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel, external_id)
);

-- Allowlist de registración (invite-only): los emails autorizados a auto-crear cuenta al
-- entrar con Google. El gate de autorización: sólo un email acá puede dar de alta un usuario
-- nuevo (ver registerGoogleUserIfAuthorized). La gestiona el admin por CLI (ceibo allow ...).
-- name/handle son seeds opcionales para el alta (si faltan se derivan del email). used_at se
-- setea cuando ya se creó la cuenta desde este entry (auditoría; no re-bloquea el login).
CREATE TABLE IF NOT EXISTS authorized_emails (
  email      TEXT PRIMARY KEY,   -- lowercased
  name       TEXT,               -- nombre de pila para sembrar (opcional)
  handle     TEXT,               -- handle preferido (opcional; si no, se deriva del email)
  note       TEXT,               -- anotación de admin, ej. "vecina María" (opcional)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at    TEXT                -- timestamp del alta efectiva desde este entry (NULL = sin usar)
);

-- Una wiki = un repo git en la org. full_name = org/name. El acceso es N:N:
-- un repo puede ser compartido por varios usuarios (repo_access).
-- deleted_at: soft-delete global (setea el dueño; borrada para TODOS).
-- personal: 1 = wiki personal del usuario (no borrable / no archivable). Setea
--   provisionPersonalWiki y la migración one-shot al abrir la DB.
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  personal INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org, name)
);

-- role: 'owner' | 'member'. El dueño es el creador original; backfill one-shot al abrir
-- la DB congela el owner actual (grant activo más viejo, mismo criterio que firstUserForRepo).
-- archived_at: archivado per-usuario (sale del contexto del agente sólo para ése).
CREATE TABLE IF NOT EXISTS repo_access (
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo_id, user_id)
);

-- Invitaciones por email a wikis (gente sin cuenta todavía). Se materializa en grant
-- al alta/login del email (acceptInvitesForEmail). Idempotente: PK (repo_id, email).
CREATE TABLE IF NOT EXISTS wiki_invites (
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,           -- lowercased
  invited_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT,                    -- set cuando se materializó el grant
  PRIMARY KEY (repo_id, email)
);

-- Watermark de REM por wiki (Fase 16, incremental). last_sha = commit hasta el que REM
-- ya consolidó esa wiki; la próxima corrida mira sólo lo nuevo (git log last_sha..HEAD).
-- Por repo (no por usuario): es estado de la WIKI — si es compartida, vale para todos.
CREATE TABLE IF NOT EXISTS rem_watermarks (
  repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  last_sha TEXT NOT NULL,
  ran_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Una sesión MA activa por usuario + último snapshot del usage acumulado de esa
-- sesión, para computar el costo de cada turno por diferencia.
CREATE TABLE IF NOT EXISTS sessions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  last_input INTEGER NOT NULL DEFAULT 0,
  last_output INTEGER NOT NULL DEFAULT 0,
  last_cache_5m INTEGER NOT NULL DEFAULT 0,
  last_cache_1h INTEGER NOT NULL DEFAULT 0,
  last_cache_read INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ledger: un row por turno completado. Fuente de verdad para facturar.
CREATE TABLE IF NOT EXISTS usage_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_1h_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_turns (user_id);

-- Token de enrollment de OAuth: link de UN SOLO USO que ata el flujo a un usuario.
-- El usuario abre el link, aprueba en Google, y el servicio de enrollment escribe
-- la credencial mcp_oauth en SU vault. Sin esto, cualquiera podría linkear su
-- propia cuenta Google al vault de otro (confused-deputy). El service (gmail, …)
-- lo resuelve @ceibo/enroll a scopes + MCP URL.
CREATE TABLE IF NOT EXISTS enroll_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT 'default',  -- multi-cuenta (Fase 7): qué perfil del servicio
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT
);

-- Tokens de login web (managed-ui Fase A): magic link de UN SOLO USO que el bot manda
-- (/web -> https://<box>/<handle>?t=<token>). Misma idea que enroll_tokens pero sin
-- service/profile: solo identifica al usuario. TTL corto; se quema al canjearlo por la
-- cookie de sesion. Telegram ya es la raiz de identidad, esto no la amplia.
CREATE TABLE IF NOT EXISTS web_login_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT
);

-- Contraseña de login web (email + password, allowlist). El email vive como identidad
-- de canal \`email\` (allowlist, igual que \`google\`); ESTO es solo el verificador. Un row
-- por usuario, seteado por el admin (\`ceibo user passwd <handle>\`). Hash scrypt con salt
-- embebido (formato \`scrypt$N$r$p$salt$hash\`): sin secreto de servidor, el robo de la DB
-- no permite forjar passwords, solo crackear por fuerza bruta (scrypt es deliberadamente lento).
CREATE TABLE IF NOT EXISTS web_passwords (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  set_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Servicios que un usuario tiene conectados (lo escribe el servicio oauth al
-- completar un enroll). Vista barata para /connections; la verdad de auth sigue
-- siendo la credencial en el vault (puede driftar si se revoca — el agente avisa).
CREATE TABLE IF NOT EXISTS connections (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT 'default',  -- multi-cuenta (Fase 7)
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, service, profile)
);

-- Grants OAuth que maneja NUESTRO broker (Fase 6: oauth = broker de refresh).
-- Acá viven el refresh_token + el access_token vigente, EN NUESTRA INFRA (la box),
-- nunca en el vault de Anthropic. El broker refresca el access_token con el
-- refresh_token (+ el client_secret del provider, que está en el .env de la box) y
-- al vault solo le pushea un static_bearer corto. refresh_token NULL = provider sin
-- refresh (Notion: el token no expira, no hay nada que refrescar).
-- A3: refresh_token/access_token se guardan CIFRADOS (AES-256-GCM, ver crypto.ts); la
-- nulabilidad y expires_at quedan en claro (los usa el filtro de refresh lazy).
CREATE TABLE IF NOT EXISTS oauth_grants (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT 'default',  -- multi-cuenta (Fase 7): "work", "personal", … ("default" = cuenta única)
  provider TEXT NOT NULL,
  mcp_url TEXT NOT NULL,            -- perfil default = URL pelada; extra = …?profile=<perfil> (key del vault)
  display_name TEXT NOT NULL,
  account TEXT,                     -- cuenta externa real (ej. user@example.com / workspace de Notion); NULL = desconocida/no aplica
  broken_at TEXT,                   -- ISO; NULL = sano. Se setea cuando el refresh muere con invalid_grant (Google expira los refresh tokens ~cada 7 días en modo Testing). Estado para UI/lógica: el grant está roto. Se limpia al reconectar (grant fresco) o si un refresh vuelve a andar.
  notified_at TEXT,                 -- ISO; NULL = todavía no avisamos con éxito. Sella cuándo se ENTREGÓ la notif de rotura (item durable en el 🔔). Anti-spam mira ESTO (no broken_at): mientras broken_at set y notified_at NULL, reintentamos entregar cada sweep; recién al entregar bien se sella. Se limpia junto con broken_at al reconectar.
  refresh_token TEXT,
  access_token TEXT NOT NULL,
  expires_at TEXT,                 -- ISO; NULL = no expira
  scope TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, service, profile)
);

-- Crons / recordatorios (Fase 8). El agente los agenda llamando al MCP \`schedule\`
-- (lado set); un scheduler propio en el gateway dispara al vencer (lado fire):
-- inyecta \`what\` como prompt sintético en la sesión del usuario y empuja el output
-- a su canal. \`what\` lo redacta el agente (lenguaje natural, nota a su yo futuro).
--   report  = qué hace el fire-side con el output del turno: 'always' postea a
--             Telegram, 'never' lo traga (housekeeping; sólo error sale), 'conditional'
--             postea salvo centinela (fast-follow).
--   kind     = 'once' (disparo absoluto, se marca done) | 'recur' (recomputa next_fire).
--   recur_expr = expresión de recurrencia si kind='recur'; NULL si 'once'.
--   next_fire = ISO UTC del próximo disparo (índice de barrido del scheduler).
CREATE TABLE IF NOT EXISTS crons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,         -- canal de egress (ej. 'telegram')
  title TEXT,                    -- título corto para el listado (nullable; fallback al what)
  what TEXT NOT NULL,
  report TEXT NOT NULL DEFAULT 'always' CHECK (report IN ('always','never','conditional')),
  kind TEXT NOT NULL CHECK (kind IN ('once','recur')),
  recur_expr TEXT,
  tz TEXT NOT NULL DEFAULT 'UTC',
  next_fire TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_fired_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_crons_due ON crons (status, next_fire);

-- Change feed del substrato de wikis (plan substrato-wikis-working-copy.md). Cada commit
-- a una wiki registra una fila acá; las vistas (web) tailean por id (cursor monotonico)
-- desde su ultimo visto y refrescan. Cruza procesos via SQLite WAL (mismo patron que crons).
CREATE TABLE IF NOT EXISTS wiki_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  ref TEXT NOT NULL,             -- commit sha resultante
  paths TEXT NOT NULL,           -- JSON array de los paths tocados (compat: lo leen el feedPoll web)
  entries TEXT,                  -- JSON Array<{path, op}> (op por-path); NULL en filas legacy
  source TEXT,                   -- quién originó: 'web' | 'agent' | 'rem'; NULL legacy
  user_id INTEGER,               -- usuario que originó (web: el editor; agente: dueño de la sesión); NULL legacy
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wiki_changes_repo ON wiki_changes (repo, id);

-- Fuente de cada commit de wiki: copia SLIM y PERMANENTE de (repo, ref) → source/user.
-- wiki_changes (el feed) se poda a 7 días; esto NO se poda: el blame por línea de la web
-- necesita resolver shas viejos para distinguir ediciones humanas ('web') de las del
-- agente ('agent'/'rem') en wikis personales. Se alimenta en cada recordWikiChange /
-- recordWikiEdit con source; shas anteriores al registro quedan sin fila (= desconocido).
CREATE TABLE IF NOT EXISTS wiki_commit_sources (
  repo TEXT NOT NULL,
  ref TEXT NOT NULL,             -- commit sha
  source TEXT NOT NULL,          -- 'web' | 'agent' | 'rem'
  user_id INTEGER,               -- quién originó (NULL si no se sabe)
  at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo, ref)
);

-- Hasta qué ref tiene sincronizada cada usuario su working copy LOCAL de una wiki
-- (Fase 2c — detección de deriva). Lo escribe el endpoint de sync (web-server) con el
-- ref REAL servido en cada hydrate/pull/push de ese user. El gateway lo compara contra
-- el HEAD del substrato antes de cada turno: si el HEAD avanzó (alguien editó por la web,
-- el editor local o REM), le ordena al agente refrescar ANTES de leer/editar. Por
-- (usuario, repo): la working copy vive en el sandbox de la sesión, que es 1:1 con el user.
CREATE TABLE IF NOT EXISTS wiki_sync_watermarks (
  user_id INTEGER NOT NULL,
  repo TEXT NOT NULL,            -- nombre del repo (lo que fluye por sync + tag [wikis])
  ref TEXT NOT NULL,            -- último commit sha al que el user sincronizó su copia local
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, repo)
);

-- Último HEAD conocido del substrato por wiki (Fase 2c — watcher único). Lo mantiene UN solo
-- watcher (web-server) que pollea GitHub + las escrituras que pasan por el server (commit/save).
-- Dos consumidores leen de acá SIN pollear: (1) el change-feed de la web refresca las pestañas
-- cuando el watcher detecta un HEAD nuevo out-of-band (git push); (2) el gateway compara este
-- HEAD contra el watermark del usuario para la directiva de deriva (en vez de pegarle a GitHub
-- por turno). Una sola fuente de polling, dos consumidores.
CREATE TABLE IF NOT EXISTS wiki_heads (
  repo TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Anuncios de la empresa a todos los usuarios (broadcast). A diferencia de \`crons\`,
-- el broadcast es inmediato y literal: el gateway postea el MISMO \`text\` tal cual a
-- cada destinatario por Telegram (sin pasar por el agente). Esta tabla es sólo el
-- registro de auditoría — qué se mandó, cuándo, y a cuántos llegó / falló. El envío
-- lo hace el gateway (es quien tiene el bot token) y graba la fila al terminar.
CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,    -- destinatarios alcanzados OK
  failed_count INTEGER NOT NULL DEFAULT 0,  -- destinatarios que fallaron
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Inbox del agente (feature crons-delivery): bandeja durable y GENÉRICA de cosas que el
-- agente le dejó al usuario para la web. Nace para los crons creados en web (que sin esto se
-- pierden offline, ver channels/src/remote.ts), pero \`kind\` la deja abierta a REM/sistema/viewer.
-- Aditiva (tabla nueva, sin ALTER). \`source_id\` ata al origen (ej. el cron.id); nullable porque
-- no todos los kinds tienen uno. \`read_at\` NULL = no leído (el badge cuenta esos).
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cron','rem','system','viewer')),
  source_id INTEGER,             -- id del origen (ej. cron.id); NULL si no aplica
  title TEXT NOT NULL,           -- etiqueta corta para el listado del panel
  body TEXT NOT NULL,            -- el texto que se re-inyecta como burbuja al clickear
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT                   -- NULL = no leído (lo que cuenta el badge)
);
CREATE INDEX IF NOT EXISTS idx_inbox_user_unread ON inbox (user_id, read_at);

-- Cola de admisión al sistema (invitaciones + waitlist; decisiones #2/#4/#5 del spec).
-- Una fila por persona (email PK). Aprobar = INSERT en authorized_emails (el gate
-- real, register*IfAuthorized, no se toca). La fila queda como auditoría.
CREATE TABLE IF NOT EXISTS waiting_list (
  email       TEXT PRIMARY KEY,             -- lowercased
  source      TEXT NOT NULL CHECK (source IN ('invited','self-signup')),
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','rejected')),
  invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- NULL si self-signup
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,                          -- cuándo decidió el admin
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
`;

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  db.exec(NOTES_INDEX_SCHEMA); // índice derivado de notas (feature db F1) — tablas aditivas
  db.exec(NOTES_WRITE_SCHEMA); // escritura versionada + historial (feature db F3) — aditivo
  ensureNotesVersionColumn(db);
  migrate(db);
  pruneEnrollTokens(db); // housekeeping: limpia tokens usados/vencidos al arrancar
  pruneWikiChanges(db); // housekeeping: acota el change feed (lo viejo ya nadie lo tailea)
  return db;
}

/** Borra tokens de enrollment ya usados o vencidos (no acota nada vivo: peek filtra
 *  igual por used/TTL). Evita que la tabla crezca sin bound. */
export function pruneEnrollTokens(db: Db): void {
  db.prepare(
    "DELETE FROM enroll_tokens WHERE used_at IS NOT NULL OR created_at < datetime('now', '-1 day')",
  ).run();
  db.prepare(
    "DELETE FROM web_login_tokens WHERE used_at IS NOT NULL OR created_at < datetime('now', '-1 day')",
  ).run();
}

// ── Change feed del substrato de wikis (Fase 1b) ───────────────────────────────
// Cada commit a una wiki registra una fila; las vistas tailean por `id` desde su último
// cursor y refrescan. Es writer-agnostic: lo escribe el caller de wikis.commit() tras
// éxito (agente o web), y cualquier subscriptor lo ve, sin importar quién lo originó.

/** Tipo de operación de un cambio, por-path. Lo usa el reporte de cambios en el chat para
 *  conjugar el verbo (creaste/editaste/borraste/…). `move` = renombrar/mover (la nota nueva). */
export type WikiChangeOp = "create" | "edit" | "delete" | "archive" | "move";

/** Quién originó el cambio. 'web' = el usuario desde el editor web; 'agent' = el agente (chat o
 *  REM, que commitea por el mismo /api/sync); 'rem' = REM explícito (reservado). NULL = legacy. */
export type WikiChangeSource = "web" | "agent" | "rem";

export interface WikiChangeEntry {
  path: string;
  op: WikiChangeOp;
}

export interface WikiChange {
  id: number;
  repo: string;
  ref: string; // commit sha resultante
  paths: string[]; // paths tocados en ese commit (compat)
  entries: WikiChangeEntry[]; // op por-path (legacy → todo 'edit')
  source: WikiChangeSource | null; // quién lo originó (NULL legacy)
  userId: number | null; // usuario que lo originó (NULL legacy)
  at: string;
}

interface WikiChangeRow {
  id: number;
  repo: string;
  ref: string;
  paths: string;
  entries: string | null;
  source: string | null;
  user_id: number | null;
  at: string;
}

const toWikiChange = (r: WikiChangeRow): WikiChange => {
  const paths = JSON.parse(r.paths) as string[];
  // Filas legacy (sin `entries`): asumimos op 'edit' por path (no sabemos el tipo real).
  const entries = r.entries
    ? (JSON.parse(r.entries) as WikiChangeEntry[])
    : paths.map((p) => ({ path: p, op: "edit" as WikiChangeOp }));
  return {
    id: r.id,
    repo: r.repo,
    ref: r.ref,
    paths,
    entries,
    source: (r.source as WikiChangeSource | null) ?? null,
    userId: r.user_id ?? null,
    at: r.at,
  };
};

/** Registra un cambio commiteado a una wiki. Devuelve el `id` (cursor monotónico). Lo llama
 *  el caller de `wikis.commit()` tras un commit exitoso (gateway/web), no el substrato — así
 *  `@ceibo/wikis` no se acopla a la DB. Acepta `entries` (op por-path) o `paths` (legacy: op
 *  'edit'). `source`/`userId` alimentan el reporte de cambios en el chat (quién y cómo). */
export function recordWikiChange(
  db: Db,
  c: {
    repo: string;
    ref: string;
    paths?: string[];
    entries?: WikiChangeEntry[];
    source?: WikiChangeSource;
    userId?: number;
  },
): number {
  const entries = c.entries ?? (c.paths ?? []).map((p) => ({ path: p, op: "edit" as WikiChangeOp }));
  const paths = entries.map((e) => e.path);
  const info = db
    .prepare(
      "INSERT INTO wiki_changes (repo, ref, paths, entries, source, user_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(c.repo, c.ref, JSON.stringify(paths), JSON.stringify(entries), c.source ?? null, c.userId ?? null);
  if (c.source) recordWikiCommitSource(db, c.repo, c.ref, c.source, c.userId);
  return Number(info.lastInsertRowid);
}

/** Registra (repo, ref) → source en la tabla permanente que consume el blame. Idempotente
 *  (INSERT OR IGNORE: el primer registro de un sha gana). Interna a record*, pero exportada
 *  para tests. */
export function recordWikiCommitSource(
  db: Db,
  repo: string,
  ref: string,
  source: WikiChangeSource,
  userId?: number,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO wiki_commit_sources (repo, ref, source, user_id) VALUES (?, ?, ?, ?)",
  ).run(repo, ref, source, userId ?? null);
}

/** source de cada sha en `refs` para una wiki (los shas sin registro no aparecen en el Map:
 *  son anteriores al feed = origen desconocido). Lo consume /api/file/blame para distinguir
 *  ediciones humanas ('web') de las del agente ('agent'/'rem') por rango. */
export function wikiCommitSources(db: Db, repo: string, refs: string[]): Map<string, WikiChangeSource> {
  const out = new Map<string, WikiChangeSource>();
  if (refs.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT ref, source FROM wiki_commit_sources WHERE repo = ? AND ref IN (${refs.map(() => "?").join(",")})`,
    )
    .all(repo, ...refs) as Array<{ ref: string; source: string }>;
  for (const r of rows) out.set(r.ref, r.source as WikiChangeSource);
  return out;
}

/** ¿La wiki tiene AL MENOS un commit con source registrado? Gate del blame en wikis
 *  personales: sin registro no hay distinción humano/IA que mostrar (todo sería gris). */
export function repoHasCommitSources(db: Db, repo: string): boolean {
  return db.prepare("SELECT 1 FROM wiki_commit_sources WHERE repo = ? LIMIT 1").get(repo) !== undefined;
}

/** Ventana de coalescing de ediciones (segundos). Una edición web sobre la misma nota, del
 *  mismo usuario, dentro de esta ventana, ACTUALIZA la fila previa en vez de insertar una nueva
 *  — así el autosave frecuente del editor no inunda el feed ni el reporte de chat. */
export const WIKI_EDIT_COALESCE_SEC = 180;

/** Registra una edición de la web COALESCED: si ya hay una fila de edición reciente del mismo
 *  usuario sobre la MISMA única nota (dentro de `windowSec`), le actualiza `ref`/`at` en vez de
 *  insertar otra. Devuelve el `id` (el de la fila reusada o la nueva). El reporte de chat ve un
 *  solo "editaste X" por ráfaga de autosave en vez de uno por tecleo. */
export function recordWikiEdit(
  db: Db,
  c: {
    repo: string;
    ref: string;
    path: string;
    userId: number;
    source?: WikiChangeSource;
    windowSec?: number;
  },
): number {
  const source = c.source ?? "web";
  const windowSec = c.windowSec ?? WIKI_EDIT_COALESCE_SEC;
  const single = JSON.stringify([c.path]);
  const row = db
    .prepare(
      `SELECT id, entries FROM wiki_changes
       WHERE repo = ? AND user_id = ? AND source = ? AND paths = ?
         AND at > datetime('now', ?) ORDER BY id DESC LIMIT 1`,
    )
    .get(c.repo, c.userId, source, single, `-${windowSec} seconds`) as
    | { id: number; entries: string | null }
    | undefined;
  if (row?.entries) {
    const entries = JSON.parse(row.entries) as WikiChangeEntry[];
    if (entries.length === 1 && entries[0]?.op === "edit") {
      db.prepare("UPDATE wiki_changes SET ref = ?, at = datetime('now') WHERE id = ?").run(c.ref, row.id);
      // El feed coalescea (una fila por ráfaga) pero CADA autosave es un commit real con su
      // propio sha → registramos cada ref en la tabla de sources, que el blame mira por sha.
      recordWikiCommitSource(db, c.repo, c.ref, source, c.userId);
      return row.id;
    }
  }
  return recordWikiChange(db, {
    repo: c.repo,
    ref: c.ref,
    entries: [{ path: c.path, op: "edit" }],
    source,
    userId: c.userId,
  });
}

/** Cambios con `id` > `sinceId`, en orden ascendente; opcionalmente filtrados por `repos`.
 *  Los subscriptores (vistas) lo pollean desde su último cursor para refrescar. */
export function wikiChangesSince(db: Db, sinceId: number, repos?: string[]): WikiChange[] {
  const rows = repos?.length
    ? db
        .prepare(
          `SELECT * FROM wiki_changes WHERE id > ? AND repo IN (${repos.map(() => "?").join(",")}) ORDER BY id`,
        )
        .all(sinceId, ...repos)
    : db.prepare("SELECT * FROM wiki_changes WHERE id > ? ORDER BY id").all(sinceId);
  return (rows as WikiChangeRow[]).map(toWikiChange);
}

/** Id del último cambio (0 si no hay). Cursor inicial para un subscriptor que sólo quiere lo nuevo. */
export function latestWikiChangeId(db: Db): number {
  const row = db.prepare("SELECT MAX(id) AS max FROM wiki_changes").get() as { max: number | null };
  return row.max ?? 0;
}

/** Acota el feed: borra cambios de más de 7 días (lo viejo ya nadie lo tailea). */
export function pruneWikiChanges(db: Db): void {
  db.prepare("DELETE FROM wiki_changes WHERE at < datetime('now', '-7 days')").run();
}

/** Slug válido para un handle: minúsculas, dígitos, `-` y `_`. */
export function isValidHandle(s: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(s);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Migraciones idempotentes. Cada bloque se chequea solo (no asume el otro).
function migrate(db: Db): void {
  const hasCol = (table: string, col: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);

  // 1) users.handle (la box de Fase 2 tenía al owner sin handle). Backfill desde name.
  if (!hasCol("users", "handle")) {
    db.exec("ALTER TABLE users ADD COLUMN handle TEXT");
    const rows = db.prepare("SELECT id, name FROM users").all() as Array<{ id: number; name: string | null }>;
    const taken = new Set<string>();
    for (const r of rows) {
      let h = slugify(r.name ?? "") || `u${r.id}`;
      while (taken.has(h)) h = `${h}-${r.id}`;
      taken.add(h);
      db.prepare("UPDATE users SET handle = ? WHERE id = ?").run(h, r.id);
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users (handle)");
  }

  // 1b) users.vault_id (vault MA por usuario, agregado en Fase 3 escritura).
  if (!hasCol("users", "vault_id")) {
    db.exec("ALTER TABLE users ADD COLUMN vault_id TEXT");
  }

  // 2) repos: forma vieja 1:N (con user_id/url) → N:N (repos org/name + repo_access).
  // El feature nunca se usó → la tabla vieja está vacía; si no, abortamos.
  if (hasCol("repos", "user_id")) {
    const n = (db.prepare("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c;
    if (n > 0) throw new Error("migración repos: tabla vieja no vacía, requiere migración manual");
    db.exec("DROP TABLE repos");
    db.exec(SCHEMA); // recrea repos (forma nueva) + repo_access vía IF NOT EXISTS
  }

  // 3) Multi-cuenta (Fase 7): dimensión `profile` en oauth_grants/connections (entra a
  // la PK → hay que rebuildear la tabla) y en enroll_tokens (PK=token, basta ADD COLUMN).
  // Lo existente queda como perfil "default" (retro-compatible: misma URL pelada, misma
  // cred del vault). FK off durante el rebuild (renombrar/dropear con FK on es frágil).
  if (!hasCol("oauth_grants", "profile")) {
    db.pragma("foreign_keys = OFF");
    db.exec(`
      ALTER TABLE oauth_grants RENAME TO oauth_grants_old;
      CREATE TABLE oauth_grants (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        service TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT 'default',
        provider TEXT NOT NULL,
        mcp_url TEXT NOT NULL,
        display_name TEXT NOT NULL,
        refresh_token TEXT,
        access_token TEXT NOT NULL,
        expires_at TEXT,
        scope TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, service, profile)
      );
      INSERT INTO oauth_grants (user_id, service, profile, provider, mcp_url, display_name, refresh_token, access_token, expires_at, scope, updated_at)
        SELECT user_id, service, 'default', provider, mcp_url, display_name, refresh_token, access_token, expires_at, scope, updated_at FROM oauth_grants_old;
      DROP TABLE oauth_grants_old;
    `);
    db.pragma("foreign_keys = ON");
  }
  if (!hasCol("connections", "profile")) {
    db.pragma("foreign_keys = OFF");
    db.exec(`
      ALTER TABLE connections RENAME TO connections_old;
      CREATE TABLE connections (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        service TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT 'default',
        connected_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, service, profile)
      );
      INSERT INTO connections (user_id, service, profile, connected_at)
        SELECT user_id, service, 'default', connected_at FROM connections_old;
      DROP TABLE connections_old;
    `);
    db.pragma("foreign_keys = ON");
  }
  if (!hasCol("enroll_tokens", "profile")) {
    db.exec("ALTER TABLE enroll_tokens ADD COLUMN profile TEXT NOT NULL DEFAULT 'default'");
  }
  // Cuenta externa real por grant (gmail→email, notion→workspace, …). NULL = desconocida o
  // no obtenible con el scope actual. El oauth la guarda al enrolar y un backfill la completa
  // para grants viejos. ADD COLUMN basta (nullable).
  if (!hasCol("oauth_grants", "account")) {
    db.exec("ALTER TABLE oauth_grants ADD COLUMN account TEXT");
  }
  // Detección de muerte de grant: `broken_at` (ISO) marca un grant cuyo refresh murió con
  // invalid_grant (refresh token expirado → hay que reconectar). NULL = sano. El gateway notifica
  // al usuario UNA vez en la transición sano→roto (guard anti-spam) y lo limpia al reconectar.
  // ADD COLUMN basta (nullable).
  if (!hasCol("oauth_grants", "broken_at")) {
    db.exec("ALTER TABLE oauth_grants ADD COLUMN broken_at TEXT");
  }
  // Sello de ENTREGA de la notificación de rotura (durable en el 🔔). Separado de broken_at: el
  // anti-spam mira notified_at, así que reintentamos entregar hasta que salga bien (elimina el
  // "aviso perdido", sobre todo en cron). Se limpia junto con broken_at al reconectar. ADD COLUMN basta.
  if (!hasCol("oauth_grants", "notified_at")) {
    db.exec("ALTER TABLE oauth_grants ADD COLUMN notified_at TEXT");
  }

  // 4) Settings de voz (Fase 10): voz elegida + prosodia (rate/pitch/volume). Basta ADD
  // COLUMN. `voice_reply` quedó DEPRECADO (el modo voz/texto lo decide el agente, no el
  // bridge); la columna se conserva (sin uso) para no rebuildear la tabla.
  if (!hasCol("users", "voice_reply")) {
    db.exec("ALTER TABLE users ADD COLUMN voice_reply TEXT NOT NULL DEFAULT 'auto'");
  }
  if (!hasCol("users", "tts_voice")) db.exec("ALTER TABLE users ADD COLUMN tts_voice TEXT");
  if (!hasCol("users", "tts_rate")) db.exec("ALTER TABLE users ADD COLUMN tts_rate TEXT");
  if (!hasCol("users", "tts_pitch")) db.exec("ALTER TABLE users ADD COLUMN tts_pitch TEXT");
  if (!hasCol("users", "tts_volume")) db.exec("ALTER TABLE users ADD COLUMN tts_volume TEXT");

  // 5) Idioma del usuario (Fase 15). 'es' default; el gateway inyecta un tag por turno
  // cuando != 'es' y /voice filtra voces por idioma. ADD COLUMN basta.
  if (!hasCol("users", "lang")) db.exec("ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT 'es'");

  // Modelo de chat elegido (/model). NULL = default (haiku). Resuelve a qué agente
  // coordinador apunta la sesión del usuario. ADD COLUMN basta (nullable).
  if (!hasCol("users", "model")) db.exec("ALTER TABLE users ADD COLUMN model TEXT");

  // 6) Wiki en foco (Fase 16, /wiki set). NULL = todas (default); si no, el chat monta
  // sólo esa wiki (menos contexto/costo). ADD COLUMN basta (nullable).
  if (!hasCol("users", "active_wiki")) db.exec("ALTER TABLE users ADD COLUMN active_wiki TEXT");
  if (!hasCol("users", "default_profile")) db.exec("ALTER TABLE users ADD COLUMN default_profile TEXT");

  // Modo debug por usuario (/debug). 0 = off (default); 1 = el canal renderiza los tool-calls
  // del agente en vivo. INTEGER booleano. ADD COLUMN con default basta (filas viejas → 0).
  if (!hasCol("users", "debug_mode")) {
    db.exec("ALTER TABLE users ADD COLUMN debug_mode INTEGER NOT NULL DEFAULT 0");
  }

  // 8) Backend de sesión por usuario (archima). 'ma' default = Managed Agents de Anthropic;
  // 'local' = archima en infra propia, cableado en una PR aparte. ADD COLUMN con default basta;
  // el CHECK acota a los dos valores válidos (las filas viejas toman 'ma' → pasan).
  if (!hasCol("users", "backend_mode")) {
    db.exec(
      "ALTER TABLE users ADD COLUMN backend_mode TEXT NOT NULL DEFAULT 'ma' CHECK (backend_mode IN ('ma','local'))",
    );
  }

  // 8c) users.timezone (quickboot/sessions): el clear diario de sesión corre a las 4am del tz del
  // usuario. ADD COLUMN con default 'UTC' (safe; las filas viejas pasan). Backfill de los usuarios
  // ACTUALES a GMT-3 (hoy todos en Argentina) en el mismo paso de migración — los nuevos toman
  // 'UTC' hasta que se setee su tz. El mecanismo es por-tz desde el día 1 (cada usuario el suyo).
  if (!hasCol("users", "timezone")) {
    db.exec("ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'");
    db.exec("UPDATE users SET timezone = 'America/Argentina/Buenos_Aires'");
  }

  // 6b) users.local_vault_id (vault del agent-vault LOCAL, backend 'local'/archima). Aditiva,
  // default NULL (mismo patrón que backend_mode). Separada de vault_id porque cada backend tiene su
  // propio vault con IDs incompatibles (MA: vlt_011C…; local: UUID/slug); pisar uno con el otro
  // rompía el push de credenciales al agent-vault ("Vault not found"). El user puede ir y volver
  // entre 'ma' y 'local' sin perder ninguno.
  if (!hasCol("users", "local_vault_id")) {
    db.exec("ALTER TABLE users ADD COLUMN local_vault_id TEXT");
  }

  // 7) Label de wiki (Fase 16, aliases). Alias humano de la wiki bajo la convención
  // username-label: el dueño la ve por su label ("personal"), los demás con prefijo
  // ("demo-personal"). NULL = sin alias seteado (se usa un fallback al mostrar). El repo
  // de GitHub NO se renombra: esto es sólo capa de display.
  if (!hasCol("repos", "label")) db.exec("ALTER TABLE repos ADD COLUMN label TEXT");

  // 8) Título corto de un cron (nullable). El listado de la agenda muestra el título;
  // si es NULL cae al `what`. Backfill de los existentes: deriva un título de la primera
  // línea del `what` (truncada) para que ninguno quede en blanco. O(1) en el ALTER; el
  // backfill es un UPDATE acotado a las filas sin título (una sola pasada, idempotente).
  if (!hasCol("crons", "title")) {
    db.exec("ALTER TABLE crons ADD COLUMN title TEXT");
    const rows = db.prepare("SELECT id, what FROM crons WHERE title IS NULL").all() as {
      id: number;
      what: string;
    }[];
    const setTitle = db.prepare("UPDATE crons SET title = ? WHERE id = ?");
    const backfill = db.transaction((rs: { id: number; what: string }[]) => {
      for (const r of rs) setTitle.run(deriveCronTitle(r.what), r.id);
    });
    backfill(rows);
  }

  // 9) Avatar del usuario (edición de perfil desde la web): el BLOB de la imagen + su mime,
  // ambos nullable. Sin avatar → NULL/NULL (la UI cae a un placeholder). Se lee por
  // getUserAvatar (select explícito; getUser NO lo expone en el tipo User a propósito,
  // para no implicar que leerlo es barato). O(1): sólo ALTERs idempotentes.
  if (!hasCol("users", "avatar_blob")) db.exec("ALTER TABLE users ADD COLUMN avatar_blob BLOB");
  if (!hasCol("users", "avatar_mime")) db.exec("ALTER TABLE users ADD COLUMN avatar_mime TEXT");

  // 9b) Queries del fondo Unsplash por usuario (cog de settings). JSON array de strings;
  // NULL = default de la app (lo resuelve el web-server). ADD COLUMN basta (nullable).
  if (!hasCol("users", "bg_queries")) db.exec("ALTER TABLE users ADD COLUMN bg_queries TEXT");

  // 9c) Ubicación del usuario (perfil, texto libre). NULL = sin setear → el gateway no la
  // inyecta en el contexto del agente. ADD COLUMN basta (nullable, aditiva, no destructiva).
  if (!hasCol("users", "location")) db.exec("ALTER TABLE users ADD COLUMN location TEXT");

  // 10) Detalle por-cambio del feed de wikis (reporte de cambios en el chat): op por-path
  // (`entries`), quién originó (`source`), y el usuario (`user_id`). Las filas legacy quedan
  // con NULL → al leer caen a op 'edit' / source desconocido (no rompen el feed web existente,
  // que sólo mira `repo`). ADD COLUMN basta (nullable, sin default): O(1), idempotente.
  if (!hasCol("wiki_changes", "entries")) db.exec("ALTER TABLE wiki_changes ADD COLUMN entries TEXT");
  if (!hasCol("wiki_changes", "source")) db.exec("ALTER TABLE wiki_changes ADD COLUMN source TEXT");
  if (!hasCol("wiki_changes", "user_id")) db.exec("ALTER TABLE wiki_changes ADD COLUMN user_id INTEGER");

  // 11) Backfill de wiki_commit_sources desde lo que el feed todavía conserva (≤7 días: el
  // prune corre DESPUÉS de migrar, ver openDb). Idempotente y barato (INSERT OR IGNORE sobre
  // una tabla acotada); corre en cada open para no perder filas escritas por un proceso con
  // código viejo (deploy rolling: gateway viejo + webserver nuevo comparten la DB).
  db.exec(`
    INSERT OR IGNORE INTO wiki_commit_sources (repo, ref, source, user_id, at)
      SELECT repo, ref, source, user_id, at FROM wiki_changes WHERE source IS NOT NULL
  `);

  // 12) Wiki lifecycle (F1 wiki-management):
  //   - repos.deleted_at   → soft-delete global
  //   - repos.personal     → flag wiki personal (no borrable / no archivable)
  //   - repo_access.role   → 'owner'|'member'; backfill one-shot desde firstUserForRepo
  //   - repo_access.archived_at → archivado per-usuario
  //   - wiki_invites table → invitaciones por email pendientes
  //
  // Todas aditivas e idempotentes. El SCHEMA ya creó repos/repo_access con las columnas
  // nuevas en DBs frescas; las columnas faltarán sólo en DBs viejas → ADD COLUMN.
  if (!hasCol("repos", "deleted_at")) {
    db.exec("ALTER TABLE repos ADD COLUMN deleted_at TEXT");
  }
  if (!hasCol("repos", "personal")) {
    db.exec("ALTER TABLE repos ADD COLUMN personal INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasCol("repo_access", "role")) {
    db.exec(
      "ALTER TABLE repo_access ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member'))",
    );
  }
  if (!hasCol("repo_access", "archived_at")) {
    db.exec("ALTER TABLE repo_access ADD COLUMN archived_at TEXT");
  }
  // wiki_invites: la tabla puede no existir en DBs viejas (el SCHEMA la crea con IF NOT EXISTS,
  // pero el SCHEMA sólo corre al abrir la DB ANTES de migrate → ya la creó si era nueva).
  // Para DBs viejas donde el SCHEMA la salteó (ya tenía todas las otras tablas), crearla acá.
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_invites (
      repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      email       TEXT NOT NULL,
      invited_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      accepted_at TEXT,
      PRIMARY KEY (repo_id, email)
    )
  `);

  // Backfill one-shot (F1):
  // (a) role='owner' al grant activo más viejo de cada repo (mismo criterio que firstUserForRepo:
  //     ra.created_at ASC, u.id ASC). La CTE identifica, para cada repo, cuál es el usuario
  //     "owner" (el activo con el created_at más viejo; en empate, el de menor u.id).
  //     Idempotente: el UPDATE sólo toca filas con role='member' donde hay un owner candidato.
  db.exec(`
    WITH owners AS (
      SELECT ra.repo_id, ra.user_id
      FROM repo_access ra
      JOIN users u ON u.id = ra.user_id AND u.status = 'active'
      WHERE NOT EXISTS (
        SELECT 1 FROM repo_access ra2
        JOIN users u2 ON u2.id = ra2.user_id AND u2.status = 'active'
        WHERE ra2.repo_id = ra.repo_id
          AND (ra2.created_at < ra.created_at
               OR (ra2.created_at = ra.created_at AND ra2.user_id < ra.user_id))
      )
    )
    UPDATE repo_access SET role = 'owner'
    WHERE role = 'member' AND EXISTS (
      SELECT 1 FROM owners o
      WHERE o.repo_id = repo_access.repo_id AND o.user_id = repo_access.user_id
    )
  `);

  // (b) personal=1 para la wiki personal de cada usuario: la más antigua cuyo nombre es
  //     '<handle>-personal' y cuyo dueño (role='owner' en repo_access) es ese usuario.
  //     Idempotente: UPDATE WHERE personal=0. Si un usuario no tiene una identificable,
  //     se loguea un warning pero NO se aborta la migración.
  {
    const rows = db
      .prepare(
        `SELECT u.id AS user_id, u.handle AS handle,
                r.id AS repo_id, r.name AS repo_name
         FROM users u
         JOIN repo_access ra ON ra.user_id = u.id AND ra.role = 'owner'
         JOIN repos r ON r.id = ra.repo_id
         WHERE r.name = u.handle || '-personal'
           AND r.personal = 0
         ORDER BY r.created_at ASC`,
      )
      .all() as { user_id: number; handle: string; repo_id: number; repo_name: string }[];

    // Para cada usuario, tomar la wiki personal más antigua (la que aparece primera,
    // ya que ORDER BY r.created_at ASC) y marcarla como personal=1.
    const seen = new Set<number>();
    const markPersonal = db.prepare("UPDATE repos SET personal = 1 WHERE id = ?");
    const tx = db.transaction(() => {
      for (const r of rows) {
        if (!seen.has(r.user_id)) {
          seen.add(r.user_id);
          markPersonal.run(r.repo_id);
        }
      }
    });
    tx();

    // Warning por usuarios con role='owner' que NO tienen su wiki personal ya identificada
    // (personal=1 con nombre '<handle>-personal' y owner = el usuario).
    // Usa el ESTADO REAL post-UPDATE (independiente de esta corrida) para ser idempotente:
    // en re-runs el backfill ya marcó personal=1 en la 1ª corrida → esta query devuelve
    // los mismos owners sin personal en la 1ª y en todas las siguientes. `seen` sólo se
    // usó para el UPDATE; no lo usamos acá.
    const ownersWithPersonal = new Set<number>(
      (
        db
          .prepare(
            `SELECT DISTINCT ra.user_id
             FROM repo_access ra
             JOIN repos r ON r.id = ra.repo_id
             JOIN users u ON u.id = ra.user_id
             WHERE ra.role = 'owner'
               AND r.personal = 1
               AND r.name = u.handle || '-personal'`,
          )
          .all() as { user_id: number }[]
      ).map((row) => row.user_id),
    );
    const allOwners = db
      .prepare(
        `SELECT DISTINCT u.id, u.handle FROM users u
         JOIN repo_access ra ON ra.user_id = u.id AND ra.role = 'owner'
         WHERE u.status = 'active'`,
      )
      .all() as { id: number; handle: string }[];
    for (const u of allOwners) {
      if (!ownersWithPersonal.has(u.id)) {
        console.warn(
          `[store] migrate F1: usuario ${u.handle} (id=${u.id}) no tiene wiki '<handle>-personal' identificable → personal=1 no seteado, revisar manualmente`,
        );
      }
    }
  }

  // 13) Invitaciones + waitlist (P1):
  //   - users.admin          → flag admin (para gestionar waitlist y system-page)
  //   - wiki_invites.accept_token → token del link de mail (hex 32 chars, único por invite)
  //     + índice UNIQUE + backfill de pendientes existentes (F6 nunca mandó mails)
  //   - waiting_list table   → cola de admisión (SCHEMA la crea en DBs frescas; acá la
  //     creamos en DBs viejas donde el SCHEMA la saltea porque las otras tablas ya existen)
  if (!hasCol("users", "admin")) {
    db.exec("ALTER TABLE users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasCol("wiki_invites", "accept_token")) {
    db.exec("ALTER TABLE wiki_invites ADD COLUMN accept_token TEXT");
    // Backfill: genera tokens para invites que no tienen uno todavía (incluyendo F6).
    // Idempotente: solo actualiza NULL. El índice UNIQUE va después del backfill para
    // no chocar contra los NULL (SQLite trata cada NULL como distinto en UNIQUE).
    db.exec("UPDATE wiki_invites SET accept_token = lower(hex(randomblob(16))) WHERE accept_token IS NULL");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_wiki_invites_token ON wiki_invites (accept_token)");
  } else {
    // Si la columna ya existe (migración parcial), aseguramos el índice y backfill de NULLs restantes.
    db.exec("UPDATE wiki_invites SET accept_token = lower(hex(randomblob(16))) WHERE accept_token IS NULL");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_wiki_invites_token ON wiki_invites (accept_token)");
  }
  // waiting_list: en DBs viejas el SCHEMA la salteó (ya tenía otras tablas). Creamos acá.
  db.exec(`
    CREATE TABLE IF NOT EXISTS waiting_list (
      email       TEXT PRIMARY KEY,
      source      TEXT NOT NULL CHECK (source IN ('invited','self-signup')),
      status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected')),
      invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    )
  `);
}

// --- Tipos de fila -------------------------------------------------------
/** Backend de sesión por usuario (archima): 'ma' = Managed Agents de Anthropic (default),
 *  'local' = archima en infra propia. El gateway elige el SessionBackend según esto. */
export type BackendMode = "ma" | "local";

export interface User {
  id: number;
  handle: string;
  name: string | null;
  /** Ubicación del usuario (perfil, texto libre, ej. "Buenos Aires, Argentina"). null = sin
   *  setear → el gateway no la inyecta en el contexto del agente. La edita el propio usuario. */
  location: string | null;
  status: "active" | "disabled";
  anthropic_api_key: string | null;
  /** Vault MA del usuario (backend 'ma'). Lazy. */
  vault_id: string | null;
  /** Vault del agent-vault LOCAL (backend 'local'/archima). Lazy. Independiente de vault_id. */
  local_vault_id: string | null;
  /** @deprecated Fase 10: el modo voz/texto lo decide el agente, no el bridge. Sin uso. */
  voice_reply: string;
  /** Idioma del usuario (Fase 15): 'es' | 'en'. */
  lang: string;
  /** Modelo de chat elegido (/model): clave estable (haiku|sonnet|opus), o null = default. */
  model: string | null;
  /** Wiki en foco (Fase 16, /wiki set): nombre del repo, o null = todas montadas. */
  active_wiki: string | null;
  /** Backend de sesión (archima): 'ma' (Managed Agents, default) | 'local' (archima). Hoy sólo 'ma' cableado. */
  backend_mode: BackendMode;
  /** Timezone IANA del usuario (ej. 'America/Argentina/Buenos_Aires'); default 'UTC'. La usa el
   *  clear diario de sesión (quickboot/sessions): corre a las 4am de ESTA tz. */
  timezone: string;
  default_profile: string | null;
  tts_voice: string | null;
  tts_rate: string | null;
  tts_pitch: string | null;
  tts_volume: string | null;
  /** Modo debug (/debug): 1 = el canal muestra los tool-calls del agente en vivo, 0 = off.
   *  SQLite no tiene boolean: es 0|1. Usá `getUserDebug` para leerlo como boolean. */
  debug_mode: number;
  /** Flag admin (P1 invitaciones): 1 = puede gestionar la waitlist y ve la system-page de admin.
   *  SQLite no tiene boolean: es 0|1. Usá `isAdmin` para leerlo como boolean. */
  admin: number;
  created_at: string;
}

export interface ChannelIdentity {
  id: number;
  user_id: number;
  channel: string;
  external_id: string;
  created_at: string;
}

export interface AuthorizedEmail {
  email: string;
  name: string | null;
  handle: string | null;
  note: string | null;
  created_at: string;
  used_at: string | null;
}

export interface Repo {
  id: number;
  org: string;
  name: string;
  /** Alias humano (Fase 16). NULL = sin setear → se usa un fallback al mostrar. */
  label: string | null;
  created_at: string;
  /** Soft-delete global (F1): setea el dueño al borrar la wiki para todos. */
  deleted_at: string | null;
  /** Flag wiki personal (F1): 1 = wiki personal del usuario (no borrable/no archivable). */
  personal: number;
}

/** full_name estilo GitHub: org/name. */
export function repoFullName(r: Pick<Repo, "org" | "name">): string {
  return `${r.org}/${r.name}`;
}

/** Label efectivo de una wiki (Fase 16). El explícito (repos.label) gana; si no hay, se
 *  deriva del nombre del repo bajo la convención `<handle>-<label>`: se le pela el prefijo
 *  del dueño (`demo-ceibo` → `ceibo`). La wiki propia (repo.name === ownerHandle, esquema
 *  viejo) cae a "personal"; cualquier otra, al nombre del repo. */
export function wikiLabel(repo: Pick<Repo, "name" | "label">, ownerHandle: string): string {
  if (repo.label) return repo.label;
  const prefix = `${ownerHandle}-`;
  if (repo.name.startsWith(prefix) && repo.name.length > prefix.length) {
    return repo.name.slice(prefix.length);
  }
  return repo.name === ownerHandle ? "personal" : repo.name;
}

/** Nombre visible de una wiki para un viewer, convención username-label (Fase 16): el dueño
 *  la ve por su label ("personal"); los demás, con el prefijo del dueño ("demo-personal"). */
export function wikiDisplayName(
  repo: Pick<Repo, "name" | "label">,
  ownerHandle: string,
  viewerHandle: string,
): string {
  const label = wikiLabel(repo, ownerHandle);
  return viewerHandle === ownerHandle ? label : `${ownerHandle}-${label}`;
}

/** Nombres visibles de un set de wikis para un viewer, con desambiguación por colisión: cada
 *  wiki se muestra por su label pelado ("luminos"), sin importar de quién sea. El prefijo del
 *  dueño ("demo-luminos") aparece SÓLO cuando dos o más wikis visibles comparten label; en ese
 *  caso la propia del viewer mantiene el label pelado y las ajenas se prefijan. Devuelve un
 *  Map repo.name → display. El owner es el primer usuario activo con acceso (firstUserForRepo). */
export function wikiDisplayNames(db: Db, viewerHandle: string, repos: Repo[]): Map<string, string> {
  const owners = new Map<string, string>();
  const labels = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const r of repos) {
    const owner = firstUserForRepo(db, r.id)?.handle ?? r.name;
    const label = wikiLabel(r, owner);
    owners.set(r.name, owner);
    labels.set(r.name, label);
    const k = label.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const r of repos) {
    const owner = owners.get(r.name) ?? r.name;
    const label = labels.get(r.name) ?? r.name;
    const isOwn = owner === viewerHandle;
    const collides = (counts.get(label.toLowerCase()) ?? 0) > 1;
    out.set(r.name, isOwn || !collides ? label : `${owner}-${label}`);
  }
  return out;
}

export interface SessionRow {
  user_id: number;
  session_id: string;
  last_input: number;
  last_output: number;
  last_cache_5m: number;
  last_cache_1h: number;
  last_cache_read: number;
  updated_at: string;
}

// --- Usuarios ------------------------------------------------------------
/** Crea un usuario. `handle` es el identificador humano (único). Throws si ya existe. */
export function addUser(db: Db, handle: string, opts?: { name?: string; anthropicApiKey?: string }): User {
  // En dev (local) los usuarios nacen en backend 'local' (archima) → el chat anda sin tener que
  // flipear cada cuenta a mano (da igual si entrás con el user del seed o con tu Google). En
  // prod/staging el default sigue siendo 'ma'; ahí se pasa a 'local' por separado (set-backend).
  const backendMode = ceiboEnv() === "dev" ? "local" : "ma";
  const info = db
    .prepare("INSERT INTO users (handle, name, anthropic_api_key, backend_mode) VALUES (?, ?, ?, ?)")
    .run(handle, opts?.name ?? null, opts?.anthropicApiKey ?? null, backendMode);
  return getUser(db, Number(info.lastInsertRowid)) as User;
}

export function getUser(db: Db, id: number): User | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
}

export function getUserByHandle(db: Db, handle: string): User | undefined {
  return db.prepare("SELECT * FROM users WHERE handle = ?").get(handle) as User | undefined;
}

export function listUsers(db: Db): User[] {
  return db.prepare("SELECT * FROM users ORDER BY id").all() as User[];
}

/** Directorio restringido (P6): usuarios con los que el caller comparte al menos una wiki
 *  activa (deleted_at IS NULL). Co-membresía actual en repo_access — no historial de grants.
 *  Excluye al caller y a usuarios inactivos. Ordenado por handle. */
export function listCoMembers(db: Db, callerId: number): User[] {
  return db
    .prepare(
      `SELECT DISTINCT u.*
       FROM users u
       JOIN repo_access ra_other ON ra_other.user_id = u.id
       JOIN repo_access ra_me    ON ra_me.repo_id = ra_other.repo_id
                                 AND ra_me.user_id = ?
       JOIN repos r              ON r.id = ra_other.repo_id
                                 AND r.deleted_at IS NULL
       WHERE u.id != ?
         AND u.status = 'active'
       ORDER BY u.handle`,
    )
    .all(callerId, callerId) as User[];
}

export function setUserStatus(db: Db, id: number, status: "active" | "disabled"): void {
  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, id);
}

/** Cambia el handle de un usuario. Único (índice `idx_users_handle`): throws si ya existe.
 *  No toca canales/repos/vault — todo eso cuelga del user.id, no del handle.
 *
 *  PERO el nombre de repo de una wiki codifica el handle del dueño al crearla
 *  (`<handle>-<label>`, ver @ceibo/wikis userRepoName) y el display label se deriva pelando
 *  ese prefijo (`wikiLabel`). Si el handle cambia, ese prefijo queda viejo (`demo-personal` con
 *  dueño `demo-gpuhost`) y el strip falla → la wiki se muestra con su nombre crudo en vez del label.
 *  Para que el label SOBREVIVA al rename, congelamos el label derivado (del handle viejo) en
 *  `repos.label` de las wikis sin label explícito ANTES de cambiar el handle. Atómico. */
export function renameUser(db: Db, id: number, newHandle: string): void {
  const priorHandle = getUser(db, id)?.handle;
  const tx = db.transaction(() => {
    if (priorHandle) backfillOwnedWikiLabels(db, id, priorHandle);
    db.prepare("UPDATE users SET handle = ? WHERE id = ?").run(newHandle, id);
  });
  tx();
}

/** Congela el display label (`repos.label`) de las wikis que `userId` posee y que todavía no
 *  tienen label explícito, derivándolo del prefijo `priorHandle-` del nombre del repo
 *  (vía `wikiLabel`). Display-only: NO toca el nombre del repo ni GitHub. Idempotente (sólo
 *  toca `label IS NULL`) y conservador (sólo persiste cuando el strip realmente aplicó, es
 *  decir el label derivado difiere del nombre crudo — así no horneamos un nombre feo como label).
 *  Lo usa `renameUser` (para que el label sobreviva al cambio de handle) y, como migración
 *  one-shot, la CLI (`repo backfill-labels`) para usuarios YA renombrados. Devuelve cuántas tocó. */
export function backfillOwnedWikiLabels(db: Db, userId: number, priorHandle: string): number {
  const owned = listReposForUser(db, userId).filter(
    (r) => r.label === null && firstUserForRepo(db, r.id)?.id === userId,
  );
  let n = 0;
  const tx = db.transaction(() => {
    const stmt = db.prepare("UPDATE repos SET label = ? WHERE id = ?");
    for (const r of owned) {
      const label = wikiLabel(r, priorHandle);
      if (label !== r.name) {
        // el strip (o el fallback a "personal") aplicó → vale la pena congelarlo
        stmt.run(label, r.id);
        n++;
      }
    }
  });
  tx();
  return n;
}

/** Cambia el nombre de display de un usuario (null = sin nombre → se usa el handle). */
export function setUserName(db: Db, id: number, name: string | null): void {
  db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, id);
}

/** Setea (o limpia) la ubicación del usuario (edición de perfil web). Texto libre; null la
 *  borra (→ el gateway deja de inyectarla en el contexto del agente). El caller (web-server)
 *  valida longitud/trim antes de llamar. */
export function setUserLocation(db: Db, id: number, location: string | null): void {
  db.prepare("UPDATE users SET location = ? WHERE id = ?").run(location, id);
}

export function setUserVault(db: Db, id: number, vaultId: string): void {
  db.prepare("UPDATE users SET vault_id = ? WHERE id = ?").run(vaultId, id);
}

/** Setea el vault LOCAL (agent-vault) del usuario (backend 'local'/archima). No toca vault_id (MA):
 *  cada backend tiene su propio vault. */
export function setUserLocalVault(db: Db, id: number, vaultId: string): void {
  db.prepare("UPDATE users SET local_vault_id = ? WHERE id = ?").run(vaultId, id);
}

/** Vault del usuario para SU backend activo: 'local' → local_vault_id (agent-vault); 'ma' (default)
 *  → vault_id (MA). Helper PURO (no toca la DB) que centraliza la selección por backend para todos
 *  los consumidores (gateway prepareSession/revoke, oauth refresh) → un único lugar que sabe qué
 *  vault corresponde. null = el backend activo todavía no tiene vault provisionado. */
export function vaultIdForUser(
  user: Pick<User, "backend_mode" | "vault_id" | "local_vault_id">,
): string | null {
  return user.backend_mode === "local" ? user.local_vault_id : user.vault_id;
}

/** Setea (o limpia) el avatar del usuario (edición de perfil web). blob+mime van juntos:
 *  pasar `null, null` borra el avatar. El BLOB es la imagen cruda (PNG/JPEG/WebP); el caller
 *  (web-server) valida tamaño/formato antes de llamar. */
export function setUserAvatar(db: Db, id: number, blob: Buffer | null, mime: string | null): void {
  db.prepare("UPDATE users SET avatar_blob = ?, avatar_mime = ? WHERE id = ?").run(blob, mime, id);
}

/** Lee el avatar del usuario, o null si no tiene. Select explícito (no `SELECT *`): el BLOB
 *  sólo se carga cuando de verdad se va a servir. Devuelve null si falta el blob o el mime. */
export function getUserAvatar(db: Db, id: number): { blob: Buffer; mime: string } | null {
  const row = db.prepare("SELECT avatar_blob AS blob, avatar_mime AS mime FROM users WHERE id = ?").get(id) as
    | { blob: Buffer | null; mime: string | null }
    | undefined;
  if (!row || !row.blob || !row.mime) return null;
  return { blob: row.blob, mime: row.mime };
}

/** ¿El usuario tiene avatar? Chequeo barato (no carga el BLOB) para que /api/me indique
 *  presencia sin transferir la imagen. */
export function userHasAvatar(db: Db, id: number): boolean {
  const row = db
    .prepare("SELECT avatar_blob IS NOT NULL AND avatar_mime IS NOT NULL AS has FROM users WHERE id = ?")
    .get(id) as { has: number } | undefined;
  return !!row?.has;
}

/** Idioma del usuario (Fase 15). Default 'es'. */
export function getUserLang(db: Db, id: number): string {
  const row = db.prepare("SELECT lang FROM users WHERE id = ?").get(id) as { lang: string } | undefined;
  return row?.lang ?? "es";
}

/** Cambia el idioma del usuario y resetea la voz a NULL (la voz vieja era del idioma
 *  viejo → vuelve a la default del idioma nuevo). La prosodia es agnóstica, se conserva. */
export function setUserLang(db: Db, id: number, lang: string): void {
  db.prepare("UPDATE users SET lang = ?, tts_voice = NULL WHERE id = ?").run(lang, id);
}

/** Modelo de chat elegido por el usuario (/model). null = default (lo resuelve el gateway). */
export function getUserModel(db: Db, id: number): string | null {
  const row = db.prepare("SELECT model FROM users WHERE id = ?").get(id) as
    | { model: string | null }
    | undefined;
  return row?.model ?? null;
}

/** Fija el modelo de chat (clave estable, ej. "opus") o null = default. El gateway recrea
 *  la sesión apuntando al agente coordinador del modelo elegido (los mounts/agente son fijos
 *  al crear la sesión → cambio limpio, reinicia el contexto). */
export function setUserModel(db: Db, id: number, model: string | null): void {
  db.prepare("UPDATE users SET model = ? WHERE id = ?").run(model, id);
}

/** Queries del fondo Unsplash elegidas por el usuario (cog de settings). Guardadas como
 *  JSON array de strings en users.bg_queries. null = sin preferencia → default de la app
 *  (lo resuelve el web-server). El getter SANEA: si la columna tiene basura (no-JSON, no
 *  array, entradas no-string/vacías) devuelve null en vez de tirar — el caller cae al
 *  default sin romper. */
export function getUserBgQueries(db: Db, id: number): string[] | null {
  const row = db.prepare("SELECT bg_queries FROM users WHERE id = ?").get(id) as
    | { bg_queries: string | null }
    | undefined;
  if (!row?.bg_queries) return null;
  try {
    const parsed: unknown = JSON.parse(row.bg_queries);
    if (!Array.isArray(parsed)) return null;
    const queries = parsed
      .filter((q): q is string => typeof q === "string")
      .map((q) => q.trim())
      .filter((q) => q.length > 0);
    return queries.length > 0 ? queries : null;
  } catch {
    return null; // basura guardada → default
  }
}

/** Fija las queries del fondo. null o lista vacía limpian la preferencia (→ default de la
 *  app). No valida límites (eso es del endpoint); sólo persiste la lista tal cual. */
export function setUserBgQueries(db: Db, id: number, queries: string[] | null): void {
  const val = queries && queries.length > 0 ? JSON.stringify(queries) : null;
  db.prepare("UPDATE users SET bg_queries = ? WHERE id = ?").run(val, id);
}

/** Wiki en foco del usuario (Fase 16, /wiki set). null = todas montadas (default). */
export function getUserActiveWiki(db: Db, id: number): string | null {
  const row = db.prepare("SELECT active_wiki FROM users WHERE id = ?").get(id) as
    | { active_wiki: string | null }
    | undefined;
  return row?.active_wiki ?? null;
}

/** Fija la wiki en foco (nombre del repo) o null = todas. El gateway recrea la sesión
 *  para que el nuevo set de mounts tome efecto (los mounts son fijos al crear la sesión). */
export function setUserActiveWiki(db: Db, id: number, name: string | null): void {
  db.prepare("UPDATE users SET active_wiki = ? WHERE id = ?").run(name, id);
}

/** Backend de sesión del usuario (archima). 'ma' (default) o 'local'. El gateway elige el
 *  SessionBackend según esto; hoy sólo 'ma' está cableado. */
export function getUserBackendMode(db: Db, id: number): BackendMode {
  const row = db.prepare("SELECT backend_mode FROM users WHERE id = ?").get(id) as
    | { backend_mode: BackendMode }
    | undefined;
  return row?.backend_mode ?? "ma";
}

/** Fija el backend de sesión del usuario ('ma' | 'local'). Cambiar de backend NO migra el
 *  estado (vive externalizado): es elegir a qué infra le habla el gateway en el próximo turno. */
export function setUserBackendMode(db: Db, id: number, mode: BackendMode): void {
  db.prepare("UPDATE users SET backend_mode = ? WHERE id = ?").run(mode, id);
}

/** Modo debug del usuario (/debug). false = off (default). Cuando está on, los canales
 *  renderizan los tool-calls del agente en vivo (Telegram los postea; la web los muestra). */
export function getUserDebug(db: Db, id: number): boolean {
  const row = db.prepare("SELECT debug_mode FROM users WHERE id = ?").get(id) as
    | { debug_mode: number }
    | undefined;
  return !!row?.debug_mode;
}

/** Prende/apaga el modo debug del usuario. No recrea la sesión: sólo cambia cómo el canal
 *  renderiza la actividad del agente en los próximos turnos. */
export function setUserDebug(db: Db, id: number, on: boolean): void {
  db.prepare("UPDATE users SET debug_mode = ? WHERE id = ?").run(on ? 1 : 0, id);
}

/** Fija el perfil default del usuario (multi-cuenta). */
export function setDefaultProfile(db: Db, id: number, profile: string | null): void {
  db.prepare("UPDATE users SET default_profile = ? WHERE id = ?").run(profile, id);
}

/** Settings de voz del usuario (Fase 10): voz + prosodia. NULL = default de @ceibo/speech. */
export interface UserSpeech {
  voice: string | null;
  rate: string | null;
  pitch: string | null;
  volume: string | null;
}

export function getUserSpeech(db: Db, id: number): UserSpeech {
  const row = db
    .prepare("SELECT tts_voice, tts_rate, tts_pitch, tts_volume FROM users WHERE id = ?")
    .get(id) as
    | {
        tts_voice: string | null;
        tts_rate: string | null;
        tts_pitch: string | null;
        tts_volume: string | null;
      }
    | undefined;
  return {
    voice: row?.tts_voice ?? null,
    rate: row?.tts_rate ?? null,
    pitch: row?.tts_pitch ?? null,
    volume: row?.tts_volume ?? null,
  };
}

/** Actualiza voz/prosodia (sólo los campos pasados; null limpia → vuelve al default). */
export function setUserSpeech(db: Db, id: number, patch: Partial<UserSpeech>): void {
  if (patch.voice !== undefined)
    db.prepare("UPDATE users SET tts_voice = ? WHERE id = ?").run(patch.voice, id);
  if (patch.rate !== undefined) db.prepare("UPDATE users SET tts_rate = ? WHERE id = ?").run(patch.rate, id);
  if (patch.pitch !== undefined)
    db.prepare("UPDATE users SET tts_pitch = ? WHERE id = ?").run(patch.pitch, id);
  if (patch.volume !== undefined)
    db.prepare("UPDATE users SET tts_volume = ? WHERE id = ?").run(patch.volume, id);
}

/** Resuelve una identidad de canal a un usuario ACTIVO. Es el allowlist + router. */
export function resolveUser(db: Db, channel: string, externalId: string): User | undefined {
  return db
    .prepare(
      `SELECT u.* FROM users u
       JOIN channel_identities ci ON ci.user_id = u.id
       WHERE ci.channel = ? AND ci.external_id = ? AND u.status = 'active'`,
    )
    .get(channel, externalId) as User | undefined;
}

/** Igual que resolveUser pero incluye usuarios disabled. Uso interno: detectar colisión UNIQUE
 *  en channel_identities antes de intentar un INSERT (evita el crash en re-login de disabled). */
function resolveUserAny(db: Db, channel: string, externalId: string): User | undefined {
  return db
    .prepare(
      `SELECT u.* FROM users u
       JOIN channel_identities ci ON ci.user_id = u.id
       WHERE ci.channel = ? AND ci.external_id = ?`,
    )
    .get(channel, externalId) as User | undefined;
}

// --- Identidades de canal -----------------------------------------------
export function addChannel(db: Db, userId: number, channel: string, externalId: string): ChannelIdentity {
  const info = db
    .prepare("INSERT INTO channel_identities (user_id, channel, external_id) VALUES (?, ?, ?)")
    .run(userId, channel, externalId);
  return db
    .prepare("SELECT * FROM channel_identities WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as ChannelIdentity;
}

// Borra los canales de un usuario que matcheen channel (y external_id si se da).
// Devuelve las filas borradas (vacío si no había match).
export function removeChannel(
  db: Db,
  userId: number,
  channel: string,
  externalId?: string,
): ChannelIdentity[] {
  const where =
    externalId !== undefined
      ? "WHERE user_id = ? AND channel = ? AND external_id = ?"
      : "WHERE user_id = ? AND channel = ?";
  const params = externalId !== undefined ? [userId, channel, externalId] : [userId, channel];
  const matched = db
    .prepare(`SELECT * FROM channel_identities ${where} ORDER BY id`)
    .all(...params) as ChannelIdentity[];
  if (matched.length > 0) db.prepare(`DELETE FROM channel_identities ${where}`).run(...params);
  return matched;
}

export function listChannels(db: Db, userId?: number): ChannelIdentity[] {
  if (userId !== undefined) {
    return db
      .prepare("SELECT * FROM channel_identities WHERE user_id = ? ORDER BY id")
      .all(userId) as ChannelIdentity[];
  }
  return db.prepare("SELECT * FROM channel_identities ORDER BY user_id, id").all() as ChannelIdentity[];
}

// --- Allowlist de registración (invite-only) ----------------------------
// El gate de autorización del signup por Google. La tabla la gestiona el admin (CLI `allow`);
// el alta automática (registerGoogleUserIfAuthorized) es el ÚNICO camino que crea un usuario
// desde un login web → centraliza el chequeo de autorización en un solo lugar (store).

/** Nombre de display por defecto cuando el entry no trae `name`: el local-part del email,
 *  primer segmento (antes de `.`/`+`/`-`/`_`), capitalizado. El admin normalmente pasa --name. */
function defaultNameFromEmail(email: string): string {
  const local = (email.split("@")[0] ?? "").split(/[.+_-]/)[0] ?? "";
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : "Usuario";
}

/** Deriva un handle válido y ÚNICO a partir de una semilla (handle preferido o local-part del
 *  email). Slugifica, cae a "user" si quedara inválido/vacío, y desambigua con sufijo -2/-3… */
function deriveUniqueHandle(db: Db, seed: string): string {
  let base = slugify(seed);
  if (!base || !isValidHandle(base)) base = "user";
  let handle = base;
  let n = 2;
  while (getUserByHandle(db, handle)) {
    handle = `${base}-${n}`;
    n++;
  }
  return handle;
}

/** Agrega (o actualiza) un email a la allowlist. El email se normaliza a lowercase (matchea el
 *  email verificado del id_token de Google). Re-agregar pisa name/handle/note (última intención
 *  del admin) pero preserva created_at/used_at. */
export function addAuthorizedEmail(
  db: Db,
  emailRaw: string,
  opts?: { name?: string; handle?: string; note?: string },
): AuthorizedEmail {
  const email = emailRaw.trim().toLowerCase();
  db.prepare(
    `INSERT INTO authorized_emails (email, name, handle, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, handle = excluded.handle, note = excluded.note`,
  ).run(email, opts?.name ?? null, opts?.handle ?? null, opts?.note ?? null);
  return getAuthorizedEmail(db, email) as AuthorizedEmail;
}

export function getAuthorizedEmail(db: Db, emailRaw: string): AuthorizedEmail | undefined {
  const email = emailRaw.trim().toLowerCase();
  return db.prepare("SELECT * FROM authorized_emails WHERE email = ?").get(email) as
    | AuthorizedEmail
    | undefined;
}

export function listAuthorizedEmails(db: Db): AuthorizedEmail[] {
  return db.prepare("SELECT * FROM authorized_emails ORDER BY created_at, email").all() as AuthorizedEmail[];
}

/** Saca un email de la allowlist. NO borra una cuenta ya creada (eso es `user disable`).
 *  Devuelve true si había una fila. */
export function removeAuthorizedEmail(db: Db, emailRaw: string): boolean {
  const email = emailRaw.trim().toLowerCase();
  return db.prepare("DELETE FROM authorized_emails WHERE email = ?").run(email).changes > 0;
}

/** Gate de signup por Google (atómico). Dado un email verificado:
 *   - si ya existe un usuario ACTIVO con identidad `google:<email>` → lo devuelve (created:false);
 *   - si existe un usuario DISABLED con identidad `google:<email>` y el email está autorizado →
 *     lo re-activa (status='active', created:false); si NO está autorizado → undefined (sin crash);
 *   - si no existe pero el email está en la allowlist → crea el usuario (backend_mode='local',
 *     status active), le agrega la identidad `google`, marca el entry como usado, y lo devuelve
 *     (created:true);
 *   - si no existe y NO está autorizado → devuelve undefined (el caller rechaza el login).
 *  Todo en una transacción: el chequeo de autorización y el alta no se pueden separar (no hay
 *  ventana de confused-deputy), y la UNIQUE(channel,external_id) hace race-safe el doble-callback
 *  concurrente (el segundo re-resuelve al usuario del primero en vez de duplicar). */
export function registerGoogleUserIfAuthorized(
  db: Db,
  emailRaw: string,
): { user: User; created: boolean } | undefined {
  const email = emailRaw.trim().toLowerCase();
  if (!email) return undefined;
  const tx = db.transaction((): { user: User; created: boolean } | undefined => {
    const existing = resolveUser(db, "google", email);
    if (existing) return { user: existing, created: false };
    // Detectar usuario disabled con la misma identidad ANTES de intentar INSERT (evita UNIQUE crash).
    const disabled = resolveUserAny(db, "google", email);
    if (disabled) {
      // La identidad ya existe → no podemos crear un usuario nuevo.
      const entry = getAuthorizedEmail(db, email);
      if (!entry) return undefined; // NO autorizado → deny limpio, sin crash
      // Re-autorizado: re-activar la cuenta existente en vez de duplicar.
      console.log(`[store] re-enabling disabled user ${disabled.id} (${disabled.handle}) via google login`);
      setUserStatus(db, disabled.id, "active");
      return { user: getUser(db, disabled.id) as User, created: false };
    }
    const entry = getAuthorizedEmail(db, email);
    if (!entry) return undefined; // NO autorizado
    const handle = deriveUniqueHandle(db, entry.handle ?? email.split("@")[0] ?? "user");
    const name = entry.name ?? defaultNameFromEmail(email);
    const u = addUser(db, handle, { name });
    setUserBackendMode(db, u.id, "local"); // "vamos todos a archima"
    addChannel(db, u.id, "google", email);
    db.prepare(
      "UPDATE authorized_emails SET used_at = datetime('now'), handle = COALESCE(handle, ?) WHERE email = ?",
    ).run(handle, email);
    return { user: getUser(db, u.id) as User, created: true };
  });
  return tx();
}

/** Gate de signup/login por email (magic link), atómico. Espejo de
 *  `registerGoogleUserIfAuthorized` pero con UNIFICACIÓN por email: la misma persona puede
 *  haber entrado antes por Google (identidad `google:<email>`), así que reusamos esa cuenta en
 *  vez de crear una segunda. Dado un email:
 *   - si ya existe un usuario ACTIVO con identidad `email:<email>` O `google:<email>` → lo devuelve
 *     (created:false) asegurando idempotente la identidad `email` (sin ella, el login web por
 *     mail —resolveUser("email", …)— no resolvería a una cuenta que entró sólo por Google);
 *   - si existe un usuario DISABLED con identidad `email:<email>` O `google:<email>` y el email
 *     está autorizado → re-activa la cuenta (status='active', created:false); si NO está
 *     autorizado → undefined (deny limpio, sin crash UNIQUE);
 *   - si no existe pero el email está en la allowlist → crea el usuario (backend_mode='local',
 *     status active), le agrega la identidad `email`, marca el entry como usado, y lo devuelve
 *     (created:true);
 *   - si no existe y NO está autorizado → devuelve undefined (el caller responde 200 igual,
 *     anti-enumeración: nunca revela si el email está en la allowlist).
 *  Todo en una transacción: el chequeo de autorización y el alta no se separan (sin ventana de
 *  confused-deputy), y la UNIQUE(channel,external_id) hace race-safe el doble-start concurrente. */
export function registerEmailUserIfAuthorized(
  db: Db,
  emailRaw: string,
): { user: User; created: boolean } | undefined {
  const email = emailRaw.trim().toLowerCase();
  if (!email) return undefined;
  const tx = db.transaction((): { user: User; created: boolean } | undefined => {
    const existing = resolveUser(db, "email", email) ?? resolveUser(db, "google", email);
    if (existing) {
      if (!listChannels(db, existing.id).some((c) => c.channel === "email" && c.external_id === email)) {
        addChannel(db, existing.id, "email", email);
      }
      return { user: getUser(db, existing.id) as User, created: false };
    }
    // Detectar usuario disabled con la misma identidad ANTES de intentar INSERT (evita UNIQUE crash).
    // Incluye unificación google+email igual que el camino activo de arriba.
    const disabled = resolveUserAny(db, "email", email) ?? resolveUserAny(db, "google", email);
    if (disabled) {
      // La identidad ya existe → no podemos crear un usuario nuevo.
      const entry = getAuthorizedEmail(db, email);
      if (!entry) return undefined; // NO autorizado → deny limpio, sin crash
      // Re-autorizado: re-activar la cuenta existente en vez de duplicar.
      console.log(`[store] re-enabling disabled user ${disabled.id} (${disabled.handle}) via email login`);
      setUserStatus(db, disabled.id, "active");
      // Asegurar que la identidad email exista (puede que solo tenga google).
      if (!listChannels(db, disabled.id).some((c) => c.channel === "email" && c.external_id === email)) {
        addChannel(db, disabled.id, "email", email);
      }
      return { user: getUser(db, disabled.id) as User, created: false };
    }
    const entry = getAuthorizedEmail(db, email);
    if (!entry) return undefined; // NO autorizado
    const handle = deriveUniqueHandle(db, entry.handle ?? email.split("@")[0] ?? "user");
    const name = entry.name ?? defaultNameFromEmail(email);
    const u = addUser(db, handle, { name });
    setUserBackendMode(db, u.id, "local"); // "vamos todos a archima"
    addChannel(db, u.id, "email", email);
    db.prepare(
      "UPDATE authorized_emails SET used_at = datetime('now'), handle = COALESCE(handle, ?) WHERE email = ?",
    ).run(handle, email);
    return { user: getUser(db, u.id) as User, created: true };
  });
  return tx();
}

// --- Repos (N:N con usuarios vía repo_access) ----------------------------
/** Registra un repo (org/name) con un label opcional. El repo en GitHub lo crea @ceibo/wikis. */
export function addRepo(db: Db, org: string, name: string, label?: string): Repo {
  const info = db
    .prepare("INSERT INTO repos (org, name, label) VALUES (?, ?, ?)")
    .run(org, name, label ?? null);
  return db.prepare("SELECT * FROM repos WHERE id = ?").get(Number(info.lastInsertRowid)) as Repo;
}

export function getRepoByName(db: Db, org: string, name: string): Repo | undefined {
  return db.prepare("SELECT * FROM repos WHERE org = ? AND name = ?").get(org, name) as Repo | undefined;
}

/** Setea (o limpia, con null) el alias de una wiki. No renombra el repo de GitHub. */
export function setRepoLabel(db: Db, repoId: number, label: string | null): void {
  db.prepare("UPDATE repos SET label = ? WHERE id = ?").run(label, repoId);
}

/** Marca `repoId` como la wiki PERSONAL de su dueño (personal=1 → no borrable/no archivable).
 *  Mantiene la invariante "una sola personal por dueño": limpia personal en las otras wikis del
 *  mismo owner antes de marcar ésta. Útil para usuarios renombrados, donde la wiki personal quedó
 *  con el nombre del handle viejo y la migración F1 (que busca `<handle>-personal`) no la detecta. */
export function setRepoPersonal(db: Db, repoId: number): void {
  const tx = db.transaction(() => {
    const owners = db
      .prepare("SELECT user_id FROM repo_access WHERE repo_id = ? AND role = 'owner'")
      .all(repoId) as { user_id: number }[];
    // Limpiamos personal=1 de TODAS las wikis cuyos dueños son los del repo objetivo.
    for (const o of owners) {
      db.prepare(
        `UPDATE repos SET personal = 0
         WHERE id IN (SELECT ra.repo_id FROM repo_access ra WHERE ra.user_id = ? AND ra.role = 'owner')`,
      ).run(o.user_id);
    }
    db.prepare("UPDATE repos SET personal = 1 WHERE id = ?").run(repoId);
  });
  tx();
}

/** Renombra un repo en el STORE (nombre + label) y repunta cualquier `active_wiki` que
 *  apuntaba al nombre viejo (se guarda por nombre). El rename en GitHub lo hace @ceibo/wikis;
 *  llamar a esto DESPUÉS de que GitHub confirmó. Atómico (una transacción). Fase 16. */
export function renameRepoInStore(
  db: Db,
  repoId: number,
  oldName: string,
  newName: string,
  label: string,
): void {
  const tx = db.transaction(() => {
    db.prepare("UPDATE repos SET name = ?, label = ? WHERE id = ?").run(newName, label, repoId);
    db.prepare("UPDATE users SET active_wiki = ? WHERE active_wiki = ?").run(newName, oldName);
  });
  tx();
}

/** Quita el repo del store (cascada a repo_access). NO toca GitHub. */
export function removeRepo(db: Db, repoId: number): void {
  db.prepare("DELETE FROM repos WHERE id = ?").run(repoId);
}

/** Soft-delete global de una wiki (sólo el store; el repo de GitHub no se toca en v1).
 *  Setea `repos.deleted_at`. Desaparece para TODOS los miembros. Reversible por admin.
 *  También limpia `active_wiki` de todos los usuarios que apuntaban a este repo. */
export function softDeleteRepo(db: Db, repoId: number): void {
  const repo = db.prepare("SELECT name FROM repos WHERE id = ?").get(repoId) as { name: string } | undefined;
  const tx = db.transaction(() => {
    db.prepare("UPDATE repos SET deleted_at = datetime('now') WHERE id = ?").run(repoId);
    if (repo) {
      db.prepare("UPDATE users SET active_wiki = NULL WHERE active_wiki = ?").run(repo.name);
    }
  });
  tx();
}

/** Recupera una wiki soft-borrada (admin). Limpia `deleted_at`. */
export function recoverRepo(db: Db, repoId: number): void {
  db.prepare("UPDATE repos SET deleted_at = NULL WHERE id = ?").run(repoId);
}

/** Lista las wikis soft-borradas (para admin). */
export function listSoftDeleted(db: Db): Repo[] {
  return db
    .prepare("SELECT * FROM repos WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")
    .all() as Repo[];
}

/** Borra físicamente una wiki del store (hard-delete, admin). Cascada a repo_access, wiki_invites, etc.
 *  El repo de GitHub es responsabilidad del caller (fuera de v1). */
export function purgeRepo(db: Db, repoId: number): void {
  db.prepare("DELETE FROM repos WHERE id = ?").run(repoId);
}

/** Lista todos los repos activos (deleted_at IS NULL) por default.
 *  Pasa `{ includeDeleted: true }` para incluir los soft-borrados (admin).
 *  Lo usa REM (solo wikis activas) y el CLI (idem). */
export function listAllRepos(db: Db, opts?: { includeDeleted?: boolean }): Repo[] {
  if (opts?.includeDeleted) {
    return db.prepare("SELECT * FROM repos ORDER BY org, name").all() as Repo[];
  }
  return db.prepare("SELECT * FROM repos WHERE deleted_at IS NULL ORDER BY org, name").all() as Repo[];
}

/** Da acceso de un usuario a un repo con un rol opcional (default 'member'). Idempotente:
 *  si ya existe el acceso, lo deja como está (INSERT OR IGNORE). Si el usuario YA tiene acceso
 *  y se pasa `role`, actualiza el rol (para el backfill y para `grantAccess(role='owner')`
 *  al crear). */
export function grantAccess(
  db: Db,
  repoId: number,
  userId: number,
  role: "owner" | "member" = "member",
): void {
  db.prepare(
    `INSERT INTO repo_access (repo_id, user_id, role) VALUES (?, ?, ?)
     ON CONFLICT (repo_id, user_id) DO UPDATE SET role = excluded.role`,
  ).run(repoId, userId, role);
}

export function revokeAccess(db: Db, repoId: number, userId: number): void {
  db.prepare("DELETE FROM repo_access WHERE repo_id = ? AND user_id = ?").run(repoId, userId);
}

/** Rol de un usuario en un repo, o undefined si no tiene acceso. */
export function roleOf(db: Db, repoId: number, userId: number): "owner" | "member" | undefined {
  const row = db
    .prepare("SELECT role FROM repo_access WHERE repo_id = ? AND user_id = ?")
    .get(repoId, userId) as { role: string } | undefined;
  return row?.role as "owner" | "member" | undefined;
}

/** ¿Es el usuario dueño de este repo? */
export function isOwner(db: Db, repoId: number, userId: number): boolean {
  return roleOf(db, repoId, userId) === "owner";
}

/** ¿Es el usuario miembro (cualquier rol) de este repo? */
export function isMember(db: Db, repoId: number, userId: number): boolean {
  return roleOf(db, repoId, userId) !== undefined;
}

/** Dueño de un repo (fuente de verdad: role='owner' en repo_access). undefined si no hay
 *  ningún owner materializado (fallback: usar firstUserForRepo). */
export function ownerOf(db: Db, repoId: number): User | undefined {
  return db
    .prepare(
      `SELECT u.* FROM users u
       JOIN repo_access ra ON ra.user_id = u.id
       WHERE ra.repo_id = ? AND ra.role = 'owner'
       LIMIT 1`,
    )
    .get(repoId) as User | undefined;
}

/** Archiva una wiki para un usuario (sale de su contexto; otros miembros no se ven afectados).
 *  Si `active_wiki` del usuario apuntaba a esta wiki, la limpia (vuelve a "todas").
 *  Idempotente: si ya está archivada, no-op. NO archiva wikis personales (el caller debe
 *  verificar `repos.personal` antes; acá sólo persistimos). */
export function archiveForUser(db: Db, repoId: number, userId: number): void {
  const repo = db.prepare("SELECT name FROM repos WHERE id = ?").get(repoId) as { name: string } | undefined;
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE repo_access SET archived_at = datetime('now') WHERE repo_id = ? AND user_id = ? AND archived_at IS NULL",
    ).run(repoId, userId);
    if (repo) {
      db.prepare("UPDATE users SET active_wiki = NULL WHERE id = ? AND active_wiki = ?").run(
        userId,
        repo.name,
      );
    }
  });
  tx();
}

/** Desarchiva una wiki para un usuario. Aditivo (sin reset de sesión). Idempotente. */
export function unarchiveForUser(db: Db, repoId: number, userId: number): void {
  db.prepare("UPDATE repo_access SET archived_at = NULL WHERE repo_id = ? AND user_id = ?").run(
    repoId,
    userId,
  );
}

/** Repos a los que un usuario tiene acceso (los que se montan en su sesión).
 *  Por default filtra repos soft-borrados (deleted_at IS NULL) Y archivados por el usuario
 *  (archived_at IS NULL). Pasa `{ includeArchived: true }` para incluir los archivados (vista
 *  "archivo" de la web). */
export function listReposForUser(db: Db, userId: number, opts?: { includeArchived?: boolean }): Repo[] {
  if (opts?.includeArchived) {
    return db
      .prepare(
        `SELECT r.* FROM repos r
         JOIN repo_access ra ON ra.repo_id = r.id
         WHERE ra.user_id = ? AND r.deleted_at IS NULL
         ORDER BY r.org, r.name`,
      )
      .all(userId) as Repo[];
  }
  return db
    .prepare(
      `SELECT r.* FROM repos r
       JOIN repo_access ra ON ra.repo_id = r.id
       WHERE ra.user_id = ? AND r.deleted_at IS NULL AND ra.archived_at IS NULL
       ORDER BY r.org, r.name`,
    )
    .all(userId) as Repo[];
}

/** Repos que el usuario archivó (archived_at IS NOT NULL). Incluye el campo archived_at
 *  del join con repo_access para que el caller no necesite una segunda consulta. */
export interface RepoWithArchived extends Repo {
  archived_at: string;
}

export function listArchivedReposForUser(db: Db, userId: number): RepoWithArchived[] {
  return db
    .prepare(
      `SELECT r.*, ra.archived_at FROM repos r
       JOIN repo_access ra ON ra.repo_id = r.id
       WHERE ra.user_id = ? AND r.deleted_at IS NULL AND ra.archived_at IS NOT NULL
       ORDER BY r.org, r.name`,
    )
    .all(userId) as RepoWithArchived[];
}

/** Usuarios con acceso a un repo (para ver con quién se comparte). */
export function usersForRepo(db: Db, repoId: number): User[] {
  return db
    .prepare(
      `SELECT u.* FROM users u
       JOIN repo_access ra ON ra.user_id = u.id
       WHERE ra.repo_id = ? ORDER BY u.handle`,
    )
    .all(repoId) as User[];
}

// --- Wiki invites (F1 wiki-management) ------------------------------------
// Invitaciones por email a usuarios que todavía no tienen cuenta. Se materializan
// en grant al registrarse/loguearse (acceptInvitesForEmail).

export interface WikiInvite {
  repo_id: number;
  email: string; // lowercased
  invited_by: number;
  created_at: string;
  accepted_at: string | null;
  /** Token del link de mail (hex 32 chars). NULL solo en filas muy viejas antes del backfill de P1. */
  accept_token: string | null;
}

/** Agrega una invitación por email a una wiki (idempotente: ON CONFLICT DO NOTHING —
 *  si ya existe una pendiente para (repo, email), no la pisa). Genera `accept_token`
 *  automáticamente para los nuevos invites (P1: token del link de mail). */
export function addInvite(db: Db, repoId: number, email: string, invitedBy: number): WikiInvite {
  const normalized = email.trim().toLowerCase();
  const token = randomBytes(16).toString("hex");
  db.prepare(
    `INSERT INTO wiki_invites (repo_id, email, invited_by, accept_token) VALUES (?, ?, ?, ?)
     ON CONFLICT (repo_id, email) DO NOTHING`,
  ).run(repoId, normalized, invitedBy, token);
  return db
    .prepare("SELECT * FROM wiki_invites WHERE repo_id = ? AND email = ?")
    .get(repoId, normalized) as WikiInvite;
}

/** Lista las invitaciones de una wiki (incluidas ya aceptadas). */
export function listInvitesForRepo(db: Db, repoId: number): WikiInvite[] {
  return db
    .prepare("SELECT * FROM wiki_invites WHERE repo_id = ? ORDER BY created_at")
    .all(repoId) as WikiInvite[];
}

/** Lista las invitaciones pendientes para un email (accepted_at IS NULL). */
export function listPendingInvitesForEmail(db: Db, email: string): WikiInvite[] {
  const normalized = email.trim().toLowerCase();
  return db
    .prepare("SELECT * FROM wiki_invites WHERE email = ? AND accepted_at IS NULL ORDER BY created_at")
    .all(normalized) as WikiInvite[];
}

/** Materializa los invites pendientes de un email: por cada uno hace grantAccess(role='member')
 *  y marca accepted_at. Idempotente: el grantAccess tiene ON CONFLICT DO UPDATE (no duplica).
 *  Lo llama el path de alta/login tras resolver el userId. */
export function acceptInvitesForEmail(db: Db, email: string, userId: number): number {
  const normalized = email.trim().toLowerCase();
  const pending = listPendingInvitesForEmail(db, normalized);
  if (pending.length === 0) return 0;
  const markAccepted = db.prepare(
    "UPDATE wiki_invites SET accepted_at = datetime('now') WHERE repo_id = ? AND email = ?",
  );
  const tx = db.transaction(() => {
    for (const inv of pending) {
      grantAccess(db, inv.repo_id, userId, "member");
      markAccepted.run(inv.repo_id, normalized);
    }
  });
  tx();
  return pending.length;
}

/** Borra una invitación puntual (el dueño la revoca). NO toca authorized_emails.
 *  Devuelve true si había una fila que borrar. */
export function removeInvite(db: Db, repoId: number, email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return (
    db.prepare("DELETE FROM wiki_invites WHERE repo_id = ? AND email = ?").run(repoId, normalized).changes > 0
  );
}

/** Busca una invitación por su accept_token (el token del link de mail).
 *  Devuelve la fila completa o undefined si no existe (o ya fue revocada). */
export function getInviteByToken(db: Db, token: string): WikiInvite | undefined {
  return db.prepare("SELECT * FROM wiki_invites WHERE accept_token = ?").get(token) as WikiInvite | undefined;
}

// --- Waiting list (P1 invitaciones) ---------------------------------------
// Cola de admisión al sistema. Una fila por persona (email PK).
// Aprobar = INSERT en authorized_emails. La fila queda como auditoría.
// Callers de P2–P6: ver spec invitations-waitlist-spec.md §4.6.

export type WaitingStatus = "pending" | "approved" | "rejected";
export type WaitingSource = "invited" | "self-signup";

export interface WaitingEntry {
  email: string;
  source: WaitingSource;
  status: WaitingStatus;
  invited_by: number | null;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: number | null;
}

/** Fila de listWaitingList: el resultado del JOIN que incluye el handle del invitador
 *  y las wikis pendientes para ese email. */
export interface WaitingListRow extends WaitingEntry {
  /** handle del usuario que invitó (NULL si self-signup o usuario borrado). */
  inviter_handle: string | null;
  /** Repos que el email tiene en wiki_invites pendientes (aún no materializados).
   *  JSON array de {repo_id, org, name} — puede ser vacío. */
  pending_wikis: Array<{ repo_id: number; org: string; name: string }>;
}

/** Agrega o no-op un email en la waitlist (upsert-no-op por PK).
 *  - source='invited' si el email tiene un wiki_invite pendiente; 'self-signup' si vino solo.
 *  - invited_by: el invited_by del invite más antiguo pendiente (o el que pase opts.invitedBy).
 *  Si ya existe una fila (cualquier status), devuelve {alreadyWaiting: true, entry}.
 *  Si es nueva, devuelve {alreadyWaiting: false, entry}. Idempotente. */
export function addToWaitingList(
  db: Db,
  emailRaw: string,
  opts?: { source?: WaitingSource; invitedBy?: number },
): { alreadyWaiting: boolean; entry: WaitingEntry } {
  const email = emailRaw.trim().toLowerCase();

  // Detectar provenance: si hay un invite pendiente, es 'invited'.
  let source: WaitingSource = opts?.source ?? "self-signup";
  let invitedBy: number | null = opts?.invitedBy ?? null;
  if (source === "self-signup" || invitedBy === null) {
    const oldestInvite = db
      .prepare(
        "SELECT invited_by FROM wiki_invites WHERE email = ? AND accepted_at IS NULL ORDER BY created_at ASC LIMIT 1",
      )
      .get(email) as { invited_by: number } | undefined;
    if (oldestInvite) {
      source = "invited";
      invitedBy = oldestInvite.invited_by;
    }
  }

  const existing = db.prepare("SELECT * FROM waiting_list WHERE email = ?").get(email) as
    | WaitingEntry
    | undefined;
  if (existing) return { alreadyWaiting: true, entry: existing };

  db.prepare("INSERT INTO waiting_list (email, source, invited_by) VALUES (?, ?, ?)").run(
    email,
    source,
    invitedBy,
  );

  return {
    alreadyWaiting: false,
    entry: db.prepare("SELECT * FROM waiting_list WHERE email = ?").get(email) as WaitingEntry,
  };
}

/** Devuelve la entrada de waitlist para un email, o undefined si no existe. */
export function getWaitingEntry(db: Db, emailRaw: string): WaitingEntry | undefined {
  const email = emailRaw.trim().toLowerCase();
  return db.prepare("SELECT * FROM waiting_list WHERE email = ?").get(email) as WaitingEntry | undefined;
}

/** Lista las entradas de la waitlist (todas o filtradas por status).
 *  Cada fila incluye el handle del invitador y las wikis pendientes (JOIN). */
export function listWaitingList(db: Db, opts?: { status?: WaitingStatus }): WaitingListRow[] {
  const where = opts?.status ? "WHERE w.status = ?" : "";
  const rows = (
    opts?.status
      ? db
          .prepare(
            `SELECT w.*, u.handle AS inviter_handle
             FROM waiting_list w
             LEFT JOIN users u ON u.id = w.invited_by
             ${where}
             ORDER BY w.created_at ASC`,
          )
          .all(opts.status)
      : db
          .prepare(
            `SELECT w.*, u.handle AS inviter_handle
             FROM waiting_list w
             LEFT JOIN users u ON u.id = w.invited_by
             ORDER BY w.created_at ASC`,
          )
          .all()
  ) as Array<WaitingEntry & { inviter_handle: string | null }>;

  return rows.map((r) => {
    const pendingWikisRaw = db
      .prepare(
        `SELECT wi.repo_id, re.org, re.name
         FROM wiki_invites wi
         JOIN repos re ON re.id = wi.repo_id
         WHERE wi.email = ? AND wi.accepted_at IS NULL`,
      )
      .all(r.email) as Array<{ repo_id: number; org: string; name: string }>;
    return {
      ...r,
      pending_wikis: pendingWikisRaw,
    };
  });
}

/** Aprueba un email de la waitlist (transacción atómica):
 *  1. Pone status='approved' + reviewed_at/reviewed_by.
 *  2. Llama addAuthorizedEmail (el gate real de registro).
 *  Idempotente: si ya está aprobada, actualiza reviewed_* y re-upsertea authorized_emails.
 *  opts.name/handle se pasan como seeds para la cuenta (authorized_emails). */
export function approveWaitingEmail(
  db: Db,
  emailRaw: string,
  reviewerId: number,
  opts?: { name?: string; handle?: string },
): WaitingEntry {
  const email = emailRaw.trim().toLowerCase();
  const tx = db.transaction((): WaitingEntry => {
    db.prepare(
      `UPDATE waiting_list
       SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ?
       WHERE email = ?`,
    ).run(reviewerId, email);
    addAuthorizedEmail(db, email, { name: opts?.name, handle: opts?.handle });
    return db.prepare("SELECT * FROM waiting_list WHERE email = ?").get(email) as WaitingEntry;
  });
  return tx();
}

/** Rechaza un email de la waitlist (marca status='rejected' + reviewed_at/reviewed_by).
 *  Idempotente. NO toca authorized_emails. */
export function rejectWaitingEmail(db: Db, emailRaw: string, reviewerId: number): WaitingEntry {
  const email = emailRaw.trim().toLowerCase();
  db.prepare(
    `UPDATE waiting_list
     SET status = 'rejected', reviewed_at = datetime('now'), reviewed_by = ?
     WHERE email = ?`,
  ).run(reviewerId, email);
  return db.prepare("SELECT * FROM waiting_list WHERE email = ?").get(email) as WaitingEntry;
}

// --- Admin helpers (P1 invitaciones) --------------------------------------

/** True si el usuario tiene el flag admin=1 en la DB. */
export function isAdmin(db: Db, userId: number): boolean {
  const row = db.prepare("SELECT admin FROM users WHERE id = ?").get(userId) as { admin: number } | undefined;
  return (row?.admin ?? 0) === 1;
}

/** Setea o limpia el flag admin de un usuario. */
export function setAdmin(db: Db, userId: number, on: boolean): void {
  db.prepare("UPDATE users SET admin = ? WHERE id = ?").run(on ? 1 : 0, userId);
}

/** @deprecated P1 invitaciones: el auto-whitelist de F6 se elimina en P2 junto con su
 *  único caller (POST /api/wiki/invite en web-server). La whitelist solo la gestiona
 *  el admin (approveWaitingEmail o ./ceibo allow add). No borrar hasta que P2 lo saque. */
export function ensureAuthorizedEmailForInvite(db: Db, emailRaw: string, note: string): boolean {
  const email = emailRaw.trim().toLowerCase();
  const result = db
    .prepare("INSERT INTO authorized_emails (email, note) VALUES (?, ?) ON CONFLICT(email) DO NOTHING")
    .run(email, note);
  return result.changes > 0;
}

// --- Acceso N:N (continuación) -------------------------------------------

/** "Dueño" de un repo (Fase 16, cron de REM): el PRIMER usuario activo con acceso (por orden
 *  de alta). El cron corre REM por repo una sola vez, atribuido a su dueño; una wiki compartida
 *  tiene un dueño => no se corre dos veces. undefined si nadie activo tiene acceso. */
export function firstUserForRepo(db: Db, repoId: number): User | undefined {
  return db
    .prepare(
      `SELECT u.* FROM users u
       JOIN repo_access ra ON ra.user_id = u.id
       WHERE ra.repo_id = ? AND u.status = 'active'
       ORDER BY ra.created_at ASC, u.id ASC LIMIT 1`,
    )
    .get(repoId) as User | undefined;
}

// --- Enrollment OAuth (links de un solo uso) -----------------------------
const ENROLL_TOKEN_TTL_MIN = 30;

/** Mintea un token de enrollment para un usuario + servicio + perfil. Va en el link
 *  `/oauth/start?t=<token>` que se le manda a la persona. Único, no adivinable.
 *  `profile` default "default" (cuenta única); otro valor = multi-cuenta (Fase 7). */
export function createEnrollToken(db: Db, userId: number, service: string, profile = "default"): string {
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO enroll_tokens (token, user_id, service, profile) VALUES (?, ?, ?, ?)").run(
    token,
    userId,
    service,
    profile,
  );
  return token;
}

export interface EnrollClaim {
  userId: number;
  service: string;
  profile: string;
}

/** Valida un token de enrollment (existe, no usado, dentro del TTL) SIN consumirlo.
 *  El consumo (single-use) se hace al COMPLETAR el OAuth (markEnrollTokenUsed), no al
 *  abrir el link — así un prefetch (ej. el preview de Telegram) no lo quema. */
export function peekEnrollToken(db: Db, token: string): EnrollClaim | undefined {
  const row = db
    .prepare(
      `SELECT user_id, service, profile FROM enroll_tokens
       WHERE token = ? AND used_at IS NULL AND created_at >= datetime('now', ?)`,
    )
    .get(token, `-${ENROLL_TOKEN_TTL_MIN} minutes`) as
    | { user_id: number; service: string; profile: string }
    | undefined;
  return row ? { userId: row.user_id, service: row.service, profile: row.profile } : undefined;
}

/** Marca un token de enrollment como usado (al completar el OAuth). Idempotente. */
export function markEnrollTokenUsed(db: Db, token: string): void {
  db.prepare("UPDATE enroll_tokens SET used_at = datetime('now') WHERE token = ? AND used_at IS NULL").run(
    token,
  );
}

// --- Login web (magic link, managed-ui Fase A) ---------------------------
const WEB_LOGIN_TOKEN_TTL_MIN = 5; // ventana corta: el link se canjea al toque

/** Mintea un token de login web para un usuario. Va en el link que manda el bot
 *  (`/web` → `https://<box>/<handle>?t=<token>`). Único, no adivinable, single-use. */
export function createWebLoginToken(db: Db, userId: number): string {
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO web_login_tokens (token, user_id) VALUES (?, ?)").run(token, userId);
  return token;
}

/** Valida un token de login web (existe, no usado, dentro del TTL) SIN consumirlo. */
export function peekWebLoginToken(db: Db, token: string): number | undefined {
  const row = db
    .prepare(
      `SELECT user_id FROM web_login_tokens
       WHERE token = ? AND used_at IS NULL AND created_at >= datetime('now', ?)`,
    )
    .get(token, `-${WEB_LOGIN_TOKEN_TTL_MIN} minutes`) as { user_id: number } | undefined;
  return row?.user_id;
}

/** Marca un token de login web como usado (al canjearlo por la cookie). Idempotente. */
export function markWebLoginTokenUsed(db: Db, token: string): void {
  db.prepare("UPDATE web_login_tokens SET used_at = datetime('now') WHERE token = ? AND used_at IS NULL").run(
    token,
  );
}

// --- Contraseña de login web (email + password, allowlist) ----------------
// El email se allowlistea como identidad de canal `email` (igual que `google`); estas
// funciones manejan SOLO el verificador. Hash scrypt con salt aleatorio por usuario,
// formato `scrypt$N$r$p$salt_b64$hash_b64`. Parámetros embebidos → re-hashear con costo
// más alto en el futuro no invalida los hashes viejos (cada uno lleva sus N/r/p).
const SCRYPT_N = 16384; // 2^14: ~lo recomendado para login interactivo
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

function hashPassword(plaintext: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(plaintext, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${dk.toString("base64")}`;
}

/** Verifica un plaintext contra un hash con parámetros embebidos. Tiempo constante. */
function verifyHash(plaintext: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const want = Buffer.from(hashB64 ?? "", "base64");
  if (want.length === 0) return false;
  let got: Buffer;
  try {
    got = scryptSync(plaintext, Buffer.from(saltB64 ?? "", "base64"), want.length, { N, r, p });
  } catch {
    return false; // parámetros corruptos (ej. N no potencia de 2) → no autentica
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Setea (o reemplaza) la contraseña web de un usuario. La llama el admin por CLI. */
export function setUserPassword(db: Db, userId: number, plaintext: string): void {
  if (plaintext.length === 0) throw new Error("la contraseña no puede ser vacía");
  db.prepare(
    `INSERT INTO web_passwords (user_id, hash, set_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, set_at = excluded.set_at`,
  ).run(userId, hashPassword(plaintext));
}

/** True si el usuario tiene una contraseña web seteada. */
export function hasUserPassword(db: Db, userId: number): boolean {
  return db.prepare("SELECT 1 FROM web_passwords WHERE user_id = ?").get(userId) !== undefined;
}

/** Verifica la contraseña de un usuario. False si no tiene password seteada o no matchea. */
export function verifyUserPassword(db: Db, userId: number, plaintext: string): boolean {
  const row = db.prepare("SELECT hash FROM web_passwords WHERE user_id = ?").get(userId) as
    | { hash: string }
    | undefined;
  return row ? verifyHash(plaintext, row.hash) : false;
}

// --- Conexiones (servicios OAuth conectados por usuario) -----------------
export interface Connection {
  service: string;
  profile: string;
}

/** Marca un servicio+perfil como conectado para un usuario (idempotente; lo llama oauth). */
export function recordConnection(db: Db, userId: number, service: string, profile = "default"): void {
  db.prepare(
    `INSERT INTO connections (user_id, service, profile) VALUES (?, ?, ?)
     ON CONFLICT (user_id, service, profile) DO UPDATE SET connected_at = datetime('now')`,
  ).run(userId, service, profile);
}

/** Saca la marca de conexión (lo llama oauth al revocar). `profile` undefined =
 *  saca TODOS los perfiles de ese servicio. */
export function removeConnection(db: Db, userId: number, service: string, profile?: string): void {
  if (profile === undefined) {
    db.prepare("DELETE FROM connections WHERE user_id = ? AND service = ?").run(userId, service);
  } else {
    db.prepare("DELETE FROM connections WHERE user_id = ? AND service = ? AND profile = ?").run(
      userId,
      service,
      profile,
    );
  }
}

/** Servicios+perfiles que un usuario tiene conectados (para /connections). */
export function listConnections(db: Db, userId: number): Connection[] {
  return db
    .prepare("SELECT service, profile FROM connections WHERE user_id = ? ORDER BY service, profile")
    .all(userId) as Connection[];
}

// --- Grants OAuth del broker (refresh del lado nuestro) ------------------
export interface OauthGrant {
  user_id: number;
  service: string;
  profile: string;
  provider: string;
  mcp_url: string;
  display_name: string;
  /** Cuenta externa real (ej. "user@example.com", workspace de Notion). NULL = desconocida
   *  o no obtenible con el scope actual del grant. */
  account: string | null;
  /** ISO en que el refresh murió con invalid_grant (refresh token expirado → reconectar). NULL =
   *  sano. Estado del grant (para UI/lógica). Se limpia al reconectar (grant fresco) o si un refresh
   *  vuelve a andar. */
  broken_at: string | null;
  /** ISO en que se ENTREGÓ con éxito la notificación de rotura (item durable en el 🔔). NULL = aún
   *  no avisamos bien → reintentar. Anti-spam de la notif (mira ESTO, no broken_at). Se limpia junto
   *  con broken_at al reconectar. */
  notified_at: string | null;
  refresh_token: string | null;
  access_token: string;
  expires_at: string | null;
  scope: string;
}

// A3 (auditoría 2026-06-08): `refresh_token`/`access_token` se cifran at-rest (AES-256-GCM,
// clave `OAUTH_ENC_KEY` fuera de la DB). Ciframos al escribir (`upsertOauthGrant`) y
// desciframos al leer (helper `decryptGrant`). El COALESCE del upsert conserva el blob ya
// cifrado del refresh previo cuando el nuevo viene null → no hay que re-cifrar nada.
/** Descifra los tokens de una fila de grant. Si falla (clave equivocada, o fila vieja en
 *  claro de antes del cifrado) NO crashea: loguea y devuelve undefined → el caller la trata
 *  como "no conectado" (el usuario re-conecta). */
function decryptGrant(row: OauthGrant | undefined): OauthGrant | undefined {
  if (!row) return undefined;
  try {
    return {
      ...row,
      refresh_token: row.refresh_token === null ? null : decryptToken(row.refresh_token),
      access_token: decryptToken(row.access_token),
    };
  } catch (e) {
    console.warn(
      `[store] grant ${row.user_id}/${row.service}/${row.profile}: no se pudo descifrar (${(e as Error).message}) — tratado como no conectado`,
    );
    return undefined;
  }
}

/** Upsert del grant de un usuario+servicio+perfil (lo escribe el broker al enrolar y
 *  en cada refresh). Conserva refresh_token previo si el nuevo viene null (algunos
 *  providers no rotan el refresh_token en cada refresh). Cifra los tokens at-rest (A3). */
export function upsertOauthGrant(db: Db, g: OauthGrant): void {
  const enc: OauthGrant = {
    ...g,
    refresh_token: g.refresh_token === null ? null : encryptToken(g.refresh_token),
    access_token: encryptToken(g.access_token),
  };
  db.prepare(
    // `broken_at`/`notified_at` se escriben TAL CUAL vienen (no COALESCE): un upsert exitoso = grant
    // sano, así que enrolar (callback OAuth) o un refresh que anduvo los dejan en NULL y limpian una
    // rotura previa Y su sello de notif. La marca de rotura y el sello viven aparte
    // (`markGrantBroken` / `sealGrantNotified`), fuera del path de escritura del token.
    `INSERT INTO oauth_grants (user_id, service, profile, provider, mcp_url, display_name, account, broken_at, notified_at, refresh_token, access_token, expires_at, scope, updated_at)
     VALUES (@user_id, @service, @profile, @provider, @mcp_url, @display_name, @account, @broken_at, @notified_at, @refresh_token, @access_token, @expires_at, @scope, datetime('now'))
     ON CONFLICT (user_id, service, profile) DO UPDATE SET
       provider = excluded.provider,
       mcp_url = excluded.mcp_url,
       display_name = excluded.display_name,
       account = COALESCE(excluded.account, oauth_grants.account),
       broken_at = excluded.broken_at,
       notified_at = excluded.notified_at,
       refresh_token = COALESCE(excluded.refresh_token, oauth_grants.refresh_token),
       access_token = excluded.access_token,
       expires_at = excluded.expires_at,
       scope = excluded.scope,
       updated_at = datetime('now')`,
  ).run(enc);
}

/** Setea (o limpia) la cuenta externa de un grant puntual. Lo usa el backfill del oauth al
 *  completar grants viejos sin `account`. No toca tokens ni updated_at. */
export function setOauthGrantAccount(
  db: Db,
  userId: number,
  service: string,
  profile: string,
  account: string | null,
): void {
  db.prepare("UPDATE oauth_grants SET account = ? WHERE user_id = ? AND service = ? AND profile = ?").run(
    account,
    userId,
    service,
    profile,
  );
}

/**
 * Marca un grant como ROTO (refresh murió con invalid_grant → hay que reconectar) seteando
 * `broken_at = now` SÓLO si estaba sano (`broken_at IS NULL`) — idempotente: no re-pisa el ISO de la
 * primera rotura. Devuelve `true` si ESTA llamada hizo la transición sano→roto, `false` si ya estaba
 * roto. (El anti-spam de la NOTIFICACIÓN mira `notified_at`, no esto: aunque el grant ya estuviera
 * roto, si la notif nunca se entregó hay que reintentarla — ver `grantNeedsNotify`.) No toca tokens
 * ni updated_at. El UPDATE condicionado da la transición atómicamente, sin un SELECT+UPDATE con carrera.
 */
export function markGrantBroken(db: Db, userId: number, service: string, profile: string): boolean {
  const res = db
    .prepare(
      "UPDATE oauth_grants SET broken_at = datetime('now') WHERE user_id = ? AND service = ? AND profile = ? AND broken_at IS NULL",
    )
    .run(userId, service, profile);
  return res.changes > 0;
}

/** ¿Este grant está roto pero todavía NO le avisamos con éxito al usuario? (broken_at set y
 *  notified_at NULL). Es el guard de retry-hasta-entregar: el broker devuelve estos grants cada
 *  sweep hasta que la notif se entregue y se selle `notified_at`. */
export function grantNeedsNotify(db: Db, userId: number, service: string, profile: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM oauth_grants WHERE user_id = ? AND service = ? AND profile = ? AND broken_at IS NOT NULL AND notified_at IS NULL",
    )
    .get(userId, service, profile) as { ok: number } | undefined;
  return row !== undefined;
}

/** Sella `notified_at = now` (la notif de rotura se ENTREGÓ con éxito → dejar de reintentar). Sólo
 *  cuando la entrega salió bien (item durable insertado). Condicionado a `broken_at IS NOT NULL`
 *  para no sellar un grant que ya revivió entre el intento y el sello. No toca tokens ni updated_at. */
export function sealGrantNotified(db: Db, userId: number, service: string, profile: string): void {
  db.prepare(
    "UPDATE oauth_grants SET notified_at = datetime('now') WHERE user_id = ? AND service = ? AND profile = ? AND broken_at IS NOT NULL",
  ).run(userId, service, profile);
}

/** Grants (de cualquier usuario) que todavía no tienen `account` resuelto. Lo consume el
 *  backfill del oauth para completarlos best-effort contra el provider. */
export function listGrantsMissingAccount(db: Db): OauthGrant[] {
  const rows = db
    .prepare("SELECT * FROM oauth_grants WHERE account IS NULL ORDER BY user_id, service, profile")
    .all() as OauthGrant[];
  return rows.map(decryptGrant).filter((g): g is OauthGrant => g !== undefined);
}

/** Borra el grant de un usuario+servicio. `profile` undefined = borra TODOS los
 *  perfiles de ese servicio (al desconectar el servicio entero). */
export function deleteOauthGrant(db: Db, userId: number, service: string, profile?: string): void {
  if (profile === undefined) {
    db.prepare("DELETE FROM oauth_grants WHERE user_id = ? AND service = ?").run(userId, service);
  } else {
    db.prepare("DELETE FROM oauth_grants WHERE user_id = ? AND service = ? AND profile = ?").run(
      userId,
      service,
      profile,
    );
  }
}

/** Un grant puntual (user+service+profile), o undefined si no existe. */
export function getOauthGrant(
  db: Db,
  userId: number,
  service: string,
  profile = "default",
): OauthGrant | undefined {
  const row = db
    .prepare("SELECT * FROM oauth_grants WHERE user_id = ? AND service = ? AND profile = ?")
    .get(userId, service, profile) as OauthGrant | undefined;
  return decryptGrant(row);
}

/** Todos los grants de un usuario (para armar los mcp_servers per-sesión + /connections). */
export function listGrantsForUser(db: Db, userId: number): OauthGrant[] {
  const rows = db
    .prepare("SELECT * FROM oauth_grants WHERE user_id = ? ORDER BY service, profile")
    .all(userId) as OauthGrant[];
  return rows.map(decryptGrant).filter((g): g is OauthGrant => g !== undefined);
}

/** Grants de UN usuario que son refrescables (tienen refresh_token y expiran) y cuyo
 *  access_token vence antes de `beforeIso`. El broker refresca lazy: el gateway llama
 *  esto al preparar el turno del usuario y re-mintea solo lo que está por vencer →
 *  la carga escala con usuarios ACTIVOS, no con el total. */
export function listRefreshableGrantsForUser(db: Db, userId: number, beforeIso: string): OauthGrant[] {
  // `refresh_token IS NOT NULL` y `expires_at` no se cifran (la nulabilidad y el ISO de expiry
  // quedan en claro) → el filtro SQL sigue siendo válido; sólo el VALOR del token va cifrado.
  const rows = db
    .prepare(
      `SELECT * FROM oauth_grants
       WHERE user_id = ? AND refresh_token IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ?
       ORDER BY expires_at`,
    )
    .all(userId, beforeIso) as OauthGrant[];
  return rows.map(decryptGrant).filter((g): g is OauthGrant => g !== undefined);
}

// --- Crons / recordatorios (Fase 8) --------------------------------------
/** Qué hace el fire-side con el output del turno del cron. */
export type CronReport = "always" | "never" | "conditional";
/** 'once' = disparo absoluto (se marca done); 'recur' = recurrente (recomputa next_fire). */
export type CronKind = "once" | "recur";

export interface CronRow {
  id: number;
  user_id: number;
  channel: string;
  title: string | null;
  what: string;
  report: CronReport;
  kind: CronKind;
  recur_expr: string | null;
  tz: string;
  next_fire: string;
  status: "active" | "done" | "cancelled";
  created_at: string;
  last_fired_at: string | null;
}

export interface NewCron {
  userId: number;
  channel: string;
  /** Título corto (opcional). Si no se pasa, se deriva del `what`. */
  title?: string;
  what: string;
  report?: CronReport; // default 'always'
  kind: CronKind;
  recurExpr?: string | null; // requerido si kind='recur'
  tz?: string; // default 'UTC'
  nextFire: string; // ISO UTC
}

/** Crea un cron (lo llama el MCP schedule). Devuelve la fila creada. */
export function createCron(db: Db, c: NewCron): CronRow {
  const info = db
    .prepare(
      `INSERT INTO crons (user_id, channel, title, what, report, kind, recur_expr, tz, next_fire)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.userId,
      c.channel,
      c.title?.trim() || deriveCronTitle(c.what),
      c.what,
      c.report ?? "always",
      c.kind,
      c.recurExpr ?? null,
      c.tz ?? "UTC",
      c.nextFire,
    );
  return getCron(db, Number(info.lastInsertRowid)) as CronRow;
}

export function getCron(db: Db, id: number): CronRow | undefined {
  return db.prepare("SELECT * FROM crons WHERE id = ?").get(id) as CronRow | undefined;
}

/** Crons activos vencidos (next_fire <= now). El scheduler barre esto cada tick.
 *  `nowIso` en UTC, mismo formato que next_fire (comparación lexicográfica de ISO). */
export function listCronsDue(db: Db, nowIso: string): CronRow[] {
  return db
    .prepare("SELECT * FROM crons WHERE status = 'active' AND next_fire <= ? ORDER BY next_fire")
    .all(nowIso) as CronRow[];
}

/** Crons activos de un usuario (para schedule_list). */
export function listCronsForUser(db: Db, userId: number): CronRow[] {
  return db
    .prepare("SELECT * FROM crons WHERE user_id = ? AND status = 'active' ORDER BY next_fire")
    .all(userId) as CronRow[];
}

/** Cancela un cron. Acotado a su dueño (un usuario sólo cancela los suyos vía el MCP).
 *  Devuelve true si canceló algo. */
export function cancelCron(db: Db, id: number, userId: number): boolean {
  const info = db
    .prepare("UPDATE crons SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'active'")
    .run(id, userId);
  return info.changes > 0;
}

/** Campos editables de un cron desde la UI (modal de edición). Todos opcionales:
 *  se actualiza sólo lo presente. El caller (endpoint) arma un combo coherente
 *  (ej. si pasa kind='recur' debería pasar recurExpr; si 'once', nextFire). */
export interface CronEdit {
  /** Título corto. '' (vacío) NO se acepta acá; el caller filtra antes. */
  title?: string;
  what?: string;
  kind?: CronKind;
  recurExpr?: string | null;
  tz?: string;
  /** Canal de entrega: 'telegram' | 'whatsapp' | 'all'. El fire-path lo honra (con
   *  fallback a la prioridad si el elegido no está disponible). */
  channel?: string;
  /** Formato de aviso: 'always' (postea al chat) | 'never' (silencioso). 'conditional'
   *  existe en el enum pero NO está implementado en el fire-path → no se expone. */
  report?: CronReport;
  /** Próximo disparo en ISO UTC. Para 'once' es el disparo absoluto; para 'recur'
   *  el caller lo recomputa con nextFireFrom tras cambiar expr/tz. */
  nextFire?: string;
}

/** Edita un cron activo. Acotado al dueño (`id` + `user_id`, sólo si está activo).
 *  Updater parcial: arma el SET dinámico con los campos presentes. Devuelve true si
 *  tocó una fila. No recomputa nada (eso lo hace el caller); acá sólo persiste. */
export function updateCron(db: Db, id: number, userId: number, edit: CronEdit): boolean {
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  if (edit.title !== undefined) {
    sets.push("title = ?");
    vals.push(edit.title);
  }
  if (edit.what !== undefined) {
    sets.push("what = ?");
    vals.push(edit.what);
  }
  if (edit.kind !== undefined) {
    sets.push("kind = ?");
    vals.push(edit.kind);
  }
  if (edit.channel !== undefined) {
    sets.push("channel = ?");
    vals.push(edit.channel);
  }
  if (edit.report !== undefined) {
    sets.push("report = ?");
    vals.push(edit.report);
  }
  if (edit.recurExpr !== undefined) {
    sets.push("recur_expr = ?");
    vals.push(edit.recurExpr);
  }
  if (edit.tz !== undefined) {
    sets.push("tz = ?");
    vals.push(edit.tz);
  }
  if (edit.nextFire !== undefined) {
    sets.push("next_fire = ?");
    vals.push(edit.nextFire);
  }
  if (sets.length === 0) return false; // nada que cambiar
  const info = db
    .prepare(`UPDATE crons SET ${sets.join(", ")} WHERE id = ? AND user_id = ? AND status = 'active'`)
    .run(...vals, id, userId);
  return info.changes > 0;
}

/** Lista crons (TODOS los estados, para inspección admin por CLI). `userId` filtra
 *  por dueño; sin él, todos. Ordena por estado y luego próximo disparo. */
export function listCrons(db: Db, userId?: number): CronRow[] {
  if (userId !== undefined) {
    return db
      .prepare("SELECT * FROM crons WHERE user_id = ? ORDER BY status, next_fire")
      .all(userId) as CronRow[];
  }
  return db.prepare("SELECT * FROM crons ORDER BY status, next_fire").all() as CronRow[];
}

/** Cancela cualquier cron activo por id, sin scope de usuario (override admin por CLI). */
export function adminCancelCron(db: Db, id: number): boolean {
  const info = db.prepare("UPDATE crons SET status = 'cancelled' WHERE id = ? AND status = 'active'").run(id);
  return info.changes > 0;
}

/** Borra los crons ya terminados (done/cancelled), dejando sólo los activos. Devuelve
 *  cuántos borró. Housekeeping: los one-shot disparados y los cancelados se acumulan. */
export function pruneCrons(db: Db): number {
  return db.prepare("DELETE FROM crons WHERE status != 'active'").run().changes;
}

/** Marca un cron one-shot como disparado y terminado. */
export function completeCron(db: Db, id: number): void {
  db.prepare("UPDATE crons SET status = 'done', last_fired_at = datetime('now') WHERE id = ?").run(id);
}

/** Re-agenda un cron recurrente al próximo disparo (lo computa el scheduler). */
export function rescheduleCron(db: Db, id: number, nextFireIso: string): void {
  db.prepare("UPDATE crons SET next_fire = ?, last_fired_at = datetime('now') WHERE id = ?").run(
    nextFireIso,
    id,
  );
}

// --- Inbox del agente (feature crons-delivery) ---------------------------
// Bandeja durable y genérica de cosas que el agente le dejó al usuario para la web. La usa el
// fire-path del gateway cuando un cron tiene `channel === "web"`: persiste SIEMPRE el output (sin
// fallback a Telegram) y, si hay una vista viva, emite además un frame `inbox` en vivo para subir
// el badge al instante. La web la lee con GET /api/inbox y marca leído con los POST.

/** kind del item de inbox. 'cron' es el v1; los demás quedan reservados (REM/sistema/viewer). */
export type InboxKind = "cron" | "rem" | "system" | "viewer";

export interface InboxRow {
  id: number;
  user_id: number;
  kind: InboxKind;
  source_id: number | null;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export interface NewInboxItem {
  userId: number;
  kind: InboxKind;
  sourceId?: number | null;
  title: string;
  body: string;
}

/** Inserta un item de inbox. Devuelve la fila creada (con id/created_at). */
export function addInboxItem(db: Db, item: NewInboxItem): InboxRow {
  const info = db
    .prepare(
      `INSERT INTO inbox (user_id, kind, source_id, title, body)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(item.userId, item.kind, item.sourceId ?? null, item.title, item.body);
  return db.prepare("SELECT * FROM inbox WHERE id = ?").get(Number(info.lastInsertRowid)) as InboxRow;
}

/** Items de inbox de un usuario, más nuevos primero. `limit` acota (default 50). */
export function listInbox(db: Db, userId: number, opts?: { limit?: number }): InboxRow[] {
  const limit = opts?.limit ?? 50;
  return db
    .prepare("SELECT * FROM inbox WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .all(userId, limit) as InboxRow[];
}

/** Cantidad de items no leídos de un usuario (lo que muestra el badge del FAB). */
export function countUnread(db: Db, userId: number): number {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM inbox WHERE user_id = ? AND read_at IS NULL").get(userId) as {
      c: number;
    }
  ).c;
}

/** Marca un item como leído. Acotado a su dueño. Devuelve true si marcó algo (no-op si ya lo estaba). */
export function markInboxRead(db: Db, userId: number, id: number): boolean {
  return (
    db
      .prepare("UPDATE inbox SET read_at = datetime('now') WHERE id = ? AND user_id = ? AND read_at IS NULL")
      .run(id, userId).changes > 0
  );
}

/** Marca TODOS los items no leídos del usuario como leídos. Devuelve cuántos marcó. */
export function markAllInboxRead(db: Db, userId: number): number {
  return db
    .prepare("UPDATE inbox SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL")
    .run(userId).changes;
}

// Recurrencia (cron-expr 5 campos + timezone). El MCP schedule computa el primer
// disparo; el scheduler del gateway recomputa el siguiente tras cada fire. Helpers
// puros (no tocan la DB) pero viven acá por cohesión con el dominio cron + porque
// store es el dep común de mcps y gateway.

/** Próximo disparo (ISO UTC) de un cron-expr en una tz, estrictamente posterior a
 *  `afterIso`. Throws si la expresión o la tz son inválidas (el caller valida antes). */
export function nextFireFrom(expr: string, tz: string, afterIso: string): string {
  const it = CronExpressionParser.parse(expr, { currentDate: new Date(afterIso), tz });
  return it.next().toDate().toISOString();
}

/** Valida un cron-expr (+ tz si se pasa) probando un parse. */
export function isValidCron(expr: string, tz = "UTC"): boolean {
  try {
    CronExpressionParser.parse(expr, { currentDate: new Date(), tz });
    return true;
  } catch {
    return false;
  }
}

// --- Presentación de crons (para el comando /agenda y la API web) --------
// Una sola fuente de verdad de "cómo se lee un cron en humano", reusada por el
// gateway (comando de canal) y el web-server (endpoint /api/crons) → así el cliente
// web recibe los strings ya formateados y no necesita librerías de cron.

/** Vista legible de un cron para listar al usuario (no expone user_id ni internals). */
export interface CronView {
  id: number;
  /** Título corto (siempre presente: el store backfillea/deriva del `what`). */
  title: string;
  what: string;
  kind: CronKind;
  report: CronReport;
  /** Próximo disparo en ISO UTC crudo (por si el cliente quiere reformatear). */
  nextFireIso: string;
  /** Próximo disparo legible, en la tz del cron (es-AR). Ej. "lun 9 jun, 09:00". */
  nextHuman: string;
  /** Recurrencia en español, o null si es one-shot. Ej. "Todos los días a las 09:00". */
  recurHuman: string | null;
  /** Canal de entrega elegido: 'telegram' | 'whatsapp' | 'all'. */
  channel: string;
  tz: string;
  /** Último disparo en ISO UTC, o null si nunca disparó. */
  lastFiredIso: string | null;
}

/** Formatea un instante ISO UTC en la tz dada, en español rioplatense. Tolerante:
 *  si la tz es inválida cae a UTC en vez de tirar (es presentación, no debe romper). */
function humanInstant(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleString("es-AR", {
      timeZone: tz,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return new Date(iso).toISOString();
  }
}

/** Deriva un título corto de un `what` de cron: primera línea no vacía, colapsando
 *  espacios y truncando a ~60 chars (con elipsis si se cortó). Usado para el backfill
 *  de crons existentes y como fallback cuando no hay título explícito. Nunca vacío
 *  salvo que el `what` lo esté (caso degenerado, no debería pasar: `what` es NOT NULL). */
export function deriveCronTitle(what: string): string {
  const firstLine = what.split("\n").find((l) => l.trim().length > 0) ?? what;
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  const MAX = 60;
  if (collapsed.length <= MAX) return collapsed;
  return `${collapsed.slice(0, MAX - 1).trimEnd()}…`;
}

/** Proyecta una fila de cron a su vista legible. Puro (no toca la DB). */
export function viewCron(c: CronRow): CronView {
  let recurHuman: string | null = null;
  if (c.recur_expr) {
    try {
      recurHuman = cronstrue.toString(c.recur_expr, {
        locale: "es",
        use24HourTimeFormat: true,
      });
    } catch {
      // Expresión rara que cronstrue no sabe describir → mostramos la cruda.
      recurHuman = c.recur_expr;
    }
  }
  return {
    id: c.id,
    title: c.title?.trim() || deriveCronTitle(c.what),
    what: c.what,
    kind: c.kind,
    report: c.report,
    nextFireIso: c.next_fire,
    nextHuman: humanInstant(c.next_fire, c.tz),
    recurHuman,
    channel: c.channel,
    tz: c.tz,
    lastFiredIso: c.last_fired_at,
  };
}

// --- Broadcasts (anuncios de la empresa a todos) -------------------------
export interface BroadcastRow {
  id: number;
  text: string;
  sent_count: number;
  failed_count: number;
  created_at: string;
}

/** Registra un anuncio ya enviado (auditoría). Lo llama el gateway tras hacer el
 *  envío real, con la cuenta de destinatarios alcanzados / fallidos. */
export function recordBroadcast(db: Db, text: string, sentCount: number, failedCount: number): BroadcastRow {
  const info = db
    .prepare("INSERT INTO broadcasts (text, sent_count, failed_count) VALUES (?, ?, ?)")
    .run(text, sentCount, failedCount);
  return db
    .prepare("SELECT * FROM broadcasts WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as BroadcastRow;
}

/** Lista los anuncios enviados, del más reciente al más viejo. `limit` acota (default 20). */
export function listBroadcasts(db: Db, limit = 20): BroadcastRow[] {
  return db.prepare("SELECT * FROM broadcasts ORDER BY id DESC LIMIT ?").all(limit) as BroadcastRow[];
}

// Token de identidad de usuario para MCPs propios. Un MCP server público (montado en
// un path-secret COMPARTIDO entre usuarios) no tiene forma de saber QUÉ usuario llama;
// el gateway mintea un token firmado y lo guarda como static_bearer en el vault del
// usuario para la URL de ese MCP → el vault lo inyecta como Bearer, el server lo verifica
// y saca el userId. El path-secret gatea el acceso; el Bearer identifica al usuario.
//
// C1 (auditoría 2026-06-08): la `key` HMAC es ahora una clave DEDICADA por server
// (`<NAME>_MCP_HMAC_KEY`), DISTINTA del path-secret de la URL (`<NAME>_MCP_PATH_SECRET`).
// Antes el path-secret hacía doble rol (gate de URL + clave de firma) y se filtraba en los
// logs de nginx → quien leyera el log podía forjar tokens de cualquier usuario. La key HMAC
// nunca viaja en URL ni logs.
//
// A2 (misma auditoría): el token lleva `exp` embebido en el MAC, igual que el de sesión:
// `<userId>.<expMs>.<hmac("cap.<userId>.<expMs>")>`. El prefijo de dominio `cap.` lo separa
// del token de sesión (que firma `<userId>.<expMs>` sin prefijo) → ni con la misma key un
// token de un mecanismo valida en el otro. Antes era `<userId>.<hmac>` sin caducidad (Bearer
// eterno). Se re-mintean por sesión en el gateway, así que un TTL corto está bien.

/** TTL de un token de capability de identidad (MCP/sync). 24h: se re-mintea por sesión igual. */
export const USER_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Firma un token de identidad de usuario con `exp` (lo mintea el gateway). `key` = la
 *  HMAC key del MCP (`<NAME>_MCP_HMAC_KEY`), NO el path-secret. */
export function signUserToken(
  userId: number,
  key: string,
  now: number = Date.now(),
  ttlMs: number = USER_TOKEN_TTL_MS,
): string {
  const body = `${userId}.${now + ttlMs}`;
  const mac = createHmac("sha256", key).update(`cap.${body}`).digest("base64url");
  return `${body}.${mac}`;
}

/** Verifica un token de identidad: HMAC válido Y no vencido. Devuelve el userId, o undefined. */
export function verifyUserToken(token: string, key: string, now: number = Date.now()): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [uid, exp, mac] = parts;
  if (uid === undefined || exp === undefined || mac === undefined) return undefined;
  const userId = Number(uid);
  const expMs = Number(exp);
  if (!Number.isInteger(userId) || userId <= 0) return undefined;
  if (!Number.isInteger(expMs) || expMs < now) return undefined; // vencido o exp no numérico
  const got = Buffer.from(mac);
  const want = Buffer.from(createHmac("sha256", key).update(`cap.${uid}.${exp}`).digest("base64url"));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
  return userId;
}

// Token del MCP schedule (feature crons-delivery). DIVERGE del token de identidad genérico
// (signUserToken) porque además del userId tiene que llevar el CANAL DE ORIGEN de la sesión, así
// el cron se entrega al canal donde fue creado (web/telegram/whatsapp) en vez del telegram
// hardcodeado. Wire-format de 4 PARTES: `<userId>.<channel>.<exp>.<hmac("sched.<userId>.<channel>.<exp>")>`.
// El prefijo de dominio `sched.` lo separa de los tokens `cap.`/sesión aunque compartan key.
//
// Compat: el `verify` tolera tokens VIEJOS de 3 partes (`<userId>.<exp>.<mac>`, los que minteaba
// el alias de signUserToken) → devuelve `{ channel: undefined }` y el MCP cae al fallback telegram.
// `schedule.ts` (en @ceibo/mcps) es el ÚNICO consumidor de verifyScheduleToken → cambiar su shape
// (de `number` a `{userId, channel?}`) es seguro. NO toca signUserToken/verifyUserToken (genéricos,
// compartidos por wacli/viewer/control/wiki-sync/rem-batch/cookie web).

/** Firma el token de schedule con el canal de origen embebido. `key` = SCHEDULE_MCP_HMAC_KEY. */
export function signScheduleToken(
  userId: number,
  channel: string,
  key: string,
  now: number = Date.now(),
  ttlMs: number = USER_TOKEN_TTL_MS,
): string {
  const body = `${userId}.${channel}.${now + ttlMs}`;
  const mac = createHmac("sha256", key).update(`sched.${body}`).digest("base64url");
  return `${body}.${mac}`;
}

/** Verifica el token de schedule: HMAC válido Y no vencido. Devuelve `{userId, channel?}`, o
 *  undefined. Tolera tokens viejos de 3 partes (canal undefined → fallback telegram en el MCP). */
export function verifyScheduleToken(
  token: string,
  key: string,
  now: number = Date.now(),
): { userId: number; channel?: string } | undefined {
  const parts = token.split(".");
  // 4 partes = token nuevo con canal; 3 partes = token viejo (compat, sin canal).
  if (parts.length === 4) {
    const [uid, channel, exp, mac] = parts as [string, string, string, string];
    const userId = Number(uid);
    const expMs = Number(exp);
    if (!Number.isInteger(userId) || userId <= 0) return undefined;
    if (!Number.isInteger(expMs) || expMs < now) return undefined; // vencido o exp no numérico
    const got = Buffer.from(mac);
    const want = Buffer.from(
      createHmac("sha256", key).update(`sched.${uid}.${channel}.${exp}`).digest("base64url"),
    );
    if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
    return { userId, channel };
  }
  // Compat: token viejo de 3 partes (lo firmaba el alias de signUserToken sobre `cap.<uid>.<exp>`).
  const userId = verifyUserToken(token, key, now);
  return userId === undefined ? undefined : { userId };
}

// Token de SESIÓN web (cookie). Lleva `exp` embebido en el HMAC: `<userId>.<exp>.<hmac>`,
// hmac = HMAC(key, "<userId>.<exp>"). Así un token capturado (o una cookie que sobrevive al
// logout client-side) tiene vida máxima y caduca solo. La key es WEB_SESSION_KEY.
//
// Mismo wire-format de 3 partes que el de capability (signUserToken), pero el de capability
// firma sobre `cap.<userId>.<exp>` (prefijo de dominio) y el de sesión sobre `<userId>.<exp>`
// (sin prefijo) → ni con la misma key un token de un mecanismo valida en el otro. En prod además
// usan keys distintas (WEB_SESSION_KEY vs `<NAME>_MCP_HMAC_KEY`).
export function signSessionToken(userId: number, key: string, expMs: number): string {
  const body = `${userId}.${expMs}`;
  const mac = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** Verifica un token de sesión: HMAC válido Y no vencido. Devuelve el userId, o undefined. */
export function verifySessionToken(token: string, key: string, now: number): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [uid, exp, mac] = parts;
  if (uid === undefined || exp === undefined || mac === undefined) return undefined;
  const userId = Number(uid);
  const expMs = Number(exp);
  if (!Number.isInteger(userId) || userId <= 0) return undefined;
  if (!Number.isInteger(expMs) || expMs < now) return undefined; // vencido o exp no numérico
  const got = Buffer.from(mac);
  const want = Buffer.from(createHmac("sha256", key).update(`${uid}.${exp}`).digest("base64url"));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
  return userId;
}

// --- Sesiones + metering -------------------------------------------------
export function getSession(db: Db, userId: number): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE user_id = ?").get(userId) as SessionRow | undefined;
}

/** Borra el snapshot de sesión del usuario (tabla `sessions`). Lo usa `user set-backend`: al flipear
 *  de backend (`ma`↔`local`) el `session_id` guardado pertenece al backend VIEJO (ej. un id de MA) y
 *  NO debe reusarse como handle del nuevo (el backend local lo trataría como nombre de VM → clona una
 *  VM basura). Devuelve true si había una fila que borrar. */
export function clearUserSession(db: Db, userId: number): boolean {
  return db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes > 0;
}

/** Fija la sesión activa del usuario. Resetea el snapshot (sesión nueva = usage 0). */
export function setSession(db: Db, userId: number, sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions (user_id, session_id, last_input, last_output, last_cache_5m, last_cache_1h, last_cache_read, updated_at)
     VALUES (?, ?, 0, 0, 0, 0, 0, datetime('now'))
     ON CONFLICT (user_id) DO UPDATE SET
       session_id = excluded.session_id,
       last_input = 0, last_output = 0, last_cache_5m = 0, last_cache_1h = 0, last_cache_read = 0,
       updated_at = datetime('now')`,
  ).run(userId, sessionId);
}

/** Usage acumulado de una sesión, tal como lo devuelve sessions.retrieve(). */
export interface CumulativeUsage {
  input: number;
  output: number;
  cache5m: number;
  cache1h: number;
  cacheRead: number;
}

/**
 * Registra un turno por diferencia contra el snapshot guardado y actualiza el
 * snapshot. Devuelve los tokens del turno + costo, o undefined si no hubo delta
 * (nada que cobrar). Atómico.
 */
export function recordTurn(
  db: Db,
  userId: number,
  sessionId: string,
  model: string,
  cum: CumulativeUsage,
): (TurnTokens & { costUsd: number }) | undefined {
  const tx = db.transaction(() => {
    const prev = getSession(db, userId);
    // Si la sesión guardada no coincide, arrancamos snapshot en 0 contra esta.
    const base =
      prev && prev.session_id === sessionId
        ? prev
        : { last_input: 0, last_output: 0, last_cache_5m: 0, last_cache_1h: 0, last_cache_read: 0 };

    const delta: TurnTokens = {
      input: Math.max(0, cum.input - base.last_input),
      output: Math.max(0, cum.output - base.last_output),
      cache5m: Math.max(0, cum.cache5m - base.last_cache_5m),
      cache1h: Math.max(0, cum.cache1h - base.last_cache_1h),
      cacheRead: Math.max(0, cum.cacheRead - base.last_cache_read),
    };

    // Actualizar snapshot al acumulado actual (siempre, aunque el delta sea 0).
    db.prepare(
      `INSERT INTO sessions (user_id, session_id, last_input, last_output, last_cache_5m, last_cache_1h, last_cache_read, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (user_id) DO UPDATE SET
         session_id = excluded.session_id,
         last_input = excluded.last_input, last_output = excluded.last_output,
         last_cache_5m = excluded.last_cache_5m, last_cache_1h = excluded.last_cache_1h,
         last_cache_read = excluded.last_cache_read, updated_at = datetime('now')`,
    ).run(userId, sessionId, cum.input, cum.output, cum.cache5m, cum.cache1h, cum.cacheRead);

    const total = delta.input + delta.output + delta.cache5m + delta.cache1h + delta.cacheRead;
    if (total === 0) return undefined;

    const costUsd = costOf(model, delta);
    db.prepare(
      `INSERT INTO usage_turns
         (user_id, session_id, model, input_tokens, output_tokens, cache_5m_tokens, cache_1h_tokens, cache_read_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      sessionId,
      model,
      delta.input,
      delta.output,
      delta.cache5m,
      delta.cache1h,
      delta.cacheRead,
      costUsd,
    );
    return { ...delta, costUsd };
  });
  return tx();
}

/** Registra el uso de una corrida REM (Fase 16) en el ledger `usage_turns`. A
 * diferencia de `recordTurn`, NO toca el snapshot de la sesión de chat (`sessions`):
 * la sesión REM es efímera y aparte, su usage acumulado YA es el total de la corrida.
 * Devuelve el costo en USD para reportarlo al usuario. */
export function recordRemTurn(
  db: Db,
  userId: number,
  sessionId: string,
  model: string,
  t: TurnTokens,
): number {
  const costUsd = costOf(model, t);
  db.prepare(
    `INSERT INTO usage_turns
       (user_id, session_id, model, input_tokens, output_tokens, cache_5m_tokens, cache_1h_tokens, cache_read_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, sessionId, model, t.input, t.output, t.cache5m, t.cache1h, t.cacheRead, costUsd);
  return costUsd;
}

/** Watermark de REM de una wiki (Fase 16): el último commit hasta el que REM consolidó.
 * null = nunca corrió (→ pasada completa). Es por repo (estado de la wiki, no del usuario). */
export function getRemWatermark(db: Db, repoId: number): string | null {
  const row = db.prepare("SELECT last_sha FROM rem_watermarks WHERE repo_id = ?").get(repoId) as
    | { last_sha: string }
    | undefined;
  return row?.last_sha ?? null;
}

/** Avanza el watermark de una wiki al SHA dado (HEAD tras la corrida de REM). Upsert. */
export function setRemWatermark(db: Db, repoId: number, sha: string): void {
  db.prepare(
    `INSERT INTO rem_watermarks (repo_id, last_sha, ran_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (repo_id) DO UPDATE SET last_sha = excluded.last_sha, ran_at = excluded.ran_at`,
  ).run(repoId, sha);
}

/** Ref al que un usuario tiene sincronizada su working copy local de una wiki (Fase 2c,
 * detección de deriva). null = nunca sincronizó esa wiki en su sesión actual (→ el gateway
 * no chequea deriva: el agente la hidrata fresca cuando la toque). Por (usuario, repo). */
export function getSyncWatermark(db: Db, userId: number, repo: string): string | null {
  const row = db
    .prepare("SELECT ref FROM wiki_sync_watermarks WHERE user_id = ? AND repo = ?")
    .get(userId, repo) as { ref: string } | undefined;
  return row?.ref ?? null;
}

/** Todas las wikis que un usuario tiene sincronizadas (con su ref), para chequear deriva.
 * Es el set de working copies que el agente realmente bajó esta sesión → las únicas que
 * pueden estar viejas. El gateway no depende de la wiki "en foco": una wiki sin watermark
 * no tiene copia local, así que no hay deriva posible (la hidrata fresca al tocarla). */
export function listSyncWatermarks(db: Db, userId: number): { repo: string; ref: string }[] {
  return db.prepare("SELECT repo, ref FROM wiki_sync_watermarks WHERE user_id = ?").all(userId) as {
    repo: string;
    ref: string;
  }[];
}

/** Registra que un usuario sincronizó su copia local de una wiki hasta `ref` (lo llama el
 * endpoint de sync en cada hydrate/pull/push, con el ref REAL servido). Upsert. */
export function setSyncWatermark(db: Db, userId: number, repo: string, ref: string): void {
  db.prepare(
    `INSERT INTO wiki_sync_watermarks (user_id, repo, ref, synced_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (user_id, repo) DO UPDATE SET ref = excluded.ref, synced_at = excluded.synced_at`,
  ).run(userId, repo, ref);
}

/** Repos con un watermark sincronizado en los últimos `withinMinutes` — el set "vivo" que el
 * watcher vigila para servir la deriva del agente (además de las wikis con pestaña web abierta).
 * El filtro por recencia evita pollear GitHub 24/7 por wikis de sesiones ya muertas: escala con
 * el uso real, no con el total de wikis. Una conversación activa re-sincroniza seguido → su wiki
 * se mantiene en la ventana; al quedar idle, sale del set y se deja de pollear. */
export function listActiveWatermarkedRepos(db: Db, withinMinutes: number): string[] {
  return (
    db
      .prepare("SELECT DISTINCT repo FROM wiki_sync_watermarks WHERE synced_at >= datetime('now', ?)")
      .all(`-${withinMinutes} minutes`) as { repo: string }[]
  ).map((r) => r.repo);
}

/** Último HEAD del substrato que el sistema conoce para una wiki (lo mantiene el watcher +
 * las escrituras por el server). null = todavía no observado. El gateway lo compara contra el
 * watermark del usuario para la deriva, sin pegarle a GitHub por turno. */
export function getWikiHead(db: Db, repo: string): string | null {
  const row = db.prepare("SELECT ref FROM wiki_heads WHERE repo = ?").get(repo) as
    | { ref: string }
    | undefined;
  return row?.ref ?? null;
}

/** Registra el HEAD conocido de una wiki (watcher al pollear, o el server tras un commit/save
 * con el ref resultante). Upsert. */
export function setWikiHead(db: Db, repo: string, ref: string): void {
  db.prepare(
    `INSERT INTO wiki_heads (repo, ref, checked_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (repo) DO UPDATE SET ref = excluded.ref, checked_at = excluded.checked_at`,
  ).run(repo, ref);
}

// --- Reportes de gasto ---------------------------------------------------
export interface SpendRow {
  user_id: number;
  handle: string;
  name: string | null;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_5m_tokens: number;
  cache_1h_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

export function spendReport(db: Db, userId?: number): SpendRow[] {
  const where = userId !== undefined ? "WHERE u.id = ?" : "";
  const sql = `
    SELECT u.id AS user_id, u.handle AS handle, u.name AS name,
           COUNT(t.id) AS turns,
           COALESCE(SUM(t.input_tokens), 0) AS input_tokens,
           COALESCE(SUM(t.output_tokens), 0) AS output_tokens,
           COALESCE(SUM(t.cache_5m_tokens), 0) AS cache_5m_tokens,
           COALESCE(SUM(t.cache_1h_tokens), 0) AS cache_1h_tokens,
           COALESCE(SUM(t.cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(t.cost_usd), 0) AS cost_usd
    FROM users u
    LEFT JOIN usage_turns t ON t.user_id = u.id
    ${where}
    GROUP BY u.id, u.handle, u.name
    ORDER BY cost_usd DESC, u.id`;
  return (userId !== undefined ? db.prepare(sql).all(userId) : db.prepare(sql).all()) as SpendRow[];
}

// --- Reporte diario ------------------------------------------------------
// Buckets por día calendario en horario de Buenos Aires (UTC-3 fijo, sin DST).
// Override por env (CEIBO_DAY_TZ_OFFSET, modificador de SQLite date()).
const DAY_TZ_OFFSET = process.env.CEIBO_DAY_TZ_OFFSET ?? "-3 hours";

export interface DailyRow {
  day: string; // YYYY-MM-DD (BA)
  user_id: number;
  handle: string;
  turns: number;
  tokens: number; // input + output (no incluye cache)
  cost_usd: number;
}

/**
 * Gasto por día y usuario, ascendente por fecha. `userId` lo limita a un usuario;
 * `days` recorta a los últimos N días con actividad (sin recorte si se omite).
 */
export function spendDaily(db: Db, opts: { userId?: number; days?: number } = {}): DailyRow[] {
  const { userId, days } = opts;
  const where = userId !== undefined ? "WHERE t.user_id = ?" : "";
  const sql = `
    SELECT date(t.ts, ?) AS day, u.id AS user_id, u.handle AS handle,
           COUNT(*) AS turns,
           COALESCE(SUM(t.input_tokens + t.output_tokens), 0) AS tokens,
           COALESCE(SUM(t.cost_usd), 0) AS cost_usd
    FROM usage_turns t
    JOIN users u ON u.id = t.user_id
    ${where}
    GROUP BY day, u.id, u.handle
    ORDER BY day ASC, u.handle ASC`;
  const rows = (
    userId !== undefined ? db.prepare(sql).all(DAY_TZ_OFFSET, userId) : db.prepare(sql).all(DAY_TZ_OFFSET)
  ) as DailyRow[];
  if (days && days > 0) {
    const uniqueDays = [...new Set(rows.map((r) => r.day))].sort();
    const keep = new Set(uniqueDays.slice(-days));
    return rows.filter((r) => keep.has(r.day));
  }
  return rows;
}

export interface ModelUsageRow {
  model: string;
  users: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

export function modelUsageReport(db: Db, opts: { userId?: number; days?: number } = {}): ModelUsageRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.userId !== undefined) {
    clauses.push("t.user_id = ?");
    params.push(opts.userId);
  }
  if (opts.days && opts.days > 0) {
    clauses.push("t.ts >= datetime('now', ?)");
    params.push(`-${Math.floor(opts.days)} days`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `
    SELECT t.model AS model,
           COUNT(DISTINCT t.user_id) AS users,
           COUNT(*) AS turns,
           COALESCE(SUM(t.input_tokens), 0) AS input_tokens,
           COALESCE(SUM(t.output_tokens), 0) AS output_tokens,
           COALESCE(SUM(t.cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(t.cost_usd), 0) AS cost_usd
    FROM usage_turns t
    ${where}
    GROUP BY t.model
    ORDER BY cost_usd DESC, turns DESC, model ASC`;
  return db.prepare(sql).all(...params) as ModelUsageRow[];
}

export * from "./notes-embed.ts";
// --- Índice derivado de notas (feature db F1) — módulo aparte, re-exportado ---
export * from "./notes-index.ts";
export * from "./notes-search.ts";
export * from "./notes-write.ts";
