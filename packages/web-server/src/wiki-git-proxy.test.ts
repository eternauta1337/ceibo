// Tests del proxy git smart-HTTP scopeado (wiki-git-proxy.ts).
//
// SEGURIDAD (crítico): estos tests ejercitan principalmente el path de auth/scoping.
// El test adversarial verifica que un token de user A NO puede acceder a una wiki
// de user B, y que no se hace ningún request upstream en ese caso.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Writable } from "node:stream";
import { signUserToken } from "@ceibo/store";
import type { ScopedToken, Wikis } from "@ceibo/wikis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeWikiGitProxyHandler } from "./wiki-git-proxy.ts";

const SECRET = "test-secret-git-proxy";
const USER_A = 10;
const USER_B = 20;
const WIKI_A = "demo-personal"; // wiki del user A
const WIKI_B = "lula-notas"; // wiki del user B
const ORG = "ceibofamily";
const ALLOWED_IP = "203.0.113.10"; // IP de archima (NAT egress)

// ── Fakes ──────────────────────────────────────────────────────────────────────

/** Wikis fake que captura las llamadas a mintToken y las URLs de fetch upstream. */
function fakeWikis(opts: { mintShouldFail?: boolean } = {}): Wikis & {
  minted: string[][];
} {
  const stub = {
    org: ORG,
    minted: [] as string[][],
    async mintToken(repoNames: string[]): Promise<ScopedToken> {
      if (opts.mintShouldFail) throw new Error("mint-failed");
      stub.minted.push(repoNames);
      return { token: "ghs_fake_installation_token", expiresAt: "2099-01-01T00:00:00Z" };
    },
  };
  return stub as unknown as Wikis & { minted: string[][] };
}

/** Respuesta HTTP fake: captura status y headers; usa un Writable real de Node para el
 *  body, de modo que pipeline (node:stream/promises) pueda manejar back-pressure, finish
 *  y destroy sin colgarse en esperas de eventos que un mock ad-hoc no emite. */
function fakeRes() {
  const captured: {
    status?: number;
    headers?: Record<string, string>;
    ended: boolean;
    written: Buffer[];
    destroyed: boolean;
  } = { ended: false, written: [], destroyed: false };

  // Writable real que acumula chunks y marca `ended` cuando termina.
  const writable = new Writable({
    write(chunk: Buffer, _enc, cb) {
      captured.written.push(chunk);
      cb();
    },
    final(cb) {
      captured.ended = true;
      cb();
    },
    destroy(_err, cb) {
      captured.destroyed = true;
      cb(null);
    },
  });

  // Mezclamos writeHead sobre el Writable real para que el handler pueda llamarlo.
  const res = Object.assign(writable, {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      return res;
    },
  }) as unknown as ServerResponse;

  return { res, captured };
}

/** Request HTTP fake. */
function fakeReq(opts: {
  method: string;
  url: string;
  userId?: number;
  secret?: string;
  noAuth?: boolean;
  badAuthHeader?: string;
  /** Valor de X-Forwarded-For (simula lo que apendea el edge). Default: IP permitida. */
  xff?: string;
}): IncomingMessage {
  const token = opts.noAuth
    ? undefined
    : opts.badAuthHeader !== undefined
      ? opts.badAuthHeader
      : opts.userId !== undefined
        ? signUserToken(opts.userId, opts.secret ?? SECRET)
        : undefined;
  const headers: Record<string, string> = {
    // Default: la IP de archima (último hop del XFF que agrega el edge). Los tests
    // que quieren probar IP no permitida pasan su propio xff.
    "x-forwarded-for": opts.xff ?? ALLOWED_IP,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const req = {
    method: opts.method,
    url: opts.url,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    on(_event: string, _cb: unknown) {
      // Para los POST sin body real en tests, simplemente no emitimos nada.
      return req;
    },
  } as unknown as IncomingMessage;
  return req;
}

// ── Helpers de handler ─────────────────────────────────────────────────────────

let fetchSpy: ReturnType<typeof vi.fn>;

function makeHandler(
  wikis: Wikis,
  reposByUser: Record<number, string[]>,
  opts: {
    fetchResponse?: { status: number; body?: string; ct?: string };
    /** IPs permitidas. Default: solo ALLOWED_IP. Pasar Set vacío para probar fail-closed. */
    allowedIps?: ReadonlySet<string>;
  } = {},
) {
  const { fetchResponse = { status: 200, ct: "application/x-git-upload-pack-result" } } = opts;

  // Mock global fetch: captura la URL y cabeceras del upstream.
  const capturedFetches: { url: string; headers: Record<string, string>; method: string }[] = [];
  fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    capturedFetches.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      method: (init?.method ?? "GET") as string,
    });
    const body = fetchResponse.body ?? "";
    return new Response(body, {
      status: fetchResponse.status,
      headers: { "content-type": fetchResponse.ct ?? "application/x-git-upload-pack-result" },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);

  const handler = makeWikiGitProxyHandler({
    secret: SECRET,
    wikis,
    userRepoNames: (userId) => reposByUser[userId] ?? [],
    allowedIps: opts.allowedIps ?? new Set([ALLOWED_IP]),
  });
  return { handler, capturedFetches };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("wiki-git-proxy: autenticación", () => {
  it("sin header Authorization → 401", async () => {
    const wikis = fakeWikis();
    const { handler } = makeHandler(wikis, { [USER_A]: [WIKI_A] });
    const req = fakeReq({
      method: "GET",
      url: `/api/git/${WIKI_A}/info/refs?service=git-upload-pack`,
      noAuth: true,
    });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("token con HMAC inválido → 401", async () => {
    const wikis = fakeWikis();
    const { handler } = makeHandler(wikis, { [USER_A]: [WIKI_A] });
    const req = fakeReq({
      method: "GET",
      url: `/api/git/${WIKI_A}/info/refs?service=git-upload-pack`,
      badAuthHeader: "tok.bad.mac",
    });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("token firmado con secret DISTINTO → 401", async () => {
    const wikis = fakeWikis();
    const { handler } = makeHandler(wikis, { [USER_A]: [WIKI_A] });
    // Firmamos con otro secret, distinto del que el handler usa
    const badToken = signUserToken(USER_A, "otro-secret");
    const req = fakeReq({
      method: "GET",
      url: `/api/git/${WIKI_A}/info/refs?service=git-upload-pack`,
      badAuthHeader: badToken,
    });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("wiki-git-proxy: ADVERSARIAL — cross-user scoping", () => {
  it("token de user A NO puede acceder a wiki de user B → 403, sin request upstream", async () => {
    const wikis = fakeWikis();
    // User A tiene WIKI_A; user B tiene WIKI_B. El token es de user A.
    const { handler, capturedFetches } = makeHandler(wikis, {
      [USER_A]: [WIKI_A],
      [USER_B]: [WIKI_B],
    });
    const req = fakeReq({
      method: "GET",
      url: `/api/git/${WIKI_B}/info/refs?service=git-upload-pack`,
      userId: USER_A,
    });
    const { res, captured } = fakeRes();
    await handler(req, res);

    // Tiene que fallar con 403
    expect(captured.status).toBe(403);
    // CRÍTICO: no debe haberse hecho ningún request upstream (ni minteo de token)
    expect(capturedFetches).toHaveLength(0);
    expect(wikis.minted).toHaveLength(0);
  });

  it("token de user B NO puede acceder a wiki de user A → 403", async () => {
    const wikis = fakeWikis();
    const { handler, capturedFetches } = makeHandler(wikis, {
      [USER_A]: [WIKI_A],
      [USER_B]: [WIKI_B],
    });
    const req = fakeReq({
      method: "POST",
      url: `/api/git/${WIKI_A}/git-upload-pack`,
      userId: USER_B,
    });
    const { res, captured } = fakeRes();
    await handler(req, res);

    expect(captured.status).toBe(403);
    expect(capturedFetches).toHaveLength(0);
    expect(wikis.minted).toHaveLength(0);
  });

  it("user A no puede acceder a wiki que no está en su allowlist → 403", async () => {
    const wikis = fakeWikis();
    const { handler, capturedFetches } = makeHandler(wikis, {
      [USER_A]: [WIKI_A], // solo WIKI_A, no "demo-secreto"
    });
    const req = fakeReq({
      method: "GET",
      url: "/api/git/demo-secreto/info/refs?service=git-upload-pack",
      userId: USER_A,
    });
    const { res, captured } = fakeRes();
    await handler(req, res);

    expect(captured.status).toBe(403);
    expect(capturedFetches).toHaveLength(0);
  });
});

describe("wiki-git-proxy: path traversal / inputs raros en <wiki>", () => {
  const cases: { label: string; wikiInUrl: string }[] = [
    { label: "..", wikiInUrl: ".." },
    { label: ".", wikiInUrl: "." },
    { label: "vacío", wikiInUrl: "" },
    { label: "slash extra", wikiInUrl: "foo%2Fbar" }, // percent-encoded slash → "foo/bar" tras decode
    { label: "null-byte encoded", wikiInUrl: "foo%00bar" }, // null byte
    { label: "mayúsculas", wikiInUrl: "demo-Personal" }, // fuera del RE (mayúsculas)
    { label: "backslash", wikiInUrl: "foo\\bar" },
    { label: "guion inicial", wikiInUrl: "-foo" }, // fuera del RE (empieza con guion)
  ];

  for (const { label, wikiInUrl } of cases) {
    it(`<wiki> = "${label}" → 400 o 403 (nunca forward)`, async () => {
      const wikis = fakeWikis();
      const { handler, capturedFetches } = makeHandler(wikis, { [USER_A]: [WIKI_A] });
      const req = fakeReq({
        method: "GET",
        url: `/api/git/${wikiInUrl}/info/refs?service=git-upload-pack`,
        userId: USER_A,
      });
      const { res, captured } = fakeRes();
      await handler(req, res);
      // O bien el nombre es inválido (400/404) o no pertenece al user (403) — en ningún caso 200
      expect(captured.status).not.toBe(200);
      // Nunca debe haber llegado al fetch upstream
      expect(capturedFetches).toHaveLength(0);
      expect(wikis.minted).toHaveLength(0);
    });
  }
});

describe("wiki-git-proxy: validación del service", () => {
  it("service inválido en info/refs → 400", async () => {
    const wikis = fakeWikis();
    const { handler } = makeHandler(wikis, { [USER_A]: [WIKI_A] });
    const req = fakeReq({
      method: "GET",
      url: `/api/git/${WIKI_A}/info/refs?service=git-hack-pack`,
      userId: USER_A,
    });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("service ausente en info/refs → 400", async () => {
    const wikis = fakeWikis();
    const { handler } = makeHandler(wikis, { [USER_A]: [WIKI_A] });
    const req = fakeReq({
      method: "GET",
      url: `/api/git/${WIKI_A}/info/refs`,
      userId: USER_A,
    });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("wiki-git-proxy: happy path — info/refs upload-pack", () => {
  it("forwardea a la URL upstream correcta con token del App inyectado", async () => {
    const wikis = fakeWikis();
    const { handler, capturedFetches } = makeHandler(
      wikis,
      { [USER_A]: [WIKI_A] },
      {
        fetchResponse: { status: 200, ct: "application/x-git-upload-pack-advertisement" },
      },
    );
    const req = fakeReq({
      method: "GET",
      url: `/api/git/${WIKI_A}/info/refs?service=git-upload-pack`,
      userId: USER_A,
    });
    const { res, captured } = fakeRes();
    await handler(req, res);

    expect(captured.status).toBe(200);
    expect(capturedFetches).toHaveLength(1);

    // URL correcta
    const upstream = capturedFetches[0];
    expect(upstream?.url).toBe(`https://github.com/${ORG}/${WIKI_A}.git/info/refs?service=git-upload-pack`);
    // Token del App inyectado como Basic auth
    const expected = `Basic ${Buffer.from("x-access-token:ghs_fake_installation_token").toString("base64")}`;
    expect(upstream?.headers.authorization).toBe(expected);

    // CRÍTICO: el token de la VM (del Bearer entrante) NO debe haber ido a GitHub.
    // El Basic de upstream usa el token del App, no el de la VM.
    const vmToken = signUserToken(USER_A, SECRET);
    expect(upstream?.headers.authorization).not.toContain(vmToken);
  });

  it("el minteo se hace acotado al repo exacto (no a todos los repos del user)", async () => {
    const wikis = fakeWikis();
    const { handler } = makeHandler(wikis, {
      [USER_A]: [WIKI_A, "demo-trabajo"], // user A tiene dos wikis
    });
    const req = fakeReq({
      method: "GET",
      url: `/api/git/${WIKI_A}/info/refs?service=git-upload-pack`,
      userId: USER_A,
    });
    const { res } = fakeRes();
    await handler(req, res);
    // mintToken debe haberse llamado solo con la wiki pedida, no con todas las del user.
    expect(wikis.minted).toHaveLength(1);
    expect(wikis.minted[0]).toEqual([WIKI_A]);
  });
});

describe("wiki-git-proxy: happy path — git-upload-pack (POST)", () => {
  it("POST upload-pack forwardea con método POST a la URL correcta", async () => {
    const wikis = fakeWikis();
    const { handler, capturedFetches } = makeHandler(
      wikis,
      { [USER_A]: [WIKI_A] },
      {
        fetchResponse: { status: 200, ct: "application/x-git-upload-pack-result" },
      },
    );
    const req = fakeReq({
      method: "POST",
      url: `/api/git/${WIKI_A}/git-upload-pack`,
      userId: USER_A,
    });
    const { res, captured } = fakeRes();
    await handler(req, res);

    expect(captured.status).toBe(200);
    expect(capturedFetches[0]?.url).toBe(`https://github.com/${ORG}/${WIKI_A}.git/git-upload-pack`);
    expect(capturedFetches[0]?.method).toBe("POST");
  });
});

describe("wiki-git-proxy: happy path — git-receive-pack (push)", () => {
  it("POST receive-pack forwardea a la URL correcta", async () => {
    const wikis = fakeWikis();
    const { handler, capturedFetches } = makeHandler(
      wikis,
      { [USER_A]: [WIKI_A] },
      {
        fetchResponse: { status: 200, ct: "application/x-git-receive-pack-result" },
      },
    );
    const req = fakeReq({
      method: "POST",
      url: `/api/git/${WIKI_A}/git-receive-pack`,
      userId: USER_A,
    });
    const { res, captured } = fakeRes();
    await handler(req, res);

    expect(captured.status).toBe(200);
    expect(capturedFetches[0]?.url).toBe(`https://github.com/${ORG}/${WIKI_A}.git/git-receive-pack`);
    expect(capturedFetches[0]?.method).toBe("POST");
  });
});

describe("wiki-git-proxy: error de minteo de token", () => {
  it("fallo en mintToken → 502, sin respuesta upstream al cliente", async () => {
    const wikis = fakeWikis({ mintShouldFail: true });
    const { handler } = makeHandler(wikis, { [USER_A]: [WIKI_A] });
    const req = fakeReq({
      method: "GET",
      url: `/api/git/${WIKI_A}/info/refs?service=git-upload-pack`,
      userId: USER_A,
    });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(502);
  });
});

describe("wiki-git-proxy: subpaths inválidos", () => {
  it("GET /api/git/<wiki>/algo-raro → 404", async () => {
    const wikis = fakeWikis();
    const { handler } = makeHandler(wikis, { [USER_A]: [WIKI_A] });
    const req = fakeReq({
      method: "GET",
      url: `/api/git/${WIKI_A}/algo-raro`,
      userId: USER_A,
    });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POST /api/git/<wiki>/info/refs (método incorrecto) → 404", async () => {
    const wikis = fakeWikis();
    const { handler } = makeHandler(wikis, { [USER_A]: [WIKI_A] });
    const req = fakeReq({
      method: "POST",
      url: `/api/git/${WIKI_A}/info/refs?service=git-upload-pack`,
      userId: USER_A,
    });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("wiki-git-proxy: gate de source-IP", () => {
  it("IP permitida con token válido → pasa (happy path con IP)", async () => {
    const wikis = fakeWikis();
    const { handler } = makeHandler(wikis, { [USER_A]: [WIKI_A] });
    const req = fakeReq({
      method: "GET",
      url: `/api/git/${WIKI_A}/info/refs?service=git-upload-pack`,
      userId: USER_A,
      xff: ALLOWED_IP, // IP de archima
    });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(200);
  });

  it("IP distinta a la permitida → 403, sin forward ni minteo (aunque token sea válido)", async () => {
    const wikis = fakeWikis();
    const { handler, capturedFetches } = makeHandler(wikis, { [USER_A]: [WIKI_A] });
    const req = fakeReq({
      method: "GET",
      url: `/api/git/${WIKI_A}/info/refs?service=git-upload-pack`,
      userId: USER_A,
      xff: "1.2.3.4", // IP externa, no permitida
    });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(403);
    expect(capturedFetches).toHaveLength(0);
    expect(wikis.minted).toHaveLength(0);
  });

  it("allowlist vacía (misconfig / WIKI_GIT_ALLOWED_IPS ausente) → 403 siempre (fail-closed)", async () => {
    const wikis = fakeWikis();
    // Set vacío: simula env sin WIKI_GIT_ALLOWED_IPS
    const { handler, capturedFetches } = makeHandler(
      wikis,
      { [USER_A]: [WIKI_A] },
      {
        allowedIps: new Set<string>(),
      },
    );
    const req = fakeReq({
      method: "GET",
      url: `/api/git/${WIKI_A}/info/refs?service=git-upload-pack`,
      userId: USER_A,
      xff: ALLOWED_IP, // hasta la IP "correcta" es rechazada
    });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(403);
    expect(capturedFetches).toHaveLength(0);
    expect(wikis.minted).toHaveLength(0);
  });

  it("spoof: varios hops en XFF; el último (el del edge) NO está permitido → 403", async () => {
    // El edge apendea la IP real como último hop. Un atacante mandó XFF=9.9.9.9 desde afuera;
    // el edge apendea SU IP real al final → el último hop es la IP del atacante, no la de gpuhost.
    const wikis = fakeWikis();
    const { handler, capturedFetches } = makeHandler(wikis, { [USER_A]: [WIKI_A] });
    const req = fakeReq({
      method: "GET",
      url: `/api/git/${WIKI_A}/info/refs?service=git-upload-pack`,
      userId: USER_A,
      // Intenta parecer archima en un hop anterior; el edge agrega la IP real al final.
      xff: `${ALLOWED_IP}, 1.2.3.4`,
    });
    const { res, captured } = fakeRes();
    await handler(req, res);
    // Solo el ÚLTIMO hop importa (clientIpFrom toma el último); 1.2.3.4 no está en la allowlist.
    expect(captured.status).toBe(403);
    expect(capturedFetches).toHaveLength(0);
  });

  it("spoof inverso: ALLOWED_IP al final → pasa (verifica que el último hop es el que cuenta)", async () => {
    // Caso complementario: el legítimo archima manda la request → el edge agrega ALLOWED_IP al final.
    const wikis = fakeWikis();
    const { handler } = makeHandler(wikis, { [USER_A]: [WIKI_A] });
    const req = fakeReq({
      method: "GET",
      url: `/api/git/${WIKI_A}/info/refs?service=git-upload-pack`,
      userId: USER_A,
      xff: `10.0.0.1, ${ALLOWED_IP}`, // ALLOWED_IP es el último (agregado por el edge)
    });
    const { res, captured } = fakeRes();
    await handler(req, res);
    expect(captured.status).toBe(200);
  });
});
