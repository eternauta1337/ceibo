# decay — prueba en staging (end-to-end, incluye el plugin)

> QA manual del feature `decay` en **staging** (`staging.example.com`). A diferencia de dev-local, acá se ejercen las piezas de **archi** (plugin de opencode + REM) sobre una runtime prod-like. (2026-06-30) · Diseño: `spec.md` · Local: `prueba-local.md`.

## Por qué staging es seguro para esto

De `tecnico/features/staging/staging-spec.md` §3: la **GitHub App de wikis es compartida conprod, PERO staging apunta a wikis de PRUEBA, no a los repos reales** → los productores escriben frontmatter en **wikis de test**, no en tus `ajs-*`. Cuenta de staging del owner separada (no toca tu yo-de-prod), DB propia, y **VMs de archima namespaceadas** por entorno. ⇒ cero riesgo de datos; podés probar el plugin que en la mac es imposible.

> ⚠️ **Es una sesión de deploy a staging.**  Cada `--apply` es una acción explícita del owner. La regla "no tocar staging" prohíbe rsync/systemctl/instrumentación ad-hoc — un deploy con estos scripts ES la forma bendecida. Diagnóstico **read-only** (journalctl, git log) está OK. Prod (`app.example.com`) NO se toca en ningún paso.

## Alcance

Cubre las 5 piezas: editor (#658), primitiva+seed (#665), web-producer (#670), **plugin#opencode (#669)**, **gate de REM (#672)** .


---

## Prerrequisitos

- Estar en el repo con `dev` al día y los PRs del feature mergeados a `dev` (o a punto de).
- Acceso SSH a la box (`deploy@<edge-host>`) y a archi (`archetype1`) — para diagnóstico read-only y para correr los deploys.
- El cutover de entornos de staging ya hecho (F6.2/F6.4: `~/ceibo-staging` y `~/archima/staging` existen). Si no, parar y resolver eso primero.


---

## Paso 1 — Promover `dev → staging` (por PR, CI-gated)

Las branches son PR-only; `git push origin staging` se rechaza. Mergeá a `dev` primero (en orden: #658, #665 base; después #669, #670, #672), y abrí el PR `dev → staging`:

```bash
gh pr create --base staging --head dev --title "promote: decay → staging" --body "feature decay completo"
# esperá CI verde (lint+typecheck; staging NO corre tests) y mergealo (merge commit, NO squash)
```

Verificá que `origin/staging` quedó al día:

```bash
git fetch origin && git log --oneline origin/dev ^origin/staging   # debería estar vacío
```


---

## Paso 2 — Deploy del BOX (editor + web-producer + gateway)

```bash
./scripts/deploy-staging.sh            # DRY-RUN: muestra todo lo que haría, no toca la box
./scripts/deploy-staging.sh --apply    # real (pide confirmación)
```

Hace: rsync de `origin/staging` → `~/ceibo-staging`, rebuild de `packages/web` (porque tocó #658), restart de #ceibo-{gateway,webserver,oauth,mcps}@staging#, smoke check. Tras esto el#editor (#658) y el web-producer (#670) están vivos en `https://staging.example.com`.

> Hacé este paso ANTES del plugin: que el editor esté arriba antes de que aparezca frontmatter (aunque en wikis de test no se ve en prod, mantenemos el orden sano).


---

## Paso 3 — Deploy de ARCHIMA (el plugin #669)

```bash
git checkout staging && git pull        # deploy SIEMPRE desde la branch del entorno
pnpm deploy:archima:staging             # dry-run (= bash scripts/deploy-archima.sh staging)
pnpm deploy:archima:staging --apply     # real
```

Hace: `build` del paquete (vendoriza `frontmatter.ts` al lado del plugin) → rsync → `~/archima/staging/`. **NO reinicia nada**: cp.sh se forkea por turno y lee los archivos nuevos en el **próximo spawn/serve** de una VM. ⇒ el plugin entra en la próxima sesión de staging.


---

## Paso 4 — REM en staging (opcional / avanzado)

El gate de REM (#672) **no lo cubre ningún script de deploy** (rem-runner se copia a mano, ver `packages/rem-runner/CLAUDE.md`). Dos opciones:

- **Suficiente para validar el gate:**  corré el **dry-run** contra una wiki de test sembrada (mismo comando que en local, ver `prueba-local.md` §6). No necesita deploy.
- **End-to-end real (avanzado):**  copiar el bundle a `~/rem-runner/` en archi con un `rem-batch.env` apuntado a staging y correr el batch a mano. Sólo si querés ver el ciclo completo planner→gate→executor sobre las wikis de test. El gate es conservador (sin frontmatter no archiva), así que recién muestra algo cuando las notas de test tengan `accessed`/`reads`.


---

## Pruebas + qué verificar

### A) Editor + web-producer (igual que local, pero en staging)


1. `https://staging.example.com` → login con la **cuenta de staging del owner**.
2. Abrí una nota de la wiki de **test**: ✅ ves el chip "⚙ N propiedades", NO `---` crudo.
3. Verificación dura: la respuesta de `GET /api/file?repo=...&path=...` (DevTools → Network) trae `accessed: <hoy>`, `reads: 1`, y un `sha` nuevo. Re-abrir el mismo día → `reads` sigue en 1 (debounce).

### B) Plugin (#669) — LO QUE STAGING HABILITA


1. Abrí un **chat nuevo** en staging (fuerza un spawn/serve → cp.sh empuja el plugin a la VM).
2. Pedile al agente que **lea** una nota: "¿qué dice mi nota \<X\>?" (dispara su tool `read`).
3. **Verificá el bump** (read-only). Dos ángulos:
  - En la VM de staging: el archivo `~/work/<wiki>/<X>.md` ahora tiene `accessed`/`reads` en el frontmatter (ssh a la VM vía el control-plane de archima, o `cp.sh` del runtime staging).
  - En el repo de la wiki de test: buscá el commit del bump (si el sync lo pushea).
4. ✅ **Éxito:**  la nota leída quedó con frontmatter de decay. ❗ **Punto a confirmar de verdadacá** (no se pudo testear sin VM): que opencode **cargue** el plugin (mirá los logs de `opencode-serve` en la VM al arrancar) y que el bump de una lectura **se commitee/pushee** al repo de test (si una vuelta read-only no dispara push, anotalo — es feedback de diseño).

### C) Gate de REM (#672)

- Por dry-run (paso 4, opción 1): la salida imprime `decay-gate (ON): X de Y vetadas`. Con notas recién sembradas (todas frescas) debería **vetar casi todo archivado** — correcto/conservador.


---

## Monitoreo (read-only)

```bash
# Box staging — servicios:
ssh deploy@<edge-host> 'journalctl -u ceibo-webserver@staging -n 50 --no-pager'
ssh deploy@<edge-host> 'head -1 ~/ceibo-staging/.deployed-sha'          # qué SHA corre
# ¿la box quedó == origin/staging? (guard por contenido)
./scripts/verify-prod.sh --ref origin/staging --box deploy@<edge-host> --tree ceibo-staging

# Archima staging — runtime desplegado + VMs:
ssh archetype1 'head -1 ~/archima/staging/.deployed-sha'
ssh archetype1 '~/archima/staging/vm/cp.sh list'                          # VMs de staging y estado
# Logs de opencode en una VM (¿cargó el plugin? ¿errores en tool.execute.after?):
#   vía el control-plane de archima: journalctl -u opencode-serve en la VM
```

## Criterios de éxito

- [ ] A: editor esconde frontmatter en staging; `/api/file` devuelve `accessed`/`reads:1`/sha nuevo; debounce OK.
- [ ] B: tras un turno de chat que lee una nota, esa nota de test quedó con frontmatter de decay; `opencode-serve` no logueó errores del plugin.
- [ ] C: el dry-run de REM imprime la línea `decay-gate` y veta archivados de notas no frías.

## Rollback

- **Box:**  redeployá el SHA previo (`deploy-staging.sh` desde un `origin/staging` revertido) o revertí el PR de promoción y redeployá. Bajo riesgo: el web-producer es best-effort/debounced, el editor es estado de vista.
- **Archima:**  el plugin es falla-cerrado (un error no rompe el turno). Para sacarlo, redeployá un runtime sin el `plugin` en el config; entra en el próximo serve.
- **Datos:**  son wikis de **test** → si algo quedó feo, se descartan/re-seedean sin tocar prod.

## NO hacer

- ❌ Tocar prod (`app.example.com` / `~/ceibo`) en ningún paso.
- ❌ rsync/systemctl/console.log a mano sobre staging fuera de estos scripts.
- ❌ Apuntar el seed o el batch de REM a wikis reales — sólo wikis de test de staging.

## Reportá

Criterios A/B/C ✅/❌, la salida de `/api/file`, lo que viste en los logs de `opencode-serve` (¿cargó el plugin?), y si el bump de una lectura se pusheó al repo de test. Con eso se decide el deploy a **prod** (orden en `plan.md`: box-prod primero, después seed, después archi).
