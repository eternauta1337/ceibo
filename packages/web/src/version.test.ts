import { describe, expect, it } from "vitest";
import { pageTitle, versionBadge, versionLine } from "./version.ts";

describe("versionBadge", () => {
  // staging → siempre visible
  it("staging sin debugVersion → show=true, tag=staging", () => {
    const r = versionBadge("staging", "abc1234", "");
    expect(r).toEqual({ show: true, sha: "abc1234", tag: "staging" });
  });

  it("staging con debugVersion=1 → show=true (ya era visible)", () => {
    const r = versionBadge("staging", "abc1234", "?debugVersion=1");
    expect(r.show).toBe(true);
    expect(r.tag).toBe("staging");
  });

  // dev → siempre visible
  it("dev sin debugVersion → show=true, tag=dev", () => {
    const r = versionBadge("dev", "deadbee", "");
    expect(r).toEqual({ show: true, sha: "deadbee", tag: "dev" });
  });

  it("dev con debugVersion=1 → show=true", () => {
    expect(versionBadge("dev", "deadbee", "?debugVersion=1").show).toBe(true);
  });

  // prod → oculto por default
  it("prod sin debugVersion → show=false", () => {
    const r = versionBadge("prod", "f00ba7a", "");
    expect(r).toEqual({ show: false, sha: "f00ba7a", tag: "prod" });
  });

  it("prod con debugVersion=1 → show=true", () => {
    const r = versionBadge("prod", "f00ba7a", "?debugVersion=1");
    expect(r).toEqual({ show: true, sha: "f00ba7a", tag: "prod" });
  });

  it("prod con debugVersion distinto de '1' → show=false", () => {
    expect(versionBadge("prod", "f00ba7a", "?debugVersion=true").show).toBe(false);
    expect(versionBadge("prod", "f00ba7a", "?debugVersion=0").show).toBe(false);
  });

  // sha null
  it("sha null en staging → show=true pero sha=null", () => {
    const r = versionBadge("staging", null, "");
    expect(r.show).toBe(true);
    expect(r.sha).toBeNull();
  });
});

describe("pageTitle", () => {
  it("dev → prefijo [dev]", () => {
    expect(pageTitle("dev")).toBe("[dev] Ceibo");
  });

  it("staging → prefijo [staging]", () => {
    expect(pageTitle("staging")).toBe("[staging] Ceibo");
  });

  it("prod → pelado, sin prefijo", () => {
    expect(pageTitle("prod")).toBe("Ceibo");
  });

  it("respeta el base personalizado", () => {
    expect(pageTitle("dev", "Mi App")).toBe("[dev] Mi App");
    expect(pageTitle("prod", "Mi App")).toBe("Mi App");
  });
});

describe("versionLine", () => {
  // En Configuración la versión se muestra SIEMPRE, sin importar el entorno (no aplica
  // la regla de visibilidad del badge): es info de soporte.
  it("prod con sha → 'sha · prod' (visible aunque sea prod)", () => {
    expect(versionLine({ env: "prod", sha: "f00ba7a" })).toBe("f00ba7a · prod");
  });

  it("staging con sha → 'sha · staging'", () => {
    expect(versionLine({ env: "staging", sha: "abc1234" })).toBe("abc1234 · staging");
  });

  it("dev con sha → 'sha · dev'", () => {
    expect(versionLine({ env: "dev", sha: "deadbee" })).toBe("deadbee · dev");
  });

  it("sin sha → sólo el entorno", () => {
    expect(versionLine({ env: "prod", sha: null })).toBe("prod");
  });

  it("info null (endpoint sin resolver / inexistente) → 'no disponible'", () => {
    expect(versionLine(null)).toBe("no disponible");
  });
});
