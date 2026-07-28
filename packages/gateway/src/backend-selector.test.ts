// El selector de backend por usuario (el enchufe de archima): 'ma' → MA; 'local' → archima si
// está configurado, si no falla explícito. Este test fija esa política.

import type { SessionBackend } from "@ceibo/agent";
import type { User } from "@ceibo/store";
import { describe, expect, it } from "vitest";
import { errorOriginForUser, makeBackendForUser } from "./engine.ts";

// Sentinelas: sólo comparamos identidad de referencia, no ejercitamos los backends.
const fakeMa = {} as SessionBackend;
const fakeArchima = {} as SessionBackend;
const user = (mode: "ma" | "local"): User => ({ id: 1, handle: "demo", backend_mode: mode }) as User;

describe("makeBackendForUser", () => {
  it("'ma' (default) resuelve al backend MA", () => {
    const backendForUser = makeBackendForUser(fakeMa, fakeArchima);
    expect(backendForUser(user("ma"))).toBe(fakeMa);
  });

  it("'local' resuelve al backend de archima cuando está configurado", () => {
    const backendForUser = makeBackendForUser(fakeMa, fakeArchima);
    expect(backendForUser(user("local"))).toBe(fakeArchima);
  });

  it("'local' sin archima configurado → falla explícito", () => {
    const backendForUser = makeBackendForUser(fakeMa); // sin archimaBackend
    expect(() => backendForUser(user("local"))).toThrow(/no está configurado/);
  });
});

describe("errorOriginForUser", () => {
  it("user 'ma' → origin 'ma' (errores etiquetados como Anthropic)", () => {
    expect(errorOriginForUser(user("ma"))).toBe("ma");
  });

  it("user 'local' → origin 'local' (errores del entorno propio, no Anthropic)", () => {
    expect(errorOriginForUser(user("local"))).toBe("local");
  });
});
