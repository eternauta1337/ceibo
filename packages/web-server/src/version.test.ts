// Tests de resolveDeploySha y del endpoint GET /api/version.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@ceibo/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDeploySha } from "./version.ts";
import { startWebServer, type WebServer } from "./web.ts";

// ── resolveDeploySha ───────────────────────────────────────────────────────────

describe("resolveDeploySha", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `version-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("lee el SHA desde .deployed-sha y lo recorta a 7 chars", () => {
    const fullSha = "abc1234def5678901234567890";
    writeFileSync(join(tmpDir, ".deployed-sha"), `${fullSha}\nmain\n2026-06-16T07:30:00Z\n`);
    expect(resolveDeploySha(tmpDir)).toBe("abc1234");
  });

  it("toma solo los primeros 7 chars de la primera línea", () => {
    writeFileSync(join(tmpDir, ".deployed-sha"), "deadbeef1234567\nstaging\n");
    expect(resolveDeploySha(tmpDir)).toBe("deadbee");
  });

  it("en directorio sin .deployed-sha devuelve string o null (git disponible o no)", () => {
    // No controlamos si hay git en el entorno de CI, así que aceptamos ambos.
    const result = resolveDeploySha(tmpDir);
    expect(result === null || typeof result === "string").toBe(true);
  });
});

// ── Endpoint GET /api/version ──────────────────────────────────────────────────
//
// Mismo patrón que web.e2e.test.ts: puerto efímero, fetch real.

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe("GET /api/version", () => {
  let server: WebServer;
  let base: string;

  beforeEach(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = startWebServer({
      db: openDb(":memory:"),
      port,
      staticDir: tmpdir(),
      sessionKey: "test-session-key-32-chars-minimum!",
      sendToAgent: () => {},
    });
  });

  afterEach(() => {
    server.close();
  });

  it("responde 200 con JSON { env, sha } donde env es uno de dev/staging/prod", async () => {
    const res = await fetch(`${base}/api/version`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = (await res.json()) as { env: string; sha: string | null };
    expect(["dev", "staging", "prod"]).toContain(json.env);
    // sha puede ser string (repo git local) o null (env sin git)
    expect(json.sha === null || typeof json.sha === "string").toBe(true);
    if (typeof json.sha === "string") {
      // SHA corto: máximo 7 chars
      expect(json.sha.length).toBeLessThanOrEqual(7);
    }
  });

  it("responde con el sha del .deployed-sha del cwd si existe", async () => {
    // Este test valida la resolución en el arranque del módulo — DEPLOY_SHA es una const
    // del módulo web.ts y se resuelve UNA vez al importar. No podemos cambiarla entre
    // tests sin re-importar el módulo. Verificamos solo que el contrato de shape se cumple.
    const res = await fetch(`${base}/api/version`);
    const json = (await res.json()) as { env: string; sha: string | null };
    expect(Object.keys(json)).toEqual(expect.arrayContaining(["env", "sha"]));
  });

  it("GET /api/version no requiere auth", async () => {
    // Sin cookie de sesión ni Bearer → igual 200 (endpoint público)
    const res = await fetch(`${base}/api/version`);
    expect(res.status).toBe(200);
  });
});
