// Tests e2e de los comandos P2: `waitlist *` y `user admin`.
// Usa la misma técnica de set-backend.test.ts: subproceso real apuntado a
// una DB temporal; sin Resend real (RESEND_API_KEY vacío → best-effort).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  addInvite,
  addRepo,
  addToWaitingList,
  addUser,
  getAuthorizedEmail,
  getWaitingEntry,
  grantAccess,
  isAdmin,
  openDb,
} from "@ceibo/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const INDEX = fileURLToPath(new URL("./index.ts", import.meta.url));

let dir: string;
let dbPath: string;

// Sin RESEND_API_KEY → mail best-effort (sólo logueado, no falla).
const ENV_NO_MAIL = { ...process.env, CEIBO_DB_PATH: "", RESEND_API_KEY: "" };

function runCli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", INDEX, ...args], {
    env: { ...ENV_NO_MAIL, CEIBO_DB_PATH: dbPath },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/ceibo-cli-waitlist-`);
  dbPath = `${dir}/test.db`;
  // Sembramos un usuario activo que actúa como el admin en los tests.
  const db = openDb(dbPath);
  addUser(db, "admin", { name: "Admin" });
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// waitlist list
// ---------------------------------------------------------------------------

describe("waitlist list", () => {
  it("lista vacía → mensaje claro", () => {
    const r = runCli("waitlist", "list");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("vacía");
  });

  it("muestra source: invited con el handle del invitador", () => {
    const db = openDb(dbPath);
    const admin = db.prepare("SELECT * FROM users WHERE handle = 'admin'").get() as {
      id: number;
    };
    const repo = addRepo(db, "ceibofamily", "admin-personal", "personal");
    grantAccess(db, repo.id, admin.id, "owner");
    addInvite(db, repo.id, "nueva@example.com", admin.id);
    addToWaitingList(db, "nueva@example.com", { source: "invited", invitedBy: admin.id });
    db.close();

    const r = runCli("waitlist", "list");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nueva@example.com");
    expect(r.stdout).toContain("invitado por @admin");
    expect(r.stdout).toContain("pending");
  });

  it("muestra source: self-signup", () => {
    const db = openDb(dbPath);
    addToWaitingList(db, "spontaneo@example.com", { source: "self-signup" });
    db.close();

    const r = runCli("waitlist", "list");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("spontaneo@example.com");
    expect(r.stdout).toContain("self-signup");
  });

  it("--status pending filtra correctamente", () => {
    const db = openDb(dbPath);
    addToWaitingList(db, "pendiente@example.com", { source: "self-signup" });
    db.close();

    const r = runCli("waitlist", "list", "--status", "pending");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("pendiente@example.com");
  });

  it("--status inválido → exit 1", () => {
    const r = runCli("waitlist", "list", "--status", "bogus");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("inválido");
  });
});

// ---------------------------------------------------------------------------
// waitlist approve
// ---------------------------------------------------------------------------

describe("waitlist approve", () => {
  it("happy path: aprueba → authorized_emails + exit 0; sin RESEND_API_KEY avisa de mail", () => {
    const db = openDb(dbPath);
    addToWaitingList(db, "aprob@example.com", { source: "self-signup" });
    db.close();

    const r = runCli("waitlist", "approve", "aprob@example.com");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("aprobado");

    const db2 = openDb(dbPath);
    const entry = getAuthorizedEmail(db2, "aprob@example.com");
    expect(entry).toBeDefined();
    const wl = getWaitingEntry(db2, "aprob@example.com");
    expect(wl?.status).toBe("approved");
    db2.close();
  });

  it("avisa de mail no enviado cuando falta RESEND_API_KEY", () => {
    const db = openDb(dbPath);
    addToWaitingList(db, "sin-mail@example.com", { source: "self-signup" });
    db.close();

    const r = runCli("waitlist", "approve", "sin-mail@example.com");
    expect(r.status).toBe(0);
    // Sin key → aviso explícito (no error)
    expect(r.stdout).toContain("RESEND_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// waitlist reject
// ---------------------------------------------------------------------------

describe("waitlist reject", () => {
  it("rechaza → status=rejected, sin tocar authorized_emails", () => {
    const db = openDb(dbPath);
    addToWaitingList(db, "rechazo@example.com", { source: "self-signup" });
    db.close();

    const r = runCli("waitlist", "reject", "rechazo@example.com");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("rechazado");

    const db2 = openDb(dbPath);
    expect(getWaitingEntry(db2, "rechazo@example.com")?.status).toBe("rejected");
    expect(getAuthorizedEmail(db2, "rechazo@example.com")).toBeUndefined();
    db2.close();
  });
});

// ---------------------------------------------------------------------------
// user admin
// ---------------------------------------------------------------------------

describe("user admin", () => {
  it("setea admin=1 y lo quita con --off", () => {
    // Primero sin flag → true
    const on = runCli("user", "admin", "admin");
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("es admin ahora");

    const db = openDb(dbPath);
    const u = db.prepare("SELECT * FROM users WHERE handle = 'admin'").get() as { id: number };
    expect(isAdmin(db, u.id)).toBe(true);
    db.close();

    // Luego --off → false
    const off = runCli("user", "admin", "admin", "--off");
    expect(off.status).toBe(0);
    expect(off.stdout).toContain("ya no es admin");

    const db2 = openDb(dbPath);
    const u2 = db2.prepare("SELECT * FROM users WHERE handle = 'admin'").get() as { id: number };
    expect(isAdmin(db2, u2.id)).toBe(false);
    db2.close();
  });

  it("handle inexistente → exit 1", () => {
    const r = runCli("user", "admin", "nadie");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no existe");
  });
});
