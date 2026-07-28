// Helpers puros del servicio OAuth, extraídos de server.ts (que es el proceso HTTP:
// loadEnvFile + new Anthropic + listen al cargar → inimportable en tests). server.ts los
// envuelve inyectando su env y su Map de estado pendiente.

import type { OAuthProvider } from "./index.ts";

/** Credenciales de la app OAuth de un provider, leídas del env. undefined si falta alguna. */
export function providerCredsFromEnv(
  p: OAuthProvider,
  env: NodeJS.ProcessEnv,
): { clientId: string; clientSecret: string } | undefined {
  const clientId = env[p.clientIdEnv];
  const clientSecret = env[p.clientSecretEnv];
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

/** Borra del map los enrollments pendientes que pasaron el TTL (mutación in-place). */
export function sweepExpired(entries: Map<string, { createdAt: number }>, now: number, ttlMs: number): void {
  for (const [key, v] of entries) if (now - v.createdAt > ttlMs) entries.delete(key);
}

/** Escapa para contexto de texto HTML (anti-XSS de valores reflejados desde la query). */
export function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}
