#!/usr/bin/env tsx
// Seed mínimo para dev local (CEIBO_ENV=dev).
//
// Crea en ceibo.dev.db:
//   · Usuario "dev" con contraseña "dev" (backend_mode=ma, sin Telegram/WhatsApp)
//   · Identidad "email" → dev@ceibo.local (permite login por email+password en la web)
//   · Wiki "dev-personal" registrada en el store (repo local, sin tocar GitHub)
//
// Idempotente: re-correrlo sobre una DB ya seedeada es no-op silencioso.
//
// Uso:
//   CEIBO_ENV=dev tsx packages/store/scripts/seed-dev.ts
//   (o desde el root: pnpm --filter @ceibo/store exec tsx scripts/seed-dev.ts con el .env.dev cargado)

import {
  addAuthorizedEmail,
  addChannel,
  addRepo,
  addUser,
  ceiboEnv,
  defaultDbPath,
  getRepoByName,
  getUserByHandle,
  grantAccess,
  openDb,
  resolveUser,
  setUserPassword,
} from "../src/index.ts";

const env = ceiboEnv();
if (env !== "dev") {
  console.error(`seed-dev: CEIBO_ENV=${env} — este script solo corre con CEIBO_ENV=dev`);
  process.exit(1);
}

const dbPath = defaultDbPath();
console.log(`seed-dev: seedeando ${dbPath} ...`);

const db = openDb(dbPath);

const DEV_HANDLE = "dev";
const DEV_EMAIL = "dev@ceibo.local";
const DEV_PASSWORD = "dev"; // contraseña trivial, solo en la DB local dev
// Org GitHub real de las wikis (la misma que usa `repo create` vía wikisFromEnv). Si no hay
// `.env` cargado cae a "ceibofamily" como placeholder, pero entonces tampoco hay GitHub App
// (ver más abajo): la wiki fake queda solo-store.
const DEV_ORG = process.env.GITHUB_WIKIS_ORG ?? "ceibofamily";
const DEV_WIKI_NAME = "dev-personal";

// --- Usuario ---
let user = getUserByHandle(db, DEV_HANDLE);
if (!user) {
  user = addUser(db, DEV_HANDLE, { name: "Dev (local)" });
  console.log(`  usuario creado: ${user.handle} (id=${user.id})`);
} else {
  console.log(`  usuario ya existe: ${user.handle} (id=${user.id})`);
}

// --- Identidad web (canal remoto) ---
// Registrar como usuario "web" para que el web-server pueda resolverlo por handle.
if (!resolveUser(db, "web", DEV_HANDLE)) {
  addChannel(db, user.id, "web", DEV_HANDLE);
  console.log(`  canal web → ${DEV_HANDLE}`);
}

// --- Email en allowlist ---
addAuthorizedEmail(db, DEV_EMAIL, {
  name: "Dev (local)",
  handle: DEV_HANDLE,
  note: "cuenta de dev local — generada por seed-dev",
});

// --- Identidad email (para login por email+password en la web) ---
if (!resolveUser(db, "email", DEV_EMAIL)) {
  addChannel(db, user.id, "email", DEV_EMAIL);
  console.log(`  canal email → ${DEV_EMAIL}`);
}

// --- Contraseña de login web ---
setUserPassword(db, user.id, DEV_PASSWORD);
console.log(`  contraseña web seteada (plaintext: "${DEV_PASSWORD}" — solo para dev local)`);

// --- Wiki personal ---
// `store` es hoja (no depende de `wikis`), así que este script NO puede crear el repo de
// GitHub. La provisión real (GitHub + store, con la org correcta) la hace `repo create` desde
// la capa de orquestación: `pnpm dev:setup` lo invoca cuando hay GitHub App configurada.
// Acá solo registramos una wiki fake SOLO-STORE como fallback para dev web-only SIN GitHub App
// (sin notas reales). Si hay App, no la pre-creamos: dejaríamos un row que haría morir a
// `repo create` ("ya existe") y nunca tendría backing en GitHub.
if (process.env.GITHUB_APP_ID) {
  console.log(`  GitHub App detectada → la wiki la provisiona \`repo create\` (pnpm dev:setup)`);
} else {
  let repo = getRepoByName(db, DEV_ORG, DEV_WIKI_NAME);
  if (!repo) {
    repo = addRepo(db, DEV_ORG, DEV_WIKI_NAME, "personal");
    console.log(`  wiki fake registrada (solo store, sin GitHub): ${DEV_ORG}/${DEV_WIKI_NAME}`);
  } else {
    console.log(`  wiki fake ya existe: ${DEV_ORG}/${DEV_WIKI_NAME}`);
  }
  grantAccess(db, repo.id, user.id, "owner");
  db.prepare("UPDATE repos SET personal = 1 WHERE id = ?").run(repo.id);
}

db.close();

console.log(`
seed-dev: listo (user/auth).

  Normalmente no corras este script directo: \`pnpm dev:setup\` lo invoca y además
  provisiona la wiki por GitHub (\`repo create dev personal\`) si hay GitHub App.
  Después: \`pnpm dev\` (gateway+web-server+web) y login en http://localhost:5173
  con email "${DEV_EMAIL}" y contraseña "${DEV_PASSWORD}". Guía completa: dev.md.
`);
