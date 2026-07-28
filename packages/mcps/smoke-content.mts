// Smoke del transport: una tool puede devolver content blocks (rawContent → imagen que el
// modelo VE), y lo demás se envuelve como TextContent (JSON). Corré: tsx packages/mcps/smoke-content.mts
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMcpPost, type McpServer, rawContent } from "./src/core/transport.ts";

const server: McpServer = {
  name: "test",
  tools: [],
  async callTool(_token, tool) {
    if (tool === "img") {
      return rawContent([
        { type: "image", data: "QUJD", mimeType: "image/png" },
        { type: "text", text: "una imagen" },
      ]);
    }
    return { hello: "world" }; // plain → JSON text
  },
};

// Driver: arma un req/res duck-typed y corre un tools/call.
function call(toolName: string): Promise<{ result: { content: Array<{ type: string; text?: string }> } }> {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as unknown as { headers: Record<string, string> }).headers = { authorization: "Bearer x" };
  let body = "";
  const res = {
    writeHead() {
      return res;
    },
    end(s: string) {
      body = s;
    },
  } as unknown as ServerResponse;
  const done = handleMcpPost(server, req, res).then(() => JSON.parse(body));
  // Los listeners de readBody ya están enganchados (handleMcpPost los attachea sync); emitimos
  // en el próximo tick.
  setImmediate(() => {
    req.emit("data", JSON.stringify({ id: 1, method: "tools/call", params: { name: toolName } }));
    req.emit("end");
  });
  return done;
}

const img = await call("img");
const blocks = img.result.content;
if (blocks[0]?.type !== "image") throw new Error("rawContent no pasó el bloque de imagen");
if (blocks[1]?.type !== "text" || blocks[1]?.text !== "una imagen")
  throw new Error("falta el caption de texto");

const plain = await call("other");
if (plain.result.content[0]?.type !== "text") throw new Error("salida plana debería ser TextContent");
if (!plain.result.content[0]?.text?.includes("world")) throw new Error("salida plana mal serializada");

console.log("OK content smoke");
