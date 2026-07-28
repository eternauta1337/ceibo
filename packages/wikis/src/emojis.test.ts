import { describe, expect, it } from "vitest";
import {
  applyEmoji,
  CEIBO_DIR_PREFIX,
  EMOJIS_PATH,
  type EmojiMap,
  isCeiboMeta,
  parseEmojis,
  serializeEmojis,
} from "./emojis.ts";

describe("EMOJIS_PATH / CEIBO_DIR_PREFIX", () => {
  it("el sidecar vive bajo la carpeta de metadatos", () => {
    expect(EMOJIS_PATH.startsWith(CEIBO_DIR_PREFIX)).toBe(true);
    expect(EMOJIS_PATH).toBe(".ceibo/emojis.json");
  });
});

describe("isCeiboMeta (exclusión del árbol del explorer)", () => {
  it("los paths bajo .ceibo/ son metadatos", () => {
    expect(isCeiboMeta(".ceibo/emojis.json")).toBe(true);
    expect(isCeiboMeta(".ceibo/lo-que-sea.txt")).toBe(true);
  });
  it("tolera el slash inicial", () => {
    expect(isCeiboMeta("/.ceibo/emojis.json")).toBe(true);
  });
  it("las notas normales NO son metadatos", () => {
    expect(isCeiboMeta("nota.md")).toBe(false);
    expect(isCeiboMeta("carpeta/nota.md")).toBe(false);
    // No confundir un archivo que solo empieza parecido.
    expect(isCeiboMeta(".ceibofake.md")).toBe(false);
  });
});

describe("parseEmojis (tolerante)", () => {
  it("parsea un mapa válido", () => {
    expect(parseEmojis('{"a.md":"📌","b/c.md":"🔥"}')).toEqual({ "a.md": "📌", "b/c.md": "🔥" });
  });
  it("vacío/null/undefined → {}", () => {
    expect(parseEmojis("")).toEqual({});
    expect(parseEmojis(null)).toEqual({});
    expect(parseEmojis(undefined)).toEqual({});
  });
  it("JSON inválido → {} (no tira)", () => {
    expect(parseEmojis("{no es json")).toEqual({});
  });
  it("no-objeto (array / número / string) → {}", () => {
    expect(parseEmojis("[1,2,3]")).toEqual({});
    expect(parseEmojis("42")).toEqual({});
    expect(parseEmojis('"hola"')).toEqual({});
  });
  it("descarta entradas que no son string→string no vacío", () => {
    expect(parseEmojis('{"a.md":"📌","b.md":123,"c.md":null,"d.md":"  ","e.md":""}')).toEqual({
      "a.md": "📌",
    });
  });
  it("normaliza el slash inicial de las claves", () => {
    expect(parseEmojis('{"/a.md":"📌"}')).toEqual({ "a.md": "📌" });
  });
});

describe("applyEmoji (merge / clear, inmutable)", () => {
  it("agrega un emoji nuevo sin mutar el original", () => {
    const base: EmojiMap = { "a.md": "📌" };
    const next = applyEmoji(base, "b.md", "🔥");
    expect(next).toEqual({ "a.md": "📌", "b.md": "🔥" });
    expect(base).toEqual({ "a.md": "📌" }); // intacto
  });
  it("sobreescribe el emoji de una nota existente", () => {
    expect(applyEmoji({ "a.md": "📌" }, "a.md", "🚀")).toEqual({ "a.md": "🚀" });
  });
  it("emoji vacío → BORRA la entrada (limpiar)", () => {
    expect(applyEmoji({ "a.md": "📌", "b.md": "🔥" }, "a.md", "")).toEqual({ "b.md": "🔥" });
  });
  it("emoji solo-whitespace → BORRA la entrada", () => {
    expect(applyEmoji({ "a.md": "📌" }, "a.md", "   ")).toEqual({});
  });
  it("limpiar una nota inexistente es no-op", () => {
    expect(applyEmoji({ "a.md": "📌" }, "z.md", "")).toEqual({ "a.md": "📌" });
  });
  it("trimea el emoji guardado", () => {
    expect(applyEmoji({}, "a.md", "  📌 ")).toEqual({ "a.md": "📌" });
  });
  it("normaliza el slash inicial del path", () => {
    expect(applyEmoji({}, "/a.md", "📌")).toEqual({ "a.md": "📌" });
  });
});

describe("serializeEmojis", () => {
  it("ordena las claves y termina en newline", () => {
    const out = serializeEmojis({ "b.md": "🔥", "a.md": "📌" });
    expect(out).toBe(`{\n  "a.md": "📌",\n  "b.md": "🔥"\n}\n`);
  });
  it("round-trip: serialize → parse devuelve el mismo mapa", () => {
    const map: EmojiMap = { "a.md": "📌", "carpeta/b.md": "🔥" };
    expect(parseEmojis(serializeEmojis(map))).toEqual(map);
  });
  it("mapa vacío serializa a un objeto vacío parseable", () => {
    expect(parseEmojis(serializeEmojis({}))).toEqual({});
  });
});
