import { describe, expect, it } from "vitest";
import { type EmojiData, searchEmojis } from "./emojiData";

const data: EmojiData = {
  groups: [],
  all: [
    { char: "😀", name: "grinning face", terms: "grinning face grinning face smile happy joy" },
    { char: "❤️", name: "red heart", terms: "red heart red heart love like" },
    { char: "🚀", name: "rocket", terms: "rocket rocket launch space ship" },
    { char: "🏠", name: "house", terms: "house house home building" },
  ],
};

describe("searchEmojis", () => {
  it("query vacía devuelve null (vista por categorías)", () => {
    expect(searchEmojis(data, "")).toBeNull();
    expect(searchEmojis(data, "   ")).toBeNull();
  });

  it("matchea por nombre", () => {
    expect(searchEmojis(data, "rocket")?.map((e) => e.char)).toEqual(["🚀"]);
  });

  it("matchea por keyword aunque el nombre no la tenga", () => {
    // "happy" no está en el nombre "grinning face" pero sí en las keywords
    expect(searchEmojis(data, "happy")?.map((e) => e.char)).toEqual(["😀"]);
    expect(searchEmojis(data, "love")?.map((e) => e.char)).toEqual(["❤️"]);
  });

  it("es case-insensitive", () => {
    expect(searchEmojis(data, "ROCKET")?.map((e) => e.char)).toEqual(["🚀"]);
  });

  it("AND de tokens: exige todos los términos", () => {
    expect(searchEmojis(data, "space ship")?.map((e) => e.char)).toEqual(["🚀"]);
    expect(searchEmojis(data, "space house")).toEqual([]);
  });

  it("respeta el límite de resultados", () => {
    expect(searchEmojis(data, "e", 2)?.length).toBe(2);
  });
});
