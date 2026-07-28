// MCP `notes` — búsqueda y lectura de notas sobre el ÍNDICE DERIVADO en la DB (feature db,
// F2). Reemplaza el grep de la working copy para lookups: búsqueda híbrida (FTS5 léxica +
// vectores del bi-encoder en gpuhost) que encuentra por SIGNIFICADO, cruza todas las wikis
// del usuario, y no depende de que la VM tenga el clon fresco.
//
// Mismo patrón que `control` (in-process, transport de @ceibo/mcps, listener propio en
// index.ts): path-secret en la URL (`/mcp/notes/<NOTES_MCP_SECRET>`) gatea el acceso; el
// Bearer firmado (`signUserToken` con NOTES_MCP_HMAC_KEY) identifica al usuario en cada
// tool-call → el scope de wikis sale de `listReposForUser`, nunca de un parámetro.
//
// Nombres: opencode expone las tools como `<server>_<tool>` → server `notes` + tools
// `search`/`read`/`list` = `notes_search`/`notes_read`/`notes_list` (cubiertas por el
// allow `"notes*"` en opencode-delegv2.json).
//
// Degradación (nunca bloqueo): sin embedder o con gpuhost caído, `search` responde igual
// con la léxica y lo dice en `degraded`. El índice corre unos segundos detrás de git
// (reconciliador del web-server) — para lookups es irrelevante; la edición sigue siendo
// sobre la working copy.

import type { McpServer, Tool, ToolArgs } from "@ceibo/mcps/src/core/transport.ts";
import {
  batchNotes,
  createNote,
  type Db,
  deleteNote,
  type Embedder,
  findIndexedPaths,
  getIndexedNote,
  indexedNoteRefs,
  listReposForUser,
  moveNote,
  type NoteBatchChange,
  NoteConflictError,
  NoteExistsError,
  searchNotesHybrid,
  searchNotesLexical,
  searchNotesSemantic,
  verifyUserToken,
  writeNote,
} from "@ceibo/store";

const TOOLS: Tool[] = [
  {
    name: "search",
    description:
      "Buscá en TODAS las notas del usuario (todas sus wikis) por significado y por texto. " +
      "Es tu PRIMERA herramienta para encontrar/recordar algo de las notas: entiende " +
      'sinónimos y paráfrasis ("comida con la familia" encuentra la nota del asado), no ' +
      "sólo palabras exactas. Devuelve las notas más relevantes con path, título y un " +
      "fragmento. Con el path del resultado, leé la nota completa con `read`. " +
      "`mode`: dejalo en `hybrid` (default); `lexical` sólo si buscás un literal exacto " +
      "(un número, un nombre raro); `semantic` sólo conceptual.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Qué buscás, en lenguaje natural o palabras clave." },
        mode: { type: "string", enum: ["hybrid", "lexical", "semantic"], description: "Default: hybrid." },
        wiki: { type: "string", description: "Limitar a UNA wiki (default: todas las del usuario)." },
        limit: { type: "number", description: "Máximo de resultados (default 8)." },
      },
      required: ["query"],
    },
  },
  {
    name: "read",
    description:
      "Leé una nota completa por su path (como lo devuelve `search` o `list`). Si el path " +
      "no existe, devuelve sugerencias con nombres parecidos.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path de la nota, ej. `dir/nota.md`." },
        wiki: { type: "string", description: "La wiki de la nota (si se omite, se busca en todas)." },
      },
      required: ["path"],
    },
  },
  {
    name: "list",
    description:
      "Listá los paths de todas las notas (de una wiki o de todas). Para ubicarte, no para buscar contenido.",
    inputSchema: {
      type: "object",
      properties: {
        wiki: { type: "string", description: "Limitar a UNA wiki (default: todas)." },
      },
    },
  },
];

// Tools de ESCRITURA (feature db F3c): sólo se montan con writeMode="db" (la DB como
// fuente de verdad). El conflicto vuelve como DATO ({conflict, current_*}) y no como
// error: un modelo chico lo maneja mejor y puede mergear/reintentar.
const WRITE_TOOLS: Tool[] = [
  {
    name: "write",
    description:
      "Guardá el contenido COMPLETO de una nota existente. `expected_version` es la versión " +
      "que leíste (viene en `read`); si alguien la cambió en el medio, devuelve " +
      "`{conflict, current_version, current_content}` — integrá tu cambio sobre ese contenido " +
      "y reintentá con la versión nueva. NUNCA pises sin mirar el conflicto.",
    inputSchema: {
      type: "object",
      properties: {
        wiki: { type: "string" },
        path: { type: "string" },
        content: { type: "string", description: "El contenido COMPLETO resultante de la nota." },
        expected_version: { type: "number", description: "La versión que leíste." },
      },
      required: ["wiki", "path", "content", "expected_version"],
    },
  },
  {
    name: "create",
    description: "Creá una nota nueva. Si el path ya existe devuelve `{exists: true}` (elegí otro nombre).",
    inputSchema: {
      type: "object",
      properties: {
        wiki: { type: "string" },
        path: { type: "string", description: "Path nuevo, ej. `dir/nota.md`." },
        content: { type: "string" },
      },
      required: ["wiki", "path"],
    },
  },
  {
    name: "delete",
    description: "Borrá una nota (recuperable: la historia queda). Requiere `expected_version` como `write`.",
    inputSchema: {
      type: "object",
      properties: {
        wiki: { type: "string" },
        path: { type: "string" },
        expected_version: { type: "number" },
      },
      required: ["wiki", "path", "expected_version"],
    },
  },
  {
    name: "move",
    description:
      "Mové/renombrá una nota (la historia la sigue). `to_wiki` opcional para cruzar de wiki. " +
      "Requiere `expected_version` como `write`.",
    inputSchema: {
      type: "object",
      properties: {
        wiki: { type: "string" },
        path: { type: "string" },
        to_path: { type: "string" },
        to_wiki: { type: "string" },
        expected_version: { type: "number" },
      },
      required: ["wiki", "path", "to_path", "expected_version"],
    },
  },
  {
    name: "batch",
    description:
      "Aplicá VARIOS cambios a UNA wiki en una sola operación atómica (o entra todo o nada). " +
      "Para cambios masivos: renombres, reformateos, mover en volumen. `changes` = lista de " +
      '{op:"put"|"delete"|"move", path, content?, to_path?, expected_version?} — `put` sin ' +
      "expected_version crea. Si hay conflictos devuelve `{conflict_paths}` (re-leé esos y reintentá).",
    inputSchema: {
      type: "object",
      properties: {
        wiki: { type: "string" },
        changes: { type: "array", items: { type: "object" } },
      },
      required: ["wiki", "changes"],
    },
  },
];

const asStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export interface NotesServerOpts {
  /** "db" monta también las tools de escritura (F3c). Default "git" = sólo lectura/búsqueda. */
  writeMode?: "git" | "db";
}

export function makeNotesServer(
  hmacKey: string,
  db: Db,
  embedder: Embedder | null,
  serverOpts: NotesServerOpts = {},
): McpServer {
  /** Wikis del usuario, opcionalmente acotadas por el parámetro `wiki` (validado contra
   *  su scope: una wiki ajena o inexistente es indistinguible — "no tenés esa wiki"). */
  function reposFor(userId: number, wiki: string): string[] {
    const all = listReposForUser(db, userId).map((r) => r.name);
    if (!wiki) return all;
    if (!all.includes(wiki))
      throw new Error(`no tenés una wiki "${wiki}" (tenés: ${all.join(", ") || "ninguna"})`);
    return [wiki];
  }

  async function callTool(token: string, name: string, args: ToolArgs): Promise<unknown> {
    const userId = verifyUserToken(token, hmacKey);
    if (userId === undefined) throw new Error("token de notes inválido");

    if (name === "search") {
      const query = asStr(args.query);
      if (!query) throw new Error("falta `query`");
      const repos = reposFor(userId, asStr(args.wiki));
      const mode = asStr(args.mode) || "hybrid";
      const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 25);

      let degraded: string | undefined;
      let queryVec: Float32Array | null = null;
      if (mode !== "lexical") {
        if (!embedder) {
          degraded = "búsqueda semántica no configurada: resultados sólo léxicos";
        } else {
          try {
            queryVec = (await embedder.embed([query], "query"))[0] ?? null;
          } catch {
            degraded = "búsqueda semántica no disponible ahora: resultados sólo léxicos";
          }
        }
      }

      const hits =
        mode === "semantic" && queryVec
          ? searchNotesSemantic(db, repos, queryVec, limit)
          : mode === "lexical" || !queryVec
            ? searchNotesLexical(db, repos, query, limit)
            : searchNotesHybrid(db, repos, query, queryVec, limit);

      return {
        results: hits.map((h) => ({ wiki: h.repo, path: h.path, title: h.title, snippet: h.snippet })),
        ...(degraded ? { degraded } : {}),
        ...(hits.length === 0
          ? { hint: "sin resultados: probá otras palabras o `list` para ver qué hay" }
          : {}),
      };
    }

    if (name === "read") {
      const path = asStr(args.path);
      if (!path) throw new Error("falta `path`");
      const repos = reposFor(userId, asStr(args.wiki));
      for (const repo of repos) {
        const note = getIndexedNote(db, repo, path);
        if (note) return { wiki: note.repo, path: note.path, title: note.title, content: note.content };
      }
      const base = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
      const similar = findIndexedPaths(db, repos, base);
      throw new Error(
        `no existe "${path}"${similar.length ? ` — ¿quisiste decir? ${similar.map((s) => `${s.repo}/${s.path}`).join(" · ")}` : ""}`,
      );
    }

    if (name === "list") {
      const repos = reposFor(userId, asStr(args.wiki));
      const wikis = repos.map((repo) => ({
        wiki: repo,
        paths: indexedNoteRefs(db, repo).map((r) => r.path),
      }));
      return { wikis };
    }

    if (serverOpts.writeMode === "db") {
      const meta = { authorUid: userId, source: "agent" as const };
      // El parámetro `wiki` es OBLIGATORIO en writes (nada de defaults implícitos con
      // efectos); reposFor valida que sea del usuario.
      const requireWiki = (): string => {
        const wiki = asStr(args.wiki);
        if (!wiki) throw new Error("falta `wiki`");
        reposFor(userId, wiki);
        return wiki;
      };
      const conflictAsData = (e: unknown): unknown => {
        if (e instanceof NoteConflictError) {
          return { conflict: true, current_version: e.currentVersion, current_content: e.currentContent };
        }
        if (e instanceof NoteExistsError) return { exists: true };
        throw e;
      };

      if (name === "write") {
        const wiki = requireWiki();
        const path = asStr(args.path);
        if (!path || typeof args.content !== "string") throw new Error("faltan `path`/`content`");
        try {
          return writeNote(db, wiki, path, args.content, Number(args.expected_version), meta);
        } catch (e) {
          return conflictAsData(e);
        }
      }
      if (name === "create") {
        const wiki = requireWiki();
        const path = asStr(args.path);
        if (!path) throw new Error("falta `path`");
        try {
          return createNote(db, wiki, path, typeof args.content === "string" ? args.content : "", meta);
        } catch (e) {
          return conflictAsData(e);
        }
      }
      if (name === "delete") {
        const wiki = requireWiki();
        const path = asStr(args.path);
        if (!path) throw new Error("falta `path`");
        try {
          deleteNote(db, wiki, path, Number(args.expected_version), meta);
          return { deleted: true };
        } catch (e) {
          return conflictAsData(e);
        }
      }
      if (name === "move") {
        const wiki = requireWiki();
        const path = asStr(args.path);
        const toPath = asStr(args.to_path);
        const toWiki = asStr(args.to_wiki) || wiki;
        if (!path || !toPath) throw new Error("faltan `path`/`to_path`");
        reposFor(userId, toWiki); // el destino también tiene que ser del usuario
        try {
          return moveNote(
            db,
            { repo: wiki, path },
            { repo: toWiki, path: toPath },
            Number(args.expected_version),
            meta,
          );
        } catch (e) {
          return conflictAsData(e);
        }
      }
      if (name === "batch") {
        const wiki = requireWiki();
        if (!Array.isArray(args.changes)) throw new Error("falta `changes`");
        const changes = (args.changes as Record<string, unknown>[]).map((c): NoteBatchChange => {
          const op = asStr(c.op);
          const path = asStr(c.path);
          if (!path) throw new Error("cada change necesita `path`");
          if (op === "put") {
            return {
              op: "put",
              path,
              content: typeof c.content === "string" ? c.content : "",
              ...(c.expected_version !== undefined ? { expectedVersion: Number(c.expected_version) } : {}),
            };
          }
          if (op === "delete") return { op: "delete", path, expectedVersion: Number(c.expected_version) };
          if (op === "move") {
            return {
              op: "move",
              path,
              toPath: asStr(c.to_path),
              expectedVersion: Number(c.expected_version),
            };
          }
          throw new Error(`op desconocida: ${op}`);
        });
        const result = batchNotes(db, wiki, changes, meta);
        return result.ok ? { ok: true } : { conflict_paths: result.conflictPaths };
      }
    }

    throw new Error(`tool desconocida: ${name}`);
  }

  const tools = serverOpts.writeMode === "db" ? [...TOOLS, ...WRITE_TOOLS] : TOOLS;
  return { name: "notes", tools, callTool };
}
