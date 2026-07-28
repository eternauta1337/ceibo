import { writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const CONFIG_PATH = fileURLToPath(new URL("./orb.config.json", import.meta.url));

function writeJsonPost(
  path: string,
  filePath: string,
  reqPath: string,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (reqPath !== path) return false;
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end();
    return true;
  }
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", async () => {
    try {
      const pretty = `${JSON.stringify(JSON.parse(body), null, 2)}\n`;
      await writeFile(filePath, pretty);
      res.statusCode = 200;
      res.end("ok");
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  return true;
}

// Plugin dev: POST /orb-config escribe orb.config.json — el "Guardar" del harness persiste la
// config que la app consume directo (una sola fuente de verdad, sin baking a mano).
function saveConfig(): Plugin {
  return {
    name: "orb-save-config",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        if (writeJsonPost("/orb-config", CONFIG_PATH, path, req, res)) return;
        next();
      });
    },
  };
}

// Harness standalone (sandbox). `pnpm --filter @ceibo/orb dev`.
export default defineConfig({
  root: "dev",
  plugins: [saveConfig()],
});
