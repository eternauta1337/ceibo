// Orquestador cron-pull de REM para gpuhost (Fase 5b).
//
// Flujo:
//   1. GET /api/rem/batch  — pide al web-server qué wikis tienen delta pendiente
//   2. runRemForWiki()     — corre REM sobre cada wiki secuencialmente (wipe-between ya
//                           lo maneja el runner: scratch efímero, rm -rf en el finally)
//   3. POST /api/rem/report — reporta los resultados; el web-server avanza watermarks y
//                            manda el digest de Telegram al owner
//
// AUTH contra el web-server (ambas rutas):
//   FRONTERA 1 — la box de gpuhost necesita estar en la allowedIps del web-server.
//   FRONTERA 2 — Authorization: Bearer $REM_BATCH_SECRET (variable de entorno).
//
// Env vars (ver batchConfigFromEnv):
//   REM_BATCH_BASE         URL base del web-server (ej. "https://ceibo.example.com")
//   REM_BATCH_SECRET       Bearer token (= REM_BATCH_SECRET del web-server)
//   Más las del runner (REM_GIT_PROXY_BASE, REM_OPENCODE_BASE, etc.) — ver runner.ts

import { configFromEnv, type RemRunnerConfig, runRemForWiki } from "./runner.ts";

// ── Tipos de wire (espejo de web-server/rem-batch.ts) ─────────────────────────

/** Un ítem del response de GET /api/rem/batch. */
interface RemBatchWiki {
  wiki: string;
  scope: string;
  pushToken: string;
}

/** Response de GET /api/rem/batch. */
interface RemBatchResponse {
  batchId: string;
  generatedAt: string;
  wikis: RemBatchWiki[];
}

/** Un resultado de POST /api/rem/report (espejo de RemReportResult). */
interface RemReportResult {
  wiki: string;
  status: string;
  summary?: string;
  cost?: number;
}

/** Body de POST /api/rem/report. */
interface RemReportBody {
  batchId: string;
  results: RemReportResult[];
}

// ── Config del batch ───────────────────────────────────────────────────────────

export interface BatchConfig {
  /** URL base del web-server (sin trailing slash). Ej: "https://ceibo.example.com" */
  batchBase: string;
  /** Bearer token compartido con el web-server (REM_BATCH_SECRET). */
  batchSecret: string;
  /** Config del runner per-wiki (endpoints, keys, modelos). */
  runner: RemRunnerConfig;
}

/** Construye la config del batch desde variables de entorno (más la del runner). */
export function batchConfigFromEnv(): BatchConfig {
  const raw = process.env.REM_BATCH_BASE ?? "https://ceibo.example.com";
  const batchBase = raw.replace(/\/$/, "");
  const batchSecret = process.env.REM_BATCH_SECRET ?? "";
  if (!batchSecret) {
    throw new Error("REM_BATCH_SECRET no está seteado — necesario para autenticarse con el web-server");
  }
  const runner = configFromEnv();
  return { batchBase, batchSecret, runner };
}

// ── Helpers internos ───────────────────────────────────────────────────────────

/** Headers de auth comunes a ambas rutas. */
function authHeaders(secret: string): Record<string, string> {
  return {
    authorization: `Bearer ${secret}`,
    "content-type": "application/json",
  };
}

/** GET /api/rem/batch: obtiene las wikis con delta pendiente. */
async function fetchBatch(cfg: BatchConfig): Promise<RemBatchResponse> {
  const base = cfg.batchBase.replace(/\/$/, "");
  const url = `${base}/api/rem/batch`;
  const res = await fetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${cfg.batchSecret}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET /api/rem/batch ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as RemBatchResponse;
}

/** POST /api/rem/report: entrega los resultados al web-server. */
async function postReport(cfg: BatchConfig, body: RemReportBody): Promise<void> {
  const base = cfg.batchBase.replace(/\/$/, "");
  const url = `${base}/api/rem/report`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(cfg.batchSecret),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const responseBody = await res.text().catch(() => "");
    throw new Error(`POST /api/rem/report ${res.status}: ${responseBody.slice(0, 200)}`);
  }
}

// ── Entry pública ──────────────────────────────────────────────────────────────

/**
 * Corre el batch completo: GET batch → runRemForWiki por wiki → POST report.
 * Devuelve los resultados (para testing / salida de log).
 *
 * @param cfg   Config inyectable (batchUrl, batchSecret, runner)
 * @param log   Función de log (default: console.log)
 */
export async function runRemBatch(
  cfg: BatchConfig,
  log: (s: string) => void = console.log,
): Promise<RemReportResult[]> {
  // 1. Pedir al web-server qué wikis tienen delta pendiente.
  log("[rem-batch] GET /api/rem/batch...");
  const batch = await fetchBatch(cfg);
  log(`[rem-batch] batchId=${batch.batchId} wikis=${batch.wikis.length}`);

  if (batch.wikis.length === 0) {
    log("[rem-batch] sin wikis con delta — nada que hacer");
    await postReport(cfg, { batchId: batch.batchId, results: [] });
    return [];
  }

  // 2. Correr REM secuencialmente (wipe-between lo maneja runner.ts en su finally).
  //    Error en una wiki → aislado: se captura, se incluye en el report con status=error,
  //    el resto del batch continúa.
  const results: RemReportResult[] = [];
  for (const item of batch.wikis) {
    log(`[rem-batch] procesando wiki=${item.wiki}`);
    // No logueamos pushToken ni scope (puede contener títulos de notas).
    let result: RemReportResult;
    try {
      // El pushToken de la wiki tiene precedencia sobre el env REM_PUSH_TOKEN.
      const wikiCfg: RemRunnerConfig = { ...cfg.runner, pushToken: item.pushToken };
      const r = await runRemForWiki(item.wiki, wikiCfg, item.scope);
      result = { wiki: r.wiki, status: r.status, summary: r.summary, cost: r.cost };
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      console.error(`[rem-batch] error inesperado wiki=${item.wiki}: ${msg}`);
      result = { wiki: item.wiki, status: "error", summary: msg };
    }
    log(`[rem-batch] wiki=${item.wiki} status=${result.status}`);
    results.push(result);
  }

  // 3. Reportar al web-server (watermarks + digest Telegram).
  log(`[rem-batch] POST /api/rem/report batchId=${batch.batchId} results=${results.length}`);
  await postReport(cfg, { batchId: batch.batchId, results });
  log("[rem-batch] listo");

  return results;
}
