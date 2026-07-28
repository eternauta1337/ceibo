// Filtrado PRESENTACIONAL del listado de archivos del explorer. Puro (sin DOM, sin
// estado) para poder testearlo en node — la UI del explorer (Explorer.tsx) es jsdom y
// queda fuera del harness, así que la lógica de "qué archivo es nota visible" vive acá.

/** ¿Este archivo participa del árbol del explorer (como nota o como ancla de carpeta)?
 *
 *  Filtra lo que NO es nota del usuario:
 *   - dotfiles (cualquier nombre que empieza con `.`) — ruido interno, NO son notas. La
 *     EXCEPCIÓN es `.gitkeep`: ancla una carpeta vacía (ver abajo) — pasa el filtro pero se
 *     oculta como nota en TreeNodes.
 *   - lo que no es `.md`.
 *   - `CLAUDE.md` en cualquier nivel (convenciones internas del repo).
 *
 *  El `README.md` de la RAÍZ SÍ se muestra: es la **bienvenida** de Ceibo (el explorer lo
 *  etiqueta "Bienvenida" y la vista pinta un texto estático de onboarding en vez de su
 *  contenido autogenerado — ver `welcome.ts`). Antes se ocultaba porque GitHub lo autogenera
 *  con un `# <nombre-repo>` pelado; ahora ese ruido no importa porque no mostramos el archivo
 *  crudo, mostramos la bienvenida. (Un `README.md` dentro de una carpeta sigue siendo una nota
 *  normal del usuario y también se muestra.)
 *
 *  `.gitkeep` (ancla de carpeta vacía) y los manifests de archivado (`.archived.md` nuevo y
 *  `_archivado.md` legacy) SÍ pasan este filtro a propósito: anclan la EXISTENCIA de su carpeta
 *  (buildTree infiere carpetas desde los paths de archivo); como NOTA se ocultan más adelante, en
 *  TreeNodes. (`_index.md` legacy recibe el mismo trato — ya no se crea, pero los que quedaron en
 *  wikis viejas siguen anclando su carpeta sin mostrarse como nota.) El `.archived.md` necesita la
 *  excepción explícita porque, al ser dotfile, si no caería en el filtro de `.` de abajo. */
export function isVisibleWikiFile(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  if (base === ".gitkeep") return true; // ancla de carpeta vacía (se oculta como nota en TreeNodes)
  if (base === ".archived.md") return true; // manifest de archivado (dotfile): ancla su carpeta
  if (base.startsWith(".")) return false; // dotfiles: ruido interno, no son notas
  if (!path.endsWith(".md")) return false;
  if (base === "CLAUDE.md") return false;
  return true;
}
