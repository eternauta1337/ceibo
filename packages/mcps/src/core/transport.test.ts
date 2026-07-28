import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { handleMcpPost, type McpServer, rawContent, type ToolArgs } from "./transport.ts";

// req fake: un Readable que emite el body + headers inyectados.
function fakeReq(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage;
  r.headers = headers;
  return r;
}

// res fake: captura status/headers/body. writeHead es chainable (el código hace .writeHead().end()).
function fakeRes() {
  const out = { status: 0, headers: {} as Record<string, string>, body: "" };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status;
      out.headers = headers;
      return res;
    },
    end(body?: string) {
      out.body = body ?? "";
    },
  } as unknown as ServerResponse;
  return { res, out };
}

// Server de prueba: una tool `echo` que refleja args (o tira si se le pide).
function testServer(callTool?: McpServer["callTool"]): McpServer {
  return {
    name: "test",
    tools: [{ name: "echo", description: "refleja", inputSchema: { type: "object" } }],
    callTool: callTool ?? (async (token: string, tool: string, args: ToolArgs) => ({ token, tool, args })),
  };
}

// Drives una request MCP y devuelve {status, json}.
async function rpc(server: McpServer, msg: unknown, headers?: Record<string, string>) {
  const { res, out } = fakeRes();
  await handleMcpPost(server, fakeReq(JSON.stringify(msg), headers), res);
  return { status: out.status, json: JSON.parse(out.body), headers: out.headers };
}

const AUTH = { authorization: "Bearer tok-123" };

describe("handleMcpPost — JSON-RPC dispatch", () => {
  it("initialize devuelve protocolVersion y serverInfo con el nombre del server", async () => {
    const { json } = await rpc(testServer(), { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(json.id).toBe(1);
    expect(json.result.protocolVersion).toBe("2025-06-18");
    expect(json.result.serverInfo.name).toBe("ceibo-test-mcp");
  });

  it("tools/list devuelve las tools del server", async () => {
    const { json } = await rpc(testServer(), { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(json.result.tools).toHaveLength(1);
    expect(json.result.tools[0].name).toBe("echo");
  });

  it("ping devuelve result vacío", async () => {
    const { json } = await rpc(testServer(), { jsonrpc: "2.0", id: 3, method: "ping" });
    expect(json.result).toEqual({});
  });

  it("método desconocido → error -32601", async () => {
    const { json } = await rpc(testServer(), { jsonrpc: "2.0", id: 4, method: "frobnicate" });
    expect(json.error.code).toBe(-32601);
    expect(json.error.message).toMatch(/frobnicate/);
  });

  it("JSON inválido → 400 con error -32700", async () => {
    const { res, out } = fakeRes();
    await handleMcpPost(testServer(), fakeReq("{ no json", AUTH), res);
    expect(out.status).toBe(400);
    expect(JSON.parse(out.body).error.code).toBe(-32700);
  });
});

describe("handleMcpPost — tools/call + auth", () => {
  it("con Bearer ejecuta la tool y envuelve el resultado como TextContent JSON", async () => {
    const { json } = await rpc(
      testServer(),
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "echo", arguments: { x: 1 } } },
      AUTH,
    );
    expect(json.result.isError).toBeUndefined();
    const parsed = JSON.parse(json.result.content[0].text);
    expect(parsed).toMatchObject({ token: "tok-123", tool: "echo", args: { x: 1 } });
  });

  it("extrae el Bearer case-insensitive", async () => {
    const { json } = await rpc(
      testServer(),
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "echo", arguments: {} } },
      { authorization: "bearer LOW" },
    );
    expect(JSON.parse(json.result.content[0].text).token).toBe("LOW");
  });

  it("sin token → isError con aviso, sin llamar a la tool", async () => {
    let called = false;
    const server = testServer(async () => {
      called = true;
      return {};
    });
    const { json } = await rpc(server, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/token/i);
    expect(called).toBe(false);
  });

  it("si la tool tira, devuelve isError con el mensaje (no propaga)", async () => {
    const server = testServer(async () => {
      throw new Error("boom");
    });
    const { json } = await rpc(
      server,
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "echo", arguments: {} } },
      AUTH,
    );
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/Error: boom/);
  });

  it("rawContent pasa los bloques de contenido tal cual (ej. imagen para vision)", async () => {
    const server = testServer(async () =>
      rawContent([{ type: "image", data: "BASE64", mimeType: "image/png" }]),
    );
    const { json } = await rpc(
      server,
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "shot", arguments: {} } },
      AUTH,
    );
    expect(json.result.content).toEqual([{ type: "image", data: "BASE64", mimeType: "image/png" }]);
  });
});

describe("handleMcpPost — batch", () => {
  it("procesa un batch y filtra las notificaciones (sin id de respuesta)", async () => {
    const { json } = await rpc(testServer(), [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect(Array.isArray(json)).toBe(true);
    // la notificación (devuelve null) se filtra → quedan 2 respuestas
    expect(json).toHaveLength(2);
    expect(json.map((r: { id: number }) => r.id)).toEqual([1, 2]);
  });
});
