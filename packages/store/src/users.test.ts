import { describe, expect, it } from "vitest";
import {
  addRepo,
  addUser,
  getUser,
  getUserActiveWiki,
  getUserAvatar,
  getUserBackendMode,
  getUserBgQueries,
  getUserByHandle,
  getUserDebug,
  getUserLang,
  getUserModel,
  getUserSpeech,
  grantAccess,
  listCoMembers,
  listUsers,
  openDb,
  renameUser,
  setDefaultProfile,
  setUserActiveWiki,
  setUserAvatar,
  setUserBackendMode,
  setUserBgQueries,
  setUserDebug,
  setUserLang,
  setUserLocalVault,
  setUserLocation,
  setUserModel,
  setUserName,
  setUserSpeech,
  setUserStatus,
  setUserVault,
  softDeleteRepo,
  userHasAvatar,
  vaultIdForUser,
} from "./index.ts";

const db = () => openDb(":memory:");

describe("alta y lookup", () => {
  it("addUser + getUser/getUserByHandle; defaults", () => {
    const d = db();
    const u = addUser(d, "demo", { name: "Alicia" });
    expect(u.handle).toBe("demo");
    expect(u.name).toBe("Alicia");
    expect(u.status).toBe("active");
    expect(getUser(d, u.id)?.handle).toBe("demo");
    expect(getUserByHandle(d, "demo")?.id).toBe(u.id);
    expect(getUser(d, 9999)).toBeUndefined();
  });

  it("usuario nuevo arranca con timezone 'UTC' (quickboot/sessions: lo usa el clear diario)", () => {
    const d = db();
    const u = addUser(d, "demo");
    expect(u.timezone).toBe("UTC");
    expect(getUser(d, u.id)?.timezone).toBe("UTC");
  });

  it("listUsers", () => {
    const d = db();
    addUser(d, "a");
    addUser(d, "b");
    expect(
      listUsers(d)
        .map((u) => u.handle)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});

describe("setters", () => {
  it("status / name / vault / rename", () => {
    const d = db();
    const u = addUser(d, "demo");
    setUserStatus(d, u.id, "disabled");
    expect(getUser(d, u.id)?.status).toBe("disabled");
    setUserName(d, u.id, "Nombre");
    expect(getUser(d, u.id)?.name).toBe("Nombre");
    setUserName(d, u.id, null);
    expect(getUser(d, u.id)?.name).toBeNull();
    setUserVault(d, u.id, "vault-1");
    expect(getUser(d, u.id)?.vault_id).toBe("vault-1");
    renameUser(d, u.id, "nuevo");
    expect(getUserByHandle(d, "nuevo")?.id).toBe(u.id);
    expect(getUserByHandle(d, "demo")).toBeUndefined();
  });

  it("location default null; set/get/clear", () => {
    const d = db();
    const u = addUser(d, "demo");
    expect(getUser(d, u.id)?.location).toBeNull();
    setUserLocation(d, u.id, "Buenos Aires, Argentina");
    expect(getUser(d, u.id)?.location).toBe("Buenos Aires, Argentina");
    setUserLocation(d, u.id, null);
    expect(getUser(d, u.id)?.location).toBeNull();
  });

  it("lang default 'es'; setUserLang cambia y resetea la voz", () => {
    const d = db();
    const u = addUser(d, "demo");
    expect(getUserLang(d, u.id)).toBe("es");
    setUserSpeech(d, u.id, { voice: "voz-es" });
    setUserLang(d, u.id, "en");
    expect(getUserLang(d, u.id)).toBe("en");
    expect(getUserSpeech(d, u.id).voice).toBeNull(); // la voz se reseteó al cambiar idioma
  });

  it("model default null; set/clear", () => {
    const d = db();
    const u = addUser(d, "demo");
    expect(getUserModel(d, u.id)).toBeNull();
    setUserModel(d, u.id, "opus");
    expect(getUserModel(d, u.id)).toBe("opus");
    setUserModel(d, u.id, null);
    expect(getUserModel(d, u.id)).toBeNull();
  });

  it("bg_queries default null; set/get/clear (null y lista vacía limpian)", () => {
    const d = db();
    const u = addUser(d, "demo");
    expect(getUserBgQueries(d, u.id)).toBeNull();
    setUserBgQueries(d, u.id, ["bosque al amanecer", "ceibo en flor"]);
    expect(getUserBgQueries(d, u.id)).toEqual(["bosque al amanecer", "ceibo en flor"]);
    setUserBgQueries(d, u.id, []);
    expect(getUserBgQueries(d, u.id)).toBeNull();
    setUserBgQueries(d, u.id, ["otra"]);
    setUserBgQueries(d, u.id, null);
    expect(getUserBgQueries(d, u.id)).toBeNull();
  });

  it("bg_queries con basura en la columna → null (no tira)", () => {
    const d = db();
    const u = addUser(d, "demo");
    const set = d.prepare("UPDATE users SET bg_queries = ? WHERE id = ?");
    set.run("no es json {", u.id); // JSON inválido
    expect(getUserBgQueries(d, u.id)).toBeNull();
    set.run('{"a":1}', u.id); // JSON pero no array
    expect(getUserBgQueries(d, u.id)).toBeNull();
    set.run('[1, true, "", "   "]', u.id); // array sin strings útiles
    expect(getUserBgQueries(d, u.id)).toBeNull();
    set.run('[" con espacios ", 7, "ok"]', u.id); // mezcla → sólo strings, trimmeadas
    expect(getUserBgQueries(d, u.id)).toEqual(["con espacios", "ok"]);
  });

  it("active_wiki y default_profile", () => {
    const d = db();
    const u = addUser(d, "demo");
    expect(getUserActiveWiki(d, u.id)).toBeNull();
    setUserActiveWiki(d, u.id, "demo-notas");
    expect(getUserActiveWiki(d, u.id)).toBe("demo-notas");
    setDefaultProfile(d, u.id, "work");
    expect(getUser(d, u.id)?.default_profile).toBe("work");
  });

  it("backend_mode default 'ma'; set 'local'; el CHECK rechaza inválidos", () => {
    const d = db();
    const u = addUser(d, "demo");
    expect(getUserBackendMode(d, u.id)).toBe("ma"); // default = Managed Agents
    expect(getUser(d, u.id)?.backend_mode).toBe("ma");
    setUserBackendMode(d, u.id, "local");
    expect(getUserBackendMode(d, u.id)).toBe("local");
    setUserBackendMode(d, u.id, "ma");
    expect(getUserBackendMode(d, u.id)).toBe("ma");
    // el CHECK del schema acota a 'ma'|'local' (bypaseamos el setter tipado a propósito)
    expect(() => d.prepare("UPDATE users SET backend_mode = ? WHERE id = ?").run("bogus", u.id)).toThrow();
  });

  it("en dev los usuarios nacen en backend 'local' (archima)", () => {
    const prev = process.env.CEIBO_ENV;
    process.env.CEIBO_ENV = "dev";
    try {
      const d = db();
      const u = addUser(d, "dev");
      expect(getUserBackendMode(d, u.id)).toBe("local");
    } finally {
      if (prev === undefined) delete process.env.CEIBO_ENV;
      else process.env.CEIBO_ENV = prev;
    }
  });

  it("local_vault_id default null; setUserLocalVault no pisa vault_id (cada backend su vault)", () => {
    const d = db();
    const u = addUser(d, "demo");
    expect(getUser(d, u.id)?.local_vault_id).toBeNull(); // default NULL (columna aditiva)
    // Vault MA y vault local conviven sin pisarse:
    setUserVault(d, u.id, "vlt_011Cbo_ma");
    setUserLocalVault(d, u.id, "508d20dc-local");
    expect(getUser(d, u.id)?.vault_id).toBe("vlt_011Cbo_ma");
    expect(getUser(d, u.id)?.local_vault_id).toBe("508d20dc-local");
  });

  it("vaultIdForUser elige el vault del backend ACTIVO (ma→vault_id, local→local_vault_id)", () => {
    const d = db();
    const u = addUser(d, "demo");
    setUserVault(d, u.id, "vlt_011Cbo_ma");
    setUserLocalVault(d, u.id, "508d20dc-local");
    // Default 'ma' → vault_id.
    expect(vaultIdForUser(getUser(d, u.id) as never)).toBe("vlt_011Cbo_ma");
    // 'local' → local_vault_id (NO el vault MA: ese es el bug que rompía el push al agent-vault).
    setUserBackendMode(d, u.id, "local");
    expect(vaultIdForUser(getUser(d, u.id) as never)).toBe("508d20dc-local");
    // local sin local_vault_id provisionado → null (el caller lo provisiona on-demand).
    const u2 = addUser(d, "esteban");
    setUserVault(d, u2.id, "vlt_only_ma");
    setUserBackendMode(d, u2.id, "local");
    expect(vaultIdForUser(getUser(d, u2.id) as never)).toBeNull();
  });

  it("debug_mode default off; set on/off; getUserDebug devuelve boolean", () => {
    const d = db();
    const u = addUser(d, "demo");
    expect(getUserDebug(d, u.id)).toBe(false); // default 0
    expect(getUser(d, u.id)?.debug_mode).toBe(0);
    setUserDebug(d, u.id, true);
    expect(getUserDebug(d, u.id)).toBe(true);
    expect(getUser(d, u.id)?.debug_mode).toBe(1);
    setUserDebug(d, u.id, false);
    expect(getUserDebug(d, u.id)).toBe(false);
  });

  it("avatar: vacío por default; set/get; userHasAvatar; clear", () => {
    const d = db();
    const u = addUser(d, "demo");
    // Default: sin avatar.
    expect(getUserAvatar(d, u.id)).toBeNull();
    expect(userHasAvatar(d, u.id)).toBe(false);
    // Set: blob + mime.
    const blob = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // header PNG
    setUserAvatar(d, u.id, blob, "image/png");
    const av = getUserAvatar(d, u.id);
    expect(av?.mime).toBe("image/png");
    expect(av?.blob.equals(blob)).toBe(true);
    expect(userHasAvatar(d, u.id)).toBe(true);
    // Clear: null/null → vuelve a sin avatar.
    setUserAvatar(d, u.id, null, null);
    expect(getUserAvatar(d, u.id)).toBeNull();
    expect(userHasAvatar(d, u.id)).toBe(false);
  });

  it("setUserSpeech actualiza solo los campos pasados (patch)", () => {
    const d = db();
    const u = addUser(d, "demo");
    setUserSpeech(d, u.id, { voice: "v1", rate: "+10%" });
    setUserSpeech(d, u.id, { pitch: "-2st" }); // no toca voice/rate
    const s = getUserSpeech(d, u.id);
    expect(s).toEqual({ voice: "v1", rate: "+10%", pitch: "-2st", volume: null });
  });
});

describe("listCoMembers — directorio restringido (P6)", () => {
  it("devuelve co-miembros de wikis activas, excluye al caller", () => {
    const d = db();
    const alice = addUser(d, "alice");
    const bob = addUser(d, "bob");
    const carol = addUser(d, "carol");
    const repo = addRepo(d, "org", "wiki-compartida");
    grantAccess(d, repo.id, alice.id, "owner");
    grantAccess(d, repo.id, bob.id, "member");
    grantAccess(d, repo.id, carol.id, "member");
    const members = listCoMembers(d, alice.id);
    const handles = members.map((u) => u.handle).sort();
    expect(handles).toEqual(["bob", "carol"]);
    // alice (el caller) no aparece
    expect(members.some((u) => u.handle === "alice")).toBe(false);
  });

  it("excluye usuarios inactivos aunque sean co-miembros", () => {
    const d = db();
    const alice = addUser(d, "alice");
    const bob = addUser(d, "bob");
    setUserStatus(d, bob.id, "disabled");
    const repo = addRepo(d, "org", "wiki-compartida");
    grantAccess(d, repo.id, alice.id, "owner");
    grantAccess(d, repo.id, bob.id, "member");
    expect(listCoMembers(d, alice.id)).toHaveLength(0);
  });

  it("excluye co-membresía en repos soft-borrados (deleted_at)", () => {
    const d = db();
    const alice = addUser(d, "alice");
    const bob = addUser(d, "bob");
    const repo = addRepo(d, "org", "wiki-borrada");
    grantAccess(d, repo.id, alice.id, "owner");
    grantAccess(d, repo.id, bob.id, "member");
    softDeleteRepo(d, repo.id);
    expect(listCoMembers(d, alice.id)).toHaveLength(0);
  });

  it("lista vacía si el caller no comparte ninguna wiki con nadie", () => {
    const d = db();
    const alice = addUser(d, "alice");
    addUser(d, "bob"); // existe pero no comparte nada con alice
    expect(listCoMembers(d, alice.id)).toHaveLength(0);
  });

  it("un usuario compartido en varias wikis aparece una sola vez (DISTINCT)", () => {
    const d = db();
    const alice = addUser(d, "alice");
    const bob = addUser(d, "bob");
    const repo1 = addRepo(d, "org", "wiki-1");
    const repo2 = addRepo(d, "org", "wiki-2");
    grantAccess(d, repo1.id, alice.id, "owner");
    grantAccess(d, repo1.id, bob.id, "member");
    grantAccess(d, repo2.id, alice.id, "owner");
    grantAccess(d, repo2.id, bob.id, "member");
    const members = listCoMembers(d, alice.id);
    expect(members).toHaveLength(1);
    expect(members[0]?.handle).toBe("bob");
  });

  it("co-membresía en repo archivado per-user sigue contando (archived_at no es deleted_at)", () => {
    const d = db();
    const alice = addUser(d, "alice");
    const bob = addUser(d, "bob");
    const repo = addRepo(d, "org", "wiki-archivada");
    grantAccess(d, repo.id, alice.id, "owner");
    grantAccess(d, repo.id, bob.id, "member");
    // archivar solo para alice (per-user, no soft-delete global)
    d.prepare("UPDATE repo_access SET archived_at = datetime('now') WHERE repo_id = ? AND user_id = ?").run(
      repo.id,
      alice.id,
    );
    // El repo no tiene deleted_at → la co-membresía sigue siendo válida
    const members = listCoMembers(d, alice.id);
    expect(members.some((u) => u.handle === "bob")).toBe(true);
  });
});
