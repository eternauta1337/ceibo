import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAuthUrl,
  DEFAULT_PROFILE,
  knownProvider,
  knownService,
  makePkce,
  makeState,
  mcpUrlForProfile,
  PROVIDERS,
  sanitizeProfile,
  serverNameForProfile,
} from "./index.ts";

const isB64Url = (s: string) => /^[A-Za-z0-9_-]+$/.test(s);

describe("makePkce", () => {
  it("verifier y challenge son base64url distintos", () => {
    const { verifier, challenge } = makePkce();
    expect(isB64Url(verifier)).toBe(true);
    expect(isB64Url(challenge)).toBe(true);
    expect(verifier).not.toBe(challenge);
  });

  it("el challenge es S256(verifier) en base64url (relación verificable)", () => {
    const { verifier, challenge } = makePkce();
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });

  it("cada llamada produce un verifier distinto (aleatorio)", () => {
    expect(makePkce().verifier).not.toBe(makePkce().verifier);
  });
});

describe("makeState", () => {
  it("es base64url", () => {
    expect(isB64Url(makeState())).toBe(true);
  });
  it("es único por llamada", () => {
    const states = new Set(Array.from({ length: 50 }, () => makeState()));
    expect(states.size).toBe(50);
  });
});

describe("buildAuthUrl", () => {
  const google = PROVIDERS.google as NonNullable<ReturnType<typeof knownProvider>>;
  const notion = PROVIDERS.notion as NonNullable<ReturnType<typeof knownProvider>>;

  it("Google (PKCE): incluye challenge S256, scope space-joined y los authParams del provider", () => {
    const url = buildAuthUrl({
      provider: google,
      clientId: "cid",
      redirectUri: "https://app/cb",
      scopes: ["a/scope.read", "b/scope.write"],
      state: "st8",
      challenge: "CH",
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = u.searchParams;
    expect(p.get("client_id")).toBe("cid");
    expect(p.get("redirect_uri")).toBe("https://app/cb");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("state")).toBe("st8");
    expect(p.get("scope")).toBe("a/scope.read b/scope.write");
    expect(p.get("code_challenge")).toBe("CH");
    expect(p.get("code_challenge_method")).toBe("S256");
    // authParams de Google
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
  });

  it("Notion (sin PKCE): no agrega code_challenge y respeta owner=user", () => {
    const url = buildAuthUrl({
      provider: notion,
      clientId: "cid",
      redirectUri: "https://app/cb",
      scopes: [],
      state: "st8",
    });
    const p = new URL(url).searchParams;
    expect(p.get("owner")).toBe("user");
    expect(p.has("code_challenge")).toBe(false);
    expect(p.has("code_challenge_method")).toBe(false);
  });

  it("sin scopes no agrega el param scope", () => {
    const url = buildAuthUrl({
      provider: notion,
      clientId: "c",
      redirectUri: "https://a/cb",
      scopes: [],
      state: "s",
    });
    expect(new URL(url).searchParams.has("scope")).toBe(false);
  });

  it("provider con PKCE pero sin challenge → tira", () => {
    expect(() =>
      buildAuthUrl({
        provider: google,
        clientId: "c",
        redirectUri: "https://a/cb",
        scopes: [],
        state: "s",
      }),
    ).toThrow(/PKCE/);
  });
});

describe("sanitizeProfile", () => {
  it("minúsculas + colapsa no-alfanum a guión", () => {
    expect(sanitizeProfile("My Work!!")).toBe("my-work");
  });
  it("quita diacríticos vía NFKD", () => {
    expect(sanitizeProfile("café")).toBe("cafe");
  });
  it("recorta guiones de los bordes", () => {
    expect(sanitizeProfile("  --work-- ")).toBe("work");
  });
  it('"" → default', () => {
    expect(sanitizeProfile("")).toBe(DEFAULT_PROFILE);
  });
  it('"default" → default', () => {
    expect(sanitizeProfile("default")).toBe(DEFAULT_PROFILE);
  });
  it("solo símbolos → default (queda vacío tras el trim)", () => {
    expect(sanitizeProfile("!!!")).toBe(DEFAULT_PROFILE);
  });
  it("recorta a 32 chars", () => {
    expect(sanitizeProfile("a".repeat(40))).toBe("a".repeat(32));
  });
});

describe("mcpUrlForProfile", () => {
  it("default → URL pelada (retro-compat)", () => {
    expect(mcpUrlForProfile("https://x/mcp/gmail/SEC", DEFAULT_PROFILE)).toBe("https://x/mcp/gmail/SEC");
  });
  it("perfil extra → segmento de path ANTES del secret (último)", () => {
    expect(mcpUrlForProfile("https://x/mcp/gmail/SEC", "work")).toBe("https://x/mcp/gmail/work/SEC");
  });
  it("preserva query string existente", () => {
    expect(mcpUrlForProfile("https://x/mcp/gmail/SEC?a=1", "work")).toBe("https://x/mcp/gmail/work/SEC?a=1");
  });
});

describe("serverNameForProfile", () => {
  it("default → el nombre del servicio pelado", () => {
    expect(serverNameForProfile("gmail", DEFAULT_PROFILE)).toBe("gmail");
  });
  it("perfil extra → servicio_perfil", () => {
    expect(serverNameForProfile("gmail", "work")).toBe("gmail_work");
  });
});

describe("knownProvider / knownService", () => {
  it("providers conocidos", () => {
    expect(knownProvider("google")?.usePkce).toBe(true);
    expect(knownProvider("notion")?.tokenAuth).toBe("basic");
  });
  it("provider desconocido → undefined", () => {
    expect(knownProvider("apple")).toBeUndefined();
  });
  it("servicios conocidos resuelven a su provider", () => {
    expect(knownService("gmail")?.provider).toBe("google");
    expect(knownService("notion")?.provider).toBe("notion");
  });
  it("servicio desconocido → undefined", () => {
    expect(knownService("dropbox")).toBeUndefined();
  });
});
