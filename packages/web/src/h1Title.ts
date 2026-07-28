// Reescritura PURA del H1 (`# título`) de una nota markdown.
//
// El título mostrado de una nota = su nombre de archivo. Para que el .md quede consistente con
// el filename (estilo Obsidian bidireccional), al renombrar reescribimos el primer H1 del cuerpo
// al título nuevo. Es la MISMA operación tanto para el rename del explorer (Explorer.doRename)
// como para el rename desde el título del editor (useChannel.renameDoc) — por eso vive acá, en un
// helper puro y testeable, en vez de duplicada/improvisada en cada path.
//
// Bug que cerró extraerlo (QA 2026-06-11): el rename-por-título hacía un `prefixRef.replace(/#.../, …)`
// sobre contenido que podía estar rotado por un re-save tardío → DOS H1 ("# nuevo" + "# viejo") y un
// archivo duplicado. Unificando ambos paths en este reemplazo idempotente (siempre REEMPLAZA el
// primer H1, nunca agrega uno segundo) el H1 queda único por construcción.

/** Reemplaza el primer H1 (`# título`) por `# ${newTitle}` manteniendo el resto del contenido
 *  intacto. Si la nota no empieza por un H1 (primera línea no-vacía no es `# …`) o está vacía,
 *  PREPENDE un H1. Nunca agrega un segundo H1: si ya hay uno, lo reescribe en su lugar. */
export function replaceOrInsertH1(content: string, newTitle: string): string {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? "";
    if (!ln.trim()) continue;
    if (/^#\s+/.test(ln)) {
      lines[i] = `# ${newTitle}`;
      return lines.join("\n");
    }
    break; // primera línea no-vacía no es H1 → insertamos uno arriba
  }
  return content ? `# ${newTitle}\n\n${content}` : `# ${newTitle}\n\n`;
}
