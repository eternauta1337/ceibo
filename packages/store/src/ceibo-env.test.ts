import { afterEach, describe, expect, it } from "vitest";
import { ceiboEnv, defaultDbPath, sockPath } from "./index.ts";

// Estas funciones leen process.env (CEIBO_ENV / CEIBO_DB_PATH). Restauramos tras cada test.
const SAVED = { env: process.env.CEIBO_ENV, db: process.env.CEIBO_DB_PATH };
function setEnv(env?: string, db?: string) {
  if (env === undefined) delete process.env.CEIBO_ENV;
  else process.env.CEIBO_ENV = env;
  if (db === undefined) delete process.env.CEIBO_DB_PATH;
  else process.env.CEIBO_DB_PATH = db;
}
afterEach(() => setEnv(SAVED.env, SAVED.db));

describe("ceiboEnv", () => {
  it("default = prod cuando CEIBO_ENV está ausente o es inválido", () => {
    setEnv(undefined);
    expect(ceiboEnv()).toBe("prod");
    setEnv("garbage");
    expect(ceiboEnv()).toBe("prod");
  });

  it("respeta dev/staging/prod", () => {
    for (const e of ["dev", "staging", "prod"] as const) {
      setEnv(e);
      expect(ceiboEnv()).toBe(e);
    }
  });
});

describe("defaultDbPath", () => {
  it("CEIBO_DB_PATH overridea todo (lo que fija la box)", () => {
    setEnv("dev", "/tmp/whatever.db");
    expect(defaultDbPath()).toBe("/tmp/whatever.db");
  });

  it("invariante prod: ceibo.db (sin sufijo) sin override", () => {
    setEnv("prod");
    expect(defaultDbPath().endsWith("/data/ceibo.db")).toBe(true);
    setEnv(undefined); // ausente == prod
    expect(defaultDbPath().endsWith("/data/ceibo.db")).toBe(true);
  });

  it("dev/staging: ceibo.<env>.db", () => {
    setEnv("dev");
    expect(defaultDbPath().endsWith("/data/ceibo.dev.db")).toBe(true);
    setEnv("staging");
    expect(defaultDbPath().endsWith("/data/ceibo.staging.db")).toBe(true);
  });
});

describe("sockPath", () => {
  it("invariante prod: <base>.sock, al lado de la DB", () => {
    setEnv("prod", "/srv/data/ceibo.db");
    expect(sockPath("remote")).toBe("/srv/data/remote.sock");
    expect(sockPath("gateway")).toBe("/srv/data/gateway.sock");
  });

  it("dev/staging: <base>.<env>.sock (sin colisión entre entornos)", () => {
    setEnv("dev", "/srv/data/ceibo.dev.db");
    expect(sockPath("remote")).toBe("/srv/data/remote.dev.sock");
    setEnv("staging", "/srv/data/ceibo.staging.db");
    expect(sockPath("gateway")).toBe("/srv/data/gateway.staging.sock");
  });
});
