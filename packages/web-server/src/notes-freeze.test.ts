import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeFreezeGate } from "./notes-freeze.ts";
import { isFrozenNoteWrite } from "./web.ts";

describe("freeze del cutover (F3)", () => {
  it("el flag por archivo se lee en vivo (touch/rm sin restart)", () => {
    const dir = mkdtempSync(join(tmpdir(), "freeze-"));
    const flag = join(dir, "notes.freeze");
    const gate = makeFreezeGate(flag);
    expect(gate.frozen()).toBe(false);
    writeFileSync(flag, "");
    expect(gate.frozen()).toBe(true);
    rmSync(flag);
    expect(gate.frozen()).toBe(false);
    expect(existsSync(flag)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it("isFrozenNoteWrite: congela SOLO las vías de escritura de contenido de notas", () => {
    // Escrituras → sí.
    expect(isFrozenNoteWrite("PUT", "/api/file")).toBe(true);
    expect(isFrozenNoteWrite("POST", "/api/file")).toBe(true);
    expect(isFrozenNoteWrite("DELETE", "/api/file")).toBe(true);
    expect(isFrozenNoteWrite("POST", "/api/file/move")).toBe(true);
    expect(isFrozenNoteWrite("POST", "/api/file/archive")).toBe(true);
    expect(isFrozenNoteWrite("POST", "/api/folder/archive")).toBe(true);
    expect(isFrozenNoteWrite("POST", "/api/file/emoji")).toBe(true);
    expect(isFrozenNoteWrite("POST", "/api/sync/commit")).toBe(true);
    expect(isFrozenNoteWrite("POST", "/api/git/demo-personal/git-receive-pack")).toBe(true);

    // Lecturas y estructura → no.
    expect(isFrozenNoteWrite("GET", "/api/file")).toBe(false);
    expect(isFrozenNoteWrite("GET", "/api/explorer")).toBe(false);
    expect(isFrozenNoteWrite("GET", "/api/git/demo-personal/info/refs")).toBe(false);
    expect(isFrozenNoteWrite("POST", "/api/git/demo-personal/git-upload-pack")).toBe(false); // clone/pull
    expect(isFrozenNoteWrite("GET", "/api/sync/read")).toBe(false);
    expect(isFrozenNoteWrite("POST", "/api/wiki")).toBe(false); // crear wiki = estructural, no contenido
    expect(isFrozenNoteWrite("POST", "/api/send")).toBe(false); // chat
  });
});
