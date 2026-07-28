// Proxy git smart-HTTP scopeado para la VM de inferencia local (archima).
//
// SEGURIDAD (dos fronteras independientes, ambas obligatorias):
//
// FRONTERA 1 — source-IP (WIKI_GIT_ALLOWED_IPS):
//   Solo la infra de archima puede llegar al endpoint. Fail-closed: sin allowlist configurada,
//   TODO /api/git devuelve 403. La IP se lee del último hop de x-forwarded-for (el que agrega
//   nuestro edge de vps.example.com, anti-spoof verificado: el edge sobreescribe XFF con la IP real).
//   Un token de VM filtrado afuera NO sirve para descargar wikis — la frontera de IP lo rechaza.
//
// FRONTERA 2 — token de identidad + scoping:
//   La VM habla con un token firmado (WIKI_SYNC_SECRET) que autentica y determina el userId.
//   El server (que tiene las credenciales del GitHub App) reenvía a GitHub inyectando un
//   installation token efímero acotado al repo exacto. El token del App NUNCA sale hacia la VM;
//   el token de la VM NUNCA va a GitHub.
//
// Esquema de transporte del token de la VM:
//   `Authorization: Bearer <token>`  (cabecera HTTP)
// La VM configura git con:
//   git config http.extraHeader "Authorization: Bearer <token>"
// Evita poner credenciales en la URL (se logguean fácilmente) y funciona con
// cualquier versión de git ≥ 2.10 sin depender de credential helpers.
//
// Endpoints montados bajo /api/git/:
//   GET  /api/git/<wiki>/info/refs?service=git-upload-pack|git-receive-pack
//   POST /api/git/<wiki>/git-upload-pack   (clone / pull)
//   POST /api/git/<wiki>/git-receive-pack  (push)
//
// Flujo de seguridad (en orden):
//   0. Source-IP: IP del cliente contra allowedIps (último hop de XFF). Fail-closed.  (403)
//   1. Extraer Bearer → verifyUserToken → userId  (401 si no válido)
//   2. Validar <wiki>: solo letras, dígitos y guiones; no path traversal  (400 si raro)
//   3. Resolver <wiki> contra listReposForUser(userId)  (403 si no pertenece)
//   4. Validar ?service (solo git-upload-pack | git-receive-pack) en info/refs  (400 si inválido)
//   5. Mintear installation token efímero acotado AL repo exacto
//   6. Forward streaming a GitHub inyectando el token del App como Basic auth
//      (x-access-token:<token>); preservar Content-Type y status HTTP upstream

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { verifyUserToken } from "@ceibo/store";
import type { Wikis } from "@ceibo/wikis";
import { clientIpFrom } from "./http.ts";

export interface WikiGitProxyOpts {
  /** HMAC del token de identidad de la VM (== WIKI_SYNC_SECRET). */
  secret: string;
  wikis: Wikis;
  /** Repos ACTIVOS del usuario (nombre corto, sin org/). Mismo closure que /api/sync. */
  userRepoNames: (userId: number) => string[];
  /** IPs permitidas (FRONTERA 1, fail-closed). Set vacío → deniega todo. Viene de
   *  WIKI_GIT_ALLOWED_IPS (comma-separated) parseado en web.ts. */
  allowedIps: ReadonlySet<string>;
  log?: (s: string) => void;
}

// Un nombre de wiki válido: letras minúsculas, dígitos y guiones, 1-50 chars.
// Rechaza '.', '..', slashes, encodings raros — todo lo que podría escapar la allowlist.
const WIKI_NAME_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

const VALID_SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

/** Extrae `Authorization: Bearer <token>` de la request. */
function bearerToken(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return undefined;
  const t = h.slice("Bearer ".length).trim();
  return t || undefined;
}

function errJson(res: ServerResponse, status: number, msg: string): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: msg }));
}

/** Handler de /api/git/*. El dispatcher ya filtró el prefijo. */
export function makeWikiGitProxyHandler(opts: WikiGitProxyOpts) {
  const log = opts.log ?? (() => {});

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ── 0. Source-IP (FRONTERA 1): fail-closed ─────────────────────────────────
    // Último hop de XFF = lo que apendea el edge de vps.example.com (anti-spoof verificado:
    // el edge sobreescribe XFF con la IP real, no la propaga del cliente).
    // Sin allowlist configurada → deniega todo (misconfig safe).
    const clientIp = clientIpFrom(
      req.headers["x-forwarded-for"] as string | undefined,
      req.socket?.remoteAddress,
    );
    if (!opts.allowedIps.has(clientIp)) {
      log(`git-proxy: IP denegada ip=${clientIp}`);
      errJson(res, 403, "forbidden");
      return;
    }

    // ── 1. Auth: token firmado → userId ────────────────────────────────────────
    const token = bearerToken(req);
    const userId = token ? verifyUserToken(token, opts.secret) : undefined;
    if (userId === undefined) {
      errJson(res, 401, "unauth");
      return;
    }

    // ── 2. Parsear la URL: /api/git/<wiki>/<subpath> ────────────────────────────
    const url = new URL(req.url ?? "/", "http://internal");
    // Quitamos el prefijo "/api/git/" para obtener el resto: "<wiki>/info/refs" etc.
    const rest = url.pathname.replace(/^\/api\/git\//, "");
    // rest tiene forma "<wiki>/info/refs" o "<wiki>/git-upload-pack" etc.
    const slashIdx = rest.indexOf("/");
    if (slashIdx === -1) {
      errJson(res, 404, "not-found");
      return;
    }
    const wikiRaw = rest.slice(0, slashIdx);
    const subpath = rest.slice(slashIdx + 1); // "info/refs", "git-upload-pack", "git-receive-pack"

    // ── 2b. Validar el nombre de wiki (sin path traversal ni encodings raros) ─
    // URL.pathname NO decodifica %2F (sigue siendo literalmente "%2F") — el slash real
    // sería un segmento distinto y ya lo separó slashIdx. Cualquier otro encoding raro
    // (null-byte %00, etc.) queda como texto y el regex lo rechaza.
    // Rechazamos además cualquier carácter fuera del conjunto seguro.
    if (!WIKI_NAME_RE.test(wikiRaw)) {
      errJson(res, 400, "wiki-name-invalid");
      return;
    }

    // ── 3. Scoping: la wiki TIENE que pertenecer al userId ─────────────────────
    // FRONTERA DE SEGURIDAD: nunca forwardeamos sin confirmar pertenencia.
    const allowed = new Set(opts.userRepoNames(userId));
    if (!allowed.has(wikiRaw)) {
      // No revelamos si el repo existe para otro usuario.
      errJson(res, 403, "forbidden");
      return;
    }

    // ── 4. Validar subpath y service ───────────────────────────────────────────
    let service: string;

    if (subpath === "info/refs" && req.method === "GET") {
      const svc = url.searchParams.get("service") ?? "";
      if (!VALID_SERVICES.has(svc)) {
        errJson(res, 400, "service-invalid");
        return;
      }
      service = svc;
    } else if (subpath === "git-upload-pack" && req.method === "POST") {
      service = "git-upload-pack";
    } else if (subpath === "git-receive-pack" && req.method === "POST") {
      service = "git-receive-pack";
    } else {
      errJson(res, 404, "not-found");
      return;
    }

    // ── 5. Mintear installation token efímero acotado al repo exacto ───────────
    // El token expira en 1h (GitHub); lo minteamos en cada request (sin caché) para
    // que un token de VM capturado no pueda derivar tokens de App a voluntad.
    let appToken: string;
    try {
      const scoped = await opts.wikis.mintToken([wikiRaw]);
      appToken = scoped.token;
    } catch (e) {
      log(
        `git-proxy: error minteando token para user=${userId} wiki=${wikiRaw}: ${e instanceof Error ? e.message : e}`,
      );
      errJson(res, 502, "upstream-auth-failed");
      return;
    }

    // ── 6. Forward streaming a GitHub ──────────────────────────────────────────
    // URL upstream: https://github.com/<org>/<wiki>.git/<subpath>[?service=...]
    const upstreamBase = `https://github.com/${opts.wikis.org}/${wikiRaw}.git`;
    const upstreamUrl =
      subpath === "info/refs" ? `${upstreamBase}/info/refs?service=${service}` : `${upstreamBase}/${subpath}`;

    // Auth upstream: Basic con usuario "x-access-token" y el installation token como password.
    // Esta es la forma canónica de autenticar con installation tokens contra github.com.
    // El token del App NO viaja de vuelta a la VM en ningún header de respuesta.
    const basicAuth = Buffer.from(`x-access-token:${appToken}`, "utf8").toString("base64");

    // Headers para el upstream: propagamos Content-Type (requerido para los POSTs de git)
    // y Git-Protocol si viene (smart protocol negotiation). Excluimos Authorization
    // (reemplazamos por la del App) y Host (el fetch lo pone solo).
    const upstreamHeaders: Record<string, string> = {
      authorization: `Basic ${basicAuth}`,
    };
    if (req.headers["content-type"]) {
      upstreamHeaders["content-type"] = req.headers["content-type"] as string;
    }
    if (req.headers["git-protocol"]) {
      upstreamHeaders["git-protocol"] = req.headers["git-protocol"] as string;
    }

    // Body para los POST (upload-pack / receive-pack): streameamos desde la VM a GitHub.
    // ReadableStream desde IncomingMessage — Node 22 acepta esto en fetch.
    let upstreamBody: ReadableStream<Uint8Array> | undefined;
    if (req.method === "POST") {
      upstreamBody = reqToReadableStream(req);
    }

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: req.method as string,
        headers: upstreamHeaders,
        body: upstreamBody,
        // duplex: "half" — requerido por fetch spec para streaming request body (Node 18+)
        duplex: "half",
      } as RequestInit & { duplex?: string });
    } catch (e) {
      log(
        `git-proxy: error fetch upstream user=${userId} wiki=${wikiRaw} ${subpath}: ${e instanceof Error ? e.message : e}`,
      );
      errJson(res, 502, "upstream-unreachable");
      return;
    }

    // Propagamos status + Content-Type de GitHub a la VM.
    // NO propagamos headers que revelen el token del App (Authorization upstream
    // es nuestra cred; no hay ningún Set-Cookie ni header sensible en git protocol).
    const resHeaders: Record<string, string> = {};
    const ct = upstream.headers.get("content-type");
    if (ct) resHeaders["content-type"] = ct;
    const cacheCtl = upstream.headers.get("cache-control");
    if (cacheCtl) resHeaders["cache-control"] = cacheCtl;

    res.writeHead(upstream.status, resHeaders);

    // Stream del body de GitHub a la VM (sin buffering: los packfiles pueden ser grandes).
    // pipeline maneja back-pressure, errores y cleanup (llama res.end solo) sin acumular
    // listeners por-chunk — seguro para clones grandes (ej. wikibomb clona N wikis a la vez).
    if (upstream.body) {
      try {
        await pipeline(Readable.fromWeb(upstream.body), res);
      } catch (e) {
        // Error de red (cliente desconectado, timeout, etc.): destroy cierra el socket.
        log(`git-proxy: stream error user=${userId} wiki=${wikiRaw}: ${e instanceof Error ? e.message : e}`);
        res.destroy();
      }
    } else {
      res.end();
    }

    log(`git-proxy: user=${userId} wiki=${wikiRaw} ${req.method} ${subpath} → ${upstream.status}`);
  };
}

/** Convierte un IncomingMessage (Node stream) en un ReadableStream<Uint8Array> para fetch. */
function reqToReadableStream(req: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      req.on("end", () => {
        controller.close();
      });
      req.on("error", (err) => {
        controller.error(err);
      });
    },
    cancel() {
      req.destroy();
    },
  });
}
