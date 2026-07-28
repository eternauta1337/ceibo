import { describe, expect, it } from "vitest";
import { makeResolveBase, run, sshArgv } from "./factory.ts";

describe("sshArgv", () => {
  it("arma el comando remoto como un solo string (lo que valida el forced-command)", () => {
    const argv = sshArgv("demo@100.64.0.10", "/home/deploy/.ssh/gpuhost_cp", "cp.sh", ["spawn", "vm1"]);
    // la llave primero, luego opts, target, y el comando remoto JUNTO al final
    expect(argv[0]).toBe("-i");
    expect(argv[1]).toBe("/home/deploy/.ssh/gpuhost_cp");
    expect(argv).toContain("demo@100.64.0.10");
    expect(argv[argv.length - 1]).toBe("cp.sh spawn vm1");
  });

  it("junta verbo + args con espacios", () => {
    const argv = sshArgv("t", "k", "agent-vault", ["vault", "create", "u1"]);
    expect(argv[argv.length - 1]).toBe("agent-vault vault create u1");
  });
});

describe("run", () => {
  it("devuelve stdout (trim) en el path de éxito", async () => {
    await expect(run("printf", ["hola"], { timeoutMs: 5000 })).resolves.toBe("hola");
  });

  it("rechaza con error claro y mata el proceso al vencer el timeout", async () => {
    // `sleep 5` con timeout 150ms → debe abortar rápido con el mensaje de timeout, no esperar 5s.
    await expect(run("sleep", ["5"], { timeoutMs: 150, label: "cp.sh serve vm1" })).rejects.toThrow(
      /archima exec timeout \(150ms\): cp\.sh serve vm1/,
    );
  });

  it("rechaza con stderr cuando el exit != 0 (sin timeout espurio)", async () => {
    await expect(run("sh", ["-c", "exit 3"], { timeoutMs: 5000 })).rejects.toThrow(/exit 3/);
  });

  it("cae a STDOUT cuando stderr viene vacío (cp.sh/agent-vault loguean por stdout)", async () => {
    // El bug: cp.sh imprime el error por stdout → con sólo stderr el mensaje quedaba mudo.
    await expect(
      run("sh", ["-c", "echo 'Vault not found'; exit 1"], {
        timeoutMs: 5000,
        label: "cp.sh assign vm1 vault-x",
      }),
    ).rejects.toThrow(/cp\.sh assign vm1 vault-x exit 1: Vault not found/);
  });

  it("usa el `label` (cmd+args lógicos) en el mensaje, no el `ssh` crudo", async () => {
    // Sin label cae al bin+argv; con label muestra el comando lógico que el caller pasó.
    await expect(
      run("sh", ["-c", "echo err 1>&2; exit 2"], { timeoutMs: 5000, label: "agent-vault vault create u1" }),
    ).rejects.toThrow(/agent-vault vault create u1 exit 2: err/);
  });
});

// --- Incidente 2026-06-10: serve en loop de 401 (token AV rechazado tras reboot del broker) ----

describe("makeResolveBase — auto-recuperación del token AV (assign + retry de serve)", () => {
  /** exec espía: `failServes` = cuántos `cp.sh serve` consecutivos fallan antes de andar. */
  function spyExec(failServes: number) {
    const calls: string[][] = [];
    let serveFails = 0;
    const exec = async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "serve" && serveFails < failServes) {
        serveFails++;
        throw new Error(`cp.sh serve ${args[1]} exit 1: serve no respondió en archima-${args[1]}`);
      }
      if (args[0] === "ip") return "192.168.122.42";
      return "";
    };
    return { exec, calls };
  }

  it("camino feliz: serve + ip, SIN assign (no rota el token de gusto)", async () => {
    const { exec, calls } = spyExec(0);
    const resolve = makeResolveBase({ exec, cp: "cp.sh", port: 14420, vaultFor: () => "ceibo-demo-gpuhost" });
    await expect(resolve("vm1")).resolves.toBe("http://192.168.122.42:14420");
    // vault conocido → serve lleva la config explícita en $3 + --require-vault en $4 (cp.sh no
    // levanta opencode pelado; el cp.sh viejo ignora $4 en vez de romperse con la config).
    expect(calls).toEqual([
      ["serve", "vm1", "opencode-delegv2.json", "--require-vault"],
      ["ip", "vm1"],
    ]);
  });

  it("serve falla y el vault es conocido → assign (re-mintea el token) + retry de serve", async () => {
    const { exec, calls } = spyExec(1);
    const resolve = makeResolveBase({ exec, cp: "cp.sh", port: 14420, vaultFor: () => "ceibo-demo-gpuhost" });
    await expect(resolve("vm1")).resolves.toBe("http://192.168.122.42:14420");
    // serve --require-vault falla (sin agent-vault-env) → assign + retry de serve (re-wrappea).
    expect(calls).toEqual([
      ["serve", "vm1", "opencode-delegv2.json", "--require-vault"],
      ["assign", "vm1", "ceibo-demo-gpuhost"],
      ["serve", "vm1", "opencode-delegv2.json", "--require-vault"],
      ["ip", "vm1"],
    ]);
  });

  it("serve falla también tras el assign → propaga (sin loop infinito de rotates)", async () => {
    const { exec, calls } = spyExec(99);
    const resolve = makeResolveBase({ exec, cp: "cp.sh", port: 14420, vaultFor: () => "ceibo-demo-gpuhost" });
    await expect(resolve("vm1")).rejects.toThrow(/serve no respondió/);
    expect(calls.map((c) => c[0])).toEqual(["serve", "assign", "serve"]); // un solo retry
  });

  it("sin vault conocido (registro vacío) → serve SIN --require-vault y propaga, sin assign", async () => {
    const { exec, calls } = spyExec(99);
    const resolve = makeResolveBase({ exec, cp: "cp.sh", port: 14420, vaultFor: () => undefined });
    await expect(resolve("vm1")).rejects.toThrow(/serve no respondió/);
    // sin vault → NO mandamos --require-vault (el fallback pelado de cp.sh sigue válido para ese caso).
    expect(calls).toEqual([["serve", "vm1"]]);
  });
});
