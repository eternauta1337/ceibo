// Endpoints de REM batch-pull para la VM de archima (Fase 5b).
//
// DISEÑO (invariante duro): este path vive en el web-server, SIN depender del gateway
// (conversacional / MA). El digest a Telegram se manda directo desde aquí.
//
// Dos endpoints bajo /api/rem/:
//
//   GET  /api/rem/batch   — enumera las wikis con delta pendiente + scope + pushToken
//   POST /api/rem/report  — recibe los resultados, avanza watermarks, manda digest
//
// AUTH (ambas rutas, fail-closed):
//   FRONTERA 1 — source-IP: último hop de x-forwarded-for contra allowedIps.
//                Sin allowlist → 403 siempre (fail-closed).
//   FRONTERA 2 — Bearer dedicado: Authorization: Bearer <REM_BATCH_SECRET>
//                comparado constant-time. Si REM_BATCH_SECRET no está seteado,
//                el handler no se monta (igual que git-proxy con su secret).
//
// Seguridad:
//   - El scope (lista de paths cambiados) NO se loguea (puede contener títulos de notas).
//   - El pushToken tampoco se loguea.
//   - El watermark NO avanza en GET /batch (sólo al reportar resultados OK).

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type Db,
  firstUserForRepo,
  getRemWatermark,
  listAllRepos,
  listChannels,
  setRemWatermark,
  signUserToken,
} from "@ceibo/store";
import type { WikiDelta, Wikis } from "@ceibo/wikis";
import { clientIpFrom } from "./http.ts";

// ── Tipos de wire ──────────────────────────────────────────────────────────────

/** Un ítem del response de GET /api/rem/batch. */
export interface RemBatchWiki {
  wiki: string;
  scope: string;
  pushToken: string;
}

/** Response de GET /api/rem/batch. */
export interface RemBatchResponse {
  batchId: string;
  generatedAt: string;
  wikis: RemBatchWiki[];
}

/** Un resultado de POST /api/rem/report. */
export interface RemReportResult {
  wiki: string;
  status: string; // "revisada" | "sin-cambios" | "error" | ...
  summary?: string;
  cost?: number;
  commit?: string;
}

/** Body de POST /api/rem/report. */
export interface RemReportBody {
  batchId: string;
  results: RemReportResult[];
}

// ── Opciones del handler ───────────────────────────────────────────────────────

export interface RemBatchHandlerOpts {
  /** HMAC key (REM_BATCH_SECRET). Bearer de sistema (gpuhost), NO per-usuario. */
  secret: string;
  /** IPs permitidas (FRONTERA 1). Set vacío → deniega todo (fail-closed). */
  allowedIps: ReadonlySet<string>;
  db: Db;
  wikis: Wikis;
  /** HMAC del token de usuario para el pushToken (== WIKI_SYNC_SECRET). */
  wikiSyncSecret: string;
  /** Token del bot de Telegram para el digest (TELEGRAM_BOT_TOKEN). undefined → sin digest. */
  telegramBotToken?: string;
  /** Base URL de la Bot API (override para tests). Default: https://api.telegram.org */
  telegramApiBase?: string;
  log?: (s: string) => void;
}

// ── Helpers internos ────────────────────────────────────────────────────────────

function errJson(res: ServerResponse, status: number, msg: string): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: msg }));
}

/** Verifica el Bearer constant-time contra el secret configurado.
 *  Rechaza si el header falta, tiene formato incorrecto o el valor no matchea. */
function verifyBearer(req: IncomingMessage, secret: string): boolean {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return false;
  const token = h.slice("Bearer ".length).trim();
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Lee y parsea el body JSON de la request (cota de 64 KB). Tira si el body excede el límite
 *  o si el JSON es inválido. */
async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("body-too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid-json"));
      }
    });
    req.on("error", reject);
  });
}

/** Texto del scope a pasar al rem-runner (lo consume el planner en rem-runner/runner.ts):
 *  - Sin watermark → primera corrida completa.
 *  - Con watermark + delta → lista los cambiados/borrados.
 *  Pre: delta.changed.length + delta.deleted.length > 0 (los sin delta se filtran antes). */
function buildScope(wm: string | null, delta: WikiDelta): string {
  if (!wm) {
    return "Es la PRIMERA corrida de REM sobre esta wiki: hacé una pasada COMPLETA.";
  }
  const changedPaths = delta.changed.map((c) => c.path);
  const deletedPaths = delta.deleted;
  const touched = [...changedPaths, ...deletedPaths.map((p) => `${p} (borrada)`)];
  if (touched.length === 0) {
    // Esto no debería pasar (filtramos antes), pero si ocurre damos un mensaje coherente.
    return `Desde tu última consolidación (commit ${wm.slice(0, 8)}) NO cambió ninguna nota. Mandá un reporte corto "sin cambios desde la última corrida" y terminá — NO re-escanees la wiki.`;
  }
  return (
    `Desde tu última consolidación (commit ${wm.slice(0, 8)}) cambiaron estas notas:\n` +
    `${touched.map((p) => `- ${p}`).join("\n")}\nConsolidá SÓLO eso y lo directamente relacionado.`
  );
}

/** Texto del digest para mandar al owner después de un batch report. */
function buildDigest(results: RemReportResult[]): string {
  const total = results.reduce((s, r) => s + (r.cost ?? 0), 0);
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const lines = results.map(
    (r) =>
      `• ${r.wiki}: ${r.status}` +
      (r.summary ? ` — ${r.summary}` : "") +
      (r.cost ? ` ($${r.cost.toFixed(4)})` : ""),
  );
  return (
    `🌙 REM batch — ${results.length} wikis: ${count("revisada")} revisadas, ` +
    `${count("sin-cambios")} sin cambios` +
    (count("error") ? `, ${count("error")} con error` : "") +
    `.\n${lines.join("\n")}` +
    (total ? `\n\nCosto total: $${total.toFixed(4)}.` : "")
  );
}

/** Intenta mandar el digest de Telegram al owner de cada wiki, fail-soft por destinatario. */
async function sendTelegramDigest(
  db: Db,
  results: RemReportResult[],
  botToken: string,
  apiBase: string,
  log: (s: string) => void,
): Promise<void> {
  // Agrupa resultados por owner (userId) para mandar un digest por persona.
  const byOwner = new Map<number, { chatId: string; results: RemReportResult[] }>();

  for (const r of results) {
    // Resolvemos el repo por nombre (buscamos en todos los repos, el nombre es único en la org).
    const allRepos = listAllRepos(db);
    const repo = allRepos.find((rp) => rp.name === r.wiki);
    if (!repo) {
      log(`rem-batch digest: wiki no encontrada en db: ${r.wiki}`);
      continue;
    }
    const owner = firstUserForRepo(db, repo.id);
    if (!owner) {
      log(`rem-batch digest: sin owner para ${r.wiki}`);
      continue;
    }
    const chatId = listChannels(db, owner.id).find((c) => c.channel === "telegram")?.external_id;
    if (!chatId) {
      log(`rem-batch digest: user=${owner.id} sin canal telegram`);
      continue;
    }
    const entry = byOwner.get(owner.id);
    if (entry) {
      entry.results.push(r);
    } else {
      byOwner.set(owner.id, { chatId, results: [r] });
    }
  }

  for (const [userId, { chatId, results: ownerResults }] of byOwner) {
    const text = buildDigest(ownerResults);
    try {
      const res = await fetch(`${apiBase}/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) {
        log(`rem-batch digest: telegram HTTP ${res.status} para user=${userId}`);
      }
    } catch (e) {
      log(`rem-batch digest: error enviando a user=${userId}: ${(e as Error)?.message ?? e}`);
    }
  }
}

// ── Handler principal ──────────────────────────────────────────────────────────

/** Fábrica del handler de /api/rem/*. Devuelve undefined si falta `secret`. */
export function makeRemBatchHandler(opts: RemBatchHandlerOpts) {
  const log = opts.log ?? (() => {});
  const apiBase = opts.telegramApiBase ?? "https://api.telegram.org";

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ── 0. FRONTERA 1: source-IP (fail-closed) ───────────────────────────────
    const clientIp = clientIpFrom(
      req.headers["x-forwarded-for"] as string | undefined,
      req.socket?.remoteAddress,
    );
    if (!opts.allowedIps.has(clientIp)) {
      log(`rem-batch: IP denegada ip=${clientIp}`);
      errJson(res, 403, "forbidden");
      return;
    }

    // ── 1. FRONTERA 2: Bearer constant-time ─────────────────────────────────
    if (!verifyBearer(req, opts.secret)) {
      log(`rem-batch: auth fallida ip=${clientIp}`);
      errJson(res, 401, "unauth");
      return;
    }

    // ── Dispatch por path ────────────────────────────────────────────────────
    const url = new URL(req.url ?? "/", "http://internal");
    const path = url.pathname;

    if (path === "/api/rem/batch" && req.method === "GET") {
      await handleBatch(req, res);
      return;
    }
    if (path === "/api/rem/report" && req.method === "POST") {
      await handleReport(req, res);
      return;
    }
    errJson(res, 404, "not-found");
  };

  // ── GET /api/rem/batch ─────────────────────────────────────────────────────
  async function handleBatch(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const batchId = `rem-${Date.now().toString(36)}`;
    const generatedAt = new Date().toISOString();
    const wikis: RemBatchWiki[] = [];

    const allRepos = listAllRepos(opts.db);
    for (const repo of allRepos) {
      // Owner de la wiki (primer usuario activo con acceso; criterio de firstUserForRepo).
      const owner = firstUserForRepo(opts.db, repo.id);
      if (!owner) continue;

      // Watermark actual.
      const wm = getRemWatermark(opts.db, repo.id);

      // Delta desde el watermark.
      let delta: WikiDelta;
      try {
        if (!wm) {
          // Primera corrida: forzamos delta vacío pero con la wiki presente (scope = completo).
          delta = { ref: "", changed: [], deleted: [] };
        } else {
          delta = await opts.wikis.changesSince(repo.name, wm);
        }
      } catch (e) {
        // Error transitorio (red / rate-limit / base gone): salteo esta wiki sin logs de scope.
        log(`rem-batch batch: error delta wiki=${repo.name}: ${(e as Error)?.message ?? e}`);
        continue;
      }

      // Solo incluir wikis con delta real (o primera corrida sin watermark).
      const hasChanges = !wm || delta.changed.length > 0 || delta.deleted.length > 0;
      if (!hasChanges) continue;

      // scope: texto del delta que pasará el runner al planificador.
      const scope = buildScope(wm, delta);

      // pushToken: firmado con el wikiSyncSecret, identifica al owner.
      const pushToken = signUserToken(owner.id, opts.wikiSyncSecret);

      wikis.push({ wiki: repo.name, scope, pushToken });
    }

    const body: RemBatchResponse = { batchId, generatedAt, wikis };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    log(`rem-batch batch: batchId=${batchId} wikis=${wikis.length}`);
  }

  // ── POST /api/rem/report ───────────────────────────────────────────────────
  async function handleReport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: RemReportBody;
    try {
      const raw = await readJsonBody(req);
      body = raw as RemReportBody;
      if (!Array.isArray(body?.results)) throw new Error("invalid-body");
    } catch (e) {
      errJson(res, 400, (e as Error)?.message ?? "bad-request");
      return;
    }

    const allRepos = listAllRepos(opts.db);
    let processed = 0;

    for (const r of body.results) {
      if (!r.wiki || typeof r.wiki !== "string") continue;
      const repo = allRepos.find((rp) => rp.name === r.wiki);
      if (!repo) {
        log(`rem-batch report: wiki no encontrada: ${r.wiki}`);
        continue;
      }

      // Solo avanzamos el watermark en resultados exitosos (no "error").
      if (r.status !== "error") {
        try {
          const headSha = await opts.wikis.headSha(repo.name);
          setRemWatermark(opts.db, repo.id, headSha);
        } catch (e) {
          log(`rem-batch report: no pude leer headSha de ${r.wiki}: ${(e as Error)?.message ?? e}`);
          // No avanzamos el watermark si no podemos leer el HEAD — conservador.
        }
      }
      processed++;
    }

    // Digest a Telegram (fail-soft: no rompe el report si el bot falla).
    if (opts.telegramBotToken && body.results.length > 0) {
      try {
        await sendTelegramDigest(opts.db, body.results, opts.telegramBotToken, apiBase, log);
      } catch (e) {
        log(`rem-batch report: error en digest telegram: ${(e as Error)?.message ?? e}`);
      }
    } else if (!opts.telegramBotToken) {
      log(`rem-batch report: sin TELEGRAM_BOT_TOKEN, digest omitido`);
    }

    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, processed }));
    log(`rem-batch report: batchId=${body.batchId} processed=${processed}`);
  }
}
