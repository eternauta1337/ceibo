import { describe, expect, it, vi } from "vitest";

// Mock del backend GitHub (@octokit/app): un único `request` ruteado por un handler
// que cada test fija. createWikis instancia `new App(...)` internamente → mockeamos la
// clase entera (evita además validar el PEM). El handler devuelve el `data`; si tira,
// simula un error HTTP (status).
const h = vi.hoisted(() => ({
  handler: (_route: string, _params: Record<string, unknown>): unknown => ({}),
  // Headers que el mock adjunta a la respuesta (para los conditional-requests de headSha).
  headers: {} as Record<string, string>,
  // Handler del endpoint GraphQL (blame). Devuelve el `data` directo (octokit.graphql no
  // envuelve en { data } como request).
  graphqlHandler: (_query: string, _vars: Record<string, unknown>): unknown => ({}),
}));
vi.mock("@octokit/app", () => {
  const request = async (route: string, params: Record<string, unknown>) => ({
    data: h.handler(route, params),
    headers: h.headers,
  });
  const graphql = async (query: string, vars: Record<string, unknown>) => h.graphqlHandler(query, vars);
  return {
    App: class {
      octokit = { request, graphql };
      async getInstallationOctokit() {
        return { request, graphql };
      }
    },
  };
});

const {
  assertValidLabel,
  createWikis,
  gitAuthorFor,
  userRepoName,
  WikiBaseGoneError,
  WikiConflictError,
  WikiExistsError,
} = await import("./index.ts");

const wikis = () => createWikis({ appId: "1", privateKey: "PEM", org: "ceibofamily", installationId: 42 });
const httpErr = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe("gitAuthorFor", () => {
  it("usa el display name si viene, email = handle@users.example.com", () => {
    expect(gitAuthorFor("demo", "Alicia")).toEqual({ name: "Alicia", email: "demo@users.example.com" });
  });
  it("fallback al handle si name es null/undefined", () => {
    expect(gitAuthorFor("demo", null)).toEqual({ name: "demo", email: "demo@users.example.com" });
    expect(gitAuthorFor("demo")).toEqual({ name: "demo", email: "demo@users.example.com" });
  });
});

describe("helpers puros de naming", () => {
  it("assertValidLabel acepta válidos y rechaza inválidos", () => {
    expect(() => assertValidLabel("personal")).not.toThrow();
    expect(() => assertValidLabel("con-guion-9")).not.toThrow();
    expect(() => assertValidLabel("Mayus")).toThrow(/inválido/);
    expect(() => assertValidLabel("-arranca-guion")).toThrow();
    expect(() => assertValidLabel("")).toThrow();
  });
  it("userRepoName = handle-label (valida el label)", () => {
    expect(userRepoName("demo", "notas")).toBe("demo-notas");
    expect(() => userRepoName("demo", "MAL")).toThrow();
  });
});

describe("Wikis sobre Octokit fakeado", () => {
  it("installationId usa el de la config (sin pegarle al App)", async () => {
    expect(await wikis().installationId()).toBe(42);
  });

  it("listRepos mapea a full_name", async () => {
    h.handler = () => ({ repositories: [{ full_name: "o/a" }, { full_name: "o/b" }] });
    expect(await wikis().listRepos()).toEqual(["o/a", "o/b"]);
  });

  it("mintToken devuelve token + expiry", async () => {
    h.handler = () => ({ token: "ghs_x", expires_at: "2030-01-01T00:00:00Z" });
    expect(await wikis().mintToken(["o/a"])).toEqual({ token: "ghs_x", expiresAt: "2030-01-01T00:00:00Z" });
  });

  it("createRepo proyecta full_name/html_url/clone_url y agrega un .gitkeep en root", async () => {
    let gitkeep: { repo?: unknown; path?: unknown; content?: unknown } | undefined;
    h.handler = (route, params) => {
      if (route.includes("/contents/")) {
        gitkeep = { repo: params.repo, path: params.path, content: params.content };
        return { content: { sha: "gk" } };
      }
      return { full_name: "o/r", html_url: "http://h", clone_url: "http://c" }; // POST repos
    };
    expect(await wikis().createRepo("r")).toEqual({
      fullName: "o/r",
      htmlUrl: "http://h",
      cloneUrl: "http://c",
    });
    // El árbol nunca queda vacío: un `.gitkeep` en el root del repo recién creado.
    expect(gitkeep).toEqual({ repo: "r", path: ".gitkeep", content: "" });
  });

  it("createRepo no aborta si el .gitkeep falla (best-effort)", async () => {
    h.handler = (route) => {
      if (route.includes("/contents/")) throw httpErr(500); // GitHub falla al crear el blob
      return { full_name: "o/r", html_url: "http://h", clone_url: "http://c" };
    };
    // La wiki ya existe → createRepo igual resuelve con sus datos.
    expect(await wikis().createRepo("r")).toEqual({
      fullName: "o/r",
      htmlUrl: "http://h",
      cloneUrl: "http://c",
    });
  });

  it("getFile decodifica el contenido base64", async () => {
    h.handler = () => ({ type: "file", content: Buffer.from("hola").toString("base64"), sha: "s1" });
    expect(await wikis().getFile("r", "/nota.md")).toEqual({ content: "hola", sha: "s1", path: "nota.md" });
  });

  it("getFile sobre una carpeta → tira", async () => {
    h.handler = () => [{ name: "a" }]; // array = directorio
    await expect(wikis().getFile("r", "carpeta")).rejects.toThrow(/no es un archivo/);
  });

  it("headSha resuelve branch default → ref → sha", async () => {
    h.headers = {};
    h.handler = (route) => {
      if (route.includes("/git/ref/")) return { object: { sha: "deadbeef" } };
      return { default_branch: "main" }; // GET repo
    };
    expect(await wikis().headSha("r")).toBe("deadbeef");
  });

  it("headSha: cachea el ETag y el 304 devuelve el sha previo sin re-pegar (conditional request)", async () => {
    const w = wikis();
    // 1ra: 200 con ETag → cachea etag+sha+branch.
    h.headers = { etag: 'W/"abc"' };
    h.handler = (route) => {
      if (route.includes("/git/ref/")) return { object: { sha: "sha1" } };
      return { default_branch: "main" };
    };
    expect(await w.headSha("r")).toBe("sha1");

    // 2da: debe mandar If-None-Match con el etag previo; GitHub responde 304 (octokit tira
    // status 304) → devolvemos el sha cacheado. El branch va cacheado: NO se vuelve a pedir el repo.
    let sentIfNoneMatch: string | undefined;
    let askedRepo = false;
    h.handler = (route, params) => {
      if (route.includes("/git/ref/")) {
        sentIfNoneMatch = (params.headers as Record<string, string> | undefined)?.["if-none-match"];
        throw httpErr(304);
      }
      askedRepo = true;
      return { default_branch: "main" };
    };
    expect(await w.headSha("r")).toBe("sha1");
    expect(sentIfNoneMatch).toBe('W/"abc"');
    expect(askedRepo).toBe(false); // branch cacheado → 1 sola request (la condicional, gratis)
    h.headers = {};
  });

  it("listFiles: cachea el árbol por headSha y no re-pega a git/trees si el HEAD no cambió", async () => {
    const w = wikis();
    // 1ra: ref 200 con ETag → resuelve branch + headSha, y baja el árbol (git/trees).
    h.headers = { etag: 'W/"t1"' };
    h.handler = (route) => {
      if (route.includes("/git/ref/")) return { object: { sha: "head1" } };
      if (route.includes("/git/trees/")) {
        return {
          tree: [
            { type: "blob", path: "b.md" },
            { type: "blob", path: "a.md" },
            { type: "tree", path: "dir" }, // las carpetas no entran
          ],
        };
      }
      return { default_branch: "main" }; // GET repo (branch)
    };
    expect(await w.listFiles("r")).toEqual(["a.md", "b.md"]); // ordenado, sólo blobs

    // 2da: ref vuelve 304 (HEAD igual) → NO debe pedir git/trees; devuelve el árbol cacheado.
    let askedTrees = false;
    h.handler = (route, params) => {
      if (route.includes("/git/ref/")) {
        expect((params.headers as Record<string, string> | undefined)?.["if-none-match"]).toBe('W/"t1"');
        throw httpErr(304);
      }
      if (route.includes("/git/trees/")) {
        askedTrees = true;
        return { tree: [] };
      }
      return { default_branch: "main" };
    };
    expect(await w.listFiles("r")).toEqual(["a.md", "b.md"]); // mismo resultado, del cache
    expect(askedTrees).toBe(false); // la clave: cero git/trees cuando el HEAD no cambió
    h.headers = {};
  });

  it("putFile traduce 409 a WikiConflictError", async () => {
    h.handler = () => {
      throw httpErr(409);
    };
    await expect(wikis().putFile("r", "n.md", "x", "base", "msg")).rejects.toBeInstanceOf(WikiConflictError);
  });

  it("putFile pasa author al body cuando se provee", async () => {
    let captured: Record<string, unknown> | undefined;
    h.handler = (_route, params) => {
      captured = params as Record<string, unknown>;
      return { content: { sha: "s1" } };
    };
    const author = { name: "Alicia", email: "demo@users.example.com" };
    await wikis().putFile("r", "n.md", "x", "base", "msg", author);
    expect(captured?.author).toEqual(author);
  });

  it("putFile NO incluye author en el body si no se pasa (retrocompatible)", async () => {
    let captured: Record<string, unknown> | undefined;
    h.handler = (_route, params) => {
      captured = params as Record<string, unknown>;
      return { content: { sha: "s1" } };
    };
    await wikis().putFile("r", "n.md", "x", "base", "msg");
    expect(captured?.author).toBeUndefined();
  });

  it("createFile pasa author al body cuando se provee", async () => {
    let captured: Record<string, unknown> | undefined;
    h.handler = (_route, params) => {
      captured = params as Record<string, unknown>;
      return { content: { sha: "s1" } };
    };
    const author = { name: "Alicia", email: "demo@users.example.com" };
    await wikis().createFile("r", "n.md", "x", "msg", author);
    expect(captured?.author).toEqual(author);
  });

  it("deleteFile pasa author al body cuando se provee", async () => {
    let captured: Record<string, unknown> | undefined;
    h.handler = (_route, params) => {
      captured = params as Record<string, unknown>;
      return {};
    };
    const author = { name: "Alicia", email: "demo@users.example.com" };
    await wikis().deleteFile("r", "n.md", "base", "msg", author);
    expect(captured?.author).toEqual(author);
  });

  it("commit pasa author al POST git/commits cuando se provee", async () => {
    const captured: Array<Record<string, unknown>> = [];
    h.handler = (route, params) => {
      if (route.includes("/git/ref/")) return { object: { sha: "head1" } };
      if (route.includes("/git/commits/")) return { tree: { sha: "t1" } };
      if (route.includes("/git/trees/")) return { tree: [] }; // treeMap para conflicto por-path
      if (route.startsWith("POST") && route.includes("/git/commits")) {
        captured.push(params as Record<string, unknown>);
        return { sha: "newsha" };
      }
      if (route.startsWith("POST") && route.includes("/git/blobs")) return { sha: "blob1" };
      if (route.startsWith("POST") && route.includes("/git/trees")) return { sha: "tree1" };
      if (route.startsWith("PATCH") && route.includes("/git/refs")) return {};
      return { default_branch: "main" };
    };
    const author = { name: "Alicia", email: "demo@users.example.com" };
    await wikis().commit("r", "head1", [{ op: "put", path: "n.md", content: "x" }], "msg", author);
    expect(captured[0]?.author).toEqual(author);
  });

  it("commit NO incluye author si no se pasa (retrocompatible)", async () => {
    const captured: Array<Record<string, unknown>> = [];
    h.handler = (route, params) => {
      if (route.includes("/git/ref/")) return { object: { sha: "head1" } };
      if (route.includes("/git/commits/")) return { tree: { sha: "t1" } };
      if (route.includes("/git/trees/")) return { tree: [] }; // treeMap para conflicto por-path
      if (route.startsWith("POST") && route.includes("/git/commits")) {
        captured.push(params as Record<string, unknown>);
        return { sha: "newsha" };
      }
      if (route.startsWith("POST") && route.includes("/git/blobs")) return { sha: "blob1" };
      if (route.startsWith("POST") && route.includes("/git/trees")) return { sha: "tree1" };
      if (route.startsWith("PATCH") && route.includes("/git/refs")) return {};
      return { default_branch: "main" };
    };
    await wikis().commit("r", "head1", [{ op: "put", path: "n.md", content: "x" }], "msg");
    expect(captured[0]?.author).toBeUndefined();
  });

  it("createFile traduce 422 a WikiExistsError", async () => {
    h.handler = () => {
      throw httpErr(422);
    };
    await expect(wikis().createFile("r", "n.md", "x", "msg")).rejects.toBeInstanceOf(WikiExistsError);
  });

  it("recall recupera la última versión viva de un archivo borrado (del commit padre del borrado)", async () => {
    h.handler = (route, params) => {
      if (route.includes("/contents/")) {
        // ref=parent1 → el contenido histórico; sin ref → alive check, que para un borrado da 404.
        if (params.ref === "parent1") {
          return { type: "file", content: Buffer.from("viejo").toString("base64"), sha: "blob1" };
        }
        throw httpErr(404);
      }
      if (route.includes("/commits")) return [{ parents: [{ sha: "parent1" }] }]; // commit que lo borró
      return {};
    };
    expect(await wikis().recall("r", "/nota.md")).toEqual({
      content: "viejo",
      sha: "blob1",
      path: "nota.md",
    });
  });

  it("recall sobre un path que sigue vivo en HEAD → tira (no está archivado)", async () => {
    h.handler = (route) => {
      if (route.includes("/contents/")) {
        return { type: "file", content: Buffer.from("vivo").toString("base64"), sha: "s" };
      }
      return [];
    };
    await expect(wikis().recall("r", "nota.md")).rejects.toThrow(/no está archivado/);
  });

  // Mock del recorrido de searchArchived: headOf (repo/ref/commit) → tree con manifests →
  // blob de cada manifest (markdown) → por cada nota archivada, deletedContent (commits + contents).
  const searchHandler =
    (manifest: string, noteContent: string) => (route: string, _params: Record<string, unknown>) => {
      if (route.includes("/git/ref/")) return { object: { sha: "head1" } };
      if (route.includes("/git/commits/")) return { tree: { sha: "t1" } }; // headOf
      if (route.includes("/git/trees/")) {
        return {
          tree: [
            { type: "blob", path: "_archivado.md", sha: "mani1" },
            { type: "blob", path: "viva.md", sha: "v1" }, // no es manifest → se ignora
          ],
        };
      }
      if (route.includes("/git/blobs/")) return { content: Buffer.from(manifest).toString("base64") };
      if (route.includes("/commits")) return [{ parents: [{ sha: "parent1" }] }]; // deletedContent
      if (route.includes("/contents/")) {
        return { type: "file", content: Buffer.from(noteContent).toString("base64"), sha: "blob1" };
      }
      return { default_branch: "main" }; // GET repo (headOf)
    };

  it("searchArchived matchea el término en el contenido de una nota archivada", async () => {
    h.handler = searchHandler(
      "- [Compras](compras.md) — 2026-06-01 — lista",
      "# Compras\n\npresupuesto Acme aprobado",
    );
    expect(await wikis().searchArchived("r", "acme")).toEqual({
      matches: [{ path: "compras.md", title: "Compras", line: "presupuesto Acme aprobado" }],
      scanned: 1,
      truncated: false,
    });
  });

  it("searchArchived sin coincidencias devuelve matches vacío (pero igual escaneó)", async () => {
    h.handler = searchHandler("- [Compras](compras.md) — x", "# Compras\n\nnada relevante");
    expect(await wikis().searchArchived("r", "zzz")).toEqual({ matches: [], scanned: 1, truncated: false });
  });

  it("searchArchived con query vacío no pega a la API", async () => {
    h.handler = () => {
      throw new Error("no debería pegar a la API");
    };
    expect(await wikis().searchArchived("r", "   ")).toEqual({ matches: [], scanned: 0, truncated: false });
  });

  // headOf: GET repo (branch) → GET git/ref (sha) → GET git/commits/{sha} (tree). Lo comparten
  // changesSince / diffFiles / revertTo antes de pegar al compare / commits.
  const headOfRoutes = (headSha: string, treeSha = "tHead") => ({
    repo: { default_branch: "main" },
    ref: { object: { sha: headSha } },
    commit: { tree: { sha: treeSha } },
  });

  it("changesSince con baseRef fuera de la historia (compare 404) → WikiBaseGoneError", async () => {
    const r = headOfRoutes("headnew");
    h.handler = (route, params) => {
      if (route.includes("/compare/")) throw httpErr(404); // el sha viejo ya no existe (rewrite)
      if (route.includes("/git/ref/")) return r.ref;
      if (route.includes("/git/commits/")) {
        expect(params.commit_sha).toBe("headnew");
        return r.commit;
      }
      return r.repo;
    };
    await expect(wikis().changesSince("r", "00dcursor")).rejects.toBeInstanceOf(WikiBaseGoneError);
  });

  it("changesSince re-tira los errores que NO son 404 (transitorios) sin tipar", async () => {
    const r = headOfRoutes("headnew");
    h.handler = (route) => {
      if (route.includes("/compare/")) throw httpErr(500);
      if (route.includes("/git/ref/")) return r.ref;
      if (route.includes("/git/commits/")) return r.commit;
      return r.repo;
    };
    const err = await wikis()
      .changesSince("r", "00dcursor")
      .then(() => null)
      .catch((e) => e);
    expect(err).not.toBeNull();
    expect(err).not.toBeInstanceOf(WikiBaseGoneError);
  });

  it("diffFiles separa added/removed/renamed/modified (con blob shas) + commits del rango", async () => {
    h.handler = (route, params) => {
      if (route.includes("/compare/")) {
        expect(params.basehead).toBe("before...after");
        return {
          files: [
            { status: "added", filename: "nueva.md", sha: "blobA" },
            { status: "removed", filename: "borrada.md", sha: "blobB" },
            {
              status: "renamed",
              filename: "nuevo/path.md",
              previous_filename: "viejo/path.md",
              sha: "blobC",
            },
            { status: "modified", filename: "tocada.md", sha: "blobD" },
          ],
          commits: [{ sha: "c1", commit: { message: "rem: consolidación\n\ndetalle" } }],
        };
      }
      return {};
    };
    expect(await wikis().diffFiles("r", "before", "after")).toEqual({
      added: [{ path: "nueva.md", sha: "blobA" }],
      removed: [{ path: "borrada.md", sha: "blobB" }],
      renamed: [{ from: "viejo/path.md", to: "nuevo/path.md" }],
      modified: ["tocada.md"],
      commits: [{ sha: "c1", message: "rem: consolidación\n\ndetalle" }],
    });
  });

  it("revertTo crea un commit con el árbol de toRef sobre HEAD y patchea el ref SIN force", async () => {
    let created: Record<string, unknown> | undefined;
    let patched: Record<string, unknown> | undefined;
    h.handler = (route, params) => {
      if (route.startsWith("POST") && route.includes("/git/commits")) {
        created = params;
        return { sha: "revert333" };
      }
      if (route.startsWith("PATCH") && route.includes("/git/refs/")) {
        patched = params;
        return {};
      }
      if (route.includes("/git/commits/")) {
        // headOf pide el commit de HEAD; revertTo pide el de toRef. Árboles distintos.
        return params.commit_sha === "headX" ? { tree: { sha: "tHead" } } : { tree: { sha: "tOld" } };
      }
      if (route.includes("/git/ref/")) return { object: { sha: "headX" } };
      return { default_branch: "main" };
    };
    expect(await wikis().revertTo("r", "beforeY", "revert(rem): guardrail", "headX")).toEqual({
      ref: "revert333",
    });
    // El commit de revert: árbol del toRef, parent el HEAD actual (historia intacta).
    expect(created).toMatchObject({ tree: "tOld", parents: ["headX"], message: "revert(rem): guardrail" });
    expect(patched).toMatchObject({ ref: "heads/main", sha: "revert333", force: false });
  });

  it("revertTo aborta con WikiConflictError si HEAD ya no es el expectedHead (otro escritor)", async () => {
    h.handler = (route) => {
      if (route.includes("/git/ref/")) return { object: { sha: "headZ" } }; // avanzó
      if (route.includes("/git/commits/")) return { tree: { sha: "t" } };
      return { default_branch: "main" };
    };
    await expect(wikis().revertTo("r", "beforeY", "m", "headX")).rejects.toBeInstanceOf(WikiConflictError);
  });

  // ── moveFile atómico ─────────────────────────────────────────────────────────────────────
  // Flujo del mock: GET /contents/{from} → headOf (repo+ref+commit) → treeMap (git/trees) →
  // POST git/blobs → POST git/trees → POST git/commits → PATCH git/refs.

  /** Handler base de moveFile para el happy-path. Deja `toClean` ausente del árbol HEAD. */
  const moveHandler =
    (opts: { headSha?: string; fromSha?: string; toExists?: boolean } = {}) =>
    (route: string, _params: Record<string, unknown>) => {
      const headSha = opts.headSha ?? "head1";
      const fromSha = opts.fromSha ?? "blob-from";
      // GET /contents/{fromPath}: devuelve el archivo origen con su sha
      if (route.includes("/contents/")) {
        return {
          type: "file",
          content: Buffer.from("contenido original").toString("base64"),
          sha: fromSha,
        };
      }
      // headOf: GET repo → GET git/ref → GET git/commits
      if (route.startsWith("GET") && route.includes("/git/ref/")) return { object: { sha: headSha } };
      if (route.startsWith("GET") && route.includes("/git/commits/")) return { tree: { sha: "tHead" } };
      // treeMap: GET git/trees — el destino puede estar presente o ausente
      if (route.startsWith("GET") && route.includes("/git/trees/")) {
        const tree = [{ type: "blob", path: "nota.md", sha: fromSha }]; // solo el origen existe
        if (opts.toExists) tree.push({ type: "blob", path: "destino.md", sha: "other" });
        return { tree };
      }
      // POST git/blobs: sube el contenido del destino
      if (route.startsWith("POST") && route.includes("/git/blobs")) return { sha: "blob-new" };
      // POST git/trees
      if (route.startsWith("POST") && route.includes("/git/trees")) return { sha: "tree-new" };
      // POST git/commits
      if (route.startsWith("POST") && route.includes("/git/commits")) return { sha: "commit-new" };
      // PATCH git/refs: fast-forward OK
      if (route.startsWith("PATCH") && route.includes("/git/refs/")) return {};
      return { default_branch: "main" };
    };

  it("moveFile: happy path — retorna sha del blob nuevo y el toPath", async () => {
    h.handler = moveHandler();
    const out = await wikis().moveFile("r", "nota.md", "destino.md", "blob-from", "mv");
    expect(out).toEqual({ sha: "blob-new", path: "destino.md" });
  });

  it("moveFile: commit atómico — UN blob + UN tree + UN commit + UN PATCH, sin DELETE separado", async () => {
    const calls: string[] = [];
    const base = moveHandler();
    h.handler = (route, params) => {
      calls.push(route);
      return base(route, params);
    };
    await wikis().moveFile("r", "nota.md", "destino.md", "blob-from", "mv");
    // Exactamente una operación de cada tipo de escritura (no dos commits, no DELETE suelto)
    expect(calls.filter((r) => r.startsWith("POST") && r.includes("/git/blobs"))).toHaveLength(1);
    expect(calls.filter((r) => r.startsWith("POST") && r.includes("/git/trees"))).toHaveLength(1);
    expect(calls.filter((r) => r.startsWith("POST") && r.includes("/git/commits"))).toHaveLength(1);
    expect(calls.filter((r) => r.startsWith("PATCH") && r.includes("/git/refs/"))).toHaveLength(1);
    // Clave del fix: nunca se lanza un DELETE separado (que antes era el segundo request)
    expect(calls.filter((r) => r.startsWith("DELETE"))).toHaveLength(0);
  });

  it("moveFile: el tree nuevo incluye put en toPath Y delete en fromPath en el mismo commit", async () => {
    let treeEntries: unknown[] | undefined;
    const base = moveHandler();
    h.handler = (route, params) => {
      if (route.startsWith("POST") && route.includes("/git/trees")) {
        treeEntries = params.tree as unknown[];
      }
      return base(route, params);
    };
    await wikis().moveFile("r", "nota.md", "destino.md", "blob-from", "mv");
    // El árbol debe tener exactamente dos entradas: add destino + delete origen (sha null)
    expect(treeEntries).toHaveLength(2);
    expect(treeEntries).toContainEqual(expect.objectContaining({ path: "destino.md", sha: "blob-new" }));
    expect(treeEntries).toContainEqual(expect.objectContaining({ path: "nota.md", sha: null }));
  });

  it("moveFile: WikiConflictError si el origen cambió desde baseSha (sha no coincide)", async () => {
    h.handler = (route) => {
      if (route.includes("/contents/")) {
        return { type: "file", content: "", sha: "otro-sha" }; // sha distinto al baseSha
      }
      return { default_branch: "main" };
    };
    await expect(wikis().moveFile("r", "nota.md", "destino.md", "sha-viejo", "mv")).rejects.toBeInstanceOf(
      WikiConflictError,
    );
  });

  it("moveFile: WikiExistsError si el destino ya existe en HEAD", async () => {
    h.handler = moveHandler({ toExists: true });
    await expect(wikis().moveFile("r", "nota.md", "destino.md", "blob-from", "mv")).rejects.toBeInstanceOf(
      WikiExistsError,
    );
  });

  it("moveFile: WikiConflictError si HEAD avanzó entre headOf y PATCH (carrera estrecha)", async () => {
    const base = moveHandler();
    h.handler = (route, params) => {
      if (route.startsWith("PATCH") && route.includes("/git/refs/")) throw httpErr(422);
      return base(route, params);
    };
    await expect(wikis().moveFile("r", "nota.md", "destino.md", "blob-from", "mv")).rejects.toBeInstanceOf(
      WikiConflictError,
    );
  });

  it("moveFile: opts.newContent reemplaza el contenido del destino (rename con H1 nuevo)", async () => {
    let uploadedContent: string | undefined;
    const base = moveHandler();
    h.handler = (route, params) => {
      if (route.startsWith("POST") && route.includes("/git/blobs")) {
        uploadedContent = params.content as string;
        return { sha: "blob-new" };
      }
      return base(route, params);
    };
    await wikis().moveFile("r", "nota.md", "destino.md", "blob-from", "mv", {
      newContent: "# Título nuevo\n\ncuerpo",
    });
    // El contenido subido debe ser el newContent, no el del origen
    expect(Buffer.from(uploadedContent ?? "", "base64").toString("utf8")).toBe("# Título nuevo\n\ncuerpo");
  });

  it("moveFile: pasa author al POST git/commits cuando se provee", async () => {
    let commitParams: Record<string, unknown> | undefined;
    const base = moveHandler();
    h.handler = (route, params) => {
      if (route.startsWith("POST") && route.includes("/git/commits")) {
        commitParams = params as Record<string, unknown>;
      }
      return base(route, params);
    };
    const author = { name: "Alicia", email: "demo@users.example.com" };
    await wikis().moveFile("r", "nota.md", "destino.md", "blob-from", "mv", { author });
    expect(commitParams?.author).toEqual(author);
  });

  // ── searchArchived: guard de "alive" ────────────────────────────────────────────────────

  it("searchArchived omite paths que volvieron a estar vivos en HEAD (recalled/recreados)", async () => {
    // El manifest lista 'compras.md' como archivado, pero 'compras.md' está vivo en HEAD
    // (fue recalled). Sin el guard, deletedContent daría el commit de re-creación y
    // devolvería contenido viejo presentado como "archivado".
    h.handler = (route) => {
      if (route.includes("/git/ref/")) return { object: { sha: "head1" } };
      if (route.includes("/git/commits/")) return { tree: { sha: "t1" } }; // headOf
      if (route.includes("/git/trees/")) {
        return {
          tree: [
            { type: "blob", path: "_archivado.md", sha: "mani1" },
            // compras.md está VIVO en HEAD (fue recalled después de archivar)
            { type: "blob", path: "compras.md", sha: "alive-blob" },
          ],
        };
      }
      if (route.includes("/git/blobs/")) {
        // manifest: lista compras.md como archivada
        return { content: Buffer.from("- [Compras](compras.md) — 2026-06-01").toString("base64") };
      }
      // deletedContent no debería llamarse; si lo hace, devolvería stale content
      if (route.includes("/commits")) return [{ parents: [{ sha: "parent1" }] }];
      if (route.includes("/contents/")) {
        return { type: "file", content: Buffer.from("contenido stale").toString("base64"), sha: "s" };
      }
      return { default_branch: "main" };
    };
    const result = await wikis().searchArchived("r", "compras");
    // Aunque el term "compras" aparece en el path y el manifest, el path está vivo → no debe
    // aparecer en los resultados (sería contenido stale).
    expect(result.matches).toEqual([]);
    // scanned = 0 porque el único path archivado estaba vivo → se filtró antes de deletedContent
    expect(result.scanned).toBe(0);
  });
});

describe("blame (GraphQL)", () => {
  it("proyecta los ranges del query a BlameRange + ref del HEAD", async () => {
    let vars: Record<string, unknown> = {};
    h.graphqlHandler = (query, v) => {
      vars = v;
      expect(query).toContain("blame(path: $path)");
      return {
        repository: {
          defaultBranchRef: {
            target: {
              oid: "headABC",
              blame: {
                ranges: [
                  {
                    startingLine: 1,
                    endingLine: 3,
                    commit: {
                      oid: "c1",
                      committedDate: "2026-06-09T12:00:00Z",
                      author: { name: "Anni", email: "anni@users.example.com" },
                    },
                  },
                  {
                    startingLine: 4,
                    endingLine: 4,
                    commit: {
                      oid: "c2",
                      committedDate: "2026-05-01T00:00:00Z",
                      author: { name: "bot[bot]", email: "1234+bot[bot]@users.noreply.github.com" },
                    },
                  },
                ],
              },
            },
          },
        },
      };
    };
    expect(await wikis().blame("r", "/notas/plan.md")).toEqual({
      ref: "headABC",
      ranges: [
        {
          startLine: 1,
          endLine: 3,
          authorEmail: "anni@users.example.com",
          authorName: "Anni",
          sha: "c1",
          date: "2026-06-09T12:00:00Z",
        },
        {
          startLine: 4,
          endLine: 4,
          authorEmail: "1234+bot[bot]@users.noreply.github.com",
          authorName: "bot[bot]",
          sha: "c2",
          date: "2026-05-01T00:00:00Z",
        },
      ],
    });
    // El path viaja limpio (sin slash inicial).
    expect(vars.path).toBe("notas/plan.md");
  });

  it("author null (commit raro sin autor) → email/name vacíos", async () => {
    h.graphqlHandler = () => ({
      repository: {
        defaultBranchRef: {
          target: {
            oid: "h",
            blame: {
              ranges: [
                { startingLine: 1, endingLine: 1, commit: { oid: "c", committedDate: "d", author: null } },
              ],
            },
          },
        },
      },
    });
    expect((await wikis().blame("r", "a.md")).ranges).toEqual([
      { startLine: 1, endLine: 1, authorEmail: "", authorName: "", sha: "c", date: "d" },
    ]);
  });

  it("repo sin branch default → tira", async () => {
    h.graphqlHandler = () => ({ repository: { defaultBranchRef: null } });
    await expect(wikis().blame("r", "a.md")).rejects.toThrow(/sin branch default/);
  });
});
