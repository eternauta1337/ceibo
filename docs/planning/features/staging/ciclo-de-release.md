# Ciclo de release — dev → staging → prod

> Estado: **ciclo acordado con el owner** (2026-06-17) · autor: claude (opus). Destila el flujo de branches/entornos de `ceibo/CLAUDE.md` en el ciclo operativo de release. El gating de promoción y el flow-guard que lo sostienen viven en los PRs #439 (gates de promoción robustos a squash) y #440 (flow-guard en CI). El **changelog** quedó **implementado** en #454 (ver sección Changelog).

## El modelo en dos frases

Los PRs de feature van **solo a** `**dev**`. La promoción a staging y a prod es por **PRs derelease** (uno por salto, no uno por feature) — `dev→staging` y `staging→main` —, y **mergear ≠ deployar**: el merge mueve el branch, el deploy a la box es un paso aparte que el owner autoriza **por entorno**.

## Refinamientos que no son obvios


1. **La promoción es por release, no por feature.**  Juntás todas las features en `dev`, y después hacés *un* PR `dev→staging` y, más tarde, *un* PR `staging→main`. El flow-guard (#440) lo obliga: un PR a `staging` solo se acepta desde `dev`, uno a `main` solo desde `staging` (branch protection no puede restringir el branch *origen* de un PR, así que lo enforça el CI).
2. **Merge ≠ deploy.**  Mergear `dev→staging` mueve el branch `staging` pero **no toca labox**. `main` HEAD = lo que *debería* correr en prod, pero prod solo cambia cuando se corre el runbook de deploy. El deploy a prod y el deploy a staging se autorizan por separado (ver el ⛔ "PROD Y STAGING NO SE TOCAN" en `ceibo/CLAUDE.md`).

## El ciclo, paso a paso


1. **Merge de cada PR de feature a** `**dev**` — CI = lint + typecheck, self-merge OK. Por `strict:true`, si mergeás varios en la misma sesión **serializá** (mergeá uno → `git pull --ff-only` de dev → rebaseá el siguiente) para evitar el rebase-dance. Los PRs que tocan el mismo archivo *deben* ir en serie.
2. **QA en dev** — `pnpm dev` en la mac del owner (dev *es* la mac, no deploya a ningún lado). Se ejercita todo junto sobre el working tree de `dev`.
3. **PR de release** `**dev → staging**` — CI escala:  **\+ suite completa de tests**. Merge → **deploy a staging** (paso aparte, autorizado). Si el release incluye cambios de runtime de archima, son **dos** acciones de deploy: rsync + restart del gateway/web en la box, *y* `deploy-archima.sh staging --apply` para `~/archima/staging`.
4. **QA en staging** — sobre `staging.example.com`, con la cuenta real del owner conectada (ver F6.3 en `staging-plan-2.md`). Acá se "siente" de verdad.
5. **PR de release** `**staging → main**` — CI escala:  **\+ coverage (pisos por-archivo) + QAmanual (runsheet)** . Merge → **deploy a prod** (paso aparte, autorizado por separado de staging): el runbook de rsync + restart + `deploy-archima.sh prod --apply` si tocó runtime de archima.

> **Meta:**  el tooling del propio ciclo (gates de promoción #439, flow-guard #440, fix del `--` de `deploy-archima` #453) conviene tenerlo en `dev` **antes** del primer release a staging, así el PR `dev→staging` ya corre con los gates puestos.

## Changelog (implementado · #454)

**Objetivo del owner:**  que cada release a staging llegue **con un changelog**, y que los changelogs se **combinen en un gran changelog** en cada release a prod.

**Por qué fragmentos y no** `**git log**` **:**  las promociones son **squash-merge** (de hecho los gates de #439 dejaron de usar ancestría de commits justo por esto). Entonces el historial de commits **no** es fuente confiable de changelog. La forma robusta es el patrón de **fragmentos** (estilo *towncrier* / *changesets*): cada PR aporta su propia entrada en un archivo nuevo, y la promoción *agrega* los fragmentos.

**Cómo funciona (implementación real):**

- **Por cada PR de feature → dev:**  el PR agrega un fragmento `changelog.d/<slug>.<tipo>.md` (tipo ∈ `feat`/`fix`/`perf`/`docs`/`chore`) con una línea user-facing. Un archivo por PR = **cero conflictos** de merge. El workflow `changelog` (aparte de `ci.yml`) lo exige; label `skip-changelog` lo saltea. Hoy es **advisory** — para hacerlo bloqueante hay que agregar el check `changelog` a `required_status_checks` de la branch protection de `dev`.
- **En el release** `**dev → staging**` **:**  `pnpm changelog` (= `node scripts/changelog.mjs render`) imprime los fragmentos acumulados, agrupados por tipo → va en el cuerpo del PR de release / preview de staging. Los fragmentos quedan vivos (no salieron a prod todavía).
- **En el release** `**staging → main**`  **(prod):**  `pnpm changelog:release "<fecha o versión>"` foldea los fragmentos al **gran changelog** canónico (`CHANGELOG.md`, user-facing) bajo un encabezado nuevo y **borra** los fragmentos de `changelog.d/`.

Formato y detalle: `changelog.d/README.md` en el repo. Bootstrap del primer ciclo: #454#sembró un fragmento por cada PR en vuelo (#439–#453, etiquetados `skip-changelog`), así el primer release `dev→staging→prod` ya trae changelog real.

**Off-the-shelf antes que custom** (ver memoria `feedback_official_plugins_first`): [Changesets](https://github.com/changesets/changesets) es el estándar de monorepos pnpm, pero asume publishing semver por-paquete; acá hay **un deploy lógico** y branch-flow, así que mapeaba peor que el fragmento crudo. **Evaluado y descartado por ahora** a favor del script propio chico (towncrier-like).
