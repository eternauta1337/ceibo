import { describe, expect, it } from "vitest";
import { createSession, reuseOrCreate, type SessionConfig, setSessionAgentConfig } from "./index.ts";

// Fake del client: captura sessions.create/update y deja al test fijar retrieve.
function fakeClient(retrieve?: (id: string) => Promise<{ status: string }>) {
  const created: Record<string, unknown>[] = [];
  const updated: { id: string; body: unknown }[] = [];
  let uploads = 0; // ids deterministas para los File resources de wiki-sync
  const client = {
    beta: {
      sessions: {
        create: async (body: Record<string, unknown>) => {
          created.push(body);
          return { id: "sess_new" };
        },
        update: async (id: string, body: unknown) => {
          updated.push({ id, body });
        },
        retrieve: retrieve ?? (async () => ({ status: "idle" })),
      },
      files: { upload: async () => ({ id: `file_${++uploads}` }) },
    },
    // biome-ignore lint/suspicious/noExplicitAny: stub estructural
  } as any;
  return { client, created, updated };
}

const cfg = (over: Partial<SessionConfig> = {}): SessionConfig => ({
  agentId: "ag1",
  envId: "env1",
  ...over,
});

describe("createSession", () => {
  it("monta repos (github_repository con el token) y sube wiki-sync (script + token) como file resources", async () => {
    const { client, created } = fakeClient();
    await createSession(
      client,
      cfg({
        vaultId: "v1",
        repos: [{ url: "https://gh/r", mountPath: "/w/r" }],
        repoToken: "tok",
        wikiSync: { token: "u42.sig", url: "https://host/api/sync" },
      }),
      "título",
    );
    const body = created[0] as { agent: string; vault_ids: string[]; resources: Record<string, unknown>[] };
    expect(body.agent).toBe("ag1");
    expect(body.vault_ids).toEqual(["v1"]);
    // El repo va primero; después los dos File resources del sync (mount_paths fijos). El upload
    // a la Files API (file_id) pasa abajo de la costura — sólo afirmamos los mount_paths.
    expect(body.resources[0]).toEqual({
      type: "github_repository",
      url: "https://gh/r",
      authorization_token: "tok",
      mount_path: "/w/r",
    });
    expect(body.resources.slice(1).map((r) => ({ type: r.type, mount_path: r.mount_path }))).toEqual([
      { type: "file", mount_path: "wiki-sync.mjs" },
      { type: "file", mount_path: "wiki-token" },
    ]);
  });

  it("sin repos/wikiSync/vault → sin resources ni vault_ids", async () => {
    const { client, created } = fakeClient();
    await createSession(client, cfg(), "t");
    const body = created[0] as Record<string, unknown>;
    expect(body.resources).toBeUndefined();
    expect(body.vault_ids).toBeUndefined();
  });

  it("repos sin token → no monta los repos (necesita el token de clone)", async () => {
    const { client, created } = fakeClient();
    await createSession(client, cfg({ repos: [{ url: "u", mountPath: "m" }] }), "t");
    expect((created[0] as Record<string, unknown>).resources).toBeUndefined();
  });
});

describe("reuseOrCreate", () => {
  it("sesión existente viva (idle/running) → la reusa, no crea", async () => {
    const { client, created } = fakeClient(async () => ({ status: "running" }));
    const id = await reuseOrCreate(client, cfg(), "t", "sess_old");
    expect(id).toBe("sess_old");
    expect(created).toHaveLength(0);
  });

  it("sesión existente terminada → crea una nueva", async () => {
    const { client, created } = fakeClient(async () => ({ status: "terminated" }));
    const id = await reuseOrCreate(client, cfg(), "t", "sess_old");
    expect(id).toBe("sess_new");
    expect(created).toHaveLength(1);
  });

  it("retrieve tira (no existe) → crea una nueva", async () => {
    const { client, created } = fakeClient(async () => {
      throw new Error("404");
    });
    expect(await reuseOrCreate(client, cfg(), "t", "sess_old")).toBe("sess_new");
    expect(created).toHaveLength(1);
  });

  it("sin sesión previa → crea", async () => {
    const { client, created } = fakeClient();
    expect(await reuseOrCreate(client, cfg(), "t")).toBe("sess_new");
    expect(created).toHaveLength(1);
  });
});

describe("setSessionAgentConfig", () => {
  it("hace sessions.update con el agent override", async () => {
    const { client, updated } = fakeClient();
    const agentCfg = { mcp_servers: [], tools: [] } as never;
    await setSessionAgentConfig(client, "sess1", agentCfg);
    expect(updated).toEqual([{ id: "sess1", body: { agent: agentCfg } }]);
  });
});
