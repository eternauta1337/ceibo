import { describe, expect, it } from "vitest";
import { isSafeRelPath } from "./path-safety.ts";

describe("isSafeRelPath", () => {
  it("acepta paths repo-relativos normales", () => {
    expect(isSafeRelPath("nota.md")).toBe(true);
    expect(isSafeRelPath("carpeta/sub/nota.md")).toBe(true);
  });

  it("rechaza vacío y paths absolutos", () => {
    expect(isSafeRelPath("")).toBe(false);
    expect(isSafeRelPath("/etc/passwd")).toBe(false);
  });

  it("rechaza traversal y segmentos vacíos/punto", () => {
    expect(isSafeRelPath("../x")).toBe(false);
    expect(isSafeRelPath("a/../b")).toBe(false);
    expect(isSafeRelPath("a//b")).toBe(false);
    expect(isSafeRelPath("a/./b")).toBe(false);
  });

  it("rechaza null-byte y backslash (defensa en profundidad)", () => {
    expect(isSafeRelPath(`a${String.fromCharCode(0)}b`)).toBe(false);
    expect(isSafeRelPath("a\\..\\b")).toBe(false);
  });

  it("rechaza CLAUDE.md (convención del repo, no nota del usuario)", () => {
    expect(isSafeRelPath("CLAUDE.md")).toBe(false);
    expect(isSafeRelPath("sub/CLAUDE.md")).toBe(false);
    // pero un nombre que solo lo contiene como prefijo sí pasa
    expect(isSafeRelPath("CLAUDE.md.bak")).toBe(true);
  });
});
