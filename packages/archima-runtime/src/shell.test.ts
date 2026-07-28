// shellcheck (-S error: solo errores duros) sobre los scripts canónicos del control-plane.
// Los `.sh` son hand-written grandes con idioms intencionales que warnean; gateamos en errores,
// no en estilo. Skip si shellcheck no está instalado (CI ubuntu lo trae); gatea en staging+.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const VM = resolve(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "vm");

function hasShellcheck(): boolean {
  try {
    execFileSync("shellcheck", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("shellcheck del control-plane", () => {
  const present = hasShellcheck();
  const scripts = readdirSync(VM).filter((f) => f.endsWith(".sh"));
  it("hay scripts que chequear", () => expect(scripts.length).toBeGreaterThan(0));
  for (const sh of scripts) {
    it.skipIf(!present)(`${sh} pasa shellcheck -S error`, () => {
      expect(() =>
        execFileSync("shellcheck", ["-S", "error", join(VM, sh)], { stdio: "pipe" }),
      ).not.toThrow();
    });
  }
});
