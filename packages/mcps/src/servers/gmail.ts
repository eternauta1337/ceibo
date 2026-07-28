// MCP server de Gmail: traduce MCP → Gmail REST. Portado de managed-1.
//
// Existe porque el MCP oficial de Google (gmailmcp.googleapis.com) está detrás del
// Workspace Developer Preview Program, que NO admite cuentas @gmail.com personales.
// La Gmail REST API normal sí funciona con el access_token OAuth que minteamos.
//
// Tools: search_messages, read_message, create_draft (borrador, NO envía — toda
// mutación de mundo externo queda como borrador, ver spec).

import { googleClient } from "../core/google.ts";
import { renderPdfToImages } from "../core/pdf.ts";
import { type McpServer, rawContent, type Tool, type ToolArgs } from "../core/transport.ts";

const api = googleClient("https://gmail.googleapis.com/gmail/v1/users/me");

// --- Tipos mínimos de la Gmail REST API (sólo lo que usamos) ---------------
interface GmailHeader {
  name?: string;
  value?: string;
}
interface GmailPayload {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPayload[];
}
interface GmailMessage {
  id?: string;
  snippet?: string;
  payload?: GmailPayload;
}
interface GmailMessageList {
  messages?: Array<{ id?: string }>;
}
interface GmailDraft {
  id?: string;
  message?: { id?: string };
}
interface GmailAttachmentBody {
  data?: string;
  size?: number;
}

/** Un adjunto del mail, tal como lo listamos para el agente. `attachmentId` se usa con
 *  read_attachment para traer el contenido. */
interface AttachmentRef {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

// MIME types cuyo contenido es texto plano legible → read_attachment devuelve el texto
// decodificado. Lo binario (PDF/imagen/zip/office) NO se devuelve por ahora (no se puede
// mandar megabytes de base64 por el modelo; la entrega binaria es un follow-up).
const TEXTUAL = /^text\/|^application\/(json|xml|csv|x-yaml|yaml)|\+(json|xml)$/i;
const MAX_ATTACHMENT_TEXT = 100_000; // chars; corta adjuntos de texto enormes

// Imágenes que el modelo PUEDE ver (vision): las 4 que acepta la API de Claude. Otras
// (heic, tiff, svg, …) no se renderizan → caen al aviso de "no disponible".
const VISION_IMAGE = /^image\/(png|jpe?g|gif|webp)$/i;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // tope conservador (req a MA ~32MB, base64 +33%)

// Gmail devuelve base64url; el content block de imagen quiere base64 estándar (con padding).
export function b64UrlToStd(data: string | undefined): string {
  let s = (data ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  return s;
}

// image/jpg → image/jpeg (media type válido); el resto tal cual en minúsculas.
export const normImageMime = (m: string): string =>
  /^image\/jpg$/i.test(m) ? "image/jpeg" : m.toLowerCase();

// Recorre el árbol de partes MIME y junta las que son adjuntos (tienen filename + attachmentId).
export function collectAttachments(
  payload: GmailPayload | undefined,
  out: AttachmentRef[] = [],
): AttachmentRef[] {
  if (!payload) return out;
  const id = payload.body?.attachmentId;
  if (payload.filename && id) {
    out.push({
      filename: payload.filename,
      mimeType: payload.mimeType ?? "application/octet-stream",
      size: payload.body?.size ?? 0,
      attachmentId: id,
    });
  }
  for (const part of payload.parts ?? []) collectAttachments(part, out);
  return out;
}

export function header(msg: GmailMessage, name: string): string {
  const h = (msg.payload?.headers ?? []).find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

export const decodeB64Url = (data?: string): string =>
  data ? Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "";

// Decodifica recursivamente la primera parte text/plain (o text/html como fallback).
export function extractBody(payload?: GmailPayload): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeB64Url(payload.body.data);
  let htmlFallback = "";
  for (const part of payload.parts ?? []) {
    const got = extractBody(part);
    if (got && part.mimeType === "text/plain") return got;
    if (got && !htmlFallback) htmlFallback = got;
  }
  if (payload.mimeType === "text/html" && payload.body?.data) return decodeB64Url(payload.body.data);
  return htmlFallback;
}

const TOOLS: Tool[] = [
  {
    name: "search_messages",
    description:
      "Busca mensajes en el Gmail del usuario con sintaxis de búsqueda de Gmail " +
      "(ej. 'from:alice newer_than:7d', 'subject:factura', 'is:unread'). " +
      "Devuelve remitente, asunto, fecha, snippet e id de cada mensaje.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Query en sintaxis Gmail. Vacío = recientes." },
        maxResults: { type: "integer", description: "Máx mensajes (1-25). Default 10." },
      },
    },
  },
  {
    name: "read_message",
    description:
      "Lee un mensaje completo por id (headers + cuerpo en texto plano). Si el mail tiene " +
      "adjuntos, los lista (nombre, tipo, tamaño, attachmentId); usá read_attachment para abrirlos.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "id del mensaje (de search_messages)." } },
      required: ["id"],
    },
  },
  {
    name: "read_attachment",
    description:
      "Abre un adjunto de un mail. TEXTO (txt/csv/json/xml): devuelve su contenido. IMÁGENES " +
      "(png/jpg/gif/webp): las VES directamente. PDF: se rasteriza a imágenes (lo VES, hasta ~15 " +
      "páginas). Otros binarios (office/zip) todavía NO se pueden abrir: avisale al usuario.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "id del mensaje (de search_messages/read_message)." },
        attachmentId: { type: "string", description: "attachmentId del adjunto (de read_message)." },
        mimeType: {
          type: "string",
          description: "mimeType del adjunto (de read_message), para decidir si es texto.",
        },
        filename: { type: "string", description: "nombre del adjunto (de read_message), opcional." },
      },
      required: ["messageId", "attachmentId"],
    },
  },
  {
    name: "create_draft",
    description:
      "Crea un BORRADOR en Gmail (no envía). Útil para dejarle al usuario un mail listo para revisar.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Destinatario(s), separados por coma." },
        subject: { type: "string" },
        body: { type: "string", description: "Cuerpo en texto plano." },
      },
      required: ["to", "subject", "body"],
    },
  },
];

const str = (v: unknown): string => (typeof v === "string" ? v : "");

async function callTool(token: string, name: string, args: ToolArgs): Promise<unknown> {
  if (name === "search_messages") {
    const max = Math.min(Math.max(Number(args.maxResults ?? 10), 1), 25);
    const q = encodeURIComponent(str(args.query));
    const list = await api<GmailMessageList>(token, `/messages?maxResults=${max}&q=${q}`);
    const ids = (list.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    const items = await Promise.all(
      ids.map(async (id) => {
        const m = await api<GmailMessage>(
          token,
          `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        );
        return {
          id,
          from: header(m, "From"),
          subject: header(m, "Subject"),
          date: header(m, "Date"),
          snippet: m.snippet ?? "",
        };
      }),
    );
    return { count: items.length, messages: items };
  }

  if (name === "read_message") {
    const m = await api<GmailMessage>(token, `/messages/${str(args.id)}?format=full`);
    return {
      id: m.id,
      from: header(m, "From"),
      to: header(m, "To"),
      subject: header(m, "Subject"),
      date: header(m, "Date"),
      body: extractBody(m.payload),
      attachments: collectAttachments(m.payload),
    };
  }

  if (name === "read_attachment") {
    const messageId = str(args.messageId);
    const attachmentId = str(args.attachmentId);
    const mimeType = str(args.mimeType);
    const filename = str(args.filename);
    if (!messageId || !attachmentId) throw new Error("read_attachment necesita messageId y attachmentId.");

    // Imagen que el modelo puede VER (png/jpeg/gif/webp): la devolvemos como content block de
    // imagen → MA la pasa al modelo como input de visión.
    if (mimeType && VISION_IMAGE.test(mimeType)) {
      const att = await api<GmailAttachmentBody>(token, `/messages/${messageId}/attachments/${attachmentId}`);
      if ((att.size ?? 0) > MAX_IMAGE_BYTES) {
        return {
          filename,
          mimeType,
          delivered: false,
          note: `Imagen demasiado grande (${att.size} bytes; tope ${MAX_IMAGE_BYTES}). No la puedo abrir.`,
        };
      }
      return rawContent([
        { type: "image", data: b64UrlToStd(att.data), mimeType: normImageMime(mimeType) },
        { type: "text", text: `Adjunto: ${filename || "(sin nombre)"} (${mimeType}).` },
      ]);
    }

    // Texto plano legible (txt/csv/json/xml): devolvemos el contenido decodificado.
    if (!mimeType || TEXTUAL.test(mimeType)) {
      const att = await api<GmailAttachmentBody>(token, `/messages/${messageId}/attachments/${attachmentId}`);
      const full = decodeB64Url(att.data);
      const text = full.slice(0, MAX_ATTACHMENT_TEXT);
      return {
        filename,
        mimeType: mimeType || "text/plain",
        size: att.size ?? full.length,
        truncated: full.length > MAX_ATTACHMENT_TEXT,
        content: text,
      };
    }

    // PDF: lo rasterizamos a imágenes con gs (server-side) y devolvemos las páginas como
    // content blocks de imagen → el modelo "ve" el PDF (MA no tiene vía MCP para PDF nativo).
    if (mimeType === "application/pdf") {
      const att = await api<GmailAttachmentBody>(token, `/messages/${messageId}/attachments/${attachmentId}`);
      const pdf = Buffer.from(b64UrlToStd(att.data), "base64");
      try {
        const { pages, truncated } = await renderPdfToImages(pdf);
        if (pages.length === 0) {
          return {
            filename,
            mimeType,
            delivered: false,
            note: "No pude renderizar el PDF (¿vacío, protegido o corrupto?).",
          };
        }
        const cap = `Adjunto PDF: ${filename || "(sin nombre)"} — ${pages.length} página(s)${truncated ? " (truncado: el PDF tiene más, te muestro las primeras)" : ""}.`;
        return rawContent([
          ...pages.map((data) => ({ type: "image" as const, data, mimeType: "image/png" })),
          { type: "text", text: cap },
        ]);
      } catch (e) {
        return {
          filename,
          mimeType,
          delivered: false,
          note: `No pude convertir el PDF a imagen: ${(e as Error).message}`,
        };
      }
    }

    // Resto (office, zip, imágenes no-vision): todavía no se puede abrir por esta vía.
    return {
      filename,
      mimeType,
      delivered: false,
      note: "Por ahora puedo abrir adjuntos de texto (txt/csv/json), imágenes (png/jpg/gif/webp) y PDF. Otros binarios (office/zip) todavía no.",
    };
  }

  if (name === "create_draft") {
    // Sanitizar headers: sin CR/LF en To/Subject (evita header injection en el RFC822).
    const hdr = (v: unknown) =>
      str(v)
        .replace(/[\r\n]+/g, " ")
        .trim();
    const raw = [
      `To: ${hdr(args.to)}`,
      `Subject: ${hdr(args.subject)}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      str(args.body),
    ].join("\r\n");
    const encoded = Buffer.from(raw, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const draft = await api<GmailDraft>(token, "/drafts", {
      method: "POST",
      body: JSON.stringify({ message: { raw: encoded } }),
    });
    return { draftId: draft.id, messageId: draft.message?.id };
  }

  throw new Error(`tool desconocida: ${name}`);
}

export const gmail: McpServer = { name: "gmail", tools: TOOLS, callTool };
