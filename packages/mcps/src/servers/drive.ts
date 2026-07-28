// MCP server de Google Drive: traduce MCP → Drive REST v3. SOLO LECTURA
// (scope drive.readonly): buscar archivos y leer su contenido como texto.
//
// Tools: search_files, read_file. Para Google Docs/Sheets/Slides nativos exporta a
// texto plano/CSV; para archivos text/* baja el contenido; binarios no se leen.
// El access_token lo inyecta el vault del usuario.

import { googleClient, googleText } from "../core/google.ts";
import type { McpServer, Tool, ToolArgs } from "../core/transport.ts";

const api = googleClient("https://www.googleapis.com/drive/v3");
const raw = googleText("https://www.googleapis.com/drive/v3");

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
}
interface FileList {
  files?: DriveFile[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// MIME nativos de Google → cómo exportarlos a texto.
const EXPORT_AS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

const TOOLS: Tool[] = [
  {
    name: "search_files",
    description:
      "Busca archivos en el Drive del usuario. `query` admite sintaxis de búsqueda de " +
      "Drive (ej. \"name contains 'factura'\", \"mimeType='application/pdf'\", " +
      "\"modifiedTime > '2026-01-01'\"). Devuelve id, nombre, tipo y fecha de cada uno.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Query Drive. Vacío = recientes." },
        maxResults: { type: "integer", description: "Máx archivos (1-25). Default 10." },
      },
    },
  },
  {
    name: "read_file",
    description:
      "Lee el contenido de un archivo como texto. Google Docs/Sheets/Slides se exportan " +
      "a texto/CSV; archivos de texto se bajan tal cual; binarios (imágenes, etc.) no se leen.",
    inputSchema: {
      type: "object",
      properties: { fileId: { type: "string", description: "id del archivo (de search_files)." } },
      required: ["fileId"],
    },
  },
];

async function callTool(token: string, name: string, args: ToolArgs): Promise<unknown> {
  if (name === "search_files") {
    const max = Math.min(Math.max(Number(args.maxResults ?? 10), 1), 25);
    const params = new URLSearchParams({
      pageSize: String(max),
      fields: "files(id,name,mimeType,modifiedTime)",
      orderBy: "modifiedTime desc",
    });
    if (str(args.query)) params.set("q", str(args.query));
    const list = await api<FileList>(token, `/files?${params}`);
    return { count: (list.files ?? []).length, files: list.files ?? [] };
  }

  if (name === "read_file") {
    const id = encodeURIComponent(str(args.fileId));
    const meta = await api<DriveFile>(token, `/files/${id}?fields=id,name,mimeType`);
    const mime = meta.mimeType ?? "";
    let content: string;
    if (EXPORT_AS[mime]) {
      content = await raw(token, `/files/${id}/export?mimeType=${encodeURIComponent(EXPORT_AS[mime])}`);
    } else if (mime.startsWith("text/") || mime === "application/json") {
      content = await raw(token, `/files/${id}?alt=media`);
    } else {
      return {
        id: meta.id,
        name: meta.name,
        mimeType: mime,
        content: null,
        note: "binario no legible como texto",
      };
    }
    return { id: meta.id, name: meta.name, mimeType: mime, content };
  }

  throw new Error(`tool desconocida: ${name}`);
}

export const drive: McpServer = { name: "drive", tools: TOOLS, callTool };
