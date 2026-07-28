// Smoke de recordRemTurn (Fase 16). Invariante crítico: registrar el uso de una corrida
// REM va al ledger usage_turns SIN tocar el snapshot de metering de la sesión de chat
// (recordTurn keyea por user_id en `sessions`; recordRemTurn NO debe pisarlo, o el próximo
// turno de chat calcularía un delta corrupto). Corré: tsx packages/store/smoke-rem.mts
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addRepo,
  addUser,
  costOf,
  firstUserForRepo,
  getRemWatermark,
  getSession,
  grantAccess,
  openDb,
  recordRemTurn,
  recordTurn,
  setRemWatermark,
  setUserStatus,
} from "./src/index.ts";

const db = openDb(join(tmpdir(), `ceibo-rem-smoke-${Date.now()}.db`));
const u = addUser(db, "remsmoke");

// 1) Establecé un snapshot de sesión de chat (haiku) con un acumulado conocido.
const CHAT = "chat-session-aaa";
recordTurn(db, u.id, CHAT, "claude-haiku-4-5", {
  input: 100,
  output: 50,
  cache5m: 0,
  cache1h: 0,
  cacheRead: 0,
});
const snapBefore = getSession(db, u.id);
if (snapBefore?.session_id !== CHAT) throw new Error("snapshot de chat no quedó seteado");
if (snapBefore.last_input !== 100) throw new Error("last_input de chat mal");

// 2) Corré REM en una sesión efímera APARTE (sonnet). El usage acumulado de esa sesión ES
// el total de la corrida.
const REM = "rem-session-zzz";
const t = { input: 1_000_000, output: 200_000, cache5m: 0, cache1h: 0, cacheRead: 500_000 };
const cost = recordRemTurn(db, u.id, REM, "claude-sonnet-4-6", t);

// 3) El costo devuelto = costOf con la tarifa de sonnet (misma fuente de verdad).
const expected = costOf("claude-sonnet-4-6", t);
if (cost !== expected) throw new Error(`costo REM ${cost} != costOf ${expected}`);
if (!(cost > 0)) throw new Error("costo REM no positivo");

// 4) INVARIANTE: el snapshot de la sesión de chat quedó INTACTO (REM no lo pisó).
const snapAfter = getSession(db, u.id);
if (snapAfter?.session_id !== CHAT) throw new Error("REM pisó el session_id del chat");
if (snapAfter.last_input !== 100 || snapAfter.last_output !== 50)
  throw new Error("REM corrompió el snapshot de metering del chat");

// 5) La corrida REM quedó en el ledger (usage_turns) con su propio session_id y modelo.
const row = db
  .prepare("SELECT model, input_tokens, cost_usd FROM usage_turns WHERE session_id = ?")
  .get(REM) as { model: string; input_tokens: number; cost_usd: number } | undefined;
if (!row) throw new Error("la corrida REM no se registró en usage_turns");
if (row.model !== "claude-sonnet-4-6" || row.input_tokens !== t.input)
  throw new Error("fila REM en usage_turns con datos mal");

// 6) Watermark incremental (Fase 16): null por default → set → get → update.
const repo = addRepo(db, "example-wikis", "demo");
if (getRemWatermark(db, repo.id) !== null) throw new Error("watermark default no es null (primera corrida)");
setRemWatermark(db, repo.id, "aaaa1111");
if (getRemWatermark(db, repo.id) !== "aaaa1111") throw new Error("set watermark falló");
setRemWatermark(db, repo.id, "bbbb2222"); // upsert: avanza al HEAD nuevo
if (getRemWatermark(db, repo.id) !== "bbbb2222") throw new Error("upsert watermark falló");

// 7) Dueño de la wiki (cron): el primer usuario activo con acceso. Define quién corre REM
// sobre una wiki compartida (una sola vez) y a quién se atribuye el costo.
const shared = addRepo(db, "example-wikis", "casa");
if (firstUserForRepo(db, shared.id) !== undefined) throw new Error("repo sin acceso debería no tener dueño");
const ua = addUser(db, "owner-a"); // id menor → dueño por desempate
const ub = addUser(db, "owner-b");
grantAccess(db, shared.id, ub.id); // ub primero por acceso, pero...
grantAccess(db, shared.id, ua.id);
// Mismo created_at (segundos) → desempata por id ascendente: gana ua (id menor).
if (firstUserForRepo(db, shared.id)?.id !== ua.id)
  throw new Error("dueño debería ser el de id menor en empate");
setUserStatus(db, ua.id, "disabled"); // dueño deshabilitado → pasa al siguiente activo
if (firstUserForRepo(db, shared.id)?.id !== ub.id)
  throw new Error("dueño debería saltar al activo siguiente");

console.log("OK rem smoke");
