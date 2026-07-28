// Helpers HTTP puros del web-server, extraídos de web.ts (el server always-on, inimportable
// en tests: createServer().listen() al cargar). Sin req/res ni estado de módulo → testeables.
// web.ts los envuelve pasando los headers/campos que sacan del request.

import { timingSafeEqual } from "node:crypto";

/** ¿El origin/referer del request es el mismo host? (defensa CSRF). Ambos del request. */
export function isAllowedOrigin(host: string | undefined, originOrReferer: string | undefined): boolean {
  if (!host || !originOrReferer) return false;
  try {
    return new URL(originOrReferer).host === host;
  } catch {
    return false;
  }
}

/** IP del cliente para rate-limit: el ÚLTIMO hop de x-forwarded-for o el remoteAddress.
 *
 * Modelo de confianza: hay exactamente UN reverse proxy confiable (nginx) que APENDEA la IP
 * real del cliente al header con `$proxy_add_x_forwarded_for`. El cliente puede meter lo que
 * quiera en los hops anteriores → tomar el primero es evadir el rate-limit rotando el header.
 * El último hop es el que apendeó nuestro proxy → es el que vale. Sin header (request directo
 * sin proxy, p.ej. tests locales) usamos `req.socket.remoteAddress`. */
export function clientIpFrom(xForwardedFor: string | undefined, remoteAddress: string | undefined): string {
  if (xForwardedFor) {
    const hops = xForwardedFor.split(",");
    return hops[hops.length - 1]?.trim() || "unknown";
  }
  return remoteAddress ?? "unknown";
}

/** Valor de una cookie por nombre desde el header `Cookie` crudo, o undefined. */
export function parseCookie(rawCookieHeader: string | undefined, name: string): string | undefined {
  if (!rawCookieHeader) return undefined;
  for (const part of rawCookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Compara secretos en tiempo constante (largo primero, contenido timing-safe). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Arma un header Set-Cookie con los flags estándar (HttpOnly/Secure/SameSite=Lax).
 *  Max-Age=0 + value vacío = borrar la cookie. */
export function buildSetCookie(name: string, value: string, opts: { path: string; maxAge: number }): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${opts.path}; Max-Age=${opts.maxAge}`;
}
