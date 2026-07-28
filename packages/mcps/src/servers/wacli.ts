// MCP server `wacli` (Fase 9, v1 = READ-ONLY) — WhatsApp del usuario como tools de
// lectura. Vive ACÁ, con los demás MCP stateless, porque las lecturas SON stateless:
// spawnean el binario `wacli` (steipete/wacli, Go) contra el SQLite del store ya
// sincronizado — no necesitan socket vivo. Lo único stateful de WhatsApp es el
// `sync --follow`, que NO es un MCP: lo orquesta el gateway atado a la sesión MA
// (arranca al activarse, para al expirar — L349). No envía (mutación = fast-follow).
//
// Media (audio/imágenes/PDF): en la proyección el agente VE que un mensaje trae
// `media:audio`/`image`/… pero el contenido no entra solo. `wa_get_media` lo trae según
// el tipo: imágenes como bloque image (el modelo las ve), PDFs rasterizados a imágenes
// (renderPdfToImages, gs — MA no tiene input de PDF nativo), audios transcriptos a texto
// (STT local del server, @ceibo/speech — MA no tiene input de audio), y el resto
// (video/sticker) como metadatos.
//
// IMPORTANTE — por qué NO usamos `wacli media download`: ese comando es de ESCRITURA
// (marca la media en la DB) → toma el lock EXCLUSIVO del store, el mismo que retiene el
// `sync --follow` del gateway mientras el usuario está activo. Y abrir un 2º socket de
// WhatsApp con la misma sesión patea la conexión del follow (un socket por device). Como
// la transcripción se pide DURANTE la conversación, chocaba siempre ("store is locked").
// En su lugar (todo en @ceibo/store, compartido con el canal del bot): leemos `direct_path` +
// `media_key` de la `wacli.db` en READ-ONLY (sin lock), bajamos el blob `.enc` del CDN
// (`mmg.whatsapp.net`) con un GET HTTPS pelado (la media es E2E-encriptada; el CDN no pide
// auth) y lo desencripta `fetchWacliMediaBytes` (esquema whatsmeow: HKDF-SHA256 →
// IV+cipherKey+macKey, HMAC-10, AES-256-CBC). Cero socket, cero lock → corre con el follow.
//
// Identidad: igual que `schedule`, el Bearer es un token firmado por el gateway
// (`<userId>.<expMs>.<hmac>`, HMAC con WACLI_MCP_HMAC_KEY) → userId → su `--store`. El
// path-secret del launcher (WACLI_MCP_PATH_SECRET) gatea el acceso; el Bearer identifica al
// usuario. C1: la clave HMAC está desacoplada del path-secret (no se filtra en logs de nginx).

import { execFile } from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";
import { speechEnabled, transcribe } from "@ceibo/speech";
import {
  fetchWacliMediaBytes,
  readWacliMediaInfo,
  verifyUserToken,
  type WacliMediaInfo,
  wacliStoreDirForUser,
} from "@ceibo/store";
import { renderPdfToImages } from "../core/pdf.ts";
import { type McpContent, type McpServer, rawContent, type Tool, type ToolArgs } from "../core/transport.ts";

const execFileAsync = promisify(execFile);

// Binario wacli (la box lo fija al release ≥v0.7.0). Timeout de lectura acotado.
const WACLI_BIN = process.env.WACLI_BIN ?? "wacli";
const READ_TIMEOUT_MS = Number(process.env.WACLI_READ_TIMEOUT_MS ?? 30_000);
const MAX_BUFFER = 16 * 1024 * 1024; // 16MB: un thread largo entra holgado

interface Envelope {
  success: boolean;
  data: unknown;
  error: string | null;
}

export function parseEnvelope(stdout: string): unknown {
  let env: Envelope;
  try {
    env = JSON.parse(stdout) as Envelope;
  } catch {
    throw new Error(`wacli devolvió algo que no es JSON: ${stdout.slice(0, 200)}`);
  }
  if (!env.success) throw new Error(env.error || "wacli falló sin detalle");
  return env.data;
}

/** Corre `wacli --json --store <store> <args…>` (execFile, sin shell) y devuelve `data`. */
async function run(store: string, args: string[], timeoutMs: number = READ_TIMEOUT_MS): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(WACLI_BIN, ["--json", "--store", store, ...args], {
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
    });
    return parseEnvelope(stdout);
  } catch (e) {
    // wacli puede salir con código ≠0 PERO igual imprimir el envelope con success:false.
    const err = e as { stdout?: string; code?: string; message?: string };
    if (typeof err.stdout === "string" && err.stdout.trim().startsWith("{")) {
      return parseEnvelope(err.stdout); // re-lanza el error real del envelope
    }
    if (err.code === "ENOENT") throw new Error(`no encuentro el binario wacli (WACLI_BIN=${WACLI_BIN})`);
    throw new Error(`wacli falló: ${err.message ?? String(e)}`);
  }
}

/** Agrega `--flag valor` sólo si el valor está presente. */
export function flag(name: string, value: string | number | undefined): string[] {
  if (value === undefined || value === "") return [];
  return [`--${name}`, String(value)];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

// Proyección de mensajes a lo esencial. El objeto crudo de wacli trae ~25 campos por
// mensaje (paths de media, reacciones, flags de starred/revoked, …); devolverlos todos
// infla fuerte el contexto del agente (riesgo #1 de la spec: el payload domina los
// tokens). Recortamos a lo que el agente realmente usa para leer una conversación.
export function projectMessage(m: unknown): unknown {
  if (!m || typeof m !== "object") return m;
  const r = m as Record<string, unknown>;
  const out: Record<string, unknown> = {
    ts: r.Timestamp,
    from: r.SenderName || r.SenderJID,
    from_me: r.FromMe,
    chat: r.ChatName || r.ChatJID,
    text: r.DisplayText || r.Text || r.MediaCaption || "",
  };
  if (r.MediaType) {
    out.media = r.MediaType; // sólo si es media (imagen/audio/…)
    // El JID del chat y el id del mensaje son la coordenada para bajar el adjunto con
    // wa_get_media. El chat-JID puro (no el nombre) es lo que pide la tool.
    out.id = r.MsgID;
    out.chat_jid = r.ChatJID;
  }
  return out;
}

/** Aplica projectMessage a la lista de mensajes del `data` de wacli, preservando el
 *  resto del envelope (ej. `fts`). Tolera `data.messages` (search/list) o array pelado. */
export function leanMessages(data: unknown): unknown {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.messages)) return { ...d, messages: d.messages.map(projectMessage) };
    return data;
  }
  if (Array.isArray(data)) return data.map(projectMessage);
  return data;
}

/** Saca el userId del Bearer firmado, o throw. La key HMAC es WACLI_MCP_HMAC_KEY (C1). */
function userIdFromToken(token: string): number {
  const key = process.env.WACLI_MCP_HMAC_KEY ?? "";
  const userId = key ? verifyUserToken(token, key) : undefined;
  if (userId === undefined) throw new Error("token de wacli inválido");
  return userId;
}

// --- Media (wa_get_media / wa_transcribe_audio) --------------------------

/** Normaliza el mime de imagen a uno que la API de MA acepta (jpeg/png/gif/webp). */
const IMG_MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
export function normImageMime(mime: string, hintPath: string): string {
  const m = mime.toLowerCase();
  if (/^image\/(jpe?g|png|gif|webp)$/.test(m)) return m === "image/jpg" ? "image/jpeg" : m;
  return IMG_MIME_BY_EXT[extname(hintPath).toLowerCase()] ?? "image/jpeg";
}

// El descifrado + bajada de media vive en @ceibo/store (lo comparten este MCP per-usuario y
// el canal del bot). Se re-exporta `decryptMedia` para no romper la superficie/tests del MCP.
export { decryptWacliMedia as decryptMedia } from "@ceibo/store";

/** Carga el adjunto de un mensaje (valida que exista y tenga media). */
function loadMediaInfo(userId: number, chat: string, id: string): WacliMediaInfo {
  const info = readWacliMediaInfo(userId, chat, id);
  if (!info) throw new Error("no encuentro ese mensaje en WhatsApp (revisá chat_jid e id)");
  if (!info.mediaType) throw new Error("ese mensaje no tiene adjunto");
  return info;
}

/** Baja un audio y lo transcribe a texto (STT local del server). */
async function transcribeMedia(userId: number, chat: string, id: string): Promise<string> {
  if (!speechEnabled()) throw new Error("transcripción no disponible (STT no configurado en el server)");
  const info = loadMediaInfo(userId, chat, id);
  if (info.mediaType !== "audio" && info.mediaType !== "ptt") {
    throw new Error(`ese mensaje no es un audio (es "${info.mediaType}")`);
  }
  return transcribe(await fetchWacliMediaBytes(info));
}

const DATE_DESC = "Filtro de fecha: RFC3339 (2026-05-26T09:00:00-03:00) o YYYY-MM-DD.";

const TOOLS: Tool[] = [
  {
    name: "wa_list_chats",
    description:
      "Lista los chats de WhatsApp del usuario (más recientes primero), con el JID de " +
      "cada uno. Usá el JID para leer un chat (wa_list_messages) o filtrar búsquedas. " +
      "`query` filtra por nombre/contacto.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Filtra chats por nombre/contacto (opcional)." },
        limit: { type: "integer", description: "Máximo de chats (default 50)." },
      },
    },
  },
  {
    name: "wa_search_messages",
    description:
      "Busca mensajes en el historial de WhatsApp del usuario (full-text). Acotá con " +
      "`chat` (JID, de wa_list_chats), `from` (JID del remitente) y/o rango de fechas.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto a buscar (full-text)." },
        chat: { type: "string", description: "JID del chat para acotar (opcional)." },
        from: { type: "string", description: "JID del remitente para acotar (opcional)." },
        after: { type: "string", description: `Sólo después de. ${DATE_DESC}` },
        before: { type: "string", description: `Sólo antes de. ${DATE_DESC}` },
        type: {
          type: "string",
          enum: ["image", "video", "audio", "document"],
          description: "Filtra por tipo de media (opcional).",
        },
        limit: { type: "integer", description: "Máximo de resultados (default 50)." },
      },
      required: ["query"],
    },
  },
  {
    name: "wa_list_messages",
    description:
      "Lee los mensajes de UN chat de WhatsApp (sin buscar texto), más recientes " +
      "primero. Pasá el `chat` (JID, de wa_list_chats).",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "JID del chat a leer (de wa_list_chats)." },
        after: { type: "string", description: `Sólo después de. ${DATE_DESC}` },
        before: { type: "string", description: `Sólo antes de. ${DATE_DESC}` },
        limit: { type: "integer", description: "Máximo de mensajes (default 50)." },
      },
      required: ["chat"],
    },
  },
  {
    name: "wa_search_contacts",
    description: "Busca contactos de WhatsApp del usuario por nombre/número; devuelve sus JIDs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Nombre o número a buscar." },
        limit: { type: "integer", description: "Máximo de resultados (default 50)." },
      },
      required: ["query"],
    },
  },
  {
    name: "wa_transcribe_audio",
    description:
      "Transcribe a texto una nota de voz / audio de WhatsApp. Pasá `chat_jid` e `id` (de " +
      "un mensaje con `media:audio` en wa_list_messages/wa_search_messages). Devuelve el " +
      "texto transcripto (STT local en el server; MA no puede escuchar el audio directo).",
    inputSchema: {
      type: "object",
      properties: {
        chat_jid: {
          type: "string",
          description: "JID del chat (campo chat_jid del mensaje, o de wa_list_chats).",
        },
        id: { type: "string", description: "ID del mensaje de audio (campo `id` del mensaje)." },
      },
      required: ["chat_jid", "id"],
    },
  },
  {
    name: "wa_get_media",
    description:
      "Trae el adjunto de un mensaje de WhatsApp según su tipo: las imágenes vuelven como " +
      "imagen (las ves directamente), los PDFs se rasterizan a imágenes (los ves página por " +
      "página), los audios se transcriben a texto, y otros adjuntos (video/sticker) devuelven " +
      "sus metadatos (no se pueden cargar al contexto). Anda igual en DM o en grupo. " +
      "Pasá `chat_jid` e `id` (de un mensaje con `media:…` en wa_list_messages).",
    inputSchema: {
      type: "object",
      properties: {
        chat_jid: {
          type: "string",
          description: "JID del chat (campo chat_jid del mensaje, o de wa_list_chats).",
        },
        id: { type: "string", description: "ID del mensaje con media (campo `id` del mensaje)." },
      },
      required: ["chat_jid", "id"],
    },
  },
];

async function callTool(token: string, name: string, args: ToolArgs): Promise<unknown> {
  const userId = userIdFromToken(token);
  const store = wacliStoreDirForUser(userId); // path para los comandos de lectura de wacli

  if (name === "wa_list_chats") {
    return run(store, [
      "chats",
      "list",
      ...flag("query", str(args.query) || undefined),
      ...flag("limit", num(args.limit)),
    ]);
  }

  if (name === "wa_search_messages") {
    const query = str(args.query).trim();
    if (!query) throw new Error("falta `query` (texto a buscar)");
    return leanMessages(
      await run(store, [
        "messages",
        "search",
        query,
        ...flag("chat", str(args.chat) || undefined),
        ...flag("from", str(args.from) || undefined),
        ...flag("after", str(args.after) || undefined),
        ...flag("before", str(args.before) || undefined),
        ...flag("type", str(args.type) || undefined),
        ...flag("limit", num(args.limit)),
      ]),
    );
  }

  if (name === "wa_list_messages") {
    const chat = str(args.chat).trim();
    if (!chat) throw new Error("falta `chat` (JID del chat, de wa_list_chats)");
    return leanMessages(
      await run(store, [
        "messages",
        "list",
        ...flag("chat", chat),
        ...flag("after", str(args.after) || undefined),
        ...flag("before", str(args.before) || undefined),
        ...flag("limit", num(args.limit)),
      ]),
    );
  }

  if (name === "wa_search_contacts") {
    const query = str(args.query).trim();
    if (!query) throw new Error("falta `query` (nombre o número)");
    return run(store, ["contacts", "search", query, ...flag("limit", num(args.limit))]);
  }

  if (name === "wa_transcribe_audio") {
    const chat = str(args.chat_jid).trim();
    const id = str(args.id).trim();
    if (!chat || !id) throw new Error("faltan `chat_jid` y/o `id` (de un mensaje con media:audio)");
    const text = (await transcribeMedia(userId, chat, id)).trim();
    return { text: text || "(audio sin habla detectable)" };
  }

  if (name === "wa_get_media") {
    const chat = str(args.chat_jid).trim();
    const id = str(args.id).trim();
    if (!chat || !id) throw new Error("faltan `chat_jid` y/o `id` (de un mensaje con media)");
    const info = loadMediaInfo(userId, chat, id);

    // Audio → transcripción (MA no tiene input de audio).
    if (info.mediaType === "audio" || info.mediaType === "ptt") {
      if (!speechEnabled()) throw new Error("transcripción no disponible (STT no configurado en el server)");
      const text = (await transcribe(await fetchWacliMediaBytes(info))).trim();
      return { type: "audio", transcript: text || "(audio sin habla detectable)" };
    }

    // Imagen → bloque image (el modelo la ve). El caption va como texto aparte.
    if (info.mediaType === "image") {
      const data = (await fetchWacliMediaBytes(info)).toString("base64");
      const hint = info.filename || info.localPath;
      const blocks: McpContent[] = [{ type: "image", data, mimeType: normImageMime(info.mimeType, hint) }];
      if (info.caption) blocks.push({ type: "text", text: `Caption: ${info.caption}` });
      return rawContent(blocks);
    }

    // PDF → lo rasterizamos a imágenes con gs (server-side) y devolvemos las páginas como
    // bloques image, para que el modelo lo VEA (MA no tiene input de PDF nativo). Mismo
    // patrón que el MCP de gmail (renderPdfToImages). Andan tanto en DM como en grupo.
    if (info.mediaType === "document" && /^application\/pdf$/i.test(info.mimeType ?? "")) {
      const pdf = await fetchWacliMediaBytes(info);
      try {
        const { pages, truncated } = await renderPdfToImages(pdf);
        if (pages.length === 0) {
          return {
            type: "document",
            note: "No pude renderizar el PDF (¿vacío, protegido o corrupto?).",
            filename: info.filename || null,
            mime: info.mimeType || null,
            caption: info.caption || null,
          };
        }
        const cap = `Adjunto PDF: ${info.filename || "(sin nombre)"} — ${pages.length} página(s)${
          truncated ? " (truncado: el PDF tiene más, te muestro las primeras)" : ""
        }.${info.caption ? ` Caption: ${info.caption}` : ""}`;
        return rawContent([
          ...pages.map((data): McpContent => ({ type: "image", data, mimeType: "image/png" })),
          { type: "text", text: cap },
        ]);
      } catch (e) {
        return {
          type: "document",
          note: `No pude convertir el PDF a imagen: ${(e as Error).message}`,
          filename: info.filename || null,
          mime: info.mimeType || null,
          caption: info.caption || null,
        };
      }
    }

    // Video / sticker / otros documentos → no entra al contexto (sólo texto/imagen/PDF). Metadatos.
    return {
      type: info.mediaType,
      note: "No puedo cargar este tipo de adjunto al contexto (sólo soporto texto, imagen y PDF). Te paso los metadatos.",
      filename: info.filename || null,
      mime: info.mimeType || null,
      caption: info.caption || null,
    };
  }

  throw new Error(`tool desconocida: ${name}`);
}

export const wacli: McpServer = { name: "wacli", tools: TOOLS, callTool };
