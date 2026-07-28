// Embeddings del índice de notas (feature db F1): chunker + codec de vectores + cliente
// del bi-encoder de Onyx (corre en gpuhost; endpoint verificado 2026-07-11, ver wiki
// tecnico/features/db/plan.md "Datos del terreno").
//
// Vive en store (hoja) a propósito: el reconciliador (web-server) lo usa para indexar y
// el MCP de búsqueda (gateway, F2) lo va a usar para embeber queries — ambos dependen de
// store y de nadie más. Es la plomería de datos del índice, no lógica de producto.
//
// El modelo devuelve vectores NORMALIZADOS (norma 1) ⇒ similitud coseno = producto punto.

export const DEFAULT_EMBED_MODEL = "Alibaba-NLP/gte-multilingual-base";
export const EMBED_DIM = 768;

// --- Codec: Float32 little-endian <-> BLOB ---------------------------------

export function vectorToBlob(vec: readonly number[] | Float32Array): Buffer {
  const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function blobToVector(blob: Buffer): Float32Array {
  // Copia defensiva: el Buffer de better-sqlite3 puede compartir un pool.
  const out = new Float32Array(blob.byteLength / 4);
  new Uint8Array(out.buffer).set(blob);
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

// --- Chunker ----------------------------------------------------------------

// ~1400 chars ≈ bien abajo de los 512 tokens del max_context_length del modelo (es/en).
const CHUNK_MAX_CHARS = 1400;

/** Parte una nota markdown en fragmentos embebibles. Corta por headings y párrafos
 *  (nunca a mitad de línea salvo bloques monolíticos gigantes) y agrupa hasta ~maxChars.
 *  Cada fragmento arranca con el heading vigente para que el vector tenga contexto. */
export function chunkNote(content: string, maxChars = CHUNK_MAX_CHARS): string[] {
  const text = content.trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  // Bloques = párrafos separados por línea en blanco; los headings abren bloque propio.
  const blocks: { heading: string | null; text: string }[] = [];
  let heading: string | null = null;
  for (const raw of text.split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;
    if (/^#{1,6}\s/.test(block)) {
      heading = block.split("\n")[0] as string;
      blocks.push({ heading, text: block });
      continue;
    }
    blocks.push({ heading, text: block });
  }

  const chunks: string[] = [];
  let cur = "";
  let curHeading: string | null = null;
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };
  for (const b of blocks) {
    // Bloque monolítico más grande que el límite: se parte duro (raro; tablas/código).
    const pieces =
      b.text.length > maxChars
        ? (b.text.match(new RegExp(`[\\s\\S]{1,${maxChars - 200}}`, "g")) ?? [])
        : [b.text];
    for (const piece of pieces) {
      const withHeading = (h: string | null): string =>
        b.heading && b.heading !== h && !piece.startsWith(b.heading) ? `${b.heading}\n${piece}` : piece;
      let text = withHeading(curHeading);
      if (cur && cur.length + text.length + 2 > maxChars) {
        flush();
        curHeading = null;
        text = withHeading(null);
      }
      cur = cur ? `${cur}\n\n${text}` : text;
      curHeading = b.heading;
    }
  }
  flush();
  return chunks;
}

// --- Cliente del bi-encoder (Onyx model server) ------------------------------

export interface Embedder {
  readonly modelId: string;
  /** Embebe textos en lotes; devuelve un vector por texto, en orden. Lanza si el server
   *  no responde tras los reintentos (el caller decide degradar). */
  embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]>;
}

export interface EmbedderOpts {
  url: string; // base, ej. http://100.64.0.10:9000
  modelId?: string;
  batchSize?: number;
  retries?: number;
  fetchFn?: typeof fetch; // inyectable para tests
}

export function createEmbedder(opts: EmbedderOpts): Embedder {
  const modelId = opts.modelId ?? DEFAULT_EMBED_MODEL;
  const batchSize = opts.batchSize ?? 16;
  const retries = opts.retries ?? 2;
  const doFetch = opts.fetchFn ?? fetch;
  const endpoint = `${opts.url.replace(/\/$/, "")}/encoder/bi-encoder-embed`;

  async function embedBatch(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await doFetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            texts,
            model_name: modelId,
            text_type: kind,
            max_context_length: 512,
            normalize_embeddings: true,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`embed server ${res.status}`);
        const body = (await res.json()) as { embeddings?: number[][] };
        const vecs = body.embeddings;
        if (!Array.isArray(vecs) || vecs.length !== texts.length) {
          throw new Error(
            `embed server: respuesta con ${vecs?.length ?? 0} vectores para ${texts.length} textos`,
          );
        }
        return vecs.map((v) => Float32Array.from(v));
      } catch (e) {
        lastErr = e;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  return {
    modelId,
    async embed(texts, kind) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        out.push(...(await embedBatch(texts.slice(i, i + batchSize), kind)));
      }
      return out;
    },
  };
}
