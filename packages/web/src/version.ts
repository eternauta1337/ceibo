// Lógica de presentación del badge de versión (SHA del deploy).
//
// El SHA viene de GET /api/version (runtime), no del build. La función `versionBadge`
// es pura y testeable: decide qué mostrar dado el entorno y los query params.

export type CeiboEnv = "dev" | "staging" | "prod";

/** Resultado del cálculo de presentación del badge. */
export interface VersionBadge {
  /** ¿Hay que mostrar el badge? */
  show: boolean;
  /** SHA corto del deploy (7 chars) o null si no se pudo resolver. */
  sha: string | null;
  /** Etiqueta del entorno ("dev" | "staging" | "prod"). */
  tag: CeiboEnv;
}

/**
 * Decide si mostrar el badge de versión y con qué contenido.
 *
 * Reglas:
 * - staging y dev → badge visible por default.
 * - prod → oculto salvo que `?debugVersion=1` esté en la URL.
 *
 * @param env    Entorno tal como lo devuelve GET /api/version.
 * @param sha    SHA corto del deploy (7 chars) o null.
 * @param search `window.location.search` (o cualquier query string).
 */
export function versionBadge(env: CeiboEnv, sha: string | null, search: string): VersionBadge {
  const params = new URLSearchParams(search);
  const debugVersion = params.get("debugVersion") === "1";
  const show = env !== "prod" || debugVersion;
  return { show, sha, tag: env };
}

/**
 * Devuelve el título de la tab del navegador para el entorno dado.
 *
 * Reglas:
 * - dev y staging → prefijo `[env]` para que se vea aunque la tab esté angosta.
 * - prod → base pelado, sin prefijo.
 *
 * @param env  Entorno tal como lo devuelve GET /api/version.
 * @param base Título base (default: "Ceibo").
 */
export function pageTitle(env: CeiboEnv, base = "Ceibo"): string {
  return env === "prod" ? base : `[${env}] ${base}`;
}

/** Respuesta de GET /api/version. */
export interface VersionApiResponse {
  env: CeiboEnv;
  sha: string | null;
}

/**
 * Texto de versión para mostrar SIEMPRE en Configuración (info de soporte): a diferencia del
 * badge del header/home, acá no aplica la regla de visibilidad por entorno — si el usuario abrió
 * Configuración, mostramos qué versión está corriendo en cualquier entorno. Graceful: si el
 * endpoint todavía no resolvió (`info` null), devuelve "no disponible".
 *
 * Ejemplos: `{env:"prod", sha:"a1b2c3d"}` → "a1b2c3d · prod"; null → "no disponible".
 *
 * @param info Respuesta de GET /api/version, o null si aún no resolvió / el endpoint no existe.
 */
export function versionLine(info: VersionApiResponse | null): string {
  if (!info) return "no disponible";
  return info.sha ? `${info.sha} · ${info.env}` : info.env;
}
