// @ceibo/wikis — el substrato de wikis de los usuarios.
//
// Una wiki = un repo git. Hoy el backend es un **GitHub App**: crea repos
// on-demand en la org y mintea **tokens efímeros scoped a repos puntuales**
// (aislamiento por auth, no por confianza en el gateway). Es la única pieza
// atada a GitHub → el día que se ejecte a otro host, se reemplaza el backend
// de acá adentro y el resto del sistema no se entera.

import { readFileSync } from "node:fs";
import { App } from "@octokit/app";
import {
  type Change,
  type CommitResult,
  conflictingChanges,
  type WikiDelta,
  type WikiSnapshot,
  type WikiTree,
} from "./substrate.ts";

// Re-export del contrato git-shaped (Fase 1) para los consumidores de @ceibo/wikis.
export type { Change, CommitResult, WikiDelta, WikiSnapshot, WikiTree } from "./substrate.ts";

// Sidecar de emojis por-nota (estilo Notion): mapa path→emoji en `.ceibo/emojis.json`.
import {
  applyEmoji,
  EMOJIS_PATH,
  type EmojiMap,
  isCeiboMeta,
  parseEmojis,
  serializeEmojis,
} from "./emojis.ts";

export {
  applyEmoji,
  CEIBO_DIR_PREFIX,
  EMOJIS_PATH,
  type EmojiMap,
  isCeiboMeta,
  parseEmojis,
  serializeEmojis,
} from "./emojis.ts";
// Nota de bienvenida (Bienvenida.md): contenido + predicado "el README está pelado" + seed
// (conversión README→Bienvenida en creación, reusado por el backfill).
export {
  isBareReadme,
  README_PATH,
  seedWelcomeNote,
  WELCOME_MARKDOWN,
  WELCOME_PATH,
} from "./welcome.ts";

export interface WikisConfig {
  appId: string | number;
  privateKey: string; // contenido del PEM
  org: string;
  installationId?: number; // si falta, se resuelve por la org
}

export interface ScopedToken {
  token: string;
  expiresAt: string;
}

/** Identidad git del autor humano de un commit. El committer sigue siendo el bot del GitHub App.
 *  Formato canónico del email: `<handle>@users.example.com`. */
export interface GitAuthor {
  name: string;
  email: string;
}

/** Construye el `GitAuthor` canónico para un usuario de ceibo.
 *  `name` = display name del usuario si lo tiene, o el handle como fallback.
 *  `email` = `<handle>@users.example.com` (estable aunque cambie el display name). */
export function gitAuthorFor(handle: string, name?: string | null): GitAuthor {
  return { name: name ?? handle, email: `${handle}@users.example.com` };
}

export interface CreatedRepo {
  fullName: string; // org/name
  htmlUrl: string;
  cloneUrl: string;
}

// Convención de nombre de repo para una wiki de usuario (Fase 16): `<handle>-<label>`.
// El handle del dueño va de prefijo; el label es el nombre humano (lo que el dueño ve, ver
// wikiDisplayName en @ceibo/store). Sólo letras/dígitos/guion en el label.
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** Valida un label de wiki (minúsculas, dígitos y guiones). Throws si no cumple. */
export function assertValidLabel(label: string): void {
  if (!LABEL_RE.test(label)) {
    throw new Error(`label inválido "${label}" (usá minúsculas, dígitos y guiones, ej. personal)`);
  }
}

/** Nombre de repo para la wiki de un usuario: `<handle>-<label>` (Fase 16). */
export function userRepoName(handle: string, label: string): string {
  assertValidLabel(label);
  return `${handle}-${label}`;
}

export interface Wikis {
  readonly org: string;
  /** Installation id del App sobre la org (cacheado). */
  installationId(): Promise<number>;
  /** Crea un repo privado en la org (con commit inicial). Idempotente-ish: 422 si ya existe. */
  createRepo(name: string): Promise<CreatedRepo>;
  /** Renombra un repo en la org. GitHub deja un redirect del nombre viejo (Fase 16). */
  renameRepo(oldName: string, newName: string): Promise<CreatedRepo>;
  /** Token efímero (1h) acotado a esos repos, con contents R/W. Lo que se monta en la sesión. */
  mintToken(repoNames: string[]): Promise<ScopedToken>;
  /** Repos visibles para la instalación (debug/health). */
  listRepos(): Promise<string[]>;
  /** SHA del HEAD del branch default del repo (watermark de REM, Fase 16). */
  headSha(repoName: string): Promise<string>;
  /** Lee un archivo del branch default. `sha` = blob sha (para escritura optimista, Fase C).
   *  managed-ui Fase B: la vista web muestra lo que el agente abre. */
  getFile(repoName: string, path: string): Promise<WikiFile>;
  /** Escribe un archivo (commit directo al branch default). `baseSha` = blob sha que se
   *  está reemplazando → 409 (WikiConflictError) si cambió. managed-ui Fase C: editor web. */
  putFile(
    repoName: string,
    path: string,
    content: string,
    baseSha: string,
    message: string,
    author?: GitAuthor,
  ): Promise<{ sha: string; path: string }>;
  /** Crea un archivo nuevo. SIN baseSha — falla con 422 si ya existe (no sobreescribe).
   *  managed-ui: botón `+` del explorer. */
  createFile(
    repoName: string,
    path: string,
    content: string,
    message: string,
    author?: GitAuthor,
  ): Promise<{ sha: string; path: string }>;
  /** Borra un archivo. `baseSha` = blob sha que se está borrando → 409 si cambió
   *  (alguien escribió en el medio). managed-ui: click derecho → borrar. */
  deleteFile(
    repoName: string,
    path: string,
    baseSha: string,
    message: string,
    author?: GitAuthor,
  ): Promise<void>;
  /** Mueve un archivo (crea destino + borra origen). `baseSha` del origen para
   *  detectar concurrent writes (no sobreescribe destino si existe). managed-ui:
   *  drag&drop del explorer.
   *
   *  `opts.newContent` (opcional): si viene, se escribe ese contenido en el destino
   *  en lugar del contenido del origen — usado por el rename del explorer para
   *  reemplazar el H1 dentro de la nota en el mismo commit que el cambio de nombre,
   *  sin generar un commit extra. */
  moveFile(
    repoName: string,
    fromPath: string,
    toPath: string,
    baseSha: string,
    message: string,
    opts?: { newContent?: string; author?: GitAuthor },
  ): Promise<{ sha: string; path: string }>;
  /** Lista los paths de archivos (blobs) del branch default, recursivo. managed-ui:
   *  el explorador de archivos. Excluye `.ceibo/` (metadatos de ceibo, no notas). */
  listFiles(repoName: string): Promise<string[]>;
  /** Lee el sidecar de emojis por-nota (`.ceibo/emojis.json`) como mapa `path → emoji`.
   *  Devuelve `{}` si el sidecar no existe o está corrupto (nunca tira). managed-ui: el
   *  explorer pinta el emoji al lado de cada nota. */
  readEmojis(repoName: string): Promise<EmojiMap>;
  /** Asigna (o limpia, si `emoji` viene vacío) el emoji de una nota: lee el sidecar, lo
   *  mergea y lo commitea con el mismo write-path de las notas (versiona con la wiki).
   *  Devuelve el mapa resultante. managed-ui: el picker de emoji del explorer. */
  setEmoji(repoName: string, path: string, emoji: string, author?: GitAuthor): Promise<EmojiMap>;
  /** Recupera del historial la última versión de un archivo BORRADO (archivado): busca el
   *  commit que lo borró y lee el blob de su commit padre. Throw si el path sigue vivo en
   *  HEAD (no está archivado) o no tiene historia previa. NO commitea — devuelve el contenido
   *  para que el cliente lo re-agregue por el push normal. (Archivado-por-historia.) */
  recall(repoName: string, path: string): Promise<WikiFile>;
  /** Busca un término DENTRO del contenido de las notas archivadas (las listadas en los
   *  manifests de archivado del repo): lee cada una desde la historia y matchea case-insensitive.
   *  NO incluye lo descartado (borrado sin anotar en un manifest). Acotado por un cap; si se
   *  supera, `truncated` lo indica. Para títulos/previews alcanza con grepear los manifests. */
  searchArchived(repoName: string, query: string): Promise<ArchivedSearchResult>;
  /** Blame por línea de un archivo al HEAD del branch default: quién escribió cada rango de
   *  líneas (autor git del commit que las introdujo). Va por la **GraphQL API** de GitHub
   *  (`Commit.blame` — la REST no expone blame). `ref` = commit sha del HEAD blameado (clave
   *  de cache del caller). Path inexistente → GitHub responde error y esto tira (el caller
   *  lo trata como not-found). */
  blame(repoName: string, path: string): Promise<WikiBlame>;

  // ── Contrato git-shaped del substrato (Fase 1, plan substrato-wikis-working-copy.md) ──
  // Los clientes (agente, web) trabajan sobre una working copy local y sincronizan con
  // estas ops, en vez de micro-commits por archivo. Aún sin consumidores.

  /** Foto del repo a un `ref` (default HEAD del branch default): los archivos —o el
   *  subconjunto `paths`— con contenido y blob sha. Hidratación de la working copy. */
  read(repoName: string, ref?: string, paths?: string[]): Promise<WikiSnapshot>;
  /** Árbol del repo a un `ref` (default HEAD): sólo los paths de blobs + el ref. */
  tree(repoName: string, ref?: string): Promise<WikiTree>;
  /** Delta entre `baseRef` y HEAD: archivos cambiados (con contenido) y borrados. Pull
   *  incremental de la working copy. Si `baseRef` ya NO existe en la historia del repo
   *  (history rewrite / force-push), tira `WikiBaseGoneError` — el caller debe degradar
   *  (re-anclar su cursor), NUNCA inventar un diff. */
  changesSince(repoName: string, baseRef: string): Promise<WikiDelta>;
  /** Diff name-status entre dos refs (`base...head`), SIN contenido — para guardrails del
   *  gateway (tope de borrado de REM): qué paths se agregaron/borraron/renombraron/modificaron,
   *  con el blob sha de added/removed (detecta moves que git no reportó como rename: el blob
   *  borrado reaparece agregado en otro path) + los commits del rango (para citar qué se
   *  revierte). Los renamed NO aparecen en `removed`. */
  diffFiles(repoName: string, baseRef: string, headRef: string): Promise<WikiDiffFiles>;
  /** Revierte el branch default al ÁRBOL de `toRef` con UN commit nuevo sobre HEAD (commit de
   *  revert, sin force: la historia revertida queda intacta y recuperable). Si `expectedHead`
   *  viene y el HEAD real ya avanzó (otro escritor pushó en el medio), aborta con
   *  WikiConflictError en vez de pisar trabajo ajeno. Guardrail de REM. */
  revertTo(
    repoName: string,
    toRef: string,
    message: string,
    expectedHead?: string,
    author?: GitAuthor,
  ): Promise<{ ref: string }>;
  /** Aplica un changeset como UN commit sobre `baseRef`. Conflicto POR-PATH (Decisión 1-A):
   *  los paths que otro escritor tocó entre `baseRef` y HEAD vuelven en `conflictPaths`
   *  (el cliente re-baja esos y reintenta); el resto se auto-mergea. Push de la working copy. */
  commit(
    repoName: string,
    baseRef: string,
    changes: Change[],
    message: string,
    author?: GitAuthor,
  ): Promise<CommitResult>;
}

export interface WikiFile {
  content: string;
  sha: string;
  path: string;
}

/** Resultado de `diffFiles` (name-status entre dos refs). El `sha` de added/removed es el blob
 *  sha (en removed: el del blob que existía antes del borrado) — la clave para distinguir un
 *  borrado real de un move sin rename-detection. */
export interface WikiDiffFiles {
  added: { path: string; sha: string }[];
  removed: { path: string; sha: string }[];
  renamed: { from: string; to: string }[];
  modified: string[];
  commits: { sha: string; message: string }[];
}

/** Un rango contiguo de líneas (1-based, inclusive) atribuido a un commit/autor por blame. */
export interface BlameRange {
  startLine: number;
  endLine: number;
  /** Email del AUTOR git del commit. Escrituras de ceibo (desde #296): `<handle>@users.example.com`.
   *  Historia previa: el bot del GitHub App. */
  authorEmail: string;
  authorName: string;
  sha: string;
  /** committedDate del commit (ISO 8601). */
  date: string;
}

/** Resultado de `blame`: el commit blameado (HEAD del branch default) + los rangos por autor. */
export interface WikiBlame {
  ref: string;
  ranges: BlameRange[];
}

// Forma de la respuesta del query GraphQL de blame (sólo lo que proyectamos).
interface BlameQueryData {
  repository: {
    defaultBranchRef: {
      target: {
        oid: string;
        blame: {
          ranges: {
            startingLine: number;
            endingLine: number;
            commit: {
              oid: string;
              committedDate: string;
              author: { name: string | null; email: string | null } | null;
            };
          }[];
        };
      } | null;
    } | null;
  } | null;
}

const BLAME_QUERY = `
  query ($owner: String!, $repo: String!, $path: String!) {
    repository(owner: $owner, name: $repo) {
      defaultBranchRef {
        target {
          ... on Commit {
            oid
            blame(path: $path) {
              ranges {
                startingLine
                endingLine
                commit {
                  oid
                  committedDate
                  author { name email }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/** Nombre del índice de notas archivadas que mantiene el agente en cada carpeta (oculto en
 *  la web — es un dotfile). Es el registro de qué se archivó: searchArchived enumera desde
 *  acá (no escanea toda la historia). Convención `.archived.md` (dotfile, lo oculta la regla
 *  de `.` del explorer). El nombre VIEJO `_archivado.md` se sigue RECONOCIENDO en lectura
 *  (ver `isArchiveManifest`) durante la transición, hasta correr la migración de data
 *  (`ceibo repo migrate-archive`). El soporte legacy se saca en la próxima release. */
export const ARCHIVE_MANIFEST = ".archived.md";
/** Nombre LEGACY del manifest de archivado (pre-convención-dotfile). Sólo lectura/detección. */
export const ARCHIVE_MANIFEST_LEGACY = "_archivado.md";
/** ¿Es `name` un manifest de archivado (nuevo `.archived.md` o legacy `_archivado.md`)? Lo usan
 *  searchArchived y el archivado por carpeta para reconocer ambos durante la transición. */
export function isArchiveManifest(name: string): boolean {
  return name === ARCHIVE_MANIFEST || name === ARCHIVE_MANIFEST_LEGACY;
}
/** Tope de notas archivadas que searchArchived inspecciona en una corrida (cada una = lectura
 *  desde la historia). Si se supera, el resultado viene `truncated`. */
export const ARCHIVE_SEARCH_CAP = 200;

export interface ArchivedMatch {
  /** Path repo-relativo de la nota archivada (para recuperarla con `recall`). */
  path: string;
  /** Título legible (primer H1, o el nombre de archivo sin `.md`). */
  title: string;
  /** Primera línea que matchea el término (trim), para mostrarle al usuario el contexto. */
  line: string;
}
export interface ArchivedSearchResult {
  matches: ArchivedMatch[];
  /** Cuántas notas archivadas se inspeccionaron (≤ ARCHIVE_SEARCH_CAP). */
  scanned: number;
  /** true si había más notas archivadas que el cap (la búsqueda no fue exhaustiva). */
  truncated: boolean;
}

function reqEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`falta ${k} en el entorno`);
  return v;
}

/** Construye Wikis desde el entorno (GITHUB_APP_ID, GITHUB_WIKIS_ORG, GITHUB_APP_PRIVATE_KEY_PATH). */
export function wikisFromEnv(): Wikis {
  return createWikis({
    appId: reqEnv("GITHUB_APP_ID"),
    org: reqEnv("GITHUB_WIKIS_ORG"),
    privateKey: readFileSync(reqEnv("GITHUB_APP_PRIVATE_KEY_PATH"), "utf8"),
    installationId: process.env.GITHUB_APP_INSTALLATION_ID
      ? Number(process.env.GITHUB_APP_INSTALLATION_ID)
      : undefined,
  });
}

export function createWikis(cfg: WikisConfig): Wikis {
  const app = new App({ appId: cfg.appId, privateKey: cfg.privateKey });
  let cached = cfg.installationId;
  // Cache de conditional-requests para headSha (el watcher lo pollea seguido). Guardamos el
  // ETag + el sha + el branch default por repo: la próxima consulta manda `If-None-Match`, y si
  // el HEAD no cambió GitHub responde 304 (cuerpo vacío) que NO descuenta del rate limit → el
  // sondeo es gratis salvo cambio real. El branch default ~nunca cambia, así que cachearlo
  // ahorra además su llamada por poll (de 2 requests por chequeo bajamos a 1, y esa 1 suele
  // ser un 304 gratis). Si el branch se renombrara, el ref daría 404 y headSha tiraría — caso
  // rarísimo y ruidoso, no silencioso.
  const headCache = new Map<string, { etag: string; sha: string; branch: string }>();
  // Cache del LISTADO de archivos por repo, keyed por el commit sha del HEAD. `listFiles` hacía
  // 2 requests NO-conditional a GitHub por llamada (repo→branch + git/trees recursivo); con el
  // explorer polleando cada 5s × N wikis, eso quemaba el rate limit del App (5000/h) en menos
  // de una hora con una sola pestaña abierta. Ahora `listFiles` primero resuelve el headSha
  // (barato: 304 conditional + branch cacheado) y, si el HEAD no cambió, devuelve el árbol
  // cacheado SIN pegarle a git/trees. Sólo refetcheamos el árbol cuando el HEAD cambió de verdad.
  const treeCache = new Map<string, { sha: string; files: string[] }>();

  async function installationId(): Promise<number> {
    if (cached) return cached;
    // Autenticado como el App (JWT): la instalación de la org.
    const { data } = await app.octokit.request("GET /orgs/{org}/installation", { org: cfg.org });
    cached = data.id;
    return cached;
  }

  // HEAD del branch default: commit sha + nombre del branch + tree sha (este último es el
  // `base_tree` de createTree). Lo usan commit/read/tree del contrato git-shaped.
  async function headOf(repoName: string): Promise<{ sha: string; branch: string; treeSha: string }> {
    const octokit = await app.getInstallationOctokit(await installationId());
    const { data: repo } = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: cfg.org,
      repo: repoName,
    });
    const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner: cfg.org,
      repo: repoName,
      ref: `heads/${repo.default_branch}`,
    });
    const { data: commit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
      owner: cfg.org,
      repo: repoName,
      commit_sha: ref.object.sha,
    });
    return { sha: ref.object.sha, branch: repo.default_branch, treeSha: commit.tree.sha };
  }

  // HEAD commit sha del branch default con conditional-request (un 304 no descuenta del rate
  // limit). Lo comparten el método `headSha` (que usa el watcher) y `listFiles` (que keyea su
  // cache del árbol por este sha). Branch default cacheado tras la 1ra vez.
  async function resolveHeadSha(repoName: string): Promise<string> {
    const octokit = await app.getInstallationOctokit(await installationId());
    const prev = headCache.get(repoName);
    let branch = prev?.branch;
    if (!branch) {
      const { data: repo } = await octokit.request("GET /repos/{owner}/{repo}", {
        owner: cfg.org,
        repo: repoName,
      });
      branch = repo.default_branch;
    }
    try {
      const ref = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        owner: cfg.org,
        repo: repoName,
        ref: `heads/${branch}`,
        headers: prev?.etag ? { "if-none-match": prev.etag } : {},
      });
      const sha = ref.data.object.sha;
      const etag = ref.headers?.etag;
      if (etag) headCache.set(repoName, { etag, sha, branch });
      return sha;
    } catch (e) {
      // 304 Not Modified: octokit lo tira como error con status 304 → el HEAD no cambió.
      if ((e as { status?: number }).status === 304 && prev) return prev.sha;
      throw e;
    }
  }

  // Árbol de un commit (recursivo, sólo blobs) como Map<path, blobSha> para el conflicto
  // por-path. `commitish` puede ser un commit sha o nombre de branch (GitHub lo resuelve).
  async function treeMap(repoName: string, commitish: string): Promise<Map<string, string>> {
    const octokit = await app.getInstallationOctokit(await installationId());
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner: cfg.org,
      repo: repoName,
      tree_sha: commitish,
      recursive: "1",
    });
    const m = new Map<string, string>();
    for (const e of data.tree) {
      if (e.type === "blob" && typeof e.path === "string" && typeof e.sha === "string") m.set(e.path, e.sha);
    }
    return m;
  }

  // Última versión viva de un archivo BORRADO (sin alive-check): el commit más reciente que lo
  // tocó es el que lo borró (ya no está en HEAD) → leemos el blob en su commit padre. null si
  // no hay versión previa (commit raíz / sin historia) o no es un archivo. Lo comparten recall
  // y searchArchived.
  async function deletedContent(
    repoName: string,
    clean: string,
  ): Promise<{ content: string; sha: string } | null> {
    const octokit = await app.getInstallationOctokit(await installationId());
    const { data: commits } = await octokit.request("GET /repos/{owner}/{repo}/commits", {
      owner: cfg.org,
      repo: repoName,
      path: clean,
      per_page: 1,
    });
    const parent = commits[0]?.parents?.[0]?.sha;
    if (!parent) return null;
    try {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner: cfg.org,
        repo: repoName,
        path: clean,
        ref: parent,
      });
      if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") return null;
      return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null; // no existía en el padre
      throw e;
    }
  }

  return {
    org: cfg.org,
    installationId,

    async createRepo(name) {
      const id = await installationId();
      const octokit = await app.getInstallationOctokit(id);
      const { data } = await octokit.request("POST /orgs/{org}/repos", {
        org: cfg.org,
        name,
        private: true,
        auto_init: true, // commit inicial → clonable y con branch default
        description: `wiki ceibo: ${name}`,
      });
      // `.gitkeep` defensivo en el root (Fase 7.2): garantiza que el árbol nunca quede
      // vacío, así `read`/`tree` sobre una wiki recién creada no se topan con un commit sin
      // blobs. `auto_init` ya deja un README, pero el `.gitkeep` sobrevive aunque ese README
      // se borre. Best-effort: si falla, la wiki ya existe — no abortamos su creación.
      try {
        await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
          owner: cfg.org,
          repo: name,
          path: ".gitkeep",
          message: "chore: .gitkeep",
          content: Buffer.from("", "utf8").toString("base64"),
        });
      } catch (e) {
        console.warn(`createRepo: no se pudo agregar .gitkeep a "${name}":`, e);
      }
      return { fullName: data.full_name, htmlUrl: data.html_url, cloneUrl: data.clone_url };
    },

    async renameRepo(oldName, newName) {
      const id = await installationId();
      const octokit = await app.getInstallationOctokit(id);
      const { data } = await octokit.request("PATCH /repos/{owner}/{repo}", {
        owner: cfg.org,
        repo: oldName,
        name: newName,
      });
      return { fullName: data.full_name, htmlUrl: data.html_url, cloneUrl: data.clone_url };
    },

    async mintToken(repoNames) {
      const id = await installationId();
      // Token de instalación acotado a repos puntuales + permisos mínimos.
      const { data } = await app.octokit.request("POST /app/installations/{installation_id}/access_tokens", {
        installation_id: id,
        repositories: repoNames,
        permissions: { contents: "write", metadata: "read" },
      });
      return { token: data.token, expiresAt: data.expires_at };
    },

    async listRepos() {
      const id = await installationId();
      const octokit = await app.getInstallationOctokit(id);
      const { data } = await octokit.request("GET /installation/repositories", { per_page: 100 });
      return data.repositories.map((r) => r.full_name);
    },

    async headSha(repoName) {
      return resolveHeadSha(repoName);
    },

    async getFile(repoName, path) {
      const id = await installationId();
      const octokit = await app.getInstallationOctokit(id);
      const clean = path.replace(/^\/+/, "");
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner: cfg.org,
        repo: repoName,
        path: clean,
      });
      if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
        throw new Error(`"${clean}" no es un archivo (¿carpeta o muy grande?)`);
      }
      return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha, path: clean };
    },

    async putFile(repoName, path, content, baseSha, message, author) {
      const id = await installationId();
      const octokit = await app.getInstallationOctokit(id);
      const clean = path.replace(/^\/+/, "");
      try {
        const { data } = await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
          owner: cfg.org,
          repo: repoName,
          path: clean,
          message,
          content: Buffer.from(content, "utf8").toString("base64"),
          sha: baseSha, // exige que el blob no haya cambiado → 409 si alguien escribió en el medio
          ...(author && { author }),
        });
        const sha = data.content?.sha;
        if (!sha) throw new Error("PUT sin sha de vuelta");
        return { sha, path: clean };
      } catch (e) {
        // 409 = el archivo cambió desde baseSha (otro escritor: agente/REM/otra pestaña).
        if ((e as { status?: number }).status === 409) {
          throw new WikiConflictError(`"${clean}" cambió desde que lo abriste`);
        }
        throw e;
      }
    },

    async createFile(repoName, path, content, message, author) {
      const id = await installationId();
      const octokit = await app.getInstallationOctokit(id);
      const clean = path.replace(/^\/+/, "");
      try {
        const { data } = await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
          owner: cfg.org,
          repo: repoName,
          path: clean,
          message,
          content: Buffer.from(content, "utf8").toString("base64"),
          // SIN `sha` → GitHub rechaza con 422 si el archivo ya existe (no sobreescribimos).
          ...(author && { author }),
        });
        const sha = data.content?.sha;
        if (!sha) throw new Error("PUT sin sha de vuelta");
        return { sha, path: clean };
      } catch (e) {
        // 422 con "sha" en el mensaje = ya existía un archivo en ese path.
        const err = e as { status?: number; message?: string };
        if (err.status === 422) {
          throw new WikiExistsError(`"${clean}" ya existe`);
        }
        throw e;
      }
    },

    async deleteFile(repoName, path, baseSha, message, author) {
      const id = await installationId();
      const octokit = await app.getInstallationOctokit(id);
      const clean = path.replace(/^\/+/, "");
      try {
        await octokit.request("DELETE /repos/{owner}/{repo}/contents/{path}", {
          owner: cfg.org,
          repo: repoName,
          path: clean,
          message,
          sha: baseSha, // exige que el blob no haya cambiado → 409 si alguien escribió en el medio
          ...(author && { author }),
        });
      } catch (e) {
        if ((e as { status?: number }).status === 409) {
          throw new WikiConflictError(`"${clean}" cambió desde que lo abriste`);
        }
        throw e;
      }
    },

    async moveFile(repoName, fromPath, toPath, baseSha, message, opts) {
      const octokit = await app.getInstallationOctokit(await installationId());
      const owner = cfg.org;
      const fromClean = fromPath.replace(/^\/+/, "");
      const toClean = toPath.replace(/^\/+/, "");
      if (fromClean === toClean) {
        throw new Error(`origen y destino son iguales: ${fromClean}`);
      }
      const author = opts?.author;

      // 1) Leemos el contenido vigente del origen para escribirlo en el destino.
      //    Lo bajamos de nuevo (no confiamos en lo que el cliente pueda mandar) para
      //    moves limpios sin pasar contenido por el wire.
      const { data: src } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo: repoName,
        path: fromClean,
      });
      if (Array.isArray(src) || src.type !== "file" || typeof src.content !== "string") {
        throw new Error(`"${fromClean}" no es un archivo`);
      }
      if (src.sha !== baseSha) {
        // El origen cambió desde el baseSha que el cliente tenía → conflicto optimista.
        throw new WikiConflictError(`"${fromClean}" cambió desde que lo abriste`);
      }

      // 2) Resolución del HEAD ANTES de crear cualquier objeto — aporta el base_tree para
      //    el árbol nuevo y nos da el estado actual del árbol para detectar si el destino
      //    ya existe (WikiExistsError) sin haber escrito nada aún.
      const head = await headOf(repoName);
      const headTree = await treeMap(repoName, head.sha);
      if (headTree.has(toClean)) {
        throw new WikiExistsError(`"${toClean}" ya existe (destino ocupado)`);
      }

      // 3) Commit atómico: UN SOLO commit que agrega toClean y borra fromClean.
      //    Antes la implementación creaba el destino (PUT) y borraba el origen (DELETE)
      //    en dos requests separados: si el DELETE fallaba, la nota quedaba duplicada y
      //    el cliente ya había recibido un 200. Ahora usamos la Git Data API directamente
      //    (igual que `commit()`): un árbol + un commit + un PATCH ref — todo-o-nada.
      //
      //    `opts.newContent` (opcional): el rename del explorer lo usa para reemplazar el
      //    H1 dentro del archivo en el mismo commit que el cambio de path, sin commit extra.
      //    `src.content` viene base64 desde GET contents; opts.newContent es UTF-8.
      const contentBase64 =
        opts?.newContent !== undefined
          ? Buffer.from(opts.newContent, "utf-8").toString("base64")
          : src.content;

      // Subimos el blob del destino a la Object Store de GitHub.
      const { data: newBlob } = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
        owner,
        repo: repoName,
        content: contentBase64,
        encoding: "base64",
      });

      // Árbol nuevo: agrega toClean (blob nuevo) y elimina fromClean (sha: null).
      const { data: newTree } = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
        owner,
        repo: repoName,
        base_tree: head.treeSha,
        tree: [
          { path: toClean, mode: "100644" as const, type: "blob" as const, sha: newBlob.sha },
          { path: fromClean, mode: "100644" as const, type: "blob" as const, sha: null },
        ],
      });

      const { data: newCommit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        owner,
        repo: repoName,
        message,
        tree: newTree.sha,
        parents: [head.sha],
        ...(author && { author }),
      });

      try {
        await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
          owner,
          repo: repoName,
          ref: `heads/${head.branch}`,
          sha: newCommit.sha,
          force: false, // no fast-forward → falla con 422 si HEAD se movió entre read y update
        });
      } catch (e) {
        // Carrera estrecha: HEAD avanzó en la ventana headOf→PATCH (otro escritor concurrente).
        // El cliente debe re-sincronizar y reintentar; reportamos el conflicto como WikiConflictError
        // (mismo contrato que putFile/deleteFile, que el caller de /api/file/move ya maneja con 409).
        if ((e as { status?: number }).status === 422) {
          throw new WikiConflictError(
            `HEAD de "${repoName}" se movió mientras movía "${fromClean}" → "${toClean}" — reintentá`,
          );
        }
        throw e;
      }

      // El blob sha del destino (lo que `putFile` devolvía como `sha`): es el sha del nuevo blob.
      return { sha: newBlob.sha, path: toClean };
    },

    async listFiles(repoName) {
      // Resolvemos el HEAD primero (barato: 304 conditional). Si el árbol cacheado es del mismo
      // commit, lo devolvemos sin tocar git/trees → el poll del explorer deja de quemar quota.
      const sha = await resolveHeadSha(repoName);
      const hit = treeCache.get(repoName);
      if (hit && hit.sha === sha) return hit.files;
      const octokit = await app.getInstallationOctokit(await installationId());
      // El commit sha resuelve a su tree (GitHub acepta sha de commit en {tree_sha}).
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner: cfg.org,
        repo: repoName,
        tree_sha: sha,
        recursive: "1",
      });
      const files = data.tree
        .filter((e) => e.type === "blob" && typeof e.path === "string")
        .map((e) => e.path as string)
        // `.ceibo/` son metadatos de ceibo (sidecar de emojis, etc.) — no notas: fuera del árbol.
        .filter((p) => !isCeiboMeta(p))
        .sort();
      treeCache.set(repoName, { sha, files });
      return files;
    },

    async readEmojis(repoName) {
      // Sidecar opcional: si no existe (wiki sin ningún emoji aún) → mapa vacío. Cualquier otro
      // error tampoco debe romper el explorer: degradamos a {} (el emoji es decorativo).
      try {
        const file = await this.getFile(repoName, EMOJIS_PATH);
        return parseEmojis(file.content);
      } catch {
        return {};
      }
    },

    async setEmoji(repoName, path, emoji, author) {
      const clean = path.replace(/^\/+/, "");
      // 1) Leemos el sidecar vigente (con su blob sha si existe) para mergear + escritura optimista.
      let current: EmojiMap = {};
      let baseSha: string | undefined;
      try {
        const file = await this.getFile(repoName, EMOJIS_PATH);
        current = parseEmojis(file.content);
        baseSha = file.sha;
      } catch {
        // No existe aún → lo creamos abajo (baseSha undefined).
      }
      const next = applyEmoji(current, clean, emoji);
      const content = serializeEmojis(next);
      const verb = emoji.trim() ? "🏷️ emoji" : "🧹 emoji";
      const message = `${verb} ${clean} — ${author?.name ?? "web"}`;
      if (baseSha) {
        // Reescritura optimista: 409 si el sidecar cambió desde que lo leímos. El caller
        // (poco probable que dos escrituras de emoji concurran) puede reintentar.
        await this.putFile(repoName, EMOJIS_PATH, content, baseSha, message, author);
      } else {
        // Primer emoji de la wiki: crea `.ceibo/emojis.json` (carpeta incluida).
        await this.createFile(repoName, EMOJIS_PATH, content, message, author);
      }
      return next;
    },

    async recall(repoName, path) {
      const id = await installationId();
      const octokit = await app.getInstallationOctokit(id);
      const clean = path.replace(/^\/+/, "");
      // Guard: si el path sigue vivo en HEAD, no está archivado (nada que recuperar).
      let alive = false;
      try {
        await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
          owner: cfg.org,
          repo: repoName,
          path: clean,
        });
        alive = true;
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e; // 404 = borrado, lo esperado
      }
      if (alive) throw new Error(`"${clean}" no está archivado (sigue vivo en la wiki)`);
      const got = await deletedContent(repoName, clean);
      if (!got) throw new Error(`"${clean}" no tiene una versión previa recuperable`);
      return { content: got.content, sha: got.sha, path: clean };
    },

    async searchArchived(repoName, query) {
      const q = query.trim().toLowerCase();
      if (!q) return { matches: [], scanned: 0, truncated: false };
      const octokit = await app.getInstallationOctokit(await installationId());
      const headSha = (await headOf(repoName)).sha;
      // 1) Manifests de archivado en HEAD (`.archived.md` nuevo + `_archivado.md` legacy).
      const { data: treeData } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner: cfg.org,
        repo: repoName,
        tree_sha: headSha,
        recursive: "1",
      });
      // Conjunto de paths VIVOS en HEAD: permite filtrar notas que aparecen en un manifest
      // pero que ya volvieron a estar vivas (fueron recalled/recreadas). Sin este guard,
      // `deletedContent` daría el commit más reciente que tocó el path (el de creación/edición),
      // leería el blob de su padre, y devolvería contenido VIEJO presentado como "archivado".
      // (El mismo guard que usa `recall` individualmente, acá de una sola vez para toda la búsqueda.)
      const livePaths = new Set(
        treeData.tree
          .filter((e) => e.type === "blob" && typeof e.path === "string")
          .map((e) => e.path as string),
      );
      const manifests = treeData.tree.filter(
        (e) =>
          e.type === "blob" &&
          typeof e.path === "string" &&
          typeof e.sha === "string" &&
          isArchiveManifest((e.path as string).split("/").pop() ?? ""),
      );
      // 2) Paths archivados = links markdown a `.md` en cada manifest, relativos a su carpeta.
      const archived = new Set<string>();
      for (const m of manifests) {
        const mpath = m.path as string;
        const slash = mpath.lastIndexOf("/");
        const dir = slash === -1 ? "" : mpath.slice(0, slash);
        const { data: blob } = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
          owner: cfg.org,
          repo: repoName,
          file_sha: m.sha as string,
        });
        const md = Buffer.from(blob.content, "base64").toString("utf8");
        for (const link of md.matchAll(/\]\(([^)]+\.md)\)/g)) {
          const target = (link[1] ?? "").replace(/^\.\//, "");
          const full = (dir ? `${dir}/${target}` : target).replace(/^\/+/, "");
          if (full) archived.add(full);
        }
      }
      // 3) Leer cada nota archivada desde la historia y matchear el término en su contenido.
      //    Excluimos los paths que volvieron a estar vivos en HEAD (recalled/recreados): su
      //    `deletedContent` daría el commit de re-creación y leería el blob del padre anterior
      //    — contenido viejo y potencialmente irrelevante presentado como "archivado".
      const all = [...archived].filter((p) => !livePaths.has(p));
      const truncated = all.length > ARCHIVE_SEARCH_CAP;
      const target = all.slice(0, ARCHIVE_SEARCH_CAP);
      const matches: ArchivedMatch[] = [];
      // Concurrencia acotada para no disparar el secondary rate-limit de GitHub.
      for (let i = 0; i < target.length; i += 8) {
        const chunk = target.slice(i, i + 8);
        const got = await Promise.all(chunk.map((p) => deletedContent(repoName, p).catch(() => null)));
        chunk.forEach((p, j) => {
          const content = got[j]?.content;
          if (!content) return;
          const lines = content.split("\n");
          const hit = lines.find((l) => l.toLowerCase().includes(q));
          if (!hit && !p.toLowerCase().includes(q)) return;
          const h1 = lines
            .find((l) => /^#\s+/.test(l))
            ?.replace(/^#\s+/, "")
            .trim();
          matches.push({
            path: p,
            title: h1 || (p.split("/").pop() ?? p).replace(/\.md$/, ""),
            line: (hit ?? "").trim(),
          });
        });
      }
      return { matches, scanned: target.length, truncated };
    },

    async blame(repoName, path): Promise<WikiBlame> {
      const octokit = await app.getInstallationOctokit(await installationId());
      const clean = path.replace(/^\/+/, "");
      // GraphQL (Blob.blame no existe; es Commit.blame): un solo request resuelve HEAD del
      // branch default + los rangos. El installation client de @octokit/app trae `.graphql`
      // con el mismo token que `.request` — sin deps nuevas.
      const data = (await octokit.graphql(BLAME_QUERY, {
        owner: cfg.org,
        repo: repoName,
        path: clean,
      })) as BlameQueryData;
      const target = data.repository?.defaultBranchRef?.target;
      if (!target) throw new Error(`blame: "${repoName}" sin branch default (¿repo vacío?)`);
      const ranges = (target.blame?.ranges ?? []).map((r) => ({
        startLine: r.startingLine,
        endLine: r.endingLine,
        authorEmail: r.commit.author?.email ?? "",
        authorName: r.commit.author?.name ?? "",
        sha: r.commit.oid,
        date: r.commit.committedDate,
      }));
      return { ref: target.oid, ranges };
    },

    // ── Contrato git-shaped (Fase 1) ─────────────────────────────────────────
    async tree(repoName, ref): Promise<WikiTree> {
      const octokit = await app.getInstallationOctokit(await installationId());
      const commitSha = ref ?? (await headOf(repoName)).sha;
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner: cfg.org,
        repo: repoName,
        tree_sha: commitSha,
        recursive: "1",
      });
      const paths = data.tree
        .filter((e) => e.type === "blob" && typeof e.path === "string")
        .map((e) => e.path as string)
        .sort();
      return { ref: commitSha, paths };
    },

    async read(repoName, ref, paths): Promise<WikiSnapshot> {
      const octokit = await app.getInstallationOctokit(await installationId());
      const commitSha = ref ?? (await headOf(repoName)).sha;
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner: cfg.org,
        repo: repoName,
        tree_sha: commitSha,
        recursive: "1",
      });
      const blobs = data.tree
        .filter((e) => e.type === "blob" && typeof e.path === "string" && typeof e.sha === "string")
        .map((e) => ({ path: e.path as string, sha: e.sha as string }));
      const want = paths ? new Set(paths.map((p) => p.replace(/^\/+/, ""))) : undefined;
      const target = want ? blobs.filter((b) => want.has(b.path)) : blobs;
      const files = await Promise.all(
        target.map(async (b) => {
          const { data: blob } = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
            owner: cfg.org,
            repo: repoName,
            file_sha: b.sha,
          });
          return { path: b.path, sha: b.sha, content: Buffer.from(blob.content, "base64").toString("utf8") };
        }),
      );
      return { ref: commitSha, files };
    },

    async changesSince(repoName, baseRef): Promise<WikiDelta> {
      const octokit = await app.getInstallationOctokit(await installationId());
      const head = (await headOf(repoName)).sha;
      if (head === baseRef) return { ref: head, changed: [], deleted: [] };
      const { data } = await octokit
        .request("GET /repos/{owner}/{repo}/compare/{basehead}", {
          owner: cfg.org,
          repo: repoName,
          basehead: `${baseRef}...${head}`,
        })
        .catch((e: unknown) => {
          // 404 en el compare con el repo existente (headOf ya resolvió HEAD recién) = el baseRef
          // no está en la historia (history rewrite / force-push / branch recreado). Error TIPADO
          // para que el caller degrade con gracia (incidente REM 2026-06-09): un cursor roto NO
          // puede convertirse en silencio en un diff inventado/total.
          if ((e as { status?: number }).status === 404) {
            throw new WikiBaseGoneError(
              `baseRef ${baseRef} ya no existe en la historia de "${repoName}" (¿history rewrite?)`,
            );
          }
          throw e;
        });
      const changed: WikiDelta["changed"] = [];
      const deleted: string[] = [];
      for (const f of data.files ?? []) {
        if (f.status === "removed") {
          deleted.push(f.filename);
          continue;
        }
        // renamed: el path viejo se borra y el nuevo cuenta como cambiado.
        if (f.status === "renamed" && f.previous_filename) deleted.push(f.previous_filename);
        if (typeof f.sha === "string") {
          const { data: blob } = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
            owner: cfg.org,
            repo: repoName,
            file_sha: f.sha,
          });
          changed.push({
            path: f.filename,
            sha: f.sha,
            content: Buffer.from(blob.content, "base64").toString("utf8"),
          });
        }
      }
      return { ref: head, changed, deleted };
    },

    async diffFiles(repoName, baseRef, headRef): Promise<WikiDiffFiles> {
      const octokit = await app.getInstallationOctokit(await installationId());
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
        owner: cfg.org,
        repo: repoName,
        basehead: `${baseRef}...${headRef}`,
      });
      const out: WikiDiffFiles = { added: [], removed: [], renamed: [], modified: [], commits: [] };
      for (const f of data.files ?? []) {
        if (f.status === "added") {
          out.added.push({ path: f.filename, sha: typeof f.sha === "string" ? f.sha : "" });
        } else if (f.status === "removed") {
          // En removed, `sha` es el blob que existía antes del borrado. Si GitHub no lo diera,
          // "" no matchea ningún added → el caller lo cuenta como borrado real (conservador).
          out.removed.push({ path: f.filename, sha: typeof f.sha === "string" ? f.sha : "" });
        } else if (f.status === "renamed" && f.previous_filename) {
          out.renamed.push({ from: f.previous_filename, to: f.filename });
        } else {
          out.modified.push(f.filename);
        }
      }
      out.commits = (data.commits ?? []).map((c) => ({ sha: c.sha, message: c.commit?.message ?? "" }));
      return out;
    },

    async revertTo(repoName, toRef, message, expectedHead, author): Promise<{ ref: string }> {
      const octokit = await app.getInstallationOctokit(await installationId());
      const head = await headOf(repoName);
      if (head.sha === toRef) return { ref: head.sha }; // ya estamos ahí: nada que revertir
      // Anclaje: si el caller decidió revertir mirando un HEAD que ya no es el actual (otro
      // escritor pushó en el medio), abortamos — revertir acá pisaría trabajo que no evaluamos.
      if (expectedHead && head.sha !== expectedHead) {
        throw new WikiConflictError(
          `HEAD de "${repoName}" avanzó (${head.sha.slice(0, 8)} ≠ ${expectedHead.slice(0, 8)}) → no revierto`,
        );
      }
      // Commit nuevo cuyo árbol ES el de `toRef`, con parent el HEAD actual: un revert de todo
      // lo que vino después de `toRef`, sin reescribir historia (lo revertido queda recuperable).
      const { data: target } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        owner: cfg.org,
        repo: repoName,
        commit_sha: toRef,
      });
      const { data: revert } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        owner: cfg.org,
        repo: repoName,
        message,
        tree: target.tree.sha,
        parents: [head.sha],
        ...(author && { author }),
      });
      try {
        await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
          owner: cfg.org,
          repo: repoName,
          ref: `heads/${head.branch}`,
          sha: revert.sha,
          force: false, // no fast-forward → falla si HEAD se movió entre el read y el update
        });
      } catch (e) {
        if ((e as { status?: number }).status === 422) {
          throw new WikiConflictError(`HEAD de "${repoName}" se movió mientras revertía → no revierto`);
        }
        throw e;
      }
      return { ref: revert.sha };
    },

    async commit(repoName, baseRef, changes, message, author): Promise<CommitResult> {
      const octokit = await app.getInstallationOctokit(await installationId());
      const owner = cfg.org;
      const head = await headOf(repoName);
      // Conflicto por-path (Decisión 1-A): comparamos el blob de cada path tocado entre
      // baseRef y HEAD. Si baseRef === HEAD, el árbol es el mismo (cero conflictos posibles).
      const headTree = await treeMap(repoName, head.sha);
      const baseTree = baseRef === head.sha ? headTree : await treeMap(repoName, baseRef);
      // Normalizamos el path una vez (sin slash inicial) y conservamos `base` por-cambio.
      const normalized = changes.map((c) => ({ ...c, path: c.path.replace(/^\/+/, "") }));
      const touched = normalized.map((c) => c.path);
      // Conflicto endurecido (la edición manual gana): si el cambio declara `base`, comparamos
      // contra el HEAD real al momento del commit, no sólo baseTree-vs-headTree del baseRef.
      const conflicts = conflictingChanges(normalized, baseTree, headTree);
      if (conflicts.length) return { ok: false, conflictPaths: conflicts };
      // Tree nuevo basado en el de HEAD: un blob nuevo por cada put, sha:null por cada delete.
      const entries = await Promise.all(
        changes.map(async (c) => {
          const path = c.path.replace(/^\/+/, "");
          if (c.op === "delete") {
            return { path, mode: "100644" as const, type: "blob" as const, sha: null };
          }
          const { data: blob } = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
            owner,
            repo: repoName,
            content: Buffer.from(c.content, "utf8").toString("base64"),
            encoding: "base64",
          });
          return { path, mode: "100644" as const, type: "blob" as const, sha: blob.sha };
        }),
      );
      const { data: newTree } = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
        owner,
        repo: repoName,
        base_tree: head.treeSha,
        tree: entries,
      });
      const { data: newCommit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        owner,
        repo: repoName,
        message,
        tree: newTree.sha,
        parents: [head.sha],
        ...(author && { author }),
      });
      try {
        await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
          owner,
          repo: repoName,
          ref: `heads/${head.branch}`,
          sha: newCommit.sha,
          force: false, // no fast-forward → falla si HEAD se movió entre el read y el update
        });
      } catch (e) {
        // Carrera estrecha (HEAD se movió en la ventana read→update), distinta del conflicto
        // por-path. Pedimos al cliente re-sincronizar y reintentar reportando los paths tocados.
        if ((e as { status?: number }).status === 422) return { ok: false, conflictPaths: touched };
        throw e;
      }
      return { ok: true, ref: newCommit.sha };
    },
  };
}

/** El archivo cambió en el remoto desde el `baseSha` con el que se abrió (escritura optimista). */
export class WikiConflictError extends Error {
  readonly conflict = true;
  constructor(message: string) {
    super(message);
    this.name = "WikiConflictError";
  }
}

/** El baseRef pedido ya NO existe en la historia del repo (history rewrite / force-push):
 *  un diff "desde ese ref" no se puede computar. El caller debe degradar (saltear / re-anclar
 *  su cursor al HEAD actual) — nunca inventar un diff. (Incidente REM 2026-06-09.) */
export class WikiBaseGoneError extends Error {
  readonly baseGone = true;
  constructor(message: string) {
    super(message);
    this.name = "WikiBaseGoneError";
  }
}

/** El archivo ya existe (createFile no sobreescribe; moveFile no piso destino). */
export class WikiExistsError extends Error {
  readonly exists = true;
  constructor(message: string) {
    super(message);
    this.name = "WikiExistsError";
  }
}
