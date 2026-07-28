import { describe, expect, it } from "vitest";
import {
  addAuthorizedEmail,
  addUser,
  getAuthorizedEmail,
  getUserBackendMode,
  getUserByHandle,
  listChannels,
  openDb,
  registerEmailUserIfAuthorized,
  registerGoogleUserIfAuthorized,
  removeAuthorizedEmail,
  resolveUser,
  setUserStatus,
} from "./index.ts";

const db = () => openDb(":memory:");

describe("registerEmailUserIfAuthorized — gate de signup/login por mail", () => {
  it("NO autorizado → undefined, no crea ningún usuario", () => {
    const d = db();
    expect(registerEmailUserIfAuthorized(d, "intruso@x.com")).toBeUndefined();
    expect(getUserByHandle(d, "intruso")).toBeUndefined();
  });

  it("autorizado sin cuenta → crea user local + identidad email + marca used_at", () => {
    const d = db();
    addAuthorizedEmail(d, "  Maria@Gmail.com ", { name: "Maria Jose", handle: "maria" });
    const reg = registerEmailUserIfAuthorized(d, "maria@gmail.com");
    expect(reg?.created).toBe(true);
    const user = reg?.user;
    if (!user) throw new Error("sin user");
    expect(user.status).toBe("active");
    expect(getUserBackendMode(d, user.id)).toBe("local"); // "vamos todos a archima"
    expect(user.handle).toBe("maria");
    expect(user.name).toBe("Maria Jose");
    expect(
      listChannels(d, user.id).some((c) => c.channel === "email" && c.external_id === "maria@gmail.com"),
    ).toBe(true);
    expect(getAuthorizedEmail(d, "maria@gmail.com")?.used_at).not.toBeNull();
    expect(resolveUser(d, "email", "maria@gmail.com")?.id).toBe(user.id);
  });

  it("normaliza el email (mayúsculas + espacios) al crear y al resolver", () => {
    const d = db();
    addAuthorizedEmail(d, "k@x.com");
    const reg = registerEmailUserIfAuthorized(d, "  K@X.com  ");
    expect(reg?.created).toBe(true);
    // segunda llamada con otro casing → idempotente, no duplica
    const again = registerEmailUserIfAuthorized(d, "k@x.com");
    expect(again?.created).toBe(false);
    expect(again?.user.id).toBe(reg?.user.id);
    expect(listChannels(d, reg?.user.id ?? -1).filter((c) => c.channel === "email")).toHaveLength(1);
  });

  it("usuario que ya entró por Google → UNIFICA la cuenta (created:false) y le suma la identidad email", () => {
    const d = db();
    addAuthorizedEmail(d, "ana@gmail.com");
    const g = registerGoogleUserIfAuthorized(d, "ana@gmail.com");
    if (!g) throw new Error("sin reg google");
    // misma persona vuelve por mail: NO crea otra cuenta, reusa la de Google
    const reg = registerEmailUserIfAuthorized(d, "ana@gmail.com");
    expect(reg?.created).toBe(false);
    expect(reg?.user.id).toBe(g.user.id);
    // ahora resuelve por AMBOS canales contra el mismo usuario
    expect(resolveUser(d, "google", "ana@gmail.com")?.id).toBe(g.user.id);
    expect(resolveUser(d, "email", "ana@gmail.com")?.id).toBe(g.user.id);
    // y la identidad email se agregó una sola vez (idempotente en llamadas repetidas)
    registerEmailUserIfAuthorized(d, "ana@gmail.com");
    expect(listChannels(d, g.user.id).filter((c) => c.channel === "email")).toHaveLength(1);
  });

  it("colisión de handle → desambigua con sufijo", () => {
    const d = db();
    addUser(d, "pedro", { name: "Pedro existente" });
    addAuthorizedEmail(d, "pedro@x.com");
    const reg = registerEmailUserIfAuthorized(d, "pedro@x.com");
    expect(reg?.user.handle).toBe("pedro-2");
  });

  it("usuario disabled con identidad email + autorizado → re-activa, mismo user, sin crash", () => {
    const d = db();
    addAuthorizedEmail(d, "susi@x.com");
    const reg = registerEmailUserIfAuthorized(d, "susi@x.com");
    if (!reg) throw new Error("sin reg");
    setUserStatus(d, reg.user.id, "disabled");
    // Re-login por email: re-activa sin duplicar.
    const relogin = registerEmailUserIfAuthorized(d, "susi@x.com");
    expect(relogin).toBeDefined();
    expect(relogin?.user.id).toBe(reg.user.id); // MISMO usuario
    expect(relogin?.user.status).toBe("active"); // re-activado
    expect(relogin?.created).toBe(false);
    expect(listChannels(d, reg.user.id).filter((c) => c.channel === "email")).toHaveLength(1);
  });

  it("usuario disabled con identidad email + NO autorizado → undefined, sigue disabled, sin crash", () => {
    const d = db();
    addAuthorizedEmail(d, "ex@x.com");
    const reg = registerEmailUserIfAuthorized(d, "ex@x.com");
    if (!reg) throw new Error("sin reg");
    setUserStatus(d, reg.user.id, "disabled");
    removeAuthorizedEmail(d, "ex@x.com");
    const relogin = registerEmailUserIfAuthorized(d, "ex@x.com");
    expect(relogin).toBeUndefined();
    expect(getUserByHandle(d, reg.user.handle)?.status).toBe("disabled");
    expect(listChannels(d, reg.user.id).filter((c) => c.channel === "email")).toHaveLength(1);
  });

  it("usuario disabled con identidad google (no email) + autorizado → re-activa y agrega identidad email", () => {
    const d = db();
    addAuthorizedEmail(d, "goo@x.com");
    // Entró solo por Google, luego fue deshabilitado.
    const greg = registerGoogleUserIfAuthorized(d, "goo@x.com");
    if (!greg) throw new Error("sin reg google");
    setUserStatus(d, greg.user.id, "disabled");
    // Re-login por email: unifica con la cuenta google disabled y la re-activa.
    const relogin = registerEmailUserIfAuthorized(d, "goo@x.com");
    expect(relogin).toBeDefined();
    expect(relogin?.user.id).toBe(greg.user.id); // MISMO usuario (unificación)
    expect(relogin?.user.status).toBe("active"); // re-activado
    expect(relogin?.created).toBe(false);
    // La identidad email fue agregada.
    expect(
      listChannels(d, greg.user.id).some((c) => c.channel === "email" && c.external_id === "goo@x.com"),
    ).toBe(true);
  });
});
