import { afterEach, describe, expect, it, vi } from "vitest";
import { notion_server } from "./notion.ts";

afterEach(() => vi.unstubAllGlobals());

// notion() lee text()+JSON.parse y exige header notion-version. Router por URL+init.
function route(handler: (url: string, init: RequestInit, n: number) => unknown) {
  const calls: {
    url: string;
    init: RequestInit;
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url, init, body, headers });
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify(handler(url, init, calls.length)),
      } as Response;
    }),
  );
  return calls;
}

/** Ruta con soporte para statusCode y headers custom por llamada. */
function routeWithStatus(
  handler: (
    url: string,
    init: RequestInit,
    n: number,
  ) => { status: number; body: unknown; headers?: Record<string, string> },
) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const reqBody = typeof init.body === "string" ? JSON.parse(init.body) : {};
      calls.push({ url, init, body: reqBody });
      const { status, body, headers = {} } = handler(url, init, calls.length);
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(headers),
        text: async () => JSON.stringify(body),
      } as Response;
    }),
  );
  return calls;
}

const titleProp = (t: string) => ({ Name: { type: "title", title: [{ plain_text: t }] } });
const rt = (t: string) => ({ rich_text: [{ plain_text: t }] });

describe("notion.callTool search", () => {
  it("manda Notion-Version, filtra page por default y proyecta id/title/url/parent", async () => {
    const calls = route(() => ({
      results: [
        {
          id: "p1",
          url: "http://n/p1",
          object: "page",
          last_edited_time: "2026-06-01T00:00:00Z",
          parent: { type: "page_id", page_id: "papa" },
          properties: titleProp("Hola"),
        },
      ],
    }));
    const out = (await notion_server.callTool("tok", "search", { query: "x" })) as {
      count: number;
      pages: Record<string, unknown>[];
    };
    expect(out.count).toBe(1);
    expect(out.pages[0]).toEqual({
      id: "p1",
      title: "Hola",
      url: "http://n/p1",
      kind: "page",
      parent: { type: "page", id: "papa" },
      last_edited: "2026-06-01T00:00:00Z",
    });
    expect((calls[0]?.init.headers as Record<string, string>)["notion-version"]).toBe("2022-06-28");
    expect(calls[0]?.body.filter).toEqual({ value: "page", property: "object" });
    expect(calls[0]?.body.query).toBe("x");
  });

  it("pagina con next_cursor y re-rankea: el match exacto de título queda primero", async () => {
    const page = (id: string, title: string) => ({ id, url: `http://n/${id}`, properties: titleProp(title) });
    const calls = route((_url, _init, n) =>
      n === 1
        ? {
            results: [page("a", "Notas varias"), page("b", "Documentos de viaje")],
            has_more: true,
            next_cursor: "c1",
          }
        : { results: [page("c", "Documentos")], has_more: false },
    );
    const out = (await notion_server.callTool("tok", "search", { query: "Documentos", maxResults: 3 })) as {
      pages: { id: string }[];
    };
    // 2 requests (siguió el cursor) y el segundo arrastra el start_cursor
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.start_cursor).toBe("c1");
    // exacto ("Documentos") > prefijo ("Documentos de viaje") > sin match
    expect(out.pages.map((p) => p.id)).toEqual(["c", "b", "a"]);
  });

  it("sin query: ordena por last_edited_time desc en la API y no sobre-pagina", async () => {
    const calls = route(() => ({ results: [], has_more: false }));
    await notion_server.callTool("tok", "search", { maxResults: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.sort).toEqual({ direction: "descending", timestamp: "last_edited_time" });
    expect(calls[0]?.body.page_size).toBe(5);
    expect(calls[0]?.body.query).toBeUndefined();
  });

  it("kind=all no filtra; kind=database filtra databases y lee el título top-level", async () => {
    const calls = route(() => ({
      results: [{ id: "d1", object: "database", title: [{ plain_text: "Mi DB" }] }],
    }));
    await notion_server.callTool("tok", "search", { query: "q", kind: "all" });
    expect(calls[0]?.body.filter).toBeUndefined();
    const out = (await notion_server.callTool("tok", "search", { query: "q", kind: "database" })) as {
      pages: { title: string }[];
    };
    expect(calls[1]?.body.filter).toEqual({ value: "database", property: "object" });
    expect(out.pages[0]?.title).toBe("Mi DB");
  });

  it("sin resultados: avisa que la integración solo ve lo compartido", async () => {
    route(() => ({ results: [], has_more: false }));
    const out = (await notion_server.callTool("tok", "search", { query: "inexistente" })) as {
      count: number;
      note?: string;
    };
    expect(out.count).toBe(0);
    expect(out.note).toMatch(/compartid/);
  });

  it("marca páginas archivadas/en_trash con archived:true en el resultado", async () => {
    route(() => ({
      results: [
        {
          id: "pa",
          url: "http://n/pa",
          object: "page",
          archived: true,
          properties: titleProp("Vieja"),
        },
        {
          id: "pb",
          url: "http://n/pb",
          object: "page",
          in_trash: true,
          properties: titleProp("Basura"),
        },
        {
          id: "pc",
          url: "http://n/pc",
          object: "page",
          properties: titleProp("Normal"),
        },
      ],
    }));
    const out = (await notion_server.callTool("tok", "search", { query: "x" })) as {
      pages: Record<string, unknown>[];
    };
    expect(out.pages[0]?.archived).toBe(true);
    expect(out.pages[1]?.archived).toBe(true);
    expect(out.pages[2]?.archived).toBeUndefined();
  });
});

describe("notion.callTool get_page", () => {
  it("pagina los children con next_cursor hasta traer todos", async () => {
    route((url, _init, _n) => {
      if (!url.includes("/children")) return { id: "p1", url: "http://n/p1", properties: titleProp("Pág") };
      return url.includes("start_cursor=c2")
        ? { results: [{ type: "paragraph", paragraph: rt("segunda tanda") }], has_more: false }
        : {
            results: [{ type: "paragraph", paragraph: rt("primera tanda") }],
            has_more: true,
            next_cursor: "c2",
          };
    });
    const out = (await notion_server.callTool("tok", "get_page", { pageId: "p1" })) as {
      content: string;
      truncated: boolean;
    };
    expect(out.content).toBe("primera tanda\nsegunda tanda");
    expect(out.truncated).toBe(false);
  });

  it("recursa en has_children con indentación (toggle) y numera listas", async () => {
    route((url) => {
      if (!url.includes("/children")) return { id: "p1", properties: titleProp("Pág") };
      if (url.includes("/blocks/t1/")) return { results: [{ type: "paragraph", paragraph: rt("oculto") }] };
      return {
        results: [
          { id: "t1", type: "toggle", toggle: rt("Detalles"), has_children: true },
          { type: "numbered_list_item", numbered_list_item: rt("uno") },
          { type: "numbered_list_item", numbered_list_item: rt("dos") },
        ],
      };
    });
    const out = (await notion_server.callTool("tok", "get_page", { pageId: "p1" })) as { content: string };
    expect(out.content).toBe("▸ Detalles\n  oculto\n1. uno\n2. dos");
  });

  it("rinde los tipos de bloque a markdown (todo/code/quote/callout/divider/tabla/subpágina/media)", async () => {
    route((url) => {
      if (!url.includes("/children")) return { id: "p1", properties: titleProp("Pág") };
      if (url.includes("/blocks/tb/"))
        return {
          results: [
            { type: "table_row", table_row: { cells: [[{ plain_text: "a" }], [{ plain_text: "b" }]] } },
          ],
        };
      return {
        results: [
          { type: "heading_2", heading_2: rt("Sección") },
          { type: "to_do", to_do: { ...rt("hecho"), checked: true } },
          { type: "to_do", to_do: { ...rt("pendiente"), checked: false } },
          { type: "code", code: { ...rt("let x = 1;"), language: "javascript" } },
          { type: "quote", quote: rt("cita") },
          { type: "callout", callout: { ...rt("ojo"), icon: { type: "emoji", emoji: "💡" } } },
          { type: "divider", divider: {} },
          { id: "tb", type: "table", table: {}, has_children: true },
          { id: "sub1", type: "child_page", child_page: { title: "Anexo" }, has_children: true },
          {
            type: "image",
            image: { external: { url: "http://img/1.png" }, caption: [{ plain_text: "foto" }] },
          },
        ],
      };
    });
    const out = (await notion_server.callTool("tok", "get_page", { pageId: "p1" })) as { content: string };
    expect(out.content).toBe(
      [
        "## Sección",
        "[x] hecho",
        "[ ] pendiente",
        "```javascript",
        "let x = 1;",
        "```",
        "> cita",
        "> 💡 ojo",
        "---",
        "| a | b |",
        "→ subpágina: Anexo (id: sub1)",
        "[image: foto] http://img/1.png",
      ].join("\n"),
    );
  });

  it("corta la recursión al tope de profundidad y lo avisa", async () => {
    // Cadena infinita de toggles anidados: n0 → n1 → n2 → ...
    route((url) => {
      if (!url.includes("/children")) return { id: "p1", properties: titleProp("Pág") };
      const m = url.match(/\/blocks\/n(\d+)\//);
      const depth = m ? Number(m[1]) + 1 : 0;
      return {
        results: [{ id: `n${depth}`, type: "toggle", toggle: rt(`nivel ${depth}`), has_children: true }],
      };
    });
    const out = (await notion_server.callTool("tok", "get_page", { pageId: "p1" })) as {
      content: string;
      truncated: boolean;
    };
    expect(out.truncated).toBe(true);
    expect(out.content).toContain("nivel 0");
    expect(out.content).toContain("contenido truncado");
  });

  it("corta al presupuesto total de bloques y lo avisa", async () => {
    const batch = Array.from({ length: 100 }, (_, i) => ({ type: "paragraph", paragraph: rt(`p${i}`) }));
    const calls = route((url) =>
      url.includes("/children")
        ? { results: batch, has_more: true, next_cursor: "more" }
        : { id: "p1", properties: titleProp("Pág") },
    );
    const out = (await notion_server.callTool("tok", "get_page", { pageId: "p1" })) as {
      content: string;
      truncated: boolean;
    };
    expect(out.truncated).toBe(true);
    expect(out.content.split("\n").filter((l) => l.startsWith("p"))).toHaveLength(1000);
    // 1 fetch de página + 10 batches de 100 (el presupuesto frena la paginación)
    expect(calls).toHaveLength(11);
  });

  it("acepta una URL de Notion como pageId y extrae el id", async () => {
    const calls = route((url) =>
      url.includes("/children") ? { results: [] } : { id: "x", properties: titleProp("Pág") },
    );
    await notion_server.callTool("tok", "get_page", {
      pageId: "https://www.notion.so/Documentos-0123456789abcdef0123456789abcdef?pvs=4",
    });
    expect(calls[0]?.url).toContain("/pages/0123456789abcdef0123456789abcdef");
    expect(calls[1]?.url).toContain("/blocks/0123456789abcdef0123456789abcdef/children");
  });

  it("expone properties de páginas de database (Status, Fecha, Número, etc.)", async () => {
    route((url) => {
      if (url.includes("/children")) return { results: [] };
      return {
        id: "db1",
        url: "http://n/db1",
        parent: { type: "database_id", database_id: "thedb" },
        properties: {
          Name: { type: "title", title: [{ plain_text: "Tarea A" }] },
          Status: { type: "status", status: { name: "En progreso" } },
          Fecha: { type: "date", date: { start: "2026-06-11" } },
          Prioridad: { type: "select", select: { name: "Alta" } },
          Hecho: { type: "checkbox", checkbox: true },
          Puntos: { type: "number", number: 5 },
          Tags: { type: "multi_select", multi_select: [{ name: "backend" }, { name: "infra" }] },
        },
      };
    });
    const out = (await notion_server.callTool("tok", "get_page", { pageId: "db1" })) as {
      title: string;
      properties?: string[];
    };
    expect(out.title).toBe("Tarea A");
    expect(out.properties).toBeDefined();
    expect(out.properties).toContain("Status: En progreso");
    expect(out.properties).toContain("Fecha: 2026-06-11");
    expect(out.properties).toContain("Prioridad: Alta");
    expect(out.properties).toContain("Hecho: sí");
    expect(out.properties).toContain("Puntos: 5");
    expect(out.properties).toContain("Tags: backend, infra");
    // El título no se duplica en properties
    const hasTitleDuplicate = (out.properties ?? []).some((p) => p.startsWith("Name:"));
    expect(hasTitleDuplicate).toBe(false);
  });

  it("sin properties de database (página simple) → no incluye campo properties", async () => {
    route((url) => {
      if (url.includes("/children")) return { results: [{ type: "paragraph", paragraph: rt("hola") }] };
      return { id: "simple", properties: titleProp("Página simple") };
    });
    const out = (await notion_server.callTool("tok", "get_page", { pageId: "simple" })) as {
      properties?: string[];
    };
    expect(out.properties).toBeUndefined();
  });

  it("marca como archived:true si la página está archivada o en_trash", async () => {
    route((url) => {
      if (url.includes("/children")) return { results: [] };
      return { id: "arch", archived: true, properties: titleProp("Archivada") };
    });
    const out = (await notion_server.callTool("tok", "get_page", { pageId: "arch" })) as {
      archived?: boolean;
    };
    expect(out.archived).toBe(true);
  });

  it("synced_block duplicado: recursa sobre synced_from.block_id en vez del propio id", async () => {
    // p1 tiene un synced_block duplicado que apunta a 'orig'; 'orig' tiene el contenido real.
    route((url) => {
      if (!url.includes("/children")) return { id: "p1", properties: titleProp("Pág") };
      if (url.includes("/blocks/orig/"))
        return { results: [{ type: "paragraph", paragraph: rt("contenido sincronizado") }] };
      // Bloque synced duplicado: synced_from apunta a 'orig'
      return {
        results: [
          {
            id: "sync1",
            type: "synced_block",
            synced_block: { synced_from: { block_id: "orig" } },
            has_children: true,
          },
        ],
      };
    });
    const out = (await notion_server.callTool("tok", "get_page", { pageId: "p1" })) as { content: string };
    expect(out.content).toContain("contenido sincronizado");
  });

  it("synced_block original (synced_from=null): recursa sobre su propio id", async () => {
    route((url) => {
      if (!url.includes("/children")) return { id: "p1", properties: titleProp("Pág") };
      if (url.includes("/blocks/sb1/"))
        return { results: [{ type: "paragraph", paragraph: rt("contenido original") }] };
      return {
        results: [
          {
            id: "sb1",
            type: "synced_block",
            synced_block: { synced_from: null },
            has_children: true,
          },
        ],
      };
    });
    const out = (await notion_server.callTool("tok", "get_page", { pageId: "p1" })) as { content: string };
    expect(out.content).toContain("contenido original");
  });

  it("rich_text con href renderiza como link markdown", async () => {
    route((url) => {
      if (!url.includes("/children")) return { id: "p1", properties: titleProp("Pág") };
      return {
        results: [
          {
            type: "paragraph",
            paragraph: {
              rich_text: [
                { plain_text: "ver acá", href: "https://example.com" },
                { plain_text: " y esto sin link" },
              ],
            },
          },
        ],
      };
    });
    const out = (await notion_server.callTool("tok", "get_page", { pageId: "p1" })) as { content: string };
    expect(out.content).toContain("[ver acá](https://example.com)");
    expect(out.content).toContain("y esto sin link");
  });
});

describe("notion.callTool get_page — 404 con hint de integración", () => {
  it("404 en get_page incluye hint sobre compartir con la integración", async () => {
    routeWithStatus(() => ({
      status: 404,
      body: { message: "Could not find page", code: "object_not_found" },
    }));
    await expect(
      notion_server.callTool("tok", "get_page", { pageId: "aabbccdd00112233aabbccdd00112233" }),
    ).rejects.toThrow(/integración/);
  });
});

describe("notion.callTool get_page — normalizePageId", () => {
  it("pageId con nombre de página (espacios) lanza error claro", async () => {
    route(() => ({}));
    await expect(notion_server.callTool("tok", "get_page", { pageId: "Mi página de notas" })).rejects.toThrow(
      /parece un nombre de página/,
    );
  });

  it("pageId con texto no-hex sin espacios también lanza error claro", async () => {
    route(() => ({}));
    await expect(
      notion_server.callTool("tok", "get_page", { pageId: "mis-notas-importantes" }),
    ).rejects.toThrow(/parece un nombre de página/);
  });
});

describe("notion.callTool resto", () => {
  it("create_page: parte el content en párrafos y devuelve id/url", async () => {
    const calls = route(() => ({ id: "new", url: "http://n/new" }));
    const out = (await notion_server.callTool("tok", "create_page", {
      parentPageId: "aabbccdd11223344aabbccdd11223344",
      title: "T",
      content: "linea1\n\nlinea2",
    })) as { id: string };
    expect(out.id).toBe("new");
    const body = calls[0]?.body as { children: unknown[]; parent: unknown };
    expect(body.children).toHaveLength(2); // las líneas vacías se filtran
    expect(body.parent).toEqual({ page_id: "aabbccdd11223344aabbccdd11223344" });
  });

  it("create_page con >100 bloques: crea con primeros 100 y appendea el resto", async () => {
    const calls = route(() => ({ id: "bigpage", url: "http://n/bigpage" }));
    // 150 líneas → 100 en el create + 50 en un PATCH
    const content = Array.from({ length: 150 }, (_, i) => `linea ${i}`).join("\n");
    const out = (await notion_server.callTool("tok", "create_page", {
      parentPageId: "aabbccdd11223344aabbccdd11223344",
      title: "Grande",
      content,
    })) as { id: string };
    expect(out.id).toBe("bigpage");
    // 1 POST (crear) + 1 PATCH (appendear 50 restantes)
    expect(calls).toHaveLength(2);
    const postBody = calls[0]?.body as { children: unknown[] };
    expect(postBody.children).toHaveLength(100);
    const patchBody = calls[1]?.body as { children: unknown[] };
    expect(patchBody.children).toHaveLength(50);
    // El PATCH va al endpoint correcto
    expect(calls[1]?.url).toContain("/blocks/bigpage/children");
    expect(calls[1]?.init.method).toBe("PATCH");
  });

  it("create_page con >200 bloques: appendea en múltiples tandas de 100", async () => {
    const calls = route(() => ({ id: "hugepage", url: "http://n/hugepage" }));
    // 250 líneas → 100 en POST + 100 en PATCH1 + 50 en PATCH2
    const content = Array.from({ length: 250 }, (_, i) => `linea ${i}`).join("\n");
    await notion_server.callTool("tok", "create_page", {
      parentPageId: "aabbccdd11223344aabbccdd11223344",
      title: "Enorme",
      content,
    });
    expect(calls).toHaveLength(3);
    expect((calls[0]?.body as { children: unknown[] }).children).toHaveLength(100);
    expect((calls[1]?.body as { children: unknown[] }).children).toHaveLength(100);
    expect((calls[2]?.body as { children: unknown[] }).children).toHaveLength(50);
  });

  it("create_page con línea >2000 chars: la parte en múltiples bloques", async () => {
    const calls = route(() => ({ id: "longline", url: "http://n/longline" }));
    // Una línea de 4500 chars → 3 bloques (2000+2000+500)
    const longLine = "x".repeat(4500);
    await notion_server.callTool("tok", "create_page", {
      parentPageId: "aabbccdd11223344aabbccdd11223344",
      title: "Largo",
      content: longLine,
    });
    const body = calls[0]?.body as {
      children: { paragraph: { rich_text: { text: { content: string } }[] } }[];
    };
    expect(body.children).toHaveLength(3);
    expect(body.children[0]?.paragraph.rich_text[0]?.text.content).toHaveLength(2000);
    expect(body.children[1]?.paragraph.rich_text[0]?.text.content).toHaveLength(2000);
    expect(body.children[2]?.paragraph.rich_text[0]?.text.content).toHaveLength(500);
  });

  it("tool desconocida → tira", async () => {
    route(() => ({}));
    await expect(notion_server.callTool("tok", "nope", {})).rejects.toThrow(/desconocida/);
  });
});

describe("notion helper — retry 429", () => {
  it("reintenta en 429 respetando Retry-After y eventualmente devuelve la respuesta", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init: RequestInit = {}) => {
        callCount++;
        if (callCount <= 2) {
          // Primeros 2 intentos: rate limit
          return {
            ok: false,
            status: 429,
            headers: new Headers({ "retry-after": "0" }), // 0 para no dormir en tests
            text: async () => JSON.stringify({ message: "rate limited" }),
          } as Response;
        }
        // Tercer intento: éxito
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () =>
            JSON.stringify({
              id: "p1",
              properties: { Name: { type: "title", title: [{ plain_text: "OK" }] } },
            }),
        } as Response;
      }),
    );
    // Necesitamos que get_page también llame a /children
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, _init: RequestInit = {}) => {
        callCount++;
        if (url.includes("/pages/") && !url.includes("/children") && callCount <= 2) {
          return {
            ok: false,
            status: 429,
            headers: new Headers({ "retry-after": "0" }),
            text: async () => JSON.stringify({ message: "rate limited" }),
          } as Response;
        }
        // children o tercer intento de page: éxito
        if (url.includes("/children")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            text: async () => JSON.stringify({ results: [] }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () =>
            JSON.stringify({
              id: "p1",
              properties: { Name: { type: "title", title: [{ plain_text: "OK" }] } },
            }),
        } as Response;
      }),
    );

    const out = (await notion_server.callTool("tok", "get_page", {
      pageId: "00000000000000000000000000000001",
    })) as { title: string };
    expect(out.title).toBe("OK");
    // Al menos 2 intentos del page fetch (con reintentos por 429)
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("después de MAX_RETRIES intentos con 429, lanza error de rate limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "0" }),
        text: async () => JSON.stringify({ message: "rate limited" }),
      })),
    );
    await expect(
      notion_server.callTool("tok", "get_page", { pageId: "00000000000000000000000000000001" }),
    ).rejects.toThrow(/rate limit/i);
  });
});
