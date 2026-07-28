import { describe, expect, it, vi } from "vitest";
import {
  apiErrorMessage,
  attach,
  type InboundMedia,
  isInternalDetail,
  publicErrorReason,
  type Sink,
} from "./index.ts";

// Sink de prueba: los spies se exponen aparte (tipados como Mock) para inspeccionarlos.
function makeSink() {
  const spies = {
    message: vi.fn(),
    activity: vi.fn(),
    status: vi.fn(),
    error: vi.fn(),
    dead: vi.fn(),
    turnComplete: vi.fn(),
  };
  return { sink: spies as unknown as Sink, spies };
}

// Fake del client de sesiones: stream emite `events` (terminado para que el pump corte),
// send acumula, retrieve devuelve el usage para el reporte de turno.
function fakeClient(events: unknown[] = [{ type: "session.status_terminated" }]) {
  const sent: { id: string; body: { events: unknown[] } }[] = [];
  const client = {
    beta: {
      sessions: {
        retrieve: async () => ({
          status: "idle",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
          agent: { model: { id: "claude-x" } },
        }),
        events: {
          stream: async () =>
            (async function* () {
              for (const e of events) yield e;
            })(),
          send: async (id: string, body: { events: unknown[] }) => {
            sent.push({ id, body });
          },
        },
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: stub estructural
  } as any;
  return { client, sent };
}

describe("attach — ingress (send/interrupt)", () => {
  it("send con texto solo → un user.message con un bloque de texto", async () => {
    const { client, sent } = fakeClient();
    const relay = attach(client, "s1", makeSink().sink);
    await relay.send("hola");
    relay.close();
    expect(sent[0]?.body.events).toEqual([
      { type: "user.message", content: [{ type: "text", text: "hola" }] },
    ]);
  });

  it("send con imagen → bloque image (source base64) ANTES del texto", async () => {
    const { client, sent } = fakeClient();
    const relay = attach(client, "s1", makeSink().sink);
    const media: InboundMedia[] = [{ kind: "image", data: "B64", mediaType: "image/png" }];
    await relay.send("mirá", media);
    relay.close();
    const content = sent[0]?.body.events[0] as { content: Record<string, unknown>[] };
    expect(content.content[0]).toEqual({
      type: "image",
      source: { type: "base64", data: "B64", media_type: "image/png" },
    });
    expect(content.content[1]).toEqual({ type: "text", text: "mirá" });
  });

  it("send con PDF → bloque document con title; sin texto no agrega bloque de texto", async () => {
    const { client, sent } = fakeClient();
    const relay = attach(client, "s1", makeSink().sink);
    const media: InboundMedia[] = [
      { kind: "document", data: "PDF64", mediaType: "application/pdf", filename: "f.pdf" },
    ];
    await relay.send("", media);
    relay.close();
    const content = (sent[0]?.body.events[0] as { content: Record<string, unknown>[] }).content;
    expect(content).toEqual([
      {
        type: "document",
        source: { type: "base64", data: "PDF64", media_type: "application/pdf" },
        title: "f.pdf",
      },
    ]);
  });

  it("interrupt → user.interrupt", async () => {
    const { client, sent } = fakeClient();
    const relay = attach(client, "s1", makeSink().sink);
    await relay.interrupt();
    relay.close();
    expect(sent[0]?.body.events).toEqual([{ type: "user.interrupt" }]);
  });
});

describe("attach — egress (dispatch de eventos del stream)", () => {
  it("agent.message → sink.message con el texto de cada bloque", async () => {
    const { sink, spies } = makeSink();
    const { client } = fakeClient([
      { type: "agent.message", content: [{ type: "text", text: "respuesta" }] },
      { type: "session.status_terminated" },
    ]);
    attach(client, "s1", sink);
    await vi.waitFor(() => expect(spies.dead).toHaveBeenCalled());
    expect(spies.message).toHaveBeenCalledWith("respuesta");
  });

  it("tool_use → sink.activity con el nombre y el input de la tool", async () => {
    const { sink, spies } = makeSink();
    const { client } = fakeClient([
      { type: "agent.tool_use", name: "bash", input: { command: "git status" } },
      { type: "session.status_terminated" },
    ]);
    attach(client, "s1", sink);
    await vi.waitFor(() => expect(spies.dead).toHaveBeenCalled());
    expect(spies.activity).toHaveBeenCalledWith("bash", { command: "git status" });
  });

  it("status_idle end_turn → reporta el turno con usage acumulado y model", async () => {
    const { sink, spies } = makeSink();
    const { client } = fakeClient([
      { type: "session.status_idle", stop_reason: { type: "end_turn" } },
      { type: "session.status_terminated" },
    ]);
    attach(client, "s1", sink);
    await vi.waitFor(() => expect(spies.turnComplete).toHaveBeenCalled());
    const [usage, model] = spies.turnComplete.mock.calls[0] as [Record<string, number>, string];
    expect(usage).toMatchObject({ input: 10, output: 5, cacheRead: 2 });
    expect(model).toBe("claude-x");
  });

  it("status_terminated → status + dead (el pump corta)", async () => {
    const { sink, spies } = makeSink();
    const { client } = fakeClient([{ type: "session.status_terminated" }]);
    attach(client, "s1", sink);
    await vi.waitFor(() => expect(spies.dead).toHaveBeenCalled());
    expect(spies.status).toHaveBeenCalledWith("[sesión terminada]");
  });

  // El caso real que colgaba mudo: la workspace topó su límite de uso → MA emite un session.error
  // (billing_error, retry_status exhausted) seguido de un status_idle (retries_exhausted). Antes:
  // el error iba a `status` (log-only) y el turno nunca cerraba (busy congelado). Ahora: el error
  // llega a `sink.error` con un texto legible/accionable Y el turno cierra (turnComplete).
  it("session.error billing (usage-limit) → sink.error con texto accionable; el turno NO cuelga", async () => {
    const { sink, spies } = makeSink();
    const { client } = fakeClient([
      {
        type: "session.error",
        error: {
          type: "billing_error",
          message:
            "You have reached your specified workspace API usage limits. You will regain access on 2026-07-01 at 00:00 UTC.",
          retry_status: { type: "exhausted" },
        },
      },
      { type: "session.status_idle", stop_reason: { type: "retries_exhausted" } },
      { type: "session.status_terminated" },
    ]);
    attach(client, "s1", sink);
    await vi.waitFor(() => expect(spies.dead).toHaveBeenCalled());
    // El usuario VE el error (no se traga en status).
    expect(spies.error).toHaveBeenCalledTimes(1);
    const shown = spies.error.mock.calls[0]?.[0] as string;
    expect(shown).toContain("límite de uso de la workspace de Anthropic");
    expect(shown).toContain("2026-07-01"); // el detalle accionable de la API
    expect(shown).not.toContain("undefined");
    // Y el turno CIERRA (retries_exhausted dispara turnComplete) → no queda colgado.
    expect(spies.turnComplete).toHaveBeenCalledTimes(1);
  });

  // Un error que el server está REINTENTANDO solo no debe molestar al usuario (sólo log/status).
  it("session.error con retry_status 'retrying' → status, NO sink.error", async () => {
    const { sink, spies } = makeSink();
    const { client } = fakeClient([
      {
        type: "session.error",
        error: { type: "model_overloaded_error", message: "overloaded", retry_status: { type: "retrying" } },
      },
      { type: "session.status_terminated" },
    ]);
    attach(client, "s1", sink);
    await vi.waitFor(() => expect(spies.dead).toHaveBeenCalled());
    expect(spies.error).not.toHaveBeenCalled();
    expect(spies.status).toHaveBeenCalled();
  });

  // Un error de UN servidor MCP puntual: el agente sigue el turno → sólo log (status), no error.
  it("session.error de un MCP → status (preserva el nombre del server), NO sink.error", async () => {
    const { sink, spies } = makeSink();
    const { client } = fakeClient([
      {
        type: "session.error",
        error: {
          type: "mcp_connection_failed_error",
          mcp_server_name: "gmail",
          message: "connection refused",
          retry_status: { type: "exhausted" },
        },
      },
      { type: "session.status_terminated" },
    ]);
    attach(client, "s1", sink);
    await vi.waitFor(() => expect(spies.dead).toHaveBeenCalled());
    expect(spies.error).not.toHaveBeenCalled();
    expect(spies.status).toHaveBeenCalledWith(expect.stringContaining("gmail"));
  });
});

describe("apiErrorMessage", () => {
  it("billing_error → nota accionable de límite de uso + el message de la API", () => {
    const out = apiErrorMessage(
      "You have reached your specified workspace API usage limits.",
      "billing_error",
    );
    expect(out).toContain("límite de uso de la workspace");
    expect(out).toContain("subir el límite");
    expect(out).toContain("workspace API usage limits");
  });

  it("detecta el usage-limit por el texto aunque no venga el type", () => {
    const out = apiErrorMessage("Your credit balance is too low to access the Anthropic API.");
    expect(out).toContain("límite de uso de la workspace");
  });

  it("error genérico → mensaje limpio con el texto de la API (sin stack traces)", () => {
    const out = apiErrorMessage(new Error("invalid_request_error: something"));
    expect(out).toBe("⚠️ Error de la API de Anthropic: invalid_request_error: something");
  });

  it("extrae el message del body de un APIError del SDK", () => {
    const apiErr = { status: 400, error: { error: { message: "bad model" } } };
    expect(apiErrorMessage(apiErr)).toBe("⚠️ Error de la API de Anthropic: bad model");
  });

  it("origin 'local' → NO menciona Anthropic NI adjunta el detalle crudo (interna)", () => {
    const out = apiErrorMessage(
      new Error(
        "opencode POST /session 502: cp.sh serve archima-ceibo-demo-env_013CMPP exit 1: serve no respondió",
      ),
      undefined,
      "local",
    );
    expect(out).not.toContain("Anthropic");
    expect(out).toContain("entorno local");
    // NADA de interna al usuario (incidente 2026-06-10): ni VM, ni env id, ni cp.sh, ni stdout.
    expect(out).not.toContain("archima");
    expect(out).not.toContain("env_013");
    expect(out).not.toContain("cp.sh");
    expect(out).not.toContain("exit 1");
    expect(out).toContain("Probá de nuevo");
  });

  it("origin 'local' con error de cold-start → frase de 'entorno despertando', sin conteos ni VM", () => {
    const out = apiErrorMessage(
      new Error("opencode cold-start de ceibo-demo-env_013CMPP falló tras 8 intentos: cp.sh serve … exit 1"),
      undefined,
      "local",
    );
    expect(out).not.toContain("Anthropic");
    expect(out).toContain("despertando");
    expect(out).not.toContain("env_013");
    expect(out).not.toContain("intentos");
    expect(out).not.toContain("cp.sh");
  });

  it("origin 'local' sin detalle alguno → frase base accionable, sin Anthropic", () => {
    const out = apiErrorMessage("   ", undefined, "local");
    expect(out).not.toContain("Anthropic");
    expect(out).toContain("Probá de nuevo");
  });

  it("origin 'local' NUNCA dispara el texto de usage-limit de Anthropic", () => {
    const out = apiErrorMessage("Your credit balance is too low.", "billing_error", "local");
    expect(out).not.toContain("Anthropic");
    expect(out).not.toContain("límite de uso de la workspace");
  });

  it("origin 'ma' (usage-limit) sigue diciendo Anthropic + accionable", () => {
    const out = apiErrorMessage(
      "You have reached your specified workspace API usage limits.",
      "billing_error",
      "ma",
    );
    expect(out).toContain("límite de uso de la workspace de Anthropic");
    expect(out).toContain("subir el límite");
  });
});

// --- Higiene de errores user-facing (incidente 2026-06-10: no filtrar interna) -----------------
// Movidas desde gateway/logic.ts: ahora viven en agent (paquete hoja) para que channels también
// las use sin depender de gateway. El gateway las re-exporta desde su logic.ts.

describe("isInternalDetail", () => {
  it("detecta la interna típica del backend local (VMs, env ids, cp.sh, conteos, IPs)", () => {
    const dirty = [
      "opencode cold-start de ceibo-demo-gpuhost-env_013CMPPUUQY4YWv8ZFafECzg falló tras 8 intentos",
      "cp.sh serve vm1 exit 1: serve no respondió en archima-ceibo-demo",
      "agent-vault vault create u1 exit 2: boom",
      "archima exec timeout (60000ms): cp.sh serve vm1",
      "VM en 192.168.122.42 sin respuesta",
      "sesión no vinculada: ses_8a3bc91q",
      "opencode POST /session 502: bad gateway",
      "fetch failed",
      "connect ECONNREFUSED 10.0.0.1:14420",
    ];
    for (const m of dirty) expect(isInternalDetail(m), m).toBe(true);
  });

  it("deja pasar mensajes inocuos aptos para el usuario", () => {
    expect(isInternalDetail("Falta el token de autorización.")).toBe(false);
    expect(isInternalDetail("No tenés wikis configuradas.")).toBe(false);
  });
});

describe("publicErrorReason", () => {
  it("reemplaza el detalle interno por el fallback (el crudo va al log, no al canal)", () => {
    const e = new Error("opencode cold-start de ceibo-demo-env_013CMPP falló tras 8 intentos: cp.sh serve …");
    expect(publicErrorReason(e, "no pude conectar con tu entorno")).toBe("no pude conectar con tu entorno");
  });

  it("conserva un mensaje inocuo (capado a 160)", () => {
    expect(publicErrorReason(new Error("Falta el token de autorización."), "x")).toBe(
      "Falta el token de autorización.",
    );
    const long = new Error(`pasó algo raro ${"y".repeat(300)}`);
    expect(publicErrorReason(long, "x").length).toBeLessThanOrEqual(161); // 160 + elipsis
  });

  it("error vacío/raro → fallback", () => {
    expect(publicErrorReason(undefined, "fallback")).toBe("fallback");
    expect(publicErrorReason(new Error("   "), "fallback")).toBe("fallback");
  });
});
