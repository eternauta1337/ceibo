#!/usr/bin/env node
// dev:setup — prepara dev local de una. Dos pasos:
//   1. seed-dev (store): usuario dev@ceibo.local / "dev" + identidades + allowlist
//   2. wiki dev: si hay GitHub App configurada, la provisiona por GitHub con `repo create`
//      (crea el repo en la org real + seedea Bienvenida.md + registra en el store). Sin App,
//      seed-dev ya dejó una wiki fake solo-store (dev web-only sin notas).
//
// Carga el .env del root (como ./ceibo) para tener GITHUB_*, ANTHROPIC_API_KEY, etc., y
// fuerza CEIBO_ENV=dev. Idempotente: re-correrlo es no-op (el repo ya existe → se tolera).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.CEIBO_ENV = "dev"; // dev:setup SIEMPRE opera sobre dev, pase lo que pase en .env

const run = (args) =>
  execFileSync("pnpm", args, { cwd: root, stdio: "inherit", env: process.env });

// 1. user/auth (store-only)
console.log("→ seed-dev (user/auth)…");
run(["--filter", "@ceibo/store", "seed:dev"]);

// 2. wiki dev por GitHub (solo si la App está configurada)
if (process.env.GITHUB_APP_ID) {
  console.log("\n→ provisionando wiki dev por GitHub (repo create dev personal)…");
  try {
    run(["-s", "cli", "repo", "create", "dev", "personal"]);
  } catch {
    // `repo create` muere si el repo ya existe — en un dev:setup re-corrido es lo esperado.
    console.log("  (la wiki dev ya estaba provisionada — ok)");
  }
} else {
  console.log("\n→ GITHUB_APP_ID no seteado → dev web-only sin notas (wiki fake solo-store).");
  console.log("  Para notas por GitHub: completá las vars GITHUB_* en .env y recorré pnpm dev:setup.");
}

console.log("\n✓ dev:setup listo. Arrancá con: pnpm dev");
