import { describe, expect, it } from "vitest";
import {
  getSystemPageMeta,
  isSystemPage,
  pageFromSlug,
  SYSTEM_PAGES,
  type SystemPage,
} from "./systemPages.ts";

describe("SYSTEM_PAGES registry", () => {
  it("contiene exactamente 8 páginas (agenda/canales/conexiones/archivo + perfil/apariencia/idioma/config)", () => {
    expect(SYSTEM_PAGES).toHaveLength(8);
  });

  it("contiene config, agenda, conexiones, archivo, perfil, apariencia, canales e idioma con sus ids", () => {
    const ids = SYSTEM_PAGES.map((p) => p.id);
    expect(ids).toContain("config");
    expect(ids).toContain("agenda");
    expect(ids).toContain("conexiones");
    expect(ids).toContain("archivo");
    expect(ids).toContain("perfil");
    expect(ids).toContain("apariencia");
    expect(ids).toContain("canales");
    expect(ids).toContain("idioma");
  });

  it("cada página tiene id, title, icon y slug definidos", () => {
    for (const p of SYSTEM_PAGES) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.title).toBe("string");
      expect(typeof p.icon).toBe("string");
      expect(typeof p.slug).toBe("string");
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.slug.length).toBeGreaterThan(0);
    }
  });

  it("el slug de config es 'config'", () => {
    const p = SYSTEM_PAGES.find((x) => x.id === "config");
    expect(p?.slug).toBe("config");
  });

  it("el slug de agenda es 'agenda'", () => {
    const p = SYSTEM_PAGES.find((x) => x.id === "agenda");
    expect(p?.slug).toBe("agenda");
  });

  it("el slug de conexiones es 'conexiones'", () => {
    const p = SYSTEM_PAGES.find((x) => x.id === "conexiones");
    expect(p?.slug).toBe("conexiones");
  });

  it("los slugs son únicos (no colisionan entre sí)", () => {
    const slugs = SYSTEM_PAGES.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("los ids son únicos", () => {
    const ids = SYSTEM_PAGES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getSystemPageMeta", () => {
  it("devuelve la metadata correcta para config", () => {
    const meta = getSystemPageMeta("config");
    expect(meta.id).toBe("config");
    expect(meta.icon).toBe("settings");
  });

  it("devuelve la metadata correcta para agenda", () => {
    const meta = getSystemPageMeta("agenda");
    expect(meta.id).toBe("agenda");
    expect(meta.icon).toBe("clock");
  });

  it("devuelve la metadata correcta para conexiones", () => {
    const meta = getSystemPageMeta("conexiones");
    expect(meta.id).toBe("conexiones");
    expect(meta.icon).toBe("plug");
  });

  it("devuelve la metadata correcta para archivo", () => {
    const meta = getSystemPageMeta("archivo");
    expect(meta.id).toBe("archivo");
    expect(meta.icon).toBe("archive");
    expect(meta.slug).toBe("archivo");
  });

  it("devuelve la metadata correcta para perfil (v2)", () => {
    const meta = getSystemPageMeta("perfil");
    expect(meta.id).toBe("perfil");
    expect(meta.icon).toBe("user");
    expect(meta.slug).toBe("perfil");
    expect(meta.group).toBe("setup");
  });

  it("devuelve la metadata correcta para apariencia (v2)", () => {
    const meta = getSystemPageMeta("apariencia");
    expect(meta.id).toBe("apariencia");
    expect(meta.icon).toBe("palette");
    expect(meta.slug).toBe("apariencia");
    expect(meta.group).toBe("setup");
  });

  it("devuelve la metadata correcta para canales (v2)", () => {
    const meta = getSystemPageMeta("canales");
    expect(meta.id).toBe("canales");
    expect(meta.icon).toBe("message");
    expect(meta.slug).toBe("canales");
    expect(meta.group).toBe("content");
  });

  it("devuelve la metadata correcta para idioma (v3)", () => {
    const meta = getSystemPageMeta("idioma");
    expect(meta.id).toBe("idioma");
    expect(meta.title).toBe("Idioma y voz");
    expect(meta.icon).toBe("languages");
    expect(meta.slug).toBe("idioma");
    expect(meta.group).toBe("setup");
  });

  it("idioma va inmediatamente antes de config en el orden del menú", () => {
    const ids = SYSTEM_PAGES.map((p) => p.id);
    expect(ids.indexOf("idioma")).toBe(ids.indexOf("config") - 1);
  });

  it("todas las páginas tienen un campo group válido", () => {
    for (const p of SYSTEM_PAGES) {
      expect(["content", "setup"]).toContain(p.group);
    }
  });

  it("round-trip: id → meta → id es estable", () => {
    const pages: SystemPage[] = [
      "config",
      "agenda",
      "conexiones",
      "archivo",
      "perfil",
      "apariencia",
      "canales",
      "idioma",
    ];
    for (const page of pages) {
      expect(getSystemPageMeta(page).id).toBe(page);
    }
  });
});

describe("pageFromSlug", () => {
  it("devuelve la page correcta para cada slug", () => {
    expect(pageFromSlug("config")).toBe("config");
    expect(pageFromSlug("agenda")).toBe("agenda");
    expect(pageFromSlug("conexiones")).toBe("conexiones");
    expect(pageFromSlug("archivo")).toBe("archivo");
    expect(pageFromSlug("perfil")).toBe("perfil");
    expect(pageFromSlug("apariencia")).toBe("apariencia");
    expect(pageFromSlug("canales")).toBe("canales");
    expect(pageFromSlug("idioma")).toBe("idioma");
  });

  it("devuelve null para un slug desconocido", () => {
    expect(pageFromSlug("settings")).toBeNull();
    expect(pageFromSlug("")).toBeNull();
    expect(pageFromSlug("Config")).toBeNull(); // case-sensitive
    expect(pageFromSlug("AGENDA")).toBeNull();
  });

  it("round-trip: slug → page → slug (via SYSTEM_PAGES) es estable", () => {
    for (const p of SYSTEM_PAGES) {
      const page = pageFromSlug(p.slug);
      expect(page).toBe(p.id);
    }
  });
});

describe("isSystemPage", () => {
  it("acepta los ids válidos", () => {
    expect(isSystemPage("config")).toBe(true);
    expect(isSystemPage("agenda")).toBe(true);
    expect(isSystemPage("conexiones")).toBe(true);
    expect(isSystemPage("archivo")).toBe(true);
    expect(isSystemPage("perfil")).toBe(true);
    expect(isSystemPage("apariencia")).toBe(true);
    expect(isSystemPage("canales")).toBe(true);
    expect(isSystemPage("idioma")).toBe(true);
  });

  it("rechaza el id viejo 'ediciones' (ya no es página de sistema)", () => {
    expect(isSystemPage("ediciones")).toBe(false);
  });

  it("rechaza strings que no son ids válidos", () => {
    expect(isSystemPage("settings")).toBe(false);
    expect(isSystemPage("Config")).toBe(false);
    expect(isSystemPage("")).toBe(false);
    expect(isSystemPage("AGENDA")).toBe(false);
  });

  it("rechaza valores no-string", () => {
    expect(isSystemPage(null)).toBe(false);
    expect(isSystemPage(undefined)).toBe(false);
    expect(isSystemPage(42)).toBe(false);
    expect(isSystemPage({})).toBe(false);
  });
});
