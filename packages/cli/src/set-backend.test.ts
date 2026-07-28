import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { addUser, getSession, getUserBackendMode, getUserByHandle, openDb, setSession } from "@ceibo/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Test e2e del comando `user set-backend`: la lógica vive dentro de main() (corre al
// importar index.ts), así que la ejercemos como subproceso real apuntándolo a una DB
// temporal vía CEIBO_DB_PATH, sembrando/leyendo con el store en proceso.
const INDEX = fileURLToPath(new URL("./index.ts", import.meta.url));

let dir: string;
let dbPath: string;

function runCli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", INDEX, ...args], {
    env: { ...process.env, CEIBO_DB_PATH: dbPath },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/ceibo-cli-`);
  dbPath = `${dir}/test.db`;
  const db = openDb(dbPath);
  addUser(db, "bob", { name: "Bob" });
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("user set-backend", () => {
  it("flipea a 'local' y vuelve a 'ma' (persiste en la DB)", () => {
    const toLocal = runCli("user", "set-backend", "bob", "local");
    expect(toLocal.status).toBe(0);
    expect(toLocal.stdout).toContain('✓ bob → backend "local"');

    let db = openDb(dbPath);
    const u = getUserByHandle(db, "bob");
    expect(u && getUserBackendMode(db, u.id)).toBe("local");
    db.close();

    const toMa = runCli("user", "set-backend", "bob", "ma");
    expect(toMa.status).toBe(0);
    expect(toMa.stdout).toContain('✓ bob → backend "ma"');

    db = openDb(dbPath);
    expect(getUserBackendMode(db, getUserByHandle(db, "bob")!.id)).toBe("ma");
    db.close();
  });

  it("resetea la sesión guardada al flipear de backend (no reusa un session_id ajeno)", () => {
    // Sembramos un session_id (como el que dejaría el backend MA): tras `set-backend` debe BORRARSE,
    // así el backend nuevo no lo trata como handle propio (el local lo tomaría por nombre de VM).
    let db = openDb(dbPath);
    const u = getUserByHandle(db, "bob")!;
    setSession(db, u.id, "sesn_01McyCC4poisoned");
    expect(getSession(db, u.id)?.session_id).toBe("sesn_01McyCC4poisoned");
    db.close();

    const r = runCli("user", "set-backend", "bob", "local");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("sesión reseteada");

    db = openDb(dbPath);
    expect(getSession(db, u.id)).toBeUndefined(); // la fila se borró
    db.close();
  });

  it("rechaza un valor que no sea ma|local (sale 1, no toca la DB)", () => {
    const r = runCli("user", "set-backend", "bob", "bogus");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("uso: user set-backend <handle> <ma|local>");

    const db = openDb(dbPath);
    expect(getUserBackendMode(db, getUserByHandle(db, "bob")!.id)).toBe("ma"); // intacto (default)
    db.close();
  });

  it("falla claro si el handle no existe", () => {
    const r = runCli("user", "set-backend", "nadie", "local");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no existe el usuario "nadie"');
  });
});
