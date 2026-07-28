// Core de transporte MCP — compartido por todos nuestros MCP servers stateless.
//
// Implementa el protocolo MCP sobre HTTP stateless al estilo del "StatelessServer"
// de Google: POST con JSON-RPC, responde application/json (sin sesiones ni SSE).
// Métodos: initialize, tools/list, tools/call, ping, notifications/*. Soporta batch.
//
// Un MCP server concreto (gmail, calendar, …) sólo provee un `McpServer`
// (name + tools + callTool); el launcher (launch.ts) lo monta en un path con su
// secreto. La extracción del Bearer y el parseo viven acá; el gate por path
// secreto y el ruteo viven en el launcher (que conoce el registry).

import type { IncomingMessage, ServerResponse } from "node:http";

export type ToolArgs = Record<string, unknown>;

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Lo que aporta cada MCP server: su identidad, sus tools y cómo ejecutarlas. */
export interface McpServer {
  name: string;
  tools: Tool[];
  callTool(token: string, tool: string, args: ToolArgs): Promise<unknown>;
}

// --- Content blocks (MCP spec) -------------------------------------------
// Por default `callTool` devuelve un valor y el transport lo envuelve como TextContent
// (JSON). Si una tool necesita devolver contenido rico (imágenes para que el modelo las
// VEA), devuelve `rawContent([...])`: el transport pasa esos bloques tal cual. Imagen =
// shape MCP `{type:"image", data, mimeType}` (NO el `source` de la API directa).
export type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const RAW_CONTENT = Symbol.for("ceibo.mcp.rawContent");

interface RawContent {
  [RAW_CONTENT]: true;
  content: McpContent[];
}

/** Marca una salida de tool como bloques de contenido MCP ya armados (no JSON-wrap). */
export function rawContent(content: McpContent[]): RawContent {
  return { [RAW_CONTENT]: true, content };
}

function asRawContent(out: unknown): RawContent | undefined {
  return out && typeof out === "object" && (out as Partial<RawContent>)[RAW_CONTENT]
    ? (out as RawContent)
    : undefined;
}

const PROTOCOL_VERSION = "2025-06-18";

interface RpcMessage {
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: ToolArgs };
}

const rpcResult = (id: RpcMessage["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcMessage["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

async function handleRpc(server: McpServer, msg: RpcMessage, token: string): Promise<unknown> {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `ceibo-${server.name}-mcp`, version: "0.1.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notificación: sin respuesta
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: server.tools });
    case "tools/call": {
      if (!token) {
        return rpcResult(id, {
          content: [{ type: "text", text: "Falta el token de autorización." }],
          isError: true,
        });
      }
      try {
        const out = await server.callTool(token, params?.name ?? "", params?.arguments ?? {});
        const raw = asRawContent(out);
        if (raw) return rpcResult(id, { content: raw.content });
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return rpcResult(id, {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(id, -32601, `método no soportado: ${method}`);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => resolve(raw));
  });
}

/**
 * Maneja un POST MCP para un server ya resuelto (el launcher validó path+secreto).
 * Extrae el Bearer que Anthropic inyecta, parsea el cuerpo (single o batch),
 * corre el JSON-RPC y responde. Nada se loguea.
 */
export async function handleMcpPost(
  server: McpServer,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = req.headers.authorization ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";

  const raw = await readBody(req);
  let payload: RpcMessage | RpcMessage[];
  try {
    payload = JSON.parse(raw);
  } catch {
    res
      .writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify(rpcError(null, -32700, "JSON inválido")));
    return;
  }

  const out = Array.isArray(payload)
    ? (await Promise.all(payload.map((m) => handleRpc(server, m, token)))).filter(Boolean)
    : await handleRpc(server, payload, token);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(out ?? {}));
}
