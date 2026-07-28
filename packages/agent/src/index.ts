// Relay bidireccional con una sesión de Managed Agents (cloud).
//
// La sesión es un stream de eventos bidireccional y persistente; este módulo NO
// modela "turnos" ni bloquea:
//   - EGRESS: un loop atacha el stream y bombea los eventos del agente al `Sink`
//     a medida que salen (cada `agent.message` es un bloque completo, no delta).
//   - INGRESS: `send()` mete tu texto como `user.message` cuando sea (corriendo o
//     no — la sesión lo encola/redirige); `interrupt()` manda `user.interrupt`.
// El canal (Telegram vía Chat SDK, REPL, etc.) sólo implementa el `Sink` + llama
// send/interrupt. No sabe nada de turnos ni de Managed Agents.
//
// Portado de managed-1 (cli/relay.ts). Cambio para ceibo: el repo montado es
// OPCIONAL — el agente "sin features" de Fase 1 chatea sin wiki montada.

import type Anthropic from "@anthropic-ai/sdk";
import { uploadWikiSyncResources } from "./wiki-sync-upload.ts";

/** Un repo a montar en la sesión. La URL es de clone; mountPath dónde aparece. */
export interface RepoMount {
  url: string;
  mountPath: string;
}

export interface SessionConfig {
  agentId: string;
  envId: string;
  vaultId?: string;
  /** Repos del usuario a montar (vacío = ninguno). */
  repos?: RepoMount[];
  /** Token (efímero, scoped) usado para clonar TODOS los repos de arriba. */
  repoToken?: string;
  /** Material de wiki-sync NEUTRAL (backend-agnóstico): el token de identidad YA firmado
   *  (`<userId>.<hmac>`) + la URL del endpoint `/api/sync`. Cada backend lo entrega a su
   *  sustrato a su manera (MA → File resources vía Files API; archima → cp.sh a la VM). */
  wikiSync?: WikiSyncMount;
  /** Rol del agente del SUSTRATO para esta sesión (sólo backend local/archima): "worker" corre
   *  el agente con tools completas y sin spawn (`ceibo-worker` de opencode.json) — es el rol de
   *  REM y de cualquier turno batch/no-interactivo, que necesita editar archivos y NO puede
   *  delegar. Ausente o "coordinator" = el coordinador conversacional (sólo MCP tools + spawn),
   *  reservado a las sesiones interactivas de chat. MA lo ignora (ahí el rol lo decide agentId). */
  agentRole?: "coordinator" | "worker";
  /** Override de modelo para backend local/archima. MA lo ignora. Sirve para corridas especiales
   *  (ej. REM executor) cuando el rol no alcanza para elegir el modelo. Si falta `providerID`, el
   *  backend usa su provider local default. */
  localModel?: { providerID?: string; modelID: string };
}

/** Material neutral de wiki-sync que viaja por la costura. NO trae file-ids ni nada MA-shaped. */
export interface WikiSyncMount {
  /** Token de identidad firmado del user (`<userId>.<hmac>`, NO el de GitHub). */
  token: string;
  /** Base del endpoint de sync (ej. `https://host/api/sync`). Pública, no secreta. */
  url: string;
  /** Nombres de las wikis del user (sin org/). archima las clona TODAS como repos git en `~/work`
   *  (la "wikibomb") al crear la sesión, vía el proxy git scopeado (`/api/git`). MA lo ignora
   *  (entrega cada wiki por el sync HTTP). */
  wikis?: string[];
}

/** Usage acumulado de la sesión (lo que devuelve sessions.retrieve().usage). */
export interface TurnUsage {
  input: number;
  output: number;
  cache5m: number;
  cache1h: number;
  cacheRead: number;
}

/** Timing de un turno, en ms. Lo emite SOLO el backend local (archima), donde el TTFT ≈
 *  prefill de vLLM y es la única señal de warm/cold que el `cache:X/Y` del usage NO da (vLLM
 *  no popula `cached_tokens` → cache siempre 0/0; ver quickboot/mediciones.md). MA lo deja
 *  undefined (su latencia es otra historia). Todos los campos opcionales: un turno que no nació
 *  de un `send` del usuario (ej. prompt sintético de cierre de un background) no tiene `ttftMs`. */
export interface TurnTiming {
  /** ms entre el `send` del prompt y el primer token del asistente ≈ tiempo de prefill. */
  ttftMs?: number;
  /** ms entre el `send` y el cierre del turno (`session.idle`). */
  turnMs?: number;
}

export interface Sink {
  message(text: string): void | Promise<void>; // el agente dijo algo → mostralo
  // tool use / sub-agente arrancó (progreso). `input` = args crudos de la tool-call (cuando los
  // hay), para que el consumidor pueda humanizar un label con detalle (ej. `bash: git status`).
  activity?(name: string, input?: unknown): void;
  // Cantidad de sub-agentes ACTIVOS en este preciso momento (concurrentes incluidos). La ALIMENTA
  // el backend a partir del ciclo de vida de los sub-agentes: en archima (backend-local) contando
  // los tool-calls `task` en estado `running`; en MA, de `session.thread_created` / `thread_idled`
  // / `thread_terminated`. El consumidor (web) la usa para decorar el orb con N mini-orbs (un
  // satélite por sub-agente vivo). 0 = ninguno activo. Es un CONTEO absoluto, no un delta: cada
  // llamada reemplaza el valor anterior. Se resetea a 0 al fin del turno.
  subagents?(count: number): void;
  status?(text: string): void; // avisos transitorios del stream → SÓLO log (no se le muestran al user)
  // Error de la API/MA que FALLÓ el turno de forma no-recuperable (límite de uso de la workspace,
  // billing, modelo caído tras agotar reintentos). A diferencia de `status` (log-only), esto el
  // USUARIO lo tiene que ver: el consumidor lo postea al canal del usuario. El turno se cierra
  // después con el `session.status_idle` (retries_exhausted) que sigue → no queda colgado mudo.
  error?(text: string): void | Promise<void>;
  // Aviso de SISTEMA neutro, visible para el usuario (NO es voz del agente como `message`, ni un
  // error como `error`, ni log-only como `status`): un hecho del plano de sesión que el usuario
  // debe ver — "conversación compactada" (auto-compaction de opencode) o "conversación reiniciada"
  // (clear diario). El consumidor lo postea como una línea de sistema atenuada, distinta de una
  // burbuja de usuario/asistente. Un solo frame sirve para compactación Y clear (quickboot/sessions).
  notice?(text: string): void | Promise<void>;
  // El relay se dio por muerto irrecuperable (la sesión MA terminó server-side, no un corte
  // transitorio que se pueda reconectar): el dueño del relay debería recrearlo (ensureRelay lo rearma).
  dead?(): void;
  // Fin de turno (end_turn): usage ACUMULADO de la sesión + model id. El metering
  // lo convierte en delta. El relay no sabe de DB ni de plata. `timing` (opcional, solo backend
  // local) trae el TTFT/duración del turno para loguear warm/cold del prefill (quickboot).
  turnComplete?(usage: TurnUsage, model: string, timing?: TurnTiming): void | Promise<void>;
}

// Adjunto entrante que el modelo puede ver/leer (Fase 16). Va como content block en el
// user.message. `data` = base64 estándar; `mediaType` el MIME. MA acepta imágenes
// (png/jpeg/gif/webp) y documentos (PDF) como input.
export interface InboundMedia {
  kind: "image" | "document";
  data: string;
  mediaType: string;
  filename?: string;
}

export interface Relay {
  /** Manda un turno del usuario. `media` adjunta imágenes/documentos que el modelo ve. */
  send(text: string, media?: InboundMedia[]): Promise<unknown>;
  interrupt(): Promise<unknown>;
  /** Compactación manual on-demand (comando `/compact`). Sólo el backend LOCAL (archima/opencode)
   *  lo soporta → opcional: dispara `POST /session/:id/summarize` en la VM. MA auto-compacta
   *  server-side y NO expone un trigger → lo omite (el comando avisa que no aplica). El summarize
   *  dispara el mismo evento `session.compacted` que la auto-compaction → el aviso de sistema
   *  "Conversación compactada" sale por el camino normal (Sink.notice). */
  summarize?(): Promise<unknown>;
  close(): void;
}

// --- Vault: credencial del MCP de escritura (GitHub) ---------------------
// El vault es por-usuario y persistente; adentro guardamos UNA credencial
// static_bearer mapeada a la URL del MCP, cuyo token refrescamos (es efímero).

/** Crea un vault y devuelve su id. */
export async function createVault(client: Anthropic, displayName: string): Promise<string> {
  const v = await client.beta.vaults.create({ display_name: displayName });
  return v.id;
}

/**
 * Asegura que el vault tenga la credencial del MCP con ESTE token. Si ya existe
 * una para esa URL, le actualiza el token (mismo credential id → la sesión viva
 * la sigue usando); si no, la crea. El token nunca se loguea.
 */
export async function setMcpCredential(
  client: Anthropic,
  vaultId: string,
  mcpServerUrl: string,
  token: string,
): Promise<void> {
  const norm = (u: string) => u.replace(/\/+$/, ""); // Anthropic normaliza el trailing slash
  const page = await client.beta.vaults.credentials.list(vaultId, {});
  const existing = (page.data ?? []).find((c) => norm(c.auth.mcp_server_url) === norm(mcpServerUrl));
  if (existing) {
    // El update NO acepta mcp_server_url (es fijo); solo cambia el token.
    await client.beta.vaults.credentials.update(existing.id, {
      vault_id: vaultId,
      auth: { type: "static_bearer", token },
    });
    return;
  }
  await client.beta.vaults.credentials.create(vaultId, {
    display_name: "github-mcp",
    auth: { type: "static_bearer", mcp_server_url: mcpServerUrl, token },
  });
}

/**
 * Asegura en el vault una credencial `static_bearer` para una MCP URL.
 *
 * Es el ÚNICO tipo de credencial que escribimos al vault de Anthropic: un
 * access_token corto, sin refresh_token ni client_secret (esos viven en NUESTRO
 * broker, ver @ceibo/oauth). Lo usa el broker al enrolar y en cada refresh.
 *
 * Si ya hay una credencial `static_bearer` para esa URL, hace **UPDATE in-place**
 * (conserva el credential id → una sesión viva sigue usando la misma cred mientras
 * el broker le rota el token por debajo). Si la que había es de otro tipo (ej. un
 * `mcp_oauth` viejo del modelo anterior), hace delete + create para migrarla
 * limpio. El token nunca se loguea.
 */
export async function setStaticBearerCredential(
  client: Anthropic,
  vaultId: string,
  c: { mcpServerUrl: string; displayName: string; token: string },
): Promise<void> {
  const norm = (u: string) => u.replace(/\/+$/, ""); // Anthropic normaliza el trailing slash
  const page = await client.beta.vaults.credentials.list(vaultId, {});
  const existing = (page.data ?? []).find((x) => norm(x.auth.mcp_server_url) === norm(c.mcpServerUrl));
  if (existing && existing.auth.type === "static_bearer") {
    // Mismo tipo → update del token, conservando el id (no rompe sesiones vivas).
    await client.beta.vaults.credentials.update(existing.id, {
      vault_id: vaultId,
      auth: { type: "static_bearer", token: c.token },
    });
    return;
  }
  if (existing) {
    // Tipo distinto (ej. mcp_oauth heredado) → migración limpia.
    await client.beta.vaults.credentials.delete(existing.id, { vault_id: vaultId });
  }
  await client.beta.vaults.credentials.create(vaultId, {
    display_name: c.displayName,
    auth: { type: "static_bearer", mcp_server_url: c.mcpServerUrl, token: c.token },
  });
}

/**
 * Borra del vault la credencial OAuth de una MCP URL (revocar un enrollment).
 * Devuelve true si había algo que borrar. No-op si no existía. No loguea nada.
 */
export async function revokeOauthCredential(
  client: Anthropic,
  vaultId: string,
  mcpServerUrl: string,
): Promise<boolean> {
  const norm = (u: string) => u.replace(/\/+$/, "");
  const page = await client.beta.vaults.credentials.list(vaultId, {});
  const existing = (page.data ?? []).find((c) => norm(c.auth.mcp_server_url) === norm(mcpServerUrl));
  if (!existing) return false;
  await client.beta.vaults.credentials.delete(existing.id, { vault_id: vaultId });
  return true;
}

/**
 * Override PER-SESIÓN de la config del agente (mcp_servers + tools). La sesión
 * snapshotea el agente al crearse; esto reemplaza esos dos arrays mid-session
 * (reemplazo TOTAL — el caller manda la lista completa, base + extras). Lo usa el
 * gateway para montarle a cada usuario sólo los perfiles de cuenta que conectó
 * (multi-cuenta, Fase 7), sin predeclararlos en el agente global. El resto de la
 * config (system, model, skills) queda intacta. Idempotente.
 */
export async function setSessionAgentConfig(
  client: Anthropic,
  sessionId: string,
  agentCfg: NonNullable<Anthropic.Beta.Sessions.SessionUpdateParams["agent"]>,
): Promise<void> {
  await client.beta.sessions.update(sessionId, { agent: agentCfg });
}

export async function createSession(client: Anthropic, cfg: SessionConfig, title: string): Promise<string> {
  const repoResources =
    cfg.repos && cfg.repos.length > 0 && cfg.repoToken
      ? cfg.repos.map((r) => ({
          type: "github_repository" as const,
          url: r.url,
          authorization_token: cfg.repoToken as string,
          mount_path: r.mountPath,
          // sin checkout → branch default del repo (auto_init crea main)
        }))
      : [];
  // File resources (Fase 2b): script de sync + token firmado del user. El upload a la Files API
  // es sustrato MA → vive abajo de la costura (uploadWikiSyncResources), a partir del `wikiSync`
  // NEUTRAL de la config. Best-effort: si la Files API falla, devuelve [] (sesión sin sync).
  const fileResources = (await uploadWikiSyncResources(client, cfg.wikiSync)).map((f) => ({
    type: "file" as const,
    file_id: f.fileId,
    mount_path: f.mountPath,
  }));
  const resources = [...repoResources, ...fileResources];

  const s = await client.beta.sessions.create({
    agent: cfg.agentId,
    environment_id: cfg.envId,
    ...(cfg.vaultId ? { vault_ids: [cfg.vaultId] } : {}),
    title,
    ...(resources.length ? { resources } : {}),
  });
  return s.id;
}

export async function reuseOrCreate(
  client: Anthropic,
  cfg: SessionConfig,
  title: string,
  existing?: string,
): Promise<string> {
  if (existing) {
    try {
      const s = await client.beta.sessions.retrieve(existing);
      if (s.status === "idle" || s.status === "running") return existing;
    } catch {
      /* terminada / no existe → creamos una nueva */
    }
  }
  return createSession(client, cfg, title);
}

// Trae el usage acumulado de la sesión (fuente de verdad de facturación) y se lo
// pasa al Sink. Best-effort: si el retrieve falla, sólo logueamos al status.
async function reportTurn(client: Anthropic, sessionId: string, sink: Sink): Promise<void> {
  try {
    const s = await client.beta.sessions.retrieve(sessionId);
    // biome-ignore lint/suspicious/noExplicitAny: usage/agent son uniones anchas del beta
    const u = ((s as any).usage ?? {}) as any;
    const usage: TurnUsage = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cache5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      cache1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
    };
    // biome-ignore lint/suspicious/noExplicitAny: idem
    const model = ((s as any).agent?.model?.id ?? "unknown") as string;
    await sink.turnComplete?.(usage, model);
  } catch (err) {
    sink.status?.(`[metering] no pude leer usage: ${(err as Error)?.message ?? String(err)}`);
  }
}

// Discriminante de un `session.error` de MA (el `error.type` del evento). `billing_error` es el
// que tira la workspace cuando se topa el límite de uso / se queda sin crédito; los `mcp_*` son
// de UN servidor MCP puntual (el turno sigue); el resto son fallas de modelo.
export type SessionErrorType =
  | "unknown_error"
  | "model_overloaded_error"
  | "model_rate_limited_error"
  | "model_request_failed_error"
  | "mcp_connection_failed_error"
  | "mcp_authentication_failed_error"
  | "billing_error";

/**
 * Origen del error, para elegir el LABEL correcto. El backend MA es de Anthropic; el backend
 * local (archima) corre en infra propia (ssh / cp.sh / opencode) → sus errores NO son de
 * Anthropic y mencionar "Anthropic" sería engañoso. Default `"ma"` (backend histórico).
 */
export type ErrorOrigin = "ma" | "local";

/**
 * Arma un mensaje LIMPIO y accionable para el USUARIO a partir de un error de la API/MA o del
 * backend local. Acepta tanto el texto crudo (string) como un error tirado por el SDK
 * (Anthropic.APIError u objeto con `.message`/`.error.message`): nunca expone stack traces ni
 * secretos, sólo el texto humano.
 *
 * `origin` elige el label: `"ma"` (default) → errores de la API de Anthropic; `"local"` →
 * errores del backend local (archima/ssh/opencode), SIN mencionar Anthropic.
 *
 * Caso especial (sólo `origin === "ma"`) — límite de uso de la workspace (billing_error o un
 * message que menciona "usage limit"/"credit"/"spend limit"): además del texto de la API, agrega
 * una nota accionable (subir el límite / agregar crédito en la consola de Anthropic), que es lo
 * que el owner necesita ver. No aplica al backend local (no hay consola de Anthropic ahí).
 */
export function apiErrorMessage(err: unknown, type?: SessionErrorType, origin: ErrorOrigin = "ma"): string {
  // biome-ignore lint/suspicious/noExplicitAny: extraemos el message de formas heterogéneas (string, Error, APIError)
  const e = err as any;
  const raw =
    typeof err === "string" ? err : (e?.error?.error?.message ?? e?.error?.message ?? e?.message ?? "");
  const msg = String(raw ?? "").trim();
  // Backend local: el error es del entorno propio (ssh/cp.sh/opencode), no de Anthropic. El
  // detalle crudo NUNCA viaja al usuario: trae interna (nombres de VM `archima-…`, env ids
  // `env_…`, comandos `cp.sh`, stdout de scripts, conteos de reintentos) — pedido explícito del
  // owner (2026-06-10). El CALLER loguea el error completo server-side; acá sólo elegimos la
  // frase amable: cold-start (la VM está levantando) vs. fallo de conexión genérico.
  if (origin === "local") {
    return /cold-start/i.test(msg)
      ? "⚠️ Tu entorno se está despertando y todavía no respondió. Probá de nuevo en unos segundos."
      : "⚠️ No pude conectar con tu entorno local. Probá de nuevo en unos segundos.";
  }
  const lower = msg.toLowerCase();
  const isUsageLimit =
    type === "billing_error" ||
    lower.includes("usage limit") ||
    lower.includes("credit balance") ||
    lower.includes("spend limit") ||
    lower.includes("out of credit");
  if (isUsageLimit) {
    return (
      "⚠️ No puedo responder ahora: se alcanzó el límite de uso de la workspace de Anthropic." +
      (msg ? `\n${msg}` : "") +
      "\nHay que subir el límite (o agregar crédito) en la consola de Anthropic para seguir."
    );
  }
  return msg ? `⚠️ Error de la API de Anthropic: ${msg}` : "⚠️ Error de la API de Anthropic.";
}

// --- Higiene de errores user-facing (no filtrar interna) -------------------
// Pedido del owner (incidente 2026-06-10): NINGÚN mensaje user-facing puede incluir interna —
// nombres de VM (`archima-…`), IDs de environment (`env_…`), sesiones opencode (`ses_…`),
// comandos (`cp.sh`, `agent-vault`, ssh), stdout/stderr crudos de scripts ni conteos de
// reintentos. El detalle completo va SIEMPRE al log; al canal va una frase amable. Estas dos
// piezas viven acá (paquete hoja) para que tanto el gateway como los canales puedan sanear sin
// que `channels` dependa de `gateway` (el gateway las re-exporta desde su `logic.ts`).

/** ¿El mensaje de un error huele a detalle INTERNO de infra (VMs, cp.sh, opencode, ssh, IPs)?
 *  Si sí, no es apto para el canal del usuario: mostrale el fallback y logueá el crudo. */
export function isInternalDetail(msg: string): boolean {
  return /archima|env_[A-Za-z0-9]{6,}|ses(?:sion)?_[A-Za-z0-9]{6,}|vlt_[A-Za-z0-9]{6,}|cp\.sh|agent-vault|opencode|\bssh\b|\bexit \d+\b|\bcold-start\b|\bintentos?\b|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|vllm|virsh|qcow|systemd|ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed|\bHTTP \d{3}\b|\bstatus\b.*\b\d{3}\b/i.test(
    msg,
  );
}

/** Razón mostrable al usuario para un error: el message original si es inocuo (capado), o el
 *  `fallback` genérico si trae interna. El caller SIEMPRE debe loguear el error crudo aparte. */
export function publicErrorReason(err: unknown, fallback: string): string {
  const msg = ((err as Error)?.message ?? String(err ?? "")).replace(/\s+/g, " ").trim();
  if (!msg || isInternalDetail(msg)) return fallback;
  return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg;
}

// Atacha el stream (egress) y devuelve los handles de ingress. No bloquea.
export function attach(client: Anthropic, sessionId: string, sink: Sink): Relay {
  let stopped = false;

  // Sub-agentes (threads) VIVOS de la sesión MA, por id de thread. El coordinador spawnea threads
  // del roster (`session.thread_created`) y los cierra (`session.thread_idled` / `thread_terminated`).
  // Contamos los vivos → `sink.subagents(count)` para que la web los dibuje como mini-orbs (paridad
  // con archima, que cuenta los `task` en `running`). Si un evento no trae id de thread, se ignora
  // para el conteo (mejor sub-contar que corromper): MA-sin-id simplemente no muestra mini-orbs.
  // Es BEST-EFFORT y NO verificado en vivo (la forma exacta de estos eventos no está en refs); el
  // path verificado/must-have es archima. El conteo se resetea al fin de turno (status_idle).
  const liveThreads = new Set<string>();
  const threadId = (e: { thread_id?: string; id?: string }): string | undefined => e.thread_id ?? e.id;
  const reportSubagents = () => sink.subagents?.(liveThreads.size);

  // ¿La sesión MA sigue viva (idle/running)? Si el retrieve falla o dice terminada, está muerta
  // server-side y no tiene sentido reconectar el stream.
  const sessionAlive = async (): Promise<boolean> => {
    try {
      const s = await client.beta.sessions.retrieve(sessionId);
      return s.status === "idle" || s.status === "running";
    } catch {
      return false;
    }
  };

  const pump = async () => {
    let backoff = 500;
    while (!stopped) {
      try {
        const stream = await client.beta.sessions.events.stream(sessionId);
        backoff = 500; // conexión OK → reseteamos el backoff
        for await (const ev of stream) {
          if (stopped) return;
          // biome-ignore lint/suspicious/noExplicitAny: eventos del stream son union ancha
          const e = ev as any;
          switch (e.type) {
            case "agent.message":
              for (const b of e.content ?? []) {
                if (b.type === "text" && b.text) await sink.message(b.text);
              }
              break;
            case "agent.tool_use":
            case "agent.mcp_tool_use":
            case "agent.custom_tool_use":
              // `e.input` son los args de la tool-call (un objeto chico); los pasamos para que
              // el consumidor arme un label con detalle (qué archivo, qué comando, etc.).
              sink.activity?.(e.name ?? "tool", e.input);
              break;
            case "session.thread_created": {
              // El coordinador spawneó un sub-agente del roster; e.agent_name dice cuál
              // (worker-low/mid/high) → muestra el nivel de modelo que está delegando.
              sink.activity?.(`sub-agente: ${e.agent_name ?? "?"}`);
              // …y contalo como sub-agente vivo (mini-orb) si el evento trae un id de thread.
              const tid = threadId(e);
              if (tid && !liveThreads.has(tid)) {
                liveThreads.add(tid);
                reportSubagents();
              }
              break;
            }
            case "session.thread_idled":
            case "session.thread_terminated": {
              // El sub-agente terminó (idle = sin trabajo en vuelo; terminated = destruido). En ambos
              // dejamos de mostrar su mini-orb. Dedup por id (idled→terminated no decrementa dos veces).
              const tid = threadId(e);
              if (tid && liveThreads.has(tid)) {
                liveThreads.delete(tid);
                reportSubagents();
              }
              break;
            }
            case "session.status_idle":
              // El agente cerró su turno. `end_turn` = cierre natural; `retries_exhausted` = el
              // turno MURIÓ tras agotar reintentos (ej. después de un session.error de límite de
              // uso ya surfaceado). En AMBOS hay que cerrar el turno: reportar el usage acumulado
              // y, sobre todo, soltar `busy` del lado del consumidor. Antes sólo cerrábamos en
              // end_turn → un turno fallido quedaba colgado con `busy` congelado (el cuelgue mudo).
              // `requires_action` NO cierra: el agente espera input del usuario (confirmación de tool).
              if (
                (e.stop_reason?.type === "end_turn" || e.stop_reason?.type === "retries_exhausted") &&
                sink.turnComplete
              ) {
                void reportTurn(client, sessionId, sink);
              }
              // Fin de turno → no quedan sub-agentes vivos (red de seguridad por si algún
              // thread_idled/terminated no llegó). Sólo reportamos si había algo que limpiar.
              if (e.stop_reason?.type === "end_turn" || e.stop_reason?.type === "retries_exhausted") {
                if (liveThreads.size > 0) {
                  liveThreads.clear();
                  reportSubagents();
                }
              }
              break;
            case "session.error": {
              // El evento trae `error: { type, message, retry_status }`. Decidimos qué hacer por el
              // tipo y el retry_status:
              //  - mcp_* → error de UN servidor MCP puntual; el agente sigue el turno → sólo log.
              //  - retry_status 'retrying' → el server reintenta solo; no molestamos al usuario → log.
              //  - resto (billing/model/unknown, exhausted/terminal) → falla del turno que el
              //    usuario TIENE que ver (el caso del límite de uso) → sink.error.
              const errObj = e.error ?? {};
              const errType = errObj.type as SessionErrorType | undefined;
              const retry = errObj.retry_status?.type as string | undefined;
              const isMcp =
                errType === "mcp_connection_failed_error" || errType === "mcp_authentication_failed_error";
              if (isMcp) {
                sink.status?.(`error mcp:${errObj.mcp_server_name ?? "?"}: ${errObj.message ?? ""}`);
              } else if (retry === "retrying") {
                sink.status?.(`[api ${errType ?? "error"}] reintentando: ${errObj.message ?? ""}`);
              } else {
                await sink.error?.(apiErrorMessage(errObj.message, errType));
              }
              break;
            }
            case "session.status_terminated":
              // La sesión murió server-side: no hay nada que reconectar, avisamos para recrear.
              sink.status?.("[sesión terminada]");
              sink.dead?.();
              return;
          }
        }
        // El stream se cerró LIMPIO del lado servidor; si no paramos, re-atachamos (es un
        // tail en vivo sin cursor, así que no hay replay/duplicados).
        if (!stopped) await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        // El stream se cortó por ERROR (drop de red idle nocturno, el edge cierra el SSE, etc).
        // NO matamos el relay: si la sesión sigue viva reconectamos con backoff; si murió
        // server-side avisamos para que el dueño la recree. (Antes esta excepción mataba el
        // pump y dejaba la sesión zombie hasta un /new manual.)
        if (stopped) return;
        const msg = (err as Error)?.message ?? String(err);
        if (!(await sessionAlive())) {
          sink.status?.(`[stream cortado] ${msg} → sesión muerta`);
          sink.dead?.();
          return;
        }
        sink.status?.(`[stream cortado] ${msg} → reconecto en ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  };

  // Red de seguridad: el pump ya se auto-sana adentro; si aun así revienta, no lo dejamos
  // morir mudo → avisamos para que el relay se recree.
  pump().catch((err) => {
    sink.status?.(`[relay caído] ${(err as Error)?.message ?? String(err)}`);
    sink.dead?.();
  });

  return {
    send: (text, media) => {
      // Bloques de imagen/documento primero (lo que el modelo VE), luego el texto. Shape de la
      // API de sesiones: image → {source:{type:base64,data,media_type}}, document igual con PDF.
      type ImgMedia = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      const content = (media ?? []).map((m) =>
        m.kind === "image"
          ? ({
              type: "image",
              source: { type: "base64", data: m.data, media_type: m.mediaType as ImgMedia },
            } as const)
          : ({
              type: "document",
              source: { type: "base64", data: m.data, media_type: "application/pdf" },
              ...(m.filename ? { title: m.filename } : {}),
            } as const),
      );
      const blocks = text ? [...content, { type: "text", text } as const] : content;
      return client.beta.sessions.events.send(sessionId, {
        events: [{ type: "user.message", content: blocks }],
      });
    },
    interrupt: () => client.beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] }),
    close: () => {
      stopped = true;
    },
  };
}

// --- La costura de backend ------------------------------------------------
// Hasta acá, cada operación de sesión/vault toma `client: Anthropic` como 1er
// arg — ESE es el acoplamiento a Managed Agents. `SessionBackend` lo abstrae:
// es TODO lo que el gateway/oauth le piden a la infra de agentes, sin nombrar a
// Anthropic. Hoy la única implementación es `makeMaBackend` (MA cloud, abajo);
// archima provee otra (local, en su propio repo) detrás de la misma forma. El
// selector backend↔usuario vive en el gateway (Fase "enchufe", aparte).

export interface SessionBackend {
  /** Crea un vault por-usuario y devuelve su id. */
  createVault(displayName: string): Promise<string>;
  /** Asegura una credencial `static_bearer` para una MCP URL (update in-place si ya existe). */
  setStaticBearerCredential(
    vaultId: string,
    c: { mcpServerUrl: string; displayName: string; token: string },
  ): Promise<void>;
  /** Borra la credencial OAuth de una MCP URL (revocar enrollment). true si había algo. */
  revokeOauthCredential(vaultId: string, mcpServerUrl: string): Promise<boolean>;
  /** Override per-sesión de la config del agente (mcp_servers + tools). */
  setSessionAgentConfig(
    sessionId: string,
    agentCfg: NonNullable<Anthropic.Beta.Sessions.SessionUpdateParams["agent"]>,
  ): Promise<void>;
  /** Crea una sesión fresca y devuelve su id. */
  createSession(cfg: SessionConfig, title: string): Promise<string>;
  /** Reusa la sesión `existing` si sigue viva (idle/running); si no, crea una nueva. */
  reuseOrCreate(cfg: SessionConfig, title: string, existing?: string): Promise<string>;
  /** OPCIONAL: ¿hay un wiki-sync en background todavía en vuelo para `sessionId`? El backend local
   *  desacopla el sync de las wikis del reopen (no bloquea la respuesta del agente); mientras corre,
   *  el gateway le avisa al agente que las wikis no están listas para leer/editar. MA no lo usa
   *  (entrega las wikis como File resources al crear la sesión) → omite el método (→ false). */
  wikiSyncPending?(sessionId: string): boolean;
  /** OPCIONAL: abre una SEGUNDA sesión-agente DENTRO de la sesión/VM ya viva `vmSessionId` (la del
   *  coordinador), para correr un sub-agente asíncrono sin clonar infra nueva ni pisar el stream del
   *  coordinador. Devuelve un sessionId lógico nuevo (misma VM/infra, stream propio) usable con
   *  attach/send/close. Sólo el backend local lo soporta; MA tiene su propio roster de coordinadores
   *  y lo omite. */
  createWorkerSession?(vmSessionId: string): Promise<string>;
  /** Atacha el stream (egress) y devuelve los handles de ingress. No bloquea. */
  attach(sessionId: string, sink: Sink): Relay;
}

/**
 * Backend = Managed Agents cloud. Liga un `Anthropic` a la costura. CERO lógica
 * nueva: cada método delega 1:1 en la función libre de arriba. Envolver el
 * gateway en esto deja la conducta de prod idéntica — es sólo el punto de corte
 * para que después se pueda enchufar otro backend por-usuario.
 */
export function makeMaBackend(client: Anthropic): SessionBackend {
  return {
    createVault: (displayName) => createVault(client, displayName),
    setStaticBearerCredential: (vaultId, c) => setStaticBearerCredential(client, vaultId, c),
    revokeOauthCredential: (vaultId, mcpServerUrl) => revokeOauthCredential(client, vaultId, mcpServerUrl),
    setSessionAgentConfig: (sessionId, agentCfg) => setSessionAgentConfig(client, sessionId, agentCfg),
    createSession: (cfg, title) => createSession(client, cfg, title),
    reuseOrCreate: (cfg, title, existing) => reuseOrCreate(client, cfg, title, existing),
    attach: (sessionId, sink) => attach(client, sessionId, sink),
  };
}
