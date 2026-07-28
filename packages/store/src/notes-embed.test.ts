import { describe, expect, it, vi } from "vitest";
import { blobToVector, chunkNote, createEmbedder, dot, vectorToBlob } from "./notes-embed.ts";

describe("chunkNote", () => {
  it("nota corta = un solo chunk; vacía = ninguno", () => {
    expect(chunkNote("# Hola\n\nun párrafo")).toEqual(["# Hola\n\nun párrafo"]);
    expect(chunkNote("   \n  ")).toEqual([]);
  });

  it("nota larga se parte por párrafos sin exceder el máximo, con heading de contexto", () => {
    const para = "x".repeat(300);
    const md = `# Doc\n\n## Sección A\n\n${para}\n\n${para}\n\n## Sección B\n\n${para}\n\n${para}`;
    const chunks = chunkNote(md, 800);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(800);
    // Un chunk que siguió dentro de la Sección B sin abrirla arrastra su heading.
    const cont = chunks.filter((c) => c.startsWith("## Sección B"));
    expect(cont.length).toBeGreaterThanOrEqual(1);
    // Todo el contenido sobrevive (los párrafos están en algún chunk).
    expect(chunks.join("\n\n")).toContain("## Sección A");
  });

  it("bloque monolítico más grande que el máximo se parte duro", () => {
    const monster = "y".repeat(3000);
    const chunks = chunkNote(monster, 1000);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    expect(chunks.join("")).toContain("y".repeat(100));
  });
});

describe("codec de vectores", () => {
  it("roundtrip f32 y producto punto", () => {
    const v = Float32Array.from([0.5, -0.25, 1 / 3]);
    const back = blobToVector(vectorToBlob(v));
    expect(Array.from(back)).toEqual(Array.from(v));
    expect(dot(Float32Array.from([1, 2, 3]), Float32Array.from([4, 5, 6]))).toBeCloseTo(32);
  });
});

describe("createEmbedder", () => {
  const okResponse = (texts: string[]) =>
    new Response(JSON.stringify({ embeddings: texts.map((_, i) => [i, i + 0.5]) }), { status: 200 });

  it("batchea, respeta el orden y arma el payload del bi-encoder de Onyx", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      return okResponse(body.texts as string[]);
    });
    const e = createEmbedder({ url: "http://gpuhost:9000/", batchSize: 2, fetchFn: fetchFn as typeof fetch });
    const vecs = await e.embed(["a", "b", "c"], "passage");

    expect(vecs).toHaveLength(3);
    expect(Array.from(vecs[2]!)).toEqual([0, 0.5]); // primer elemento de SU batch → el orden global se respeta por posición
    expect(calls).toHaveLength(2); // 2+1 con batchSize 2
    expect(calls[0]?.url).toBe("http://gpuhost:9000/encoder/bi-encoder-embed");
    expect(calls[0]?.body).toMatchObject({
      text_type: "passage",
      max_context_length: 512,
      normalize_embeddings: true,
      model_name: "Alibaba-NLP/gte-multilingual-base",
    });
    const q = await e.embed(["q"], "query");
    expect(q).toHaveLength(1);
    expect(calls[2]?.body).toMatchObject({ text_type: "query" });
  });

  it("reintenta ante 500 y falla con error tras agotar reintentos", async () => {
    let n = 0;
    const flaky = vi.fn(async (_u: Parameters<typeof fetch>[0], init?: RequestInit) => {
      n++;
      if (n === 1) return new Response("boom", { status: 500 });
      return okResponse(JSON.parse(init?.body as string).texts as string[]);
    });
    const e = createEmbedder({ url: "http://x", retries: 2, fetchFn: flaky as typeof fetch });
    await expect(e.embed(["a"], "query")).resolves.toHaveLength(1);
    expect(n).toBe(2);

    const dead = vi.fn(async () => new Response("no", { status: 503 }));
    const e2 = createEmbedder({ url: "http://x", retries: 1, fetchFn: dead as typeof fetch });
    await expect(e2.embed(["a"], "query")).rejects.toThrow("embed server 503");
    expect(dead).toHaveBeenCalledTimes(2); // intento + 1 retry
  });

  it("rechaza respuestas con cantidad de vectores inconsistente", async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({ embeddings: [[1]] }), { status: 200 }));
    const e = createEmbedder({ url: "http://x", retries: 0, fetchFn: bad as typeof fetch });
    await expect(e.embed(["a", "b"], "passage")).rejects.toThrow(/1 vectores para 2/);
  });
});
