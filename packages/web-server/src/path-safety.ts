// Helpers de validación de paths repo-relativos. Compartido por web.ts (POST/DELETE/move
// del editor) y viewer.ts (viewer_create del agente) para que el gate sea el mismo
// donde sea que se cree o toque un archivo del usuario.

/** Valida que un path repo-relativo no escape (sin `..`, sin abs, sin segmentos vacíos)
 *  y no apunte a archivos especiales (no permitimos crear/borrar `CLAUDE.md` desde la
 *  UI ni desde el agente — eso es convención del repo, no notas del usuario). */
export function isSafeRelPath(p: string): boolean {
  if (!p || p.startsWith("/")) return false;
  // Como es el gate único, rechazamos también null-byte (truncation en libs viejas) y
  // backslash (un solo segmento para el split por `/` → un `..\..` se colaría si algún
  // consumidor lo interpretara como separador). Defensa en profundidad.
  if (p.includes(String.fromCharCode(0)) || p.includes("\\")) return false;
  const segs = p.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return false;
  const base = segs[segs.length - 1] ?? "";
  if (base === "CLAUDE.md") return false;
  return true;
}
