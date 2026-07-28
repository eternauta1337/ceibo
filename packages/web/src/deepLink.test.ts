import { describe, expect, it } from "vitest";
import { noteUrl, parseNoteUrl, parseSystemUrl, systemUrl } from "./deepLink.ts";

describe("noteUrl", () => {
  it("arma /<repo>/<path> con las carpetas como segmentos reales", () => {
    expect(noteUrl("demo-personal", "nota.md")).toBe("/demo-personal/nota.md");
    expect(noteUrl("demo-personal", "2026/junio/nota.md")).toBe("/demo-personal/2026/junio/nota.md");
  });

  it("encodea por segmento (espacios, acentos) sin tocar los `/` de carpeta", () => {
    expect(noteUrl("mi wiki", "carpeta con espacios/año nuevo.md")).toBe(
      "/mi%20wiki/carpeta%20con%20espacios/a%C3%B1o%20nuevo.md",
    );
  });

  it("escapa un `/` literal dentro de un nombre como %2F (no lo confunde con carpeta)", () => {
    // (caso teórico: un nombre con `/` adentro no es un separador de carpeta)
    expect(noteUrl("repo", "a/b").includes("a/b")).toBe(true);
  });
});

describe("parseNoteUrl", () => {
  it("parsea un deep-link de nota", () => {
    expect(parseNoteUrl("/demo-personal/nota.md")).toEqual({ repo: "demo-personal", path: "nota.md" });
    expect(parseNoteUrl("/demo-personal/2026/junio/nota.md")).toEqual({
      repo: "demo-personal",
      path: "2026/junio/nota.md",
    });
  });

  it("decodifica los segmentos", () => {
    expect(parseNoteUrl("/mi%20wiki/a%C3%B1o%20nuevo.md")).toEqual({
      repo: "mi wiki",
      path: "año nuevo.md",
    });
  });

  it("es la inversa de noteUrl (round-trip)", () => {
    const repo = "mi wiki";
    const path = "carpeta con espacios/año nuevo.md";
    expect(parseNoteUrl(noteUrl(repo, path))).toEqual({ repo, path });
  });

  it("devuelve null para la raíz o un solo segmento (no es deep-link de nota)", () => {
    expect(parseNoteUrl("/")).toBeNull();
    expect(parseNoteUrl("")).toBeNull();
    expect(parseNoteUrl("/demo")).toBeNull(); // sólo el handle/repo, sin path
  });

  it("devuelve null ante un %xx inválido", () => {
    expect(parseNoteUrl("/repo/%E0%A4%A.md")).toBeNull();
  });

  it("devuelve null para slugs de sistema (1 segmento)", () => {
    // Los slugs de sistema viven en parseSystemUrl, no en parseNoteUrl.
    expect(parseNoteUrl("/config")).toBeNull();
    expect(parseNoteUrl("/agenda")).toBeNull();
    expect(parseNoteUrl("/conexiones")).toBeNull();
  });
});

describe("systemUrl", () => {
  it("arma /<page> para cada página de sistema", () => {
    expect(systemUrl("config")).toBe("/config");
    expect(systemUrl("agenda")).toBe("/agenda");
    expect(systemUrl("conexiones")).toBe("/conexiones");
  });

  it("encodea el id si contuviera caracteres especiales (robustez)", () => {
    // Los ids actuales son ASCII puro, pero la función es correcta por diseño.
    expect(systemUrl("config")).toBe("/config");
  });
});

describe("parseSystemUrl", () => {
  it("resuelve los slugs de las 3 páginas de sistema", () => {
    expect(parseSystemUrl("/config")).toBe("config");
    expect(parseSystemUrl("/agenda")).toBe("agenda");
    expect(parseSystemUrl("/conexiones")).toBe("conexiones");
  });

  it("devuelve null para slugs desconocidos", () => {
    expect(parseSystemUrl("/settings")).toBeNull();
    expect(parseSystemUrl("/AGENDA")).toBeNull(); // case-sensitive
    expect(parseSystemUrl("/Config")).toBeNull();
    expect(parseSystemUrl("/desconocido")).toBeNull();
  });

  it("devuelve null para paths de 2+ segmentos (son notas, no páginas de sistema)", () => {
    expect(parseSystemUrl("/demo/nota.md")).toBeNull();
    expect(parseSystemUrl("/config/algo")).toBeNull(); // 2 segmentos → nota
  });

  it("devuelve null para la raíz", () => {
    expect(parseSystemUrl("/")).toBeNull();
    expect(parseSystemUrl("")).toBeNull();
  });

  it("devuelve null ante un %xx inválido", () => {
    expect(parseSystemUrl("/%E0%A4%A")).toBeNull();
  });

  it("round-trip: systemUrl → parseSystemUrl", () => {
    expect(parseSystemUrl(systemUrl("config"))).toBe("config");
    expect(parseSystemUrl(systemUrl("agenda"))).toBe("agenda");
    expect(parseSystemUrl(systemUrl("conexiones"))).toBe("conexiones");
  });

  it("no colisiona con parseNoteUrl (espacios de 1 vs ≥2 segmentos son disjuntos)", () => {
    // Un slug de sistema da null para parseNoteUrl.
    expect(parseNoteUrl("/config")).toBeNull();
    // Un deep-link de nota (≥2 segmentos) da null para parseSystemUrl.
    expect(parseSystemUrl("/repo/nota.md")).toBeNull();
  });
});
