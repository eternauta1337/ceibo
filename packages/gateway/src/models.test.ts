import { describe, expect, it } from "vitest";
import {
  CHAT_MODELS,
  DEFAULT_LOCAL_MODEL_KEY,
  DEFAULT_MODEL_KEY,
  defaultModelKeyForBackend,
  EXTRA_COORDINATORS,
  LOCAL_MODELS,
  modelsForBackend,
  PRINCIPAL_MODEL_KEY,
} from "./models.ts";

describe("CHAT_MODELS", () => {
  it("tiene al menos un modelo y claves únicas", () => {
    expect(CHAT_MODELS.length).toBeGreaterThan(0);
    const keys = CHAT_MODELS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("cada modelo declara key/label/model/envKey/agentName", () => {
    for (const m of CHAT_MODELS) {
      expect(m.key).toBeTruthy();
      expect(m.label).toBeTruthy();
      expect(m.model).toMatch(/^claude-/);
      expect(m.envKey).toBeTruthy();
      expect(m.agentName).toBeTruthy();
    }
  });
});

describe("claves de modelo", () => {
  it("DEFAULT_MODEL_KEY y PRINCIPAL_MODEL_KEY existen en la tabla", () => {
    const keys = CHAT_MODELS.map((m) => m.key);
    expect(keys).toContain(DEFAULT_MODEL_KEY);
    expect(keys).toContain(PRINCIPAL_MODEL_KEY);
  });

  it("EXTRA_COORDINATORS = todos salvo el principal", () => {
    expect(EXTRA_COORDINATORS.some((m) => m.key === PRINCIPAL_MODEL_KEY)).toBe(false);
    expect(EXTRA_COORDINATORS.length).toBe(CHAT_MODELS.length - 1);
  });
});

describe("modelsForBackend (workstream E — lista por-backend)", () => {
  const env = { AGENT_ID: "a", AGENT_ID_SONNET: "s" } as unknown as NodeJS.ProcessEnv; // opus no publicado

  it("local → roster local; NO ofrece modelos de Anthropic", () => {
    const local = modelsForBackend("local", env);
    const keys = local.map((m) => m.key);
    expect(keys).toContain("gemma");
    for (const ma of ["haiku", "sonnet", "opus"]) expect(keys).not.toContain(ma);
  });

  it("local expone sólo Gemma", () => {
    expect(modelsForBackend("local", env).map((m) => m.key)).toEqual(["gemma"]);
  });

  it("ma → sólo los coordinadores publicados (gated por env)", () => {
    expect(modelsForBackend("ma", env).map((m) => m.key)).toEqual(["haiku", "sonnet"]);
  });

  it("default por backend: local→gemma, ma→sonnet", () => {
    expect(defaultModelKeyForBackend("local")).toBe(DEFAULT_LOCAL_MODEL_KEY);
    expect(defaultModelKeyForBackend("ma")).toBe(DEFAULT_MODEL_KEY);
  });

  it("LOCAL_MODELS: claves únicas, default presente, model = id de opencode (no claude-)", () => {
    const keys = LOCAL_MODELS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(DEFAULT_LOCAL_MODEL_KEY);
    for (const m of LOCAL_MODELS) expect(m.model).not.toMatch(/^claude-/);
  });
});
