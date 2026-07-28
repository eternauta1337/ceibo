// MCP server de Notion: traduce MCP → Notion REST API.
//
// Notion NO es Google: usa su propio cliente (header obligatorio `Notion-Version`)
// y su access_token de larga duración llega como Bearer desde el vault (credencial
// static_bearer, no mcp_oauth — ver @ceibo/oauth providers).
//
// Tools: search, get_page (propiedades + contenido como texto), create_page.
//
// Notas de calidad (2026-06):
// - search pagina la API, re-rankea por match de título (la relevancia nativa de
//   /search es floja para "encontrá la página X") y devuelve parent + fecha.
//   /search solo ve lo que la integración tiene compartido: si una página no está
//   compartida con la integración, NO va a aparecer por más query que se pruebe.
// - get_page pagina los children (next_cursor) y recursa en has_children
//   (toggles, columnas, listas anidadas, synced blocks) con indentación, cubriendo
//   muchos más tipos de bloque. Tope de profundidad/bloques para páginas gigantes.
//   Las páginas de database exponen sus properties como texto legible.
//
// Versión de API: pineada intencionalmente a 2022-06-28.
// En 2025-09-03 las databases migraron a "data sources" con dual-ID
// (database_id de URL vs data_source_id de la API). Migrar requiere un mapper
// bidireccional (ver ceibo-archive/mother-ene/utils/database-id-mapper.ts) y
// solo vale la pena cuando agreguemos tools de database (query_database, etc.).
// Para search + get_page + create_page, 2022-06-28 funciona perfecto.

import type { McpServer, Tool, ToolArgs } from "../core/transport.ts";

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const MAX_RETRIES = 3;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Fetch tipado contra la REST API de Notion. Forwardea el Bearer del vault y suma
 *  el header de versión que Notion exige. No loguea tokens.
 *  Maneja rate-limit (429): respeta Retry-After y reintenta hasta MAX_RETRIES veces.
 *  En 404, anexa hint sobre integración no compartida ya que Notion devuelve 404
 *  también cuando la página existe pero no está compartida con la integración. */
async function notion<T>(token: string, path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  // Rate limit: respetar Retry-After y reintentar con tope de intentos.
  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "2", 10);
    await sleep(Math.min(retryAfter, 30) * 1000);
    return notion<T>(token, path, init, attempt + 1);
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    let msg = (body as { message?: string })?.message ?? `Notion API HTTP ${res.status}`;
    if (res.status === 404) {
      msg +=
        " (ojo: Notion devuelve 404 también cuando la página existe pero no está " +
        "compartida con la integración — Connections → agregar la integración)";
    }
    if (attempt >= MAX_RETRIES && res.status === 429) {
      msg = `Notion rate limit (429) después de ${MAX_RETRIES} reintentos. Esperá unos segundos y reintentá.`;
    }
    throw new Error(msg);
  }
  return body as T;
}

// --- Tipos mínimos --------------------------------------------------------
interface RichTextItem {
  type?: string;
  plain_text?: string;
  href?: string | null;
  mention?: { type?: string; page?: { id?: string } };
}
interface NotionProp {
  type?: string;
  title?: RichTextItem[];
  rich_text?: RichTextItem[];
  number?: number | null;
  checkbox?: boolean;
  date?: { start?: string; end?: string | null } | null;
  select?: { name?: string } | null;
  multi_select?: { name?: string }[];
  status?: { name?: string } | null;
  people?: { name?: string; id?: string }[];
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  relation?: { id?: string }[];
  formula?: {
    type?: string;
    string?: string;
    number?: number;
    boolean?: boolean;
    date?: { start?: string } | null;
  };
}
interface NotionParent {
  type?: string;
  page_id?: string;
  database_id?: string;
  block_id?: string;
}
interface NotionPage {
  id?: string;
  url?: string;
  object?: string;
  last_edited_time?: string;
  parent?: NotionParent;
  properties?: Record<string, NotionProp>;
  archived?: boolean;
  in_trash?: boolean;
  /** Las databases llevan el título top-level, no en properties. */
  title?: RichTextItem[];
}
interface SearchResult {
  results?: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
}
interface Block {
  id?: string;
  type?: string;
  has_children?: boolean;
  synced_block?: { synced_from?: { block_id?: string } | null };
  [k: string]: unknown;
}
interface BlockChildren {
  results?: Block[];
  has_more?: boolean;
  next_cursor?: string | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Renderiza rich_text a texto, preservando hrefs como links markdown. */
function richText(rt?: RichTextItem[]): string {
  return (rt ?? [])
    .map((item) => {
      const text = item.plain_text ?? "";
      if (!text) return "";
      // Links: emitir como markdown. Para menciones a página, agregar el id.
      if (item.href) {
        return `[${text}](${item.href})`;
      }
      if (item.type === "mention" && item.mention?.type === "page" && item.mention.page?.id) {
        return `${text} (id: ${item.mention.page.id})`;
      }
      return text;
    })
    .join("");
}

/** Título de una página (propiedad `title`) o de una database (campo top-level). */
function pageTitle(page: NotionPage): string {
  if (Array.isArray(page.title)) {
    // rich_text puede tener hrefs pero para el título usamos plain_text directo
    const t = (page.title ?? []).map((i) => i.plain_text ?? "").join("");
    if (t) return t;
  }
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop.type === "title") {
      return (prop.title ?? []).map((i) => i.plain_text ?? "").join("") || "(sin título)";
    }
  }
  return "(sin título)";
}

/** Acepta un id (con o sin guiones) o una URL de Notion y devuelve el id pelado.
 *  Las URLs terminan en `...-<32 hex>` (más query opcional); la API acepta el id sin guiones.
 *  Si el input parece un nombre de página (tiene espacios, o es suficientemente largo
 *  y contiene letras no-hex), lanza un error claro para que el modelo busque el id
 *  con search en vez de pasar el título directamente. */
function normalizePageId(input: string): string {
  const cleaned = (input.trim().split(/[?#]/)[0] ?? "").replace(/-/g, "");
  const m = cleaned.match(/[0-9a-f]{32}$/i);
  if (m) return m[0];
  const trimmed = input.trim();
  // Heurística: tiene espacios → nombre de página.
  // O tiene >8 chars y el valor limpio (sin guiones) no es todo hex → slug/nombre.
  // El tope de 8 evita falsos positivos con IDs de test cortos ("p1", "arch").
  const cleanedForCheck = trimmed.replace(/-/g, "");
  const looksLikeName =
    /\s/.test(trimmed) || (cleanedForCheck.length > 8 && !/^[0-9a-f]+$/i.test(cleanedForCheck));
  if (looksLikeName) {
    throw new Error(
      `'${trimmed}' parece un nombre de página, no un id. ` +
        "Buscala primero con search para obtener el id.",
    );
  }
  return trimmed;
}

/** Extrae el valor legible de una property de database.
 *  Cubre los tipos más comunes (~95% del uso real). */
function extractPropertyValue(prop: NotionProp): string | null {
  switch (prop.type) {
    case "title":
      return (prop.title ?? []).map((i) => i.plain_text ?? "").join("") || null;
    case "rich_text":
      return (prop.rich_text ?? []).map((i) => i.plain_text ?? "").join("") || null;
    case "number":
      return prop.number != null ? String(prop.number) : null;
    case "checkbox":
      return prop.checkbox != null ? (prop.checkbox ? "sí" : "no") : null;
    case "date":
      if (!prop.date?.start) return null;
      return prop.date.end ? `${prop.date.start} → ${prop.date.end}` : prop.date.start;
    case "select":
      return prop.select?.name ?? null;
    case "multi_select":
      return (
        (prop.multi_select ?? [])
          .map((o) => o.name ?? "")
          .filter(Boolean)
          .join(", ") || null
      );
    case "status":
      return prop.status?.name ?? null;
    case "people":
      return (
        (prop.people ?? [])
          .map((p) => p.name ?? p.id ?? "")
          .filter(Boolean)
          .join(", ") || null
      );
    case "url":
      return prop.url ?? null;
    case "email":
      return prop.email ?? null;
    case "phone_number":
      return prop.phone_number ?? null;
    case "relation":
      return (
        (prop.relation ?? [])
          .map((r) => r.id ?? "")
          .filter(Boolean)
          .join(", ") || null
      );
    case "formula": {
      const f = prop.formula;
      if (!f) return null;
      if (f.type === "string") return f.string ?? null;
      if (f.type === "number") return f.number != null ? String(f.number) : null;
      if (f.type === "boolean") return f.boolean != null ? (f.boolean ? "sí" : "no") : null;
      if (f.type === "date") return f.date?.start ?? null;
      return null;
    }
    default:
      return null;
  }
}

/** Parent compacto para que el modelo se ubique sin fetches extra. */
function parentRef(p?: NotionParent): { type: string; id?: string } {
  if (!p?.type) return { type: "unknown" };
  if (p.type === "page_id") return { type: "page", id: p.page_id };
  if (p.type === "database_id") return { type: "database", id: p.database_id };
  if (p.type === "block_id") return { type: "block", id: p.block_id };
  return { type: p.type.replace(/_id$/, "") };
}

// --- Search ----------------------------------------------------------------
// /search de Notion rankea flojo: paginamos varios batches y re-rankeamos por
// match de título contra la query (orden estable: a igual score queda el orden
// que devolvió la API).

const SEARCH_FETCH_CAP = 100; // tope de resultados crudos a paginar por búsqueda

const norm = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** Score de match título↔query: exacto > prefijo > substring > todas las palabras. */
function titleScore(title: string, query: string): number {
  const t = norm(title);
  const q = norm(query);
  if (!q || !t) return 0;
  if (t === q) return 4;
  if (t.startsWith(q)) return 3;
  if (t.includes(q)) return 2;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 1;
  return 0;
}

async function searchPaginated(
  token: string,
  query: string,
  kind: string,
  cap: number,
): Promise<{ results: NotionPage[]; hasMore: boolean }> {
  const results: NotionPage[] = [];
  let cursor: string | undefined;
  let hasMore = false;
  do {
    const body: Record<string, unknown> = {
      page_size: Math.min(100, cap - results.length),
    };
    if (query) body.query = query;
    if (kind !== "all") body.filter = { value: kind, property: "object" };
    // Sin query no hay relevancia posible: lo más reciente primero es lo útil.
    if (!query) body.sort = { direction: "descending", timestamp: "last_edited_time" };
    if (cursor) body.start_cursor = cursor;
    const out = await notion<SearchResult>(token, "/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
    results.push(...(out.results ?? []));
    hasMore = out.has_more === true;
    cursor = hasMore ? (out.next_cursor ?? undefined) : undefined;
  } while (cursor && results.length < cap);
  return { results, hasMore: hasMore && results.length >= cap };
}

// --- Lectura de bloques ------------------------------------------------------
// Paginación completa de children + recursión en has_children con indentación.
// Presupuesto global de bloques y tope de profundidad para no explotar en
// páginas gigantes; si se corta, se avisa en el contenido.

const MAX_BLOCKS = 1000;
const MAX_DEPTH = 6;

interface Budget {
  remaining: number;
  truncated: boolean;
}

/** Una pasada paginada por los children directos de un bloque/página. */
async function listChildren(token: string, blockId: string, budget: Budget): Promise<Block[]> {
  const out: Block[] = [];
  let cursor: string | undefined;
  do {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    const qs = [
      `page_size=${Math.min(100, budget.remaining)}`,
      cursor ? `start_cursor=${encodeURIComponent(cursor)}` : "",
    ]
      .filter(Boolean)
      .join("&");
    const res = await notion<BlockChildren>(token, `/blocks/${encodeURIComponent(blockId)}/children?${qs}`);
    const batch = res.results ?? [];
    out.push(...batch);
    budget.remaining -= batch.length;
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return out;
}

/** Líneas de texto propias de un bloque (sin children). `num` numera las listas. */
function blockLines(b: Block, num: number): string[] {
  const type = b.type ?? "";
  const data = b[type] as Record<string, unknown> | undefined;
  const text = richText(data?.rich_text as RichTextItem[] | undefined);
  switch (type) {
    case "paragraph":
      return text ? [text] : [];
    case "heading_1":
      return text ? [`# ${text}`] : [];
    case "heading_2":
      return text ? [`## ${text}`] : [];
    case "heading_3":
      return text ? [`### ${text}`] : [];
    case "bulleted_list_item":
      return [`- ${text}`];
    case "numbered_list_item":
      return [`${num}. ${text}`];
    case "to_do":
      return [`${data?.checked === true ? "[x]" : "[ ]"} ${text}`];
    case "toggle":
      return [`▸ ${text}`];
    case "quote":
      return text.split("\n").map((l) => `> ${l}`);
    case "callout": {
      const icon = (data?.icon as { emoji?: string } | undefined)?.emoji;
      return [`> ${icon ? `${icon} ` : ""}${text}`];
    }
    case "code": {
      const lang = str(data?.language);
      return [`\`\`\`${lang === "plain text" ? "" : lang}`, ...text.split("\n"), "```"];
    }
    case "divider":
      return ["---"];
    case "equation":
      return data?.expression ? [`$${str(data.expression)}$`] : [];
    case "child_page":
      return [`→ subpágina: ${str(data?.title) || "(sin título)"} (id: ${b.id ?? "?"})`];
    case "child_database":
      return [`→ database: ${str(data?.title) || "(sin título)"} (id: ${b.id ?? "?"})`];
    case "bookmark":
    case "embed":
    case "link_preview": {
      const url = str(data?.url);
      const caption = richText(data?.caption as RichTextItem[] | undefined);
      return url ? [caption ? `[${caption}](${url})` : url] : [];
    }
    case "image":
    case "video":
    case "audio":
    case "file":
    case "pdf": {
      const url =
        str((data?.external as { url?: string } | undefined)?.url) ||
        str((data?.file as { url?: string } | undefined)?.url);
      const caption = richText(data?.caption as RichTextItem[] | undefined);
      return [`[${type}${caption ? `: ${caption}` : ""}]${url ? ` ${url}` : ""}`];
    }
    case "table_row": {
      const cells = ((data?.cells as RichTextItem[][] | undefined) ?? []).map((c) => richText(c));
      return [`| ${cells.join(" | ")} |`];
    }
    // Contenedores sin texto propio: el contenido sale de sus children.
    case "table":
    case "column_list":
    case "column":
    case "synced_block":
      return [];
    // Bloques de navegación/decoración sin contenido útil para el modelo.
    case "breadcrumb":
    case "table_of_contents":
      return [];
    default:
      // Tipo no contemplado: si trae rich_text lo mostramos igual, mejor que perderlo.
      return text ? [text] : [];
  }
}

/** Contenedores puros: los children se renderizan al mismo nivel (sin indentar). */
const FLAT_CONTAINERS = new Set(["table", "column_list", "column", "synced_block"]);

async function renderChildren(
  token: string,
  blockId: string,
  depth: number,
  budget: Budget,
): Promise<string[]> {
  const blocks = await listChildren(token, blockId, budget);
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  let num = 0;
  for (const b of blocks) {
    num = b.type === "numbered_list_item" ? num + 1 : 0;
    lines.push(...blockLines(b, Math.max(num, 1)).map((l) => indent + l));
    // No descendemos en child_page/child_database: son páginas aparte (se leen con get_page).
    if (b.has_children && b.id && b.type !== "child_page" && b.type !== "child_database") {
      if (depth + 1 >= MAX_DEPTH) {
        budget.truncated = true;
      } else {
        const flat = FLAT_CONTAINERS.has(b.type ?? "");
        // synced_block duplicado: el contenido vive en el bloque original, no en el duplicado.
        // Si synced_from.block_id existe, recursar sobre ese id en vez del propio.
        const recurseId =
          b.type === "synced_block" && b.synced_block?.synced_from?.block_id
            ? b.synced_block.synced_from.block_id
            : b.id;
        lines.push(...(await renderChildren(token, recurseId, flat ? depth : depth + 1, budget)));
      }
    }
  }
  return lines;
}

// --- Chunking de create_page -----------------------------------------------
// La API limita: ≤100 bloques por request, ≤2000 chars por rich_text.content.
// Chunkear automáticamente para que un dictado largo no falle con 400.

const MAX_BLOCKS_PER_REQUEST = 100;
const MAX_RICH_TEXT_CHARS = 2000;

interface ParagraphBlock {
  object: string;
  type: "paragraph";
  paragraph: { rich_text: { type: string; text: { content: string } }[] };
}

/** Convierte una línea de texto en uno o más bloques párrafo, partiendo en
 *  trozos de MAX_RICH_TEXT_CHARS si la línea es demasiado larga. */
function lineToBlocks(line: string): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  let remaining = line;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, MAX_RICH_TEXT_CHARS);
    remaining = remaining.slice(MAX_RICH_TEXT_CHARS);
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] },
    });
  }
  return blocks;
}

const TOOLS: Tool[] = [
  {
    name: "search",
    description:
      "Busca páginas (y opcionalmente databases) en el Notion del usuario por texto. " +
      "Pagina la API y prioriza matches por título. Devuelve id, título, URL, parent y " +
      "última edición. Solo ve lo que está compartido con la integración de Notion.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Texto a buscar (idealmente el nombre de la página). Vacío = lo más reciente.",
        },
        maxResults: { type: "integer", description: "Máx resultados (1-25). Default 10." },
        kind: {
          type: "string",
          enum: ["page", "database", "all"],
          description: "Qué objetos buscar. Default: page.",
        },
      },
    },
  },
  {
    name: "get_page",
    description:
      "Lee una página completa: título, properties (si es una página de database), y " +
      "contenido (todos los bloques, paginado y con recursión en bloques anidados como " +
      "toggles/columnas/listas) aplanado a markdown. " +
      "Las subpáginas aparecen como `→ subpágina: ... (id)` y se leen con otro get_page.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "id o URL-id de la página (de search o de un link)." },
      },
      required: ["pageId"],
    },
  },
  {
    name: "create_page",
    description:
      "Crea una página nueva como hija de otra página. `content` es texto plano (cada " +
      "línea = un párrafo). Confirmá con el usuario antes de crear. Soporta contenido " +
      "largo: chunkea automáticamente si supera 100 bloques o 2000 chars por línea.",
    inputSchema: {
      type: "object",
      properties: {
        parentPageId: { type: "string", description: "id de la página padre." },
        title: { type: "string" },
        content: { type: "string", description: "Cuerpo en texto; cada línea es un párrafo." },
      },
      required: ["parentPageId", "title"],
    },
  },
];

async function callTool(token: string, name: string, args: ToolArgs): Promise<unknown> {
  if (name === "search") {
    const max = Math.min(Math.max(Number(args.maxResults ?? 10), 1), 25);
    const query = str(args.query).trim();
    const kind = ["page", "database", "all"].includes(str(args.kind)) ? str(args.kind) : "page";
    // Con query paginamos de más para poder re-rankear por título; sin query no hace falta.
    const cap = query ? Math.min(SEARCH_FETCH_CAP, Math.max(max * 4, 40)) : max;
    const { results, hasMore } = await searchPaginated(token, query, kind, cap);
    const ranked = query
      ? results
          .map((p, i) => ({ p, i, score: titleScore(pageTitle(p), query) }))
          .sort((a, b) => b.score - a.score || a.i - b.i)
          .map((r) => r.p)
      : results;
    const pages = ranked.slice(0, max).map((p) => ({
      id: p.id,
      title: pageTitle(p),
      url: p.url,
      kind: p.object,
      parent: parentRef(p.parent),
      last_edited: p.last_edited_time,
      ...(p.archived || p.in_trash ? { archived: true } : {}),
    }));
    return {
      count: pages.length,
      has_more: hasMore || ranked.length > max,
      pages,
      ...(pages.length === 0
        ? {
            note:
              "Sin resultados. Ojo: la búsqueda solo ve páginas compartidas con la " +
              "integración de Notion; si la página existe, hay que compartirla " +
              "(Connections → la integración) o pasar su link/id directo a get_page.",
          }
        : {}),
    };
  }

  if (name === "get_page") {
    const id = normalizePageId(str(args.pageId));
    const page = await notion<NotionPage>(token, `/pages/${encodeURIComponent(id)}`);
    const budget: Budget = { remaining: MAX_BLOCKS, truncated: false };
    const lines = await renderChildren(token, id, 0, budget);
    let body = lines.join("\n");
    if (budget.truncated) {
      body += `\n\n[⚠ contenido truncado: la página supera el tope de ${MAX_BLOCKS} bloques o ${MAX_DEPTH} niveles de anidado]`;
    }

    // Properties de database: si la página vive en una database o tiene properties
    // más allá del título, extraerlas como texto legible.
    const props = page.properties ?? {};
    const propLines: string[] = [];
    for (const [key, prop] of Object.entries(props)) {
      if (prop.type === "title") continue; // ya está en el título
      const val = extractPropertyValue(prop);
      if (val != null && val !== "") propLines.push(`${key}: ${val}`);
    }

    return {
      id: page.id,
      title: pageTitle(page),
      url: page.url,
      truncated: budget.truncated,
      ...(page.archived || page.in_trash ? { archived: true } : {}),
      ...(propLines.length > 0 ? { properties: propLines } : {}),
      content: body,
    };
  }

  if (name === "create_page") {
    const parentId = normalizePageId(str(args.parentPageId));
    const allBlocks = str(args.content)
      .split("\n")
      .filter((l) => l.length > 0)
      .flatMap((line) => lineToBlocks(line));

    // Crear la página con los primeros MAX_BLOCKS_PER_REQUEST bloques.
    const firstBatch = allBlocks.slice(0, MAX_BLOCKS_PER_REQUEST);
    const page = await notion<NotionPage>(token, "/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { page_id: parentId },
        properties: { title: { title: [{ type: "text", text: { content: str(args.title) } }] } },
        children: firstBatch,
      }),
    });

    // Appendear el resto en tandas de MAX_BLOCKS_PER_REQUEST.
    const pageId = page.id ?? "";
    const remaining = allBlocks.slice(MAX_BLOCKS_PER_REQUEST);
    for (let i = 0; i < remaining.length; i += MAX_BLOCKS_PER_REQUEST) {
      const chunk = remaining.slice(i, i + MAX_BLOCKS_PER_REQUEST);
      await notion(token, `/blocks/${encodeURIComponent(pageId)}/children`, {
        method: "PATCH",
        body: JSON.stringify({ children: chunk }),
      });
    }

    return { id: page.id, url: page.url };
  }

  throw new Error(`tool desconocida: ${name}`);
}

export const notion_server: McpServer = { name: "notion", tools: TOOLS, callTool };
