import type { Sink } from "@ceibo/agent";
import { describe, expect, it } from "vitest";
import {
  ArchimaBackend,
  type ArchimaDeps,
  type OpencodeClient,
  SESSION_LOST_USER_MSG,
} from "./archima-backend.ts";
import { HttpOpencodeClient } from "./http-opencode-client.ts";
import type { OpencodeEvent } from "./opencode-events.ts";

/** `state` controla qué reporta `cp.sh state <name>`: "missing" (VM ausente, default), "running"
 *  (VM viva) o "shut off" (apagada). Es lo que decide el branch del lifecycle idempotente. */
function mockExec(state: "missing" | "running" | "shut off" = "missing") {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    if (args[0] === "state") return state;
    return "";
  };
  return { exec, calls };
}

/** OpencodeClient mock: events() emite el script una vez, después bloquea hasta close. */
function mockOpencode(script: OpencodeEvent[]): { oc: OpencodeClient; prompts: unknown[][] } {
  const prompts: unknown[][] = [];
  let emitted = false;
  const oc: OpencodeClient = {
    ensureSession: async () => {},
    unbind: () => {},
    openWorkerSession: async (vm) => `${vm}#worker:ses_mock`,
    setAgentConfig: async () => {},
    abort: async () => {},
    summarize: async () => ({}),
    prompt: async (_id, parts) => {
      prompts.push(parts);
      return {};
    },
    events: async function* () {
      if (emitted) {
        await new Promise(() => {}); // 2da vuelta: bloquea (hasta close)
        return;
      }
      emitted = true;
      for (const ev of script) yield ev;
    },
  };
  return { oc, prompts };
}

function deps(oc: OpencodeClient): ArchimaDeps {
  return { exec: mockExec().exec, cp: "/cp.sh", av: "/agent-vault", opencode: oc };
}

describe("ArchimaBackend — vault/lifecycle (shell-out)", () => {
  it("setStaticBearerCredential: credential set + service add", async () => {
    const { exec, calls } = mockExec();
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    await be.setStaticBearerCredential("u42", {
      mcpServerUrl: "https://gmail-mcp.example.com/x",
      displayName: "Gmail",
      token: "ya29.tok",
    });
    expect(calls[0]?.args.slice(0, 3)).toEqual(["vault", "credential", "set"]);
    expect(calls[0]?.args).toContain("CRED_GMAIL_MCP_EXAMPLE_COM=ya29.tok");
    // El `--vault` recibe EXACTAMENTE el vaultId que le pasaron (el local que resuelve el gateway,
    // no el vault MA): pasar el id MA acá era la causa del "Vault not found".
    expect(calls[0]?.args[calls[0].args.indexOf("--vault") + 1]).toBe("u42");
    expect(calls[1]?.args.slice(0, 3)).toEqual(["vault", "service", "add"]);
    // URL con un solo segmento de path (`/x` = secret) → cae a host-only (compat con services
    // host-scoped previos).
    expect(calls[1]?.args).toContain("gmail-mcp.example.com");
    expect(calls[1]?.args[calls[1].args.indexOf("--vault") + 1]).toBe("u42");
  });

  it("setStaticBearerCredential: service PATH-SCOPEADO por MCP (`host/mcp/<servicio>/*`)", async () => {
    const { exec, calls } = mockExec();
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    await be.setStaticBearerCredential("u42", {
      mcpServerUrl: "https://ceibo.example.com/mcp/gmail/e5461fdeadbeef",
      displayName: "Gmail",
      token: "ya29.tok",
    });
    // service add con --host path-scopeado: el secret final NO entra al matcher, lo cubre `/*`.
    expect(calls[1]?.args.slice(0, 3)).toEqual(["vault", "service", "add"]);
    const host = calls[1]?.args[calls[1].args.indexOf("--host") + 1];
    expect(host).toBe("ceibo.example.com/mcp/gmail/*");
    // credKey incluye el path del servicio (no sólo el host).
    expect(calls[0]?.args).toContain("CRED_CEIBO_EXAMPLE_COM_MCP_GMAIL=ya29.tok");
  });

  it("setStaticBearerCredential: gmail y control en el MISMO host → service/cred distintos (no se pisan)", async () => {
    const gmail = mockExec();
    await new ArchimaBackend({
      exec: gmail.exec,
      cp: "/cp.sh",
      av: "/av",
      opencode: mockOpencode([]).oc,
    }).setStaticBearerCredential("u42", {
      mcpServerUrl: "https://ceibo.example.com/mcp/gmail/SECRETA",
      displayName: "Gmail",
      token: "google.tok",
    });
    const control = mockExec();
    await new ArchimaBackend({
      exec: control.exec,
      cp: "/cp.sh",
      av: "/av",
      opencode: mockOpencode([]).oc,
    }).setStaticBearerCredential("u42", {
      mcpServerUrl: "https://ceibo.example.com/mcp/control/SECRETB",
      displayName: "Comandos",
      token: "ceibo.tok",
    });
    const gmailHost = gmail.calls[1]?.args[gmail.calls[1].args.indexOf("--host") + 1];
    const controlHost = control.calls[1]?.args[control.calls[1].args.indexOf("--host") + 1];
    expect(gmailHost).toBe("ceibo.example.com/mcp/gmail/*");
    expect(controlHost).toBe("ceibo.example.com/mcp/control/*");
    expect(gmailHost).not.toBe(controlHost);
    // credKeys distintas → la cred de gmail (token Google) no pisa la de control (token ceibo).
    const gmailKey = gmail.calls[0]?.args.find((a) => a.startsWith("CRED_"));
    const controlKey = control.calls[0]?.args.find((a) => a.startsWith("CRED_"));
    expect(gmailKey).toBe("CRED_CEIBO_EXAMPLE_COM_MCP_GMAIL=google.tok");
    expect(controlKey).toBe("CRED_CEIBO_EXAMPLE_COM_MCP_CONTROL=ceibo.tok");
    expect(gmailKey?.split("=")[0]).not.toBe(controlKey?.split("=")[0]);
  });

  it("revokeOauthCredential: borra la cred path-aware Y el service (matcher) — si no, queda huérfano", async () => {
    const { exec, calls } = mockExec();
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    const ok = await be.revokeOauthCredential("u42", "https://ceibo.example.com/mcp/gmail/SECRET");
    expect(ok).toBe(true);
    // 1) credential delete (misma credKey que el set)
    expect(calls[0]?.args.slice(0, 3)).toEqual(["vault", "credential", "delete"]);
    expect(calls[0]?.args).toContain("CRED_CEIBO_EXAMPLE_COM_MCP_GMAIL");
    // 2) service remove por host (el matcher), si no el disconnect dejaba el service huérfano
    expect(calls[1]?.args.slice(0, 3)).toEqual(["vault", "service", "remove"]);
    expect(calls[1]?.args).toContain("ceibo.example.com/mcp/gmail/*");
  });

  it("setStaticBearerCredential: perfiles del MISMO servicio (perfil en el path) → matcher/cred DISTINTOS", async () => {
    const personal = mockExec();
    await new ArchimaBackend({
      exec: personal.exec,
      cp: "/cp.sh",
      av: "/av",
      opencode: mockOpencode([]).oc,
    }).setStaticBearerCredential("u42", {
      mcpServerUrl: "https://ceibo.example.com/mcp/gmail/personal/SECRET",
      displayName: "Gmail (personal)",
      token: "tok.personal",
    });
    const work = mockExec();
    await new ArchimaBackend({
      exec: work.exec,
      cp: "/cp.sh",
      av: "/av",
      opencode: mockOpencode([]).oc,
    }).setStaticBearerCredential("u42", {
      mcpServerUrl: "https://ceibo.example.com/mcp/gmail/work/SECRET",
      displayName: "Gmail (work)",
      token: "tok.work",
    });
    const pHost = personal.calls[1]?.args[personal.calls[1].args.indexOf("--host") + 1];
    const wHost = work.calls[1]?.args[work.calls[1].args.indexOf("--host") + 1];
    expect(pHost).toBe("ceibo.example.com/mcp/gmail/personal/*");
    expect(wHost).toBe("ceibo.example.com/mcp/gmail/work/*");
    expect(pHost).not.toBe(wHost); // ← el bug viejo: ambos caían en /mcp/gmail/* y se pisaban
    const pKey = personal.calls[0]?.args.find((a) => a.startsWith("CRED_"));
    const wKey = work.calls[0]?.args.find((a) => a.startsWith("CRED_"));
    expect(pKey).toBe("CRED_CEIBO_EXAMPLE_COM_MCP_GMAIL_PERSONAL=tok.personal");
    expect(wKey).toBe("CRED_CEIBO_EXAMPLE_COM_MCP_GMAIL_WORK=tok.work");
  });

  it("createVault devuelve un id LOCAL (slug de la box, no un vlt_ MA) + es idempotente", async () => {
    const { exec, calls } = mockExec();
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    const id = await be.createVault("ceibo · esteban");
    // El id es un slug local (NO el formato vlt_011C… de MA) → el agent-vault de la box lo conoce.
    expect(id).not.toMatch(/^vlt_/);
    expect(id).toBe("ceibo-esteban");
    expect(calls.find((c) => c.args.slice(0, 3).join(" ") === "vault create ceibo-esteban")).toBeTruthy();
  });

  it("createSession: spawn + assign + ensureSession", async () => {
    const { exec, calls } = mockExec();
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    const id = await be.createSession({ agentId: "a", envId: "e1", vaultId: "u42" }, "Chat demo");
    expect(calls.find((c) => c.args[0] === "spawn")).toBeTruthy();
    expect(calls.find((c) => c.args[0] === "assign" && c.args.includes("u42"))).toBeTruthy();
    // sin wikiSync → no hay wiki-setup
    expect(calls.find((c) => c.args[0] === "wiki-setup")).toBeFalsy();
    expect(id).toContain("e1");
  });

  it("createSession con wikiSync: entrega el sync a la VM (wiki-setup token+url)", async () => {
    const { exec, calls } = mockExec();
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    await be.createSession(
      {
        agentId: "a",
        envId: "e1",
        vaultId: "u42",
        wikiSync: { token: "42.sig", url: "https://host/api/sync" },
      },
      "Chat demo",
    );
    const ws = calls.find((c) => c.args[0] === "wiki-setup");
    expect(ws?.args).toEqual([
      "wiki-setup",
      expect.stringContaining("e1"),
      "42.sig",
      "https://host/api/sync",
    ]);
  });

  it("reuseOrCreate sobre VM viva: re-entrega el sync (idempotente, no sólo en createSession)", async () => {
    const { exec, calls } = mockExec("running"); // state→"running" → reusa la VM existente
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    const id = await be.reuseOrCreate(
      { agentId: "a", envId: "e1", wikiSync: { token: "42.sig", url: "https://host/api/sync" } },
      "Chat demo",
      "saved-vm-e1", // nombre válido de este env (contiene `-e1`) → confiable, se reusa
    );
    expect(id).toBe("saved-vm-e1"); // reusó, no creó
    expect(calls.find((c) => c.args[0] === "spawn")).toBeFalsy();
    // pero igual entregó el sync a la VM reusada
    const ws = calls.find((c) => c.args[0] === "wiki-setup");
    expect(ws?.args).toEqual(["wiki-setup", "saved-vm-e1", "42.sig", "https://host/api/sync"]);
  });

  it("reuseOrCreate desacopla el wiki-sync: NO lo espera, y wikiSyncPending refleja el estado", async () => {
    // wiki-setup queda colgado hasta que lo soltamos → simula el sync en background del reopen.
    let releaseWiki!: () => void;
    const wikiGate = new Promise<void>((r) => {
      releaseWiki = r;
    });
    const exec = async (_cmd: string, args: string[]) => {
      if (args[0] === "state") return "running";
      if (args[0] === "wiki-setup") await wikiGate; // cuelga el sync
      return "";
    };
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    // reuseOrCreate RESUELVE aunque el wiki-setup siga colgado (no lo espera) → respuesta sin bloqueo.
    const id = await be.reuseOrCreate(
      { agentId: "a", envId: "e1", wikiSync: { token: "t", url: "https://host/api/sync" } },
      "Chat demo",
      "saved-vm-e1",
    );
    expect(be.wikiSyncPending(id)).toBe(true); // sync en vuelo → el gateway avisa al agente
    releaseWiki(); // termina el sync
    for (let i = 0; i < 5; i++) await Promise.resolve(); // drena la cadena .finally
    expect(be.wikiSyncPending(id)).toBe(false); // ya sincronizó → el tag desaparece
  });

  it("createSession con VM ya viva NO re-spawnea (evita el lock collision del overlay)", async () => {
    const { exec, calls } = mockExec("running"); // zombie de un turno previo, ya running
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    const id = await be.createSession({ agentId: "a", envId: "e1", vaultId: "u42" }, "Chat demo");
    // clave: NO spawn (re-spawnear chocaría con `qemu-img: Failed to get write lock`)
    expect(calls.find((c) => c.args[0] === "spawn")).toBeFalsy();
    expect(calls.find((c) => c.args[0] === "restore")).toBeFalsy();
    // igual re-asegura el vault sobre la VM reusada
    expect(calls.find((c) => c.args[0] === "assign" && c.args.includes("u42"))).toBeTruthy();
    expect(id).toContain("e1");
  });

  it("createSession con VM apagada hace restore, no spawn", async () => {
    const { exec, calls } = mockExec("shut off");
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    await be.createSession({ agentId: "a", envId: "e1", vaultId: "u42" }, "Chat demo");
    expect(calls.find((c) => c.args[0] === "restore")).toBeTruthy();
    expect(calls.find((c) => c.args[0] === "spawn")).toBeFalsy();
  });

  it("reuseOrCreate SIN session_id pero con VM zombie viva: la detecta por nombre determinístico y la reusa", async () => {
    // El turno previo falló antes de persistir el session_id, pero dejó la VM corriendo. El nombre
    // es determinístico (título+envId) → reuseOrCreate la detecta y reusa en vez de re-spawnear.
    const { exec, calls } = mockExec("running");
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    const id = await be.reuseOrCreate({ agentId: "a", envId: "e1" }, "Chat demo", undefined);
    expect(calls.find((c) => c.args[0] === "spawn")).toBeFalsy();
    // el nombre que consultó/reusó es el determinístico
    expect(calls.find((c) => c.args[0] === "state")?.args[1]).toContain("e1");
    expect(id).toContain("e1");
  });

  it("reuseOrCreate SIN session_id y VM ausente: crea (spawn) una nueva", async () => {
    const { exec, calls } = mockExec("missing");
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    await be.reuseOrCreate({ agentId: "a", envId: "e1", vaultId: "u42" }, "Chat demo", undefined);
    expect(calls.find((c) => c.args[0] === "spawn")).toBeTruthy();
    expect(calls.find((c) => c.args[0] === "assign" && c.args.includes("u42"))).toBeTruthy();
  });

  it("reuseOrCreate con session_id de VM apagada: restore (no spawn) + ensureSession", async () => {
    const { exec, calls } = mockExec("shut off");
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    const id = await be.reuseOrCreate({ agentId: "a", envId: "e1" }, "Chat demo", "saved-vm-e1");
    expect(id).toBe("saved-vm-e1");
    expect(calls.find((c) => c.args[0] === "restore" && c.args.includes("saved-vm-e1"))).toBeTruthy();
    expect(calls.find((c) => c.args[0] === "spawn")).toBeFalsy();
  });

  // --- Validación de `existing` (anti session-id ajeno / VM basura) -------------------------------
  // Bug de prod: tras un flip `ma`→`local`, el `session_id` del store es un id de MA (`sesn_…`).
  // Confiarlo ciego como nombre de VM hacía que cp.sh clonara una VM basura con ese nombre.
  it("reuseOrCreate acepta el nombre legítimo COMPLETO (contiene `-<envId>`) y lo reusa", async () => {
    const envId = "env_013CMPPUUQY4YWv8ZFafECzg";
    const { exec, calls } = mockExec("running");
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    const legit = `ceibo-demo-gpuhost-${envId}`;
    const id = await be.reuseOrCreate({ agentId: "a", envId }, "ceibo · demo", legit);
    expect(id).toBe(legit); // confiable → reusó tal cual
    expect(calls.find((c) => c.args[0] === "spawn")).toBeFalsy();
  });

  it("reuseOrCreate acepta un nombre legítimo TRUNCADO a 50 (el slice cortó el `-<envId>`)", async () => {
    const envId = "env_013CMPPUUQY4YWv8ZFafECzg";
    // Un título largo hace que `${slug}-${envId}` supere 50 → vmName lo corta; el nombre resultante
    // termina con un PREFIJO de `-${envId}`, no con el marcador completo. Debe seguir siendo válido.
    const truncated = `ceibo-demo-archivista-del-sur-profundo-${envId}`.slice(0, 50);
    expect(truncated.length).toBe(50);
    const { exec, calls } = mockExec("running");
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    const id = await be.reuseOrCreate({ agentId: "a", envId }, "ceibo · demo", truncated);
    expect(id).toBe(truncated); // reusó el nombre truncado, NO clonó
    expect(calls.find((c) => c.args[0] === "spawn")).toBeFalsy();
  });

  it("reuseOrCreate IGNORA un session_id ajeno (`sesn_…` de MA) → nombre determinístico, no clona VM basura", async () => {
    const envId = "env_013CMPPUUQY4YWv8ZFafECzg";
    const { exec, calls } = mockExec("missing"); // el nombre basura NO existe como VM
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    const poisoned = "sesn_01McyCC4aBcDeFgHiJkLmN";
    const id = await be.reuseOrCreate({ agentId: "a", envId }, "ceibo · demo", poisoned);
    expect(id).not.toBe(poisoned);
    expect(id).toContain(envId); // cayó al nombre determinístico (contiene el env)
    // NUNCA consultó/spawneó usando el id ajeno como nombre
    expect(calls.some((c) => c.args.includes(poisoned))).toBe(false);
  });

  it("reuseOrCreate con session_id vacío usa el nombre determinístico (spawn)", async () => {
    const envId = "env_013CMPPUUQY4YWv8ZFafECzg";
    const { exec, calls } = mockExec("missing");
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    const id = await be.reuseOrCreate({ agentId: "a", envId }, "ceibo · demo", "");
    expect(id).toContain(envId);
    expect(calls.find((c) => c.args[0] === "spawn")).toBeTruthy();
  });

  it("createWorkerSession abre una sesión en la VM viva del coordinador (sin spawn ni clon)", async () => {
    const { exec, calls } = mockExec("running");
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: mockOpencode([]).oc });
    const sid = await be.createWorkerSession("ceibo-demo-env_013CMPPUUQY4YWv8ZFafECzg");
    // delega en opencode.openWorkerSession (mismo VM, ses distinto) → NO toca cp.sh (ni spawn ni state)
    expect(sid).toBe("ceibo-demo-env_013CMPPUUQY4YWv8ZFafECzg#worker:ses_mock");
    expect(calls.find((c) => c.args[0] === "spawn")).toBeFalsy();
  });
});

// --- Retry+backoff de cp.sh assign en ensureVm ---------------------------------------------------
// assign falla transitoriamente en dos escenarios de prod:
//   1. exit 255 (red no lista): VM recién restaurada, vip_wait no consigue la IP todavía.
//   2. exit 1 "no pude mintear": broker AV congestionado por pico de assigns simultáneos (inicio REM).
// ensureVm ahora reintenta hasta 3 veces con backoff exponencial antes de propagar el error.

describe("ArchimaBackend — ensureVm: retry+backoff del assign", () => {
  /** Construye un `exec` que falla en los primeros `failCount` assigns y luego tiene éxito. */
  function mockExecWithAssignRetries(
    state: "missing" | "running" | "shut off",
    failCount: number,
    failMsg = "no pude mintear el agent-token AV para vault x",
  ) {
    const calls: { cmd: string; args: string[] }[] = [];
    let assignAttempts = 0;
    const exec = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === "state") return state;
      if (args[0] === "assign") {
        assignAttempts++;
        if (assignAttempts <= failCount) throw new Error(`${args.join(" ")} exit 1: ${failMsg}`);
        return "";
      }
      return "";
    };
    return { exec, calls, assignAttempts: () => assignAttempts };
  }

  it("assign falla 1 vez → reintenta y la sesión se crea OK (exit 255, red no lista)", async () => {
    const { exec, calls } = mockExecWithAssignRetries("running", 1, "exit 255: sin IP");
    const sleeps: number[] = [];
    const be = new ArchimaBackend({
      exec,
      cp: "/cp.sh",
      av: "/av",
      opencode: mockOpencode([]).oc,
      sleepImpl: async (ms) => void sleeps.push(ms),
    });
    // No debe lanzar: el 2do intento tiene éxito
    const id = await be.createSession({ agentId: "a", envId: "e1", vaultId: "u42" }, "Chat demo");
    expect(id).toContain("e1");
    // assign fue llamado exactamente 2 veces
    const assignCalls = calls.filter((c) => c.args[0] === "assign");
    expect(assignCalls).toHaveLength(2);
    // hubo un sleep de backoff entre los intentos (500ms)
    expect(sleeps).toEqual([500]);
  });

  it("assign falla 2 veces → reintenta 2 veces y la sesión se crea OK (broker congestionado)", async () => {
    const { exec, calls } = mockExecWithAssignRetries(
      "missing",
      2,
      "no pude mintear el agent-token AV para vault u42",
    );
    const sleeps: number[] = [];
    const be = new ArchimaBackend({
      exec,
      cp: "/cp.sh",
      av: "/av",
      opencode: mockOpencode([]).oc,
      sleepImpl: async (ms) => void sleeps.push(ms),
    });
    const id = await be.createSession({ agentId: "a", envId: "e1", vaultId: "u42" }, "Chat demo");
    expect(id).toContain("e1");
    // assign fue llamado 3 veces (2 fallos + 1 éxito)
    const assignCalls = calls.filter((c) => c.args[0] === "assign");
    expect(assignCalls).toHaveLength(3);
    // backoff exponencial: 500ms → 1000ms
    expect(sleeps).toEqual([500, 1000]);
  });

  it("assign falla 3 veces consecutivas → propaga el último error (misma semántica de fallo que antes)", async () => {
    const { exec } = mockExecWithAssignRetries(
      "missing",
      999,
      "no pude mintear el agent-token AV para vault u42",
    );
    const be = new ArchimaBackend({
      exec,
      cp: "/cp.sh",
      av: "/av",
      opencode: mockOpencode([]).oc,
      sleepImpl: async () => {},
    });
    await expect(
      be.createSession({ agentId: "a", envId: "e1", vaultId: "u42" }, "Chat demo"),
    ).rejects.toThrow(/assign/);
    // 3 intentos en total (no infinito)
  });

  it("assign OK al primer intento → sin sleeps, flujo normal inalterado", async () => {
    const { exec, calls } = mockExecWithAssignRetries("missing", 0);
    const sleeps: number[] = [];
    const be = new ArchimaBackend({
      exec,
      cp: "/cp.sh",
      av: "/av",
      opencode: mockOpencode([]).oc,
      sleepImpl: async (ms) => void sleeps.push(ms),
    });
    const id = await be.createSession({ agentId: "a", envId: "e1", vaultId: "u42" }, "Chat demo");
    expect(id).toContain("e1");
    expect(calls.filter((c) => c.args[0] === "assign")).toHaveLength(1);
    // sin sleeps en el path feliz
    expect(sleeps).toEqual([]);
  });
});

// --- /new debe invalidar el binding opencode (bug: token AV rotado + contexto no reseteado) -----
// createSession (path de /new vía recreateSession) corre `cp.sh assign` SIEMPRE → ROTA el token
// AV. Con el binding viejo vivo, ensureSession hacía early-return → `cp.sh serve` (el único que
// re-wrappea opencode con el token nuevo) nunca corría (MCPs 407 → 429 masivo) y la sesión
// opencode vieja seguía viva (el agente "se acordaba" de la conversación anterior).
describe("ArchimaBackend — unbind en createSession (/new)", () => {
  /** OpencodeClient espía: registra el ORDEN de unbind/ensureSession (lo que valida el contrato). */
  function spyOpencode(): { oc: OpencodeClient; log: string[] } {
    const log: string[] = [];
    const base = mockOpencode([]).oc;
    const oc: OpencodeClient = {
      ...base,
      unbind: (id) => void log.push(`unbind:${id}`),
      ensureSession: async (id) => void log.push(`ensure:${id}`),
    };
    return { oc, log };
  }

  it("createSession desbindea ANTES del assign/ensure (cada /new ⇒ sesión opencode fresca)", async () => {
    const { exec, calls } = mockExec("running"); // VM viva: el caso real de /new
    const { oc, log } = spyOpencode();
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: oc });
    const name = await be.createSession({ agentId: "a", envId: "e1", vaultId: "u42" }, "ceibo · demo");
    // unbind primero, ensure después — y el assign (rotación de token) quedó en el medio.
    expect(log).toEqual([`unbind:${name}`, `ensure:${name}`]);
    expect(calls.find((c) => c.args[0] === "assign")).toBeTruthy();
  });

  it("reuseOrCreate con VM viva NO desbindea (reattach tras restart: el binding fresco no existe)", async () => {
    const { exec } = mockExec("running");
    const { oc, log } = spyOpencode();
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: oc });
    await be.reuseOrCreate({ agentId: "a", envId: "e1" }, "ceibo · demo", "saved-vm-e1");
    expect(log).toEqual([]); // ni unbind ni ensure: el binding se re-crea lazy en attach/prompt
  });

  it("dos createSession con el MISMO nombre ⇒ 2 sesiones opencode distintas + serve ambas veces (integración con HttpOpencodeClient)", async () => {
    // Cliente HTTP REAL con fetch/resolveBase mockeados: valida la cadena completa
    // unbind → ensureSession → resolveBase (`cp.sh serve`) → POST /session fresca.
    let seq = 0;
    let serveCalls = 0;
    const promptedSes: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url as string).pathname;
      if (method === "POST" && path === "/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: `ses_${++seq}` }),
          text: async () => "",
        } as unknown as Response;
      }
      if (method === "POST" && /prompt_async$/.test(path)) {
        promptedSes.push(path.split("/")[2] ?? "");
        return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: async () => {},
      resolveBase: async () => {
        serveCalls++; // resolveBase == `cp.sh serve` (re-wrap con el token AV vigente)
        return "http://10.0.0.1:14420";
      },
      fetchImpl,
    });
    const { exec } = mockExec("running");
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: client });

    const cfg = { agentId: "a", envId: "e1", vaultId: "u42" };
    const n1 = await be.createSession(cfg, "ceibo · demo");
    await client.prompt(n1, [{ type: "text", text: "hola" }]);
    const n2 = await be.createSession(cfg, "ceibo · demo"); // /new: MISMO nombre lógico
    await client.prompt(n2, [{ type: "text", text: "de nuevo" }]);

    expect(n2).toBe(n1); // el sessionId lógico (nombre de VM) es idéntico entre /new…
    expect(serveCalls).toBe(2); // …pero serve corrió AMBAS veces (re-wrap con token nuevo)
    expect(promptedSes).toEqual(["ses_1", "ses_2"]); // …y la 2ª sesión opencode es OTRA (contexto reseteado)
  });
});

/** Bus controlable que respeta el contrato real de events(): cada iteración es un stream vivo
 *  hasta que (a) el caller la cierra vía `opts.signal` o (b) el bus la termina. `push` entrega a
 *  TODOS los streams abiertos (semántica de bus global ya filtrado por sesión). `active()` =
 *  streams vivos AHORA: es el observable de la fuga de pumps (bug E). */
function mockAbortableBus(): {
  oc: OpencodeClient;
  push: (ev: OpencodeEvent) => void;
  active: () => number;
} {
  type Stream = { queue: OpencodeEvent[]; notify?: () => void; ended: boolean };
  const streams = new Set<Stream>();
  const oc: OpencodeClient = {
    ensureSession: async () => {},
    unbind: () => {},
    openWorkerSession: async (vm) => `${vm}#worker:ses_mock`,
    setAgentConfig: async () => {},
    abort: async () => {},
    summarize: async () => ({}),
    prompt: async () => ({}),
    events: async function* (_id, opts) {
      const s: Stream = { queue: [], ended: false };
      streams.add(s);
      opts?.signal?.addEventListener("abort", () => {
        s.ended = true;
        s.notify?.();
      });
      try {
        while (true) {
          while (s.queue.length) {
            const ev = s.queue.shift();
            if (ev) yield ev;
          }
          if (s.ended) return;
          await new Promise<void>((r) => {
            s.notify = r;
          });
          s.notify = undefined;
        }
      } finally {
        streams.delete(s);
      }
    },
  };
  return {
    oc,
    push: (ev) => {
      for (const s of streams) {
        s.queue.push(ev);
        s.notify?.();
      }
    },
    active: () => streams.size,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("ArchimaBackend — attach (relay)", () => {
  it("traduce el stream y reporta turnComplete en idle; send → prompt", async () => {
    const script: OpencodeEvent[] = [
      {
        type: "message.updated",
        properties: {
          info: { id: "m1", role: "assistant", model: { providerID: "local", modelID: "gemma4-31b" } },
        },
      },
      {
        type: "message.part.updated",
        properties: { part: { type: "text", text: "Hola", messageID: "m1", id: "p1" } },
      },
      {
        type: "message.part.updated",
        properties: { part: { type: "tool", tool: "read", callID: "c1", messageID: "m1" } },
      },
      {
        type: "message.part.updated",
        properties: { part: { type: "step-finish", messageID: "m1", tokens: { input: 10, output: 5 } } },
      },
      { type: "session.idle" },
    ];
    const { oc, prompts } = mockOpencode(script);
    const be = new ArchimaBackend(deps(oc));

    const got: string[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const sink: Sink = {
      message: (t) => void got.push(`msg:${t}`),
      activity: (l) => void got.push(`act:${l}`),
      status: () => {},
      turnComplete: (u, m) => {
        got.push(`turn:${u.output}:${m}`);
        done();
      },
    };

    const relay = be.attach("vm1", sink);
    await relay.send("hola", undefined);
    await finished;
    relay.close();

    expect(got).toEqual(["msg:Hola", "act:read", "turn:5:gemma4-31b"]);
    expect(prompts[0]).toEqual([{ type: "text", text: "hola" }]);
  });

  it("close() ABORTA el stream de eventos (no sólo un flag): cero streams vivos tras N re-attach", async () => {
    // Bug E: close() era sólo `stopped = true` — el pump quedaba parqueado en el read del SSE
    // (sin eventos de SU sesión nunca re-chequeaba el flag) y cada re-attach ACUMULABA un stream
    // más sobre el mismo bus. Ahora close() aborta el fetch → el stream muere al instante.
    const bus = mockAbortableBus();
    const be = new ArchimaBackend(deps(bus.oc));

    for (let i = 0; i < 3; i++) {
      const r = be.attach("vm1", { message: () => {} });
      await tick(); // dejá arrancar el pump (abre su stream)
      expect(bus.active()).toBe(1); // exactamente UNO vivo por relay
      r.close();
      await tick();
      expect(bus.active()).toBe(0); // el close lo mató DE VERDAD (sin esperar otro evento)
    }

    // Un attach fresco después de los ciclos: los eventos se traducen UNA sola vez (sin pumps fantasma).
    const got: string[] = [];
    let turns = 0;
    const r = be.attach("vm1", {
      message: (t) => void got.push(t),
      turnComplete: () => {
        turns++;
      },
    });
    await tick();
    expect(bus.active()).toBe(1);
    bus.push({ type: "message.updated", properties: { info: { id: "m1", role: "assistant" } } });
    bus.push({
      type: "message.part.updated",
      properties: { part: { type: "text", text: "una sola vez", messageID: "m1", id: "p1" } },
    });
    bus.push({
      type: "message.part.updated",
      properties: { part: { type: "step-finish", messageID: "m1" } },
    });
    bus.push({ type: "session.idle" });
    await tick();
    expect(got).toEqual(["una sola vez"]);
    expect(turns).toBe(1);
    r.close();
    await tick();
    expect(bus.active()).toBe(0);
  });

  it("el relay del worker y el del coordinador no comparten estado (sinks aislados)", async () => {
    // Dos relays sobre el mismo backend: cada uno con su sink. El push del bus entrega a ambos
    // streams (bus global YA filtrado por sesión en el cliente HTTP — acá validamos que el attach
    // no cruce sinks por su cuenta: un translator por relay, sin estado compartido).
    const bus = mockAbortableBus();
    const be = new ArchimaBackend(deps(bus.oc));
    const a: string[] = [];
    const b: string[] = [];
    const ra = be.attach("vm1", { message: (t) => void a.push(t) });
    const rb = be.attach("vm1#worker:ses_w", { message: (t) => void b.push(t) });
    await tick();
    expect(bus.active()).toBe(2);
    ra.close();
    await tick();
    expect(bus.active()).toBe(1); // sólo murió el del coordinador; el worker sigue
    bus.push({ type: "message.updated", properties: { info: { id: "w1", role: "assistant" } } });
    bus.push({
      type: "message.part.updated",
      properties: { part: { type: "text", text: "del worker", messageID: "w1", id: "p9" } },
    });
    bus.push({ type: "session.idle" });
    await tick();
    expect(a).toEqual([]); // el relay cerrado NO recibió nada
    expect(b).toEqual(["del worker"]);
    rb.close();
  });
});

describe("ArchimaBackend — agentRole (REM/batch corre con el agente worker)", () => {
  /** OpencodeClient espía: captura las opciones con que se pide cada ensureSession. */
  function roleSpy(): {
    oc: OpencodeClient;
    opts: Array<Parameters<OpencodeClient["ensureSession"]>[1]>;
    roles: (string | undefined)[];
  } {
    const opts: Array<Parameters<OpencodeClient["ensureSession"]>[1]> = [];
    const roles: (string | undefined)[] = [];
    const base = mockOpencode([]).oc;
    const oc: OpencodeClient = {
      ...base,
      ensureSession: async (_id, o) => {
        opts.push(o);
        roles.push(o?.role);
      },
    };
    return { oc, opts, roles };
  }

  it("createSession con agentRole 'worker' abre la sesión opencode con role worker (REM)", async () => {
    const { oc, roles } = roleSpy();
    const { exec } = mockExec();
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: oc });
    await be.createSession(
      { agentId: "agent-rem", envId: "e1", vaultId: "u42", agentRole: "worker" },
      "REM · demo · personal",
    );
    expect(roles).toEqual(["worker"]);
  });

  it("createSession sin agentRole no fija rol (el chat cae al coordinador)", async () => {
    const { oc, roles } = roleSpy();
    const { exec } = mockExec();
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: oc });
    await be.createSession({ agentId: "a", envId: "e1" }, "ceibo · demo");
    expect(roles).toEqual([undefined]);
  });

  it("reuseOrCreate (VM apagada → restore) también propaga el rol", async () => {
    const { oc, roles } = roleSpy();
    const { exec } = mockExec("shut off");
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: oc });
    await be.reuseOrCreate({ agentId: "agent-rem", envId: "e1", agentRole: "worker" }, "REM · demo · w");
    expect(roles).toEqual(["worker"]);
  });

  it("propaga localModel al cliente opencode para overrides por sesión", async () => {
    const spy = roleSpy();
    const { exec } = mockExec();
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: spy.oc });
    await be.createSession(
      {
        agentId: "agent-rem",
        envId: "e1",
        agentRole: "worker",
        localModel: { providerID: "anthropic-via-av", modelID: "claude-sonnet" },
      },
      "REM · demo · personal",
    );
    expect(spy.opts[0]).toEqual({
      role: "worker",
      model: { providerID: "anthropic-via-av", modelID: "claude-sonnet" },
    });
  });
});

describe("ArchimaBackend — guardrail anti-runaway (techo de pared por turno)", () => {
  /** Bus controlable + abort espiado: el observable del guardrail es el POST /abort. */
  function guardedBus(): ReturnType<typeof mockAbortableBus> & { aborts: () => number } {
    const bus = mockAbortableBus();
    let aborts = 0;
    const oc: OpencodeClient = {
      ...bus.oc,
      abort: async () => {
        aborts++;
        return {};
      },
    };
    return { ...bus, oc, aborts: () => aborts };
  }

  it("turno que no cierra a tiempo: aborta la sesión opencode EN LA VM y avisa por sink.error", async () => {
    const bus = guardedBus();
    const be = new ArchimaBackend({
      exec: mockExec().exec,
      cp: "/cp.sh",
      av: "/av",
      opencode: bus.oc,
      turnTimeoutMs: 30,
    });
    const errors: string[] = [];
    const relay = be.attach("vm1", { message: () => {}, error: (t) => void errors.push(t) });
    await relay.send("generá sin parar", undefined);
    await new Promise((r) => setTimeout(r, 80)); // dejá vencer el techo (30ms)
    expect(bus.aborts()).toBe(1); // frenó la generación de verdad (POST /session/:id/abort)
    expect(errors[0]).toMatch(/superó el límite .* abortado/);
    relay.close();
  });

  it("el cierre normal del turno (session.idle → turnComplete) DESARMA el techo: cero aborts", async () => {
    const bus = guardedBus();
    const be = new ArchimaBackend({
      exec: mockExec().exec,
      cp: "/cp.sh",
      av: "/av",
      opencode: bus.oc,
      turnTimeoutMs: 50,
    });
    let turns = 0;
    const relay = be.attach("vm1", {
      message: () => {},
      turnComplete: () => {
        turns++;
      },
    });
    await relay.send("hola", undefined);
    await tick();
    bus.push({ type: "session.idle" }); // el turno cierra a tiempo
    await tick();
    expect(turns).toBe(1);
    await new Promise((r) => setTimeout(r, 90)); // pasado el techo: no debe haber abort
    expect(bus.aborts()).toBe(0);
    relay.close();
  });

  it("turnTimeoutMs ≤ 0 desactiva el guardrail (sin techo, sin abort)", async () => {
    const bus = guardedBus();
    const be = new ArchimaBackend({
      exec: mockExec().exec,
      cp: "/cp.sh",
      av: "/av",
      opencode: bus.oc,
      turnTimeoutMs: 0,
    });
    const relay = be.attach("vm1", { message: () => {} });
    await relay.send("hola", undefined);
    await new Promise((r) => setTimeout(r, 40));
    expect(bus.aborts()).toBe(0);
    relay.close();
  });
});

// --- Incidente 2026-06-10: stream zombie tras reboot del host → recuperación activa del pump ---

describe("ArchimaBackend — pump: recuperación activa del stream (reboot del host)", () => {
  /** OpencodeClient cuyo events() FALLA siempre (stream cortado) y con recover() scriptado. */
  function failingStream(results: ("rebound" | "session-lost" | "unreachable")[]) {
    const recovers: string[] = [];
    let unbinds = 0;
    const oc: OpencodeClient = {
      ensureSession: async () => {},
      unbind: () => {
        unbinds++;
      },
      openWorkerSession: async (vm) => `${vm}#worker:ses_mock`,
      setAgentConfig: async () => {},
      abort: async () => {},
      summarize: async () => ({}),
      prompt: async () => ({}),
      // biome-ignore lint/correctness/useYield: stream que muere antes de emitir (es el caso bajo test)
      events: async function* (): AsyncGenerator<OpencodeEvent> {
        throw new Error("fetch failed (socket zombie)");
      },
      recover: async (sid) => {
        recovers.push(sid);
        return results.shift() ?? "unreachable";
      },
    };
    return { oc, recovers, unbinds: () => unbinds };
  }

  it("tras cortes consecutivos llama recover(); 'session-lost' → UNA frase amable + dead (sin interna)", async () => {
    const { oc, recovers } = failingStream(["session-lost"]);
    const be = new ArchimaBackend({ ...deps(oc), sleepImpl: async () => {} });
    const errors: string[] = [];
    let dead = 0;
    let resolveDead!: () => void;
    const died = new Promise<void>((r) => {
      resolveDead = r;
    });
    const relay = be.attach("vm1", {
      message: () => {},
      error: (t) => void errors.push(t),
      dead: () => {
        dead++;
        resolveDead();
      },
    });
    await died;
    relay.close();

    // recover se llamó al alcanzar el umbral de cortes consecutivos (no en el 1er blip).
    expect(recovers).toEqual(["vm1"]);
    expect(dead).toBe(1);
    // El aviso al usuario es la frase amable, sin NADA de interna (VM, env id, cp.sh, intentos).
    expect(errors).toEqual([SESSION_LOST_USER_MSG]);
    expect(errors[0]).not.toMatch(/archima|env_|cp\.sh|ses_|intentos|exit/);
  });

  it("'rebound' (la sesión sobrevivió) → re-suscribe y sigue traduciendo, sin avisar ni matar el relay", async () => {
    // events(): 2 cortes, recover → rebound, después el stream VUELVE y cierra un turno.
    let call = 0;
    const recovers: string[] = [];
    const oc: OpencodeClient = {
      ensureSession: async () => {},
      unbind: () => {},
      openWorkerSession: async (vm) => `${vm}#worker:ses_mock`,
      setAgentConfig: async () => {},
      abort: async () => {},
      summarize: async () => ({}),
      prompt: async () => ({}),
      events: async function* (): AsyncGenerator<OpencodeEvent> {
        call++;
        if (call <= 2) throw new Error("fetch failed");
        yield { type: "message.updated", properties: { info: { id: "m1", role: "assistant" } } };
        yield {
          type: "message.part.updated",
          properties: { part: { type: "text", text: "sobreviví", messageID: "m1", id: "p1" } },
        };
        yield { type: "session.idle" };
        await new Promise(() => {}); // queda abierto hasta close
      },
      recover: async (sid) => {
        recovers.push(sid);
        return "rebound";
      },
    };
    const be = new ArchimaBackend({ ...deps(oc), sleepImpl: async () => {} });
    const got: string[] = [];
    const errors: string[] = [];
    let dead = 0;
    let resolveTurn!: () => void;
    const turn = new Promise<void>((r) => {
      resolveTurn = r;
    });
    const relay = be.attach("vm1", {
      message: (t) => void got.push(t),
      error: (t) => void errors.push(t),
      dead: () => {
        dead++;
      },
      turnComplete: () => resolveTurn(),
    });
    await turn;
    relay.close();

    expect(recovers).toEqual(["vm1"]); // un solo recover (el rebound resetea el contador)
    expect(got).toEqual(["sobreviví"]); // el turno post-reconexión llegó al sink
    expect(errors).toEqual([]); // nada que avisar: el contexto sobrevivió
    expect(dead).toBe(0);
  });

  it("'unreachable' → sigue reintentando con backoff (no mata el relay ni avisa)", async () => {
    const { oc, recovers } = failingStream(["unreachable", "unreachable", "session-lost"]);
    const be = new ArchimaBackend({ ...deps(oc), sleepImpl: async () => {} });
    const errors: string[] = [];
    let resolveDead!: () => void;
    const died = new Promise<void>((r) => {
      resolveDead = r;
    });
    const relay = be.attach("vm1", {
      message: () => {},
      error: (t) => void errors.push(t),
      dead: () => resolveDead(),
    });
    await died;
    relay.close();
    // Siguió reintentando a través de los 'unreachable' hasta el veredicto final.
    expect(recovers.length).toBe(3);
    expect(errors).toEqual([SESSION_LOST_USER_MSG]);
  });

  it("blip transitorio (1-2 'unreachable' y vuelve) NO arranca la VM", async () => {
    // Un par de cortes con recover→unreachable y después el stream VUELVE y cierra un turno: es el
    // caso de un blip de red, NO un reboot. wakeVm (state/restore/spawn) NO debe dispararse.
    let call = 0;
    const oc: OpencodeClient = {
      ensureSession: async () => {},
      unbind: () => {},
      openWorkerSession: async (vm) => `${vm}#worker:ses_mock`,
      setAgentConfig: async () => {},
      abort: async () => {},
      summarize: async () => ({}),
      prompt: async () => ({}),
      events: async function* (): AsyncGenerator<OpencodeEvent> {
        call++;
        if (call <= 2) throw new Error("fetch failed (blip)");
        yield { type: "session.idle" };
        await new Promise(() => {});
      },
      recover: async () => "unreachable",
    };
    const { exec, calls } = mockExec("shut off");
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: oc, sleepImpl: async () => {} });
    let resolveTurn!: () => void;
    const turn = new Promise<void>((r) => {
      resolveTurn = r;
    });
    const relay = be.attach("vm1", { message: () => {}, turnComplete: () => resolveTurn() });
    await turn;
    relay.close();
    // Sólo 2 unreachables (< WAKE_AFTER_UNREACHABLE=3) antes de reconectar → NUNCA arrancó la VM.
    expect(calls.find((c) => c.args[0] === "restore")).toBeFalsy();
    expect(calls.find((c) => c.args[0] === "spawn")).toBeFalsy();
    expect(calls.find((c) => c.args[0] === "state")).toBeFalsy();
  });

  it("'unreachable' PERSISTENTE → arranca la VM apagada (restore) sin restart del gateway, y rebindea", async () => {
    // El reboot de gpuhost dejó la VM `shut off`. recover() sólo corre `cp.sh serve` → unreachable en
    // loop. Tras WAKE_AFTER_UNREACHABLE veredictos seguidos, el pump llama wakeVm → state="shut off" →
    // restore. Después la VM levanta: recover da rebound y el stream vuelve.
    let recovered = 0;
    const oc: OpencodeClient = {
      ensureSession: async () => {},
      unbind: () => {},
      openWorkerSession: async (vm) => `${vm}#worker:ses_mock`,
      setAgentConfig: async () => {},
      abort: async () => {},
      summarize: async () => ({}),
      prompt: async () => ({}),
      events: async function* (): AsyncGenerator<OpencodeEvent> {
        // Mientras la VM no arrancó, el stream sigue muriendo; tras el rebound, vuelve y cierra turno.
        if (recovered === 0) throw new Error("fetch failed (VM shut off)");
        yield { type: "session.idle" };
        await new Promise(() => {});
      },
      recover: async () => {
        // unreachable hasta que el wake haya arrancado la VM; ahí pasa a rebound.
        return recovered > 0 ? "rebound" : "unreachable";
      },
    };
    const { exec, calls } = mockExec("shut off");
    // Envolvemos el exec para que `restore` marque la VM como arrancada (recovered→1) → próximo
    // recover da rebound. Es el mismo efecto que `cp.sh restore` + boot en prod.
    const wrappedExec = async (cmd: string, args: string[]) => {
      const out = await exec(cmd, args);
      if (args[0] === "restore") recovered++;
      return out;
    };
    const be = new ArchimaBackend({
      exec: wrappedExec,
      cp: "/cp.sh",
      av: "/av",
      opencode: oc,
      sleepImpl: async () => {},
    });
    let resolveTurn!: () => void;
    const turn = new Promise<void>((r) => {
      resolveTurn = r;
    });
    const relay = be.attach("vm1", { message: () => {}, turnComplete: () => resolveTurn() });
    await turn; // arrancó la VM y reconectó sin restart manual del gateway
    relay.close();
    // El wake consultó estado y RESTAUROU (VM shut off), nunca spawn (idempotencia).
    expect(calls.find((c) => c.args[0] === "state" && c.args[1] === "vm1")).toBeTruthy();
    expect(calls.find((c) => c.args[0] === "restore" && c.args[1] === "vm1")).toBeTruthy();
    expect(calls.find((c) => c.args[0] === "spawn")).toBeFalsy();
  });

  it("reboots repetidos en el mismo relay: cada recuperación EXITOSA renueva el presupuesto de wakes", async () => {
    // Garantía del reset de `wakes` al recuperarse: MAX_WAKE_ATTEMPTS cuenta wakes SIN éxito (= gpuhost
    // muerto), NO en toda la vida del relay. Modelamos MÁS reboots que MAX_WAKE_ATTEMPTS (5 > 3), cada
    // uno recuperado con éxito: sin el reset, el techo se agotaría al 3er reboot y los siguientes nunca
    // arrancarían la VM. Con el reset, cada reboot recuperado vuelve a tener presupuesto → 5 restores.
    const TOTAL_REBOOTS = 5;
    let restores = 0; // cuántas veces arrancamos la VM (= reboots recuperados)
    let alive = false; // ¿la VM está viva ahora? (true tras un restore, hasta el próximo reboot)
    const oc: OpencodeClient = {
      ensureSession: async () => {},
      unbind: () => {},
      openWorkerSession: async (vm) => `${vm}#worker:ses_mock`,
      setAgentConfig: async () => {},
      abort: async () => {},
      summarize: async () => ({}),
      prompt: async () => ({}),
      events: async function* (): AsyncGenerator<OpencodeEvent> {
        if (!alive) throw new Error("fetch failed (VM caída por reboot)"); // VM caída → stream muere
        yield { type: "session.idle" }; // VM viva → cierra un turno (señal de recuperación)
        if (restores < TOTAL_REBOOTS) {
          alive = false; // otro reboot: la VM se cae de nuevo y el stream vuelve a morir
          throw new Error("fetch failed (siguiente reboot)");
        }
        await new Promise(() => {}); // último turno: queda abierto hasta close
      },
      recover: async () => (alive ? "rebound" : "unreachable"),
    };
    const { exec, calls } = mockExec("shut off");
    // `restore` arranca la VM (alive=true) → el próximo recover da rebound y el stream vuelve.
    const wrappedExec = async (cmd: string, args: string[]) => {
      const out = await exec(cmd, args);
      if (args[0] === "restore") {
        restores++;
        alive = true;
      }
      return out;
    };
    const be = new ArchimaBackend({
      exec: wrappedExec,
      cp: "/cp.sh",
      av: "/av",
      opencode: oc,
      sleepImpl: async () => {},
    });
    let turns = 0;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const relay = be.attach("vm1", {
      message: () => {},
      turnComplete: () => {
        turns++;
        if (turns === TOTAL_REBOOTS) resolveDone();
      },
    });
    await done; // se recuperó de los 5 reboots sin restart manual del gateway
    relay.close();
    // La clave: 5 restores (uno por reboot), MÁS que MAX_WAKE_ATTEMPTS=3. Sin el reset del presupuesto
    // tras cada recuperación, el techo se habría agotado al 3er reboot y nunca llegaríamos a 5.
    expect(restores).toBe(TOTAL_REBOOTS);
    expect(turns).toBe(TOTAL_REBOOTS);
    const restoreCalls = calls.filter((c) => c.args[0] === "restore" && c.args[1] === "vm1");
    expect(restoreCalls.length).toBe(TOTAL_REBOOTS);
    expect(calls.find((c) => c.args[0] === "spawn")).toBeFalsy(); // siempre restore, nunca spawn
  });

  it("VM ya 'running' al despertar NO re-spawnea (idempotencia: evita el lock collision)", async () => {
    // Caso límite: el stream muere pero la VM en realidad sigue running (zombie de SSE). El wake
    // consulta estado, lo ve running y NO toca restore/spawn.
    let recovered = 0;
    const oc: OpencodeClient = {
      ensureSession: async () => {},
      unbind: () => {},
      openWorkerSession: async (vm) => `${vm}#worker:ses_mock`,
      setAgentConfig: async () => {},
      abort: async () => {},
      summarize: async () => ({}),
      prompt: async () => ({}),
      events: async function* (): AsyncGenerator<OpencodeEvent> {
        if (recovered === 0) throw new Error("fetch failed (socket zombie)");
        yield { type: "session.idle" };
        await new Promise(() => {});
      },
      recover: async () => (recovered > 0 ? "rebound" : "unreachable"),
    };
    const { exec, calls } = mockExec("running");
    const wrappedExec = async (cmd: string, args: string[]) => {
      const out = await exec(cmd, args);
      if (args[0] === "state") recovered++; // el wake consultó estado → la próxima vez rebindea
      return out;
    };
    const be = new ArchimaBackend({
      exec: wrappedExec,
      cp: "/cp.sh",
      av: "/av",
      opencode: oc,
      sleepImpl: async () => {},
    });
    let resolveTurn!: () => void;
    const turn = new Promise<void>((r) => {
      resolveTurn = r;
    });
    const relay = be.attach("vm1", { message: () => {}, turnComplete: () => resolveTurn() });
    await turn;
    relay.close();
    expect(calls.find((c) => c.args[0] === "state")).toBeTruthy();
    expect(calls.find((c) => c.args[0] === "restore")).toBeFalsy();
    expect(calls.find((c) => c.args[0] === "spawn")).toBeFalsy(); // NO re-spawn sobre VM viva
  });

  it("gpuhost caído de verdad: techo de MAX_WAKE_ATTEMPTS → no spawnea en loop infinito", async () => {
    // El control plane no responde (gpuhost muerto): `cp.sh state` falla → wakeVm devuelve false. El
    // pump NO debe quedar arrancando VMs para siempre: a lo sumo MAX_WAKE_ATTEMPTS intentos de state.
    // Acotamos el spin del test: tras un puñado de recovers cerramos el relay (en prod el sleep real
    // espacia las vueltas; acá sleepImpl es no-op para no esperar, así que paramos a mano).
    let recovers = 0;
    let relay!: ReturnType<ArchimaBackend["attach"]>;
    const oc: OpencodeClient = {
      ensureSession: async () => {},
      unbind: () => {},
      openWorkerSession: async (vm) => `${vm}#worker:ses_mock`,
      setAgentConfig: async () => {},
      abort: async () => {},
      summarize: async () => ({}),
      prompt: async () => ({}),
      // biome-ignore lint/correctness/useYield: stream que muere siempre (gpuhost caído)
      events: async function* (): AsyncGenerator<OpencodeEvent> {
        throw new Error("fetch failed (gpuhost caído)");
      },
      recover: async () => {
        // Cortamos el relay bastante después del techo de wakes (cada wake cuesta ≥3 recovers): a esa
        // altura ya quedó claro que el techo frenó los arranques. close() hace que el próximo loop salga.
        if (++recovers >= 20) relay?.close();
        return "unreachable";
      },
    };
    const stateCalls: string[] = [];
    // `cp.sh state` SIEMPRE falla (control plane mudo) → wakeVm devuelve false.
    const exec = async (_cmd: string, args: string[]) => {
      if (args[0] === "state") {
        stateCalls.push(args[1] ?? "");
        throw new Error("ssh: connect to host gpuhost: No route to host");
      }
      return "";
    };
    const statuses: string[] = [];
    const be = new ArchimaBackend({ exec, cp: "/cp.sh", av: "/av", opencode: oc, sleepImpl: async () => {} });
    relay = be.attach("vm1", { message: () => {}, status: (s) => void statuses.push(s) });
    // Esperá a que el pump corra sus vueltas y se cierre solo (recovers llega a 20 → relay.close()).
    while (recovers < 20) await new Promise((r) => setTimeout(r, 1));
    await new Promise((r) => setTimeout(r, 5));
    // El techo cortó los wakes: a lo sumo MAX_WAKE_ATTEMPTS intentos de arrancar (state), aunque hubo
    // muchos más recovers — la clave es que los wakes NO crecen sin límite.
    expect(stateCalls.length).toBeLessThanOrEqual(3);
    expect(stateCalls.length).toBeGreaterThan(0); // pero SÍ intentó al menos una vez
    // y reportó el intento de arranque por el sink de status
    expect(statuses.some((s) => /arranco \(intento/.test(s))).toBe(true);
  });

  it("un cliente SIN recover() se comporta como antes (backoff pasivo, sin crash)", async () => {
    let calls = 0;
    const oc: OpencodeClient = {
      ensureSession: async () => {},
      unbind: () => {},
      openWorkerSession: async (vm) => `${vm}#worker:ses_mock`,
      setAgentConfig: async () => {},
      abort: async () => {},
      summarize: async () => ({}),
      prompt: async () => ({}),
      events: async function* (): AsyncGenerator<OpencodeEvent> {
        calls++;
        if (calls <= 3) throw new Error("fetch failed");
        yield { type: "session.idle" };
        await new Promise(() => {});
      },
      // sin recover
    };
    const be = new ArchimaBackend({ ...deps(oc), sleepImpl: async () => {} });
    let resolveTurn!: () => void;
    const turn = new Promise<void>((r) => {
      resolveTurn = r;
    });
    const relay = be.attach("vm1", { message: () => {}, turnComplete: () => resolveTurn() });
    await turn; // reconectó por backoff pasivo y el turno cerró
    relay.close();
    expect(calls).toBe(4);
  });
});

describe("ArchimaBackend — registro vm → vault (para el retry de assign del factory)", () => {
  it("createSession registra el vault de la VM (vía ensureVm)", async () => {
    const { exec } = mockExec();
    const registered: [string, string][] = [];
    const be = new ArchimaBackend({
      exec,
      cp: "/cp.sh",
      av: "/av",
      opencode: mockOpencode([]).oc,
      registerVault: (n, v) => void registered.push([n, v]),
    });
    await be.createSession({ envId: "env_9", vaultId: "ceibo-demo-gpuhost" } as never, "ceibo · demo");
    expect(registered).toEqual([["ceibo-demo-env_9", "ceibo-demo-gpuhost"]]);
  });

  it("reuseOrCreate sobre VM viva TAMBIÉN registra (este path no pasa por ensureVm)", async () => {
    const { exec } = mockExec("running");
    const registered: [string, string][] = [];
    const be = new ArchimaBackend({
      exec,
      cp: "/cp.sh",
      av: "/av",
      opencode: mockOpencode([]).oc,
      registerVault: (n, v) => void registered.push([n, v]),
    });
    const sid = await be.reuseOrCreate(
      { envId: "env_9", vaultId: "ceibo-demo-gpuhost" } as never,
      "ceibo · demo",
    );
    expect(registered).toEqual([[sid, "ceibo-demo-gpuhost"]]);
  });
});
