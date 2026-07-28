# Fragmentos de changelog

Cada PR que cambia algo observable agrega **un archivo** acá. Un archivo por PR = **cero
conflictos de merge** (nadie edita un `CHANGELOG.md` compartido). Las promociones son
squash-merge, así que el historial de commits **no** sirve como fuente — por eso fragmentos.

## Formato

- **Nombre:** `<slug>.<tipo>.md` — ej. `453-deploy-archima-dashdash.chore.md`.
- **Tipos:** `feat` · `fix` · `perf` · `docs` · `chore`.
- **Contenido:** una línea user-facing en markdown, sin encabezado (multilínea OK).

## Ciclo (ver `tecnico/features/staging/ciclo-de-release.md` en la wiki)

- **PR → dev:** agregás tu fragmento. El check `changelog` lo exige; etiquetá el PR con
  `skip-changelog` si el cambio no es observable.
- **release `dev→staging`:** `pnpm changelog` imprime los fragmentos agrupados → va en el
  cuerpo del PR de release / preview de staging.
- **release `staging→main` (prod):** `pnpm changelog:release "<fecha o versión>"` foldea los
  fragmentos al `CHANGELOG.md` canónico y los borra.
