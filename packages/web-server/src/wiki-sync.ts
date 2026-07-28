// Endpoint de sync del substrato de wikis (Fase 2a, plan substrato-wikis-working-copy.md).
//
// SEGURIDAD (crítico): el sandbox del agente NO tiene el token de GitHub — la GitHub App
// key vive SOLO en el server. El sandbox habla con ESTE endpoint por HTTPS con un token de
// IDENTIDAD firmado (`<userId>.<hmac>`, HMAC con WIKI_SYNC_SECRET) que se le monta como
// archivo (fuera del contexto del modelo). De ese token sale el userId; el server (que sí
// tiene la App key) hace las ops contra GitHub, scoped a EXACTAMENTE los repos del user, con
// path-safety en cada cambio. Si el token se filtra, sólo da acceso a este endpoint para las
// wikis de ese user — nunca a GitHub directo.
//
// Se monta en el web server del gateway bajo /api/sync/ (el edge ya rutea /api → gateway).
// Auth por Bearer (NO cookie, NO origin-check: es server-to-sandbox, no un browser).
//
// - GET  /api/sync/read?repo=&ref=    → hidratación (foto del repo)
// - GET  /api/sync/changes?repo=&since= → pull incremental (delta)
// - POST /api/sync/commit             → push (un commit; registra el change feed)

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type Db,
  getUser,
  recordWikiChange,
  setSyncWatermark,
  setWikiHead,
  verifyUserToken,
} from "@ceibo/store";
import { type Change, gitAuthorFor, type Wikis } from "@ceibo/wikis";
import { isSafeRelPath } from "./path-safety.ts";

export interface WikiSyncOpts {
  secret: string; // HMAC del token de identidad (WIKI_SYNC_SECRET)
  wikis: Wikis;
  userRepoNames: (userId: number) => string[];
  db: Db; // para registrar el change feed tras un commit exitoso
  /** Lector del body (compartido con web.ts). `null` = body > max (payload too large)
   *  → acá cae en el mismo path de body inválido (bad-request). */
  readBody: (req: IncomingMessage, max: number) => Promise<string | null>;
  log?: (s: string) => void;
}

// Tope del body del commit: generoso para scripts de cambios masivos (muchos archivos).
const MAX_COMMIT_BYTES = 30 * 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/** Token del header `Authorization: Bearer <token>`. */
function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return undefined;
  const t = h.slice("Bearer ".length).trim();
  return t || undefined;
}

/** Handler de /api/sync/*. Devuelve siempre una respuesta (el dispatcher del web server ya
 *  filtró el prefijo). */
export function makeWikiSyncHandler(opts: WikiSyncOpts) {
  const log = opts.log ?? (() => {});
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Auth: token firmado → userId (constante en tiempo; verifyUserToken usa timingSafeEqual).
    const token = bearer(req);
    const userId = token ? verifyUserToken(token, opts.secret) : undefined;
    if (userId === undefined) {
      json(res, 401, { error: "unauth" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://internal");
    const path = url.pathname;
    const allowed = new Set(opts.userRepoNames(userId));
    const repoOf = (r: string | null): string | undefined => (r && allowed.has(r) ? r : undefined); // repo-gate: tiene que ser de ESTE user

    // GET /api/sync/read?repo=&ref=  — foto del repo (hidratación).
    if (path === "/api/sync/read" && req.method === "GET") {
      const repo = repoOf(url.searchParams.get("repo"));
      if (!repo) {
        json(res, 403, { error: "repo" });
        return;
      }
      const ref = url.searchParams.get("ref") ?? undefined;
      const snap = await opts.wikis.read(repo, ref);
      // Deriva (Fase 2c): la copia local del user queda en snap.ref. El gateway compara esto
      // contra el HEAD del substrato antes de cada turno para saber si pedirle un pull.
      setSyncWatermark(opts.db, userId, repo, snap.ref);
      log(`sync read user=${userId} ${repo}@${snap.ref} (${snap.files.length} files)`);
      json(res, 200, snap);
      return;
    }

    // GET /api/sync/changes?repo=&since=  — delta desde un ref (pull incremental).
    if (path === "/api/sync/changes" && req.method === "GET") {
      const repo = repoOf(url.searchParams.get("repo"));
      if (!repo) {
        json(res, 403, { error: "repo" });
        return;
      }
      const since = url.searchParams.get("since");
      if (!since) {
        json(res, 400, { error: "since" });
        return;
      }
      const delta = await opts.wikis.changesSince(repo, since);
      // Tras aplicar el delta, la copia local del user queda en delta.ref (Fase 2c, deriva).
      setSyncWatermark(opts.db, userId, repo, delta.ref);
      json(res, 200, delta);
      return;
    }

    // GET /api/sync/recall?repo=&path=  — recupera del historial un archivo archivado (borrado).
    // Devuelve su última versión viva; el cliente la re-agrega por el push normal.
    if (path === "/api/sync/recall" && req.method === "GET") {
      const repo = repoOf(url.searchParams.get("repo"));
      if (!repo) {
        json(res, 403, { error: "repo" });
        return;
      }
      const filePath = url.searchParams.get("path");
      if (!filePath || !isSafeRelPath(filePath)) {
        json(res, 400, { error: "path" });
        return;
      }
      try {
        const file = await opts.wikis.recall(repo, filePath);
        log(`sync recall user=${userId} ${repo} ${filePath}`);
        json(res, 200, file);
      } catch (e) {
        // No archivado / sin historia / no recuperable → 404 con el motivo.
        json(res, 404, { error: e instanceof Error ? e.message : "recall-failed" });
      }
      return;
    }

    // GET /api/sync/search-archived?repo=&q=  — busca un término en el CONTENIDO de lo archivado
    // (las notas listadas en los `_archivado.md`, leídas desde la historia).
    if (path === "/api/sync/search-archived" && req.method === "GET") {
      const repo = repoOf(url.searchParams.get("repo"));
      if (!repo) {
        json(res, 403, { error: "repo" });
        return;
      }
      const q = url.searchParams.get("q");
      if (!q) {
        json(res, 400, { error: "q" });
        return;
      }
      const result = await opts.wikis.searchArchived(repo, q);
      log(`sync search-archived user=${userId} ${repo} "${q}" → ${result.matches.length}/${result.scanned}`);
      json(res, 200, result);
      return;
    }

    // POST /api/sync/commit  {repo, baseRef, changes, message}  — push (un commit).
    if (path === "/api/sync/commit" && req.method === "POST") {
      let p: { repo?: string; baseRef?: string; changes?: Change[]; message?: string } = {};
      try {
        p = JSON.parse((await opts.readBody(req, MAX_COMMIT_BYTES)) ?? "");
      } catch {
        /* body inválido → cae en bad-request abajo */
      }
      const repo = repoOf(p.repo ?? null);
      if (!repo) {
        json(res, 403, { error: "repo" });
        return;
      }
      if (typeof p.baseRef !== "string" || !Array.isArray(p.changes) || typeof p.message !== "string") {
        json(res, 400, { error: "bad-request" });
        return;
      }
      // Path-safety + forma de cada cambio (defensa en profundidad sobre el repo-gate).
      for (const c of p.changes) {
        if (!c || typeof c.path !== "string" || !isSafeRelPath(c.path)) {
          json(res, 400, { error: `path inválido: ${c?.path}` });
          return;
        }
        if (c.op === "put") {
          if (typeof c.content !== "string") {
            json(res, 400, { error: `falta content en put ${c.path}` });
            return;
          }
        } else if (c.op !== "delete") {
          json(res, 400, { error: `op inválida: ${(c as { op?: unknown }).op}` });
          return;
        }
      }
      const user = getUser(opts.db, userId);
      const author = user ? gitAuthorFor(user.handle, user.name) : undefined;
      const result = await opts.wikis.commit(repo, p.baseRef, p.changes, p.message, author);
      if (result.ok) {
        // Para distinguir crear vs editar (lo consume el resumen de turno del gateway): un `put`
        // es 'create' si el path NO existía en baseRef, 'edit' si ya estaba. Pedimos el ÁRBOL del
        // baseRef (sólo paths, una API call, sin bajar contenido) y chequeamos pertenencia. Si el
        // árbol no se puede leer (ref inválido), caemos al comportamiento previo ('edit') sin
        // romper el commit. (Sólo lo necesitamos si hay algún `put`.)
        let baseRefPaths: Set<string> | undefined;
        if (p.changes.some((c) => c.op === "put")) {
          try {
            const t = await opts.wikis.tree(repo, p.baseRef);
            baseRefPaths = new Set(t.paths);
          } catch (e) {
            log(
              `sync commit user=${userId} ${repo} no se pudo leer el árbol de ${p.baseRef}: ${e instanceof Error ? e.message : e}`,
            );
          }
        }
        // Change feed: el web server tailea esto y refresca las vistas (writer-agnostic,
        // Fase 3a). Ya no empujamos refresh desde acá — las vistas se suscriben al feed.
        // source 'agent': el commit lo origina el agente (chat o REM, que sincroniza por el mismo
        // endpoint). op por-path: 'delete' → borró; 'put' → 'create' si el path es nuevo en baseRef
        // o 'edit' si ya existía. userId = dueño de la sesión que commiteó → atribución en el reporte.
        recordWikiChange(opts.db, {
          repo,
          ref: result.ref,
          entries: p.changes.map((c) => {
            if (c.op === "delete") return { path: c.path, op: "delete" as const };
            const op = baseRefPaths && !baseRefPaths.has(c.path) ? ("create" as const) : ("edit" as const);
            return { path: c.path, op };
          }),
          source: "agent",
          userId,
        });
        // Tras el push, la copia local del user queda en result.ref → no es deriva propia
        // (evita que el gateway le pida un pull no-op por su propio commit en el turno siguiente).
        setSyncWatermark(opts.db, userId, repo, result.ref);
        // HEAD conocido al día → el watcher no re-reporta este commit como cambio out-of-band.
        setWikiHead(opts.db, repo, result.ref);
        log(`sync commit user=${userId} ${repo} → ${result.ref} (${p.changes.length} changes)`);
      } else {
        log(`sync commit user=${userId} ${repo} CONFLICTO en ${result.conflictPaths.join(", ")}`);
      }
      json(res, 200, result);
      return;
    }

    json(res, 404, { error: "not-found" });
  };
}
