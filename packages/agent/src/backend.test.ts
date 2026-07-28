import { describe, expect, it } from "vitest";
import { makeMaBackend } from "./index.ts";

// Fake estructural del client Anthropic: captura todo lo que la costura toca, para
// verificar que makeMaBackend delega 1:1 (sin lógica propia) al SDK.
function fakeClient() {
  const calls: { op: string; args: unknown[] }[] = [];
  const rec =
    (op: string, ret?: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ op, args });
      return ret;
    };
  const client = {
    beta: {
      vaults: {
        create: rec("vaults.create", { id: "vault_new" }),
        credentials: {
          list: rec("credentials.list", { data: [] }),
          create: rec("credentials.create"),
          update: rec("credentials.update"),
          delete: rec("credentials.delete"),
        },
      },
      sessions: {
        create: rec("sessions.create", { id: "sess_new" }),
        update: rec("sessions.update"),
        retrieve: rec("sessions.retrieve", { status: "idle" }),
        events: { stream: rec("events.stream"), send: rec("events.send") },
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: stub estructural
  } as any;
  return { client, calls };
}

describe("makeMaBackend (la costura → MA)", () => {
  it("createVault → vaults.create y devuelve el id", async () => {
    const { client, calls } = fakeClient();
    const id = await makeMaBackend(client).createVault("ceibo · alguien");
    expect(id).toBe("vault_new");
    expect(calls.find((c) => c.op === "vaults.create")?.args[0]).toEqual({ display_name: "ceibo · alguien" });
  });

  it("createSession → sessions.create y devuelve el id", async () => {
    const { client, calls } = fakeClient();
    const id = await makeMaBackend(client).createSession({ agentId: "ag1", envId: "env1" }, "t");
    expect(id).toBe("sess_new");
    const body = calls.find((c) => c.op === "sessions.create")?.args[0] as { agent: string };
    expect(body.agent).toBe("ag1");
  });

  it("reuseOrCreate reusa la sesión viva (retrieve idle) sin crear", async () => {
    const { client, calls } = fakeClient();
    const id = await makeMaBackend(client).reuseOrCreate({ agentId: "ag1", envId: "env1" }, "t", "sess_old");
    expect(id).toBe("sess_old");
    expect(calls.some((c) => c.op === "sessions.create")).toBe(false);
  });

  it("setStaticBearerCredential crea la cred cuando el vault está vacío", async () => {
    const { client, calls } = fakeClient();
    await makeMaBackend(client).setStaticBearerCredential("v1", {
      mcpServerUrl: "https://mcp/x",
      displayName: "X",
      token: "tok",
    });
    expect(calls.some((c) => c.op === "credentials.create")).toBe(true);
  });

  it("setSessionAgentConfig → sessions.update con el agent override", async () => {
    const { client, calls } = fakeClient();
    const agentCfg = { mcp_servers: [], tools: [] } as never;
    await makeMaBackend(client).setSessionAgentConfig("sess1", agentCfg);
    expect(calls.find((c) => c.op === "sessions.update")?.args).toEqual(["sess1", { agent: agentCfg }]);
  });

  it("attach devuelve un Relay con send/interrupt/close", () => {
    const { client } = fakeClient();
    const relay = makeMaBackend(client).attach("sess1", { message: () => {} });
    expect(typeof relay.send).toBe("function");
    expect(typeof relay.interrupt).toBe("function");
    expect(typeof relay.close).toBe("function");
    relay.close();
  });
});
