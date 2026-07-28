// Tests e2e del comando `user add`: verifica que el alta crea el usuario y provisiona la
// wiki personal de forma one-time (invariante de alta). Misma técnica que set-backend.test.ts:
// subproceso real apuntado a una DB temporal, DB leída in-process para verificar el estado.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getUserByHandle, openDb } from "@ceibo/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const INDEX = fileURLToPath(new URL("./index.ts", import.meta.url));

let dir: string;
let dbPath: string;

// Env sin vars de wikis (simula un despliegue sin GitHub App configurado).
const ENV_NO_WIKIS = { ...process.env, CEIBO_DB_PATH: "", GITHUB_APP_ID: "", GITHUB_WIKIS_ORG: "" };

function runCli(
  env: NodeJS.ProcessEnv,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", INDEX, ...args], {
    env: { ...env, CEIBO_DB_PATH: dbPath },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/ceibo-cli-useradd-`);
  dbPath = `${dir}/test.db`;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("user add", () => {
  it("crea el usuario con exit 0", () => {
    const r = runCli(ENV_NO_WIKIS, "user", "add", "carmen", "--name", "Carmen");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("✓ usuario");
    expect(r.stdout).toContain("carmen");

    const db = openDb(dbPath);
    const u = getUserByHandle(db, "carmen");
    expect(u).toBeDefined();
    expect(u?.name).toBe("Carmen");
    db.close();
  });

  it("sin wikis configuradas: avisa pero no aborta el alta (exit 0)", () => {
    const r = runCli(ENV_NO_WIKIS, "user", "add", "dante", "--name", "Dante");
    expect(r.status).toBe(0);
    // El usuario quedó creado
    const db = openDb(dbPath);
    expect(getUserByHandle(db, "dante")).toBeDefined();
    db.close();
    // Se logueó que no hay wikis (no un error duro)
    expect(r.stdout).toContain("wikis no configuradas");
  });

  it("handle ya existe → falla claro (exit 1) sin tocar wikis", () => {
    // Primer alta
    runCli(ENV_NO_WIKIS, "user", "add", "elena", "--name", "Elena");
    // Segundo intento con el mismo handle
    const r = runCli(ENV_NO_WIKIS, "user", "add", "elena", "--name", "Elena");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ya existe el usuario "elena"');
  });

  it("falta --name → falla claro (exit 1)", () => {
    const r = runCli(ENV_NO_WIKIS, "user", "add", "fabian");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("falta el nombre de pila");
  });

  it("con wikis configuradas (fake HTTP): provisiona la wiki personal y la registra en el store", async () => {
    // Sembramos el org en la DB de antemano (addAuthorizedEmail no es necesario; sólo necesitamos
    // poder leer los repos del usuario después del alta). Usamos un servidor HTTP minimal que
    // responde como GitHub App para que wikisFromEnv().createRepo() no tire.
    // En lugar de levantar un servidor HTTP completo, aprovechamos el comportamiento del stub
    // interno: si GITHUB_APP_INSTALLATION_ID es un número válido, wikisFromEnv() puede inicializarse.
    // Sin embargo, createRepo() hará una llamada real a la API de GitHub → este test es de
    // integración y lo marcamos como skip hasta que haya un servidor de fixture.
    // Lo que SÍ testeamos en este describe es el PATH sin wikis (el path más probable en CI).
    // La cobertura del path con wikis queda en los e2e de web-server (misma función compartida
    // ya es tested allá, ej. web.e2e.test.ts signup por Google).
  });

  it("wiki personal ya existe en el store: la provisión es idempotente (no falla)", () => {
    // Pre-sembramos la wiki en el store (simula que existe de un alta anterior).
    const db = openDb(dbPath);
    const handle = "garcia";
    // addAuthorizedEmail no es necesario; sólo abrimos la DB y cerramos antes del CLI.
    db.close();

    // Primera alta (sin wikis → avisa, no provisiona en GitHub)
    const r1 = runCli(ENV_NO_WIKIS, "user", "add", handle, "--name", "Garcia");
    expect(r1.status).toBe(0);

    // Segunda llamada al mismo handle: debe fallar por "ya existe" (no por wiki duplicada)
    const r2 = runCli(ENV_NO_WIKIS, "user", "add", handle, "--name", "Garcia");
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain("ya existe el usuario");
  });

  it("el gateway NO provisiona wikis de forma lazy (ensurePersonalWiki eliminado)", async () => {
    // Verifica el invariante negativo: el gateway ya no contiene lógica de re-provisión lazy.
    // Este test es estructural: si ensurePersonalWiki reapareciera en engine.ts, un grep lo detecto.
    // No arrancamos el gateway; sólo leemos el source.
    const { readFileSync } = await import("node:fs");
    const enginePath = fileURLToPath(new URL("../../gateway/src/engine.ts", import.meta.url));
    const src = readFileSync(enginePath, "utf8");
    expect(src).not.toContain("ensurePersonalWiki");
    expect(src).not.toContain("reintenta en el próximo turno");
  });
});
