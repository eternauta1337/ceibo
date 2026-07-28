// Bienvenida de Ceibo: cada wiki nueva arranca con una nota de bienvenida llamada `Bienvenida.md`.
// GitHub autogenera un `README.md` pelado (`auto_init` → `# <nombre-repo>`, sin valor); en vez de
// dejarlo suelto, lo CONVERTIMOS en `Bienvenida.md` con el contenido de abajo: una nota normal
// (editable/movible/borrable/renombrable, Fase #379) con contenido útil de arranque, para que un
// usuario nuevo entienda qué es Ceibo, cómo funciona su wiki y cómo hablarle al agente. La wiki
// queda con `Bienvenida.md` y SIN README suelto (el `.gitkeep` mantiene el repo no-vacío).
//
// El mismo texto + predicado se usan para el backfill de wikis viejas (que aún tienen el README
// pelado). Única fuente de verdad: `WELCOME_MARKDOWN` (contenido) e `isBareReadme` (predicado
// "el README sigue pelado") — así nunca pisamos un README que el usuario ya editó.

/** Path (repo-relativo) del README de la RAÍZ que deja `auto_init` (origen de la conversión). */
export const README_PATH = "README.md";

/** Path (repo-relativo) de la nota de bienvenida (destino de la conversión). Nota normal. */
export const WELCOME_PATH = "Bienvenida.md";

/** Contenido de bienvenida (markdown) de la nota `Bienvenida.md`. Voz cálida, es-AR, coherente con
 *  el tono del asistente. Es una nota normal: el usuario puede editarla, renombrarla o borrarla. */
export const WELCOME_MARKDOWN = `# Hola, soy Ceibo 🌳

Soy tu **asistente personal**. Estoy para sacarte cosas de encima: anotar, buscar, recordarte y ordenar lo que importa. Me hablás como a una persona —por voz o por texto— y yo me encargo.

## Tu wiki

Todo lo que vale la pena guardar vive acá, en **tu wiki**: una colección de notas tuya, privada y siempre tuya.

- **La mantengo por vos.** Me decís algo —"anotá que el martes tengo turno con el dentista"— y creo u ordeno la nota solo.
- **Vos también editás.** Abrí cualquier nota desde el panel de la izquierda y escribí directo: lo que tipeás se guarda solo, sin botón de guardar.
- **Nada se pierde.** Cada cambio queda versionado. Si archivás una nota, sale de la vista pero la puedo recuperar cuando la necesites.

## Cómo hablarme

Elegí la forma que te quede más cómoda:

- **El orbe** — mantenelo presionado y hablá; soltá cuando termines. O deslizá hacia arriba mientras grabás para dejar el micrófono abierto en manos libres. Te respondo con la voz.
- **El chat** — el botón de abajo a la derecha. Escribí o mandá un audio, con todo el historial a la vista.

Como me hablás te respondo: si me mandás un audio, te contesto con la voz; si escribís, te escribo.

### Cosas que me podés pedir

- *"Anotá que…"* o *"Guardá esto en mis notas"*
- *"¿Qué tenía anotado sobre…?"* o *"Buscá la nota de…"*
- *"Recordame mañana a las 9 que…"*
- *"Armame una nota con los pasos para…"*
- *"Resumime lo que hablamos hoy"*

## Estoy en todos lados

Te acompaño también por **WhatsApp** y **Telegram**: la misma memoria y las mismas notas, desde donde te quede a mano. Conectá tus canales desde el panel de la izquierda.

---

¿Arrancamos? Cerrá esta nota y mantené presionado el orbe —o deslizá hacia arriba mientras grabás para manos libres— para decirme la primera cosa. **Estoy para vos.**
`;

/** ¿El contenido de este README es el auto-init "pelado" de GitHub (o equivalente trivial)?
 *
 *  CONSERVADOR a propósito: sólo devolvemos `true` si el README no tiene contenido real que un
 *  usuario haya escrito. "Pelado" = una de estas formas:
 *    - vacío (o sólo espacios en blanco),
 *    - exactamente UN heading H1 (`# algo`) y nada más,
 *    - DOS líneas: un H1 (`# <repo>`) seguido de la línea de descripción que mete `auto_init`
 *      cuando el repo se crea CON `description` (GitHub la pone como 2da línea del README). En
 *      ceibo `createRepo` siempre pasa `description: "wiki <flavor>: <name>"`, así que el README
 *      real de prod es `# <name>\nwiki ceibo: <name>` (o `wiki managed-2: <name>` en repos viejos).
 *  Cualquier otra cosa (un párrafo de verdad, una lista, un 2º heading, una 2da línea que NO sea
 *  esa descripción de auto_init) → `false`: hay contenido del usuario y NO lo tocamos. Ante la
 *  duda, no tocar.
 *
 *  Notas de robustez: ignoramos líneas en blanco; toleramos comentarios HTML que algún auto-init
 *  pudiera dejar; NO miramos el nombre del repo (un H1 con cualquier texto cuenta como pelado,
 *  porque `auto_init` pone `# <repo>` y no queremos atarnos al nombre exacto). */
export function isBareReadme(content: string): boolean {
  // Líneas con contenido real, sin blancos ni comentarios HTML (los comentarios no son contenido
  // que el usuario "vea" como nota).
  const lines = content
    .replace(/<!--[\s\S]*?-->/g, "") // saca comentarios HTML completos (multilínea)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return true; // vacío / sólo espacios → pelado

  const [first, second] = lines;
  const isH1 = first !== undefined && /^#\s+\S/.test(first);

  // Pelado clásico de auto_init: una sola línea, y es un único H1.
  if (lines.length === 1 && isH1) return true;

  // Auto_init CON description: H1 + la línea de descripción `wiki <flavor>: <X>` que GitHub
  // copia como 2da línea del README. Sólo ESA forma exacta cuenta como pelado (nada más laxo:
  // una 2da línea distinta es contenido real del usuario).
  if (lines.length === 2 && isH1 && second !== undefined && /^wiki\s+[^:]+:\s+\S/.test(second)) {
    return true;
  }

  // Cualquier otra forma tiene contenido real → no tocar.
  return false;
}

/** Subconjunto de `Wikis` que necesita la siembra. Lo tipamos estructuralmente (en vez de
 *  importar `Wikis` de index.ts) para no crear un import circular welcome ↔ index. */
interface WikiWelcomeIO {
  getFile(repoName: string, path: string): Promise<{ content: string; sha: string }>;
  /** Mueve un archivo en UN commit (crea destino + borra origen). `opts.newContent` reemplaza
   *  el contenido en el destino. Tira si el destino ya existe. */
  moveFile(
    repoName: string,
    fromPath: string,
    toPath: string,
    baseSha: string,
    message: string,
    opts?: { newContent?: string },
  ): Promise<{ sha: string; path: string }>;
}

/** Convierte el README pelado de auto_init en la nota de bienvenida `Bienvenida.md`.
 *
 *  `auto_init` deja un `README.md` pelado (`# <repo>`). Lo movemos a `Bienvenida.md` con el
 *  contenido de bienvenida en UN solo commit (`moveFile` con `newContent`): crea `Bienvenida.md`
 *  y borra el `README.md` pelado a la vez → la wiki queda con la bienvenida y SIN README suelto.
 *
 *  Sólo actúa si el README sigue PELADO (`isBareReadme`): si ya tiene contenido real del usuario,
 *  lo dejamos intacto (no creamos Bienvenida ni tocamos su README) — el mismo predicado que usa el
 *  backfill, así nunca clobbereamos algo del usuario.
 *
 *  Best-effort: cualquier fallo (GitHub caído, race, `Bienvenida.md` ya existente) se loguea y NO
 *  se propaga — la wiki ya existe, igual que el `.gitkeep`. El caller la llama sin try/catch propio. */
export async function seedWelcomeNote(
  wikis: WikiWelcomeIO,
  repoName: string,
  log: (s: string) => void = (s) => console.warn(s),
): Promise<void> {
  try {
    const readme = await wikis.getFile(repoName, README_PATH);
    if (!isBareReadme(readme.content)) return; // README con contenido real → no tocar nada
    await wikis.moveFile(repoName, README_PATH, WELCOME_PATH, readme.sha, "docs: nota de bienvenida", {
      newContent: WELCOME_MARKDOWN,
    });
  } catch (e) {
    log(`seedWelcomeNote: no se pudo crear la bienvenida en "${repoName}": ${(e as Error)?.message ?? e}`);
  }
}
