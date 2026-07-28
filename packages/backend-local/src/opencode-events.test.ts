import type { Sink } from "@ceibo/agent";
import { describe, expect, it } from "vitest";
import { type OpencodeEvent, RelayTranslator } from "./opencode-events.ts";

/** Sink mock que registra las llamadas en orden. */
function mockSink() {
  const calls: { fn: string; arg?: unknown }[] = [];
  const sink: Sink = {
    message: (t) => void calls.push({ fn: "message", arg: t }),
    activity: (l) => void calls.push({ fn: "activity", arg: l }),
    subagents: (n) => void calls.push({ fn: "subagents", arg: n }),
    status: (t) => void calls.push({ fn: "status", arg: t }),
    notice: (t) => void calls.push({ fn: "notice", arg: t }),
    dead: () => void calls.push({ fn: "dead" }),
    turnComplete: (u, m) =>
      void calls.push({ fn: "turnComplete", arg: `${u.input}/${u.output}/${u.cacheRead}:${m}` }),
  };
  return { sink, calls };
}

const ev = (type: string, properties?: OpencodeEvent["properties"]): OpencodeEvent => ({ type, properties });
/** Atajo: message.updated que fija el rol (y opcional modelo) de un messageID. */
const role = (id: string, r: string, model?: string) =>
  ev("message.updated", {
    info: { id, role: r, model: model ? { providerID: "local", modelID: model } : undefined },
  });
/** Atajo: message.part.updated de texto. */
const textPart = (mid: string, pid: string, text: string, synthetic?: boolean) =>
  ev("message.part.updated", { part: { type: "text", text, messageID: mid, id: pid, synthetic } });

function feed(events: OpencodeEvent[]) {
  const { sink, calls } = mockSink();
  const tr = new RelayTranslator(sink);
  const controls = events.map((e) => tr.handle(e));
  return { calls, controls };
}

describe("RelayTranslator (opencode event-bus → Sink)", () => {
  it("texto del asistente se flushea COMPLETO en idle (no snapshots parciales)", () => {
    const { calls } = feed([
      role("m1", "assistant", "gemma4-31b"),
      textPart("m1", "p1", "Un"),
      textPart("m1", "p1", "Un grafo"),
      textPart("m1", "p1", "Un grafo dirigido."), // snapshots crecientes del MISMO part
      ev("session.idle"),
    ]);
    // un solo message con el texto final, después turnComplete
    expect(calls).toEqual([
      { fn: "message", arg: "Un grafo dirigido." },
      { fn: "turnComplete", arg: "0/0/0:gemma4-31b" },
    ]);
  });

  it("ignora el texto del USER (rol no-assistant) y los sintéticos", () => {
    const { calls } = feed([
      role("mu", "user"),
      textPart("mu", "pu", "mi pregunta"), // user → ignorar
      role("ma", "assistant"),
      textPart("ma", "ps", "interno", true), // synthetic → ignorar
      ev("session.idle"),
    ]);
    expect(calls.filter((c) => c.fn === "message")).toEqual([]);
  });

  it("session.compacted → notice de sistema (flushea el texto pendiente antes)", () => {
    const { calls } = feed([
      role("m1", "assistant"),
      textPart("m1", "p1", "respondiendo…"),
      ev("session.compacted"), // opencode auto-compactó la sesión
    ]);
    // el texto pendiente se emite primero, después el aviso de sistema
    expect(calls).toEqual([
      { fn: "message", arg: "respondiendo…" },
      { fn: "notice", arg: "Conversación compactada" },
    ]);
  });

  it("tool part → activity una sola vez por callID (dedupe pending→completed)", () => {
    const { calls } = feed([
      role("m1", "assistant"),
      ev("message.part.updated", {
        part: { type: "tool", tool: "read", callID: "c1", messageID: "m1", state: { status: "pending" } },
      }),
      ev("message.part.updated", {
        part: { type: "tool", tool: "read", callID: "c1", messageID: "m1", state: { status: "running" } },
      }),
      ev("message.part.updated", {
        part: { type: "tool", tool: "read", callID: "c1", messageID: "m1", state: { status: "completed" } },
      }),
      ev("session.idle"),
    ]);
    expect(calls.filter((c) => c.fn === "activity")).toEqual([{ fn: "activity", arg: "read" }]);
  });

  it("texto antes de una tool se flushea ANTES de la activity (orden correcto)", () => {
    const { calls } = feed([
      role("m1", "assistant", "gemma4-31b"),
      textPart("m1", "p1", "Voy a leer el archivo."),
      ev("message.part.updated", { part: { type: "tool", tool: "read", callID: "c1", messageID: "m1" } }),
      role("m2", "assistant", "gemma4-31b"),
      textPart("m2", "p2", "Tiene 3 líneas."),
      ev("session.idle"),
    ]);
    expect(calls).toEqual([
      { fn: "message", arg: "Voy a leer el archivo." },
      { fn: "activity", arg: "read" },
      { fn: "message", arg: "Tiene 3 líneas." },
      { fn: "turnComplete", arg: "0/0/0:gemma4-31b" },
    ]);
  });

  // Atajo: message.part.updated de una tool con estado.
  const toolPart = (tool: string, cid: string, status: string, mid = "m1") =>
    ev("message.part.updated", {
      part: { type: "tool", tool, callID: cid, messageID: mid, state: { status } },
    });

  it("task (sub-agente) → subagents cuenta los `running`; NO emite activity", () => {
    const { calls } = feed([
      role("m1", "assistant"),
      toolPart("task", "t1", "pending"), // pending no cuenta todavía
      toolPart("task", "t1", "running"), // running → 1
      toolPart("task", "t1", "completed"), // completed → 0
      ev("session.idle"),
    ]);
    // NO hay activity (el sub-agente se representa SÓLO con mini-orbs, no como forma/hint del orb).
    expect(calls.filter((c) => c.fn === "activity")).toEqual([]);
    expect(calls.filter((c) => c.fn === "subagents")).toEqual([
      { fn: "subagents", arg: 1 },
      { fn: "subagents", arg: 0 },
    ]);
  });

  it("task concurrente: dos callIDs running → 2; uno completed → 1 (concurrencia)", () => {
    const { calls } = feed([
      role("m1", "assistant"),
      toolPart("task", "a", "running"), // → 1
      toolPart("task", "b", "running"), // → 2
      toolPart("task", "a", "completed"), // → 1
      ev("session.idle"), // el que queda vivo (b) se limpia → 0
    ]);
    expect(calls.filter((c) => c.fn === "subagents")).toEqual([
      { fn: "subagents", arg: 1 },
      { fn: "subagents", arg: 2 },
      { fn: "subagents", arg: 1 },
      { fn: "subagents", arg: 0 }, // red de seguridad en idle (b quedó vivo)
    ]);
  });

  it("task con error cuenta como fin (resta del set de vivos)", () => {
    const { calls } = feed([
      role("m1", "assistant"),
      toolPart("task", "t1", "running"), // → 1
      toolPart("task", "t1", "error"), // error = fin → 0
      ev("session.idle"), // ya no había vivos → sin subagents(0) extra
    ]);
    expect(calls.filter((c) => c.fn === "subagents")).toEqual([
      { fn: "subagents", arg: 1 },
      { fn: "subagents", arg: 0 },
    ]);
  });

  // --- task BACKGROUND (opencode 1.17+: background:true) -----------------------------------
  // Atajo: tool-call `task` BACKGROUND. El tool-call completa enseguida pero metadata.background
  // marca que el sub-agente sigue vivo (keyado por jobId = sesión hija ses_…).
  const bgTask = (jobId: string, status = "completed", cid = "bg1", mid = "m1") =>
    ev("message.part.updated", {
      part: {
        type: "tool",
        tool: "task",
        callID: cid,
        messageID: mid,
        state: { status, metadata: { background: true, jobId } },
      },
    });
  // Atajo: prompt SINTÉTICO de resultado que opencode inyecta en la sesión del padre al terminar.
  const bgResult = (jobId: string, state: "completed" | "error" = "completed", mid = "ms") =>
    textPart(
      mid,
      `${mid}p`,
      `<task id="${jobId}" state="${state}">\n<task_result>\nlisto\n</task_result>\n</task>`,
      true,
    );

  it("task background: suma al lanzarse, PERSISTE en session.idle (no muere con el turno)", () => {
    const { calls } = feed([
      role("m1", "assistant"),
      bgTask("ses_J"), // background lanzado → 1
      textPart("m1", "p1", "Lo despaché, seguí hablando."),
      ev("session.idle"), // turno cierra PERO el background sigue → NO baja a 0
    ]);
    expect(calls.filter((c) => c.fn === "subagents")).toEqual([{ fn: "subagents", arg: 1 }]);
    // y el texto del anuncio se relaya normal
    expect(calls.filter((c) => c.fn === "message")).toEqual([
      { fn: "message", arg: "Lo despaché, seguí hablando." },
    ]);
  });

  it("task background: el prompt sintético de resultado lo resta (→ 0) y el texto del coordinador se relaya", () => {
    const { calls } = feed([
      role("m1", "assistant"),
      bgTask("ses_J"), // → 1
      textPart("m1", "p1", "Lo despaché."),
      ev("session.idle"), // sigue en 1
      // resultado: opencode inyecta el prompt sintético (user/synthetic) → resta → 0
      role("ms", "user"),
      bgResult("ses_J"),
      // y dispara un turno del coordinador que informa al usuario (texto NO sintético)
      role("m2", "assistant"),
      textPart("m2", "p2", "Listo, encontré lo que pediste."),
      ev("session.idle"),
    ]);
    expect(calls.filter((c) => c.fn === "subagents")).toEqual([
      { fn: "subagents", arg: 1 },
      { fn: "subagents", arg: 0 },
    ]);
    // el <task_result> sintético NO se relaya; sí el informe del coordinador
    expect(calls.filter((c) => c.fn === "message")).toEqual([
      { fn: "message", arg: "Lo despaché." },
      { fn: "message", arg: "Listo, encontré lo que pediste." },
    ]);
  });

  it("task background no duplica el conteo si llega más de un update del mismo jobId", () => {
    const { calls } = feed([
      role("m1", "assistant"),
      bgTask("ses_J", "running"), // running con background → 1
      bgTask("ses_J", "completed"), // mismo jobId, idempotente → sin re-emisión
      ev("session.idle"),
    ]);
    expect(calls.filter((c) => c.fn === "subagents")).toEqual([{ fn: "subagents", arg: 1 }]);
  });

  it("background + bloqueante conviven en el conteo combinado", () => {
    const { calls } = feed([
      role("m1", "assistant"),
      bgTask("ses_J"), // background → 1
      toolPart("task", "blk", "running"), // bloqueante → 2
      toolPart("task", "blk", "completed"), // bloqueante termina → 1 (queda el background)
      ev("session.idle"), // bloqueantes limpios, background persiste → 1
    ]);
    expect(calls.filter((c) => c.fn === "subagents")).toEqual([
      { fn: "subagents", arg: 1 },
      { fn: "subagents", arg: 2 },
      { fn: "subagents", arg: 1 },
    ]);
  });

  it("background vivo + session.terminated → apaga mini-orbs (0) antes de dead", () => {
    const { calls } = feed([
      role("m1", "assistant"),
      bgTask("ses_J"), // → 1
      ev("session.idle"),
      ev("session.terminated"),
    ]);
    expect(calls.filter((c) => c.fn === "subagents")).toEqual([
      { fn: "subagents", arg: 1 },
      { fn: "subagents", arg: 0 },
    ]);
    expect(calls.some((c) => c.fn === "dead")).toBe(true);
  });

  it("una tool NORMAL (no task) sigue emitiendo activity y NO toca subagents", () => {
    const { calls } = feed([
      role("m1", "assistant"),
      toolPart("read", "c1", "running"),
      toolPart("read", "c1", "completed"),
      ev("session.idle"),
    ]);
    expect(calls.filter((c) => c.fn === "activity")).toEqual([{ fn: "activity", arg: "read" }]);
    expect(calls.filter((c) => c.fn === "subagents")).toEqual([]); // no había task vivo → ni en idle
  });

  it("usage se acumula de step-finish (in-band) y se reporta en idle", () => {
    const { calls } = feed([
      role("m1", "assistant", "gemma4-31b"),
      ev("message.part.updated", {
        part: {
          type: "step-finish",
          messageID: "m1",
          tokens: { input: 7492, output: 21, cache: { read: 100, write: 0 } },
        },
      }),
      ev("message.part.updated", {
        part: {
          type: "step-finish",
          messageID: "m1",
          tokens: { input: 30, output: 40, cache: { read: 50 } },
        },
      }),
      ev("session.idle"),
    ]);
    expect(calls).toEqual([{ fn: "turnComplete", arg: "7522/61/150:gemma4-31b" }]);
  });

  it("turnComplete emite el usage ACUMULADO de la sesión (no per-turno) → recordTurn saca el delta", () => {
    // Regresión item G: el local emitía per-turno y `recordTurn` (que espera acumulado y resta el
    // snapshot) calculaba delta = max(0, perTurno - snapshot) → 0 en el 2º turno → no grababa fila.
    // Ahora el acumulado crece turno a turno, igual que `sessions.retrieve().usage` en MA.
    const { sink, calls } = mockSink();
    const tr = new RelayTranslator(sink);
    [
      role("m1", "assistant", "gemma4-31b"),
      ev("message.part.updated", {
        part: {
          type: "step-finish",
          messageID: "m1",
          tokens: { input: 100, output: 10, cache: { read: 20 } },
        },
      }),
      ev("session.idle"),
    ].forEach((e) => {
      tr.handle(e);
    });
    [
      role("m2", "assistant", "gemma4-31b"),
      ev("message.part.updated", {
        part: { type: "step-finish", messageID: "m2", tokens: { input: 5, output: 5, cache: { read: 3 } } },
      }),
      ev("session.idle"),
    ].forEach((e) => {
      tr.handle(e);
    });
    expect(calls).toEqual([
      { fn: "turnComplete", arg: "100/10/20:gemma4-31b" },
      // 2º turno = acumulado (105/15/23), NO 5/5/3: recordTurn sacará el delta 5/5/3 contra el snapshot.
      { fn: "turnComplete", arg: "105/15/23:gemma4-31b" },
    ]);
  });

  it("session.error → sink.status", () => {
    const { calls } = feed([ev("session.error", { error: { message: "boom" } })]);
    expect(calls).toEqual([{ fn: "status", arg: "error: boom" }]);
  });

  it("session.deleted → sink.dead + control 'terminated'", () => {
    const { calls, controls } = feed([ev("session.deleted")]);
    expect(controls).toEqual(["terminated"]);
    expect(calls).toEqual([{ fn: "dead" }]);
  });

  it("eventos de setup/ruido → no-op (session.next.*, step-start, etc.)", () => {
    const { calls, controls } = feed([
      ev("server.connected"),
      ev("session.next.agent.switched"),
      ev("message.part.updated", { part: { type: "step-start", messageID: "m1" } }),
      ev("file.edited"),
    ]);
    expect(controls).toEqual([null, null, null, null]);
    expect(calls).toEqual([]);
  });
});

describe("RelayTranslator — timing del turno (TTFT, quickboot)", () => {
  type TimingCall = { fn: string; timing?: unknown };
  /** Sink que captura el `timing` de turnComplete. */
  function mockSinkTiming() {
    const calls: TimingCall[] = [];
    const sink: Sink = {
      message: () => {},
      activity: () => {},
      turnComplete: (_u, _m, t) => void calls.push({ fn: "turnComplete", timing: t }),
    };
    return { sink, calls };
  }
  /** Alimenta los eventos con un reloj inyectado: `times[i]` es el valor de `now()` mientras se
   *  procesa el evento i (markFirstToken y computeTiming llaman now() sincrónicamente en `handle`). */
  function feedTimed(events: OpencodeEvent[], sentAt: number, times: number[]) {
    const { sink, calls } = mockSinkTiming();
    let i = 0;
    const tr = new RelayTranslator(sink, { sentAt: () => sentAt, now: () => times[i] ?? 0 });
    events.forEach((e, idx) => {
      i = idx;
      tr.handle(e);
    });
    return { calls };
  }
  const toolPart = (tool: string, cid: string, status: string, mid = "m1") =>
    ev("message.part.updated", {
      part: { type: "tool", tool, callID: cid, state: { status }, messageID: mid },
    });

  it("ttftMs = 1er token de texto del asistente − send; turnMs = idle − send", () => {
    const { calls } = feedTimed(
      [
        role("m1", "assistant", "gemma4-31b"), // t=1100 (no marca: no es part)
        textPart("m1", "p1", "hola"), // t=1500 → primer token
        ev("message.part.updated", {
          part: { type: "step-finish", messageID: "m1", tokens: { input: 5000 } },
        }), // t=1600
        ev("session.idle"), // t=2200
      ],
      1000,
      [1100, 1500, 1600, 2200],
    );
    expect(calls).toEqual([{ fn: "turnComplete", timing: { turnMs: 1200, ttftMs: 500 } }]);
  });

  it("un tool-call también cuenta como primer token (turno sin texto previo)", () => {
    const { calls } = feedTimed(
      [role("m1", "assistant", "gemma4-31b"), toolPart("bash", "c1", "completed"), ev("session.idle")],
      1000,
      [1050, 1300, 1800],
    );
    expect(calls).toEqual([{ fn: "turnComplete", timing: { ttftMs: 300, turnMs: 800 } }]);
  });

  it("sin send (sentAt=0) → timing undefined (ej. prompt sintético de background)", () => {
    const { calls } = feedTimed(
      [role("m1", "assistant", "gemma4-31b"), textPart("m1", "p1", "x"), ev("session.idle")],
      0,
      [10, 20, 30],
    );
    expect(calls).toEqual([{ fn: "turnComplete", timing: undefined }]);
  });

  it("turno sin token del asistente → turnMs presente, ttftMs omitido", () => {
    const { calls } = feedTimed(
      [role("m1", "user"), textPart("m1", "p1", "del user"), ev("session.idle")],
      1000,
      [1100, 1200, 1900],
    );
    expect(calls).toEqual([{ fn: "turnComplete", timing: { turnMs: 900 } }]);
  });

  it("TTFT es per-turno: el 2º turno mide desde su propio send (firstTokenAt se resetea)", () => {
    const { sink, calls } = mockSinkTiming();
    let now = 0;
    let sentAt = 0;
    const tr = new RelayTranslator(sink, { sentAt: () => sentAt, now: () => now });
    // turno 1
    sentAt = 1000;
    now = 1100;
    tr.handle(role("m1", "assistant", "gemma4-31b"));
    now = 1400;
    tr.handle(textPart("m1", "p1", "uno"));
    now = 1900;
    tr.handle(ev("session.idle"));
    // turno 2
    sentAt = 5000;
    now = 5100;
    tr.handle(role("m2", "assistant", "gemma4-31b"));
    now = 5200;
    tr.handle(textPart("m2", "p2", "dos"));
    now = 5600;
    tr.handle(ev("session.idle"));
    expect(calls).toEqual([
      { fn: "turnComplete", timing: { turnMs: 900, ttftMs: 400 } },
      { fn: "turnComplete", timing: { turnMs: 600, ttftMs: 200 } },
    ]);
  });
});
