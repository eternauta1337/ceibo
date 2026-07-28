// wiki-sync — sincroniza la working copy local del sandbox del agente con el substrato de
// wikis, por HTTPS (Fase 2b, plan substrato-wikis-working-copy.md). Reemplaza git nativo
// (que cuelga en el sandbox). Es un SCRIPT (no binario): corre con el node que ya está
// (`node /mnt/session/uploads/wiki-sync.mjs ...`, donde MA monta los File resources), sin
// shebang. El gateway le inyecta WIKI_SYNC_URL al subirlo.
//
// SEGURIDAD: el token de auth (identidad firmada, NO el de GitHub) se lee de un ARCHIVO
// montado (WIKI_SYNC_TOKEN_FILE) — nunca de un arg ni del entorno del modelo. El endpoint
// (WIKI_SYNC_URL) custodia la GitHub App key del lado server.
//
// Uso:
//   node wiki-sync.mjs hydrate <repo>            # foto completa → /workspace/<repo>
//   node wiki-sync.mjs pull    <repo>            # trae el delta desde el último ref
//   node wiki-sync.mjs push    <repo> <mensaje>  # commitea el diff local (conflicto por-path)
//   node wiki-sync.mjs recall  <repo> <path>     # recupera una nota archivada (borrada) del historial
//   node wiki-sync.mjs search-archived <repo> <término>  # busca en el CONTENIDO de lo archivado
//
// Env: WIKI_SYNC_URL (base, ej. https://host/api/sync), WIKI_SYNC_TOKEN_FILE (path al token),
//      WIKI_SYNC_WORKSPACE (default /workspace), WIKI_SYNC_STATE (default /tmp/wiki-sync).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const BASE = (process.env.WIKI_SYNC_URL ?? "").replace(/\/+$/, "");
const TOKEN_FILE = process.env.WIKI_SYNC_TOKEN_FILE ?? "/mnt/session/uploads/wiki-token";
const WORKSPACE = process.env.WIKI_SYNC_WORKSPACE ?? "/workspace";
const STATE_DIR = process.env.WIKI_SYNC_STATE ?? "/tmp/wiki-sync";

const die = (msg) => {
  console.error(`wiki-sync: ${msg}`);
  process.exit(1);
};
if (!BASE) die("falta WIKI_SYNC_URL");

const token = (() => {
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return die(`no pude leer el token (${TOKEN_FILE})`);
  }
})();

const repoDir = (repo) => join(WORKSPACE, repo);
const statePath = (repo) => join(STATE_DIR, `${repo}.json`);

/** SHA del blob git de un contenido (sha1 de "blob <len>\0<bytes>") — mismo que devuelve
 *  el substrato, para poder diffear sin re-bajar. */
function blobSha(content) {
  const buf = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) die(`${method} ${path} → HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

const loadState = (repo) => {
  try {
    return JSON.parse(readFileSync(statePath(repo), "utf8"));
  } catch {
    return undefined;
  }
};
const saveState = (repo, state) => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(repo), JSON.stringify(state));
};

async function writeFileAt(repo, path, content) {
  const full = join(repoDir(repo), path);
  mkdirSync(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

/** Lista los paths (relativos) de archivos del working dir, ignorando .git y el manifest. */
async function listLocal(repo) {
  const root = repoDir(repo);
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push(relative(root, full));
    }
  }
  await walk(root);
  return out;
}

// recall — recupera una nota ARCHIVADA (borrada) desde la historia: el server busca su
// última versión viva y la devuelve; la escribimos en la working copy SIN tocar el state,
// para que el próximo `push` la re-agregue como nota nueva (vuelve a estar viva). Después
// sacá su línea del `_archivado.md` de la carpeta y hacé un push.
async function recall(repo, path) {
  if (!path) die("recall necesita el path de la nota archivada");
  const file = await api("GET", `/recall?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`);
  await writeFileAt(repo, file.path, file.content); // sin actualizar state.shas → push lo ve como put
  console.log(`recall ${repo}: ${file.path} recuperado a /workspace — sacá su línea de _archivado.md y push`);
}

// search-archived — busca un término DENTRO del contenido de las notas archivadas (las que
// están en los `_archivado.md`), que NO están en la working copy: el server las lee desde la
// historia y matchea. Para buscar por título/preview alcanza con grepear los `_archivado.md`
// locales — esto es para cuando el término está en el cuerpo de una nota archivada.
async function searchArchived(repo, query) {
  if (!query) die("search-archived necesita un término de búsqueda");
  const r = await api(
    "GET",
    `/search-archived?repo=${encodeURIComponent(repo)}&q=${encodeURIComponent(query)}`,
  );
  if (r.matches.length === 0) {
    console.log(`search-archived ${repo}: sin coincidencias en lo archivado (${r.scanned} notas)`);
  } else {
    for (const m of r.matches) console.log(`${m.path}\t${m.title}\t${m.line}`);
    console.log(
      `— ${r.matches.length} coincidencia(s) en ${r.scanned} notas archivadas${r.truncated ? " (TRUNCADO: hay más del tope)" : ""}; recuperá una con: recall ${repo} <path>`,
    );
  }
}

async function hydrate(repo) {
  const snap = await api("GET", `/read?repo=${encodeURIComponent(repo)}`);
  // Working dir limpio: arranca de cero con la foto del substrato.
  rmSync(repoDir(repo), { recursive: true, force: true });
  const shas = {};
  for (const f of snap.files) {
    await writeFileAt(repo, f.path, f.content);
    shas[f.path] = f.sha;
  }
  saveState(repo, { ref: snap.ref, shas });
  console.log(`hydrate ${repo}: ${snap.files.length} archivos @ ${snap.ref.slice(0, 10)}`);
}

async function pull(repo) {
  const state = loadState(repo) ?? die(`sin estado para ${repo}; corré hydrate primero`);
  const delta = await api("GET", `/changes?repo=${encodeURIComponent(repo)}&since=${state.ref}`);
  if (delta.ref === state.ref) {
    console.log(`pull ${repo}: sin cambios @ ${state.ref.slice(0, 10)}`);
    return;
  }
  for (const f of delta.changed) {
    await writeFileAt(repo, f.path, f.content);
    state.shas[f.path] = f.sha;
  }
  for (const p of delta.deleted) {
    rmSync(join(repoDir(repo), p), { force: true });
    delete state.shas[p];
  }
  state.ref = delta.ref;
  saveState(repo, state);
  console.log(`pull ${repo}: +${delta.changed.length} ~${delta.deleted.length} @ ${delta.ref.slice(0, 10)}`);
}

async function push(repo, message) {
  if (!message) die("push necesita un mensaje de commit");
  const state = loadState(repo) ?? die(`sin estado para ${repo}; corré hydrate primero`);
  const local = await listLocal(repo);
  const localSet = new Set(local);
  const changes = [];
  // puts: archivos nuevos o con blob distinto al del base ref. `base` = el blob que ESTE
  // sandbox cree vivo para el path (su última versión conocida, del state). Lo manda al server
  // para optimistic-concurrency por-path: si el HEAD real ya no es ese blob (otro escritor —
  // editor web/REM/otra pestaña — lo tocó), el commit RECHAZA ese path en vez de pisarlo con
  // una versión vieja. `null` para un archivo nuevo (espero que el path no exista en HEAD).
  for (const path of local) {
    const content = await readFile(join(repoDir(repo), path), "utf8");
    if (state.shas[path] !== blobSha(content))
      changes.push({ op: "put", path, content, base: state.shas[path] ?? null });
  }
  // deletes: estaban en el base ref pero ya no están localmente. `base` = el blob que borramos.
  for (const path of Object.keys(state.shas)) {
    if (!localSet.has(path)) changes.push({ op: "delete", path, base: state.shas[path] });
  }
  if (changes.length === 0) {
    console.log(`push ${repo}: nada que commitear`);
    return;
  }
  const result = await api("POST", "/commit", { repo, baseRef: state.ref, changes, message });
  if (!result.ok) {
    console.error(`push ${repo}: CONFLICTO en ${result.conflictPaths.join(", ")} — corré pull y reintentá`);
    process.exit(2);
  }
  // Actualiza el estado al nuevo ref (aplica los cambios al mapa de shas).
  for (const c of changes) {
    if (c.op === "delete") delete state.shas[c.path];
    else state.shas[c.path] = blobSha(c.content);
  }
  state.ref = result.ref;
  saveState(repo, state);
  console.log(`push ${repo}: ${changes.length} cambios → ${result.ref.slice(0, 10)}`);
}

const [cmd, repo, ...rest] = process.argv.slice(2);
if (!repo) die("uso: wiki-sync.mjs <hydrate|pull|push|recall|search-archived> <repo> [mensaje|path|término]");
const run = { hydrate, pull, push, recall, "search-archived": searchArchived }[cmd];
if (!run) die(`comando desconocido: ${cmd}`);
if (existsSync(STATE_DIR) === false) mkdirSync(STATE_DIR, { recursive: true });
await run(repo, rest.join(" "));
