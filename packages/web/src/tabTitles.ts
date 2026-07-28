// Desambiguación de los títulos de los TABS abiertos, estilo editor de código (VS Code).
//
// Cuando dos o más tabs comparten el mismo basename (ej. dos `backlog`), el título pelado no
// alcanza para saber cuál es cuál. Acá anteponemos el prefijo MÍNIMO de path que los distingue
// (`ceibo/…/backlog` vs `personal/…/backlog`); un tab sin colisión queda con el nombre pelado.
//
// Los segmentos de path incluyen el repo/wiki como ancestro MÁS ALTO, así que dos notas homónimas
// en wikis distintas se distinguen por la wiki. Si el prefijo distintivo NO es el padre directo,
// se intercala `…` para señalar que hay carpetas ocultas entre el prefijo y el basename.
//
// Es PURA (sin deps, sin React): vive en su propio módulo para poder testearla en node.

/** Un tab visto por la desambiguación: su id, el basename a mostrar (`title`, ya sin carpeta ni
 *  `.md`) y su ubicación (`repo` + `path` completo). */
export interface TabTitleInput {
  id: string;
  title: string;
  repo: string;
  path: string;
}

/** Ancestros de un tab: `[wiki, ...carpetas]` (sin el basename). El ancestro más alto es el
 *  DISPLAY LABEL (alias) de la wiki — no el slug/nombre real del repo — vía `repoLabel`; si no
 *  hay alias mapeado cae al slug. Vacíos descartados. */
function ancestorsOf(t: { repo: string; path: string }, repoLabel?: (repo: string) => string): string[] {
  const dirs = t.path.split("/").slice(0, -1).filter(Boolean);
  const wiki = repoLabel ? repoLabel(t.repo) : t.repo;
  return [wiki, ...dirs].filter(Boolean);
}

/**
 * Mapa `id → título a mostrar` para una lista de tabs abiertos. Los tabs cuyo basename es único
 * quedan con el nombre pelado; los que colisionan reciben el prefijo de path mínimo que los
 * distingue dentro de su grupo de colisión (con `…` si el prefijo no es el padre directo).
 *
 * `repoLabel` resuelve el slug del repo a su DISPLAY LABEL (alias que el usuario le puso a la
 * wiki); cuando colisionan notas de wikis distintas, el prefijo muestra el alias, no el slug
 * real. Sin `repoLabel` (o sin entrada para ese repo) cae al slug.
 */
export function disambiguateTabTitles(
  tabs: TabTitleInput[],
  repoLabel?: (repo: string) => string,
): Map<string, string> {
  // Agrupar por basename: sólo los grupos con >1 miembro colisionan y necesitan desambiguar.
  const byTitle = new Map<string, TabTitleInput[]>();
  for (const t of tabs) {
    const g = byTitle.get(t.title);
    if (g) g.push(t);
    else byTitle.set(t.title, [t]);
  }
  const out = new Map<string, string>();
  for (const [title, group] of byTitle) {
    if (group.length === 1) {
      const only = group[0];
      if (only) out.set(only.id, title);
      continue;
    }
    const groupAncestors = group.map((t) => ancestorsOf(t, repoLabel));
    group.forEach((t, i) => {
      const a = groupAncestors[i] ?? [];
      // Prefijo mínimo `k` tal que `a.slice(0,k)` es único entre los ancestros del grupo.
      let k = 1;
      for (; k <= a.length; k++) {
        const key = a.slice(0, k).join("/");
        const unique = groupAncestors.every((other, j) => j === i || other.slice(0, k).join("/") !== key);
        if (unique) break;
      }
      // Sin prefijo distintivo (paths idénticos, no debería pasar): cae al nombre pelado.
      if (k > a.length) {
        out.set(t.id, title);
        return;
      }
      const shown = a.slice(0, k);
      const hidden = k < a.length; // hay carpetas entre el prefijo mostrado y el basename
      out.set(t.id, `${shown.join("/")}/${hidden ? "…/" : ""}${title}`);
    });
  }
  return out;
}
