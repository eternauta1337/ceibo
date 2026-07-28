import { describe, expect, it } from "vitest";
import {
  addRepo,
  addUser,
  costOf,
  getRemWatermark,
  getSession,
  getSyncWatermark,
  getWikiHead,
  listActiveWatermarkedRepos,
  listSyncWatermarks,
  MARKUP,
  openDb,
  recordRemTurn,
  recordTurn,
  setRemWatermark,
  setSession,
  setSyncWatermark,
  setWikiHead,
  type TurnTokens,
} from "./index.ts";

const db = () => openDb(":memory:");
const tokens = (over: Partial<TurnTokens> = {}): TurnTokens => ({
  input: 0,
  output: 0,
  cache5m: 0,
  cache1h: 0,
  cacheRead: 0,
  ...over,
});

describe("costOf", () => {
  it("cero tokens → cero", () => {
    expect(costOf("claude-sonnet-4-6", tokens())).toBe(0);
  });
  it("más tokens → más costo, monótono", () => {
    const a = costOf("claude-sonnet-4-6", tokens({ input: 1000 }));
    const b = costOf("claude-sonnet-4-6", tokens({ input: 2000 }));
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
  });
  it("output suele costar más que input (mismo conteo)", () => {
    const inp = costOf("claude-sonnet-4-6", tokens({ input: 1000 }));
    const out = costOf("claude-sonnet-4-6", tokens({ output: 1000 }));
    expect(out).toBeGreaterThan(inp);
  });
  it("modelo desconocido usa el precio fallback (no cero)", () => {
    expect(costOf("modelo-inventado", tokens({ input: 1000 }))).toBeGreaterThan(0);
  });
  it("modelo LOCAL (archima) → costo 0, no tarifa Anthropic", () => {
    // El id grabado para un turno local es el modelID de opencode, sin prefijo de provider.
    expect(costOf("gemma4-31b", tokens({ input: 1000, output: 1000, cacheRead: 1000 }))).toBe(0);
    // Caso defensivo provider-qualified.
    expect(costOf("local/gemma4-31b", tokens({ input: 5000 }))).toBe(0);
  });
  it("modelo MA (claude-*) sigue cobrando normal (no lo afecta el fix local)", () => {
    expect(costOf("claude-sonnet-4-6", tokens({ input: 1000, output: 1000 }))).toBeGreaterThan(0);
  });
  it("MARKUP default = 1 (sin CEIBO_BILLING_MARKUP)", () => {
    expect(MARKUP).toBe(1);
  });
});

describe("sesiones + metering por diferencia", () => {
  it("setSession arranca el snapshot en 0", () => {
    const d = db();
    const u = addUser(d, "demo");
    setSession(d, u.id, "sess-1");
    const s = getSession(d, u.id);
    expect(s?.session_id).toBe("sess-1");
    expect(s?.last_input).toBe(0);
  });

  it("recordTurn cobra el delta contra el snapshot y lo avanza", () => {
    const d = db();
    const u = addUser(d, "demo");
    setSession(d, u.id, "sess-1");
    const t1 = recordTurn(d, u.id, "sess-1", "claude-sonnet-4-6", {
      input: 100,
      output: 50,
      cache5m: 0,
      cache1h: 0,
      cacheRead: 0,
    });
    expect(t1?.input).toBe(100);
    expect(t1?.costUsd).toBeGreaterThan(0);
    // segundo turno: el acumulado sube a 250/120 → delta 150/70
    const t2 = recordTurn(d, u.id, "sess-1", "claude-sonnet-4-6", {
      input: 250,
      output: 120,
      cache5m: 0,
      cache1h: 0,
      cacheRead: 0,
    });
    expect(t2?.input).toBe(150);
    expect(t2?.output).toBe(70);
  });

  it("recordTurn sin delta → undefined (nada que cobrar)", () => {
    const d = db();
    const u = addUser(d, "demo");
    setSession(d, u.id, "sess-1");
    recordTurn(d, u.id, "sess-1", "m", { input: 100, output: 0, cache5m: 0, cache1h: 0, cacheRead: 0 });
    const again = recordTurn(d, u.id, "sess-1", "m", {
      input: 100,
      output: 0,
      cache5m: 0,
      cache1h: 0,
      cacheRead: 0,
    });
    expect(again).toBeUndefined();
  });

  it("sesión distinta → snapshot arranca de 0 (cobra el acumulado entero)", () => {
    const d = db();
    const u = addUser(d, "demo");
    setSession(d, u.id, "sess-1");
    recordTurn(d, u.id, "sess-1", "m", { input: 500, output: 0, cache5m: 0, cache1h: 0, cacheRead: 0 });
    // turno reportado contra OTRA sesión → base 0
    const t = recordTurn(d, u.id, "sess-2", "m", {
      input: 80,
      output: 0,
      cache5m: 0,
      cache1h: 0,
      cacheRead: 0,
    });
    expect(t?.input).toBe(80);
  });
});

describe("REM turn + watermark", () => {
  it("recordRemTurn devuelve el costo y no toca el snapshot de sesión", () => {
    const d = db();
    const u = addUser(d, "demo");
    setSession(d, u.id, "sess-1");
    const cost = recordRemTurn(d, u.id, "rem-sess", "claude-haiku-4-5-20251001", {
      input: 100,
      output: 10,
      cache5m: 0,
      cache1h: 0,
      cacheRead: 0,
    });
    expect(cost).toBeGreaterThan(0);
    expect(getSession(d, u.id)?.last_input).toBe(0); // intacto
  });

  it("watermark de REM por repo: null al inicio, upsert avanza", () => {
    const d = db();
    const r = addRepo(d, "o", "wiki");
    expect(getRemWatermark(d, r.id)).toBeNull();
    setRemWatermark(d, r.id, "sha-a");
    expect(getRemWatermark(d, r.id)).toBe("sha-a");
    setRemWatermark(d, r.id, "sha-b");
    expect(getRemWatermark(d, r.id)).toBe("sha-b");
  });
});

describe("sync watermark (deriva de wikis, Fase 2c)", () => {
  it("null al inicio; upsert avanza el ref por (usuario, repo)", () => {
    const d = db();
    const u = addUser(d, "demo");
    expect(getSyncWatermark(d, u.id, "demo-personal")).toBeNull();
    setSyncWatermark(d, u.id, "demo-personal", "ref-a");
    expect(getSyncWatermark(d, u.id, "demo-personal")).toBe("ref-a");
    setSyncWatermark(d, u.id, "demo-personal", "ref-b");
    expect(getSyncWatermark(d, u.id, "demo-personal")).toBe("ref-b");
  });

  it("aísla por usuario y por repo (la copia local es por sesión = por user)", () => {
    const d = db();
    const a = addUser(d, "ale");
    const b = addUser(d, "lula");
    setSyncWatermark(d, a.id, "shared", "ref-ale");
    setSyncWatermark(d, b.id, "shared", "ref-lula");
    setSyncWatermark(d, a.id, "ale-personal", "ref-otra");
    // mismo repo, distinto user → refs independientes (cada uno tiene su working copy)
    expect(getSyncWatermark(d, a.id, "shared")).toBe("ref-ale");
    expect(getSyncWatermark(d, b.id, "shared")).toBe("ref-lula");
    // mismo user, distinto repo → no se pisan
    expect(getSyncWatermark(d, a.id, "ale-personal")).toBe("ref-otra");
    expect(getSyncWatermark(d, b.id, "ale-personal")).toBeNull();
  });

  it("listSyncWatermarks devuelve todas las wikis sincronizadas del user (para chequear deriva)", () => {
    const d = db();
    const a = addUser(d, "ale");
    const b = addUser(d, "lula");
    expect(listSyncWatermarks(d, a.id)).toEqual([]);
    setSyncWatermark(d, a.id, "ale-personal", "ref-1");
    setSyncWatermark(d, a.id, "shared", "ref-2");
    setSyncWatermark(d, b.id, "shared", "ref-otro"); // de otro user → no aparece
    const got = listSyncWatermarks(d, a.id).sort((x, y) => x.repo.localeCompare(y.repo));
    expect(got).toEqual([
      { repo: "ale-personal", ref: "ref-1" },
      { repo: "shared", ref: "ref-2" },
    ]);
  });
});

describe("wiki_heads (watcher único, Fase 2c)", () => {
  it("getWikiHead null al inicio; setWikiHead upserta el HEAD conocido", () => {
    const d = db();
    expect(getWikiHead(d, "demo-ceibo")).toBeNull();
    setWikiHead(d, "demo-ceibo", "sha-1");
    expect(getWikiHead(d, "demo-ceibo")).toBe("sha-1");
    setWikiHead(d, "demo-ceibo", "sha-2");
    expect(getWikiHead(d, "demo-ceibo")).toBe("sha-2");
    expect(getWikiHead(d, "otra")).toBeNull(); // por repo, no se pisan
  });

  it("listActiveWatermarkedRepos: repos distintos con watermark dentro de la ventana", () => {
    const d = db();
    const a = addUser(d, "ale");
    const b = addUser(d, "lula");
    setSyncWatermark(d, a.id, "ale-personal", "r1");
    setSyncWatermark(d, b.id, "ale-personal", "r2"); // mismo repo, otro user → DISTINCT lo colapsa
    setSyncWatermark(d, a.id, "shared", "r3");
    const got = listActiveWatermarkedRepos(d, 15).sort();
    expect(got).toEqual(["ale-personal", "shared"]);
    // Ventana de 0 minutos: un watermark con synced_at viejo (simulado) queda afuera.
    d.prepare("UPDATE wiki_sync_watermarks SET synced_at = datetime('now','-1 hour')").run();
    expect(listActiveWatermarkedRepos(d, 15)).toEqual([]);
  });
});
