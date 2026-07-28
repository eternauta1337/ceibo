import { describe, expect, it } from "vitest";
import {
  addUser,
  adminCancelCron,
  type CronRow,
  cancelCron,
  completeCron,
  createCron,
  deriveCronTitle,
  getCron,
  isValidCron,
  listCrons,
  listCronsDue,
  listCronsForUser,
  type NewCron,
  nextFireFrom,
  openDb,
  pruneCrons,
  rescheduleCron,
  updateCron,
  viewCron,
} from "./index.ts";

const setup = () => {
  const d = openDb(":memory:");
  const u = addUser(d, "demo");
  return { d, uid: u.id };
};
const newCron = (uid: number, over: Partial<NewCron> = {}): NewCron => ({
  userId: uid,
  channel: "telegram",
  what: "recordar algo",
  kind: "once",
  nextFire: "2030-01-01T09:00:00.000Z",
  ...over,
});

describe("createCron / getCron", () => {
  it("crea con defaults (report=always, tz=UTC) y getCron la trae", () => {
    const { d, uid } = setup();
    const row = createCron(d, newCron(uid));
    expect(row.report).toBe("always");
    expect(row.tz).toBe("UTC");
    expect(row.status).toBe("active");
    expect(getCron(d, row.id)?.what).toBe("recordar algo");
  });
});

describe("listados", () => {
  it("listCronsDue: solo activos con next_fire <= now", () => {
    const { d, uid } = setup();
    createCron(d, newCron(uid, { nextFire: "2020-01-01T00:00:00.000Z" })); // vencido
    createCron(d, newCron(uid, { nextFire: "2099-01-01T00:00:00.000Z" })); // futuro
    const due = listCronsDue(d, "2026-01-01T00:00:00.000Z");
    expect(due).toHaveLength(1);
    expect(due[0]?.next_fire).toBe("2020-01-01T00:00:00.000Z");
  });

  it("listCronsForUser: solo activos del usuario", () => {
    const { d, uid } = setup();
    const other = addUser(d, "otro").id;
    createCron(d, newCron(uid));
    createCron(d, newCron(other));
    expect(listCronsForUser(d, uid)).toHaveLength(1);
  });
});

describe("cancel / complete / reschedule / prune", () => {
  it("cancelCron acotado al dueño", () => {
    const { d, uid } = setup();
    const other = addUser(d, "otro").id;
    const c = createCron(d, newCron(uid));
    expect(cancelCron(d, c.id, other)).toBe(false); // no es suyo
    expect(cancelCron(d, c.id, uid)).toBe(true);
    expect(cancelCron(d, c.id, uid)).toBe(false); // ya cancelado
  });

  it("adminCancelCron sin scope de usuario", () => {
    const { d, uid } = setup();
    const c = createCron(d, newCron(uid));
    expect(adminCancelCron(d, c.id)).toBe(true);
    expect(adminCancelCron(d, c.id)).toBe(false);
  });

  it("completeCron marca done; listCrons muestra todos los estados", () => {
    const { d, uid } = setup();
    const c = createCron(d, newCron(uid));
    completeCron(d, c.id);
    expect(getCron(d, c.id)?.status).toBe("done");
    expect(listCrons(d, uid)).toHaveLength(1); // incluye done
    expect(listCronsForUser(d, uid)).toHaveLength(0); // solo activos
  });

  it("rescheduleCron mueve next_fire", () => {
    const { d, uid } = setup();
    const c = createCron(d, newCron(uid, { kind: "recur", recurExpr: "0 9 * * *" }));
    rescheduleCron(d, c.id, "2031-02-02T09:00:00.000Z");
    expect(getCron(d, c.id)?.next_fire).toBe("2031-02-02T09:00:00.000Z");
  });

  it("pruneCrons borra los terminados y devuelve la cuenta", () => {
    const { d, uid } = setup();
    const a = createCron(d, newCron(uid));
    createCron(d, newCron(uid)); // queda activo
    completeCron(d, a.id);
    expect(pruneCrons(d)).toBe(1);
    expect(listCrons(d)).toHaveLength(1);
  });
});

describe("helpers de recurrencia (puros)", () => {
  it("isValidCron acepta válidos y rechaza basura/tz inválida", () => {
    expect(isValidCron("0 9 * * *")).toBe(true);
    expect(isValidCron("0 9 * * 1", "America/Argentina/Buenos_Aires")).toBe(true);
    expect(isValidCron("no-cron")).toBe(false);
    expect(isValidCron("0 9 * * *", "Zona/Inexistente")).toBe(false);
  });

  it("nextFireFrom devuelve un ISO estrictamente posterior al after", () => {
    const next = nextFireFrom("0 9 * * *", "UTC", "2026-06-01T00:00:00.000Z");
    expect(next).toBe("2026-06-01T09:00:00.000Z");
  });
});

describe("updateCron (edición desde la UI)", () => {
  it("edita el texto, acotado al dueño", () => {
    const { d, uid } = setup();
    const other = addUser(d, "otro").id;
    const c = createCron(d, newCron(uid, { what: "viejo" }));
    expect(updateCron(d, c.id, other, { what: "ajeno" })).toBe(false); // no es suyo
    expect(updateCron(d, c.id, uid, { what: "nuevo" })).toBe(true);
    expect(getCron(d, c.id)?.what).toBe("nuevo");
  });

  it("cambia once → recur (kind + recur_expr + next_fire)", () => {
    const { d, uid } = setup();
    const c = createCron(d, newCron(uid)); // once
    const next = nextFireFrom("0 9 * * *", "UTC", "2026-06-01T00:00:00.000Z");
    expect(updateCron(d, c.id, uid, { kind: "recur", recurExpr: "0 9 * * *", nextFire: next })).toBe(true);
    const row = getCron(d, c.id);
    expect(row?.kind).toBe("recur");
    expect(row?.recur_expr).toBe("0 9 * * *");
    expect(row?.next_fire).toBe(next);
  });

  it("cambia el canal de entrega", () => {
    const { d, uid } = setup();
    const c = createCron(d, newCron(uid)); // channel 'telegram'
    expect(updateCron(d, c.id, uid, { channel: "all" })).toBe(true);
    expect(getCron(d, c.id)?.channel).toBe("all");
    expect(viewCron(getCron(d, c.id) as CronRow).channel).toBe("all");
  });

  it("cambia el formato de aviso (report)", () => {
    const { d, uid } = setup();
    const c = createCron(d, newCron(uid)); // report 'always' por default
    expect(updateCron(d, c.id, uid, { report: "never" })).toBe(true);
    expect(getCron(d, c.id)?.report).toBe("never");
  });

  it("sin campos no toca nada", () => {
    const { d, uid } = setup();
    const c = createCron(d, newCron(uid));
    expect(updateCron(d, c.id, uid, {})).toBe(false);
  });

  it("no edita un cron cancelado", () => {
    const { d, uid } = setup();
    const c = createCron(d, newCron(uid));
    cancelCron(d, c.id, uid);
    expect(updateCron(d, c.id, uid, { what: "x" })).toBe(false);
  });
});

describe("viewCron (presentación)", () => {
  it("one-shot: recurHuman null, expone next_fire crudo y legible", () => {
    const { d, uid } = setup();
    const c = createCron(d, newCron(uid, { what: "llamar al pediatra" }));
    const v = viewCron(getCron(d, c.id) as CronRow);
    expect(v.kind).toBe("once");
    expect(v.recurHuman).toBeNull();
    expect(v.what).toBe("llamar al pediatra");
    expect(v.nextFireIso).toBe("2030-01-01T09:00:00.000Z");
    expect(v.nextHuman).toMatch(/\d/); // algún string legible con dígitos
    // no filtra internals
    expect(v).not.toHaveProperty("user_id");
  });

  it("recurrente: recurHuman en español", () => {
    const { d, uid } = setup();
    const c = createCron(d, newCron(uid, { kind: "recur", recurExpr: "0 9 * * *" }));
    const v = viewCron(getCron(d, c.id) as CronRow);
    expect(v.kind).toBe("recur");
    expect(v.recurHuman).toContain("09:00"); // "A las 09:00"
  });

  it("tz inválida no rompe (cae a ISO)", () => {
    const { d, uid } = setup();
    const c = createCron(d, newCron(uid, { tz: "Zona/Inexistente" }));
    const v = viewCron(getCron(d, c.id) as CronRow);
    expect(typeof v.nextHuman).toBe("string");
    expect(v.nextHuman.length).toBeGreaterThan(0);
  });
});

describe("títulos de crons", () => {
  it("deriveCronTitle: primera línea, colapsa espacios y trunca", () => {
    expect(deriveCronTitle("Recordar el dentista")).toBe("Recordar el dentista");
    expect(deriveCronTitle("\n\n  primera   línea\nsegunda")).toBe("primera línea");
    const long = "a".repeat(80);
    const out = deriveCronTitle(long);
    expect(out.length).toBe(60);
    expect(out.endsWith("…")).toBe(true);
  });

  it("createCron deriva el título del what si no se pasa", () => {
    const { d, uid } = setup();
    const c = createCron(d, newCron(uid, { what: "llamar al pediatra de Mara" }));
    expect(c.title).toBe("llamar al pediatra de Mara");
    expect(viewCron(getCron(d, c.id) as CronRow).title).toBe("llamar al pediatra de Mara");
  });

  it("createCron respeta el título explícito", () => {
    const { d, uid } = setup();
    const c = createCron(d, newCron(uid, { title: "Pediatra", what: "llamar al pediatra de Mara" }));
    expect(c.title).toBe("Pediatra");
  });

  it("updateCron edita el título", () => {
    const { d, uid } = setup();
    const c = createCron(d, newCron(uid));
    expect(updateCron(d, c.id, uid, { title: "Nuevo título" })).toBe(true);
    expect(getCron(d, c.id)?.title).toBe("Nuevo título");
    expect(viewCron(getCron(d, c.id) as CronRow).title).toBe("Nuevo título");
  });
});
