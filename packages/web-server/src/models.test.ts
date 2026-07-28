import { describe, expect, it } from "vitest";
import {
  CHAT_MODELS,
  DEFAULT_LOCAL_MODEL_KEY,
  DEFAULT_MODEL_KEY,
  defaultModelKeyForBackend,
  LOCAL_MODELS,
  modelsForBackend,
} from "./models.ts";

describe("web CHAT_MODELS", () => {
  it("claves únicas y campos presentes", () => {
    const keys = CHAT_MODELS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const m of CHAT_MODELS) {
      expect(m.key).toBeTruthy();
      expect(m.label).toBeTruthy();
      expect(m.envKey).toBeTruthy();
    }
  });

  it("DEFAULT_MODEL_KEY existe en la tabla", () => {
    expect(CHAT_MODELS.map((m) => m.key)).toContain(DEFAULT_MODEL_KEY);
  });
});

describe("modelsForBackend (cog por-backend)", () => {
  const env = { AGENT_ID: "a", AGENT_ID_SONNET: "s" } as unknown as NodeJS.ProcessEnv; // opus no publicado

  it("local → roster local (NO los de Anthropic)", () => {
    const keys = modelsForBackend("local", env).map((m) => m.key);
    expect(keys).toEqual(LOCAL_MODELS.map((m) => m.key));
    expect(keys).not.toContain("haiku");
    expect(keys).not.toContain("sonnet");
  });

  it("local ofrece sólo Gemma", () => {
    const keys = modelsForBackend("local", env).map((m) => m.key);
    expect(keys).toEqual(["gemma"]);
  });

  it("ma → sólo los Anthropic publicados (gated por env)", () => {
    const keys = modelsForBackend("ma", env).map((m) => m.key);
    expect(keys).toEqual(["haiku", "sonnet"]); // opus excluido (sin AGENT_ID_OPUS)
  });

  it("default por backend: local→gemma, ma→sonnet", () => {
    expect(defaultModelKeyForBackend("local")).toBe(DEFAULT_LOCAL_MODEL_KEY);
    expect(defaultModelKeyForBackend("ma")).toBe(DEFAULT_MODEL_KEY);
  });
});
