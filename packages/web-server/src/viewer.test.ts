// C1 (HMAC split): HMAC_KEY es la clave dedicada (VIEWER_MCP_HMAC_KEY); PATH_SECRET es
// el path-secret de la URL (VIEWER_MCP_SECRET). Son valores distintos para verificar el split.

import { signUserToken } from "@ceibo/store";
import type { Wikis } from "@ceibo/wikis";
import { describe, expect, it, vi } from "vitest";
import { makeViewerServer, type ViewerPush } from "./viewer.ts";

const HMAC_KEY = "viewer-test-hmac-key"; // VIEWER_MCP_HMAC_KEY
const PATH_SECRET = "viewer-test-path-secret"; // VIEWER_MCP_SECRET (sólo para el path gate)
const SECRET = HMAC_KEY; // alias para compatibilidad con los tests existentes
const USER = 7;

const TOKEN = signUserToken(USER, HMAC_KEY);

const FILES: Record<string, string[]> = {
  "demo-personal": ["backlog-ceibo.md", "backlog-save.md", "projects/compras.md", "CLAUDE.md"],
  "demo-trabajo": ["okrs-2026.md"],
};

function makeServer(push: ViewerPush) {
  const wikis = {
    listFiles: vi.fn(async (repo: string) => FILES[repo] ?? []),
    createFile: vi.fn(async (_repo: string, _path: string, _content: string, _msg: string) => ({
      sha: "deadbeef",
    })),
  } as unknown as Wikis;
  const userRepoNames = () => ["demo-personal", "demo-trabajo"];
  return makeViewerServer(SECRET, push, wikis, userRepoNames);
}

describe("viewer_open (resolución nombre→path)", () => {
  it("resuelve un único match por prefijo y abre el path REAL", async () => {
    const push = vi.fn(() => 1);
    const srv = makeServer(push);
    const out = await srv.callTool(TOKEN, "viewer_open", { path: "demo-personal/compras" });
    expect(push).toHaveBeenCalledWith(USER, {
      t: "open",
      repo: "demo-personal",
      path: "projects/compras.md",
    });
    expect(out).toEqual({ delivered: true, opened: "demo-personal/projects/compras.md" });
  });

  it("abre el path exacto sin tocar nada cuando ya existe", async () => {
    const push = vi.fn(() => 1);
    const srv = makeServer(push);
    const out = await srv.callTool(TOKEN, "viewer_open", { path: "demo-personal/backlog-ceibo.md" });
    expect(out).toEqual({ delivered: true, opened: "demo-personal/backlog-ceibo.md" });
  });

  it("cae a otra wiki cuando el repo nombrado no tiene la nota", async () => {
    const push = vi.fn(() => 1);
    const srv = makeServer(push);
    const out = await srv.callTool(TOKEN, "viewer_open", { path: "demo-personal/okrs-2026" });
    expect(out).toEqual({ delivered: true, opened: "demo-trabajo/okrs-2026.md" });
  });

  it("ambiguo: tira error con la lista, NO abre nada", async () => {
    const push = vi.fn(() => 1);
    const srv = makeServer(push);
    await expect(srv.callTool(TOKEN, "viewer_open", { path: "demo-personal/backlog" })).rejects.toThrow(
      /matchea varias notas.*backlog-ceibo\.md.*backlog-save\.md/s,
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("inexistente: tira error con las notas disponibles, NO abre una vacía", async () => {
    const push = vi.fn(() => 1);
    const srv = makeServer(push);
    await expect(
      srv.callTool(TOKEN, "viewer_open", { path: "demo-personal/no-existe-nada" }),
    ).rejects.toThrow(/no encontré ninguna nota.*Notas disponibles.*viewer_create/s);
    expect(push).not.toHaveBeenCalled();
  });

  it("vista cerrada: resuelve igual pero avisa delivered:false", async () => {
    const push = vi.fn(() => 0);
    const srv = makeServer(push);
    const out = await srv.callTool(TOKEN, "viewer_open", { path: "demo-personal/backlog-ceibo.md" });
    expect(out).toMatchObject({ delivered: false });
  });

  it("token inválido: rechaza", async () => {
    const srv = makeServer(vi.fn(() => 1));
    await expect(
      srv.callTool("9.malo", "viewer_open", { path: "demo-personal/backlog-ceibo.md" }),
    ).rejects.toThrow(/token de viewer inválido/);
  });
});

describe("viewer_create (sin cambios de contrato)", () => {
  it("crea la nota y empuja el evento created", async () => {
    const push = vi.fn(() => 1);
    const srv = makeServer(push);
    const out = await srv.callTool(TOKEN, "viewer_create", { path: "demo-personal/nota-2026-06-08.md" });
    expect(out).toMatchObject({ created: "demo-personal/nota-2026-06-08.md", delivered: true });
    expect(push).toHaveBeenCalledWith(USER, {
      t: "created",
      repo: "demo-personal",
      path: "nota-2026-06-08.md",
      sha: "deadbeef",
    });
  });

  it("sigue exigiendo path completo (repo/ruta)", async () => {
    const srv = makeServer(vi.fn(() => 1));
    await expect(srv.callTool(TOKEN, "viewer_create", { path: "solo-nombre" })).rejects.toThrow(
      /path incompleto/,
    );
  });
});

describe("viewer · C1 HMAC split (HMAC key ≠ path-secret)", () => {
  it("acepta token firmado con la HMAC key dedicada (VIEWER_MCP_HMAC_KEY)", async () => {
    const push = vi.fn(() => 1);
    const srv = makeServer(push);
    const token = signUserToken(USER, HMAC_KEY); // firmado con la HMAC key
    const out = await srv.callTool(token, "viewer_open", { path: "demo-personal/backlog-ceibo.md" });
    expect(out).toMatchObject({ delivered: true });
  });

  it("rechaza token firmado con el path-secret (VIEWER_MCP_SECRET) cuando hay HMAC key distinta", async () => {
    const push = vi.fn(() => 1);
    // El servidor fue construido con HMAC_KEY; el token está firmado con PATH_SECRET.
    const srv = makeServer(push);
    const tokenSignedWithPathSecret = signUserToken(USER, PATH_SECRET);
    await expect(
      srv.callTool(tokenSignedWithPathSecret, "viewer_open", { path: "demo-personal/backlog-ceibo.md" }),
    ).rejects.toThrow(/token de viewer inválido/);
    expect(push).not.toHaveBeenCalled();
  });
});
