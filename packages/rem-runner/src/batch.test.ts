// Tests unitarios del batch orchestrator (batch.ts).
// runRemForWiki y fetch están totalmente mockeados — no se toca la red ni el disco.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BatchConfig, runRemBatch } from "./batch.ts";
import type { RemRunnerConfig, RemRunnerResult, RemRunnerStatus } from "./runner.ts";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mockeamos el runner para no tocar git, Anthropic ni opencode.
vi.mock("./runner.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./runner.ts")>();
  return {
    ...orig,
    runRemForWiki: vi.fn(),
    configFromEnv: vi.fn(() => makeRunnerCfg()),
  };
});

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRunnerCfg(overrides: Partial<RemRunnerConfig> = {}): RemRunnerConfig {
  return {
    gitProxyBase: "https://proxy.test/api/git",
    pushToken: "tok-base",
    opencodeBase: "http://127.0.0.1:4200",
    gemmaModel: "local/gemma4-31b",
    anthropicKey: "sk-ant-test",
    ...overrides,
  };
}

function makeCfg(overrides: Partial<BatchConfig> = {}): BatchConfig {
  return {
    batchBase: "https://ceibo.test",
    batchSecret: "s3cr3t",
    runner: makeRunnerCfg(),
    ...overrides,
  };
}

function mockJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function batchResponse(wikis: { wiki: string; scope: string; pushToken: string }[]): Response {
  return mockJson(200, {
    batchId: "rem-test-abc",
    generatedAt: new Date().toISOString(),
    wikis,
  });
}

function runnerResult(
  wiki: string,
  status: RemRunnerStatus = "revisada",
  summary = "todo ok",
  cost = 0.05,
): RemRunnerResult {
  return { wiki, status, cost, summary };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runRemBatch", () => {
  describe("sin wikis", () => {
    it("GET /batch vacío → POST /report vacío, sin llamar runRemForWiki", async () => {
      mockFetch
        .mockResolvedValueOnce(batchResponse([])) // GET /batch
        .mockResolvedValueOnce(mockJson(200, { ok: true })); // POST /report

      const { runRemForWiki } = await import("./runner.ts");
      const results = await runRemBatch(makeCfg());

      expect(results).toHaveLength(0);
      expect(vi.mocked(runRemForWiki)).not.toHaveBeenCalled();

      // Verifica que se llama a POST /report igualmente (con results vacío).
      const reportCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/api/rem/report"),
      );
      expect(reportCall).toBeDefined();
      const reportBody = JSON.parse((reportCall?.[1] as RequestInit).body as string);
      expect(reportBody.results).toHaveLength(0);
    });
  });

  describe("flujo feliz", () => {
    it("una wiki → runRemForWiki con pushToken del batch, POST /report con el resultado", async () => {
      const { runRemForWiki } = await import("./runner.ts");
      vi.mocked(runRemForWiki).mockResolvedValueOnce(runnerResult("ale-wiki"));

      mockFetch
        .mockResolvedValueOnce(
          batchResponse([{ wiki: "ale-wiki", scope: "3 notas cambiadas", pushToken: "tok-wiki-1" }]),
        )
        .mockResolvedValueOnce(mockJson(200, { ok: true }));

      const results = await runRemBatch(makeCfg());

      expect(results).toHaveLength(1);
      expect(results[0]?.wiki).toBe("ale-wiki");
      expect(results[0]?.status).toBe("revisada");

      // El runner recibe el pushToken de la wiki (no el base runner config).
      const firstCall = vi.mocked(runRemForWiki).mock.calls[0];
      expect(firstCall?.[0]).toBe("ale-wiki");
      expect((firstCall?.[1] as RemRunnerConfig | undefined)?.pushToken).toBe("tok-wiki-1");
    });

    it("dos wikis → procesadas secuencialmente, POST /report con ambos resultados", async () => {
      const { runRemForWiki } = await import("./runner.ts");
      vi.mocked(runRemForWiki)
        .mockResolvedValueOnce(runnerResult("ale-wiki", "revisada", "merge ok", 0.03))
        .mockResolvedValueOnce(runnerResult("lula-wiki", "sin-cambios", "nada que hacer", 0.01));

      mockFetch
        .mockResolvedValueOnce(
          batchResponse([
            { wiki: "ale-wiki", scope: "scope-ale", pushToken: "tok-ale" },
            { wiki: "lula-wiki", scope: "scope-lula", pushToken: "tok-lula" },
          ]),
        )
        .mockResolvedValueOnce(mockJson(200, { ok: true }));

      const results = await runRemBatch(makeCfg());

      expect(results).toHaveLength(2);
      expect(results[0]?.wiki).toBe("ale-wiki");
      expect(results[0]?.status).toBe("revisada");
      expect(results[1]?.wiki).toBe("lula-wiki");
      expect(results[1]?.status).toBe("sin-cambios");

      // Las wikis se procesaron en orden (secuencial).
      const calls = vi.mocked(runRemForWiki).mock.calls;
      expect(calls[0]?.[0]).toBe("ale-wiki");
      expect(calls[1]?.[0]).toBe("lula-wiki");

      // El scope de cada wiki llega intacto al runner.
      expect(calls[0]?.[2]).toBe("scope-ale");
      expect(calls[1]?.[2]).toBe("scope-lula");
    });

    it("wiki con error → incluida en el report con status=error", async () => {
      const { runRemForWiki } = await import("./runner.ts");
      vi.mocked(runRemForWiki).mockResolvedValueOnce({
        wiki: "ale-wiki",
        status: "error",
        cost: 0,
        summary: "git clone fallo",
        error: "git clone fallo",
      });

      mockFetch
        .mockResolvedValueOnce(batchResponse([{ wiki: "ale-wiki", scope: "scope", pushToken: "tok" }]))
        .mockResolvedValueOnce(mockJson(200, { ok: true }));

      const results = await runRemBatch(makeCfg());

      expect(results[0]?.status).toBe("error");
      expect(results[0]?.summary).toContain("git clone");

      // El report se manda igualmente (no abortamos ante error per-wiki).
      const reportCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/api/rem/report"),
      );
      expect(reportCall).toBeDefined();
    });

    it("runRemForWiki lanza excepción → aislada en esa wiki, el resto continúa y el report llega", async () => {
      const { runRemForWiki } = await import("./runner.ts");
      vi.mocked(runRemForWiki)
        .mockRejectedValueOnce(new Error("crash inesperado"))
        .mockResolvedValueOnce(runnerResult("lula-wiki", "revisada", "ok", 0.02));

      mockFetch
        .mockResolvedValueOnce(
          batchResponse([
            { wiki: "ale-wiki", scope: "s", pushToken: "t1" },
            { wiki: "lula-wiki", scope: "s2", pushToken: "t2" },
          ]),
        )
        .mockResolvedValueOnce(mockJson(200, { ok: true }));

      const results = await runRemBatch(makeCfg());

      // Primer wiki con excepción → error aislado.
      expect(results[0]?.wiki).toBe("ale-wiki");
      expect(results[0]?.status).toBe("error");
      expect(results[0]?.summary).toContain("crash inesperado");

      // Segunda wiki sigue procesándose.
      expect(results[1]?.wiki).toBe("lula-wiki");
      expect(results[1]?.status).toBe("revisada");

      // El report incluye ambas.
      const reportCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/api/rem/report"),
      );
      const body = JSON.parse((reportCall?.[1] as RequestInit).body as string);
      expect(body.results).toHaveLength(2);
    });
  });

  describe("auth", () => {
    it("GET /batch lleva Authorization: Bearer <secret>", async () => {
      const { runRemForWiki } = await import("./runner.ts");
      vi.mocked(runRemForWiki).mockResolvedValueOnce(runnerResult("ale-wiki"));

      mockFetch
        .mockResolvedValueOnce(batchResponse([{ wiki: "ale-wiki", scope: "s", pushToken: "t" }]))
        .mockResolvedValueOnce(mockJson(200, {}));

      await runRemBatch(makeCfg({ batchSecret: "my-secret" }));

      const batchCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/api/rem/batch"),
      );
      expect(batchCall?.[1]).toMatchObject({
        headers: expect.objectContaining({ authorization: "Bearer my-secret" }),
      });
    });

    it("POST /report lleva Authorization: Bearer <secret>", async () => {
      const { runRemForWiki } = await import("./runner.ts");
      vi.mocked(runRemForWiki).mockResolvedValueOnce(runnerResult("ale-wiki"));

      mockFetch
        .mockResolvedValueOnce(batchResponse([{ wiki: "ale-wiki", scope: "s", pushToken: "t" }]))
        .mockResolvedValueOnce(mockJson(200, {}));

      await runRemBatch(makeCfg({ batchSecret: "my-secret" }));

      const reportCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/api/rem/report"),
      );
      expect(reportCall?.[1]).toMatchObject({
        headers: expect.objectContaining({ authorization: "Bearer my-secret" }),
      });
    });
  });

  describe("errores de red", () => {
    it("GET /batch con status 403 → tira error (no llega al runner)", async () => {
      mockFetch.mockResolvedValueOnce(mockJson(403, { error: "forbidden" }));

      const { runRemForWiki } = await import("./runner.ts");
      await expect(runRemBatch(makeCfg())).rejects.toThrow("403");
      expect(vi.mocked(runRemForWiki)).not.toHaveBeenCalled();
    });

    it("GET /batch con status 401 → tira error", async () => {
      mockFetch.mockResolvedValueOnce(mockJson(401, { error: "unauth" }));

      await expect(runRemBatch(makeCfg())).rejects.toThrow("401");
    });

    it("POST /report con status 500 → tira error (resultados ya procesados)", async () => {
      const { runRemForWiki } = await import("./runner.ts");
      vi.mocked(runRemForWiki).mockResolvedValueOnce(runnerResult("ale-wiki"));

      mockFetch
        .mockResolvedValueOnce(batchResponse([{ wiki: "ale-wiki", scope: "s", pushToken: "t" }]))
        .mockResolvedValueOnce(mockJson(500, { error: "internal" }));

      await expect(runRemBatch(makeCfg())).rejects.toThrow("500");
    });
  });

  describe("urls correctas", () => {
    it("usa el batchBase del config para las dos rutas", async () => {
      const { runRemForWiki } = await import("./runner.ts");
      vi.mocked(runRemForWiki).mockResolvedValueOnce(runnerResult("ale-wiki"));

      mockFetch
        .mockResolvedValueOnce(batchResponse([{ wiki: "ale-wiki", scope: "s", pushToken: "t" }]))
        .mockResolvedValueOnce(mockJson(200, {}));

      await runRemBatch(makeCfg({ batchBase: "https://my.server.test" }));

      const batchBase = mockFetch.mock.calls[0]?.[0] as string;
      // La segunda llamada a fetch es POST /report (index 1, runner está mockeado).
      const reportUrl = mockFetch.mock.calls[1]?.[0] as string;
      expect(batchBase).toBe("https://my.server.test/api/rem/batch");
      expect(reportUrl).toBe("https://my.server.test/api/rem/report");
    });

    it("trailing slash en batchBase se elimina correctamente", async () => {
      const { runRemForWiki } = await import("./runner.ts");
      vi.mocked(runRemForWiki).mockResolvedValueOnce(runnerResult("ale-wiki"));

      mockFetch
        .mockResolvedValueOnce(batchResponse([{ wiki: "ale-wiki", scope: "s", pushToken: "t" }]))
        .mockResolvedValueOnce(mockJson(200, {}));

      // batchBase con trailing slash: no debe terminar en doble slash
      await runRemBatch(makeCfg({ batchBase: "https://my.server.test/" }));

      const batchBase = mockFetch.mock.calls[0]?.[0] as string;
      expect(batchBase).toBe("https://my.server.test/api/rem/batch");
      expect(batchBase).not.toContain("//api");
    });
  });

  describe("report body", () => {
    it("el batchId del report coincide con el del GET", async () => {
      const { runRemForWiki } = await import("./runner.ts");
      vi.mocked(runRemForWiki).mockResolvedValueOnce(runnerResult("ale-wiki"));

      const batchId = "rem-unique-id-123";
      mockFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              batchId,
              generatedAt: new Date().toISOString(),
              wikis: [{ wiki: "ale-wiki", scope: "s", pushToken: "t" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(mockJson(200, {}));

      await runRemBatch(makeCfg());

      const reportCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/api/rem/report"),
      );
      const body = JSON.parse((reportCall?.[1] as RequestInit).body as string);
      expect(body.batchId).toBe(batchId);
    });

    it("los resultados en el report no incluyen el campo 'error' del runner", async () => {
      // error es interno del runner, no se mapea al wire del report.
      const { runRemForWiki } = await import("./runner.ts");
      vi.mocked(runRemForWiki).mockResolvedValueOnce({
        wiki: "ale-wiki",
        status: "error",
        cost: 0,
        summary: "fallo git",
        error: "fallo git interno",
      });

      mockFetch
        .mockResolvedValueOnce(batchResponse([{ wiki: "ale-wiki", scope: "s", pushToken: "t" }]))
        .mockResolvedValueOnce(mockJson(200, {}));

      await runRemBatch(makeCfg());

      const reportCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/api/rem/report"),
      );
      const body = JSON.parse((reportCall?.[1] as RequestInit).body as string);
      // El campo 'error' del runner no debe aparecer en el wire
      expect(body.results[0]).not.toHaveProperty("error");
      expect(body.results[0]?.status).toBe("error");
    });
  });
});
