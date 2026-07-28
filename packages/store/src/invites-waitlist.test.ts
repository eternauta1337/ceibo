/**
 * Tests P1 — invitaciones + waitlist (store layer).
 * Scope: waiting_list CRUD, accept_token en wiki_invites, users.admin.
 * Sin chrome, sin servidor: puro vitest sobre DB in-memory.
 */
import { describe, expect, it } from "vitest";
import {
  addInvite,
  addRepo,
  addToWaitingList,
  addUser,
  approveWaitingEmail,
  getAuthorizedEmail,
  getInviteByToken,
  getWaitingEntry,
  grantAccess,
  isAdmin,
  listWaitingList,
  openDb,
  rejectWaitingEmail,
  setAdmin,
} from "./index.ts";

const db = () => openDb(":memory:");

// ---------------------------------------------------------------------------
// accept_token en wiki_invites
// ---------------------------------------------------------------------------

describe("wiki_invites.accept_token", () => {
  it("addInvite genera un accept_token no vacío", () => {
    const d = db();
    const owner = addUser(d, "owner");
    const repo = addRepo(d, "acme", "acme-personal");
    grantAccess(d, repo.id, owner.id, "owner");
    const inv = addInvite(d, repo.id, "guest@example.com", owner.id);
    expect(inv.accept_token).toBeTruthy();
    expect(typeof inv.accept_token).toBe("string");
    // hex 32 chars (16 bytes × 2)
    expect(inv.accept_token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("addInvite idempotente — segundo call conserva el token original (ON CONFLICT DO NOTHING)", () => {
    const d = db();
    const owner = addUser(d, "owner2");
    const repo = addRepo(d, "acme2", "acme2-personal");
    grantAccess(d, repo.id, owner.id, "owner");
    const inv1 = addInvite(d, repo.id, "guest2@example.com", owner.id);
    const inv2 = addInvite(d, repo.id, "guest2@example.com", owner.id);
    expect(inv2.accept_token).toBe(inv1.accept_token);
  });

  it("getInviteByToken devuelve la fila correcta", () => {
    const d = db();
    const owner = addUser(d, "owner3");
    const repo = addRepo(d, "acme3", "acme3-personal");
    grantAccess(d, repo.id, owner.id, "owner");
    const inv = addInvite(d, repo.id, "tok@example.com", owner.id);
    if (!inv.accept_token) throw new Error("accept_token debería existir");
    const found = getInviteByToken(d, inv.accept_token);
    expect(found).toBeDefined();
    expect(found?.email).toBe("tok@example.com");
    expect(found?.repo_id).toBe(repo.id);
  });

  it("getInviteByToken devuelve undefined para token inexistente", () => {
    const d = db();
    expect(getInviteByToken(d, "0000000000000000000000000000ffff")).toBeUndefined();
  });

  it("tokens de dos invites distintos son diferentes", () => {
    const d = db();
    const owner = addUser(d, "owner4");
    const r1 = addRepo(d, "org4", "repo4a");
    const r2 = addRepo(d, "org4", "repo4b");
    grantAccess(d, r1.id, owner.id, "owner");
    grantAccess(d, r2.id, owner.id, "owner");
    const inv1 = addInvite(d, r1.id, "multi@example.com", owner.id);
    const inv2 = addInvite(d, r2.id, "multi@example.com", owner.id);
    expect(inv1.accept_token).not.toBe(inv2.accept_token);
  });
});

// ---------------------------------------------------------------------------
// waiting_list: add idempotente
// ---------------------------------------------------------------------------

describe("addToWaitingList — idempotencia y provenance", () => {
  it("primera llamada crea la fila y devuelve alreadyWaiting:false", () => {
    const d = db();
    const res = addToWaitingList(d, "new@example.com");
    expect(res.alreadyWaiting).toBe(false);
    expect(res.entry.email).toBe("new@example.com");
    expect(res.entry.status).toBe("pending");
    expect(res.entry.source).toBe("self-signup");
  });

  it("email normalizado a lowercase", () => {
    const d = db();
    const res = addToWaitingList(d, "  FOO@BAR.COM  ");
    expect(res.entry.email).toBe("foo@bar.com");
  });

  it("segunda llamada NO duplica (alreadyWaiting:true)", () => {
    const d = db();
    addToWaitingList(d, "dup@example.com");
    const second = addToWaitingList(d, "dup@example.com");
    expect(second.alreadyWaiting).toBe(true);
    // la lista tiene exactamente una fila para ese email
    const list = listWaitingList(d);
    const count = list.filter((r) => r.email === "dup@example.com").length;
    expect(count).toBe(1);
  });

  it("source e invited_by se guardan y se leen bien (self-signup)", () => {
    const d = db();
    const res = addToWaitingList(d, "selfup@example.com", { source: "self-signup" });
    expect(res.entry.source).toBe("self-signup");
    expect(res.entry.invited_by).toBeNull();
  });

  it("provenance automática: si hay wiki_invite pendiente, source='invited' + invited_by del invite", () => {
    const d = db();
    const owner = addUser(d, "provowner");
    const repo = addRepo(d, "provorg", "provorg-personal");
    grantAccess(d, repo.id, owner.id, "owner");
    addInvite(d, repo.id, "provguest@example.com", owner.id);
    // addToWaitingList sin opts → detecta el invite y pone source='invited'
    const res = addToWaitingList(d, "provguest@example.com");
    expect(res.entry.source).toBe("invited");
    expect(res.entry.invited_by).toBe(owner.id);
  });

  it("source='invited' explícito + invitedBy se respetan cuando no hay invite pendiente", () => {
    const d = db();
    const inviter = addUser(d, "explicit-inviter");
    const res = addToWaitingList(d, "expl@example.com", {
      source: "invited",
      invitedBy: inviter.id,
    });
    expect(res.entry.source).toBe("invited");
    expect(res.entry.invited_by).toBe(inviter.id);
  });
});

// ---------------------------------------------------------------------------
// waiting_list: approve (transacción → authorized_emails)
// ---------------------------------------------------------------------------

describe("approveWaitingEmail", () => {
  it("aprueba y mete en authorized_emails (transacción)", () => {
    const d = db();
    const admin = addUser(d, "admin-user");
    addToWaitingList(d, "toapprove@example.com");
    const entry = approveWaitingEmail(d, "toapprove@example.com", admin.id);
    expect(entry.status).toBe("approved");
    expect(entry.reviewed_by).toBe(admin.id);
    expect(entry.reviewed_at).toBeTruthy();
    // el email DEBE estar ahora en authorized_emails
    const auth = getAuthorizedEmail(d, "toapprove@example.com");
    expect(auth).toBeDefined();
    expect(auth?.email).toBe("toapprove@example.com");
  });

  it("approve con opts.name/handle → se pasan como seeds a authorized_emails", () => {
    const d = db();
    const admin = addUser(d, "admin-seeds");
    addToWaitingList(d, "seeds@example.com");
    approveWaitingEmail(d, "seeds@example.com", admin.id, { name: "Juanita", handle: "juani" });
    const auth = getAuthorizedEmail(d, "seeds@example.com");
    expect(auth?.name).toBe("Juanita");
    expect(auth?.handle).toBe("juani");
  });

  it("approve idempotente — re-aprobar no rompe, actualiza reviewed_*", () => {
    const d = db();
    const admin = addUser(d, "admin-idem");
    addToWaitingList(d, "idem@example.com");
    approveWaitingEmail(d, "idem@example.com", admin.id);
    // re-aprobar debe no lanzar
    expect(() => approveWaitingEmail(d, "idem@example.com", admin.id)).not.toThrow();
    // solo 1 fila en authorized_emails
    const auth = getAuthorizedEmail(d, "idem@example.com");
    expect(auth).toBeDefined();
  });

  it("approve de email no en waiting_list aún pone en authorized_emails (getWaitingEntry devuelve undefined)", () => {
    const d = db();
    const admin = addUser(d, "admin-bypass");
    // bypass: no existe en waiting_list
    approveWaitingEmail(d, "bypass@example.com", admin.id);
    expect(getAuthorizedEmail(d, "bypass@example.com")).toBeDefined();
    // pero la fila de waiting_list quedó vacía (UPDATE afecta 0 rows → sin fila creada)
    expect(getWaitingEntry(d, "bypass@example.com")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// waiting_list: reject
// ---------------------------------------------------------------------------

describe("rejectWaitingEmail", () => {
  it("rechaza la fila y NO toca authorized_emails", () => {
    const d = db();
    const admin = addUser(d, "admin-rej");
    addToWaitingList(d, "toreject@example.com");
    const entry = rejectWaitingEmail(d, "toreject@example.com", admin.id);
    expect(entry.status).toBe("rejected");
    expect(entry.reviewed_by).toBe(admin.id);
    expect(getAuthorizedEmail(d, "toreject@example.com")).toBeUndefined();
  });

  it("rechazado que vuelve a llamar addToWaitingList → alreadyWaiting:true (no re-pendea)", () => {
    const d = db();
    const admin = addUser(d, "admin-rej2");
    addToWaitingList(d, "rej2@example.com");
    rejectWaitingEmail(d, "rej2@example.com", admin.id);
    const res = addToWaitingList(d, "rej2@example.com");
    expect(res.alreadyWaiting).toBe(true);
    expect(res.entry.status).toBe("rejected"); // sigue rechazado
  });
});

// ---------------------------------------------------------------------------
// listWaitingList — devuelve source + invitador + wikis pendientes
// ---------------------------------------------------------------------------

describe("listWaitingList", () => {
  it("devuelve source, invitador (handle) y pending_wikis vacío para self-signup", () => {
    const d = db();
    addToWaitingList(d, "listme@example.com");
    const list = listWaitingList(d);
    const row = list.find((r) => r.email === "listme@example.com");
    expect(row).toBeDefined();
    expect(row?.source).toBe("self-signup");
    expect(row?.inviter_handle).toBeNull();
    expect(row?.pending_wikis).toHaveLength(0);
  });

  it("devuelve inviter_handle y pending_wikis para invited", () => {
    const d = db();
    const owner = addUser(d, "list-owner");
    const repo = addRepo(d, "listorg", "listorg-personal");
    grantAccess(d, repo.id, owner.id, "owner");
    addInvite(d, repo.id, "listguest@example.com", owner.id);
    addToWaitingList(d, "listguest@example.com");
    const list = listWaitingList(d);
    const row = list.find((r) => r.email === "listguest@example.com");
    expect(row?.source).toBe("invited");
    expect(row?.inviter_handle).toBe("list-owner");
    expect(row?.pending_wikis).toHaveLength(1);
    expect(row?.pending_wikis[0]?.org).toBe("listorg");
    expect(row?.pending_wikis[0]?.name).toBe("listorg-personal");
  });

  it("filtra por status correctamente", () => {
    const d = db();
    const admin = addUser(d, "list-admin");
    addToWaitingList(d, "pend@example.com");
    addToWaitingList(d, "appr@example.com");
    approveWaitingEmail(d, "appr@example.com", admin.id);
    const pending = listWaitingList(d, { status: "pending" });
    expect(pending.some((r) => r.email === "pend@example.com")).toBe(true);
    expect(pending.some((r) => r.email === "appr@example.com")).toBe(false);
    const approved = listWaitingList(d, { status: "approved" });
    expect(approved.some((r) => r.email === "appr@example.com")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAdmin / setAdmin
// ---------------------------------------------------------------------------

describe("isAdmin / setAdmin", () => {
  it("usuario nuevo NO es admin por defecto", () => {
    const d = db();
    const u = addUser(d, "notadmin");
    expect(isAdmin(d, u.id)).toBe(false);
  });

  it("setAdmin(true) → isAdmin devuelve true", () => {
    const d = db();
    const u = addUser(d, "makeadmin");
    setAdmin(d, u.id, true);
    expect(isAdmin(d, u.id)).toBe(true);
  });

  it("setAdmin(false) → isAdmin devuelve false de nuevo", () => {
    const d = db();
    const u = addUser(d, "revokadmin");
    setAdmin(d, u.id, true);
    setAdmin(d, u.id, false);
    expect(isAdmin(d, u.id)).toBe(false);
  });

  it("isAdmin de userId inexistente devuelve false (no lanza)", () => {
    const d = db();
    expect(isAdmin(d, 99999)).toBe(false);
  });
});
