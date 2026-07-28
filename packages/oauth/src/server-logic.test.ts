import { describe, expect, it } from "vitest";
import { PROVIDERS } from "./index.ts";
import { esc, providerCredsFromEnv, sweepExpired } from "./server-logic.ts";

describe("providerCredsFromEnv", () => {
  const google = PROVIDERS.google as NonNullable<(typeof PROVIDERS)["google"]>;
  it("devuelve las creds si ambas envs están", () => {
    const env = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" } as NodeJS.ProcessEnv;
    expect(providerCredsFromEnv(google, env)).toEqual({ clientId: "cid", clientSecret: "sec" });
  });
  it("falta alguna → undefined", () => {
    expect(providerCredsFromEnv(google, { GOOGLE_CLIENT_ID: "cid" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(providerCredsFromEnv(google, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("sweepExpired", () => {
  it("borra los vencidos (now - createdAt > ttl) y conserva los frescos", () => {
    const m = new Map<string, { createdAt: number }>([
      ["viejo", { createdAt: 0 }],
      ["fresco", { createdAt: 9000 }],
    ]);
    sweepExpired(m, 10_000, 5000); // ttl 5s, ahora 10s → "viejo" (10s viejo) fuera, "fresco" (1s) queda
    expect([...m.keys()]).toEqual(["fresco"]);
  });
  it("nada vencido → no toca", () => {
    const m = new Map([["a", { createdAt: 9000 }]]);
    sweepExpired(m, 10_000, 5000);
    expect(m.size).toBe(1);
  });
});

describe("esc", () => {
  it("escapa los 5 caracteres HTML", () => {
    expect(esc(`<a href="x" o='b' & c>`)).toBe("&lt;a href=&quot;x&quot; o=&#39;b&#39; &amp; c&gt;");
  });
  it("texto sin especiales pasa igual", () => {
    expect(esc("hola mundo")).toBe("hola mundo");
  });
});
