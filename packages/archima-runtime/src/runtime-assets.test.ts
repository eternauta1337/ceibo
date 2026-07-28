// Invariantes del set ESTÁTICO versionado (`runtime/`): de-secreteado, canónico, ejecutable.
// Estos tests no necesitan red ni la box — corren en CI.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNoSecrets } from "./build.ts";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME = join(PKG, "runtime");

describe("runtime estático versionado", () => {
  it("opencode-delegv2.json parsea y no trae secretos en claro (vLLM ni anthropic)", () => {
    const cfg = JSON.parse(readFileSync(join(RUNTIME, "configs/opencode-delegv2.json"), "utf8"));
    expect(cfg.provider.local.options.apiKey).toBe("__VLLM_KEY__");
    expect(cfg.provider["local-qwen"].options.apiKey).toBe("__VLLM_KEY__");
    expect(cfg.provider["local-gemma-lite"].options.apiKey).toBe("__VLLM_KEY__");
    expect(cfg.provider.anthropic.options.apiKey).toBe("__ANTHROPIC_VAULT_REF__");
  });

  it("no hay literales-secreto en ningún archivo de runtime/", () => {
    expect(() => assertNoSecrets(RUNTIME)).not.toThrow();
  });

  it("los scripts canónicos del control-plane están y son ejecutables", () => {
    const scripts = [
      "cp.sh",
      "cp-forced.sh",
      "spawn-vm.sh",
      "build-golden.sh",
      "warm-golden.sh",
      "vm-firewall.sh",
    ];
    for (const sh of scripts) {
      const mode = statSync(join(RUNTIME, "vm", sh)).mode;
      expect(mode & 0o100, `${sh} debe tener bit +x`).toBeTruthy();
    }
  });

  it("no se colaron variantes no-canónicas (.bak, cp-b.sh, opencode-av-test/testwiki)", () => {
    const vm = readdirSync(join(RUNTIME, "vm"));
    const configs = readdirSync(join(RUNTIME, "configs"));
    expect(vm.some((f) => f.includes(".bak") || f === "cp-b.sh")).toBe(false);
    expect(configs.some((f) => f.includes(".bak") || f.includes("av-test") || f.includes("testwiki"))).toBe(
      false,
    );
  });

  it("AGENTS.md canónico es el stub (el system prompt real va por los prompts de agente)", () => {
    const agents = readFileSync(join(RUNTIME, "configs/AGENTS.md"), "utf8");
    expect(agents.length).toBeLessThan(200);
    expect(agents).toContain("tu prompt de agente");
  });
});
