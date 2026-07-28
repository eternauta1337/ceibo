import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./archima-backend.ts";
import { belongsToSession, HttpOpencodeClient, StreamIdleError } from "./http-opencode-client.ts";
import type { OpencodeEvent } from "./opencode-events.ts";

/** Respuesta fetch mínima que el cliente entiende (ok/status/headers/json/text). */
function jsonRes(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers?.[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const noSleep = async () => {};

describe("HttpOpencodeClient — cold-start tolerante", () => {
  it("reintenta resolveBase + POST /session ante fallos transitorios hasta que la VM levanta", async () => {
    let baseCalls = 0;
    let fetchCalls = 0;
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: noSleep,
      resolveBase: async () => {
        baseCalls++;
        return "http://10.0.0.1:14420";
      },
      fetchImpl: (async () => {
        fetchCalls++;
        // los 2 primeros intentos: la VM aún no levantó el serve → fetch falla
        if (fetchCalls <= 2) throw new Error("fetch failed");
        return jsonRes({ id: "ses_1" });
      }) as unknown as typeof fetch,
    });

    await client.ensureSession("vm1");
    // reintentó: 3 intentos de fetch y 3 de resolveBase (re-asegura serve en cada vuelta)
    expect(fetchCalls).toBe(3);
    expect(baseCalls).toBe(3);
  });

  it("reintenta ante 5xx (server levantando) y termina vinculando", async () => {
    let fetchCalls = 0;
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: noSleep,
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl: (async () => {
        fetchCalls++;
        if (fetchCalls === 1) return jsonRes({ err: "starting" }, 503);
        return jsonRes({ id: "ses_2" });
      }) as unknown as typeof fetch,
    });
    await client.ensureSession("vm1");
    expect(fetchCalls).toBe(2);
  });

  it("NO reintenta ante 4xx (request inválida): falla de una", async () => {
    let fetchCalls = 0;
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: noSleep,
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl: (async () => {
        fetchCalls++;
        return jsonRes({ err: "bad" }, 400);
      }) as unknown as typeof fetch,
    });
    await expect(client.ensureSession("vm1")).rejects.toThrow(/400/);
    expect(fetchCalls).toBe(1); // sin reintentos
  });

  it("agota los intentos y lanza un error de cold-start", async () => {
    let fetchCalls = 0;
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: noSleep,
      connectAttempts: 3,
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl: (async () => {
        fetchCalls++;
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(client.ensureSession("vm1")).rejects.toThrow(/cold-start.*3 intentos/);
    expect(fetchCalls).toBe(3);
  });
});

describe("HttpOpencodeClient — unbind (invalidación del binding en /new)", () => {
  it("tras unbind, ensureSession re-corre resolveBase (serve) + POST /session → sesión opencode NUEVA", async () => {
    let baseCalls = 0;
    let seq = 0;
    const prompted: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url).pathname;
      if (method === "POST" && path === "/session") return jsonRes({ id: `ses_${++seq}` });
      if (method === "POST" && /prompt_async$/.test(path)) {
        prompted.push(path.split("/")[2] ?? "");
        return jsonRes({});
      }
      return jsonRes({ err: "unexpected" }, 404);
    }) as unknown as typeof fetch;
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: noSleep,
      resolveBase: async () => {
        baseCalls++;
        return "http://10.0.0.1:14420";
      },
      fetchImpl,
    });

    await client.ensureSession("vm1");
    await client.ensureSession("vm1"); // binding vivo → early-return (sin red)
    expect(baseCalls).toBe(1);

    client.unbind("vm1"); // /new: el backend invalida el binding
    await client.ensureSession("vm1");
    expect(baseCalls).toBe(2); // resolveBase de nuevo = `cp.sh serve` re-wrappea con el token vigente
    await client.prompt("vm1", [{ type: "text", text: "hola" }]);
    expect(prompted).toEqual(["ses_2"]); // la sesión opencode es OTRA (contexto reseteado)
  });

  it("unbind de una sesión no vinculada es inocuo", () => {
    const client = newClient((async () => jsonRes({ id: "ses_1" })) as unknown as typeof fetch);
    expect(() => client.unbind("vm-nunca-vista")).not.toThrow();
  });
});

describe("HttpOpencodeClient — openWorkerSession (sub-agente en la VM viva)", () => {
  it("abre una sesión NUEVA en la VM del coordinador (mismo base, ses distinto) y rutea su prompt ahí", async () => {
    const baseArgs: string[] = [];
    const paths: string[] = [];
    let seq = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url).pathname;
      paths.push(`${method} ${path}`);
      if (method === "POST" && path === "/session") return jsonRes({ id: `ses_${++seq}` });
      if (method === "POST" && /prompt_async$/.test(path)) return jsonRes({});
      return jsonRes({ err: "unexpected" }, 404);
    }) as unknown as typeof fetch;
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: noSleep,
      resolveBase: async (id) => {
        baseArgs.push(id);
        return "http://10.0.0.1:14420";
      },
      fetchImpl,
    });

    const vm = "ceibo-demo-env_013";
    const workerSid = await client.openWorkerSession(vm);
    // sessionId lógico propio del worker, derivado del nombre de VM del coordinador
    expect(workerSid).toBe(`${vm}#worker:ses_1`);
    // resolveBase se consultó con el NOMBRE DE VM del coordinador (no con un id ajeno) → sin clon
    expect(baseArgs).toEqual([vm]);

    // El prompt del worker rutea a SU ses (ses_1) en la misma base; NO re-resuelve (binding pre-poblado)
    await client.prompt(workerSid, [{ type: "text", text: "hola" }]);
    expect(paths).toEqual(["POST /session", "POST /session/ses_1/prompt_async"]);
    expect(baseArgs).toEqual([vm]); // un único resolveBase (no hubo segundo)
  });
});

describe("HttpOpencodeClient — summarize (compactación manual on-demand, /compact)", () => {
  it("POST /session/:id/summarize con el modelo del binding en el body", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    let seq = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, path, body });
      if (method === "POST" && path === "/session") return jsonRes({ id: `ses_${++seq}` });
      if (/summarize$/.test(path)) return jsonRes({ ok: true });
      return jsonRes({ err: "unexpected" }, 404);
    }) as unknown as typeof fetch;
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "gemma4-31b",
      sleepImpl: noSleep,
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl,
    });

    await client.ensureSession("vm1");
    await client.summarize("vm1");

    const sum = calls.find((c) => /summarize$/.test(c.path));
    expect(sum?.method).toBe("POST");
    expect(sum?.path).toBe("/session/ses_1/summarize"); // la sesión opencode del binding
    // opencode 1.17.8 necesita el modelo para generar el resumen → va en el body (flatten).
    expect(sum?.body).toEqual({ providerID: "local", modelID: "gemma4-31b" });
  });
});

/** Una llamada fetch registrada (method/url + body parseado si fue JSON). */
interface Call {
  method: string;
  url: string;
  body?: unknown;
}

/** Mock de fetch que rutea por (method, path) del API de opencode. `mcpStatus` es el estado que
 *  devuelve GET /mcp. Registra todas las llamadas en `calls`. */
function routingFetch(opts: {
  calls: Call[];
  mcpStatus?: Record<string, { status?: string; config?: { url?: string } }>;
  // por-nombre: si el POST /mcp <name> debe fallar (status) — para el test de tolerancia.
  failConnect?: Record<string, number>;
}): typeof fetch {
  const { calls, mcpStatus = {}, failConnect = {} } = opts;
  // STATEFUL: un server POSTeado con éxito pasa a `connected` en los GET /mcp siguientes; un
  // disconnect lo saca. Así el VERIFY+RETRY de reconcileMcp ve el estado real (no reintenta los
  // que ya conectaron) — refleja al opencode vivo. `mcpStatus` es el estado INICIAL (pre-existente).
  const connected = new Map<string, { status?: string; config?: { url?: string } }>(
    Object.entries(mcpStatus),
  );
  return (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });
    const path = new URL(url).pathname;
    if (method === "POST" && path === "/session") return jsonRes({ id: "ses_1" });
    if (method === "GET" && path === "/mcp") return jsonRes(Object.fromEntries(connected));
    if (method === "POST" && path === "/mcp") {
      const name = (body as { name?: string })?.name ?? "";
      const fail = failConnect[name];
      if (fail) return jsonRes({ error: "boom" }, fail); // falla → NO queda connected → se reintenta
      connected.set(name, {
        status: "connected",
        config: { url: (body as { config?: { url?: string } })?.config?.url },
      });
      return jsonRes({ [name]: { status: "connected" } });
    }
    if (method === "POST" && /^\/mcp\/[^/]+\/disconnect$/.test(path)) {
      const name = path.split("/")[2] ?? "";
      connected.delete(name);
      return jsonRes({});
    }
    return jsonRes({ err: "unexpected" }, 404);
  }) as unknown as typeof fetch;
}

/** Helper: construye un AgentConfig con la forma MA (mcp_servers). Cast: el tipo real viene del
 *  SDK; lo que consume el código es sólo `mcp_servers`. */
function cfg(servers: Array<{ name: string; url: string }>): AgentConfig {
  return { mcp_servers: servers.map((s) => ({ type: "url", ...s })) } as unknown as AgentConfig;
}

function newClient(fetchImpl: typeof fetch, extra?: { mcpVerifyRounds?: number; mcpPaceMs?: number }) {
  return new HttpOpencodeClient({
    providerID: "local",
    modelID: "m",
    sleepImpl: noSleep,
    resolveBase: async () => "http://10.0.0.1:14420",
    fetchImpl,
    ...extra,
  });
}

describe("HttpOpencodeClient — agent + title (palancas de conducta y latencia)", () => {
  /** Captura los bodies de POST /session y prompt_async. */
  function capturing(calls: Call[]): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url, body });
      const path = new URL(url).pathname;
      if (method === "POST" && path === "/session") return jsonRes({ id: "ses_1" });
      if (method === "POST" && /prompt_async$/.test(path)) return jsonRes({});
      return jsonRes({ err: "unexpected" }, 404);
    }) as unknown as typeof fetch;
  }

  it("crea la sesión del coordinador con title NO-default y agent; el prompt lleva el mismo agent", async () => {
    const calls: Call[] = [];
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: noSleep,
      agent: "ceibo",
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl: capturing(calls),
    });
    await client.prompt("vm-demo", [{ type: "text", text: "hola" }]);
    const create = calls.find((c) => new URL(c.url).pathname === "/session");
    expect(create?.body).toMatchObject({ title: "ceibo · vm-demo", agent: "ceibo" });
    // el title NO matchea el default de opencode ("New session - <ISO>") → sin round-trip de título
    expect((create?.body as { title: string }).title).not.toMatch(/^(New|Child) session - /);
    const prompt = calls.find((c) => /prompt_async$/.test(new URL(c.url).pathname));
    expect((prompt?.body as { agent?: string }).agent).toBe("ceibo");
  });

  it("usa el modelo de coordinador para sesiones de chat y el modelo de worker para batch/sub-agentes", async () => {
    const calls: Call[] = [];
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "gemma4-31b",
      coordinatorModelID: "gemma4-coord",
      workerModelID: "gemma4-worker",
      sleepImpl: noSleep,
      agent: "ceibo",
      workerAgent: "ceibo-worker",
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl: capturing(calls),
    });

    await client.prompt("vm-chat", [{ type: "text", text: "hola" }]);
    await client.ensureSession("vm-rem", { role: "worker" });
    await client.prompt("vm-rem", [{ type: "text", text: "REM" }]);
    const workerSid = await client.openWorkerSession("vm-chat");
    await client.prompt(workerSid, [{ type: "text", text: "worker async" }]);

    const prompts = calls.filter((c) => /prompt_async$/.test(new URL(c.url).pathname));
    expect(prompts.map((p) => (p.body as { model: { modelID: string } }).model.modelID)).toEqual([
      "gemma4-coord",
      "gemma4-worker",
      "gemma4-worker",
    ]);
  });

  it("Qwen: apaga thinking en el coordinador y lo preserva en workers", async () => {
    const calls: Call[] = [];
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "qwen36-27b-fp8",
      sleepImpl: noSleep,
      agent: "ceibo",
      workerAgent: "ceibo-worker",
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl: capturing(calls),
    });

    await client.prompt("vm-chat", [{ type: "text", text: "hola" }]);
    const workerSid = await client.openWorkerSession("vm-chat");
    await client.prompt(workerSid, [{ type: "text", text: "worker async" }]);

    const prompts = calls.filter((c) => /prompt_async$/.test(new URL(c.url).pathname));
    expect(prompts.map((p) => (p.body as { options?: unknown }).options)).toEqual([
      { openai: { chat_template_kwargs: { enable_thinking: false } } },
      { openai: { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } } },
    ]);
  });

  it("Gemma: NO inyecta thinking kwargs (su chat template no los soporta → vLLM TemplateError)", async () => {
    const calls: Call[] = [];
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "gemma4-31b",
      sleepImpl: noSleep,
      agent: "ceibo",
      workerAgent: "ceibo-worker",
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl: capturing(calls),
    });

    await client.prompt("vm-chat", [{ type: "text", text: "hola" }]);
    const workerSid = await client.openWorkerSession("vm-chat");
    await client.prompt(workerSid, [{ type: "text", text: "worker async" }]);

    const prompts = calls.filter((c) => /prompt_async$/.test(new URL(c.url).pathname));
    // ni coordinador ni worker reciben `options` → el body del prompt no lleva la key.
    expect(prompts.map((p) => (p.body as { options?: unknown }).options)).toEqual([undefined, undefined]);
  });

  it("permite override explícito de provider options por rol", async () => {
    const calls: Call[] = [];
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "gemma4-31b",
      coordinatorOptions: { openai: { chat_template_kwargs: { enable_thinking: false, foo: "coord" } } },
      workerOptions: { openai: { chat_template_kwargs: { enable_thinking: true, foo: "worker" } } },
      sleepImpl: noSleep,
      agent: "ceibo",
      workerAgent: "ceibo-worker",
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl: capturing(calls),
    });

    await client.prompt("vm-chat", [{ type: "text", text: "hola" }]);
    const workerSid = await client.openWorkerSession("vm-chat");
    await client.prompt(workerSid, [{ type: "text", text: "worker async" }]);

    const prompts = calls.filter((c) => /prompt_async$/.test(new URL(c.url).pathname));
    expect(prompts.map((p) => (p.body as { options?: unknown }).options)).toEqual([
      { openai: { chat_template_kwargs: { enable_thinking: false, foo: "coord" } } },
      { openai: { chat_template_kwargs: { enable_thinking: true, foo: "worker" } } },
    ]);
  });

  it("un override localModel por sesión gana sobre el modelo por rol y puede cambiar provider", async () => {
    const calls: Call[] = [];
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "gemma4-31b",
      workerModelID: "gemma4-worker",
      sleepImpl: noSleep,
      agent: "ceibo",
      workerAgent: "ceibo-worker",
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl: capturing(calls),
    });

    await client.ensureSession("vm-rem", {
      role: "worker",
      model: { providerID: "anthropic-via-av", modelID: "claude-sonnet" },
    });
    await client.prompt("vm-rem", [{ type: "text", text: "REM" }]);

    const prompt = calls.find((c) => /prompt_async$/.test(new URL(c.url).pathname));
    expect((prompt?.body as { model: { providerID: string; modelID: string } }).model).toEqual({
      providerID: "anthropic-via-av",
      modelID: "claude-sonnet",
    });
  });

  it("la sesión de worker usa workerAgent (no el del coordinador) y su propio title", async () => {
    const calls: Call[] = [];
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: noSleep,
      agent: "ceibo",
      workerAgent: "ceibo-worker",
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl: capturing(calls),
    });
    const sid = await client.openWorkerSession("vm-demo");
    const create = calls.find((c) => new URL(c.url).pathname === "/session");
    expect(create?.body).toMatchObject({ title: "ceibo-worker · vm-demo", agent: "ceibo-worker" });
    await client.prompt(sid, [{ type: "text", text: "ejecutá" }]);
    const prompt = calls.find((c) => /prompt_async$/.test(new URL(c.url).pathname));
    expect((prompt?.body as { agent?: string }).agent).toBe("ceibo-worker");
  });

  it("sin agent configurado, el body no incluye `agent` (cae al default_agent de opencode)", async () => {
    const calls: Call[] = [];
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: noSleep,
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl: capturing(calls),
    });
    await client.prompt("vm-x", [{ type: "text", text: "hola" }]);
    const create = calls.find((c) => new URL(c.url).pathname === "/session");
    // title sí (siempre matamos el round-trip), agent no
    expect((create?.body as { title?: string }).title).toBe("ceibo · vm-x");
    expect((create?.body as Record<string, unknown>).agent).toBeUndefined();
    const prompt = calls.find((c) => /prompt_async$/.test(new URL(c.url).pathname));
    expect((prompt?.body as Record<string, unknown>).agent).toBeUndefined();
  });

  it("ensureSession con role 'worker' abre la sesión con workerAgent y promptea con él (REM/batch)", async () => {
    // Bug REM de prod: REM caía al agente coordinador (sin tools de archivos) y gemma loopeaba
    // `subagent_spawn` 40 min. Las sesiones batch piden role:"worker" → agente con tools completas.
    const calls: Call[] = [];
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: noSleep,
      agent: "ceibo",
      workerAgent: "ceibo-worker",
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl: capturing(calls),
    });
    await client.ensureSession("rem-demo-personal", { role: "worker" });
    const create = calls.find((c) => new URL(c.url).pathname === "/session");
    expect(create?.body).toMatchObject({ agent: "ceibo-worker" });
    // El rol queda pegado al binding: cada prompt de la sesión viaja con el agente worker.
    await client.prompt("rem-demo-personal", [{ type: "text", text: "ejecutá REM" }]);
    const prompt = calls.find((c) => /prompt_async$/.test(new URL(c.url).pathname));
    expect((prompt?.body as { agent?: string }).agent).toBe("ceibo-worker");
  });

  it("ensureSession con role 'worker' SIN workerAgent configurado cae al agent del coordinador", async () => {
    const calls: Call[] = [];
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: noSleep,
      agent: "ceibo",
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl: capturing(calls),
    });
    await client.ensureSession("rem-x", { role: "worker" });
    const create = calls.find((c) => new URL(c.url).pathname === "/session");
    expect((create?.body as { agent?: string }).agent).toBe("ceibo");
  });
});

describe("HttpOpencodeClient — setAgentConfig entrega MCP por el API /mcp (no session PATCH)", () => {
  it("POST /mcp por cada server deseado, con oauth:false; nunca usa session PATCH", async () => {
    const calls: Call[] = [];
    const client = newClient(routingFetch({ calls }));
    await client.setAgentConfig(
      "vm1",
      cfg([
        { name: "gmail", url: "https://gmail/x" },
        { name: "drive", url: "https://drive/x" },
      ]),
    );
    // ningún PATCH de sesión
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    const posts = calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/mcp");
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => (p.body as { name: string }).name).sort()).toEqual(["drive", "gmail"]);
    for (const p of posts) {
      expect((p.body as { config: { oauth: unknown; type: string; enabled: boolean } }).config).toMatchObject(
        {
          type: "remote",
          enabled: true,
          oauth: false,
        },
      );
    }
  });

  it("saltea los que ya están connected con la misma url (idempotente)", async () => {
    const calls: Call[] = [];
    const client = newClient(
      routingFetch({
        calls,
        mcpStatus: { gmail: { status: "connected", config: { url: "https://gmail/x" } } },
      }),
    );
    await client.setAgentConfig(
      "vm1",
      cfg([
        { name: "gmail", url: "https://gmail/x" }, // ya connected, misma url → skip
        { name: "drive", url: "https://drive/x" }, // nuevo → connect
      ]),
    );
    const posts = calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/mcp");
    expect(posts.map((p) => (p.body as { name: string }).name)).toEqual(["drive"]);
    // gmail no se desconecta ni reconecta
    expect(calls.some((c) => c.url.includes("/mcp/gmail/disconnect"))).toBe(false);
  });

  it("reconecta (disconnect + POST) si la url cambió", async () => {
    const calls: Call[] = [];
    const client = newClient(
      routingFetch({
        calls,
        mcpStatus: { gmail: { status: "connected", config: { url: "https://gmail/OLD" } } },
      }),
    );
    await client.setAgentConfig("vm1", cfg([{ name: "gmail", url: "https://gmail/NEW" }]));
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/mcp/gmail/disconnect"))).toBe(true);
    const post = calls.find((c) => c.method === "POST" && new URL(c.url).pathname === "/mcp");
    expect((post?.body as { config: { url: string } }).config.url).toBe("https://gmail/NEW");
  });

  it("desconecta los MCP actuales que ya no se desean (revocados)", async () => {
    const calls: Call[] = [];
    const client = newClient(
      routingFetch({
        calls,
        mcpStatus: {
          gmail: { status: "connected", config: { url: "https://gmail/x" } },
          stale: { status: "connected", config: { url: "https://stale/x" } },
        },
      }),
    );
    await client.setAgentConfig("vm1", cfg([{ name: "gmail", url: "https://gmail/x" }]));
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/mcp/stale/disconnect"))).toBe(true);
    // gmail (deseado y ya connected) NO se desconecta
    expect(calls.some((c) => c.url.endsWith("/mcp/gmail/disconnect"))).toBe(false);
  });

  it("tolera el fallo de UN server (loguea y sigue con el resto)", async () => {
    const calls: Call[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // mcpVerifyRounds:0 → testeamos SÓLO la tolerancia del connect inicial (el verify-retry tiene
    // su propio test); sin esto, gmail (que falla) se reintentaría y el conteo de POSTs cambiaría.
    const client = newClient(routingFetch({ calls, failConnect: { gmail: 500 } }), { mcpVerifyRounds: 0 });
    await client.setAgentConfig(
      "vm1",
      cfg([
        { name: "gmail", url: "https://gmail/x" }, // falla
        { name: "drive", url: "https://drive/x" }, // igual se intenta
      ]),
    );
    const posts = calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/mcp");
    expect(posts.map((p) => (p.body as { name: string }).name).sort()).toEqual(["drive", "gmail"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("VERIFY+RETRY: reintenta los MCP que quedan `failed` tras el POST hasta que conectan", async () => {
    const calls: Call[] = [];
    // tavily: el POST devuelve 200 pero el server NO queda connected (el SSE falla async); recién
    // tras el 2º POST conecta. Reproduce el incidente del thundering herd / SSE flaky del AV.
    let tavilyPosts = 0;
    const connected = new Map<string, { status: string }>();
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url, body });
      const path = new URL(url).pathname;
      if (method === "POST" && path === "/session") return jsonRes({ id: "ses_1" });
      if (method === "GET" && path === "/mcp") return jsonRes(Object.fromEntries(connected));
      if (method === "POST" && path === "/mcp") {
        const name = (body as { name?: string })?.name ?? "";
        if (name === "tavily") {
          tavilyPosts++;
          if (tavilyPosts >= 2) connected.set("tavily", { status: "connected" });
        } else connected.set(name, { status: "connected" });
        return jsonRes({ [name]: { status: "connected" } });
      }
      if (method === "POST" && /\/disconnect$/.test(path)) {
        connected.delete(path.split("/")[2] ?? "");
        return jsonRes({});
      }
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const client = newClient(fetchImpl);
    await client.setAgentConfig(
      "vm1",
      cfg([
        { name: "viewer", url: "https://v/x" },
        { name: "tavily", url: "https://t/x" },
      ]),
    );
    // tavily se POSTeó ≥2 veces (inicial + retry del verify) y terminó connected
    expect(tavilyPosts).toBeGreaterThanOrEqual(2);
    expect(connected.has("tavily")).toBe(true);
    // viewer conectó al primer intento → el verify NO lo reintenta (un solo POST)
    const viewerPosts = calls.filter(
      (c) =>
        c.method === "POST" &&
        new URL(c.url).pathname === "/mcp" &&
        (c.body as { name?: string })?.name === "viewer",
    );
    expect(viewerPosts.length).toBe(1);
  });

  it("tolera un throw de red en POST /mcp (no tira abajo el setAgentConfig)", async () => {
    const calls: Call[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url });
      const path = new URL(url).pathname;
      if (method === "POST" && path === "/session") return jsonRes({ id: "ses_1" });
      if (method === "GET" && path === "/mcp") return jsonRes({});
      if (method === "POST" && path === "/mcp") throw new Error("ECONNRESET");
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const client = newClient(fetchImpl);
    // no rechaza pese al throw del POST /mcp
    await expect(
      client.setAgentConfig("vm1", cfg([{ name: "gmail", url: "https://gmail/x" }])),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("tolera fallo del disconnect (non-ok y throw): loguea y sigue", async () => {
    const calls: Call[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url });
      const path = new URL(url).pathname;
      if (method === "POST" && path === "/session") return jsonRes({ id: "ses_1" });
      if (method === "GET" && path === "/mcp") {
        return jsonRes({
          revoked_a: { status: "connected", config: { url: "https://a/x" } },
          revoked_b: { status: "connected", config: { url: "https://b/x" } },
        });
      }
      // uno responde non-ok, el otro tira un throw de red
      if (path === "/mcp/revoked_a/disconnect") return jsonRes({ err: "nope" }, 500);
      if (path === "/mcp/revoked_b/disconnect") throw new Error("ECONNRESET");
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const client = newClient(fetchImpl);
    // deseado vacío → ambos actuales se intentan desconectar; ningún fallo propaga
    await expect(client.setAgentConfig("vm1", cfg([]))).resolves.toBeUndefined();
    expect(calls.some((c) => c.url.endsWith("/mcp/revoked_a/disconnect"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/mcp/revoked_b/disconnect"))).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("propaga un fallo total del GET /mcp (no reconcilia a ciegas)", async () => {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url });
      const path = new URL(url).pathname;
      if (method === "POST" && path === "/session") return jsonRes({ id: "ses_1" });
      if (method === "GET" && path === "/mcp") return jsonRes({ err: "down" }, 500);
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const client = newClient(fetchImpl);
    await expect(
      client.setAgentConfig("vm1", cfg([{ name: "gmail", url: "https://gmail/x" }])),
    ).rejects.toThrow(/GET \/mcp 500/);
  });
});

// --- Bug D: el MITM del AV rate-limita ~10 req/40s por agente → pacing + retry de 429 ----------

/** Registra cada sleep (ms) en vez de dormir: visibiliza pacing y backoff sin demorar el test. */
function sleepRecorder(): { sleeps: number[]; sleepImpl: (ms: number) => Promise<void> } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleepImpl: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

describe("HttpOpencodeClient — rate-limit del AV (bug D): connect paralelo acotado + retry de 429", () => {
  it("conecta los MCP en PARALELO acotado (sin pacing serial entre connects)", async () => {
    const calls: Call[] = [];
    const { sleeps, sleepImpl } = sleepRecorder();
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl,
      mcpVerifyRounds: 0, // estos tests aíslan el retry de connectMcp; el verify tiene su propio test
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl: routingFetch({ calls }),
    });
    await client.setAgentConfig(
      "vm1",
      cfg([
        { name: "gmail", url: "https://gmail/x" },
        { name: "drive", url: "https://drive/x" },
        { name: "sheets", url: "https://sheets/x" },
      ]),
    );
    const posts = calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/mcp");
    // los 3 se conectan (orden no garantizado bajo paralelismo) y SIN pacing entre connects.
    expect(posts.map((p) => (p.body as { name: string }).name).sort()).toEqual(["drive", "gmail", "sheets"]);
    expect(sleeps).toEqual([]);
  });

  it("los servers ya conectados (idempotentes) NO pagan pacing", async () => {
    const calls: Call[] = [];
    const { sleeps, sleepImpl } = sleepRecorder();
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl,
      mcpPaceMs: 1500,
      mcpVerifyRounds: 0, // estos tests aíslan el retry de connectMcp; el verify tiene su propio test
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl: routingFetch({
        calls,
        mcpStatus: { gmail: { status: "connected", config: { url: "https://gmail/x" } } },
      }),
    });
    await client.setAgentConfig(
      "vm1",
      cfg([
        { name: "gmail", url: "https://gmail/x" }, // ya connected → skip, sin pacing
        { name: "drive", url: "https://drive/x" }, // 1er connect real → sin pacing previo
      ]),
    );
    const posts = calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/mcp");
    expect(posts.map((p) => (p.body as { name: string }).name)).toEqual(["drive"]);
    expect(sleeps).toEqual([]); // un único connect real → cero esperas
  });

  it("429 con Retry-After: espera lo que pide el header y reintenta ESE server", async () => {
    const calls: Call[] = [];
    const { sleeps, sleepImpl } = sleepRecorder();
    let gmailTries = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url, body });
      const path = new URL(url).pathname;
      if (method === "POST" && path === "/session") return jsonRes({ id: "ses_1" });
      if (method === "GET" && path === "/mcp") return jsonRes({});
      if (method === "POST" && path === "/mcp") {
        if ((body as { name?: string })?.name === "gmail" && ++gmailTries === 1) {
          // header real medido del MITM del AV: Retry-After en segundos
          return jsonRes({ err: "rate limited" }, 429, { "retry-after": "7" });
        }
        return jsonRes({ ok: true });
      }
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl,
      mcpPaceMs: 0, // sin pacing: aislamos el backoff del 429
      mcpVerifyRounds: 0, // estos tests aíslan el retry de connectMcp; el verify tiene su propio test
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl,
    });
    await client.setAgentConfig("vm1", cfg([{ name: "gmail", url: "https://gmail/x" }]));
    expect(gmailTries).toBe(2); // 429 → retry → ok
    expect(sleeps).toEqual([7000]); // honró Retry-After (7s)
  });

  it("429 sin Retry-After: backoff default de 40s (la ventana medida del límite)", async () => {
    const { sleeps, sleepImpl } = sleepRecorder();
    let tries = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url).pathname;
      if (method === "POST" && path === "/session") return jsonRes({ id: "ses_1" });
      if (method === "GET" && path === "/mcp") return jsonRes({});
      if (method === "POST" && path === "/mcp") {
        return ++tries === 1 ? jsonRes({ err: "rl" }, 429) : jsonRes({ ok: true });
      }
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl,
      mcpPaceMs: 0,
      mcpVerifyRounds: 0, // estos tests aíslan el retry de connectMcp; el verify tiene su propio test
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl,
    });
    await client.setAgentConfig("vm1", cfg([{ name: "gmail", url: "https://gmail/x" }]));
    expect(tries).toBe(2);
    expect(sleeps).toEqual([40_000]);
  });

  it("429 persistente: hasta 2 reintentos, lo marca fallido con log claro y SIGUE con el resto", async () => {
    const calls: Call[] = [];
    const { sleeps, sleepImpl } = sleepRecorder();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url, body });
      const path = new URL(url).pathname;
      if (method === "POST" && path === "/session") return jsonRes({ id: "ses_1" });
      if (method === "GET" && path === "/mcp") return jsonRes({});
      if (method === "POST" && path === "/mcp") {
        if ((body as { name?: string })?.name === "gmail")
          return jsonRes({ err: "rl" }, 429, { "retry-after": "40" });
        return jsonRes({ ok: true });
      }
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl,
      mcpPaceMs: 1500,
      mcpVerifyRounds: 0, // estos tests aíslan el retry de connectMcp; el verify tiene su propio test
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl,
    });
    await client.setAgentConfig(
      "vm1",
      cfg([
        { name: "gmail", url: "https://gmail/x" }, // 429 eterno → 3 intentos y fallido
        { name: "drive", url: "https://drive/x" }, // igual se conecta
      ]),
    );
    const posts = calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/mcp");
    expect(posts.filter((p) => (p.body as { name: string }).name === "gmail")).toHaveLength(3);
    expect(posts.filter((p) => (p.body as { name: string }).name === "drive")).toHaveLength(1);
    // 2 backoffs de 40s (gmail, retry interno de connectMcp); SIN pacing serial entre connects.
    expect(sleeps).toEqual([40_000, 40_000]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/gmail 429/));
    warn.mockRestore();
  });
});

// --- Bug E: el bus /event es GLOBAL por VM → filtrado ESTRICTO por sesión + abort real ----------

/** Body SSE con un `data:` por evento. `hold` deja el stream abierto (para probar el abort). */
function sseRes(
  events: unknown[],
  opts?: { hold?: boolean; onCancel?: () => void; signal?: AbortSignal },
): Response {
  const enc = new TextEncoder();
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
      for (const ev of events) c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      if (!opts?.hold) c.close();
    },
    cancel() {
      opts?.onCancel?.();
    },
  });
  // Emula el fetch real: abortar el signal corta el stream en vuelo (el read() pendiente falla).
  opts?.signal?.addEventListener("abort", () => {
    try {
      ctl.error(new Error("aborted"));
    } catch {
      /* ya cerrado */
    }
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

/** Bus con eventos INTERLEAVED de dos sesiones (coordinador ses_1, worker ses_2) en TODAS las
 *  formas reales: sessionID top-level (idle), en part (text/step-finish), en info (message) y
 *  como info.id en eventos session.* — más un evento global sin atribución. */
function twoSessionBus(): unknown[] {
  return [
    { type: "server.connected", properties: {} }, // global sin sesión → NADIE lo traduce
    { type: "message.updated", properties: { info: { id: "m1", sessionID: "ses_1", role: "assistant" } } },
    { type: "message.updated", properties: { info: { id: "w1", sessionID: "ses_2", role: "assistant" } } },
    {
      type: "message.part.updated",
      properties: {
        part: { type: "text", sessionID: "ses_1", messageID: "m1", id: "p1", text: "hola del coordinador" },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: { type: "text", sessionID: "ses_2", messageID: "w1", id: "p2", text: "laburo del worker" },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: { type: "step-finish", sessionID: "ses_1", messageID: "m1", tokens: { input: 10, output: 5 } },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          sessionID: "ses_2",
          messageID: "w1",
          tokens: { input: 999, output: 99 },
        },
      },
    },
    { type: "session.idle", properties: { sessionID: "ses_1" } },
    { type: "session.idle", properties: { sessionID: "ses_2" } },
    { type: "session.deleted", properties: { info: { id: "ses_2" } } },
  ];
}

describe("HttpOpencodeClient — events(): filtrado ESTRICTO por sesión del bus global", () => {
  function busClient(events: unknown[]) {
    let seq = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url).pathname;
      if (method === "POST" && path === "/session") return jsonRes({ id: `ses_${++seq}` });
      if (method === "GET" && path === "/event") return sseRes(events, { signal: init?.signal ?? undefined });
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    return new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: noSleep,
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl,
    });
  }

  it("cada sesión recibe SOLO sus eventos (part/info/top-level); los sin atribución se descartan", async () => {
    const client = busClient(twoSessionBus());
    await client.ensureSession("vm1"); // → ses_1 (coordinador)
    const workerSid = await client.openWorkerSession("vm1"); // → ses_2 (worker, misma VM)

    const coord: OpencodeEvent[] = [];
    for await (const ev of client.events("vm1")) coord.push(ev);
    const worker: OpencodeEvent[] = [];
    for await (const ev of client.events(workerSid)) worker.push(ev);

    // Coordinador: SOLO ses_1 — ni el texto/usage del worker ni el server.connected sin sesión.
    expect(coord.map((e) => e.type)).toEqual([
      "message.updated",
      "message.part.updated",
      "message.part.updated",
      "session.idle",
    ]);
    expect(JSON.stringify(coord)).not.toContain("ses_2");
    expect(JSON.stringify(coord)).not.toContain("laburo del worker");
    expect(JSON.stringify(coord)).not.toContain("999"); // el step-finish del worker NO cruza

    // Worker: SOLO ses_2 — incluido el session.deleted (info.id = id de sesión en session.*).
    expect(worker.map((e) => e.type)).toEqual([
      "message.updated",
      "message.part.updated",
      "message.part.updated",
      "session.idle",
      "session.deleted",
    ]);
    expect(JSON.stringify(worker)).not.toContain("hola del coordinador");
  });

  it("belongsToSession: estricto — sin atribución reconocible NO pertenece", () => {
    expect(belongsToSession({ type: "session.idle", properties: { sessionID: "s1" } }, "s1")).toBe(true);
    expect(belongsToSession({ type: "session.idle", properties: { sessionID: "s2" } }, "s1")).toBe(false);
    expect(
      belongsToSession(
        { type: "message.part.updated", properties: { part: { type: "text", sessionID: "s1" } } },
        "s1",
      ),
    ).toBe(true);
    expect(
      belongsToSession(
        { type: "message.updated", properties: { info: { id: "m9", sessionID: "s1" } } },
        "s1",
      ),
    ).toBe(true);
    // en message.* el info.id es el id del MENSAJE, no de la sesión → no matchea por id
    expect(belongsToSession({ type: "message.updated", properties: { info: { id: "s1" } } }, "s1")).toBe(
      false,
    );
    // en session.* el info ES la sesión → info.id sí identifica
    expect(belongsToSession({ type: "session.deleted", properties: { info: { id: "s1" } } }, "s1")).toBe(
      true,
    );
    expect(belongsToSession({ type: "server.connected", properties: {} }, "s1")).toBe(false);
    expect(belongsToSession({ type: "server.connected" }, "s1")).toBe(false);
  });

  it("el signal ABORTA el stream en vuelo (close() del relay corta de verdad, no sólo un flag)", async () => {
    let cancelled = 0;
    let seq = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url).pathname;
      if (method === "POST" && path === "/session") return jsonRes({ id: `ses_${++seq}` });
      if (method === "GET" && path === "/event") {
        return sseRes([{ type: "session.idle", properties: { sessionID: "ses_1" } }], {
          hold: true, // el bus queda abierto (como el SSE real): sin abort, el read() pendiente no vuelve
          onCancel: () => cancelled++,
          signal: init?.signal ?? undefined,
        });
      }
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: noSleep,
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl,
    });

    const aborter = new AbortController();
    const got: string[] = [];
    const consumed = (async () => {
      for await (const ev of client.events("vm1", { signal: aborter.signal })) got.push(ev.type);
    })();
    // dejá que el primer evento fluya, después abortá: la iteración tiene que TERMINAR (throw).
    await new Promise((r) => setTimeout(r, 5));
    aborter.abort();
    await expect(consumed).rejects.toThrow();
    expect(got).toEqual(["session.idle"]);
  });
});

// --- Incidente 2026-06-10: el SSE muere SIN error tras un reboot del host (socket zombie) -------

describe("HttpOpencodeClient — watchdog de inactividad del stream (cuelgue silencioso)", () => {
  /** Cliente cuyo /event devuelve un stream que emite `events` y después queda MUDO (como el
   *  socket zombie del incidente: el TCP murió sin FIN/RST y el read() nunca vuelve). */
  function silentBusClient(events: unknown[], idleTimeoutMs: number) {
    let seq = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url).pathname;
      if (method === "POST" && path === "/session") return jsonRes({ id: `ses_${++seq}` });
      if (method === "GET" && path === "/event") {
        return sseRes(events, { hold: true, signal: init?.signal ?? undefined });
      }
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    return new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: noSleep,
      idleTimeoutMs,
      resolveBase: async () => "http://10.0.0.1:14420",
      fetchImpl,
    });
  }

  it("stream mudo más de idleTimeoutMs → corta con StreamIdleError (el pump puede reconectar)", async () => {
    const client = silentBusClient(
      [{ type: "session.idle", properties: { sessionID: "ses_1" } }],
      30, // watchdog cortito para el test
    );
    const got: string[] = [];
    const consumed = (async () => {
      for await (const ev of client.events("vm1")) got.push(ev.type);
    })();
    await expect(consumed).rejects.toThrow(StreamIdleError);
    expect(got).toEqual(["session.idle"]); // lo que llegó ANTES del silencio sí se tradujo
  });

  it("idleTimeoutMs ≤ 0 desactiva el watchdog (el stream mudo NO se corta solo)", async () => {
    const client = silentBusClient([{ type: "session.idle", properties: { sessionID: "ses_1" } }], 0);
    const got: string[] = [];
    let settled = false;
    const consumed = (async () => {
      for await (const ev of client.events("vm1")) got.push(ev.type);
    })().finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(settled).toBe(false); // sigue esperando (comportamiento pre-watchdog)
    expect(got).toEqual(["session.idle"]);
    void consumed.catch(() => {}); // el test termina; el stream queda para el GC
  });

  it("el abort del CONSUMIDOR (close del relay) NO se re-tipa como StreamIdleError", async () => {
    const client = silentBusClient([{ type: "session.idle", properties: { sessionID: "ses_1" } }], 10_000);
    const aborter = new AbortController();
    const consumed = (async () => {
      for await (const _ of client.events("vm1", { signal: aborter.signal })) {
        /* drena */
      }
    })();
    await new Promise((r) => setTimeout(r, 5));
    aborter.abort();
    await expect(consumed).rejects.toThrow();
    await expect(consumed).rejects.not.toThrow(StreamIdleError);
  });
});

describe("HttpOpencodeClient — recover(): recuperación activa tras cortes del stream", () => {
  /** Cliente con base re-resoluble y GET /session/{ses} controlable por el test. */
  function recoverClient(opts: {
    bases: string[]; // lo que devuelve resolveBase en cada llamada (la IP puede cambiar)
    sessionStatus: number; // status del GET /session/{ses} en la base nueva
    resolveThrows?: boolean;
  }) {
    let baseIdx = 0;
    let seq = 0;
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const u = new URL(url);
      calls.push(`${method} ${u.host}${u.pathname}`);
      if (method === "POST" && u.pathname === "/session") return jsonRes({ id: `ses_${++seq}` });
      if (method === "POST" && /prompt_async$/.test(u.pathname)) return jsonRes({});
      if (method === "GET" && u.pathname.startsWith("/session/")) {
        return jsonRes(opts.sessionStatus === 200 ? { id: "ses_1" } : {}, opts.sessionStatus);
      }
      if (method === "GET" && u.pathname === "/event")
        return sseRes([], { hold: true, signal: init?.signal ?? undefined });
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: noSleep,
      resolveBase: async () => {
        if (opts.resolveThrows) throw new Error("cp.sh serve vm1 exit 1: serve no respondió");
        const b = opts.bases[Math.min(baseIdx, opts.bases.length - 1)] ?? "";
        baseIdx++;
        return b;
      },
      fetchImpl,
    });
    return { client, calls };
  }

  it("sesión viva en una base NUEVA (la IP cambió con el reboot) → 'rebound' y el binding re-apunta", async () => {
    const { client, calls } = recoverClient({
      bases: ["http://10.0.0.1:14420", "http://10.0.0.9:14420"],
      sessionStatus: 200,
    });
    await client.ensureSession("vm1"); // binding inicial en 10.0.0.1
    await expect(client.recover("vm1")).resolves.toBe("rebound");
    // El chequeo de la sesión fue contra la base NUEVA…
    expect(calls).toContain("GET 10.0.0.9:14420/session/ses_1");
    // …y el binding quedó re-apuntado: el próximo prompt va a la base nueva con la MISMA sesión.
    await client.prompt("vm1", [{ type: "text", text: "hola" }]);
    expect(calls).toContain("POST 10.0.0.9:14420/session/ses_1/prompt_async");
  });

  it("la sesión ya no existe (404: el reboot la borró) → 'session-lost' e invalida el binding", async () => {
    const { client, calls } = recoverClient({
      bases: ["http://10.0.0.1:14420"],
      sessionStatus: 404,
    });
    await client.ensureSession("vm1");
    await expect(client.recover("vm1")).resolves.toBe("session-lost");
    // Binding invalidado: el próximo ensure abre una sesión opencode FRESCA (otro POST /session).
    await client.ensureSession("vm1");
    expect(calls.filter((c) => c === "POST 10.0.0.1:14420/session")).toHaveLength(2);
  });

  it("la VM/serve no responden todavía (resolveBase falla) → 'unreachable' (seguir con backoff)", async () => {
    const { client } = recoverClient({ bases: [], sessionStatus: 200, resolveThrows: true });
    // sin binding previo no hay nada que recuperar → rebound (el ensure abre de cero)
    await expect(client.recover("vm-x")).resolves.toBe("rebound");
  });

  it("resolveBase falla CON binding previo → 'unreachable' (conserva el binding para reintentar)", async () => {
    const { client } = recoverClient({
      bases: ["http://10.0.0.1:14420"],
      sessionStatus: 200,
    });
    await client.ensureSession("vm1");
    // a partir de acá la box no responde
    (client as unknown as { cfg: { resolveBase: () => Promise<string> } }).cfg.resolveBase = async () => {
      throw new Error("ssh timeout");
    };
    await expect(client.recover("vm1")).resolves.toBe("unreachable");
  });

  it("recover de un worker resuelve la base por el nombre de la VM (no el id lógico)", async () => {
    const resolved: string[] = [];
    let seq = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url).pathname;
      if (method === "POST" && path === "/session") return jsonRes({ id: `ses_${++seq}` });
      if (method === "GET" && path.startsWith("/session/")) return jsonRes({ id: "ses_1" });
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const client = new HttpOpencodeClient({
      providerID: "local",
      modelID: "m",
      sleepImpl: noSleep,
      resolveBase: async (name) => {
        resolved.push(name);
        return "http://10.0.0.1:14420";
      },
      fetchImpl,
    });
    const workerSid = await client.openWorkerSession("vm1");
    await expect(client.recover(workerSid)).resolves.toBe("rebound");
    expect(resolved.every((n) => n === "vm1")).toBe(true); // nunca el id lógico `vm1#worker:…`
  });
});
