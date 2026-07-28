import { describe, expect, it } from "vitest";
import {
  addRepo,
  addUser,
  firstUserForRepo,
  getRepoByName,
  getUserActiveWiki,
  grantAccess,
  listAllRepos,
  listReposForUser,
  openDb,
  removeRepo,
  renameRepoInStore,
  revokeAccess,
  setRepoLabel,
  setRepoPersonal,
  setUserActiveWiki,
  setUserStatus,
  usersForRepo,
} from "./index.ts";

const db = () => openDb(":memory:");

describe("repos CRUD", () => {
  it("addRepo + getRepoByName", () => {
    const d = db();
    const r = addRepo(d, "ceibofamily", "demo-notas", "notas");
    expect(r.org).toBe("ceibofamily");
    expect(r.name).toBe("demo-notas");
    expect(r.label).toBe("notas");
    expect(getRepoByName(d, "ceibofamily", "demo-notas")?.id).toBe(r.id);
    expect(getRepoByName(d, "ceibofamily", "noexiste")).toBeUndefined();
  });

  it("addRepo sin label → label null", () => {
    const d = db();
    expect(addRepo(d, "o", "r").label).toBeNull();
  });

  it("setRepoLabel setea y limpia", () => {
    const d = db();
    const r = addRepo(d, "o", "r");
    setRepoLabel(d, r.id, "alias");
    expect(getRepoByName(d, "o", "r")?.label).toBe("alias");
    setRepoLabel(d, r.id, null);
    expect(getRepoByName(d, "o", "r")?.label).toBeNull();
  });

  it("setRepoPersonal marca la wiki personal del dueño y garantiza una sola por dueño", () => {
    const d = db();
    const u = addUser(d, "demo-gpuhost");
    // Usuario renombrado: su wiki personal quedó con el nombre viejo ('demo-personal'), más otra.
    const personal = addRepo(d, "o", "demo-personal");
    const otra = addRepo(d, "o", "demo-ceibo");
    grantAccess(d, personal.id, u.id, "owner");
    grantAccess(d, otra.id, u.id, "owner");
    expect(getRepoByName(d, "o", "demo-personal")?.personal).toBe(0);

    setRepoPersonal(d, personal.id);
    expect(getRepoByName(d, "o", "demo-personal")?.personal).toBe(1);
    expect(getRepoByName(d, "o", "demo-ceibo")?.personal).toBe(0);

    // Cambiarla a otra wiki flipea: la anterior vuelve a 0 (una sola personal por dueño).
    setRepoPersonal(d, otra.id);
    expect(getRepoByName(d, "o", "demo-ceibo")?.personal).toBe(1);
    expect(getRepoByName(d, "o", "demo-personal")?.personal).toBe(0);
  });

  it("listAllRepos ordena por org, name", () => {
    const d = db();
    addRepo(d, "o", "zeta");
    addRepo(d, "o", "alfa");
    expect(listAllRepos(d).map((r) => r.name)).toEqual(["alfa", "zeta"]);
  });

  it("removeRepo borra", () => {
    const d = db();
    const r = addRepo(d, "o", "r");
    removeRepo(d, r.id);
    expect(getRepoByName(d, "o", "r")).toBeUndefined();
  });

  it("renameRepoInStore renombra + repunta active_wiki que apuntaba al nombre viejo", () => {
    const d = db();
    const u = addUser(d, "demo");
    const r = addRepo(d, "o", "viejo");
    setUserActiveWiki(d, u.id, "viejo");
    renameRepoInStore(d, r.id, "viejo", "nuevo", "Nuevo");
    expect(getRepoByName(d, "o", "nuevo")?.label).toBe("Nuevo");
    expect(getUserActiveWiki(d, u.id)).toBe("nuevo");
  });
});

describe("acceso N:N", () => {
  it("grant/revoke + listReposForUser + usersForRepo", () => {
    const d = db();
    const a = addUser(d, "a");
    const b = addUser(d, "b");
    const r = addRepo(d, "o", "compartida");
    grantAccess(d, r.id, a.id);
    grantAccess(d, r.id, b.id);
    grantAccess(d, r.id, a.id); // idempotente
    expect(listReposForUser(d, a.id).map((x) => x.name)).toEqual(["compartida"]);
    expect(
      usersForRepo(d, r.id)
        .map((x) => x.handle)
        .sort(),
    ).toEqual(["a", "b"]);
    revokeAccess(d, r.id, b.id);
    expect(usersForRepo(d, r.id).map((x) => x.handle)).toEqual(["a"]);
  });

  it("firstUserForRepo = primer usuario ACTIVO con acceso (por orden de alta)", () => {
    const d = db();
    const a = addUser(d, "a");
    const b = addUser(d, "b");
    const r = addRepo(d, "o", "r");
    grantAccess(d, r.id, a.id);
    grantAccess(d, r.id, b.id);
    expect(firstUserForRepo(d, r.id)?.handle).toBe("a");
    setUserStatus(d, a.id, "disabled");
    expect(firstUserForRepo(d, r.id)?.handle).toBe("b"); // saltea al inactivo
  });

  it("firstUserForRepo undefined si nadie activo tiene acceso", () => {
    const d = db();
    const r = addRepo(d, "o", "r");
    expect(firstUserForRepo(d, r.id)).toBeUndefined();
  });
});
