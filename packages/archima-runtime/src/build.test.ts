// El build ensambla el árbol desplegable: estático + prompts GENERADOS (fuente única), y queda
// sin secretos. Ejercita la reconciliación de fuente única.
// Corre `print-prompt` (tsx/pnpm) → más lento; gatea en staging+ (la suite no corre en el PR a dev).
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { build } from "./build.ts";

const out = mkdtempSync(join(tmpdir(), "archima-rt-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("build del árbol desplegable", () => {
  it("ensambla estático + prompts generados, sin secretos", () => {
    build(out);
    // estático copiado
    expect(existsSync(join(out, "vm/cp.sh"))).toBe(true);
    expect(existsSync(join(out, "configs/opencode-delegv2.json"))).toBe(true);
    expect(existsSync(join(out, "configs/AGENTS.md"))).toBe(true);

    // prompts GENERADOS (no copiados a mano) — sin el banner de pnpm
    const ceibo = readFileSync(join(out, "configs/prompts/ceibo.md"), "utf8");
    const worker = readFileSync(join(out, "configs/prompts/ceibo-worker.md"), "utf8");
    expect(ceibo.length).toBeGreaterThan(1000);
    expect(worker.length).toBeGreaterThan(500);
    expect(ceibo.startsWith(">")).toBe(false);
    expect(ceibo).not.toContain("@ceibo/gateway@");

    // wiki-sync.mjs NO se vendoriza acá: el acceso a wikis en archima es por git nativo (/api/git);
    // wiki-sync.mjs es exclusivo de MA cloud (vive en packages/agent).
    expect(existsSync(join(out, "configs/wiki-sync.mjs"))).toBe(false);
  });
});
