// Clasificación de seguridad de los hrefs clickeables del editor (live preview). Las notas las
// edita el usuario Y el agente (prompt-injectable): un `javascript:`/`data:` NO debe ejecutarse
// NUNCA. El fix de XSS (PR #257) ya impedía la EJECUCIÓN (esos esquemas no entran en la allowlist
// de `window.open`), pero caían en la rama interna (`resolveInternalPath`) → abrían un "tab
// fantasma" ("abriendo… no se encontró nada"). Acá un esquema NO-seguro se clasifica `blocked` →
// el handler lo trata como no-op (ni `window.open`, ni `resolveInternalPath`).
//
// Lógica pura (sin DOM/React) para poder testearla bajo el harness node del monorepo: Editor.tsx
// importa el atomic editor + CSS y no es importable en un test node.

/** Allowlist de esquemas SEGUROS para abrir en otra pestaña del browser. Cualquier cosa fuera de
 *  acá que TRAIGA esquema se bloquea (ver `classifyLink`). */
export const SAFE_EXTERNAL = /^(https?:|mailto:|tel:)/i;

/** Detecta un esquema explícito `scheme:` al inicio del href. RFC 3986:
 *  `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`. NO matchea `//host` (protocol-relative,
 *  arranca con `/`) ni paths internos (`./x`, `../x`, `nota`, `#anchor`). */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** ¿El link apunta afuera con un esquema seguro (http(s)/mailto/tel) o es protocol-relative
 *  (`//host`)? Esos abren en otra pestaña del browser. */
export function isExternalUrl(url: string): boolean {
  return SAFE_EXTERNAL.test(url) || url.startsWith("//");
}

/** Clasifica un href clickeado en el editor en una de tres acciones:
 *  - `"external"`: esquema seguro o protocol-relative → `window.open(_blank)`.
 *  - `"blocked"`:  TRAE un esquema pero NO está en la allowlist (`javascript:`, `data:`,
 *                  `vbscript:`, `file:`, …) → NO-OP: ni se ejecuta, ni se abre, ni se resuelve
 *                  como nota interna (evita el "tab fantasma").
 *  - `"internal"`: SIN esquema → path a otra nota de la misma wiki → `resolveInternalPath`. */
export function classifyLink(url: string): "external" | "blocked" | "internal" {
  if (isExternalUrl(url)) return "external";
  if (HAS_SCHEME.test(url)) return "blocked";
  return "internal";
}
