// Tests para el ciclo de vida de wikis: archivado per-usuario, soft-delete, ownership,
// personal flag, invites. Corresponde a la Fase 1 del feature wiki-management.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptInvitesForEmail,
  addInvite,
  addRepo,
  addUser,
  archiveForUser,
  getUserActiveWiki,
  grantAccess,
  isMember,
  isOwner,
  listAllRepos,
  listInvitesForRepo,
  listPendingInvitesForEmail,
  listReposForUser,
  listSoftDeleted,
  openDb,
  ownerOf,
  purgeRepo,
  recoverRepo,
  removeInvite,
  revokeAccess,
  roleOf,
  setUserActiveWiki,
  softDeleteRepo,
  unarchiveForUser,
} from "./index.ts";

const db = () => openDb(":memory:");

// ---------------------------------------------------------------------------
// Archivado per-usuario
// ---------------------------------------------------------------------------
describe("archivado per-usuario", () => {
  it("archivar saca la wiki sólo de listReposForUser del que archivó", () => {
    const d = db();
    const a = addUser(d, "a");
    const b = addUser(d, "b");
    const r = addRepo(d, "org", "wiki-compartida");
    grantAccess(d, r.id, a.id);
    grantAccess(d, r.id, b.id);

    archiveForUser(d, r.id, a.id);

    // A ya no la ve (sin includeArchived)
    expect(listReposForUser(d, a.id).map((x) => x.name)).not.toContain("wiki-compartida");
    // B sigue viéndola
    expect(listReposForUser(d, b.id).map((x) => x.name)).toContain("wiki-compartida");
  });

  it("includeArchived: true devuelve también las archivadas", () => {
    const d = db();
    const a = addUser(d, "a");
    const r = addRepo(d, "org", "wiki-arch");
    grantAccess(d, r.id, a.id);
    archiveForUser(d, r.id, a.id);

    const sin = listReposForUser(d, a.id).map((x) => x.name);
    const con = listReposForUser(d, a.id, { includeArchived: true }).map((x) => x.name);

    expect(sin).not.toContain("wiki-arch");
    expect(con).toContain("wiki-arch");
  });

  it("archivar limpia active_wiki si apuntaba a esa wiki", () => {
    const d = db();
    const a = addUser(d, "a");
    const r = addRepo(d, "org", "wiki-foco");
    grantAccess(d, r.id, a.id);
    setUserActiveWiki(d, a.id, "wiki-foco");

    archiveForUser(d, r.id, a.id);

    expect(getUserActiveWiki(d, a.id)).toBeNull();
  });

  it("archivar NO limpia active_wiki de otro usuario", () => {
    const d = db();
    const a = addUser(d, "a");
    const b = addUser(d, "b");
    const r = addRepo(d, "org", "wiki-comp");
    grantAccess(d, r.id, a.id);
    grantAccess(d, r.id, b.id);
    setUserActiveWiki(d, b.id, "wiki-comp");

    archiveForUser(d, r.id, a.id); // A archiva

    expect(getUserActiveWiki(d, b.id)).toBe("wiki-comp"); // B no se ve afectado
  });

  it("archivar es idempotente", () => {
    const d = db();
    const a = addUser(d, "a");
    const r = addRepo(d, "org", "wiki-idem");
    grantAccess(d, r.id, a.id);

    archiveForUser(d, r.id, a.id);
    archiveForUser(d, r.id, a.id); // segunda vez → no-op

    expect(listReposForUser(d, a.id)).toHaveLength(0);
  });

  it("desarchivar devuelve la wiki al listado activo", () => {
    const d = db();
    const a = addUser(d, "a");
    const r = addRepo(d, "org", "wiki-unarch");
    grantAccess(d, r.id, a.id);
    archiveForUser(d, r.id, a.id);

    unarchiveForUser(d, r.id, a.id);

    expect(listReposForUser(d, a.id).map((x) => x.name)).toContain("wiki-unarch");
  });
});

// ---------------------------------------------------------------------------
// Soft-delete global
// ---------------------------------------------------------------------------
describe("soft-delete global", () => {
  it("softDeleteRepo saca la wiki de listReposForUser de todos los miembros", () => {
    const d = db();
    const a = addUser(d, "a");
    const b = addUser(d, "b");
    const r = addRepo(d, "org", "wiki-borrada");
    grantAccess(d, r.id, a.id);
    grantAccess(d, r.id, b.id);

    softDeleteRepo(d, r.id);

    expect(listReposForUser(d, a.id)).toHaveLength(0);
    expect(listReposForUser(d, b.id)).toHaveLength(0);
  });

  it("softDeleteRepo limpia active_wiki de todos los usuarios que apuntaban ahí", () => {
    const d = db();
    const a = addUser(d, "a");
    const b = addUser(d, "b");
    const r = addRepo(d, "org", "wiki-del-foco");
    grantAccess(d, r.id, a.id);
    grantAccess(d, r.id, b.id);
    setUserActiveWiki(d, a.id, "wiki-del-foco");
    setUserActiveWiki(d, b.id, "wiki-del-foco");

    softDeleteRepo(d, r.id);

    expect(getUserActiveWiki(d, a.id)).toBeNull();
    expect(getUserActiveWiki(d, b.id)).toBeNull();
  });

  it("listSoftDeleted lista wikis borradas; listAllRepos no las incluye por default", () => {
    const d = db();
    const a = addUser(d, "a");
    const r = addRepo(d, "org", "wiki-sdel");
    grantAccess(d, r.id, a.id);
    softDeleteRepo(d, r.id);

    expect(listSoftDeleted(d).map((x) => x.name)).toContain("wiki-sdel");
    expect(listAllRepos(d).map((x) => x.name)).not.toContain("wiki-sdel");
    expect(listAllRepos(d, { includeDeleted: true }).map((x) => x.name)).toContain("wiki-sdel");
  });

  it("recoverRepo limpia deleted_at y la wiki vuelve a ser visible", () => {
    const d = db();
    const a = addUser(d, "a");
    const r = addRepo(d, "org", "wiki-rec");
    grantAccess(d, r.id, a.id);
    softDeleteRepo(d, r.id);
    recoverRepo(d, r.id);

    expect(listReposForUser(d, a.id).map((x) => x.name)).toContain("wiki-rec");
    expect(listSoftDeleted(d)).toHaveLength(0);
  });

  it("purgeRepo borra físicamente la wiki del store", () => {
    const d = db();
    const r = addRepo(d, "org", "wiki-purge");
    softDeleteRepo(d, r.id);
    purgeRepo(d, r.id);

    expect(listSoftDeleted(d)).toHaveLength(0);
    expect(listAllRepos(d, { includeDeleted: true })).toHaveLength(0);
  });

  it("una wiki soft-borrada NO aparece en includeArchived", () => {
    const d = db();
    const a = addUser(d, "a");
    const r = addRepo(d, "org", "wiki-del2");
    grantAccess(d, r.id, a.id);
    softDeleteRepo(d, r.id);

    expect(listReposForUser(d, a.id, { includeArchived: true })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ownership (role='owner' y helpers)
// ---------------------------------------------------------------------------
describe("ownership y roles", () => {
  it("grantAccess con role='owner' setea el rol correcto", () => {
    const d = db();
    const a = addUser(d, "a");
    const r = addRepo(d, "org", "wiki-own");
    grantAccess(d, r.id, a.id, "owner");

    expect(roleOf(d, r.id, a.id)).toBe("owner");
    expect(isOwner(d, r.id, a.id)).toBe(true);
    expect(isMember(d, r.id, a.id)).toBe(true);
  });

  it("grantAccess default es 'member'", () => {
    const d = db();
    const a = addUser(d, "a");
    const r = addRepo(d, "org", "wiki-mem");
    grantAccess(d, r.id, a.id);

    expect(roleOf(d, r.id, a.id)).toBe("member");
    expect(isOwner(d, r.id, a.id)).toBe(false);
    expect(isMember(d, r.id, a.id)).toBe(true);
  });

  it("roleOf undefined para usuario sin acceso", () => {
    const d = db();
    const a = addUser(d, "a");
    const r = addRepo(d, "org", "wiki-nr");

    expect(roleOf(d, r.id, a.id)).toBeUndefined();
    expect(isOwner(d, r.id, a.id)).toBe(false);
    expect(isMember(d, r.id, a.id)).toBe(false);
  });

  it("ownerOf devuelve el usuario con role='owner'", () => {
    const d = db();
    const a = addUser(d, "owner-a");
    const b = addUser(d, "member-b");
    const r = addRepo(d, "org", "wiki-ownerof");
    grantAccess(d, r.id, a.id, "owner");
    grantAccess(d, r.id, b.id, "member");

    expect(ownerOf(d, r.id)?.handle).toBe("owner-a");
  });

  it("ownerOf undefined si nadie tiene role='owner'", () => {
    const d = db();
    const a = addUser(d, "a");
    const r = addRepo(d, "org", "wiki-noown");
    grantAccess(d, r.id, a.id); // default member

    expect(ownerOf(d, r.id)).toBeUndefined();
  });

  it("grantAccess actualiza el rol si ya tiene acceso (idempotente pero actualiza role)", () => {
    const d = db();
    const a = addUser(d, "a");
    const r = addRepo(d, "org", "wiki-updrole");
    grantAccess(d, r.id, a.id, "member");
    grantAccess(d, r.id, a.id, "owner"); // upgrade

    expect(roleOf(d, r.id, a.id)).toBe("owner");
  });
});

// ---------------------------------------------------------------------------
// Backfill de ownership en la migración (simula DB pre-F1)
// ---------------------------------------------------------------------------
describe("backfill de ownership (migración F1)", () => {
  it("al abrir una DB con repo_access sin role, el backfill asigna 'owner' al grant más viejo", () => {
    // openDb(:memory:) corre el schema + migrate → la migración ve roles 'member' (default)
    // y aplica el backfill CTE. Simulamos creando la DB y luego dos usuarios con acceso.
    const d = db();
    const a = addUser(d, "creator");
    const b = addUser(d, "joiner");
    const r = addRepo(d, "org", "wiki-backfill");
    // Forzamos role='member' para ambos (como si vinieran de antes del F1)
    d.prepare("INSERT INTO repo_access (repo_id, user_id, role) VALUES (?, ?, 'member')").run(r.id, a.id);
    d.prepare("INSERT INTO repo_access (repo_id, user_id, role) VALUES (?, ?, 'member')").run(r.id, b.id);

    // Abrimos la misma DB de nuevo (simula restart) con otra conexión sobre :memory: no es
    // posible reusar, así que corremos la migración directamente sobre d.
    // La migración ya corrió al openDb; para el backfill, lo corremos manualmente via una
    // DB nueva que incluye las filas:
    const d2 = openDb(":memory:");
    const a2 = addUser(d2, "creator2");
    const b2 = addUser(d2, "joiner2");
    const r2 = addRepo(d2, "org", "wiki-bf2");
    // Insertar con role='member' por default (como viejo)
    d2.prepare(
      "INSERT INTO repo_access (repo_id, user_id, role, created_at) VALUES (?, ?, 'member', '2024-01-01')",
    ).run(r2.id, a2.id);
    d2.prepare(
      "INSERT INTO repo_access (repo_id, user_id, role, created_at) VALUES (?, ?, 'member', '2024-01-02')",
    ).run(r2.id, b2.id);

    // Reabrimos una nueva DB e insertamos datos "pre-migración" directamente para testear
    // el backfill CTE en aislamiento:
    const fresh = openDb(":memory:");
    const u1 = addUser(fresh, "early");
    const u2 = addUser(fresh, "late");
    const repo = addRepo(fresh, "org", "bf-wiki");
    // Pisar el created_at de repo_access para simular orden histórico
    fresh
      .prepare(
        "INSERT OR REPLACE INTO repo_access (repo_id, user_id, role, created_at) VALUES (?, ?, 'member', '2024-01-01T10:00:00')",
      )
      .run(repo.id, u1.id);
    fresh
      .prepare(
        "INSERT OR REPLACE INTO repo_access (repo_id, user_id, role, created_at) VALUES (?, ?, 'member', '2024-01-02T10:00:00')",
      )
      .run(repo.id, u2.id);

    // Correr el backfill CTE manualmente (mismo SQL que la migración)
    fresh.exec(`
      WITH owners AS (
        SELECT ra.repo_id, ra.user_id
        FROM repo_access ra
        JOIN users u ON u.id = ra.user_id AND u.status = 'active'
        WHERE NOT EXISTS (
          SELECT 1 FROM repo_access ra2
          JOIN users u2 ON u2.id = ra2.user_id AND u2.status = 'active'
          WHERE ra2.repo_id = ra.repo_id
            AND (ra2.created_at < ra.created_at
                 OR (ra2.created_at = ra.created_at AND ra2.user_id < ra.user_id))
        )
      )
      UPDATE repo_access SET role = 'owner'
      WHERE role = 'member' AND EXISTS (
        SELECT 1 FROM owners o
        WHERE o.repo_id = repo_access.repo_id AND o.user_id = repo_access.user_id
      )
    `);

    expect(roleOf(fresh, repo.id, u1.id)).toBe("owner"); // el más viejo
    expect(roleOf(fresh, repo.id, u2.id)).toBe("member"); // el más nuevo
    expect(ownerOf(fresh, repo.id)?.handle).toBe("early");
  });

  it("backfill: en empate de created_at, el de menor user.id queda owner", () => {
    const d = openDb(":memory:");
    const u1 = addUser(d, "u1");
    const u2 = addUser(d, "u2");
    const r = addRepo(d, "org", "bf-tie");
    const SAME_TS = "2024-06-01T00:00:00";
    d.prepare(
      "INSERT OR REPLACE INTO repo_access (repo_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)",
    ).run(r.id, u1.id, SAME_TS);
    d.prepare(
      "INSERT OR REPLACE INTO repo_access (repo_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)",
    ).run(r.id, u2.id, SAME_TS);

    d.exec(`
      WITH owners AS (
        SELECT ra.repo_id, ra.user_id
        FROM repo_access ra
        JOIN users u ON u.id = ra.user_id AND u.status = 'active'
        WHERE NOT EXISTS (
          SELECT 1 FROM repo_access ra2
          JOIN users u2 ON u2.id = ra2.user_id AND u2.status = 'active'
          WHERE ra2.repo_id = ra.repo_id
            AND (ra2.created_at < ra.created_at
                 OR (ra2.created_at = ra.created_at AND ra2.user_id < ra.user_id))
        )
      )
      UPDATE repo_access SET role = 'owner'
      WHERE role = 'member' AND EXISTS (
        SELECT 1 FROM owners o
        WHERE o.repo_id = repo_access.repo_id AND o.user_id = repo_access.user_id
      )
    `);

    // u1 tiene menor id → es el owner
    expect(ownerOf(d, r.id)?.handle).toBe("u1");
  });
});

// ---------------------------------------------------------------------------
// Flag personal
// ---------------------------------------------------------------------------
describe("flag personal (repos.personal)", () => {
  it("repos.personal=0 por default", () => {
    const d = db();
    const r = addRepo(d, "org", "wiki-normal");
    expect(r.personal).toBe(0);
  });

  it("personal se puede setear a 1 con UPDATE directo", () => {
    const d = db();
    const r = addRepo(d, "org", "wiki-personal");
    d.prepare("UPDATE repos SET personal = 1 WHERE id = ?").run(r.id);
    const updated = d.prepare("SELECT personal FROM repos WHERE id = ?").get(r.id) as {
      personal: number;
    };
    expect(updated.personal).toBe(1);
  });

  it("listReposForUser incluye repos personales (mientras no estén borrados/archivados)", () => {
    const d = db();
    const a = addUser(d, "a");
    const r = addRepo(d, "org", "a-personal");
    grantAccess(d, r.id, a.id, "owner");
    d.prepare("UPDATE repos SET personal = 1 WHERE id = ?").run(r.id);

    expect(listReposForUser(d, a.id).map((x) => x.name)).toContain("a-personal");
  });
});

// ---------------------------------------------------------------------------
// Wiki invites
// ---------------------------------------------------------------------------
describe("wiki invites", () => {
  it("addInvite crea una invitación pendiente", () => {
    const d = db();
    const owner = addUser(d, "owner");
    const r = addRepo(d, "org", "wiki-inv");
    grantAccess(d, r.id, owner.id, "owner");

    const inv = addInvite(d, r.id, "  Invitado@Example.COM  ", owner.id);

    expect(inv.email).toBe("invitado@example.com"); // normalizado
    expect(inv.accepted_at).toBeNull();
    expect(inv.invited_by).toBe(owner.id);
  });

  it("addInvite es idempotente (segunda llamada con mismo repo+email no duplica)", () => {
    const d = db();
    const owner = addUser(d, "owner");
    const r = addRepo(d, "org", "wiki-inv-idem");
    grantAccess(d, r.id, owner.id, "owner");

    addInvite(d, r.id, "test@test.com", owner.id);
    addInvite(d, r.id, "test@test.com", owner.id); // idempotente

    expect(listInvitesForRepo(d, r.id)).toHaveLength(1);
  });

  it("listInvitesForRepo lista todas las invitaciones de un repo", () => {
    const d = db();
    const owner = addUser(d, "owner");
    const r = addRepo(d, "org", "wiki-list-inv");
    grantAccess(d, r.id, owner.id, "owner");

    addInvite(d, r.id, "a@test.com", owner.id);
    addInvite(d, r.id, "b@test.com", owner.id);

    expect(listInvitesForRepo(d, r.id)).toHaveLength(2);
  });

  it("listPendingInvitesForEmail sólo devuelve las pendientes (accepted_at IS NULL)", () => {
    const d = db();
    const owner = addUser(d, "owner");
    const r1 = addRepo(d, "org", "wiki-p1");
    const r2 = addRepo(d, "org", "wiki-p2");
    grantAccess(d, r1.id, owner.id, "owner");
    grantAccess(d, r2.id, owner.id, "owner");

    addInvite(d, r1.id, "future@test.com", owner.id);
    addInvite(d, r2.id, "future@test.com", owner.id);

    // Aceptar manualmente uno
    d.prepare("UPDATE wiki_invites SET accepted_at = datetime('now') WHERE repo_id = ? AND email = ?").run(
      r1.id,
      "future@test.com",
    );

    const pending = listPendingInvitesForEmail(d, "future@test.com");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.repo_id).toBe(r2.id);
  });

  it("acceptInvitesForEmail materializa grants y marca accepted_at", () => {
    const d = db();
    const owner = addUser(d, "owner");
    const invited = addUser(d, "newcomer");
    const r1 = addRepo(d, "org", "wiki-acc1");
    const r2 = addRepo(d, "org", "wiki-acc2");
    grantAccess(d, r1.id, owner.id, "owner");
    grantAccess(d, r2.id, owner.id, "owner");

    addInvite(d, r1.id, "newcomer@test.com", owner.id);
    addInvite(d, r2.id, "newcomer@test.com", owner.id);

    const n = acceptInvitesForEmail(d, "newcomer@test.com", invited.id);
    expect(n).toBe(2);

    // El usuario ya tiene acceso a ambas wikis
    expect(listReposForUser(d, invited.id).map((x) => x.name)).toContain("wiki-acc1");
    expect(listReposForUser(d, invited.id).map((x) => x.name)).toContain("wiki-acc2");

    // Los invites quedan marcados como aceptados
    const invites = listInvitesForRepo(d, r1.id);
    expect(invites[0]?.accepted_at).not.toBeNull();
  });

  it("acceptInvitesForEmail es idempotente (re-login no duplica grants)", () => {
    const d = db();
    const owner = addUser(d, "owner");
    const invited = addUser(d, "newcomer2");
    const r = addRepo(d, "org", "wiki-idem-acc");
    grantAccess(d, r.id, owner.id, "owner");
    addInvite(d, r.id, "n2@test.com", owner.id);

    acceptInvitesForEmail(d, "n2@test.com", invited.id);
    acceptInvitesForEmail(d, "n2@test.com", invited.id); // segunda vez → 0 invites pendientes

    expect(listReposForUser(d, invited.id)).toHaveLength(1);
  });

  it("acceptInvitesForEmail devuelve 0 si no hay pendientes", () => {
    const d = db();
    const invited = addUser(d, "nobody");

    const n = acceptInvitesForEmail(d, "none@test.com", invited.id);
    expect(n).toBe(0);
  });

  it("removeInvite borra una invitación puntual", () => {
    const d = db();
    const owner = addUser(d, "owner");
    const r = addRepo(d, "org", "wiki-rm-inv");
    grantAccess(d, r.id, owner.id, "owner");
    addInvite(d, r.id, "revoke@test.com", owner.id);

    const removed = removeInvite(d, r.id, "revoke@test.com");
    expect(removed).toBe(true);
    expect(listInvitesForRepo(d, r.id)).toHaveLength(0);
  });

  it("removeInvite devuelve false si no había invitación", () => {
    const d = db();
    const r = addRepo(d, "org", "wiki-noninv");

    expect(removeInvite(d, r.id, "nobody@test.com")).toBe(false);
  });

  it("el rol asignado por acceptInvitesForEmail es 'member'", () => {
    const d = db();
    const owner = addUser(d, "owner");
    const invited = addUser(d, "invited-role");
    const r = addRepo(d, "org", "wiki-role-inv");
    grantAccess(d, r.id, owner.id, "owner");
    addInvite(d, r.id, "inv-role@test.com", owner.id);

    acceptInvitesForEmail(d, "inv-role@test.com", invited.id);

    expect(roleOf(d, r.id, invited.id)).toBe("member");
    expect(isOwner(d, r.id, invited.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listAllRepos filtrado
// ---------------------------------------------------------------------------
describe("listAllRepos con opts", () => {
  it("por default excluye repos soft-borrados", () => {
    const d = db();
    const a = addUser(d, "a");
    const r1 = addRepo(d, "org", "wiki-v");
    const r2 = addRepo(d, "org", "wiki-d");
    grantAccess(d, r1.id, a.id);
    grantAccess(d, r2.id, a.id);
    softDeleteRepo(d, r2.id);

    const all = listAllRepos(d);
    expect(all.map((x) => x.name)).toContain("wiki-v");
    expect(all.map((x) => x.name)).not.toContain("wiki-d");
  });

  it("{ includeDeleted: true } muestra todos", () => {
    const d = db();
    const a = addUser(d, "a");
    const r1 = addRepo(d, "org", "wiki-va");
    const r2 = addRepo(d, "org", "wiki-da");
    grantAccess(d, r1.id, a.id);
    grantAccess(d, r2.id, a.id);
    softDeleteRepo(d, r2.id);

    const all = listAllRepos(d, { includeDeleted: true });
    expect(all.map((x) => x.name)).toContain("wiki-va");
    expect(all.map((x) => x.name)).toContain("wiki-da");
  });
});

// ---------------------------------------------------------------------------
// Combinaciones: archivado + soft-delete
// ---------------------------------------------------------------------------
describe("combinaciones: archivado y soft-delete son independientes", () => {
  it("una wiki archivada por A se puede ver con includeArchived por A, pero borrada no", () => {
    const d = db();
    const a = addUser(d, "a");
    const r = addRepo(d, "org", "wiki-combo");
    grantAccess(d, r.id, a.id);
    archiveForUser(d, r.id, a.id);

    // visible con includeArchived
    expect(listReposForUser(d, a.id, { includeArchived: true })).toHaveLength(1);

    // si además se borra, ya no aparece ni con includeArchived
    softDeleteRepo(d, r.id);
    expect(listReposForUser(d, a.id, { includeArchived: true })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// revokeAccess
// ---------------------------------------------------------------------------
describe("revokeAccess", () => {
  it("revokeAccess elimina el acceso del usuario", () => {
    const d = db();
    const a = addUser(d, "a");
    const r = addRepo(d, "org", "wiki-rev");
    grantAccess(d, r.id, a.id, "owner");
    revokeAccess(d, r.id, a.id);

    expect(isMember(d, r.id, a.id)).toBe(false);
    expect(listReposForUser(d, a.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Backfill personal=1 en migración F1 — warning idempotente en re-runs
// ---------------------------------------------------------------------------
describe("backfill personal F1 — idempotencia del warning", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ceibo-store-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("personal=1 se setea en la 1ª apertura y se mantiene estable en la 2ª", () => {
    // Prepara una DB con dos usuarios: uno CON wiki personal y otro SIN ella.
    // Usa un archivo temp para poder abrir la misma DB dos veces (simula restart).
    const dbPath = join(tmpDir, "test.db");

    // 1ª apertura: crea el schema + corre la migración F1.
    const d1 = openDb(dbPath);
    const alice = addUser(d1, "alice");
    const bob = addUser(d1, "bob");

    // Alice tiene su wiki personal (nombre = '<handle>-personal', ella es owner)
    const alicePersonal = addRepo(d1, "org", "alice-personal");
    grantAccess(d1, alicePersonal.id, alice.id, "owner");

    // Bob NO tiene wiki personal (tiene una wiki con otro nombre)
    const bobOther = addRepo(d1, "org", "bob-notas");
    grantAccess(d1, bobOther.id, bob.id, "owner");

    d1.close();

    // 2ª apertura: simula restart del servicio — la migración F1 re-corre.
    const warnSpy2 = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const d2 = openDb(dbPath);
    const warnings2 = warnSpy2.mock.calls.map((c) => String(c[0]));
    warnSpy2.mockRestore();

    // Alice debe tener personal=1
    const aliceRepo2 = d2.prepare("SELECT personal FROM repos WHERE name = 'alice-personal'").get() as {
      personal: number;
    };
    expect(aliceRepo2.personal).toBe(1);

    // Bob no tiene wiki personal → debe warnear
    expect(warnings2.some((w) => w.includes("bob"))).toBe(true);
    // Alice no debe warnear
    expect(warnings2.some((w) => w.includes("alice"))).toBe(false);

    d2.close();

    // 3ª apertura: otra re-run de la migración (N-ésimo restart).
    const warnSpy3 = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const d3 = openDb(dbPath);
    const warnings3 = warnSpy3.mock.calls.map((c) => String(c[0]));
    warnSpy3.mockRestore();

    // personal=1 sigue intacto
    const aliceRepo3 = d3.prepare("SELECT personal FROM repos WHERE name = 'alice-personal'").get() as {
      personal: number;
    };
    expect(aliceRepo3.personal).toBe(1);

    // Los warnings son IDÉNTICOS a la 2ª corrida: bob warnea, alice no.
    expect(warnings3.some((w) => w.includes("bob"))).toBe(true);
    expect(warnings3.some((w) => w.includes("alice"))).toBe(false);

    // Mismo número de warnings F1 en ambas corridas (idempotente)
    const f1Warns2 = warnings2.filter((w) => w.includes("[store] migrate F1"));
    const f1Warns3 = warnings3.filter((w) => w.includes("[store] migrate F1"));
    expect(f1Warns3).toHaveLength(f1Warns2.length);

    d3.close();
  });
});
