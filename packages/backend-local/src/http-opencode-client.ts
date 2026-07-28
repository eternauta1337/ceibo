// Impl real de OpencodeClient: habla HTTP/SSE con un `opencode serve` (en la VM de la
// sesión). Rutas MEDIDAS contra el server vivo 1.15.13 (ver archima-plan §Fase 4):
//   POST /session                      → crea sesión opencode (ses_...)
//   POST /session/{ses}/prompt_async   → manda prompt, eventos llegan por el bus
//   POST /session/{ses}/abort          → interrumpe
//   GET  /mcp                          → estado de los MCP servers (GLOBAL por instancia)
//   POST /mcp {name, config}           → agrega Y conecta un MCP server (GLOBAL, no por sesión)
//   POST /mcp/{name}/disconnect        → desconecta un MCP server
//   GET  /event                        → bus SSE GLOBAL (filtramos por sessionID)
//
// OJO: el session PATCH (PATCH /session/{ses}) NO conecta MCPs — opencode lo ignora para MCP
// (medido en vivo contra opencode 1.16: tras el PATCH, GET /mcp devuelve {}). Por eso la entrega
// de MCP va por el API dedicado /mcp (ver setAgentConfig/reconcileMcp).
//
// El `sessionId` lógico del backend = el NOMBRE de la VM (de cp.sh). Acá lo mapeamos al
// id de sesión opencode (ses_...) y a la baseURL del serve de esa VM (resuelta por config).

import type { SessionConfig } from "@ceibo/agent";
import type { AgentConfig, OpencodeClient } from "./archima-backend.ts";
import type { OpencodeEvent } from "./opencode-events.ts";
import { type OpencodeRemoteMcp, toOpencodeAgentConfig } from "./opencode-mcp.ts";

export interface HttpOpencodeConfig {
  /** Resuelve la baseURL del `opencode serve` para un sessionId lógico (nombre de VM).
   *  Sim standalone: () => "http://127.0.0.1:PORT". VMs: cp.sh ip → "http://<ip>:PORT". */
  resolveBase: (sessionId: string) => Promise<string>;
  /** providerID/modelID que se inyectan en cada prompt (el agente no elige modelo). */
  providerID: string;
  modelID: string;
  /** Override del modelo del coordinador conversacional. Default: `modelID`. */
  coordinatorModelID?: string;
  /** Override del modelo del worker/sub-agente. Default: `modelID`. */
  workerModelID?: string;
  /** Opciones provider-specific que opencode reenvía al AI SDK para prompts del coordinador. */
  coordinatorOptions?: Record<string, unknown>;
  /** Opciones provider-specific que opencode reenvía al AI SDK para prompts de workers. */
  workerOptions?: Record<string, unknown>;
  /** Agente de opencode que maneja las sesiones del COORDINADOR (campo `agent` del prompt y del
   *  POST /session). Con un agente custom definido en opencode.json, opencode usa SU prompt en vez
   *  del de "build" y respeta su `permission` (tools negadas ni existen para el modelo). Default:
   *  sin agente → opencode usa el `default_agent` de su config. */
  agent?: string;
  /** Agente de opencode para las sesiones de WORKER (sub-agente asíncrono). Corre como sesión
   *  propia (no vía la tool `task`), así que su `agent` se fija por-sesión acá. Default: cae a
   *  `agent` si no se especifica. */
  workerAgent?: string;
  /** Título NO-DEFAULT para el POST /session del coordinador. Un título que NO matchea
   *  `isDefaultTitle()` de opencode ("New session - <ISO>" / "Child session - <ISO>") evita el 2º
   *  request de generación de título (re-prefilea todo el contexto → latencia). Default:
   *  `ceibo · <sessionId>`. */
  sessionTitle?: (sessionId: string) => string;
  /** Título NO-DEFAULT para el POST /session del worker. Default: `ceibo-worker · <vmSessionId>`. */
  workerTitle?: (vmSessionId: string) => string;
  /** opcional (tests). Default: global fetch de Node 22. */
  fetchImpl?: typeof fetch;
  /** Cold-start de la VM: cuántas veces reintentar `resolveBase` + POST /session ante un fallo
   *  transitorio (conexión rechazada / 5xx) antes de declarar muerto. Una VM fresca tarda en
   *  levantar el `opencode serve` → el 1er turno solía morir con `fetch failed`. Default 8. */
  connectAttempts?: number;
  /** Backoff inicial (ms) entre reintentos de cold-start; duplica hasta 5s. Default 500. */
  connectBackoffMs?: number;
  /** opcional (tests): sleep inyectable para no esperar de verdad. Default setTimeout. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** @deprecated Ya no se usa: el connect de MCP pasó de serial-con-pacing a PARALELO ACOTADO
   *  (`mcpConnectConcurrency`). Se mantiene el campo para no romper el wiring del factory/env.
   *  El MITM del Agent Vault rate-limita ~10 req/40s por agente (`X-Ratelimit-Limit: 10`). */
  mcpPaceMs?: number;
  /** Concurrencia máxima de connects de MCP en reconcileMcp. El AV rate-limita ~10 req/40s POR
   *  AGENTE (per-VM), así que un cap < 10 nunca agota el bucket en el burst inicial, sea cual sea
   *  la cantidad de MCP (el incidente 2026-06-18 fue ~16 MCP en burst > 10). El verify+retry cubre
   *  cualquier 429/SSE-flaky restante. Reemplaza el pacing serial (medido: 9 MCP serial = 19.8s →
   *  paralelo acotado ≈ 3-4s; quickboot/mediciones.md). Default 8. Env: `ARCHIMA_MCP_CONCURRENCY`. */
  mcpConnectConcurrency?: number;
  /** Rondas de VERIFY+RETRY en reconcileMcp: tras conectar, se consulta el estado real (GET /mcp)
   *  y se reintentan los servers que NO quedaron `connected` (429 del herd o SSE que falla async
   *  pese a un POST 200). Default 3. 0 desactiva (sólo el connect inicial). */
  mcpVerifyRounds?: number;
  /** Watchdog del stream de eventos: si pasan más de estos ms SIN bytes en el SSE, se corta el
   *  stream con `StreamIdleError` (el pump del backend reconecta). `opencode serve` emite
   *  `server.heartbeat` cada 10s por el bus /event → una conexión SANA nunca queda muda tanto
   *  tiempo; si quedó muda es un socket zombie (incidente 2026-06-10: el host rebootó, el TCP
   *  murió sin FIN/RST y el read() quedó parqueado para siempre — turnos colgados sin error).
   *  Default 45s (4 heartbeats perdidos). ≤0 desactiva. Env: `ARCHIMA_EVENT_IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number;
}

/** Default del watchdog de inactividad del SSE (ver HttpOpencodeConfig.idleTimeoutMs). */
export const DEFAULT_EVENT_IDLE_TIMEOUT_MS = 45_000;

/** El stream SSE quedó MUDO más de `idleTimeoutMs` (socket zombie tras un reboot del host:
 *  el server manda heartbeats cada 10s, así que silencio prolongado = conexión muerta). */
export class StreamIdleError extends Error {}

/** Resultado del intento de recuperación de una sesión tras cortes repetidos del stream:
 *  - "rebound": la VM responde y la sesión opencode SIGUE viva (quizá en una IP nueva) → el
 *    binding quedó re-apuntado, se puede re-suscribir sin perder contexto.
 *  - "session-lost": la VM responde pero la sesión YA NO existe (el reboot se la llevó) → el
 *    binding quedó invalidado; el caller tiene que avisar y recrear.
 *  - "unreachable": la VM/serve no responden todavía → seguir reintentando con backoff. */
export type RecoverResult = "rebound" | "session-lost" | "unreachable";

interface Bound {
  base: string;
  ses: string;
  model: { providerID: string; modelID: string };
  role: "coordinator" | "worker";
  options?: Record<string, unknown>;
  /** Agente de opencode con el que promptea ESTA sesión (coordinador vs worker). undefined =
   *  no mandamos `agent` en el prompt (cae al default_agent de opencode). */
  agent?: string;
}

/** ¿El modelID es de la familia Qwen? Sólo Qwen3 define `enable_thinking`/`preserve_thinking` en
 *  su chat template, así que es el único que recibe esos kwargs auto-inyectados (ver optionsFor). */
function isQwen(modelID: string): boolean {
  return /qwen/i.test(modelID);
}

function thinkingKwargs(options: Record<string, unknown> | undefined): {
  enable_thinking?: unknown;
  preserve_thinking?: unknown;
} {
  const openai = options?.openai;
  if (!openai || typeof openai !== "object" || Array.isArray(openai)) return {};
  const chatTemplateKwargs = (openai as { chat_template_kwargs?: unknown }).chat_template_kwargs;
  if (!chatTemplateKwargs || typeof chatTemplateKwargs !== "object" || Array.isArray(chatTemplateKwargs)) {
    return {};
  }
  const kwargs = chatTemplateKwargs as {
    enable_thinking?: unknown;
    preserve_thinking?: unknown;
  };
  return {
    enable_thinking: kwargs.enable_thinking,
    preserve_thinking: kwargs.preserve_thinking,
  };
}

function logThinkingOptions(bound: Bound): void {
  // El log de thinking sólo tiene sentido para modelos que realmente reciben esos kwargs (Qwen);
  // para Gemma & co. no se inyectan (ver optionsFor) → no ensuciamos el log con "unset/unset".
  if (!isQwen(bound.model.modelID)) return;
  const kwargs = thinkingKwargs(bound.options);
  const enable = kwargs.enable_thinking === undefined ? "unset" : String(kwargs.enable_thinking);
  const preserve = kwargs.preserve_thinking === undefined ? "unset" : String(kwargs.preserve_thinking);
  console.log(
    `[archima] qwen thinking role=${bound.role} model=${bound.model.modelID} enable_thinking=${enable} preserve_thinking=${preserve}`,
  );
}

/** Error que NO se reintenta en cold-start (ej. 4xx: el server está vivo pero la request es mala;
 *  reintentar no ayuda). Los fallos de conexión y 5xx (server aún levantando) sí se reintentan. */
class NonRetryable extends Error {}

export class HttpOpencodeClient implements OpencodeClient {
  private bound = new Map<string, Bound>(); // sessionId lógico → {baseURL, ses_id opencode}
  private ensuring = new Map<string, Promise<void>>(); // dedup de llamadas en vuelo
  private fetch: typeof fetch;
  private sleep: (ms: number) => Promise<void>;

  constructor(private cfg: HttpOpencodeConfig) {
    this.fetch = cfg.fetchImpl ?? globalThis.fetch;
    this.sleep = cfg.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Invalida el binding de `sessionId` (y su ensure en vuelo, si lo hubiera): el próximo
   *  ensureSession vuelve a correr openSessionOnce — resolveBase (`cp.sh serve` re-wrappea
   *  opencode con el token AV vigente; idempotente si no hay mismatch) + POST /session FRESCA
   *  (contexto reseteado de verdad). Lo llama el createSession del backend (path de /new). */
  unbind(sessionId: string): void {
    this.bound.delete(sessionId);
    this.ensuring.delete(sessionId);
  }

  /** Crea (o reusa) la sesión opencode en el serve de la VM y cachea el binding.
   *  Dedup en vuelo: en modo VM resolveBase tarda segundos → si attach y send la
   *  llaman a la vez, sin dedup crearían 2 sesiones/túneles y el stream quedaría en
   *  otra sesión que el prompt (→ timeout). `opts.role` (sólo relevante al ABRIR la sesión:
   *  un binding ya vivo no cambia de agente) selecciona el agente de opencode: "worker" →
   *  `workerAgent` (tools completas, sin spawn — REM/batch); default → `agent` (coordinador).
   *  El rol queda pegado al binding → cada prompt de la sesión viaja con ESE agente. */
  async ensureSession(
    sessionId: string,
    opts?: { role?: "coordinator" | "worker"; model?: SessionConfig["localModel"] },
  ): Promise<void> {
    if (this.bound.has(sessionId)) return;
    let inflight = this.ensuring.get(sessionId);
    if (!inflight) {
      inflight = this.doEnsure(sessionId, opts).finally(() => this.ensuring.delete(sessionId));
      this.ensuring.set(sessionId, inflight);
    }
    return inflight;
  }

  private async doEnsure(
    sessionId: string,
    opts?: { role?: "coordinator" | "worker"; model?: SessionConfig["localModel"] },
  ): Promise<void> {
    const attempts = Math.max(1, this.cfg.connectAttempts ?? 8);
    let backoff = this.cfg.connectBackoffMs ?? 500;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.openSessionOnce(sessionId, opts);
        return;
      } catch (e) {
        // 4xx → la VM responde pero la request es inválida: no tiene sentido reintentar.
        if (e instanceof NonRetryable) throw e;
        lastErr = e;
        if (i < attempts - 1) {
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, 5000);
        }
      }
    }
    throw new Error(
      `opencode cold-start de ${sessionId} falló tras ${attempts} intentos: ${(lastErr as Error)?.message ?? String(lastErr)}`,
    );
  }

  /** Un intento de resolver la base (re-corre `cp.sh serve`, que es idempotente y reasegura el
   *  serve si la VM recién levanta) + POST /session. Lanza NonRetryable ante 4xx.
   *  `opts.role === "worker"` abre la sesión con el agente WORKER (tools completas, sin spawn):
   *  es el rol de REM y de los turnos batch — sin esto, REM caía al coordinador (sin tools de
   *  archivos) y gemma loopeaba reintentando `subagent_spawn` 40 min (bug real de prod). */
  private async openSessionOnce(
    sessionId: string,
    opts?: { role?: "coordinator" | "worker"; model?: SessionConfig["localModel"] },
  ): Promise<void> {
    const t0 = Date.now();
    const base = (await this.cfg.resolveBase(sessionId)).replace(/\/$/, "");
    const tServe = Date.now();
    const agent = opts?.role === "worker" ? (this.cfg.workerAgent ?? this.cfg.agent) : this.cfg.agent;
    const model = this.modelFor(opts);
    const options = this.optionsFor(opts?.role ?? "coordinator", model);
    const ses = await this.postSession(base, {
      title: (this.cfg.sessionTitle ?? ((id) => `ceibo · ${id}`))(sessionId),
      agent,
    });
    // Sub-timing del revival (quickboot): `serve` = resolveBase/cp.sh serve, `post` = POST /session.
    const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    console.log(`⏱ session[${sessionId}] serve:${s(tServe - t0)} post:${s(Date.now() - tServe)}`);
    this.bound.set(sessionId, { base, ses, agent, model, role: opts?.role ?? "coordinator", options });
  }

  private modelFor(opts?: { role?: "coordinator" | "worker"; model?: SessionConfig["localModel"] }): {
    providerID: string;
    modelID: string;
  } {
    if (opts?.model?.modelID) {
      return { providerID: opts.model.providerID ?? this.cfg.providerID, modelID: opts.model.modelID };
    }
    const modelID =
      opts?.role === "worker"
        ? (this.cfg.workerModelID ?? this.cfg.modelID)
        : (this.cfg.coordinatorModelID ?? this.cfg.modelID);
    return { providerID: this.cfg.providerID, modelID };
  }

  private optionsFor(
    role: "coordinator" | "worker",
    model: { providerID: string; modelID: string },
  ): Record<string, unknown> | undefined {
    const explicit = role === "worker" ? this.cfg.workerOptions : this.cfg.coordinatorOptions;
    if (explicit) return explicit;
    // `enable_thinking`/`preserve_thinking` son kwargs del CHAT TEMPLATE de Qwen3 (su template
    // los lee para prender/apagar el bloque <think>). Gemma 4 NO los define en su template y vLLM
    // tira TemplateError al pasarle un kwarg que el template no acepta → el prompt nunca completa
    // (el turno cuelga: incidente 2026-06-14, "no me responde"). Por eso SÓLO auto-inyectamos
    // estos kwargs para modelos Qwen; para Gemma (y cualquier otro) devolvemos undefined y dejamos
    // que opencode mande el prompt sin `options`. Un override explícito por env (coordinator/worker
    // Options) gana siempre — para esos el operador es responsable de pasar kwargs compatibles.
    if (!isQwen(model.modelID)) return undefined;
    return role === "worker"
      ? { openai: { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } } }
      : { openai: { chat_template_kwargs: { enable_thinking: false } } };
  }

  /** POST /session contra `base` → id de la sesión opencode (ses_…). Lanza NonRetryable ante 4xx
   *  (la VM responde pero la request es mala) y Error reintentables ante 5xx/sin-id. El body lleva
   *  `title` (NO-default → mata el round-trip de generación de título) y `agent` (selecciona el
   *  agente custom de opencode.json). Campos undefined se omiten. */
  private async postSession(base: string, opts?: { title?: string; agent?: string }): Promise<string> {
    const body: Record<string, unknown> = {};
    if (opts?.title) body.title = opts.title;
    if (opts?.agent) body.agent = opts.agent;
    const res = await this.fetch(`${base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const msg = `opencode POST /session ${res.status}: ${await safeText(res)}`;
      throw res.status < 500 ? new NonRetryable(msg) : new Error(msg);
    }
    const j = (await res.json()) as { id?: string; sessionID?: string };
    const ses = j.id ?? j.sessionID;
    if (!ses) throw new Error(`opencode /session sin id: ${JSON.stringify(j).slice(0, 200)}`);
    return ses;
  }

  /** Abre una sesión opencode NUEVA en la VM ya viva de `vmSessionId` (la del coordinador) y la
   *  registra bajo una clave lógica propia (mismo `base`, `ses` distinto). resolveBase re-asegura el
   *  serve (idempotente) pero NO spawnea la VM → cero clones por worker. El binding pre-poblado deja
   *  que attach/prompt/abort/events del worker funcionen sin re-resolver (ensureSession corta corto
   *  cuando `bound` ya tiene la clave). */
  async openWorkerSession(vmSessionId: string): Promise<string> {
    const base = (await this.cfg.resolveBase(vmSessionId)).replace(/\/$/, "");
    // El worker corre como sesión PROPIA con SU agente (ej. "ceibo-worker"): tiene todas las tools
    // de archivos (a diferencia del coordinador). Cae a `agent` si no se configuró uno aparte.
    const agent = this.cfg.workerAgent ?? this.cfg.agent;
    const model = this.modelFor({ role: "worker" });
    const options = this.optionsFor("worker", model);
    const ses = await this.postSession(base, {
      title: (this.cfg.workerTitle ?? ((id) => `ceibo-worker · ${id}`))(vmSessionId),
      agent,
    });
    const logical = `${vmSessionId}#worker:${ses}`;
    this.bound.set(logical, { base, ses, agent, model, role: "worker", options });
    return logical;
  }

  private async bind(sessionId: string): Promise<Bound> {
    await this.ensureSession(sessionId);
    const b = this.bound.get(sessionId);
    if (!b) throw new Error(`sesión no vinculada: ${sessionId}`);
    return b;
  }

  async prompt(sessionId: string, parts: unknown[]): Promise<unknown> {
    const bound = await this.bind(sessionId);
    const { base, ses, agent, model, options } = bound;
    const body = JSON.stringify({
      parts,
      model,
      ...(options ? { options } : {}),
      // `agent` selecciona el agente custom de opencode.json para ESTE prompt (coordinador vs
      // worker). Omitido si la sesión no tiene agente fijado → cae al default_agent.
      ...(agent ? { agent } : {}),
    });
    logThinkingOptions(bound);
    const res = await this.fetch(`${base}/session/${ses}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!res.ok) throw new Error(`opencode prompt_async ${res.status}: ${await safeText(res)}`);
    return res.json().catch(() => ({}));
  }

  async abort(sessionId: string): Promise<unknown> {
    const { base, ses } = await this.bind(sessionId);
    const res = await this.fetch(`${base}/session/${ses}/abort`, { method: "POST" });
    return res.ok ? res.json().catch(() => ({})) : {};
  }

  /** Compactación manual on-demand (comando `/compact`): `POST /session/:id/summarize`. opencode
   *  1.17.8 necesita el modelo en el body (`{providerID, modelID}`) para generar el resumen — el
   *  mismo `bound.model` que usa `prompt`. Dispara `session.compacted` (lo relaya el translator). */
  async summarize(sessionId: string): Promise<unknown> {
    const { base, ses, model } = await this.bind(sessionId);
    const res = await this.fetch(`${base}/session/${ses}/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerID: model.providerID, modelID: model.modelID }),
    });
    if (!res.ok) throw new Error(`opencode summarize ${res.status}: ${await safeText(res)}`);
    return res.json().catch(() => ({}));
  }

  async setAgentConfig(sessionId: string, cfg: AgentConfig): Promise<void> {
    // El binding asegura la sesión y resuelve `base`; el API /mcp es GLOBAL por instancia de
    // opencode (NO por sesión: no toma sessionId), así que reconciliamos sobre `base`, no `ses`.
    const { base } = await this.bind(sessionId);
    // Traducimos la forma Anthropic (mcp_servers/tools) al `mcp` de opencode: opencode ignora la
    // forma cruda de MA. Las credenciales NO viajan (las inyecta el AV); `oauth:false` evita que
    // opencode arranque su propio flujo OAuth. OJO: el session PATCH NO conecta MCPs (opencode lo
    // ignora) → usamos el API dedicado POST /mcp, que agrega Y conecta el server.
    const desired = toOpencodeAgentConfig(cfg).mcp;
    await this.reconcileMcp(base, desired);
  }

  /** Reconcilia el set de MCP servers conectados en la instancia de opencode (`base`) con el set
   *  deseado: conecta los que faltan (POST /mcp), reconecta los que cambiaron de url, y desconecta
   *  los que ya no se quieren (revocados). Best-effort por server: un MCP que falla se loguea y no
   *  tira abajo el resto (pero un fallo de TODO el GET inicial sí se propaga).
   *
   *  Rate-limit del AV (bug D): los connects van SECUENCIALES con un pacing entre cada uno
   *  (`mcpPaceMs`, default 1500ms) — el MITM del Agent Vault limita ~10 req/40s por agente y un
   *  burst de ~10 POSTs /mcp (que opencode conecta a través del proxy) lo agota → 429 masivo.
   *  El pacing sólo aplica entre connects REALES (los servers ya conectados/idempotentes no pagan). */
  private async reconcileMcp(base: string, desired: Record<string, OpencodeRemoteMcp>): Promise<void> {
    const t0 = Date.now();
    const current = await this.getMcpStatus(base);
    // Concurrencia acotada (reemplaza el pacing serial): cap < 10 nunca agota el bucket per-agente
    // del AV en el burst inicial; el verify+retry cubre cualquier 429/SSE-flaky restante.
    const cap = Math.max(1, this.cfg.mcpConnectConcurrency ?? 8);
    // Sub-timing del revival (quickboot): cuántos MCP ya estaban conectados (idempotentes, gratis)
    // vs cuántos hubo que (re)conectar. Distingue "re-montar de más" de "reconnect lento".
    const wanted = Object.keys(desired).length;
    let reused = 0;
    // Conectar / reconectar los deseados EN PARALELO (cap). Los ya-conectados con la misma url son
    // idempotentes (skip). `disconnect→connect` de cada server corre como unidad dentro del cap.
    const toConnect = Object.entries(desired).filter(([name, conf]) => {
      const cur = current.get(name);
      if (cur?.status === "connected" && cur.url === conf.url) {
        reused++;
        return false;
      }
      return true;
    });
    const connected = toConnect.length;
    await this.runCapped(toConnect, cap, async ([name, conf]) => {
      // Existe pero cambió la url (o no está connected) → disconnect antes de re-agregar, así el
      // POST /mcp no choca con un registro previo stale.
      if (current.get(name)) await this.disconnectMcp(base, name);
      await this.connectMcp(base, name, conf);
    });
    // VERIFY + RETRY (incidente 2026-06-18: tras un respawn masivo —rebuild de golden— todas las
    // VMs reconectan sus ~16 MCP a la vez contra el MITM del AV COMPARTIDO → thundering herd → 429,
    // y algunos servers dan POST 200 pero el SSE falla async después ("Unable to connect") → quedan
    // `failed` para siempre, porque reconcile sólo corría al cambiar el set. `connectMcp` no se
    // entera de la falla async del SSE: hay que CONSULTAR el estado real (GET /mcp) y reintentar los
    // que NO quedaron `connected` (disconnect→re-POST), también en paralelo acotado. Cubre 429 y SSE flaky.
    const rounds = this.cfg.mcpVerifyRounds ?? 3;
    for (let round = 0; round < rounds; round++) {
      const status = await this.getMcpStatus(base);
      const failed = Object.entries(desired).filter(([name]) => status.get(name)?.status !== "connected");
      if (failed.length === 0) break;
      await this.runCapped(failed, cap, async ([name, conf]) => {
        await this.disconnectMcp(base, name); // limpiar el registro `failed` antes de re-POSTear
        await this.connectMcp(base, name, conf);
      });
    }
    // Desconectar los que sobran (el user revocó el MCP).
    for (const name of current.keys()) {
      if (!(name in desired)) await this.disconnectMcp(base, name);
    }
    console.log(
      `⏱ mcp reconcile:${((Date.now() - t0) / 1000).toFixed(1)}s ` +
        `wanted:${wanted} reused:${reused} reconnected:${connected}`,
    );
  }

  /** Corre `fn` sobre `items` con a lo sumo `cap` en vuelo. Best-effort: un item que lanza se
   *  loguea y NO corta el resto (igual que el loop serial previo; el verify+retry lo re-intenta).
   *  Los workers consumen de un índice compartido → cap real respetado (no batches discretos). */
  private async runCapped<T>(items: T[], cap: number, fn: (item: T) => Promise<void>): Promise<void> {
    let i = 0;
    const worker = async (): Promise<void> => {
      while (i < items.length) {
        const item = items[i++];
        if (item === undefined) return;
        try {
          await fn(item);
        } catch (e) {
          console.warn(`reconcileMcp: connect falló: ${(e as Error)?.message ?? String(e)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(cap, items.length) }, worker));
  }

  /** GET /mcp → mapa name → {status, url?}. La url puede no venir en el estado; la usamos sólo
   *  como hint para evitar reconectar de gusto. Un fallo acá se propaga (no podemos reconciliar
   *  a ciegas: arriesgaríamos dejar MCPs viejos conectados). */
  private async getMcpStatus(base: string): Promise<Map<string, { status?: string; url?: string }>> {
    const res = await this.fetch(`${base}/mcp`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`opencode GET /mcp ${res.status}: ${await safeText(res)}`);
    const j = (await res.json().catch(() => ({}))) as Record<
      string,
      { status?: string; config?: { url?: string }; url?: string }
    >;
    const out = new Map<string, { status?: string; url?: string }>();
    for (const [name, v] of Object.entries(j ?? {})) {
      out.set(name, { status: v?.status, url: v?.config?.url ?? v?.url });
    }
    return out;
  }

  /** POST /mcp {name, config} → agrega Y conecta el server. Best-effort: loguea y sigue.
   *  429 del AV (bug D): si el rate-limit del Agent Vault rebota el connect, honramos
   *  `Retry-After` (segundos; default 40s si no viene) y reintentamos ESTE server hasta 2 veces
   *  antes de marcarlo fallido. Un server fallido NO aborta el resto del reconcile. */
  private async connectMcp(base: string, name: string, config: OpencodeRemoteMcp): Promise<void> {
    const maxRetries = 2; // reintentos ante 429 (3 intentos en total)
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetch(`${base}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, config }),
        });
      } catch (e) {
        console.warn(`opencode POST /mcp ${name} falló: ${(e as Error)?.message ?? String(e)}`);
        return;
      }
      if (res.ok) return;
      if (res.status === 429 && attempt < maxRetries) {
        // Retry-After en segundos (header real del MITM del AV). Sin header (o inválido) → 40s,
        // el valor medido de la ventana del límite.
        const ra = Number(res.headers?.get?.("retry-after"));
        const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 40_000;
        console.warn(
          `opencode POST /mcp ${name} 429 (rate-limit del AV) → reintento ${attempt + 1}/${maxRetries} en ${waitMs}ms`,
        );
        await this.sleep(waitMs);
        continue;
      }
      console.warn(`opencode POST /mcp ${name} ${res.status}: ${await safeText(res)}`);
      return;
    }
  }

  /** POST /mcp/{name}/disconnect. Best-effort: loguea y sigue. */
  private async disconnectMcp(base: string, name: string): Promise<void> {
    try {
      const res = await this.fetch(`${base}/mcp/${name}/disconnect`, { method: "POST" });
      if (!res.ok) {
        console.warn(`opencode POST /mcp/${name}/disconnect ${res.status}: ${await safeText(res)}`);
      }
    } catch (e) {
      console.warn(`opencode disconnect ${name} falló: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  /** Nombre de VM de un sessionId lógico: el id del worker es `<vm>#worker:<ses>` → la parte
   *  antes del marcador. Un id de coordinador ES el nombre de VM. */
  private vmOf(sessionId: string): string {
    return sessionId.split("#worker:")[0] ?? sessionId;
  }

  /** Recuperación ACTIVA tras cortes repetidos del stream de eventos (reboot del host / de la
   *  VM): re-resuelve la base (corre `cp.sh serve`, que re-asegura el serve — y con el retry de
   *  assign del factory, re-mintea el token AV si hace falta) y verifica si la sesión opencode
   *  sigue existiendo en esa base.
   *  - sigue viva → re-apunta el binding (la IP pudo cambiar) y devuelve "rebound".
   *  - el server responde pero la sesión no existe → invalida el binding (el próximo
   *    ensureSession abre una FRESCA) y devuelve "session-lost".
   *  - nada responde aún → "unreachable" (el caller sigue con backoff). */
  async recover(sessionId: string): Promise<RecoverResult> {
    const b = this.bound.get(sessionId);
    if (!b) return "rebound"; // sin binding: el próximo ensure ya abre de cero
    let base: string;
    try {
      base = (await this.cfg.resolveBase(this.vmOf(sessionId))).replace(/\/$/, "");
    } catch {
      return "unreachable";
    }
    try {
      const res = await this.fetch(`${base}/session/${b.ses}`, {
        headers: { accept: "application/json" },
      });
      if (res.ok) {
        b.base = base; // la sesión sobrevivió (opencode la persiste a disco) — sólo re-apuntar
        return "rebound";
      }
      if (res.status >= 400 && res.status < 500) {
        this.unbind(sessionId); // confirmado: la sesión ya no existe en la VM
        return "session-lost";
      }
      return "unreachable"; // 5xx: el serve todavía está levantando
    } catch {
      return "unreachable";
    }
  }

  /** Stream del bus SSE global, filtrado ESTRICTO a los eventos de ESTA sesión (bug E).
   *
   *  El filtro viejo sólo miraba `properties.sessionID` y DEJABA PASAR todo evento que no lo
   *  trajera ahí — pero opencode anida el id según el tipo: `message.part.updated` lo lleva en
   *  `properties.part.sessionID` y `message.updated` en `properties.info.sessionID`. Con
   *  coordinador + worker en la MISMA VM (mismo bus /event), cada pump recibía los text/tool/
   *  step-finish de AMBAS sesiones → frames duplicados al canal y usage del worker asentado al
   *  coordinador. Ahora un evento sólo pasa si TRAE el id de nuestra sesión en alguna de sus
   *  formas; los eventos sin atribución de sesión (server.connected, etc.) se DESCARTAN — el
   *  translator no los usa y dejarlos pasar era la fuga.
   *
   *  `opts.signal` (lo pasa el attach del backend): abortar el signal corta el fetch del SSE de
   *  verdad — sin esto, `Relay.close()` era sólo un flag y el pump quedaba vivo (acumulando
   *  streams con cada re-attach). */
  async *events(sessionId: string, opts?: { signal?: AbortSignal }): AsyncIterable<OpencodeEvent> {
    const { base, ses } = await this.bind(sessionId);
    // Watchdog de inactividad (incidente 2026-06-10): el SSE atraviesa el subnet route del
    // tailnet; si el host se reinicia, el TCP muere SIN FIN/RST y el read() de abajo queda
    // parqueado para siempre — cuelgue silencioso. Como opencode manda `server.heartbeat` cada
    // 10s, una conexión sana NUNCA calla `idleTimeoutMs` (default 45s): silencio = socket
    // zombie → abortamos el fetch nosotros y tiramos StreamIdleError para que el pump reconecte.
    // El abort del CONSUMIDOR (opts.signal, el close() del relay) se encadena al mismo controller.
    const idleMs = this.cfg.idleTimeoutMs ?? DEFAULT_EVENT_IDLE_TIMEOUT_MS;
    const inner = new AbortController();
    const onOuterAbort = () => inner.abort();
    if (opts?.signal?.aborted) inner.abort();
    opts?.signal?.addEventListener("abort", onOuterAbort, { once: true });
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idled = false;
    const armIdle = (): void => {
      if (idleMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idled = true;
        inner.abort();
      }, idleMs);
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const res = await this.fetch(`${base}/event`, {
        headers: { accept: "text/event-stream" },
        signal: inner.signal,
      });
      if (!res.ok || !res.body) throw new Error(`opencode GET /event ${res.status}`);
      reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      armIdle();
      while (true) {
        let value: Uint8Array | undefined;
        let done: boolean;
        try {
          ({ value, done } = await reader.read());
        } catch (e) {
          // El throw del read puede venir del abort del WATCHDOG (silencio anómalo) o del abort
          // del consumidor (close del relay). Sólo el primero se re-tipa como StreamIdleError.
          if (idled && !opts?.signal?.aborted) {
            throw new StreamIdleError(
              `stream de eventos sin tráfico por ${idleMs}ms (sin heartbeats) → conexión zombie`,
            );
          }
          throw e;
        }
        if (done) {
          if (idled && !opts?.signal?.aborted) {
            throw new StreamIdleError(
              `stream de eventos sin tráfico por ${idleMs}ms (sin heartbeats) → conexión zombie`,
            );
          }
          return;
        }
        armIdle(); // llegaron bytes (evento o heartbeat) → la conexión está viva
        buf += dec.decode(value, { stream: true });
        // SSE: eventos separados por línea en blanco; payload en líneas `data:`.
        let nl: number;
        // biome-ignore lint/suspicious/noAssignInExpressions: parser SSE idiomático
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          if (!data || data === "[DONE]") continue;
          let ev: OpencodeEvent;
          try {
            ev = JSON.parse(data) as OpencodeEvent;
          } catch {
            continue;
          }
          // el bus es global → SOLO pasan los eventos atribuidos a NUESTRA sesión
          if (!belongsToSession(ev, ses)) continue;
          yield ev;
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      opts?.signal?.removeEventListener("abort", onOuterAbort);
      // Cierre del consumidor (close/abort del relay, o "terminated" del translator): soltamos el
      // reader → el socket SSE se libera en vez de quedar abierto hasta el GC.
      reader?.cancel().catch(() => {});
    }
  }
}

/** ¿El evento del bus global pertenece a la sesión `ses`? opencode anida el sessionID según el
 *  tipo de evento: top-level (`session.idle`, `session.error`), dentro del part
 *  (`message.part.updated`), dentro del info de message (`message.updated`), o como `info.id`
 *  en los eventos de ciclo de vida de sesión (`session.deleted`/`session.updated`, donde `info`
 *  ES la sesión). Estricto: sin atribución reconocible → false (no se traduce). */
export function belongsToSession(ev: OpencodeEvent, ses: string): boolean {
  const p = ev.properties;
  if (!p) return false;
  if (p.sessionID) return p.sessionID === ses;
  if (p.part?.sessionID) return p.part.sessionID === ses;
  if (p.info?.sessionID) return p.info.sessionID === ses;
  // Eventos de sesión (session.deleted/terminated/updated): el objeto `info` es la SESIÓN → su
  // `id` es el id de sesión. Sólo para `session.*` (en message.* `info.id` es el id del MENSAJE).
  if (ev.type.startsWith("session.") && p.info?.id) return p.info.id === ses;
  return false;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
