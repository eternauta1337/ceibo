// Normalización del contenido de una nota ANTES de commitearlo a git.
//
// Bug de atribución del blame (repro del owner, 2026-06-29): en una wiki de dos usuarios, U1
// escribe la línea 1 y U2 agrega la línea 2; el blame mostraba que U2 escribió LAS DOS líneas.
//
// Root cause: git blamea por bytes del blob. Si la última línea del archivo NO termina en `\n`
// y otro usuario le agrega una línea debajo, esa última línea previa cambia de bytes (gana el
// `\n` que antes no tenía) → git la cuenta como MODIFICADA por el commit que appendeó, y se la
// atribuye a ese autor. Con `printf 'line1' && commit` (U1) y luego `printf 'line1\nline2\n'`
// (U2), `git blame` atribuye AMBAS líneas a U2. Con la línea 1 ya terminada en `\n`, blame las
// separa bien. El editor guardaba el cuerpo tal cual lo tipeabas: una nota de una sola línea sin
// Enter final quedaba sin `\n` terminal, y el siguiente que appendeaba "robaba" su autoría.
//
// Fix: garantizar que toda nota no-vacía termine en EXACTAMENTE un `\n` final (convención estándar
// de archivos de texto POSIX). Así la última línea de cada commit ya está newline-terminada y un
// append posterior no reescribe sus bytes → el blame atribuye cada línea a su autor real.

/** Asegura un único `\n` terminal en el contenido de una nota (sin tocar el resto). Idempotente.
 *  Vacío queda vacío (no creamos contenido donde no lo hay). Si ya termina en `\n` (uno o varios),
 *  no toca nada: sólo nos importa que la ÚLTIMA línea esté newline-terminada, no colapsar líneas
 *  en blanco que el usuario haya tipeado a propósito. */
export function withTrailingNewline(content: string): string {
  if (content === "") return content;
  return content.endsWith("\n") ? content : content + "\n";
}
