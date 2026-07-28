// Regresión: provisionar y usar el vault LOCAL para un usuario en backend 'local' (archima).
//
// Bug: `ensureVault` (y los pushes de credenciales de prepareSession) usaban SIEMPRE
// `user.vault_id` — el vault MA (vlt_011C…). Un usuario que se pasa a 'local' con un vault MA
// heredado le pasaba ese id al agent-vault de la box (IDs propios, UUID/slug) → "Vault not found",
// y el turno abortaba antes de recordTurn. Fix: el vault se elige por backend (vaultIdForUser) y se
// provisiona on-demand en la columna que le corresponde (local → local_vault_id), sin pisar el MA.
//
// Este e2e cablea el motor REAL con un SessionBackend fake que registra qué vault recibe createVault
// /setStaticBearerCredential/createSession, y verifica que para un user 'local' con vault_id MA
// stale: (1) se provisiona un vault NUEVO, (2) las ops de vault reciben ESE id (no el MA), (3) queda
// persistido en local_vault_id y vault_id MA queda intacto.

import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionBackend, SessionConfig, Sink } from "@ceibo/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGateway } from "./engine.ts";

const { startCliChannel } = await import("@ceibo/channels");
const { addChannel, addUser, getUser, openDb, setUserBackendMode, setUserVault } = await import(
  "@ceibo/store"
);

type Db = ReturnType<typeof openDb>;

const STALE_MA_VAULT = "vlt_011Cbo_stale_ma";

// Backend fake que REGISTRA las ops de vault. createVault devuelve un id local determinista
// (espeja `agent-vault vault create` → un id propio de la box).
function recordingBackend() {
  const rec = {
    createVaultCalls: [] as string[], // displayNames
    credVaultIds: [] as string[], // vaultId que recibe setStaticBearerCredential (= --vault)
    credCalls: [] as { vaultId: string; mcpServerUrl: string; displayName: string; token: string }[],
    sessionVaultIds: [] as (string | undefined)[], // cfg.vaultId que recibe createSession (= cp.sh assign)
  };
  let n = 0;
  const backend: SessionBackend = {
    createVault: async (displayName: string) => {
      rec.createVaultCalls.push(displayName);
      n += 1;
      return `archima-local-vault-${n}`;
    },
    setStaticBearerCredential: async (
      vaultId: string,
      c: { mcpServerUrl: string; displayName: string; token: string },
    ) => {
      rec.credVaultIds.push(vaultId);
      rec.credCalls.push({ vaultId, ...c });
    },
    revokeOauthCredential: async () => false,
    setSessionAgentConfig: async () => {},
    createSession: async (cfg: SessionConfig) => {
      rec.sessionVaultIds.push(cfg.vaultId);
      return "sess-fake";
    },
    reuseOrCreate: async (cfg: SessionConfig) => {
      rec.sessionVaultIds.push(cfg.vaultId);
      return "sess-fake";
    },
    attach: (_sid, sink: Sink) => ({
      send: async (text: string) => {
        await sink.message(`eco: ${text}`);
        await sink.turnComplete?.(
          { input: 1, output: 1, cache5m: 0, cache1h: 0, cacheRead: 0 },
          "gemma4-31b",
        );
      },
      interrupt: async () => {},
      close: () => {},
    }),
  };
  return { backend, rec };
}

let db: Db;
let channel: { close(): void };
let sock: string;
let sockN = 0;
let gw: ReturnType<typeof createGateway>;
let testerId: number;
let rec: ReturnType<typeof recordingBackend>["rec"];

beforeEach(() => {
  db = openDb(":memory:");
  const u = addUser(db, "tester");
  testerId = u.id;
  addChannel(db, u.id, "cli", "tester");
  // El usuario está en 'local' y arrastra un vault_id MA stale (de cuando estaba en 'ma').
  setUserVault(db, u.id, STALE_MA_VAULT);
  setUserBackendMode(db, u.id, "local");

  const b = recordingBackend();
  rec = b.rec;

  gw = createGateway({
    // CONTROL_MCP_* fuerza needVault=true en prepareSession y dispara un setStaticBearerCredential.
    env: {
      AGENT_ID: "agent-test",
      ENV_ID: "env-test",
      CONTROL_MCP_URL: "https://app/mcp/control/x",
      CONTROL_MCP_SECRET: "ctl-path-secret",
      // C1: HMAC key separada del path-secret; debe estar para que prepareSession mintee la cred.
      CONTROL_MCP_HMAC_KEY: "ctl-hmac-key",
      // Búsqueda web (Tavily): la cred se siembra en CADA vault (sin esto, user nuevo sin web search).
      TAVILY_MCP_URL: "https://mcp.tavily.com/mcp/",
      TAVILY_API_KEY: "tvly-test-key-xyz",
    } as NodeJS.ProcessEnv,
    client: {} as never,
    backendForUser: () => b.backend, // el user 'local' resuelve a este backend que registra
    db,
    cfg: { agentId: "agent-test", envId: "env-test" },
    wikis: undefined,
    cronTarget: () => undefined,
  });

  sock = join(tmpdir(), `ceibo-localvault-${process.pid}-${sockN++}.sock`);
  channel = startCliChannel(sock, {
    handleIncoming: gw.handleIncoming,
    sendBroadcast: gw.sendBroadcast,
  });
});

afterEach(() => {
  channel.close();
  db.close();
});

function dialog(externalId: string, text: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const out: string[] = [];
    let buf = "";
    let quiet: ReturnType<typeof setTimeout>;
    const conn = net.connect(sock);
    const bump = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        conn.end();
        resolve(out);
      }, 80);
    };
    conn.on("connect", () => conn.write(`${JSON.stringify({ t: "hello", externalId })}\n`));
    conn.on("data", (d) => {
      buf += d.toString("utf8");
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: drain NDJSON
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line) as { t: string; text?: string };
        if (m.t === "ready") {
          conn.write(`${JSON.stringify({ t: "msg", text })}\n`);
          bump();
        } else if (m.t === "out" || m.t === "typing") {
          if (m.t === "out") out.push(m.text ?? "");
          bump();
        }
      }
    });
    conn.on("error", reject);
  });
}

describe("gateway · vault local para usuario backend 'local'", () => {
  it("provisiona un vault local on-demand y usa ESE id (no el vault MA stale)", async () => {
    const out = await dialog("tester", "hola");
    // el turno completó (no abortó por "Vault not found"); el eco arranca con el tag de hora
    // que se antepone al turno → confirmamos que terminó con el texto del usuario.
    expect(out.some((o) => o.endsWith("hola"))).toBe(true);

    // 1) Se provisionó exactamente un vault local (vault_id MA no servía para archima).
    expect(rec.createVaultCalls).toHaveLength(1);
    const provisioned = "archima-local-vault-1";

    // 2) El push de credenciales (= `agent-vault ... --vault <id>`) usó el id LOCAL, nunca el MA.
    expect(rec.credVaultIds.length).toBeGreaterThanOrEqual(1);
    expect(rec.credVaultIds.every((v) => v === provisioned)).toBe(true);
    expect(rec.credVaultIds).not.toContain(STALE_MA_VAULT);

    // 3) La sesión (= `cp.sh assign`) también recibió el vault local.
    expect(rec.sessionVaultIds).toContain(provisioned);
    expect(rec.sessionVaultIds).not.toContain(STALE_MA_VAULT);

    // 4) Quedó persistido en local_vault_id; el vault MA sigue intacto (el user puede volver a 'ma').
    const u = getUser(db, testerId);
    expect(u?.local_vault_id).toBe(provisioned);
    expect(u?.vault_id).toBe(STALE_MA_VAULT);
  });

  it("segundo turno reusa el local_vault_id ya provisionado (no crea otro)", async () => {
    await dialog("tester", "hola");
    await dialog("tester", "de nuevo");
    // Una sola creación de vault a lo largo de los dos turnos.
    expect(rec.createVaultCalls).toHaveLength(1);
    expect(getUser(db, testerId)?.local_vault_id).toBe("archima-local-vault-1");
  });

  // Regresión del agujero sistémico (2026-06-19): la cred de Tavily (búsqueda web) sólo estaba
  // sembrada a mano en UN vault → todos los demás usuarios daban 401. Ahora se siembra por sesión
  // en el vault de CADA user 'local', con la API key del env (no un token que firmemos nosotros).
  it("siembra la cred de Tavily en el vault local con la API key del env", async () => {
    await dialog("tester", "hola");
    const tavily = rec.credCalls.find((c) => c.mcpServerUrl === "https://mcp.tavily.com/mcp/");
    expect(tavily).toBeDefined();
    expect(tavily?.token).toBe("tvly-test-key-xyz"); // la API key del hogar, no un token firmado
    expect(tavily?.vaultId).toBe("archima-local-vault-1"); // el vault LOCAL provisionado
  });
});
