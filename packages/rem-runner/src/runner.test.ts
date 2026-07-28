// Tests unitarios del rem-runner: logica pura con planner/executor MOCKEADOS.
// NO se llama a Anthropic ni a opencode/gemma de verdad.

// Importamos las funciones puras de logic.ts para probar el contrato sin mocks.
import {
  buildRemPlannerPrompt,
  formatRemPlanForExecutor,
  parseRemStructuredPlan,
  type RemStructuredPlan,
  remPlanHasWork,
} from "@ceibo/gateway/logic";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Importamos los helpers publicos del runner.
import { type RemRunnerConfig, runRemForWiki } from "./runner.ts";

// ---------------------------------------------------------------------------
// 1. Pruebas de las funciones puras importadas de @ceibo/gateway/logic
// ---------------------------------------------------------------------------

describe("remPlanHasWork (importado de gateway/logic)", () => {
  const base: RemStructuredPlan = {
    risk: "low",
    should_execute: true,
    requires_user_confirmation: false,
    summary: "test",
    actions: [],
  };

  it("devuelve false para acciones vacias", () => {
    expect(remPlanHasWork({ ...base, actions: [] })).toBe(false);
  });

  it("devuelve false cuando todas las acciones son none", () => {
    expect(remPlanHasWork({ ...base, actions: [{ type: "none", path: "a.md", reason: "nada" }] })).toBe(
      false,
    );
  });

  it("devuelve true cuando hay al menos una accion accionable", () => {
    expect(
      remPlanHasWork({
        ...base,
        actions: [
          { type: "none", path: "a.md", reason: "nada" },
          { type: "edit", path: "b.md", reason: "hay algo" },
        ],
      }),
    ).toBe(true);
  });

  it("devuelve true para create, move, archive, delete, merge", () => {
    const types = ["create", "move", "archive", "delete", "merge"] as const;
    for (const type of types) {
      expect(remPlanHasWork({ ...base, actions: [{ type, path: "x.md", reason: "r" }] })).toBe(true);
    }
  });
});

describe("parseRemStructuredPlan (importado de gateway/logic)", () => {
  it("parsea un plan minimo valido", () => {
    const json = JSON.stringify({
      risk: "low",
      should_execute: true,
      requires_user_confirmation: false,
      summary: "consolidar notas duplicadas",
      actions: [{ type: "merge", path: "notas/a.md", reason: "duplicado" }],
    });
    const text = `\`\`\`json\n${json}\n\`\`\``;
    const plan = parseRemStructuredPlan(text);
    expect(plan).toBeDefined();
    expect(plan?.risk).toBe("low");
    expect(plan?.should_execute).toBe(true);
    expect(plan?.actions).toHaveLength(1);
  });

  it("devuelve undefined ante JSON invalido", () => {
    expect(parseRemStructuredPlan("sin json")).toBeUndefined();
    expect(parseRemStructuredPlan("```json\n{mal}\n```")).toBeUndefined();
  });

  it("devuelve undefined si falta el contrato minimo", () => {
    const json = JSON.stringify({ risk: "low" }); // falta should_execute, summary, actions
    expect(parseRemStructuredPlan(`\`\`\`json\n${json}\n\`\`\``)).toBeUndefined();
  });
});

describe("buildRemPlannerPrompt (importado de gateway/logic)", () => {
  it("incluye el nombre del repo y el scope", () => {
    const prompt = buildRemPlannerPrompt("ale-wiki", "delta: 3 notas cambiadas");
    expect(prompt).toContain("ale-wiki");
    expect(prompt).toContain("delta: 3 notas cambiadas");
  });

  it("incluye el contrato JSON del bloque final", () => {
    const prompt = buildRemPlannerPrompt("x", "y");
    expect(prompt).toContain("should_execute");
    expect(prompt).toContain("risk");
  });
});

describe("formatRemPlanForExecutor (importado de gateway/logic)", () => {
  it("incluye las acciones del plan", () => {
    const plan: RemStructuredPlan = {
      risk: "low",
      should_execute: true,
      requires_user_confirmation: false,
      summary: "consolidar",
      actions: [{ type: "merge", path: "notas/a.md", reason: "duplicado" }],
    };
    const txt = formatRemPlanForExecutor(plan);
    expect(txt).toContain("merge notas/a.md");
    expect(txt).toContain("duplicado");
    expect(txt).toContain("consolidar");
  });
});

// ---------------------------------------------------------------------------
// 2. Tests de orquestacion del runner con dependencias mockeadas
// ---------------------------------------------------------------------------

// Helpers para construir planes de test.
function makePlan(overrides: Partial<RemStructuredPlan> = {}): RemStructuredPlan {
  return {
    risk: "low",
    should_execute: true,
    requires_user_confirmation: false,
    summary: "consolidar notas duplicadas",
    actions: [{ type: "merge", path: "notas/a.md", reason: "duplicado" }],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<RemRunnerConfig> = {}): RemRunnerConfig {
  return {
    gitProxyBase: "https://proxy.test/api/git",
    pushToken: "tok-test",
    opencodeBase: "http://127.0.0.1:9999",
    gemmaModel: "local/gemma4-31b",
    anthropicKey: "sk-ant-test",
    // Estos tests ejercitan el path del planner anthropic (sonnet); el default real es vllm.
    plannerProvider: "anthropic",
    plannerModel: "claude-sonnet-4-6",
    ...overrides,
  };
}

// Mockeamos child_process y node:fs para no tocar el disco ni git.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "nota.md\n", stderr: "" })),
}));

vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  return {
    ...orig,
    mkdtempSync: vi.fn(() => "/tmp/rem-wiki-test-123"),
    rmSync: vi.fn(),
    readFileSync: vi.fn(() => "# Contenido de prueba\n"),
    existsSync: vi.fn(() => true),
  };
});

// Mock global de fetch para planner y opencode.
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Construye una respuesta fetch simulada. */
function mockResponse(status: number, body: unknown, contentType = "application/json"): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": contentType },
  });
}

/** Respuesta del planner sonnet: plan valido con una accion accionable. */
function plannerResponse(plan: RemStructuredPlan) {
  const planJson = JSON.stringify(plan);
  return mockResponse(200, {
    content: [{ type: "text", text: `Analice la wiki.\n\`\`\`json\n${planJson}\n\`\`\`` }],
    usage: { input_tokens: 1000, output_tokens: 200 },
  });
}

/** Flujo SSE minimo: session.idle en la sesion `ses`. */
function makeSseStream(ses: string, lastText = "Merge completado"): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const events = [
    // Evento de texto del asistente
    JSON.stringify({
      type: "message.part.updated",
      properties: { part: { sessionID: ses, type: "text", text: lastText } },
    }),
    // session.idle: el executor termino
    JSON.stringify({
      type: "session.idle",
      properties: { sessionID: ses },
    }),
  ]
    .map((e) => `data: ${e}\n\n`)
    .join("");

  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(events));
      controller.close();
    },
  });
}

/** SSE que NUNCA emite session.idle (simula timeout): solo heartbeats globales. Se cierra solo
 *  para que el reader no quede colgado en el test, pero como nunca hubo idle, el runner lo trata
 *  como no-idle (timeout) por el lado del flag. Para forzar el path de timeout REAL usamos un
 *  executorTimeoutMs muy bajo en el config del test. */
function makeNoIdleSseStream(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "server.heartbeat" })}\n\n`));
      // dejamos el stream abierto un toque para que el timeout del runner gane la carrera
      await new Promise((r) => setTimeout(r, 200));
      controller.close();
    },
  });
}

/**
 * Mock de spawnSync de git para los tests del executor. Devuelve:
 *  - `ls-files` -> un .md de prueba
 *  - `rev-parse HEAD` -> headBefore en la 1ra llamada, headAfter en las siguientes (asi el runner
 *    detecta o no un commit nuevo segun se le pasen iguales/distintos)
 *  - `push` -> `pushStatus` (0 OK). Si `rejectFirstPush`, el 1er push rebota y los siguientes (pull
 *    --rebase + reintento) van OK.
 *  - resto -> status 0
 */
function installGitSpawn(
  mockedSpawn: ReturnType<typeof vi.fn>,
  opts: { headBefore?: string; headAfter?: string; rejectFirstPush?: boolean } = {},
): void {
  const headBefore = opts.headBefore ?? "aaaa111";
  const headAfter = opts.headAfter ?? "bbbb222";
  let revParseCalls = 0;
  let pushCalls = 0;
  vi.mocked(mockedSpawn).mockImplementation((_cmd: unknown, args: unknown) => {
    const argsArr = (args as string[]) ?? [];
    if (argsArr.includes("ls-files")) {
      return { status: 0, stdout: "nota.md\n", stderr: "" } as ReturnType<typeof mockedSpawn>;
    }
    if (argsArr.includes("rev-parse")) {
      revParseCalls++;
      const sha = revParseCalls === 1 ? headBefore : headAfter;
      return { status: 0, stdout: `${sha}\n`, stderr: "" } as ReturnType<typeof mockedSpawn>;
    }
    if (argsArr.includes("push")) {
      pushCalls++;
      if (opts.rejectFirstPush && pushCalls === 1) {
        return {
          status: 1,
          stdout: "",
          stderr: "! [rejected] HEAD -> main (non-fast-forward)",
        } as ReturnType<typeof mockedSpawn>;
      }
      return { status: 0, stdout: "", stderr: "" } as ReturnType<typeof mockedSpawn>;
    }
    return { status: 0, stdout: "", stderr: "" } as ReturnType<typeof mockedSpawn>;
  });
}

describe("runRemForWiki - orquestacion con mocks", () => {
  it("flujo feliz: planifica y ejecuta, devuelve revisada", async () => {
    const plan = makePlan();
    const ses = "ses_test_abc";

    mockFetch
      // 1. Llamada al planner (Anthropic)
      .mockResolvedValueOnce(plannerResponse(plan))
      // 2. POST /session (opencode)
      .mockResolvedValueOnce(mockResponse(200, { id: ses }))
      // 3. POST /session/ses/prompt_async
      .mockResolvedValueOnce(mockResponse(200, {}))
      // 4. GET /event (SSE)
      .mockResolvedValueOnce(
        new Response(makeSseStream(ses, "Merge completado"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );

    const { spawnSync: mockedSpawn } = await import("node:child_process");
    // HEAD distinto antes/despues -> el runner verifica que hubo commit nuevo -> revisada.
    installGitSpawn(vi.mocked(mockedSpawn), { headBefore: "aaaa111", headAfter: "bbbb222" });

    const result = await runRemForWiki("ale-wiki", makeConfig(), "3 notas cambiadas");

    expect(result.wiki).toBe("ale-wiki");
    expect(result.status).toBe("revisada");
    expect(result.cost).toBeGreaterThan(0);
    expect(result.summary).toBe("Merge completado");
    expect(result.error).toBeUndefined();

    // El working dir se setea por query param ?directory= (opencode 1.17.4 ignora `cwd` en el
    // body de POST /session). El scratch mockeado es /tmp/rem-wiki-test-123.
    const encodedDir = encodeURIComponent("/tmp/rem-wiki-test-123");
    const sessionCall = mockFetch.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("/session?"),
    );
    expect(sessionCall).toBeDefined();
    expect(sessionCall?.[0]).toContain(`?directory=${encodedDir}`);
    // El body NO debe llevar `cwd` (opencode lo ignora por additionalProperties:false).
    const sessionBody = JSON.parse((sessionCall?.[1] as RequestInit).body as string);
    expect(sessionBody).not.toHaveProperty("cwd");

    // prompt_async tambien lleva ?directory= por robustez.
    const promptCall = mockFetch.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("/prompt_async"),
    );
    expect(promptCall).toBeDefined();
    expect(promptCall?.[0]).toContain(`?directory=${encodedDir}`);

    // GET /event tambien hay que scopearlo: sin ?directory= no llegan los session.idle de la
    // sesion del scratch (solo el stream global) y el runner colgaria hasta el timeout.
    const eventCall = mockFetch.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("/event"));
    expect(eventCall).toBeDefined();
    expect(eventCall?.[0]).toContain(`?directory=${encodedDir}`);
  });

  it("no-op: plan should_execute=false -> sin-cambios sin llamar al executor", async () => {
    const plan = makePlan({ should_execute: false });
    mockFetch.mockResolvedValueOnce(plannerResponse(plan));

    const result = await runRemForWiki("ale-wiki", makeConfig(), "sin cambios");

    expect(result.status).toBe("sin-cambios");
    // Solo UNA llamada fetch: el planner. Opencode no se toco.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("planner vllm: pega al endpoint OpenAI-compat de gemma, no a Anthropic", async () => {
    const plan = makePlan({ should_execute: false });
    const planJson = JSON.stringify(plan);
    // Respuesta OpenAI-compat (vLLM): choices[].message.content.
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, {
        choices: [{ message: { content: `Analice.\n\`\`\`json\n${planJson}\n\`\`\`` } }],
      }),
    );

    const cfg = makeConfig({
      plannerProvider: "vllm",
      plannerModel: undefined,
      vllmBase: "http://127.0.0.1:8000/v1",
      vllmKey: "sk-no-key",
    });
    const result = await runRemForWiki("ale-wiki", cfg, "primera corrida");

    expect(result.status).toBe("sin-cambios");
    expect(result.cost).toBe(0); // local: costo 0
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain("127.0.0.1:8000/v1/chat/completions");
    expect(url).not.toContain("api.anthropic.com");
    // El modelID se deriva de gemmaModel ("local/gemma4-31b" -> "gemma4-31b").
    const body = JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.model).toBe("gemma4-31b");
  });

  it("no-op: plan sin acciones accionables (solo none) -> sin-cambios", async () => {
    const plan = makePlan({
      should_execute: true,
      actions: [{ type: "none", path: "x.md", reason: "todo OK" }],
    });
    mockFetch.mockResolvedValueOnce(plannerResponse(plan));

    const result = await runRemForWiki("ale-wiki", makeConfig(), "sin cambios");

    expect(result.status).toBe("sin-cambios");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("no-op: plan acciones vacias -> sin-cambios", async () => {
    const plan = makePlan({ should_execute: true, actions: [] });
    mockFetch.mockResolvedValueOnce(plannerResponse(plan));

    const result = await runRemForWiki("ale-wiki", makeConfig(), "sin cambios");

    expect(result.status).toBe("sin-cambios");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("no-op: plan requires_user_confirmation=true -> sin-cambios (en pausa)", async () => {
    const plan = makePlan({ requires_user_confirmation: true, report_for_user: "muchos borrados" });
    mockFetch.mockResolvedValueOnce(plannerResponse(plan));

    const result = await runRemForWiki("ale-wiki", makeConfig(), "ambiguo");

    expect(result.status).toBe("sin-cambios");
    expect(result.summary).toContain("pausa");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("no-op: plan risk=high -> sin-cambios (en pausa)", async () => {
    const plan = makePlan({ risk: "high" });
    mockFetch.mockResolvedValueOnce(plannerResponse(plan));

    const result = await runRemForWiki("ale-wiki", makeConfig(), "risky");

    expect(result.status).toBe("sin-cambios");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("error: planner devuelve JSON invalido -> status error", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, {
        content: [{ type: "text", text: "No tengo un plan hoy." }],
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    );

    const result = await runRemForWiki("ale-wiki", makeConfig(), "scope");

    expect(result.status).toBe("error");
    expect(result.error).toBeDefined();
  });

  it("error: git clone falla -> status error, scratch borrado", async () => {
    const { spawnSync: mockedSpawn } = await import("node:child_process");
    const { rmSync: mockedRm } = await import("node:fs");

    vi.mocked(mockedSpawn).mockImplementationOnce(
      () =>
        ({
          status: 128,
          stdout: "",
          stderr: "fatal: repository not found",
        }) as ReturnType<typeof mockedSpawn>,
    );

    const result = await runRemForWiki("no-existe", makeConfig(), "scope");

    expect(result.status).toBe("error");
    expect(result.error).toContain("git clone");
    // El scratch SIEMPRE se borra (rmSync llamado).
    expect(vi.mocked(mockedRm)).toHaveBeenCalled();
  });

  it("error: Anthropic API 429 -> status error", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(429, "rate limited"));

    const result = await runRemForWiki("ale-wiki", makeConfig(), "scope");

    expect(result.status).toBe("error");
    expect(result.error).toContain("429");
  });

  it("push rechazado: hace rebase y reintenta", async () => {
    const plan = makePlan();
    const ses = "ses_push_test";
    const { spawnSync: mockedSpawn } = await import("node:child_process");

    // HEAD nuevo (commit verificado) + 1er push rechazado -> pull --rebase + reintento OK.
    installGitSpawn(vi.mocked(mockedSpawn), {
      headBefore: "aaaa111",
      headAfter: "bbbb222",
      rejectFirstPush: true,
    });

    mockFetch
      .mockResolvedValueOnce(plannerResponse(plan))
      .mockResolvedValueOnce(mockResponse(200, { id: ses }))
      .mockResolvedValueOnce(mockResponse(200, {}))
      .mockResolvedValueOnce(
        new Response(makeSseStream(ses), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );

    const result = await runRemForWiki("ale-wiki", makeConfig(), "scope");
    // Con el reintento OK tras el rebase, termina en revisada.
    expect(result.status).toBe("revisada");
  });

  it("commit verification: executor termina (idle) pero SIN commit nuevo -> sin-cambios", async () => {
    const plan = makePlan();
    const ses = "ses_nocommit";
    const { spawnSync: mockedSpawn } = await import("node:child_process");

    // MISMO HEAD antes/despues -> no hubo commit -> sin-cambios (nunca revisada falso).
    installGitSpawn(vi.mocked(mockedSpawn), { headBefore: "same777", headAfter: "same777" });

    mockFetch
      .mockResolvedValueOnce(plannerResponse(plan))
      .mockResolvedValueOnce(mockResponse(200, { id: ses }))
      .mockResolvedValueOnce(mockResponse(200, {}))
      .mockResolvedValueOnce(
        new Response(makeSseStream(ses), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );

    const result = await runRemForWiki("ale-wiki", makeConfig(), "scope");

    expect(result.status).toBe("sin-cambios");
    // No se intento push (no hay commit que subir).
    const pushCall = mockFetch.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("/push"));
    expect(pushCall).toBeUndefined();
    const gitPush = vi.mocked(mockedSpawn).mock.calls.find((c) => (c[1] as string[])?.includes("push"));
    expect(gitPush).toBeUndefined();
  });

  it("timeout: no llega session.idle antes del executorTimeoutMs -> error, NO revisada, aborta sesion", async () => {
    const plan = makePlan();
    const ses = "ses_timeout";
    const { spawnSync: mockedSpawn } = await import("node:child_process");
    const { rmSync: mockedRm } = await import("node:fs");

    installGitSpawn(vi.mocked(mockedSpawn), { headBefore: "aaaa111", headAfter: "bbbb222" });

    mockFetch
      .mockResolvedValueOnce(plannerResponse(plan))
      .mockResolvedValueOnce(mockResponse(200, { id: ses }))
      .mockResolvedValueOnce(mockResponse(200, {}))
      // GET /event sin session.idle -> el timeout (10ms) gana la carrera
      .mockResolvedValueOnce(
        new Response(makeNoIdleSseStream(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      )
      // POST /session/{id}/abort (lo dispara el runner ante timeout antes de wipear)
      .mockResolvedValueOnce(mockResponse(200, {}));

    const result = await runRemForWiki("ale-wiki", makeConfig({ executorTimeoutMs: 10 }), "scope");

    expect(result.status).toBe("error");
    expect(result.status).not.toBe("revisada");
    expect(result.error).toContain("timeout");

    // Se aborto la sesion opencode ANTES de wipear (no dejar a gemma escribiendo el scratch).
    const abortCall = mockFetch.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes(`/session/${ses}/abort`),
    );
    expect(abortCall).toBeDefined();

    // NO se pusheo (timeout != exito).
    const gitPush = vi.mocked(mockedSpawn).mock.calls.find((c) => (c[1] as string[])?.includes("push"));
    expect(gitPush).toBeUndefined();

    // El scratch igual se borra (finally).
    expect(vi.mocked(mockedRm)).toHaveBeenCalled();
  });
});
