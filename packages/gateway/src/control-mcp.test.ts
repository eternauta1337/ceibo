// Unit del MCP `control` (tool ceibo_command): valida el Bearer firmado → userId y delega en
// runCommandForUser. No toca el gateway real: inyectamos un runCommandForUser fake que registra
// con qué (userId, command) fue llamado.
//
// C1 (HMAC split): SECRET es la HMAC key dedicada (CONTROL_MCP_HMAC_KEY); PATH_SECRET es el
// path-secret de la URL (CONTROL_MCP_SECRET). Son valores distintos en este test para verificar
// que el servidor rechaza tokens firmados con el path-secret y acepta los firmados con la HMAC key.

import { signUserToken } from "@ceibo/store";
import { describe, expect, it, vi } from "vitest";
import { makeControlServer } from "./control-mcp.ts";

const SECRET = "test-control-hmac-key"; // CONTROL_MCP_HMAC_KEY
const PATH_SECRET = "test-control-path-secret"; // CONTROL_MCP_SECRET (sólo para el path gate)

describe("MCP control · ceibo_command", () => {
  it("verifica el token, saca el userId y corre el comando para ese usuario", async () => {
    const run = vi.fn(async (_userId: number, _cmd: string) => "Sesión nueva: sess-1");
    const server = makeControlServer(SECRET, run);
    const token = signUserToken(42, SECRET);

    const out = (await server.callTool(token, "ceibo_command", { command: "/new" })) as {
      ran: string;
      result: string;
    };

    expect(run).toHaveBeenCalledWith(42, "/new");
    expect(out.result).toBe("Sesión nueva: sess-1");
    expect(out.ran).toBe("/new");
  });

  it("rechaza un token inválido (no corre el comando)", async () => {
    const run = vi.fn(async () => "x");
    const server = makeControlServer(SECRET, run);

    await expect(server.callTool("token-falso", "ceibo_command", { command: "/new" })).rejects.toThrow(
      /token de control inválido/,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("rechaza una tool desconocida", async () => {
    const server = makeControlServer(
      SECRET,
      vi.fn(async () => "x"),
    );
    const token = signUserToken(1, SECRET);
    await expect(server.callTool(token, "otra_tool", { command: "/new" })).rejects.toThrow(
      /tool desconocida/,
    );
  });

  it("tira si falta `command`", async () => {
    const server = makeControlServer(
      SECRET,
      vi.fn(async () => "x"),
    );
    const token = signUserToken(1, SECRET);
    await expect(server.callTool(token, "ceibo_command", {})).rejects.toThrow(/falta `command`/);
  });
});

describe("MCP control · subagent_spawn (sub-agentes async)", () => {
  it("verifica el token, saca el userId y despacha el worker (goal + title)", async () => {
    const spawn = vi.fn(async () => "sub-agente despachado (id 1): reorg wiki");
    const server = makeControlServer(
      SECRET,
      vi.fn(async () => "x"),
      spawn,
    );
    const token = signUserToken(9, SECRET);

    const out = (await server.callTool(token, "subagent_spawn", {
      goal: "reorganizá la wiki de viajes por destino",
      title: "reorg wiki",
    })) as { message: string };

    expect(spawn).toHaveBeenCalledWith(9, "reorganizá la wiki de viajes por destino", "reorg wiki");
    expect(out.message).toMatch(/despachado \(id 1\)/);
  });

  it("pasa title undefined cuando no se da", async () => {
    const spawn = vi.fn(async () => "sub-agente despachado (id 2): tarea #2");
    const server = makeControlServer(
      SECRET,
      vi.fn(async () => "x"),
      spawn,
    );
    const token = signUserToken(9, SECRET);
    await server.callTool(token, "subagent_spawn", { goal: "hacé algo largo" });
    expect(spawn).toHaveBeenCalledWith(9, "hacé algo largo", undefined);
  });

  it("tira si falta `goal`", async () => {
    const server = makeControlServer(
      SECRET,
      vi.fn(async () => "x"),
      vi.fn(async () => "ok"),
    );
    const token = signUserToken(1, SECRET);
    await expect(server.callTool(token, "subagent_spawn", {})).rejects.toThrow(/falta `goal`/);
  });

  it("tira si el gateway no habilitó sub-agentes async (sin spawnSubagent)", async () => {
    const server = makeControlServer(
      SECRET,
      vi.fn(async () => "x"),
    );
    const token = signUserToken(1, SECRET);
    await expect(server.callTool(token, "subagent_spawn", { goal: "x" })).rejects.toThrow(
      /no están habilitados/,
    );
  });

  it("rechaza token inválido (no despacha)", async () => {
    const spawn = vi.fn(async () => "x");
    const server = makeControlServer(
      SECRET,
      vi.fn(async () => "x"),
      spawn,
    );
    await expect(server.callTool("token-falso", "subagent_spawn", { goal: "x" })).rejects.toThrow(
      /token de control inválido/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("MCP control · subagent_kill (cancelar sub-agentes)", () => {
  it("verifica el token, saca el userId y cancela por ref (id o título)", async () => {
    const kill = vi.fn(async () => "Cancelado el sub-agente (id 2): contador lento");
    const server = makeControlServer(
      SECRET,
      vi.fn(async () => "x"),
      vi.fn(async () => "x"),
      kill,
    );
    const token = signUserToken(9, SECRET);

    const out = (await server.callTool(token, "subagent_kill", { subagent: "contador lento" })) as {
      message: string;
    };

    expect(kill).toHaveBeenCalledWith(9, "contador lento");
    expect(out.message).toMatch(/Cancelado el sub-agente \(id 2\)/);
  });

  it("tira si falta `subagent`", async () => {
    const server = makeControlServer(
      SECRET,
      vi.fn(async () => "x"),
      vi.fn(async () => "x"),
      vi.fn(async () => "x"),
    );
    const token = signUserToken(1, SECRET);
    await expect(server.callTool(token, "subagent_kill", {})).rejects.toThrow(/falta `subagent`/);
  });

  it("tira si el gateway no habilitó sub-agentes async (sin killSubagent)", async () => {
    const server = makeControlServer(
      SECRET,
      vi.fn(async () => "x"),
    );
    const token = signUserToken(1, SECRET);
    await expect(server.callTool(token, "subagent_kill", { subagent: "1" })).rejects.toThrow(
      /no están habilitados/,
    );
  });

  it("rechaza token inválido (no cancela)", async () => {
    const kill = vi.fn(async () => "x");
    const server = makeControlServer(
      SECRET,
      vi.fn(async () => "x"),
      vi.fn(async () => "x"),
      kill,
    );
    await expect(server.callTool("token-falso", "subagent_kill", { subagent: "1" })).rejects.toThrow(
      /token de control inválido/,
    );
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("MCP control · tools semánticas de conexión", () => {
  it("connect_service corre /connect <svc> <perfil> y extrae el auth_url del texto", async () => {
    const run = vi.fn(
      async () =>
        'Para conectar gmail (perfil "personal"), abrí este link (vence en 30 min, un solo uso) y ' +
        "aprobá el acceso:\nhttps://ceibo.example.com/oauth/start?t=abc123",
    );
    const server = makeControlServer(SECRET, run);
    const token = signUserToken(7, SECRET);

    const out = (await server.callTool(token, "connect_service", {
      service: "gmail",
      profile: "personal",
    })) as { service: string; profile: string; auth_url: string };

    expect(run).toHaveBeenCalledWith(7, "/connect gmail personal");
    expect(out.auth_url).toBe("https://ceibo.example.com/oauth/start?t=abc123");
    expect(out.service).toBe("gmail");
    expect(out.profile).toBe("personal");
  });

  it("connect_service con postToUser: postea el auth_url EXACTO al chat fuera de banda y NO lo devuelve al modelo", async () => {
    const run = vi.fn(async () => "abrí este link y aprobá:\nhttps://ceibo.example.com/oauth/start?t=xyz789");
    const posted: Array<{ userId: number; text: string }> = [];
    const postToUser = vi.fn(async (userId: number, text: string) => {
      posted.push({ userId, text });
      return true;
    });
    const server = makeControlServer(SECRET, run, undefined, undefined, postToUser);
    const token = signUserToken(7, SECRET);

    const out = (await server.callTool(token, "connect_service", {
      service: "gmail",
      profile: "work",
    })) as { delivered?: boolean; auth_url?: string };

    // El link EXACTO se posteó al chat del user (out-of-band); NO se le devuelve al modelo, así no
    // lo puede manglear (escribir `[auth_url]`) ni inventar otro.
    expect(posted).toHaveLength(1);
    expect(posted[0]?.userId).toBe(7);
    expect(posted[0]?.text).toContain("https://ceibo.example.com/oauth/start?t=xyz789");
    expect(out.delivered).toBe(true);
    expect(out.auth_url).toBeUndefined();
  });

  it("connect_service con postToUser que no pudo postear (sin thread) → fallback: devuelve el auth_url", async () => {
    const run = vi.fn(async () => "link:\nhttps://ceibo.example.com/oauth/start?t=fallback");
    const postToUser = vi.fn(async () => false); // no había thread vivo
    const server = makeControlServer(SECRET, run, undefined, undefined, postToUser);
    const token = signUserToken(7, SECRET);

    const out = (await server.callTool(token, "connect_service", {
      service: "gmail",
      profile: "personal",
    })) as { auth_url?: string; delivered?: boolean };

    expect(out.auth_url).toBe("https://ceibo.example.com/oauth/start?t=fallback");
    expect(out.delivered).toBeUndefined();
  });

  it("connect_service sin URL (error del flujo) relaya el mensaje y auth_url null", async () => {
    const run = vi.fn(async () => 'No conozco "foo". Disponibles: gmail, calendar');
    const server = makeControlServer(SECRET, run);
    const token = signUserToken(7, SECRET);

    const out = (await server.callTool(token, "connect_service", {
      service: "foo",
      profile: "personal",
    })) as { auth_url: string | null; message: string };

    expect(out.auth_url).toBeNull();
    expect(out.message).toMatch(/No conozco/);
  });

  it("connect_service exige service y profile", async () => {
    const server = makeControlServer(
      SECRET,
      vi.fn(async () => "x"),
    );
    const token = signUserToken(1, SECRET);
    await expect(server.callTool(token, "connect_service", { service: "gmail" })).rejects.toThrow(
      /falta `profile`/,
    );
    await expect(server.callTool(token, "connect_service", { profile: "personal" })).rejects.toThrow(
      /falta `service`/,
    );
  });

  it("list_connections corre /connections y devuelve el texto", async () => {
    const run = vi.fn(async () => "Conectables: gmail, calendar\n\nConectado:\n  (nada todavía)");
    const server = makeControlServer(SECRET, run);
    const token = signUserToken(7, SECRET);

    const out = (await server.callTool(token, "list_connections", {})) as { connections: string };
    expect(run).toHaveBeenCalledWith(7, "/connections");
    expect(out.connections).toMatch(/Conectables/);
  });

  it("disconnect_service arma la línea con y sin perfil", async () => {
    const run = vi.fn(async () => "Desconectaste gmail.");
    const server = makeControlServer(SECRET, run);
    const token = signUserToken(7, SECRET);

    await server.callTool(token, "disconnect_service", { service: "gmail" });
    expect(run).toHaveBeenCalledWith(7, "/disconnect gmail");
    await server.callTool(token, "disconnect_service", { service: "gmail", profile: "work" });
    expect(run).toHaveBeenCalledWith(7, "/disconnect gmail work");
  });

  it("connect_whatsapp corre /connect whatsapp <phone> y suma los pasos del menú", async () => {
    const run = vi.fn(
      async () => "Conectando WhatsApp (+54 9 11 1234-5678)… en unos segundos te paso el código.",
    );
    const server = makeControlServer(SECRET, run);
    const token = signUserToken(7, SECRET);

    const out = (await server.callTool(token, "connect_whatsapp", {
      phone: "+54 9 11 1234-5678",
    })) as { message: string; pairing_steps: string };

    expect(run).toHaveBeenCalledWith(7, "/connect whatsapp +54 9 11 1234-5678");
    expect(out.message).toMatch(/Conectando WhatsApp/);
    expect(out.pairing_steps).toMatch(/Dispositivos vinculados/);
  });

  it("rechaza token inválido en una tool de conexión (no corre nada)", async () => {
    const run = vi.fn(async () => "x");
    const server = makeControlServer(SECRET, run);
    await expect(
      server.callTool("token-falso", "connect_service", { service: "gmail", profile: "personal" }),
    ).rejects.toThrow(/token de control inválido/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("MCP control · C1 HMAC split (HMAC key ≠ path-secret)", () => {
  it("acepta token firmado con la HMAC key dedicada (CONTROL_MCP_HMAC_KEY)", async () => {
    const run = vi.fn(async () => "ok");
    const server = makeControlServer(SECRET, run);
    const token = signUserToken(5, SECRET); // firmado con la HMAC key
    const out = (await server.callTool(token, "ceibo_command", { command: "/session" })) as {
      result: string;
    };
    expect(run).toHaveBeenCalledWith(5, "/session");
    expect(out.result).toBe("ok");
  });

  it("rechaza token firmado con el path-secret (CONTROL_MCP_SECRET) cuando hay HMAC key distinta", async () => {
    const run = vi.fn(async () => "x");
    // El servidor fue construido con SECRET (HMAC key); el token está firmado con PATH_SECRET.
    const server = makeControlServer(SECRET, run);
    const tokenSignedWithPathSecret = signUserToken(5, PATH_SECRET);
    await expect(
      server.callTool(tokenSignedWithPathSecret, "ceibo_command", { command: "/session" }),
    ).rejects.toThrow(/token de control inválido/);
    expect(run).not.toHaveBeenCalled();
  });
});
