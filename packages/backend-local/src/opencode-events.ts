// El traductor del relay: mapea el event-bus de opencode (`GET /event`, SSE) a llamadas
// al `Sink` (la forma que espera `@ceibo/agent`). RE-ANCLADO empíricamente (2026-06-02)
// capturando el `/event` de turnos reales (opencode 1.15.13) — ver archima-plan §Fase 4.
//
// Realidad medida (NO los `session.next.*`, que sólo disparan en el setup):
//   - assistant text → `message.part.updated` part.type="text". OJO: el prompt del USER
//     vuelve como text part también → el rol NO viene inline en el part, viene de eventos
//     `message.updated` (info.role). Hay que correlacionar messageID→role. Por eso esto
//     es un traductor CON ESTADO, no una función pura.
//   - tool → part.type="tool" {tool, callID, state.status} → dispara N veces (pending→
//     completed) → dedupe por callID.
//   - usage IN-BAND → part.type="step-finish" trae {tokens:{input,output,cache}} → se
//     acumula; el cliente NO necesita un GET aparte.
//   - fin de turno → evento `session.idle`.
// El texto se bufferea por partID y se flushea COMPLETO en los bordes (tool / step-finish /
// idle), para postear mensajes enteros (paridad con ceibo) en vez de snapshots parciales.

import type { Sink, TurnTiming, TurnUsage } from "@ceibo/agent";

export interface OpencodeTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface OpencodePart {
  type: string; // "text" | "tool" | "step-start" | "step-finish" | "reasoning" | ...
  text?: string;
  synthetic?: boolean;
  messageID?: string;
  sessionID?: string; // sesión dueña del part (el bus /event es global → clave del filtrado)
  id?: string; // partID (prt_...)
  tool?: string; // nombre de la tool, en parts type="tool"
  callID?: string;
  // `metadata` (en running/completed/error de un tool-call) trae lo que devolvió la tool. Para
  // `task(background:true)` incluye `background:true` + `jobId`/`sessionId` (id de la sesión hija).
  state?: { status?: string; metadata?: { background?: boolean; jobId?: string; sessionId?: string } };
  tokens?: OpencodeTokens;
}

export interface OpencodeMessageInfo {
  id?: string;
  role?: string;
  sessionID?: string; // sesión dueña del mensaje (en eventos `session.*`, `info` ES la sesión y va sin esto)
  model?: { providerID?: string; modelID?: string };
}

export interface OpencodeEvent {
  type: string;
  properties?: {
    part?: OpencodePart;
    sessionID?: string;
    info?: OpencodeMessageInfo;
    error?: { message?: string } | string;
  };
}

const ZERO: TurnUsage = { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheRead: 0 };

/**
 * Traductor con estado de un stream de eventos de UNA sesión opencode → Sink.
 * Se instancia uno por `attach`. `handle(ev)` despacha al Sink y devuelve "terminated"
 * si la sesión murió (el relay corta), o null.
 */
export class RelayTranslator {
  private role = new Map<string, string>(); // messageID → role
  private text = new Map<string, string>(); // partID → último texto (assistant, pendiente de flush)
  private flushed = new Set<string>(); // partIDs ya emitidos en este turno
  private seenTool = new Set<string>(); // callIDs ya anunciados en este turno
  // Sub-agentes BLOQUEANTES vivos de este turno: callIDs de tool-calls `task` cuyo `state.status`
  // es `running`. En archima un sub-agente ES un `task`. El MISMO callID transiciona
  // pending→running→completed/error; contamos los `running` = sub-agentes activos AHORA
  // (concurrentes incluidos). add en running, remove en completed/error. Mueren con el turno.
  private subagentRunning = new Set<string>();
  // Sub-agentes BACKGROUND (`task(background:true)`, opencode 1.17+): a diferencia de los
  // bloqueantes, el tool-call COMPLETA al instante (devuelve "trabajando en background") pero el
  // sub-agente sigue vivo en el scope de la INSTANCIA opencode, FUERA del turno del coordinador.
  // → NO se trackean por callID/status (parpadearían 1→0) ni mueren en `session.idle`. Se keyan por
  // el id de la sesión hija (`jobId`==`sessionId`==`ses_…`, de `state.metadata`): se SUMAN al ver
  // el tool-call con `metadata.background`, y se RESTAN cuando opencode inyecta el resultado como
  // prompt SINTÉTICO en esta sesión (`<task id="ses_…" state="completed|error">`, ver branch text).
  private backgroundRunning = new Set<string>();
  // Usage ACUMULADO de la sesión (NO per-turno): `recordTurn` (store) espera el acumulado y
  // calcula el delta contra su snapshot — igual que `sessions.retrieve().usage` en MA. Por eso
  // este acumulador NO se resetea entre turnos (ver `resetTurn`); si se reseteara, el 2º turno
  // emitiría per-turno y `delta = max(0, perTurno - snapshot)` daría 0 → no se grababa la fila.
  private usage: TurnUsage = { ...ZERO };
  private lastModel = "";
  // TTFT: ms (epoch) del primer token del asistente de ESTE turno (texto o tool-call). Se setea
  // una vez por turno y `resetTurn` lo limpia. `opts.sentAt` da el instante del `send` del prompt
  // (lo mantiene el relay en `attach`); con ambos calculamos ttftMs ≈ prefill. Ver quickboot.
  private firstTokenAt?: number;

  constructor(
    private sink: Sink,
    // Inyectables para timing/testabilidad: `now()` (default Date.now) y `sentAt()` = instante del
    // último `send` del relay (default undefined → sin timing, ej. en tests que no lo necesitan).
    private opts: { now?: () => number; sentAt?: () => number } = {},
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Marca el primer token del asistente del turno (idempotente). */
  private markFirstToken(): void {
    if (this.firstTokenAt == null) this.firstTokenAt = this.now();
  }

  /** Timing del turno para `turnComplete`. undefined si el turno no nació de un `send` (ej. el
   *  prompt sintético de cierre de un sub-agente background: no hay `sentAt` del usuario). */
  private computeTiming(): TurnTiming | undefined {
    const sentAt = this.opts.sentAt?.();
    if (!sentAt) return undefined;
    const timing: TurnTiming = { turnMs: this.now() - sentAt };
    if (this.firstTokenAt != null && this.firstTokenAt >= sentAt) {
      timing.ttftMs = this.firstTokenAt - sentAt;
    }
    return timing;
  }

  handle(ev: OpencodeEvent): "terminated" | null {
    const p = ev.properties ?? {};
    switch (ev.type) {
      case "message.updated": {
        const info = p.info;
        if (info?.id) {
          if (info.role) this.role.set(info.id, info.role);
          const m = info.model?.modelID;
          if (m) this.lastModel = m;
        }
        return null;
      }
      case "message.part.updated": {
        const part = p.part;
        if (!part) return null;
        const mid = part.messageID ?? "";
        if (part.type === "text") {
          // Fin de un `task` BACKGROUND: al terminar el sub-agente, opencode inyecta su resultado
          // como prompt SINTÉTICO en ESTA sesión — `<task id="ses_…" state="completed|error">`.
          // Es la única señal de cierre que vemos (la sesión hija la filtra el bus). Restamos el
          // mini-orb. (El prompt sintético dispara, además, un turno del coordinador que informa al
          // usuario: ese texto NO es sintético → se relaya por el camino normal de abajo.)
          if (part.text && this.backgroundRunning.size > 0) {
            const m = part.text.match(/<task id="(ses_[^"]+)" state="(?:completed|error)">/);
            if (m?.[1] && this.backgroundRunning.delete(m[1])) this.emitSubagentCount();
          }
          // sólo texto del ASISTENTE (el del user / sintético vuelve como part también)
          if (this.role.get(mid) === "assistant" && part.text != null && !part.synthetic) {
            this.markFirstToken(); // 1er token visible del turno → TTFT ≈ prefill
            this.text.set(part.id ?? mid, part.text); // bufferea; se flushea en el borde
          }
        } else if (part.type === "tool") {
          this.markFirstToken(); // un tool-call también es 1er output del modelo (turnos sin texto previo)
          this.flushText(); // el texto previo a la tool ya está completo
          const cid = part.callID ?? part.id ?? "";
          if (part.tool === "task") {
            // Sub-agente: NO emitimos el `activity` genérico (el orb no debe mostrarlo como
            // tier-tool ni con el hint crudo "task"); se representa SÓLO con mini-orbs vía `subagents`.
            const meta = part.state?.metadata;
            if (meta?.background === true) {
              // BACKGROUND: keyado por la sesión hija (jobId==sessionId==ses_…), NO por callID ni
              // status (el tool-call completa enseguida). Suma al verlo; resta vía el prompt
              // sintético de resultado (branch text). Idempotente: un mismo update no duplica.
              const jobId = meta.jobId ?? meta.sessionId;
              if (jobId && !this.backgroundRunning.has(jobId)) {
                this.backgroundRunning.add(jobId);
                this.emitSubagentCount();
              }
            } else if (cid) {
              // BLOQUEANTE: el callID transiciona running→completed/error; el conteo sigue ESE ciclo.
              this.trackSubagent(cid, part.state?.status);
            }
          } else if (cid && !this.seenTool.has(cid)) {
            this.seenTool.add(cid);
            this.sink.activity?.(part.tool ?? "tool");
          }
        } else if (part.type === "step-finish") {
          this.accUsage(part.tokens);
          this.flushText(); // el texto del step está completo
        }
        return null;
      }
      case "session.error": {
        // opencode manda `error` como NamedError ({ name, data }) o string. El `.message` suele venir
        // vacío (el detalle real está en `data`) → caemos a name + data serializada para no tragarnos
        // la causa real (model-not-found, TemplateError, auth, etc.). Ver incidente Gemma 2026-06-14.
        const e = p.error as { name?: string; message?: string; data?: unknown } | string | undefined;
        let msg: string;
        if (typeof e === "string") msg = e;
        else if (e?.message) msg = e.message;
        else if (e) {
          let data: string;
          try {
            data = JSON.stringify(e.data ?? e);
          } catch {
            data = String(e.data ?? e);
          }
          msg = `${e.name ?? "unknown"} ${data}`;
        } else msg = "unknown";
        this.sink.status?.(`error: ${msg}`);
        return null;
      }
      case "session.compacted": {
        // opencode 1.17.8 acaba de auto-compactar esta sesión (el contexto excedía el umbral y
        // reemplazó la historia vieja por un checkpoint con resumen rolling). Es la señal única y
        // durable del evento (verificado en vivo 2026-06-19, ver sessions-plan §2). La proyectamos
        // como aviso de sistema neutro para que el usuario sepa por qué "se acortó" el hilo.
        // Cualquier texto pendiente del turno se flushea antes para no intercalar el aviso.
        this.flushText();
        this.sink.notice?.("Conversación compactada");
        return null;
      }
      case "session.idle": {
        this.flushText();
        // Fin de turno → los sub-agentes BLOQUEANTES ya no están (red de seguridad por si algún
        // `task` no emitió su completed/error). Los BACKGROUND SOBREVIVEN al turno (se restan vía
        // el prompt sintético de resultado, no acá) → re-emitimos el conteo COMBINADO si limpiamos.
        if (this.subagentRunning.size > 0) {
          this.subagentRunning.clear();
          this.emitSubagentCount();
        }
        // Emite el usage ACUMULADO de la sesión (no per-turno): el gateway lo pasa a `recordTurn`
        // que saca el delta contra el snapshot. `resetTurn` limpia el estado per-turno PERO conserva
        // `this.usage` para que el próximo idle reporte el acumulado correcto.
        if (this.sink.turnComplete)
          void this.sink.turnComplete({ ...this.usage }, this.lastModel, this.computeTiming());
        this.resetTurn();
        return null;
      }
      case "session.deleted":
      case "session.terminated":
        // La sesión murió → no llegará el prompt sintético de cierre de ningún background vivo.
        // Apagamos los mini-orbs (0) para que no queden colgados, antes de soltar el relay.
        if (this.backgroundRunning.size > 0 || this.subagentRunning.size > 0) {
          this.backgroundRunning.clear();
          this.subagentRunning.clear();
          this.sink.subagents?.(0);
        }
        this.sink.dead?.();
        return "terminated";
      default:
        return null;
    }
  }

  // Actualiza el set de sub-agentes vivos para un callID `task` según su `state.status` y, si el
  // conteo cambió, lo reporta. `running` lo agrega (si no estaba); `completed`/`error` lo saca (si
  // estaba). El resto de los estados (`pending`, ausente, …) no toca el conteo. Idempotente: un
  // mismo status repetido para el mismo callID no dispara llamadas de más.
  private trackSubagent(cid: string, status?: string): void {
    const had = this.subagentRunning.has(cid);
    if (status === "running") {
      if (!had) {
        this.subagentRunning.add(cid);
        this.emitSubagentCount();
      }
    } else if (status === "completed" || status === "error") {
      if (had) {
        this.subagentRunning.delete(cid);
        this.emitSubagentCount();
      }
    }
  }

  // Conteo de mini-orbs = sub-agentes vivos AHORA, COMBINANDO bloqueantes (mueren con el turno) +
  // background (sobreviven al turno). Frame absoluto: la web reemplaza el anterior.
  private emitSubagentCount(): void {
    this.sink.subagents?.(this.subagentRunning.size + this.backgroundRunning.size);
  }

  private flushText(): void {
    for (const [pid, txt] of this.text) {
      if (!this.flushed.has(pid) && txt.trim()) {
        this.flushed.add(pid);
        void this.sink.message(txt);
      }
    }
    this.text.clear();
  }

  private accUsage(tk?: OpencodeTokens): void {
    if (!tk) return;
    this.usage.input += tk.input ?? 0;
    this.usage.output += tk.output ?? 0;
    // opencode reporta cache.read/write total; no separa TTL 5m/1h → cacheRead.
    this.usage.cacheRead += tk.cache?.read ?? 0;
  }

  private resetTurn(): void {
    this.flushed.clear();
    this.text.clear();
    this.seenTool.clear();
    this.firstTokenAt = undefined; // TTFT es per-turno
    this.subagentRunning.clear(); // los BLOQUEANTES no sobreviven al turno
    // OJO: backgroundRunning NO se limpia acá — los background sobreviven entre turnos y se restan
    // sólo al llegar su prompt sintético de resultado (o si la sesión muere).

    // `usage` (acumulado de la sesión) y role/lastModel persisten entre turnos a propósito:
    // el usage acumulado es lo que `recordTurn` necesita para el delta contra el snapshot.
  }
}
