// Tests de los endpoints REM batch-pull (rem-batch.ts).
//
// Ejercita principalmente:
//   - auth (sin Bearer → 401; Bearer inválido → 401; IP fuera → 403)
//   - GET /api/rem/batch (wiki con delta → aparece con scope+token; sin delta → excluida)
//   - POST /api/rem/report (status ok → watermark al headSha; error → no avanza;
//     digest intentado — mockeamos fetch de la Bot API)

import type { IncomingMessage, ServerResponse } from "node:http";
import { Writable } from "node:stream";
import { addChannel, type Db, getRemWatermark, grantAccess, openDb, setRemWatermark } from "@ceibo/store";
import type { WikiDelta, Wikis } from "@ceibo/wikis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRemBatchHandler, type RemBatchResponse, type RemReportBody } from "./rem-batch.ts";

const SECRET = "test-rem-batch-secret";
const SYNC_SECRET = "test-wiki-sync-secret";
const ALLOWED_IP = "203.0.113.10"; // IP de archima (último hop XFF)
const TG_TOKEN = "123456:test-bot-token";

// ── DB en memoria ──────────────────────────────────────────────────────────────

function makeTestDb(): Db {
  // Creamos una DB en memoria usando la API de openDb con un path temporal.
  // Alternativa: usar el módulo store directamente con :memory:.
  // La forma más sencilla: importar better-sqlite3 y correr las migraciones del store.
  // Como el store no exporta un "make-in-memory", usamos openDb sobre un archivo temporal.
  const tmp = `/tmp/rem-batch-test-${Math.random().toString(36).slice(2)}.db`;
  return openDb(tmp);
}

function seedUser(db: Db, handle: string, telegramChatId?: string): number {
  // Insertamos usuario directamente (la API del store no tiene createUser público).
  const info = db
    .prepare(
      `INSERT INTO users (handle, name, status, created_at)
       VALUES (?, ?, 'active', datetime('now'))`,
    )
    .run(handle, handle);
  const userId = Number(info.lastInsertRowid);
  if (telegramChatId) {
    addChannel(db, userId, "telegram", telegramChatId);
  }
  return userId;
}

function seedRepo(db: Db, org: string, name: string, ownerId: number): number {
  const info = db
    .prepare(
      `INSERT INTO repos (org, name, label, created_at)
       VALUES (?, ?, NULL, datetime('now'))`,
    )
    .run(org, name);
  const repoId = Number(info.lastInsertRowid);
  grantAccess(db, repoId, ownerId, "owner");
  return repoId;
}

// ── Wikis fake ─────────────────────────────────────────────────────────────────

interface FakeWikisOpts {
  /** Mapa repo.name → WikiDelta. Si no está, changesSince tira. */
  deltas?: Record<string, WikiDelta>;
  /** Mapa repo.name → headSha. Si no está, headSha tira. */
  heads?: Record<string, string>;
  changesSinceError?: string; // si está, changesSince tira este error en todos
  headShaError?: string; // si está, headSha tira este error en todos
}

function fakeWikis(opts: FakeWikisOpts = {}): Wikis {
  return {
    org: "ceibofamily",
    changesSince: async (repoName: string, _baseRef: string): Promise<WikiDelta> => {
      if (opts.changesSinceError) throw new Error(opts.changesSinceError);
      const delta = opts.deltas?.[repoName];
      if (!delta) throw new Error(`no-delta-for-${repoName}`);
      return delta;
    },
    headSha: async (repoName: string): Promise<string> => {
      if (opts.headShaError) throw new Error(opts.headShaError);
      const sha = opts.heads?.[repoName];
      if (!sha) throw new Error(`no-head-for-${repoName}`);
      return sha;
    },
  } as unknown as Wikis;
}

// ── Fakes de request/response ──────────────────────────────────────────────────

function fakeRes(): { res: ServerResponse; captured: { status?: number; body: string } } {
  const captured: { status?: number; body: string } = { body: "" };
  // Writable real que acumula chunks. Mismo patrón que wiki-git-proxy.test.ts.
  const writable = new Writable({
    write(chunk: Buffer, _enc, cb) {
      captured.body += chunk.toString("utf8");
      cb();
    },
    final(cb) {
      cb();
    },
  });

  // Guardamos el end original ANTES de pisar con Object.assign para no recursar.
  const writableEnd = writable.end.bind(writable);

  const res = Object.assign(writable, {
    writeHead(status: number, _headers?: Record<string, string>) {
      captured.status = status;
      return res;
    },
    end(data?: string) {
      if (data) captured.body += data;
      writableEnd(); // llama al end real (no el override)
      return res;
    },
  }) as unknown as ServerResponse;
  return { res, captured };
}

function fakeReq(opts: {
  method: string;
  url: string;
  xff?: string;
  bearer?: string | null;
  body?: unknown;
}): IncomingMessage {
  const headers: Record<string, string> = {
    "x-forwarded-for": opts.xff ?? ALLOWED_IP,
  };
  if (opts.bearer !== null) {
    headers.authorization = `Bearer ${opts.bearer ?? SECRET}`;
  }

  const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  const req = {
    method: opts.method,
    url: opts.url,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    on(event: string, cb: (chunk?: Buffer | Error) => void) {
      if (event === "data" && bodyStr) cb(Buffer.from(bodyStr));
      if (event === "end") cb();
      return req;
    },
  } as unknown as IncomingMessage;
  return req;
}

// ── Helpers de handler ─────────────────────────────────────────────────────────

function makeHandler(
  db: Db,
  wikis: Wikis,
  opts: {
    allowedIps?: ReadonlySet<string>;
    telegramBotToken?: string;
    telegramApiBase?: string;
  } = {},
) {
  return makeRemBatchHandler({
    secret: SECRET,
    allowedIps: opts.allowedIps ?? new Set([ALLOWED_IP]),
    db,
    wikis,
    wikiSyncSecret: SYNC_SECRET,
    telegramBotToken: opts.telegramBotToken,
    telegramApiBase: opts.telegramApiBase,
  });
}

// ── Setup global ───────────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Tests de auth ──────────────────────────────────────────────────────────────

describe("rem-batch: autenticación", () => {
  it("IP fuera de la allowlist → 403", async () => {
    const db = makeTestDb();
    const handler = makeHandler(db, fakeWikis());
    const req = fakeReq({ method: "GET", url: "/api/rem/batch", xff: "1.2.3.4" });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(403);
  });

  it("sin allowlist configurada → 403 (fail-closed)", async () => {
    const db = makeTestDb();
    const handler = makeHandler(db, fakeWikis(), { allowedIps: new Set() });
    const req = fakeReq({ method: "GET", url: "/api/rem/batch" });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(403);
  });

  it("sin header Authorization → 401", async () => {
    const db = makeTestDb();
    const handler = makeHandler(db, fakeWikis());
    const req = fakeReq({ method: "GET", url: "/api/rem/batch", bearer: null });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(401);
  });

  it("Bearer con secret incorrecto → 401", async () => {
    const db = makeTestDb();
    const handler = makeHandler(db, fakeWikis());
    const req = fakeReq({ method: "GET", url: "/api/rem/batch", bearer: "wrong-secret" });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(401);
  });

  it("ruta desconocida → 404", async () => {
    const db = makeTestDb();
    const handler = makeHandler(db, fakeWikis());
    const req = fakeReq({ method: "GET", url: "/api/rem/unknown" });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(404);
  });
});

// ── Tests de GET /api/rem/batch ────────────────────────────────────────────────

describe("rem-batch: GET /api/rem/batch", () => {
  it("wiki sin watermark → aparece en batch (primera corrida, scope completo)", async () => {
    const db = makeTestDb();
    const userId = seedUser(db, "ale");
    seedRepo(db, "ceibofamily", "ale-wiki", userId);
    // Sin watermark → changesSince no se llama (lo detectamos por la ausencia de delta mock)
    const handler = makeHandler(db, fakeWikis());
    const req = fakeReq({ method: "GET", url: "/api/rem/batch" });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as RemBatchResponse;
    expect(body.wikis).toHaveLength(1);
    const first = body.wikis[0];
    expect(first?.wiki).toBe("ale-wiki");
    // scope debe mencionar primera corrida
    expect(first?.scope).toContain("PRIMERA corrida");
    // pushToken es un string no vacío
    expect(first?.pushToken).toBeTruthy();
    expect(body.batchId).toMatch(/^rem-/);
    expect(body.generatedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("wiki con watermark y delta → aparece en batch (scope incremental)", async () => {
    const db = makeTestDb();
    const userId = seedUser(db, "lula");
    const repoId = seedRepo(db, "ceibofamily", "lula-notas", userId);
    const wm = "abc123defabc123def";
    setRemWatermark(db, repoId, wm);
    const delta: WikiDelta = {
      ref: "HEAD",
      changed: [{ path: "note.md", content: "c", sha: "s1" }],
      deleted: [],
    };
    const handler = makeHandler(db, fakeWikis({ deltas: { "lula-notas": delta }, heads: {} }));
    const req = fakeReq({ method: "GET", url: "/api/rem/batch" });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as RemBatchResponse;
    expect(body.wikis).toHaveLength(1);
    const first = body.wikis[0];
    expect(first?.wiki).toBe("lula-notas");
    expect(first?.scope).toContain("note.md");
    expect(first?.scope).toContain(wm.slice(0, 8));
  });

  it("wiki con watermark y delta vacío → NO aparece en batch", async () => {
    const db = makeTestDb();
    const userId = seedUser(db, "ale");
    const repoId = seedRepo(db, "ceibofamily", "ale-wiki", userId);
    setRemWatermark(db, repoId, "deadbeef");
    const emptyDelta: WikiDelta = { ref: "HEAD", changed: [], deleted: [] };
    const handler = makeHandler(db, fakeWikis({ deltas: { "ale-wiki": emptyDelta } }));
    const req = fakeReq({ method: "GET", url: "/api/rem/batch" });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as RemBatchResponse;
    expect(body.wikis).toHaveLength(0);
  });

  it("wiki sin owner → no aparece en batch", async () => {
    const db = makeTestDb();
    // Repo sin ningún usuario con acceso
    db.prepare("INSERT INTO repos (org, name, label, created_at) VALUES (?, ?, NULL, datetime('now'))").run(
      "ceibofamily",
      "orphan-wiki",
    );
    const handler = makeHandler(db, fakeWikis());
    const req = fakeReq({ method: "GET", url: "/api/rem/batch" });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as RemBatchResponse;
    expect(body.wikis).toHaveLength(0);
  });

  it("NO avanza el watermark en GET /batch", async () => {
    const db = makeTestDb();
    const userId = seedUser(db, "ale");
    const repoId = seedRepo(db, "ceibofamily", "ale-wiki", userId);
    // Sin watermark → en batch aparece, pero el watermark no debe avanzar
    const handler = makeHandler(db, fakeWikis());
    const req = fakeReq({ method: "GET", url: "/api/rem/batch" });
    const { res } = fakeRes();
    await handler(req, res);
    expect(getRemWatermark(db, repoId)).toBeNull(); // intacto
  });
});

// ── Tests de POST /api/rem/report ──────────────────────────────────────────────

describe("rem-batch: POST /api/rem/report", () => {
  it("status ok → avanza el watermark al headSha actual", async () => {
    const db = makeTestDb();
    const userId = seedUser(db, "ale", "11111");
    const repoId = seedRepo(db, "ceibofamily", "ale-wiki", userId);
    const HEAD_SHA = "cafebabe1234567890";
    const handler = makeHandler(db, fakeWikis({ heads: { "ale-wiki": HEAD_SHA } }), {
      telegramBotToken: TG_TOKEN,
    });
    const body: RemReportBody = {
      batchId: "rem-test",
      results: [{ wiki: "ale-wiki", status: "revisada", summary: "consolidada", cost: 0.0012 }],
    };
    const req = fakeReq({ method: "POST", url: "/api/rem/report", body });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(200);
    const resp = JSON.parse(captured.body) as { ok: boolean; processed: number };
    expect(resp.ok).toBe(true);
    expect(resp.processed).toBe(1);
    // Watermark debe haber avanzado al HEAD
    expect(getRemWatermark(db, repoId)).toBe(HEAD_SHA);
  });

  it("status 'sin-cambios' → avanza el watermark (no es error)", async () => {
    const db = makeTestDb();
    const userId = seedUser(db, "lula", "22222");
    const repoId = seedRepo(db, "ceibofamily", "lula-notas", userId);
    const HEAD_SHA = "0011223344556677";
    const handler = makeHandler(db, fakeWikis({ heads: { "lula-notas": HEAD_SHA } }), {
      telegramBotToken: TG_TOKEN,
    });
    const body: RemReportBody = {
      batchId: "rem-test",
      results: [{ wiki: "lula-notas", status: "sin-cambios" }],
    };
    const req = fakeReq({ method: "POST", url: "/api/rem/report", body });
    const { res } = fakeRes();
    await handler(req, res);
    expect(getRemWatermark(db, repoId)).toBe(HEAD_SHA);
  });

  it("status 'error' → NO avanza el watermark", async () => {
    const db = makeTestDb();
    const userId = seedUser(db, "ale");
    const repoId = seedRepo(db, "ceibofamily", "ale-wiki", userId);
    setRemWatermark(db, repoId, "previous-sha");
    const handler = makeHandler(db, fakeWikis({ heads: { "ale-wiki": "new-sha" } }));
    const body: RemReportBody = {
      batchId: "rem-test",
      results: [{ wiki: "ale-wiki", status: "error", summary: "fallo el runner" }],
    };
    const req = fakeReq({ method: "POST", url: "/api/rem/report", body });
    const { res } = fakeRes();
    await handler(req, res);
    // Watermark NO debe haber cambiado
    expect(getRemWatermark(db, repoId)).toBe("previous-sha");
  });

  it("headSha falla → watermark no avanza (fail-closed)", async () => {
    const db = makeTestDb();
    const userId = seedUser(db, "ale");
    const repoId = seedRepo(db, "ceibofamily", "ale-wiki", userId);
    setRemWatermark(db, repoId, "old-sha");
    const handler = makeHandler(db, fakeWikis({ headShaError: "GitHub API unavailable" }));
    const body: RemReportBody = {
      batchId: "rem-test",
      results: [{ wiki: "ale-wiki", status: "revisada" }],
    };
    const req = fakeReq({ method: "POST", url: "/api/rem/report", body });
    const { res } = fakeRes();
    await handler(req, res);
    // Watermark no avanza si no podemos leer el HEAD
    expect(getRemWatermark(db, repoId)).toBe("old-sha");
  });

  it("intenta digest Telegram con telegramBotToken configurado", async () => {
    const db = makeTestDb();
    const userId = seedUser(db, "ale", "11111");
    seedRepo(db, "ceibofamily", "ale-wiki", userId);
    const handler = makeHandler(db, fakeWikis({ heads: { "ale-wiki": "sha123" } }), {
      telegramBotToken: TG_TOKEN,
    });
    const body: RemReportBody = {
      batchId: "rem-test",
      results: [{ wiki: "ale-wiki", status: "revisada", cost: 0.001 }],
    };
    const req = fakeReq({ method: "POST", url: "/api/rem/report", body });
    const { res } = fakeRes();
    await handler(req, res);
    // fetch debe haberse llamado para el sendMessage de Telegram
    expect(fetchMock).toHaveBeenCalled();
    const [url] = fetchMock.mock.calls[0] as [string, unknown];
    expect(url).toContain("sendMessage");
    expect(url).toContain(TG_TOKEN);
  });

  it("sin telegramBotToken → NO llama fetch (digest omitido, fail-soft)", async () => {
    const db = makeTestDb();
    const userId = seedUser(db, "ale", "11111");
    seedRepo(db, "ceibofamily", "ale-wiki", userId);
    const handler = makeHandler(db, fakeWikis({ heads: { "ale-wiki": "sha123" } }));
    const body: RemReportBody = {
      batchId: "rem-test",
      results: [{ wiki: "ale-wiki", status: "revisada" }],
    };
    const req = fakeReq({ method: "POST", url: "/api/rem/report", body });
    const { res } = fakeRes();
    await handler(req, res);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("usuario sin canal telegram → digest no falla (fail-soft)", async () => {
    const db = makeTestDb();
    const userId = seedUser(db, "ale"); // sin telegram chatId
    seedRepo(db, "ceibofamily", "ale-wiki", userId);
    const handler = makeHandler(db, fakeWikis({ heads: { "ale-wiki": "sha123" } }), {
      telegramBotToken: TG_TOKEN,
    });
    const body: RemReportBody = {
      batchId: "rem-test",
      results: [{ wiki: "ale-wiki", status: "revisada" }],
    };
    const req = fakeReq({ method: "POST", url: "/api/rem/report", body });
    const { res, captured } = fakeRes();
    await handler(req, res);
    // La respuesta sigue siendo 200 (fail-soft)
    expect(captured.status).toBe(200);
    // No se llama sendMessage si no hay chatId
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("body JSON inválido → 400", async () => {
    const db = makeTestDb();
    const handler = makeHandler(db, fakeWikis());
    // Mandamos texto no-JSON
    const req = {
      method: "POST",
      url: "/api/rem/report",
      headers: { "x-forwarded-for": ALLOWED_IP, authorization: `Bearer ${SECRET}` },
      socket: { remoteAddress: "127.0.0.1" },
      on(event: string, cb: (chunk?: Buffer | Error) => void) {
        if (event === "data") cb(Buffer.from("not-json!!!"));
        if (event === "end") cb();
        return req;
      },
    } as unknown as IncomingMessage;
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(400);
  });
});
