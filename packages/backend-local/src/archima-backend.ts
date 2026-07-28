// ArchimaBackend: implementa SessionBackend (la costura de managed-2) sobre archima.
//   - vault     → Agent Vault (CLI `agent-vault`)
//   - lifecycle → control plane `cp.sh` (libvirt)
//   - attach    → pump del event-stream de opencode-server traducido al Sink
// Las dependencias externas (shell exec, cliente opencode) se INYECTAN → testeable
// sin red ni VMs. La impl real de esas deps (ssh a la box, HTTP a opencode) es el
// paso de integración; la estructura y el contrato quedan acá.

import type { InboundMedia, Relay, SessionBackend, SessionConfig, Sink } from "@ceibo/agent";
import { downscaleMedia } from "./image-downscale.ts";
import { type OpencodeEvent, RelayTranslator } from "./opencode-events.ts";
import { pdfToTextBlock } from "./pdf-extract.ts";

/** Tipo del agentCfg per-sesión, derivado de la interfaz SessionBackend (evita depender del
 *  SDK de Anthropic en el backend local; el agentCfg es la config opaca de mcp_servers). */
export type AgentConfig = Parameters<SessionBackend["setSessionAgentConfig"]>[1];

/** Corre un comando y devuelve stdout (trim). */
export type Exec = (cmd: string, args: string[]) => Promise<string>;

/** Cliente del opencode-server de la VM de una sesión (HTTP /session, /prompt, /event...).
 *  El usage NO se pide aparte: viene in-band en los eventos (step-finish) → lo acumula
 *  el RelayTranslator. */
export interface OpencodeClient {
  /** `opts.role` selecciona el agente de opencode al ABRIR la sesión: "worker" = tools completas
   *  sin spawn (REM/batch); default = coordinador. Un binding ya vivo no cambia de agente. */
  ensureSession(
    sessionId: string,
    opts?: { role?: "coordinator" | "worker"; model?: SessionConfig["localModel"] },
  ): Promise<void>;
  /** Invalida el binding de `sessionId` (estado por-sesión del cliente): el próximo ensureSession
   *  vuelve a abrir sesión DE CERO (resolveBase → `cp.sh serve` re-wrappea opencode con el token
   *  AV vigente + POST /session fresca). Lo llama createSession (path de /new): sin esto el
   *  binding viejo sobrevivía a la rotación de token del `assign` → MCPs 407 → cascada 429, y la
   *  sesión opencode vieja seguía viva → /new no reseteaba el contexto. */
  unbind(sessionId: string): void;
  /** Abre una sesión opencode NUEVA en la VM ya viva de `vmSessionId` (sin spawn) y la registra bajo
   *  un sessionId lógico propio (mismo `base`, `ses` distinto) → un sub-agente comparte VM con el
   *  coordinador pero tiene su PROPIO stream. Devuelve el sessionId lógico. */
  openWorkerSession(vmSessionId: string): Promise<string>;
  prompt(sessionId: string, parts: unknown[]): Promise<unknown>;
  abort(sessionId: string): Promise<unknown>;
  /** Compactación manual: `POST /session/:id/summarize` en la VM (opencode 1.17.8). Reemplaza la
   *  historia vieja por un checkpoint con resumen y emite `session.compacted` (lo relaya el
   *  RelayTranslator → Sink.notice). Lo invoca el comando `/compact`. */
  summarize(sessionId: string): Promise<unknown>;
  /** Stream de eventos de ESTA sesión (filtrado estricto del bus global). `opts.signal` permite
   *  al consumidor (el relay) ABORTAR el stream HTTP de verdad en `close()` — sin esto el pump
   *  quedaba parqueado en el read del SSE para siempre (bug E: pumps acumulados). */
  events(sessionId: string, opts?: { signal?: AbortSignal }): AsyncIterable<OpencodeEvent>;
  setAgentConfig(sessionId: string, cfg: AgentConfig): Promise<void>;
  /** Recuperación activa tras cortes repetidos del stream (reboot del host/VM): re-resuelve la
   *  base y verifica la sesión. "rebound" = sesión viva (re-suscribir sin perder contexto);
   *  "session-lost" = la sesión ya no existe (binding invalidado, hay que recrear y avisar);
   *  "unreachable" = la VM aún no responde (seguir con backoff). Opcional: un cliente sin
   *  recover se comporta como antes (sólo backoff pasivo). */
  recover?(sessionId: string): Promise<"rebound" | "session-lost" | "unreachable">;
}

export interface ArchimaDeps {
  exec: Exec;
  /** ruta del control plane (cp.sh) en la box */
  cp: string;
  /** ruta del binario agent-vault en la box */
  av: string;
  opencode: OpencodeClient;
  /** Guardrail anti-runaway: techo de PARED por turno (ms). Si un turno no cerró (session.idle)
   *  al vencer, se aborta la sesión opencode EN LA VM (frena la generación de verdad, no sólo el
   *  pump) y se avisa por `sink.error`. Default 10 min; ≤0 desactiva. Env: `ARCHIMA_TURN_TIMEOUT_MS`
   *  (via factory). Defensa contra el loop de tool-error que ocupó la GPU 40 min (bug de prod). */
  turnTimeoutMs?: number;
  /** Registro vm → vault: el backend lo llama en cada ensure (create + reuse) con el vaultId de
   *  la sesión. El factory lo usa para el retry de `assign` cuando `cp.sh serve` falla (token AV
   *  rechazado tras un reboot del broker — incidente 2026-06-10). Best-effort/opcional. */
  registerVault?: (vmName: string, vaultId: string) => void;
  /** opcional (tests): sleep inyectable para el backoff del pump. Default setTimeout. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Default del techo de pared por turno (ver ArchimaDeps.turnTimeoutMs). */
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

/** Cortes consecutivos del stream de eventos que disparan la recuperación ACTIVA (recover():
 *  re-resolver base + verificar la sesión). 1 corte aislado se tolera con backoff pasivo (puede
 *  ser un blip de red); 2 seguidos ya huelen a reboot. */
export const RECOVER_AFTER_FAILURES = 2;

/** Veredictos "unreachable" CONSECUTIVOS de recover() antes de arrancar la VM caída. recover()
 *  sólo corre `cp.sh serve`, que NO levanta una VM `shut off` (sólo restore/spawn lo hacen) →
 *  tras un reboot de gpuhost la VM queda apagada y recover() devolvía "unreachable" PARA SIEMPRE
 *  (el pump en backoff pasivo eterno: incidente 2026-06-15, 3 sesiones colgadas hasta un restart
 *  manual del gateway). Un blip de red transitorio da 1-2 "unreachable" y se cura solo → recién
 *  al N-ésimo asumimos VM caída y la arrancamos. Threshold conservador: no spawneamos a la primera. */
export const WAKE_AFTER_UNREACHABLE = 3;

/** Techo de arranques de VM por relay: si tras N wakes la VM sigue sin levantar, gpuhost está caído
 *  de verdad (no es nuestra sesión la que hay que arreglar). Cortamos los wakes y seguimos sólo con
 *  backoff pasivo — sin esto, una gpuhost muerta dejaría al pump spawneando en loop eterno. El relay
 *  revive solo cuando gpuhost vuelve (el siguiente recover da rebound) o con el próximo mensaje del
 *  usuario (createSession → ensureVm). */
export const MAX_WAKE_ATTEMPTS = 3;

/** Aviso al usuario cuando el reboot de su entorno se llevó la sesión opencode (el contexto no
 *  es recuperable). UNA frase amable, sin interna (nada de nombres de VM / env ids / comandos). */
export const SESSION_LOST_USER_MSG =
  "⚠️ Tu entorno se reinició y se perdió el contexto de esta conversación. Ya estoy de vuelta: contame de nuevo en qué estábamos.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "x";
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
};
/** Segmentos de path del MCP SIN el último (el secret) ni la query. Es la parte que
 *  identifica al servicio (+perfil) dentro del host. Las URLs son
 *  `https://host/mcp/<servicio>/<secret>` → ["mcp","<servicio>"], o multi-cuenta
 *  `https://host/mcp/<servicio>/<perfil>/<secret>` → ["mcp","<servicio>","<perfil>"]
 *  (así cada perfil tiene matcher y credKey propios, sin pisarse). Una URL sin path
 *  significativo (≤1 segmento, ej. `/x`) devuelve [] → matcher/credKey caen a host-only. */
const mcpScopeSegments = (url: string): string[] => {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = (url.replace(/^https?:\/\//, "").split("?")[0] ?? "").replace(/^[^/]*/, "");
  }
  // El secret es SIEMPRE el último segmento → fuera del scope (lo cubre el `/*`).
  return pathname.split("/").filter(Boolean).slice(0, -1);
};
/** Matcher de `--host` del service del AV, path-scopeado por MCP. Para
 *  `https://ceibo.example.com/mcp/gmail/SECRET` devuelve `ceibo.example.com/mcp/gmail/*`. El AV
 *  matchea most-specific (path gana a host), así que un service path-scopeado convive con
 *  los services host-only de OTROS MCP del mismo host (ej. gmail con token Google y control
 *  con token ceibo, ambos en el mismo host, ya no se pisan). Sin path significativo, cae a
 *  host-only. El secret NUNCA entra al matcher: lo cubre el `/*`. */
const serviceHostMatcher = (url: string): string => {
  const segs = mcpScopeSegments(url);
  const host = hostOf(url);
  return segs.length ? `${host}/${segs.join("/")}/*` : host;
};
/** Clave de credencial UPPER_SNAKE para AV, ÚNICA por MCP (incluye el path del servicio,
 *  no sólo el host) → gmail y control en el mismo host tienen creds distintas y no se pisan.
 *  Ej. `ceibo.example.com/mcp/gmail/SECRET` → `CRED_CEIBO_EXAMPLE_COM_MCP_GMAIL`. Sin path → host-only
 *  (compat con los services host-scoped previos). */
const credKey = (url: string) =>
  `CRED_${[hostOf(url), ...mcpScopeSegments(url)]
    .join("/")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/_+$/g, "")}`;

/** Mapea media entrante a parts de prompt de opencode (file/text).
 *  Los PDFs se PRE-PROCESAN a texto (los modelos locales no parsean PDF nativo): cada PDF se
 *  reemplaza por una part `{type:"text"}` con su capa de texto extraída (o un aviso claro si es
 *  escaneado). El resto de la media va como `{type:"file"}` data-URL (imágenes ya downscaleadas
 *  por el caller). Async porque la extracción de PDF lo es. */
async function toParts(text: string, media?: InboundMedia[]): Promise<unknown[]> {
  const parts: unknown[] = [];
  for (const m of media ?? []) {
    if (m.mediaType === "application/pdf") {
      parts.push({ type: "text", text: await pdfToTextBlock(m.data, m.filename) });
    } else {
      parts.push({
        type: "file",
        mime: m.mediaType,
        filename: m.filename,
        url: `data:${m.mediaType};base64,${m.data}`,
      });
    }
  }
  if (text) parts.push({ type: "text", text });
  return parts;
}

export class ArchimaBackend implements SessionBackend {
  constructor(private deps: ArchimaDeps) {}

  /** Wiki-syncs en background en vuelo, keyados por nombre de VM (= sessionId lógico). El reuse
   *  desacopla el sync del reopen (no bloquea la respuesta); el gateway consulta esto para avisarle
   *  al agente que las wikis todavía no están listas. Se limpia cuando el sync termina. */
  private wikiSyncInFlight = new Map<string, Promise<void>>();

  /** ¿Hay un wiki-sync en background todavía corriendo para esta sesión? (lo lee el gateway). */
  wikiSyncPending(sessionId: string): boolean {
    return this.wikiSyncInFlight.has(sessionId);
  }

  /** Dispara `deliverWikiSync` en background y lo trackea (para `wikiSyncPending`). No espera. */
  private deliverWikiSyncDetached(name: string, cfg: SessionConfig): void {
    if (!cfg.wikiSync) return;
    const p = this.deliverWikiSync(name, cfg).finally(() => {
      if (this.wikiSyncInFlight.get(name) === p) this.wikiSyncInFlight.delete(name);
    });
    this.wikiSyncInFlight.set(name, p);
  }

  // --- Vault → Agent Vault -------------------------------------------------
  async createVault(displayName: string): Promise<string> {
    const name = slug(displayName);
    await this.deps.exec(this.deps.av, ["vault", "create", name]).catch(() => {}); // idempotente
    return name;
  }

  async setStaticBearerCredential(
    vaultId: string,
    c: { mcpServerUrl: string; displayName: string; token: string },
  ): Promise<void> {
    const key = credKey(c.mcpServerUrl);
    // El broker OAuth de ceibo pushea el access_token corto acá (igual que a MA).
    await this.deps.exec(this.deps.av, [
      "vault",
      "credential",
      "set",
      `${key}=${c.token}`,
      "--vault",
      vaultId,
    ]);
    // Servicio: host del MCP PATH-SCOPEADO (`host/mcp/<servicio>/*`) → inyecta Bearer usando
    // esa credencial (idempotente). El path-scope evita que MCPs distintos del mismo host
    // (gmail con token Google, control con token ceibo) compartan service/cred y se pisen.
    await this.deps
      .exec(this.deps.av, [
        "vault",
        "service",
        "add",
        "--vault",
        vaultId,
        "--name",
        slug(c.displayName),
        "--host",
        serviceHostMatcher(c.mcpServerUrl),
        "--auth-type",
        "bearer",
        "--token-key",
        key,
      ])
      .catch(() => {});
  }

  async revokeOauthCredential(vaultId: string, mcpServerUrl: string): Promise<boolean> {
    try {
      await this.deps.exec(this.deps.av, [
        "vault",
        "credential",
        "delete",
        credKey(mcpServerUrl),
        "--vault",
        vaultId,
      ]);
      // Borrar TAMBIÉN el service (matcher de inyección): si no, el disconnect deja el
      // matcher huérfano apuntando a una cred ya borrada y, al haber varios perfiles del
      // mismo MCP, queda un host ambiguo → el proxy no inyecta y reconectar no arregla.
      // Best-effort y por-host (con el perfil en el path el matcher es único por perfil).
      await this.deps
        .exec(this.deps.av, [
          "vault",
          "service",
          "remove",
          serviceHostMatcher(mcpServerUrl),
          "--vault",
          vaultId,
          "--yes",
        ])
        .catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  // --- Sesión → control plane cp.sh ---------------------------------------
  /** Prepara el acceso git a las wikis en la VM: `cp.sh wiki-setup` empuja el token FIRMADO real y
   *  clona TODAS las wikis del user (wikibomb) en ~/work via el proxy git scopeado (/api/git). El
   *  agente opera con git nativo (`git -C ~/work/<repo> pull/push`); el token va por http.extraHeader
   *  contra el proxy — NO hay creds de GitHub en la VM. El secreto real (WIKI_SYNC_SECRET) NUNCA toca
   *  la box: el gateway firma y manda sólo el token scopeado.
   *
   *  IDEMPOTENTE y best-effort, llamado en TODO ensure de sesión (create + reuse + restore): la VM
   *  persiste entre restarts del gateway y se reusa/restaura sin pasar por createSession, así que la
   *  entrega NO puede vivir sólo ahí (si no, una VM creada antes de la wiki — o antes de este código —
   *  queda muda para siempre). El re-clone/pull es idempotente → re-correrlo es barato e inocuo.
   *  Best-effort: si falla, logueamos y seguimos (la sesión anda, sin las wikis frescas). */
  private async deliverWikiSync(name: string, cfg: SessionConfig): Promise<void> {
    if (!cfg.wikiSync) return;
    try {
      // El backend MA sigue usando la URL pública (cfg.wikiSync.url); sólo el clon on-VM de
      // archima usa WIKI_SYNC_URL_LOCAL (tailscale) cuando está seteada, para que el tráfico
      // no dependa del IP público rotante de gpuhost (que rompe el allowlist de la box).
      const syncUrl = process.env.WIKI_SYNC_URL_LOCAL ?? cfg.wikiSync.url;
      await this.deps.exec(this.deps.cp, [
        "wiki-setup",
        name,
        cfg.wikiSync.token,
        syncUrl,
        // wikibomb: nombres de wikis → cp.sh las clona TODAS como repos git en ~/work.
        ...(cfg.wikiSync.wikis ?? []),
      ]);
    } catch (e) {
      console.warn(`archima: wiki-setup falló en ${name} (sigo sin sync): ${(e as Error)?.message ?? e}`);
    }
  }

  /** Corre `cp.sh assign <name> <vaultId>` con retry+backoff exponencial.
   *  Cubre dos fallos transitorios conocidos:
   *   1. `exit 255` (stderr vacío): la VM recién restaurada todavía no tiene red lista; el
   *      SSH muere porque `vip_wait` no consiguió la IP. Un reintento alcanza.
   *   2. `exit 1` con "no pude mintear el agent-token AV": el broker Agent-Vault
   *      (192.168.122.1:14321) falla cuando varias VMs hacen assign casi simultáneas (pico
   *      de inicio del REM). El backoff descongestiona.
   *  3 intentos, backoff 500ms → 1s → 2s. Si los 3 fallan, propaga el último error. */
  private async assignWithRetry(name: string, vaultId: string): Promise<void> {
    const sleepFn = this.deps.sleepImpl ?? sleep;
    const maxAttempts = 3;
    let delay = 500;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.deps.exec(this.deps.cp, ["assign", name, vaultId]);
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < maxAttempts) {
          console.warn(
            `[archima] assign de ${name} falló (intento ${attempt}/${maxAttempts}: ${(e as Error)?.message ?? e}) → reintento en ${delay}ms`,
          );
          await sleepFn(delay);
          delay *= 2;
        }
      }
    }
    throw lastErr;
  }

  /** Nombre de VM determinístico por usuario+env. Es la clave del lifecycle idempotente:
   *  el mismo título+envId siempre resuelve al mismo nombre, así que una VM "zombie" de un
   *  turno previo (con o sin session_id persistido en el store) es SIEMPRE detectable por
   *  `cp.sh state <name>` y reusable, sin re-spawnear. */
  private vmName(cfg: SessionConfig, title: string): string {
    return `${slug(title)}-${cfg.envId}`.slice(0, 50);
  }

  /** ¿`existing` es un nombre de VM que PERTENECE a este backend (patrón vmName de este env)?
   *  Sólo un nombre así es confiable como handle de VM. Un session_id ajeno (ej. un id de MA tipo
   *  `sesn_01Mc…` que quedó en el store tras un flip de backend `ma`→`local`) NO lo es: confiarlo
   *  ciego hacía que cp.sh lo tratara como una VM inexistente y CLONARA una VM basura con ese
   *  nombre (cold-start de minutos → el turno vencía timeout). Criterio (independiente del título,
   *  robusto a la truncación a 50 de vmName):
   *    - es exactamente el nombre determinístico actual `vmName(cfg, title)`, o
   *    - contiene el marcador `-${envId}` completo (nombre no truncado), o
   *    - mide 50 y termina con un PREFIJO del marcador (el slice a 50 cortó el `-${envId}`). */
  private isOwnVmName(existing: string, cfg: SessionConfig, title: string): boolean {
    if (!existing) return false;
    if (existing === this.vmName(cfg, title)) return true;
    const marker = `-${cfg.envId}`;
    if (existing.includes(marker)) return true;
    if (existing.length >= 50) {
      for (let k = marker.length - 1; k >= 5; k--) {
        if (existing.endsWith(marker.slice(0, k))) return true;
      }
    }
    return false;
  }

  /** Lleva la VM `name` a estado `running` de forma IDEMPOTENTE, sin re-spawnear si ya existe.
   *  Antes spawneábamos siempre → si la VM ya corría (zombie de un turno que falló a mitad), el
   *  re-spawn chocaba con `qemu-img: Failed to get "write" lock` (el overlay qcow2 lo tiene tomado
   *  la VM viva). Ahora chequeamos estado primero:
   *    - running  → REUSAR (no spawn): es la corrección del lock collision.
   *    - shut off → restore.
   *    - missing/desconocido → spawn (1er arranque real).
   *  Después: assign (vault) + wiki-setup, ambos idempotentes y best-effort por diseño.
   *  `state` opcional evita un `cp.sh state` redundante cuando el caller ya lo consultó. */
  private async ensureVm(name: string, cfg: SessionConfig, state?: string): Promise<void> {
    await this.bringVmUp(name, state);
    if (cfg.vaultId) {
      await this.assignWithRetry(name, cfg.vaultId);
      this.deps.registerVault?.(name, cfg.vaultId);
    }
    await this.deliverWikiSync(name, cfg);
  }

  /** Lleva SÓLO el estado de la VM a `running`, idempotente (sin assign/wiki — eso lo re-asegura
   *  el `cp.sh serve` con su retry de assign en resolveBase). Es el núcleo de ensureVm y también el
   *  path de wakeVm (recuperación tras reboot). `state` opcional evita un `cp.sh state` redundante.
   *    - running  → REUSAR (no spawn): corrección del lock collision (`qemu-img: Failed to get write lock`).
   *    - shut off → restore.
   *    - missing/desconocido → spawn. */
  private async bringVmUp(name: string, state?: string): Promise<void> {
    const s = state ?? (await this.deps.exec(this.deps.cp, ["state", name]).catch(() => ""));
    if (s.includes("running")) {
      // ya viva → reusar tal cual (NO spawn).
    } else if (s.includes("shut off")) {
      await this.deps.exec(this.deps.cp, ["restore", name]);
    } else {
      // "missing" o estado vacío/raro → arranque fresco.
      await this.deps.exec(this.deps.cp, ["spawn", name]);
    }
  }

  /** Arranca la VM de `sessionId` (el sessionId lógico ES el nombre de VM; un worker `<vm>#worker:ses`
   *  comparte VM con el coordinador → arrancamos la del coordinador). IDEMPOTENTE: si ya corre no
   *  re-spawnea (evita el lock collision del overlay qcow2). Lo llama el pump cuando recover() da
   *  "unreachable" PERSISTENTE (VM caída por reboot de gpuhost): el mismo path que createSession usa
   *  vía ensureVm, pero sin assign/wiki (los re-asegura el `cp.sh serve` del recover siguiente con su
   *  retry de assign). Devuelve true si pudo consultar/arrancar; false si el control plane no responde
   *  (gpuhost caído de verdad) → el caller deja de insistir. */
  async wakeVm(sessionId: string): Promise<boolean> {
    const name = sessionId.split("#worker:")[0] ?? sessionId;
    let state: string;
    try {
      state = await this.deps.exec(this.deps.cp, ["state", name]);
    } catch {
      return false; // ni el `cp.sh state` respondió → gpuhost/host caído: no insistas con restore/spawn
    }
    try {
      await this.bringVmUp(name, state);
      return true;
    } catch {
      return false;
    }
  }

  async createSession(cfg: SessionConfig, title: string): Promise<string> {
    const name = this.vmName(cfg, title);
    // INVALIDAR el binding opencode ANTES de tocar la VM: createSession es el path de /new
    // (recreateSession) y el sessionId lógico (= nombre de VM) es idéntico entre /new. Sin el
    // unbind, el `assign` de ensureVm ROTA el token AV pero ensureSession hacía early-return con
    // el binding viejo → `cp.sh serve` (el único que re-wrappea opencode con el token nuevo)
    // nunca corría (MCPs 407 → cascada de retries → 429 masivo) y la sesión opencode vieja
    // seguía viva (el contexto NO se reseteaba). unbind ⇒ openSessionOnce de nuevo: serve
    // (re-wrap, idempotente sin mismatch) + POST /session FRESCA.
    this.deps.opencode.unbind(name);
    // ensureVm es idempotente: aunque createSession se llame con una VM ya viva (zombie de un
    // turno previo, o reuse tras fallo de cold-start), NO re-spawnea → no hay lock collision.
    await this.ensureVm(name, cfg);
    // `agentRole` (SessionConfig) elige el agente de opencode de la sesión: "worker" para REM /
    // turnos batch (tools completas, sin spawn); default coordinador (sólo chat interactivo).
    await this.deps.opencode.ensureSession(name, { role: cfg.agentRole, model: cfg.localModel });
    return name;
  }

  /** Abre un sub-agente asíncrono DENTRO de la VM ya viva del coordinador (`vmSessionId` = su
   *  sessionId lógico = nombre de VM). NO clona una VM ni re-spawnea: sólo abre una sesión opencode
   *  nueva en esa instancia (mismo `base`, `ses` distinto) → el worker comparte VM/MCP-config con el
   *  coordinador pero corre en su propio stream. Antes el worker llamaba `createSession` con un
   *  título propio → vmName generaba OTRO nombre → cp.sh clonaba una VM por worker (cold-start de
   *  minutos). Devuelve el sessionId lógico del worker (usable con attach/send/close). */
  async createWorkerSession(vmSessionId: string): Promise<string> {
    return this.deps.opencode.openWorkerSession(vmSessionId);
  }

  async reuseOrCreate(cfg: SessionConfig, title: string, existing?: string): Promise<string> {
    // VALIDAMOS `existing` antes de confiarlo como nombre de VM: sólo un nombre que pertenece a este
    // backend es reusable. Un id ajeno (ej. un `sesn_…` de MA tras un flip de backend) se IGNORA y
    // caemos al nombre determinístico — si no, cp.sh lo trata como VM inexistente y clona una VM
    // basura (bug real de prod). Nombre determinístico: si el store perdió el session_id (turno que
    // falló antes de persistirlo), igual resolvemos al MISMO nombre y detectamos la VM zombie → la
    // reusamos en vez de re-spawnear y chocar con el lock.
    const trusted = existing && this.isOwnVmName(existing, cfg, title) ? existing : undefined;
    if (existing && !trusted) {
      console.log(
        `archima: session_id ajeno «${existing}» ignorado (¿flip de backend?) → uso nombre determinístico`,
      );
    }
    const name = trusted ?? this.vmName(cfg, title);
    // Sub-timing del revival (quickboot): mide cada paso del reopen para pinpoint el `open`.
    const tt = (() => {
      const t0 = Date.now();
      return { mark: (label: string) => `${label}:${((Date.now() - t0) / 1000).toFixed(1)}s` };
    })();
    const tState = Date.now();
    const state = await this.deps.exec(this.deps.cp, ["state", name]).catch(() => "");
    const stateMs = `state:${((Date.now() - tState) / 1000).toFixed(1)}s`;
    if (state.includes("running")) {
      // VM viva (reuse tras restart del gateway, o zombie de un turno previo). El binding opencode
      // se re-crea lazy en attach/prompt (el `bound` map arranca vacío). Registramos el vault
      // TAMBIÉN acá (este path no pasa por ensureVm): sin esto, el retry de `assign` ante un serve
      // con token rechazado no sabría qué vault re-mintear (incidente 2026-06-10: host rebooteado,
      // VM auto-levantada, token AV viejo → serve 401 en loop).
      if (cfg.vaultId) this.deps.registerVault?.(name, cfg.vaultId);
      // Wiki-sync FUERA del path crítico (quickboot): re-pullear las 5 wikis tardaba ~8s en CADA
      // reopen y es redundante en reuse — la VM ya las tiene clonadas, el git-auth no rota
      // (`signUserToken` es determinístico) y el agente las pulla lazy por el tag de deriva. Best-
      // effort en background (ya era try/catch "sigo sin sync"): el reopen no lo espera. En el path
      // de spawn/restore (VM fresca, wikis sin clonar) SÍ se sincroniza sync — ver ensureVm.
      this.deliverWikiSyncDetached(name, cfg);
      console.log(`⏱ revival[${name}] ${stateMs} wiki:async (reuse-running)`);
      return name;
    }
    // shut off → restore; missing → spawn. ensureVm cubre ambos (le pasamos el state ya leído).
    const tVm = Date.now();
    await this.ensureVm(name, cfg, state);
    const vmMs = `vm:${((Date.now() - tVm) / 1000).toFixed(1)}s`;
    const tSes = Date.now();
    await this.deps.opencode.ensureSession(name, { role: cfg.agentRole, model: cfg.localModel });
    console.log(
      `⏱ revival[${name}] ${stateMs} ${vmMs} session:${((Date.now() - tSes) / 1000).toFixed(1)}s (${tt.mark("total")}, cold-${state.includes("shut") ? "restore" : "spawn"})`,
    );
    return name;
  }

  async setSessionAgentConfig(sessionId: string, agentCfg: AgentConfig): Promise<void> {
    await this.deps.opencode.setAgentConfig(sessionId, agentCfg);
  }

  // --- Relay → pump del event-stream de opencode --------------------------
  attach(sessionId: string, sink: Sink): Relay {
    const oc = this.deps.opencode;
    let stopped = false;
    // close() ABORTA el stream SSE en vuelo (bug E): el flag solo no alcanzaba — el pump quedaba
    // parqueado en el read del SSE (sin eventos de SU sesión nunca re-chequeaba `stopped`) y cada
    // re-attach acumulaba un stream/pump más contra el mismo bus.
    const aborter = new AbortController();

    // Guardrail anti-runaway (defensa de profundidad): techo de PARED por turno. Se arma en cada
    // send() y se desarma cuando el turno cierra (turnComplete = session.idle) o el relay muere.
    // Al vencer: POST /session/:id/abort EN LA VM (frena la generación de verdad — un loop de
    // tool-error de gemma ocupó la GPU 40 min) + aviso claro al caller vía sink.error. El abort
    // dispara el session.idle de opencode → el turno cierra por el camino normal (turnComplete).
    const turnTimeoutMs = this.deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    let turnTimer: ReturnType<typeof setTimeout> | undefined;
    const disarm = (): void => {
      if (turnTimer) clearTimeout(turnTimer);
      turnTimer = undefined;
    };
    const arm = (): void => {
      if (turnTimeoutMs <= 0) return; // ≤0 = guardrail desactivado por config
      disarm();
      turnTimer = setTimeout(() => {
        turnTimer = undefined;
        const min = Math.round(turnTimeoutMs / 60_000);
        console.warn(`archima: turno de ${sessionId} superó ${min} min → abort anti-runaway`);
        void oc.abort(sessionId).catch(() => {});
        // SIN interna (nada de "archima"/"guardrail"): el detalle quedó en el console.warn.
        void sink.error?.(
          `⏱️ El turno superó el límite de ${min} min y fue abortado. Si era una tarea larga, probá dividirla en partes.`,
        );
      }, turnTimeoutMs);
    };
    // TTFT (quickboot): instante (epoch ms) del último `send` del usuario en este relay. El
    // translator lo lee en `session.idle` para calcular ttftMs ≈ prefill. 0 = ningún send aún
    // (turno no nacido del usuario, ej. prompt sintético de background) → el translator omite timing.
    let lastSentAt = 0;
    // Sink intervenido: desarma el techo en los bordes que cierran el turno. El resto pasa tal cual.
    const guarded: Sink = {
      ...sink,
      turnComplete: (usage, model, timing) => {
        disarm();
        return sink.turnComplete?.(usage, model, timing);
      },
      dead: () => {
        disarm();
        sink.dead?.();
      },
    };
    const tr = new RelayTranslator(guarded, { sentAt: () => lastSentAt });

    const sleepFn = this.deps.sleepImpl ?? sleep;
    const wakeVm = (id: string) => this.wakeVm(id);
    const pump = async () => {
      let backoff = 500;
      let failures = 0; // cortes CONSECUTIVOS del stream (un evento recibido los resetea)
      let unreachable = 0; // veredictos "unreachable" CONSECUTIVOS (un rebound/session-lost los resetea)
      let wakes = 0; // arranques de VM disparados en este relay (techo: MAX_WAKE_ATTEMPTS)
      while (!stopped) {
        try {
          for await (const ev of oc.events(sessionId, { signal: aborter.signal })) {
            if (stopped) return;
            // Un evento recibido = el stream está sano → reseteamos TODOS los contadores de
            // recuperación. En particular `wakes`: el techo MAX_WAKE_ATTEMPTS cuenta wakes SIN éxito
            // (= gpuhost muerto), no en toda la vida del relay → tras recuperar de un reboot (la VM
            // volvió a emitir), un segundo reboot tiene de nuevo presupuesto para arrancar la VM.
            failures = 0;
            unreachable = 0;
            wakes = 0;
            backoff = 500;
            if (tr.handle(ev) === "terminated") return;
          }
          backoff = 500;
          if (!stopped) await sleepFn(500);
        } catch (e) {
          if (stopped) return; // el abort de close() llega como throw del read → salida limpia
          failures++;
          sink.status?.(
            `[stream cortado ×${failures}] ${(e as Error)?.message ?? String(e)} → reconecto en ${backoff}ms`,
          );
          // Tras varios cortes seguidos el problema NO es un blip transitorio: huele a reboot del
          // host/VM (incidente 2026-06-10 — el SSE murió y nunca se re-estableció: turnos colgados
          // sin error). Recuperación ACTIVA: recover() re-corre `cp.sh serve` (re-asegura el serve,
          // y con el retry de assign del factory re-mintea el token AV si el broker lo rechaza) y
          // verifica si nuestra sesión opencode sobrevivió.
          if (failures >= RECOVER_AFTER_FAILURES && oc.recover) {
            const r = await oc.recover(sessionId).catch(() => "unreachable" as const);
            if (stopped) return; // el relay se cerró mientras recuperábamos → nada que reportar
            sink.status?.(`[recovery] ${r}`);
            if (r === "session-lost") {
              // El reboot se llevó la sesión: el contexto no es recuperable. UNA frase amable al
              // usuario (sin interna) y soltamos el relay vía dead() — el gateway recrea la sesión
              // en el próximo mensaje (recover() ya invalidó el binding → sesión opencode fresca).
              disarm(); // el turno en vuelo murió con la sesión: que no dispare el abort tardío
              void sink.error?.(SESSION_LOST_USER_MSG);
              guarded.dead?.();
              return;
            }
            if (r === "rebound") {
              // La sesión sigue viva (quizá en una IP nueva): re-suscribir YA, sin backoff. Una
              // recuperación EXITOSA renueva el presupuesto de wakes: MAX_WAKE_ATTEMPTS cuenta wakes
              // SIN éxito (= gpuhost muerto), no wakes en toda la vida del relay → un relay que
              // sobrevive a DOS reboots de gpuhost vuelve a tener presupuesto para arrancar la VM en el
              // segundo (sin esto, agotado en el 1ro, el 2do quedaba sin wakes).
              failures = 0;
              unreachable = 0;
              wakes = 0;
              backoff = 500;
              continue;
            }
            // r === "unreachable": la VM/serve no responden. recover() sólo corre `cp.sh serve`, que
            // NO levanta una VM `shut off` → si el reboot de gpuhost la apagó, esto se repetiría para
            // siempre. Tras WAKE_AFTER_UNREACHABLE veredictos seguidos (no al 1ro: un blip da 1-2 y se
            // cura solo) ARRANCAMOS la VM (mismo path idempotente de createSession: state→restore/spawn,
            // sin re-spawn si ya corre). Techo de MAX_WAKE_ATTEMPTS: si tras varios wakes sigue muerta,
            // gpuhost está caído de verdad → dejamos de insistir y seguimos sólo con backoff pasivo.
            unreachable++;
            if (unreachable >= WAKE_AFTER_UNREACHABLE && wakes < MAX_WAKE_ATTEMPTS) {
              wakes++;
              sink.status?.(
                `[recovery] VM caída tras reboot → arranco (intento ${wakes}/${MAX_WAKE_ATTEMPTS})`,
              );
              const woke = await wakeVm(sessionId).catch(() => false);
              if (stopped) return;
              unreachable = 0; // dimos el arranque: que el contador de "unreachable" vuelva a cero
              if (woke) {
                // La VM ya está arrancando (restore/spawn no espera al boot). El próximo recover (vía
                // resolveBase→`cp.sh serve`) re-asegura el serve y re-apunta el binding → rebind sin
                // perder contexto. Dejamos el backoff (no continue): el arranque tarda decenas de
                // segundos; reintentar al toque sólo quemaría los wakes contra una VM que aún bootea.
                // El umbral de recover queda armado para que el próximo corte vuelva a evaluar recover.
                failures = RECOVER_AFTER_FAILURES;
              }
              // wakeVm falló (control plane mudo = gpuhost caído): seguimos con backoff pasivo igual.
            }
          }
          await sleepFn(backoff);
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    };
    pump().catch((e) => {
      sink.status?.(`[relay caído] ${(e as Error)?.message ?? String(e)}`);
      guarded.dead?.(); // vía el sink intervenido → también desarma el techo de turno
    });

    return {
      // Downscaleamos/recomprimimos las imágenes ANTES de armar el data-URL: opencode sólo
      // inlinea como visión las imágenes chicas; las fotos reales hay que bajarlas primero.
      send: async (text, media) => {
        lastSentAt = Date.now(); // arranca el reloj del TTFT (quickboot): hasta el 1er token
        const r = await oc.prompt(sessionId, await toParts(text, await downscaleMedia(media)));
        arm(); // el prompt entró → corre el reloj de pared del turno (anti-runaway)
        return r;
      },
      interrupt: () => oc.abort(sessionId),
      summarize: () => oc.summarize(sessionId),
      close: () => {
        disarm();
        stopped = true;
        aborter.abort();
      },
    };
  }
}
