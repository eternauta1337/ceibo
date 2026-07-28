// Espejo git de UNA vía (feature db F3b): exporta las versiones escritas por el CONTRATO
// (note_versions con mirrored_at NULL) al MISMO repo git de siempre, como commits normales.
//
// Es el reemplazo explícito de "GitHub tiene todo": backup continuo (RPO ~0), historia
// navegable que CONTINÚA sin cortarse, y salida de emergencia de la migración. De una
// vía ⇒ no hay reconciliación: la DB es la verdad de lo que exporta; git no le responde.
//
// Convive con el mundo pre-cutover: mientras los escritores sigan en git (F3c con flag
// apagado), no hay versiones del contrato y el loop es un no-op. Cuando el flag flipea,
// cada write del contrato termina acá. El commit del espejo dispara al reconciliador de
// F1 (head nuevo) — inofensivo: el contenido ya está en la DB byte-idéntico (mismo upsert,
// no-op por blob) y el guard de head se realinea.
//
// Autoría: el commit git lleva `gitAuthorFor(handle)` del autor real de la versión (la
// verdad fina vive en note_versions; el espejo la aproxima por commit, como hoy).
// Conflictos (alguien escribió git por fuera mientras): se reintenta con head fresco al
// tick siguiente; si el path sigue conflictuando, gana la DB (es la fuente) — se exporta
// con base explícita en el próximo intento. Los errores NUNCA frenan el resto de repos.

import { type Db, getUser, markMirrored, versionsPendingMirror } from "@ceibo/store";
import { type Change, type CommitResult, gitAuthorFor } from "@ceibo/wikis";

/** Lo que el espejo necesita del substrato (fakeable en tests). */
export interface MirrorSubstrate {
  headSha(repo: string): Promise<string>;
  /** Paths (.md y demás) presentes en git HEAD — para saber si un delete es no-op. */
  tree(repo: string, ref?: string): Promise<{ paths: string[] }>;
  commit(
    repo: string,
    baseRef: string,
    changes: Change[],
    message: string,
    author?: { name: string; email: string },
  ): Promise<CommitResult>;
}

export interface NotesMirrorOpts {
  db: Db;
  wikis: MirrorSubstrate;
  pollMs?: number;
  batchLimit?: number;
  log?: (msg: string) => void;
}

interface PendingVersion {
  id: number;
  repo: string;
  path: string;
  version: number;
  content: string;
  op: string;
  authorUid: number | null;
  movedFrom: string | null;
}

/** Colapsa las versiones pendientes de UN repo a un set de cambios git (último estado por
 *  path gana; un move aporta delete del path viejo + put del nuevo). Exportado para test. */
export function collapseToChanges(versions: PendingVersion[]): Change[] {
  const byPath = new Map<string, Change>();
  for (const v of versions) {
    if (v.op === "move" && v.movedFrom) {
      // movedFrom = "repo/dir/x.md" (los nombres de repo no llevan "/"). El delete del
      // path viejo va SOLO si el origen es ESTE repo — un move cross-wiki deja su propia
      // fila op='delete' en el repo de origen (ver moveNote).
      const [fromRepo, ...rest] = v.movedFrom.split("/");
      const from = rest.join("/");
      if (fromRepo === v.repo && from && from !== v.path) byPath.set(from, { op: "delete", path: from });
    }
    if (v.op === "delete") {
      byPath.set(v.path, { op: "delete", path: v.path });
    } else {
      byPath.set(v.path, { op: "put", path: v.path, content: v.content });
    }
  }
  return [...byPath.values()];
}

function messageFor(versions: PendingVersion[]): string {
  if (versions.length === 1) {
    const v = versions[0] as PendingVersion;
    const verb = { create: "crea", edit: "edita", delete: "borra", move: "mueve" }[v.op] ?? v.op;
    return `✏️ espejo db: ${verb} ${v.path}`;
  }
  return `✏️ espejo db: ${versions.length} cambios`;
}

export interface NotesMirror {
  tick(): Promise<void>;
  stop(): void;
}

export function startNotesMirror(opts: NotesMirrorOpts): NotesMirror {
  const log = opts.log ?? (() => {});
  const batchLimit = opts.batchLimit ?? 200;
  let busy = false;
  let stopped = false;

  async function mirrorRepo(repo: string, versions: PendingVersion[]): Promise<void> {
    let changes = collapseToChanges(versions);
    // Un `delete` de un path que NO está en git HEAD es un no-op (ej. una nota creada y
    // borrada por el contrato antes de que el espejo la pushara — su net es "nada en git").
    // Mandarlo al Git Data API tira BadObjectState y TRABA la cola del repo. Lo filtramos.
    if (changes.some((c) => c.op === "delete")) {
      const gitPaths = new Set((await opts.wikis.tree(repo)).paths);
      changes = changes.filter((c) => c.op !== "delete" || gitPaths.has(c.path));
    }
    if (changes.length === 0) {
      markMirrored(
        opts.db,
        versions.map((v) => v.id),
      );
      return;
    }
    // Autor del commit = el autor de la última versión del lote (aproximación por commit).
    const lastUid = [...versions].reverse().find((v) => v.authorUid !== null)?.authorUid ?? null;
    const user = lastUid !== null ? getUser(opts.db, lastUid) : undefined;
    const author = user
      ? gitAuthorFor(user.handle, user.name)
      : gitAuthorFor("ceibo-db", "Ceibo (espejo db)");

    const head = await opts.wikis.headSha(repo);
    const result = await opts.wikis.commit(repo, head, changes, messageFor(versions), author);
    if (result.ok) {
      markMirrored(
        opts.db,
        versions.map((v) => v.id),
      );
      log(`notes-mirror: ${repo} → ${result.ref.slice(0, 7)} (${changes.length} cambios)`);
    } else {
      // Base movida entre headSha y commit (o edición externa): NO marcamos; el próximo
      // tick reintenta con head fresco. La DB es la fuente: sus cambios no se descartan.
      log(`notes-mirror: ${repo} conflicto en ${result.conflictPaths.join(",")} — reintenta`);
    }
  }

  async function tick(): Promise<void> {
    if (busy || stopped) return;
    busy = true;
    try {
      const pending = versionsPendingMirror(opts.db, batchLimit) as PendingVersion[];
      if (pending.length === 0) return;
      const byRepo = new Map<string, PendingVersion[]>();
      for (const v of pending) {
        const arr = byRepo.get(v.repo) ?? [];
        arr.push(v);
        byRepo.set(v.repo, arr);
      }
      for (const [repo, versions] of byRepo) {
        if (stopped) break;
        await mirrorRepo(repo, versions).catch((e) =>
          log(`notes-mirror: ${repo}: ${(e as Error).message} — reintenta`),
        );
      }
    } finally {
      busy = false;
    }
  }

  const timer = opts.pollMs === 0 ? null : setInterval(() => void tick(), opts.pollMs ?? 20_000);
  timer?.unref?.();

  return {
    tick,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
