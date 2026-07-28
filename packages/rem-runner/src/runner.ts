// Runner per-wiki de REM en gpuhost: dado (wikiName, pushToken, scope) clona la wiki a un scratch
// efímero, planifica (gemma local por default; sonnet opt-in vía REM_PLANNER_PROVIDER=anthropic),
// ejecuta con gemma (opencode-serve en el host de gpuhost), y devuelve un resultado JSON. Ninguna
// wiki persiste al salir (rm -rf del scratch siempre, incluso ante error).
//
// TODO(aislamiento-egress): el executor hoy corre en el host sin restriccion de egress. El siguiente
// hardening es acotar su egress a solo push (ceibo.example.com) + vLLM local (:8000), sin internet.
// Opciones: netns por-proceso, iptables owner-match, o container minimo. Pospuesto a Fase-egress.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRemPlannerPrompt,
  formatRemPlanForExecutor,
  parseRemStructuredPlan,
  type RemStructuredPlan,
  remPlanHasWork,
} from "@ceibo/gateway/logic";

// --- Tipos publicos -------------------------------------------------------

export type RemRunnerStatus = "revisada" | "sin-cambios" | "error";

export interface RemRunnerResult {
  wiki: string;
  status: RemRunnerStatus;
  /** Costo estimado en USD (planner), 0 si no se uso. */
  cost: number;
  /** Resumen breve (del plan o del executor). */
  summary: string;
  /** Detalles de error, solo cuando status="error". */
  error?: string;
}

// --- Configuracion inyectable (sin hardcodear secretos) -------------------

export interface RemRunnerConfig {
  /** URL base del proxy git (ej. "https://ceibo.example.com/api/git"). */
  gitProxyBase: string;
  /** Token de push scopeado a esta wiki (Authorization: Bearer <token>). */
  pushToken: string;
  /** URL base de opencode-serve en gpuhost (ej. "http://127.0.0.1:4200"). */
  opencodeBase: string;
  /** providerID/modelID de gemma en opencode (ej. "local/gemma4-31b"). */
  gemmaModel: string;
  /** API key de Anthropic para el planner sonnet (leida de ~/.archima/anthropic.key). */
  anthropicKey: string;
  /** Proveedor del planner (default: "vllm" = gemma local, OpenAI-compat). "anthropic" = sonnet. */
  plannerProvider?: "anthropic" | "vllm";
  /** Modelo del planner. Default segun proveedor: anthropic→"claude-sonnet-4-6", vllm→modelID de gemmaModel. */
  plannerModel?: string;
  /** Base OpenAI-compatible de vLLM para el planner gemma (default: "http://127.0.0.1:8000/v1"). */
  vllmBase?: string;
  /** API key de vLLM (leida de ~/inference/api_key.txt; "sk-no-key" si no hace falta). */
  vllmKey?: string;
  /** Timeout del planner en ms (default: 120_000). */
  plannerTimeoutMs?: number;
  /** Timeout del executor opencode en ms (default: 300_000). */
  executorTimeoutMs?: number;
  /** Nombre git del autor de los commits de REM. */
  gitAuthorName?: string;
  /** Email git del autor de los commits de REM. */
  gitAuthorEmail?: string;
}

/** Default holgado del timeout del executor: un first-pass real (pasada COMPLETA) puede dar
 *  ~92 steps / ~360s (e2e barilooo 2026-06-15). 300s cortaba esos a la mitad y se veian como
 *  exito falso. 15min deja margen; configurable por REM_EXECUTOR_TIMEOUT_MS. */
export const DEFAULT_EXECUTOR_TIMEOUT_MS = 900_000;

/** Proveedor del planner por default: gemma local (vLLM). El planner anthropic (sonnet) es opt-in
 *  vía REM_PLANNER_PROVIDER=anthropic. REM corre así 100% local/gratis por default. */
export const DEFAULT_PLANNER_PROVIDER = "vllm" as const;

// --- Helpers internos -----------------------------------------------------

/** Borra un directorio de forma incondicional (always-run). */
export function wipeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort: si no se puede borrar, no es razon para tirar el proceso.
  }
}

/** Crea un directorio temporal unico y devuelve su path. */
export function makeScratch(): string {
  return mkdtempSync(join(tmpdir(), "rem-wiki-"));
}

/** Clona la wiki al scratch usando el proxy git con el token. */
export function cloneWiki(wikiName: string, cfg: RemRunnerConfig, scratchDir: string): void {
  const cloneUrl = `${cfg.gitProxyBase}/${wikiName}`;
  const result = spawnSync(
    "git",
    ["-c", `http.extraHeader=Authorization: Bearer ${cfg.pushToken}`, "clone", cloneUrl, scratchDir],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(`git clone fallo (${String(result.status)}): ${stderr.slice(0, 300)}`);
  }
}

/** Lee el contenido de todos los archivos .md bajo el scratch para pasarlo al planner. */
export function readWikiContent(scratchDir: string): string {
  const result = spawnSync("git", ["-C", scratchDir, "ls-files", "--", "*.md"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) return "(no se pudo listar archivos)";
  const files = result.stdout.trim().split("\n").filter(Boolean);
  if (files.length === 0) return "(wiki vacia)";
  const parts: string[] = [];
  for (const f of files.slice(0, 200)) {
    try {
      const content = readFileSync(join(scratchDir, f), "utf8");
      parts.push(`=== ${f} ===\n${content}`);
    } catch {
      parts.push(`=== ${f} === (error al leer)`);
    }
  }
  return parts.join("\n\n");
}

/** SHA del HEAD actual del scratch (para detectar si el executor commiteo algo nuevo). null si
 *  no se puede leer (repo sin commits / error de git). */
export function gitHead(scratchDir: string): string | null {
  const result = spawnSync("git", ["-C", scratchDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  const sha = result.stdout.trim();
  return sha || null;
}

/** Aborta la sesion opencode (best-effort): la para para que el executor deje de escribir en el
 *  scratch ANTES de que lo wipeemos (evita la race wipe-mientras-vivo + errores server-side). */
async function abortSession(base: string, ses: string): Promise<void> {
  try {
    await fetch(`${base}/session/${ses}/abort`, { method: "POST" });
  } catch {
    // best-effort: si el abort falla, igual seguimos (el timeout ya corto el stream).
  }
}

/** Llama al planner (Anthropic sonnet o gemma vLLM segun cfg.plannerProvider) y devuelve el plan. */
export async function runPlanner(
  wikiName: string,
  scope: string,
  wikiContent: string,
  cfg: RemRunnerConfig,
): Promise<{ plan: RemStructuredPlan | undefined; cost: number; rawResponse: string }> {
  const timeout = cfg.plannerTimeoutMs ?? 120_000;
  const systemPrompt = buildRemPlannerPrompt(wikiName, scope);
  const userMsg = `Contenido actual de la wiki "${wikiName}":\n\n${wikiContent}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const { rawResponse, cost } =
      (cfg.plannerProvider ?? DEFAULT_PLANNER_PROVIDER) === "vllm"
        ? await plannerVllm(systemPrompt, userMsg, cfg, ctrl.signal)
        : await plannerAnthropic(systemPrompt, userMsg, cfg, ctrl.signal);
    const plan = parseRemStructuredPlan(rawResponse);
    return { plan, cost, rawResponse };
  } finally {
    clearTimeout(timer);
  }
}

/** Planner via Anthropic Messages API (sonnet por default). Costo estimado en USD. */
async function plannerAnthropic(
  systemPrompt: string,
  userMsg: string,
  cfg: RemRunnerConfig,
  signal: AbortSignal,
): Promise<{ rawResponse: string; cost: number }> {
  const model = cfg.plannerModel ?? "claude-sonnet-4-6";
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": cfg.anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userMsg }],
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Anthropic API ${String(response.status)}: ${body.slice(0, 200)}`);
  }
  const json = (await response.json()) as {
    content?: { type: string; text: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const rawResponse = json.content?.find((b) => b.type === "text")?.text ?? "";
  // Costo estimado (sonnet-4-6: $3/$15 por 1M tokens in/out).
  const inputTokens = json.usage?.input_tokens ?? 0;
  const outputTokens = json.usage?.output_tokens ?? 0;
  const cost = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
  return { rawResponse, cost };
}

/** Planner via vLLM local (OpenAI Chat Completions). Modelo = gemma; costo 0 (local). */
async function plannerVllm(
  systemPrompt: string,
  userMsg: string,
  cfg: RemRunnerConfig,
  signal: AbortSignal,
): Promise<{ rawResponse: string; cost: number }> {
  const base = (cfg.vllmBase ?? "http://127.0.0.1:8000/v1").replace(/\/$/, "");
  // Default: el modelID de gemmaModel ("local/gemma4-31b" → "gemma4-31b"), salvo override explicito.
  const slash = cfg.gemmaModel.indexOf("/");
  const model = cfg.plannerModel ?? (slash >= 0 ? cfg.gemmaModel.slice(slash + 1) : cfg.gemmaModel);
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.vllmKey ?? "sk-no-key"}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`vLLM ${base} ${String(response.status)}: ${body.slice(0, 200)}`);
  }
  const json = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const rawResponse = json.choices?.[0]?.message?.content ?? "";
  return { rawResponse, cost: 0 };
}

/** Arma el prompt del executor gemma a partir del plan. */
function buildExecutorPrompt(wikiName: string, plan: RemStructuredPlan): string {
  const planText = formatRemPlanForExecutor(plan);
  return (
    `Sos el ejecutor de REM para la wiki "${wikiName}". Tenes el directorio de la wiki ` +
    `disponible en tu directorio de trabajo. Ejecuta EXACTAMENTE el siguiente plan -- ni mas ` +
    `ni menos. NO consultes al usuario; ejecuta las acciones de punta a punta:\n\n` +
    `${planText}\n\n` +
    `CONVENCION DE LAS WIKIS (importante, respetala):\n` +
    `- Un archivo .md es una nota; las carpetas son workspaces.\n` +
    `- ARCHIVAR una nota = (1) BORRAR el archivo .md de su carpeta y (2) agregar UNA linea al ` +
    `.archived.md de ESA carpeta (crealo si no existe) con el formato exacto: ` +
    `"- [titulo](archivo.md) — fecha — preview". NO muevas la nota a una carpeta archive/ ` +
    `(NO uses git mv a archive/): la nota queda viva en la historia de git, no en una carpeta.\n` +
    `- NUNCA quites lineas de un .archived.md existente ni lo "limpies".\n` +
    `- MOVER una nota entre workspaces = escribir el archivo en el destino y borrarlo en el origen.\n\n` +
    `Al terminar: hace UN commit con todos los cambios (mensaje: "REM: ${plan.summary.slice(0, 72)}") ` +
    `y luego termina. NO hagas push vos (lo hace el runner por separado). ` +
    `Tu ULTIMO mensaje debe ser una linea de resumen de que cambiaste.`
  );
}

/** Destila el sessionID desde las propiedades de un evento SSE de opencode. */
function sessionIdOf(ev: Record<string, unknown>): string | undefined {
  const p = ev.properties as Record<string, unknown> | undefined;
  if (!p) return undefined;
  if (typeof p.sessionID === "string") return p.sessionID;
  const part = p.part as Record<string, unknown> | undefined;
  if (typeof part?.sessionID === "string") return part.sessionID;
  const info = p.info as Record<string, unknown> | undefined;
  if (typeof info?.sessionID === "string") return info.sessionID;
  const evType = ev.type as string | undefined;
  if (evType?.startsWith("session.") && typeof info?.id === "string") return info.id;
  return undefined;
}

/** Llama a opencode-serve en el host de gpuhost y espera la respuesta.
 *  Devuelve `idle:true` SOLO si llego `session.idle` (el executor termino solo); `idle:false`
 *  significa que vencio `executorTimeoutMs` (lo cortamos nosotros) — el caller NO debe tratar eso
 *  como exito. Ante timeout abortamos la sesion opencode ANTES de devolver, para que gemma deje de
 *  escribir en el scratch antes de que lo wipeemos. */
export async function runExecutor(
  wikiName: string,
  plan: RemStructuredPlan,
  scratchDir: string,
  cfg: RemRunnerConfig,
): Promise<{ summary: string; idle: boolean }> {
  const base = cfg.opencodeBase.replace(/\/$/, "");
  const timeout = cfg.executorTimeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS;
  const prompt = buildExecutorPrompt(wikiName, plan);

  // Partir "local/gemma4-31b" en providerID + modelID.
  const slash = cfg.gemmaModel.indexOf("/");
  const providerID = slash >= 0 ? cfg.gemmaModel.slice(0, slash) : "local";
  const modelID = slash >= 0 ? cfg.gemmaModel.slice(slash + 1) : cfg.gemmaModel;

  // El working dir (donde corre el executor: el clon de la wiki) se setea por query param
  // `?directory=` (opencode 1.17.4). El body de POST /session tiene additionalProperties:false y
  // IGNORA `cwd` → con cwd en el body la sesion corre contra el cwd del server (~/), no contra el
  // scratch. Lo pasamos URL-encoded en ambos endpoints (la spec lo acepta en /session y en prompt_async).
  const dirQuery = `?directory=${encodeURIComponent(scratchDir)}`;

  // 1. Crear sesion opencode con titulo no-default (evita round-trip de generacion de titulo).
  const sesRes = await fetch(`${base}/session${dirQuery}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: `rem-runner / ${wikiName}` }),
  });
  if (!sesRes.ok) {
    const body = await sesRes.text().catch(() => "");
    throw new Error(`opencode POST /session ${String(sesRes.status)}: ${body.slice(0, 200)}`);
  }
  const sesJson = (await sesRes.json()) as { id?: string; sessionID?: string };
  const sesMaybe = sesJson.id ?? sesJson.sessionID;
  if (!sesMaybe) throw new Error(`opencode /session sin id: ${JSON.stringify(sesJson).slice(0, 200)}`);
  const ses: string = sesMaybe;

  // 2. Mandar el prompt (async).
  const pRes = await fetch(`${base}/session/${ses}/prompt_async${dirQuery}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parts: [{ type: "text", text: prompt }],
      model: { providerID, modelID },
    }),
  });
  if (!pRes.ok) {
    const body = await pRes.text().catch(() => "");
    throw new Error(`opencode prompt_async ${String(pRes.status)}: ${body.slice(0, 200)}`);
  }

  // 3. Escuchar el bus SSE hasta session.idle para nuestra sesion, o timeout.
  let summary = "";
  let idle = false; // true SOLO si llego session.idle (exito); false = vencio el timeout.
  let timedOut = false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeout);

  try {
    // El bus SSE tambien hay que scopearlo con ?directory= (opencode 1.17.4): sin el param el
    // GET /event solo emite el stream GLOBAL (server.heartbeat/server.connected) y NUNCA los
    // session.idle/message.part.updated de la sesion del scratch -> el runner colgaria hasta el
    // executorTimeoutMs sin capturar el summary. Es el MISMO dir que /session y prompt_async.
    let evRes: Response;
    try {
      evRes = await fetch(`${base}/event${dirQuery}`, {
        headers: { accept: "text/event-stream" },
        signal: ctrl.signal,
      });
    } catch (e) {
      // Si el abort (timeout) llego durante el connect del SSE, no es un error de red real:
      // cae al manejo de timeout de abajo. Cualquier otro error si se propaga.
      if (timedOut) {
        return await finishExecutor();
      }
      throw e;
    }
    if (!evRes.ok || !evRes.body) {
      throw new Error(`opencode GET /event ${String(evRes.status)}`);
    }

    const dec = new TextDecoder();
    let buf = "";
    const reader = evRes.body.getReader();
    let nl: number;

    outer: while (true) {
      let value: Uint8Array | undefined;
      let done: boolean;
      try {
        ({ value, done } = await reader.read());
      } catch {
        break;
      }
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // biome-ignore lint/suspicious/noAssignInExpressions: parser SSE idiomatico
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data || data === "[DONE]") continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const evType = ev.type as string | undefined;
        const evSes = sessionIdOf(ev);
        if (evSes && evSes !== ses) continue; // filtro estricto de sesion

        // Capturar el ultimo texto del asistente.
        if (evType === "message.part.updated") {
          const props = ev.properties as Record<string, unknown> | undefined;
          const part = props?.part as Record<string, unknown> | undefined;
          if (part?.type === "text" && typeof part.text === "string") {
            summary = part.text;
          }
        }

        // session.idle en nuestra sesion -> el executor termino SOLO (exito).
        if (evType === "session.idle" && evSes === ses) {
          idle = true;
          reader.cancel().catch(() => {});
          break outer;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return await finishExecutor();

  // Cierre comun: si vencio el timeout, abortamos la sesion opencode (gemma deja de escribir el
  // scratch) ANTES de devolver, para que el wipe del caller no compita con escritura concurrente.
  async function finishExecutor(): Promise<{ summary: string; idle: boolean }> {
    if (!idle) {
      await abortSession(base, ses);
    }
    return { summary: summary.trim() || "(sin resumen del executor)", idle };
  }
}

/** Push del scratch al proxy: pull --rebase si rechaza, luego push de nuevo. */
function pushWithRebase(
  scratchDir: string,
  pushToken: string,
  _gitProxyBase: string,
  _wikiName: string,
): void {
  const extraHeader = `Authorization: Bearer ${pushToken}`;
  const pushArgs = ["-C", scratchDir, "-c", `http.extraHeader=${extraHeader}`, "push", "origin", "HEAD"];

  const result = spawnSync("git", pushArgs, { encoding: "utf8", timeout: 60_000 });
  if (result.status === 0) return;

  const stderr = (result.stderr ?? "").toLowerCase();
  const isRejected =
    stderr.includes("rejected") || stderr.includes("non-fast-forward") || stderr.includes("[rejected]");
  if (!isRejected) {
    throw new Error(`git push fallo (${String(result.status)}): ${(result.stderr ?? "").slice(0, 300)}`);
  }

  // Rebase y reintento.
  const rebaseResult = spawnSync(
    "git",
    ["-C", scratchDir, "-c", `http.extraHeader=${extraHeader}`, "pull", "--rebase", "origin", "HEAD"],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (rebaseResult.status !== 0) {
    throw new Error(`git pull --rebase tras push rechazado: ${(rebaseResult.stderr ?? "").slice(0, 300)}`);
  }

  // Segundo intento.
  const retry = spawnSync("git", pushArgs, { encoding: "utf8", timeout: 60_000 });
  if (retry.status !== 0) {
    throw new Error(
      `git push (reintento) fallo (${String(retry.status)}): ${(retry.stderr ?? "").slice(0, 300)}`,
    );
  }
}

// --- Entry publica --------------------------------------------------------

/**
 * Corre REM sobre una wiki: clonar -> planner (gemma/sonnet) -> executor (gemma) -> push -> wipe.
 * El scratch se borra SIEMPRE (incluso ante error).
 *
 * @param wikiName  Nombre del repo (ej. "ale-wiki")
 * @param cfg       Config inyectada (endpoints, tokens, keys)
 * @param scope     Scope del planner (delta de cambios o "primera corrida")
 */
export async function runRemForWiki(
  wikiName: string,
  cfg: RemRunnerConfig,
  scope: string,
): Promise<RemRunnerResult> {
  const scratch = makeScratch();

  try {
    // F3: Clonar a scratch efimero.
    cloneWiki(wikiName, cfg, scratch);

    // Configurar identidad git en el scratch (para los commits del executor).
    const gitAuthor = cfg.gitAuthorName ?? "REM Runner";
    const gitEmail = cfg.gitAuthorEmail ?? "rem@example.com";
    execSync(`git -C "${scratch}" config user.name "${gitAuthor}"`, {
      timeout: 5_000,
      stdio: "pipe",
    });
    execSync(`git -C "${scratch}" config user.email "${gitEmail}"`, {
      timeout: 5_000,
      stdio: "pipe",
    });

    // F4: Planner (gemma local por default; sonnet si REM_PLANNER_PROVIDER=anthropic).
    const wikiContent = readWikiContent(scratch);
    const { plan, cost, rawResponse } = await runPlanner(wikiName, scope, wikiContent, cfg);

    if (!plan) {
      console.error(
        `[rem-runner/${wikiName}] planner no devolvio plan valido. Raw: ${rawResponse.slice(0, 400)}`,
      );
      return {
        wiki: wikiName,
        status: "error",
        cost,
        summary: "planner no devolvio plan valido",
        error: "planner no devolvio plan valido",
      };
    }

    // Guard 1: should_execute + remPlanHasWork (no-op duro, no llama al executor).
    if (!plan.should_execute || !remPlanHasWork(plan)) {
      const reason = plan.report_for_user ?? plan.summary;
      console.log(`[rem-runner/${wikiName}] no-op: ${reason}`);
      return { wiki: wikiName, status: "sin-cambios", cost, summary: reason };
    }

    // Guard 2: requires_user_confirmation o risk=high -> pausa sin ejecutar.
    if (plan.requires_user_confirmation || plan.risk === "high") {
      const reason = plan.report_for_user ?? plan.summary;
      console.log(`[rem-runner/${wikiName}] plan en pausa (risk=${plan.risk}): ${reason}`);
      return {
        wiki: wikiName,
        status: "sin-cambios",
        cost,
        summary: `Plan en pausa (requiere confirmacion): ${reason}`,
      };
    }

    // F5: Executor (gemma via opencode). Capturamos el HEAD ANTES para verificar despues que el
    // executor commiteo algo (no confiamos en su palabra: revisada SOLO con commit verificado).
    const headBefore = gitHead(scratch);
    const { summary, idle } = await runExecutor(wikiName, plan, scratch, cfg);

    // Timeout (no llego session.idle): NO es exito. El executor se aborto adentro de runExecutor
    // (gemma dejo de escribir) antes de devolver. Nunca devolvemos revisada en este caso.
    if (!idle) {
      const msg = `executor timeout (no termino en ${cfg.executorTimeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS}ms)`;
      console.error(`[rem-runner/${wikiName}] ${msg}`);
      return { wiki: wikiName, status: "error", cost, summary: msg, error: msg };
    }

    // Verificacion de commit: revisada SOLO si el executor dejo un commit nuevo. Sin commit nuevo
    // (mismo HEAD) -> no hay nada que pushear -> sin-cambios (no revisada falso).
    const headAfter = gitHead(scratch);
    if (!headAfter || headAfter === headBefore) {
      console.log(`[rem-runner/${wikiName}] executor termino sin commit nuevo -> sin-cambios`);
      return {
        wiki: wikiName,
        status: "sin-cambios",
        cost,
        summary: summary || "el executor no dejo cambios",
      };
    }

    // F6: Push (con rebase si rechaza). Solo llegamos aca con un commit verificado.
    pushWithRebase(scratch, cfg.pushToken, cfg.gitProxyBase, wikiName);

    return { wiki: wikiName, status: "revisada", cost, summary };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.error(`[rem-runner/${wikiName}] error: ${msg}`);
    return { wiki: wikiName, status: "error", cost: 0, summary: msg, error: msg };
  } finally {
    // F7: Wipe SIEMPRE (incluso ante error).
    wipeDir(scratch);
  }
}

// --- Helpers de config desde el entorno/fs --------------------------------

/** Lee la key de Anthropic desde ~/.archima/anthropic.key (o la variable de entorno). */
export function readAnthropicKey(envKey?: string): string {
  if (envKey) return envKey;
  const home = process.env.HOME ?? "";
  const keyPath = join(home, ".archima", "anthropic.key");
  if (existsSync(keyPath)) {
    return readFileSync(keyPath, "utf8").trim();
  }
  throw new Error(
    "No se encontro la API key de Anthropic. Setea ANTHROPIC_API_KEY o coloca en ~/.archima/anthropic.key",
  );
}

/** Lee la key de vLLM desde ~/inference/api_key.txt (o la variable de entorno). */
export function readVllmKey(envKey?: string): string {
  if (envKey) return envKey;
  const home = process.env.HOME ?? "";
  const keyPath = join(home, "inference", "api_key.txt");
  if (existsSync(keyPath)) {
    return readFileSync(keyPath, "utf8").trim();
  }
  return "sk-no-key"; // vLLM local suele no requerir key real
}

/** Construye un RemRunnerConfig desde variables de entorno + paths de gpuhost. */
export function configFromEnv(): RemRunnerConfig {
  // Default gemma (vllm); anthropic (sonnet) es opt-in. La key de Anthropic solo se exige si
  // efectivamente se usa el planner anthropic — con el default vllm no hace falta.
  const plannerProvider =
    process.env.REM_PLANNER_PROVIDER === "anthropic" ? "anthropic" : DEFAULT_PLANNER_PROVIDER;
  return {
    gitProxyBase: process.env.REM_GIT_PROXY_BASE ?? "https://ceibo.example.com/api/git",
    pushToken: process.env.REM_PUSH_TOKEN ?? "",
    opencodeBase: process.env.REM_OPENCODE_BASE ?? "http://127.0.0.1:4200",
    gemmaModel: process.env.REM_GEMMA_MODEL ?? "local/gemma4-31b",
    anthropicKey: plannerProvider === "anthropic" ? readAnthropicKey(process.env.ANTHROPIC_API_KEY) : "",
    plannerProvider,
    // Sin default fijo: cada proveedor resuelve el suyo (anthropic→sonnet, vllm→modelID de gemma).
    plannerModel: process.env.REM_PLANNER_MODEL,
    vllmBase: process.env.REM_VLLM_BASE ?? "http://127.0.0.1:8000/v1",
    vllmKey: readVllmKey(process.env.REM_VLLM_KEY),
    plannerTimeoutMs: Number(process.env.REM_PLANNER_TIMEOUT_MS || "120000"),
    executorTimeoutMs: Number(process.env.REM_EXECUTOR_TIMEOUT_MS || String(DEFAULT_EXECUTOR_TIMEOUT_MS)),
    gitAuthorName: process.env.REM_GIT_AUTHOR_NAME ?? "Ceibo REM",
    gitAuthorEmail: process.env.REM_GIT_AUTHOR_EMAIL ?? "rem@example.com",
  };
}
