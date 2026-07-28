import { describe, expect, it } from "vitest";
import { revokeOauthCredential, setMcpCredential, setStaticBearerCredential } from "./index.ts";

// Credencial tal como la lista el vault (forma mínima que consumimos).
type Cred = { id: string; auth: { type: string; mcp_server_url: string } };

// Fake del client Anthropic: solo el sub-árbol vaults.credentials, registrando ops.
function fakeVault(creds: Cred[] = []) {
  const ops = {
    update: [] as { id: string; body: unknown }[],
    create: [] as { vaultId: string; body: { display_name: string; auth: Record<string, unknown> } }[],
    delete: [] as { id: string }[],
  };
  const client = {
    beta: {
      vaults: {
        credentials: {
          list: async () => ({ data: creds }),
          update: async (id: string, body: unknown) => {
            ops.update.push({ id, body });
          },
          create: async (vaultId: string, body: { display_name: string; auth: Record<string, unknown> }) => {
            ops.create.push({ vaultId, body });
          },
          delete: async (id: string) => {
            ops.delete.push({ id });
          },
        },
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: stub estructural, no es un Anthropic real
  } as any;
  return { client, ops };
}

const cred = (id: string, url: string, type = "static_bearer"): Cred => ({
  id,
  auth: { type, mcp_server_url: url },
});

describe("setMcpCredential", () => {
  it("sin credencial previa → crea una github-mcp static_bearer con la URL y el token", async () => {
    const { client, ops } = fakeVault([]);
    await setMcpCredential(client, "v1", "https://api/mcp/", "tok");
    expect(ops.create).toHaveLength(1);
    expect(ops.update).toHaveLength(0);
    expect(ops.create[0]?.body).toMatchObject({
      display_name: "github-mcp",
      auth: { type: "static_bearer", mcp_server_url: "https://api/mcp/", token: "tok" },
    });
  });

  it("credencial existente para esa URL → update del token conservando el id (no crea)", async () => {
    const { client, ops } = fakeVault([cred("c1", "https://api/mcp/")]);
    await setMcpCredential(client, "v1", "https://api/mcp/", "tok2");
    expect(ops.create).toHaveLength(0);
    expect(ops.update).toHaveLength(1);
    expect(ops.update[0]?.id).toBe("c1");
    expect(ops.update[0]?.body).toMatchObject({ auth: { type: "static_bearer", token: "tok2" } });
  });

  it("matchea ignorando el trailing slash (Anthropic lo normaliza)", async () => {
    const { client, ops } = fakeVault([cred("c1", "https://api/mcp")]); // guardada sin slash
    await setMcpCredential(client, "v1", "https://api/mcp/", "tok"); // pedida con slash
    expect(ops.update).toHaveLength(1);
    expect(ops.create).toHaveLength(0);
  });
});

describe("setStaticBearerCredential", () => {
  const c = { mcpServerUrl: "https://api/mcp/", displayName: "Gmail", token: "tok" };

  it("sin previa → crea", async () => {
    const { client, ops } = fakeVault([]);
    await setStaticBearerCredential(client, "v1", c);
    expect(ops.create).toHaveLength(1);
    expect(ops.delete).toHaveLength(0);
    expect(ops.create[0]?.body.display_name).toBe("Gmail");
  });

  it("previa static_bearer → update in-place (sin delete, conserva id)", async () => {
    const { client, ops } = fakeVault([cred("c1", "https://api/mcp/", "static_bearer")]);
    await setStaticBearerCredential(client, "v1", c);
    expect(ops.update).toHaveLength(1);
    expect(ops.update[0]?.id).toBe("c1");
    expect(ops.delete).toHaveLength(0);
    expect(ops.create).toHaveLength(0);
  });

  it("previa de otro tipo (mcp_oauth heredado) → migración delete + create", async () => {
    const { client, ops } = fakeVault([cred("c1", "https://api/mcp/", "mcp_oauth")]);
    await setStaticBearerCredential(client, "v1", c);
    expect(ops.delete).toHaveLength(1);
    expect(ops.delete[0]?.id).toBe("c1");
    expect(ops.create).toHaveLength(1);
    expect(ops.update).toHaveLength(0);
  });
});

describe("revokeOauthCredential", () => {
  it("existe → la borra y devuelve true", async () => {
    const { client, ops } = fakeVault([cred("c1", "https://api/mcp/")]);
    expect(await revokeOauthCredential(client, "v1", "https://api/mcp/")).toBe(true);
    expect(ops.delete[0]?.id).toBe("c1");
  });

  it("no existe → false, sin borrar nada", async () => {
    const { client, ops } = fakeVault([]);
    expect(await revokeOauthCredential(client, "v1", "https://api/mcp/")).toBe(false);
    expect(ops.delete).toHaveLength(0);
  });
});
