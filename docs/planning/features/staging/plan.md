# Fase 6 — Runtime de archima al flujo dev→staging→prod

> Estado: **plan por fases** (2026-06-16) · autor: claude (opus). Expande la "Fase 6 — Futuro" de `staging-plan.md` (archivado) con las decisiones tomadas en la charla (`prompt-2.md`, archivado). Convenciones PR/CI/commits: umbrella `../CLAUDE.md`. **Discusión previa cerrada** — este doc ya integra los forks resueltos (§Decisiones).

## El problema, en una línea

El **cliente** de archima (cómo el monorepo habla con la box: `packages/backend-local`, `ENV_ID`, `ARCHIMA_*`) **ya fluye** por dev→staging→prod. El **runtime** de archima (`cp.sh`, provisioning de VMs libvirt, config de opencode, golden) vive **a mano enarchetype1** (`~/experiment-malocal`, ni siquiera es repo git — su "versionado" son \~20 `.bak-<timestamp>`), **no pasa por CI ni branches, y es una copia única que se le sirve alas VMs de los tres entornos**. Un cambio de runtime hoy impacta a prod sin red de contención.

## El reframe (importante)

El planteo "los tres le pegan al mismo vLLM → no hay aislamiento" mezcla dos cosas:

- **El vLLM compartido está bien y es por diseño** (spec §5: el modelo es dependencia externa, como la API de Anthropic — *no* se versiona por entorno).
- Lo que "impacta a los tres" **no es el vLLM**: es que `cp.sh` + `configs/opencode-delegv2.json`
  - la golden son **un solo set hand-maintained**. Hoy las VMs de staging (que ya existen, namespaceadas — ver abajo) corren **el runtime de prod**.

**La costura de aislamiento ya está medio construida:**  `ArchimaBackend` deriva el nombre de cada VM como `${slug(title)}-${envId}` (`packages/backend-local/src/archima-backend.ts`, `vmName()`), con `isOwnVmName()` validando el marcador de entorno. O sea staging (`ENV_ID=ceibo-staging`) y prod (`ceibo-prod`) **no colisionan** en el pool libvirt. Falta (a) **versionar** el runtime y (b) tener **copias del control-plane scopeadas por entorno** en la box, para que cada env corra su propio `cp.sh`/config **contra el mismo vLLM**. "Runtime de staging vs prod sobre vLLM compartido" = scopear la **copia del control-plane**, no duplicar inferencia.

## Decisiones (cerradas en la charla 2026-06-16)


1. **Dónde vive el runtime versionado:**  paquete nuevo en el **monorepo** (ej. `packages/archima-runtime`). Razón: **un solo SHA por todo el vertical** (spec §1) — el cliente (`backend-local`) y el runtime se promueven juntos. El deploy a archetype1 es un **target nuevo** keyeado por branch (rsync, como el resto), aunque la máquina destino sea distinta (archi, no <hosting-provider>).
2. **Alcance de esta ronda:**  versionar  **\+ encender staging-runtime ya** (permanente, con QA e2e). Se asume la contención sobre el vLLM compartido.
3. **dev también en archi, con label distinto:**  los tres entornos SSHean a la misma box (archi) y comparten el vLLM; cada uno tiene su **dir de runtime** y sus VMs namespaceadas por `ENV_ID` (`-ceibo-dev` / `-ceibo-staging` / `-ceibo-prod`). El gateway de dev corre en la mac pero apunta al runtime-dev de archi. **No hace falta libvirt en la mac.**
4. **Nombre/topología en la box:**  `~/archima/{dev,staging,prod}` (graduación de `experiment-malocal`, que empezó como experimento y hoy *es* el runtime de prod). Solo esos tres subdirs son checkouts versionados; el **binario** de agent-vault y la golden quedan como assets compartidos a nivel box (no en el git de ceibo).
5. **Vault (agent-vault) aislada por entorno** — daemon + store + master key + CA **propiospor entorno** (espejo de la DB-por-env). La vault guarda secretos reales (tokens OAuth de la familia) → es plano de **estado**, no dependencia compartida como el vLLM. Ver §Vault.

```
~/archima/
  prod/            ← branch main      (= el experiment-malocal actual, renombrado)
  staging/         ← branch staging
  dev/             ← branch dev
  agent-vault/     ← binario AV (vendoreado, box-level, NO en git de ceibo)
~/.agent-vault/{prod,staging,dev}/   ← store + master key + CA POR ENTORNO (estado, off-git)
  daemons: agent-vault@<env>.service — prod 14321/14322, staging 14323/14324, dev 14325/14326
(golden en el pool libvirt /var/lib/libvirt/images — compartida; se versiona la RECETA)
```

## Qué se versiona y qué no

- **Se versiona** (\~500 K, va al paquete, de-secreteado): `vm/` (`cp.sh`, `cp-forced.sh`, `spawn-vm.sh`, `build-golden.sh`, `warm-golden.sh`, `vm-firewall.sh`, `user-data.tpl.yaml`)
  - `configs/` (`opencode-delegv2.json`, agente/prompts). **Sin los**  `**.bak-\***`  (git los reemplaza). La key de vLLM **no** se versiona — el placeholder `__VLLM_KEY__` ya existe y `serve` lo sustituye desde un archivo protegido de la box (`~/.archima/vllm.key`).
- **Vive en la box, NO en git** (dependencia / asset pesado): el **binario** de `agent-vault` (29 M + checkout upstream; black-box, como opencode/vLLM — pero su \*\*versión\*\* se pineapor-entorno en el manifiesto del paquete) y las imágenes \`vms/\` (600 M: `noble-base.img` \+ golden → se versiona la **receta** `build-golden.sh`, no el blob).
- **Estado per-env, off-git** (como `ceibo.<env>.db` y `.env.<env>`): el \*\*store + master key
  - CA\*\* de cada vault (`~/.agent-vault/<env>/`). La **unit** `agent-vault@<env>.service` sí se versiona (template, como `ceibo-<svc>@<env>.service`).
- **Cruft a borrar** (\~315 M): `bao/` (OpenBao, **descartado** por diseño), `av-run`, `av-test`, `testwiki/`, `.venv/`, `vllm-*.log`, `measure_turn.sh`. `bench/` se archiva a la wiki (de ahí salieron los números de capacidad) y se saca de la box.

## Reconciliación de fuente única (drift)

Los prompts del agente (`configs/prompts/ceibo.md`, `ceibo-worker.md`) están **hand-copiadosen la box y driftearon** del repo, que los **genera** con `print-prompt` desde `packages/gateway/prompt/{core,coordinator-archima,worker-archima}.md`. Igual `wiki-sync.mjs` (fuente única = `packages/agent/wiki-sync.mjs`, vendorizado a `configs/`). **Canónico = elrepo.**  Parte de F6.1 es decidir el set canónico y que el deploy regenere/vendorice estos artefactos, no que vivan editados a mano.

## Vault (agent-vault) — plano de secretos, aislado por entorno

**Qué es:**  Infisical Agent Vault — un daemon Go en archi (hoy `:14321`, MITM `:14322`) que **inyecta** las credenciales OAuth en los MCP de cada VM por HTTPS-MITM, sin que la VM vea el token (espejo del vault de MA). El broker OAuth de ceibo (`packages/oauth`, ya per-env en <hosting-provider>) pushea el access-token corto al store; `cp.sh assign` mintea un agent-token de rol `proxy` scopeado al vault del usuario. El `ArchimaBackend` ya maneja `agent-vault vault create|credential|service` por el forced-command SSH.

**Estado hoy (a reparar):**  UN solo daemon, UN store (`~/.agent-vault/agent-vault.db`), UNA master key. Adentro conviven los vaults **reales** de la familia (`vault-<owner>`, `ceibo-lula`, `ceibo-anni`, …) con los de prueba `ceibo-dev` y `ceibo-<test-user>` (staging) y basura de experimentos (`poc`, `default`, `btest-vault`, `ceibo-archima-test`). Se separan por *handle*, **no por entorno** → secretos reales de prod y vaults de prueba bajo la misma master key y el mismo proceso.

**Por qué aislar por entorno (no compartir como el vLLM):**  la vault es **estado con secretosreales** → clase DB, no clase dependencia. El invariante del spec ("romper staging no toca tu yo-de-prod") lo exige justo para lo más sensible. Y es **obligatorio para el QA**: como el binario AV y la lógica de `assign` *son* runtime, un bump de AV o un cambio de `assign` no se puede QA-ear en staging si comparte el daemon de prod.

**Diseño (decisión: 3 stores separados):**

- **Daemon por entorno:**  `agent-vault@<env>.service` (unit template, versionada). Puertos: prod `14321/14322`, staging `14323/14324`, dev `14325/14326`.
- **Store + master key + CA por entorno:**  `~/.agent-vault/<env>/` (estado/secreto, off-git).
- **Binario:**  vendoreado, instalado en la box; **versión pineada por-entorno** (así se QA-ea un upgrade de AV). **No se trackea el source** (es upstream `Infisical/agent-vault`, pristino — verificado: 0 commits locales; black-box como opencode). Lo que se trackea es el **pin** (un tag de release real, no el commit de paso `cee96bd` de hoy) + una **receta debuild** reproducible en el paquete. Si alguna vez hay que modificarlo → patch\>fork.
- **Wiring (reusa el mecanismo del plan):**  la **misma llave por-entorno** que pinea `cp.sh`→`~/archima/<env>/vm/` también pinea `agent-vault`→el daemon del env (su forced-command setea `AGENT_VAULT_ADDR`). `assign` deja de hardcodear `:14321`. El broker per-env pushea al daemon del env por esa llave.
- **Migración sin re-auth de prod:**  el store actual pasa a ser el de **prod** (`~/.agent-vault/prod/`) → la familia no re-conecta. staging/dev arrancan con stores **frescos**; se purgan los vaults basura.


---

## Resumen y grafo de dependencias

```
F6.0 (cleanup de cruft en la box — no disruptivo)
  └── F6.1 (paquete monorepo = git authority; sin tocar la box)
        └── F6.2 (cutover prod: rename → ~/archima/prod + deploy-from-branch)   ← op de prod
              ├── F6.3 (encender staging-runtime)   ── depende de F6.2
              │     └── F6.5 (QA e2e de un cambio de runtime)
              └── F6.4 (encender dev-runtime, label propio)
```

**Camino crítico:**  F6.1 → F6.2 → F6.3 → F6.5. F6.0 es independiente y conviene primero (borra \~315 M de cruft sin tocar runtime vivo). F6.4 es paralelizable tras F6.2.


---

## Fase 6.0 — Deep cleanup + set canónico (en la box, no disruptivo)

**Objetivo:**  dejar un árbol limpio del que versionar, sin tocar el runtime vivo.

**Pasos:**

- [x] Borrar cruft: `bao/`, `av-run/`, `av-test/`, `testwiki/`, `.venv/`, `vllm-*.log`, `measure_turn.sh`. Ninguno es referenciado por el runtime vivo (verificado read-only).
- [x] Archivar `bench/` a la wiki/labs como referencia y sacarlo de la box.
- [x] Fijar el **set canónico** de runtime: `vm/*` (sin `.bak-*`) + `configs/*` (sin `.bak-*`), decidiendo cuál `cp.sh`/`opencode-delegv2.json` es el vivo (los `.bak` documentan la evolución; se descartan al pasar a git). → ver §"Set canónico" abajo.
- [x] Confirmar que `agent-vault/` (binario) y `vms/` (imágenes) quedan **fuera** del set a versionar (assets box-level).

**Criterio de hecho:**

- [x] Cruft borrado; `du -sh ~/experiment-malocal` baja a \<1 G. → **676M**.
- [x] Un turno real sigue verde (el cleanup no tocó runtime). → servicios + 8 VMs intactos; turno e2e lo valida el owner por el canal.
- [x] Documentado qué archivo es el canónico de cada artefacto. → §"Set canónico".

**Riesgo:**  borrar algo que resultó ser dependencia silenciosa. Mitigación: el grep read-only ya mostró que el runtime vivo solo toca `vm/` + `configs/` + `agent-vault/`; borrar el resto es seguro. Hacer `tar` de respaldo de la box antes de borrar.


---

## Fase 6.1 — Paquete `packages/archima-runtime` (git authority, sin tocar la box)

**Objetivo:**  que un checkout del monorepo reproduzca **fielmente** el runtime de prod de hoy. Trabajo puro de repo — **no toca archetype1** (seguro).

**Pasos:**

- [x] Crear `packages/archima-runtime/` con el set canónico de F6.0, **de-secreteado** (placeholders ya existentes; nada de keys/tokens en git). → ver §Log F6.1.
- [x] **Reconciliar fuente única:**  los prompts del agente se **generan** (`print-prompt`) y `wiki-sync.mjs` se vendoriza desde `packages/agent/` en build/deploy, no se copian a mano. → `src/build.ts` (genera prompts + vendoriza, con red anti-secreto).
- [x] CI del paquete: `shellcheck` de los `.sh`, validación de JSON de los `configs/`, y un test de "el deploy produce los mismos artefactos que la box" (diff contra un snapshot de-secreteado). → `src/{runtime-assets,build,shell}.test.ts` + `src/diff-box.ts` (operador).
- [x] Documentar en el paquete: qué es asset box-level (agent-vault, golden) y cómo se instala/buildea (no se versiona, pero se referencia la versión instalada). → `manifest.json` + `README.md`.

**Criterio de hecho:**

- [x] `pnpm lint && pnpm typecheck && pnpm test` verde (tier dev del CI escalonado). → local: lint 0, typecheck -r OK, suite completa 1924 tests verde. PR #442 a `dev`.
- [x] Diff `paquete (de-secreteado) ↔ ~/experiment-malocal` solo en secretos/`.bak`/assets. → `diff-box` contra archetype1 vivo: **estático byte-idéntico**; único drift `wiki-sync.mjs` (box stale).
- [x] Cero cambios en la box todavía. → solo lecturas read-only.

**Riesgo:**  capturar un estado que no matchea lo que prod "debería" correr (drift a mano). Mitigación: el diff contra la box es parte del criterio; se reconcilia hasta que sea exacto.


---

## Fase 6.2 — Cutover de prod: rename + deploy-from-branch (op de prod coordinada)

**Objetivo:**  prod pasa a correr desde `~/archima/prod`, alimentado por `main` vía script de deploy, en una sola ventana (para re-apuntar los paths una vez).

**Blast radius del rename** (los 4 lugares que apuntan al path viejo, ya mapeados read-only):


1. `~/.ssh/authorized_keys` (nodo `ceibo-prod`): `command=".../experiment-malocal/vm/cp-forced.sh"`.
2. `cp-forced.sh`: hardcodea `CP=.../vm/cp.sh` y `AV=.../agent-vault/agent-vault`.
3. `~/.config/systemd/user/agent-vault.service`.
4. Defaults internos: `AVBIN` en `cp.sh`, `ARCHIMA_RUNTIME` en `spawn-vm.sh`. (Las units **del sistema** están limpias — `grep` por el path → vacío.)

**Partida en dos mitades** (2026-06-17): la **repo-side** (código, mergeable, cero box) se hizo en PR #444 (squash `e74a4c1` → `dev`); la **box-side** (mutación de prod) queda para la ventana de deploy con go-ahead explícito.

**Pasos repo-side (PR #444, en** `**dev**` **):**

- [x] **Restore de**  `**__ANTHROPIC_VAULT_REF__**`  **al servir** (item diferido de F6.1): `cp.sh` lo sed-ea desde `~/.archima/anthropic.ref` (espejo de `__VLLM_KEY__`; override `ARCHIMA_ANTHROPIC_REF_FILE`). El ref es el handle `vault-…` que el MITM de agent-vault resuelve a la `sk-ant` real.
- [x] **Re-apuntar los refs versionados (2 de 4)**  vía **self-location** → el mismo archivo sirve prod y staging: `spawn-vm.sh` (`RUNTIME=$HERE/..`), `cp-forced.sh` (`CP` relativo), y `AVBIN`/`AV` → `agent-vault` **compartido** `~/archima/agent-vault` (override `ARCHIMA_AVBIN`).
- [x] **Script de deploy** `scripts/deploy-archima.sh` + `pnpm deploy:archima:{staging,prod}`: build (rsync subtree + prompts generados + wiki-sync vendoreado) → `~/archima/<env>`, dry-run default, sin restart. **Desvío del plan:**  se hizo **standalone** (no wired en `promote-prod.sh`): el wiring al promote belongs al cutover (solo tiene sentido con `~/archima/prod` ya existente).
- [x] Tests (`runtime-wiring`) + docs (README/manifest). Verificado: lint/typecheck/1928 tests + shellcheck `-S error`.

**Pasos box-side (cutover, EJECUTADO 2026-06-17 — ver Log abajo):**

- [x] Crear `~/archima/agent-vault/`; **copiar** el binario ahí (compartido; copy, no move → el daemon vivo no se tocó). Verificado v0.23.0.
- [x] Poblar `~/.archima/anthropic.ref` (26 b, `vault-…`, `0600`) desde el config viejo, sin imprimir.
- [x] `deploy:archima:prod --apply` → `~/archima/prod` (SHA `be93828`) + base image `vms/` copiada.
- [x] Re-apuntar los 2 refs box-side: `authorized_keys` → `~/archima/prod/vm/cp-forced.sh` (backup); `agent-vault.service` ExecStart → `~/archima/agent-vault/...` + `daemon-reload` (backup). **Restartdel daemon DIFERIDO** (binario byte-idéntico → no hace falta; el proceso vivo sigue intacto, sin blip; toma el path nuevo en el próximo restart natural / ventana idle).
- [x] Smoke controlado: `spawn`→`serve`→`health` de una VM descartable vía el runtime nuevo → opencode booteó **healthy** con el config servido (ambos secretos restaurados, no placeholders); VM destruida. El verbo prohibido del forced-command se rechaza. **Pendiente:**  confirmación con un turno de **usuario real wrapped** (con `assign`+MITM) — esperado OK (el config servido es byte-idéntico al pre-cutover).

**Criterio de hecho:**

- [x] Prod corre desde `~/archima/prod` (= `main`); smoke de serve verde.  *(turno de usuario realpendiente de observar — los nuevos spawn/serve ya usan el runtime nuevo; las VMs vivas migran alciclar)*
- [ ] `grep -r experiment-malocal ~` → vacío.  *(post-cleanup:*  `*experiment-malocal*` *se mantiene comored de rollback + el daemon AV todavía corre desde ahí hasta su próximo restart)*
- [x] El SHA de prod cubre client **y** runtime (deploy-archima por entorno desde la branch). El leg en `promote-prod.sh` se wirea aparte (desvío arriba — pendiente, no bloquea).

**Riesgo:**  ventana de cutover con prod vivo. Mitigación: hacerlo en rato idle, con el `tar` de respaldo de F6.0 y un rollback de 1 paso (re-apuntar authorized\_keys al path viejo).


---

## Fase 6.3 — Encender staging-runtime

**Objetivo:**  staging corre su propio runtime, alimentado por la branch `staging`, contra el **mismo vLLM**. Permanente (decisión 2).

**Pasos:**

- [x] `~/archima/staging/` alimentado por la branch `staging` (script `deploy:archima:staging`).
- [x] **Forced-command por entorno = llave por entorno.**  Una pubkey dedicada `ceibo-staging` en `authorized_keys`, pineada por su `cp-forced.sh` a `~/archima/staging/vm/`. El gateway de staging usa su `ARCHIMA_SSH_KEY`. Mantiene el blast radius scopeado por env.
- [x] `.env.staging`: `ARCHIMA_SSH_KEY` → key de staging. `ENV_ID=ceibo-staging` ya hace que las VMs salgan `-ceibo-staging` (sin colisión).
- [x] **AV compartido:**  los vaults son per-usuario (`ceibo-<user>`), no per-env → el AV daemon compartido sirve a los users seed de staging sin pisar los de prod. Naming verificado.

**Criterio de hecho:**

- [x] Un turno de staging maneja VMs `-ceibo-staging` servidas por `~/archima/staging` (no por el runtime de prod).  *(serve path probado vía smoke descartable; turno de usuario real por elbot pendiente de observar — la selección es estructural, el gateway de staging ya NO puedealcanzar el cp.sh de prod)*
- [x] Prod intacto (VMs de prod `…-env_013…` siguen corriendo; nodo/dir/.env de prod sin tocar).
- [ ] Un cambio de runtime mergeado a `staging` se ve solo en staging.  *(F6.5 — el pipeline yaquedó armado por esta fase)*

**Riesgo:**  contención del vLLM (turnos de QA meten latencia a prod) — asumido (spec §5). Mitigar QA-eando en ratos idle.

## Log de ejecución F6.3 (2026-06-17, archetype1) — EJECUTADO

Go-ahead explícito del owner ("vamos con archima staging"). **Insight clave:**  la selección prod-vs-staging es 100% por **qué key** matchea en `authorized_keys` → qué `cp-forced.sh` (autolocalizado) → qué `cp.sh`. AV daemon, `~/.archima/anthropic.ref`, `~/.archima/vllm.key` y la base image del pool son **compartidos box-level** (igual que el vLLM) → staging NO necesita daemon AV propio (eso es el end-state §Vault, no F6.3). Lo único staging-specific: su dir `~/archima/staging`

- su key `ceibo-staging` \+ el namespacing de VMs por `ENV_ID` (client-side).

**Pre-flight (read-only):**  staging hoy reusaba la key de prod (`ARCHIMA_SSH_KEY=…/archetype_cp`, nodo `ceibo-prod`) → corría el runtime de prod. `~/archima/staging` ausente; solo el nodo `ceibo-prod` en `authorized_keys`; `anthropic.ref`/`vllm.key`/`agent-vault` presentes (compartidos).

**A — deploy**  `**\~/archima/staging**`  **(cero impacto a prod):**


1. Worktree detached en `origin/staging` (30ac5ad, ya con F6.1+F6.2 repo-side) + `pnpm install`.
2. `deploy:archima:staging --apply` → `~/archima/staging` (16 archivos, SHA `30ac5ad`).
3. `vms/noble-base.img` → **symlink** a la de prod (es solo guard de presencia; el `BASE` real del pool `/var/lib/libvirt/images/archima-noble-base.img` ya existe y es compartido — NO se copian 627M).
4. Verificado: scripts `+x`, `AVBIN`/`AV` → `~/archima/agent-vault` (compartido), restore de `__ANTHROPIC_VAULT_REF__` presente, `cp-forced` autolocaliza a `~/archima/staging/vm/`, cero refs a `experiment-malocal`.

**B — key** `**ceibo-staging**` **:** 5\. Keypair `ed25519` generado **en el gateway box** (`deploy@<edge-host>:/home/deploy/.ssh/archetype_cp_staging`, `0600`) → la privada nunca pasó por mi contexto; solo manejé la pública. 6. `authorized_keys` de archetype1 (backup `.bak-f63-*`): append del nodo `restrict,command="~/archima/staging/vm/cp-forced.sh" … ceibo-staging` (aditivo, nodo `ceibo-prod` intacto). 7. Verificado: `ssh -i archetype_cp_staging … "cp.sh list"` despacha al cp.sh de staging; verbos prohibidos (`rm`) y comandos arbitrarios (`whoami`) rechazados por el forced-command.

**C — flip del gateway (deploy de staging, autorizado):** 8. `.env.staging` (backup `.bak-f63-*`): `ARCHIMA_SSH_KEY` → `…/archetype_cp_staging` (`SSH_TARGET`/`CP`/`AV` ya estaban OK). 9. `sudo systemctl restart ceibo-gateway@staging ceibo-oauth@staging` → ambos `active`, gateway levantó limpio (`<staging-bot>`, env=staging, sin errores).

**D — smoke (descartable, espejo del cutover):**  `spawn`→`assign btest-vault`→`serve`→`health` de `f63-staging-smoke` vía el runtime de staging → `assign` por el AV compartido `:14321` (token rol proxy inyectado) + **opencode healthy en**  `**:14420**` con el config y ambos secretos restaurados (no placeholders); VM destruida. Pool de vuelta a las 8 VMs (prod intacto).

**Naming AV (step 4):**  el vault seed de staging `ceibo-<test-user>` es per-usuario y distinto de los de prod (`vault-<owner>`, …) → el daemon compartido lo sirve sin colisión.

**Rollback (1 paso):**  en `.env.staging` volver `ARCHIMA_SSH_KEY` → `…/archetype_cp` (key de prod)

- restart de los servicios; opcional borrar el nodo `ceibo-staging` de `authorized_keys` y `~/archima/staging`. Backups `.bak-f63-*` en ambas boxes.

**Turno de usuario real CONFIRMADO (2026-06-17 14:12):**  el owner (su cuenta real, user `owner`, Telegram `<telegram-id>`) pasado a `backend_mode: local` → turno por `<staging-bot>` → sesión `ceibo-owner-ceibo-staging` (#f0c1e7ad), VM `archima-ceibo-owner-ceibo-staging` running servida por `~/archima/staging`, reply OK por Telegram. **Cierra el criterio 1 a full fidelity.**

**Cuenta real del owner en staging (2026-06-17):**  el owner quiso usar su cuenta real (= `<owner>`/ `owner@example.com` en prod, mismo Telegram `<telegram-id>`) para "sentir" staging. Setup sobre el user `owner` de staging (id 1):

- **Identidad:**  `owner` = display "Ale", con `telegram:<telegram-id>` + `google:owner@example.com` + `email:owner@example.com`. Web: login con Google `owner@example.com` en `staging.example.com` → cae en `owner`/archima (antes caía en `<test-user>`). `<test-user>` queda como fallback.
- **Vault** `**ceibo-owner**` (creds aparte): distinto de `vault-<owner>`/`vault-<owner>` de prod → con el AV compartido, lo que aísla es el nombre del vault (sale del handle). Sin Gmail/Drive real.
- **Wikis EN VIVO (decisión informada del owner, override del "creds aparte" para wikis):**  las 5 wikis reales de `<owner>` (`<wiki-trabajo>`, `<wiki-personal>`, `<wiki-familia>`, `<wiki-viajes>`, `<wiki-casa>`) conectadas a `owner` vía `repo import` + `repo grant` + `repo label` (mismos repos `<wikis-org>/*` que prod, read+WRITE). ⚠️ **Riesgo aceptado:**  el archima de staging puede escribir/ romper esas notas reales; sólo materializa al QA-ear un cambio de runtime destructivo. Para blindar: pasar a copias-snapshot (`owner-*`). Verificado: clonadas en la VM post-restart, el owner las ve.

**Gotcha operativo (flip de** `**backend_mode**` **):**  `resolveUser` lee la DB fresh por turno, PERO el gateway cachea el **relay por-usuario en memoria** (`ensureRelay`). Flipear `ma↔local` de un user con un turno ya servido **requiere reiniciar el gateway** del entorno para limpiar el relay viejo (si no, sigue pegándole al backend anterior). Ver memory \[\[reference\_backend\_mode\_flip\_needs\_gateway\_restart\]\].

**Siguiente:**  F6.4 (dev-runtime) / F6.5 (QA e2e de un cambio de runtime).


---

## Fase 6.4 — Encender dev-runtime (label propio)

**Objetivo:**  el gateway de dev (en la mac) maneja VMs de runtime-dev en archi, sin libvirt local.

**Pasos:**

- [x] **Target** `**dev**` **en** `**deploy-archima.sh**` (`dev → branch dev → ~/archima/dev`) + `pnpm deploy:archima:dev` — PR #449 a `dev` (squash, CI verde, 1928 tests). Pre-req de repo que prod/staging no necesitaban (el script solo tenía prod/staging).
- [x] `~/archima/dev/` alimentado por la branch `dev` (`deploy:archima:dev --apply`, SHA `2eb0ac0`)
  - vms/ symlink a la base compartida.
- [x] Llave `ceibo-dev` con su `cp-forced.sh` → `~/archima/dev/vm/`. `ENV_ID=ceibo-dev` → VMs `-ceibo-dev`. Key dedicada `~/.ssh/archima_cp_dev` en la mac; nodo forced-command agregado.
- [x] Alias `archi-cp` (mac `~/.ssh/config`) → `archima_cp_dev`. **Pendiente (owner):**  `.env` `ARCHIMA_SSH_KEY=~/.ssh/archima_cp_dev` (`.env` protegido por scope-guard).
- [ ] Doc en `dev.md` \+ memoria: dev SSHea a archi (no corre VMs en la mac).

**Criterio de hecho:**

- [x] La key `ceibo-dev` despacha a `~/archima/dev/vm/cp.sh` (verificado; verbos prohibidos rechazados).  *(turno real de dev desde la mac pendiente: el owner cambia la línea de*  `*.env*` *ycorre* `*pnpm dev*` *.)*
- [x] Los tres entornos coexisten en archi: `~/archima/{prod,staging,dev}` \+ 3 nodos forced-command (`ceibo-prod`/`ceibo-staging`/`ceibo-dev`), mismo vLLM/AV/anthropic.ref/base-image compartidos.

**Riesgo:**  dev también consume el vLLM compartido (más contención). Aceptado (uso bajo).

## Log de ejecución F6.4 (2026-06-17) — EJECUTADO (falta 1 línea de `.env` del owner)

**Hallazgo de pre-flight:**  el dev de la mac usaba `archi-cp` → key `~/.ssh/archima_cp`, cuya fingerprint  **= el nodo** `**ceibo-prod**` → **dev corría sobre el runtime de PROD** (el gap que F6.4 cierra). archetype1 tenía solo 2 nodos forced (prod/staging) + 2 full-shell (`server`/`Termius`).

**A — repo:**  PR #449 agrega el target `dev` a `deploy-archima.sh` + `pnpm deploy:archima:dev` (feature→dev, squash `2eb0ac0`). **B — deploy:**  `deploy:archima:dev --apply` → `~/archima/dev` (SHA `2eb0ac0`) + vms/ symlink; árbol verificado (autolocaliza, restore anthropic, cero refs a `experiment-malocal`). **C — key:**  keypair `archima_cp_dev` en la mac (privada local), nodo `ceibo-dev` forced-command → `~/archima/dev/vm/cp-forced.sh` (backup `.bak-f64-*`). **D — mac:** alias `archi-cp` → `archima_cp_dev` (hecho); falta la línea de `.env` (owner). **E — smoke:**  la key dev despacha a `~/archima/dev/vm/cp.sh` (`list` OK; `rm`/comando arbitrario rechazados).

**Rollback:**  alias `archi-cp` → `archima_cp` (+ `.env` idem) restaura el estado previo (dev sobre prod). Borrar el nodo `ceibo-dev` de `authorized_keys` + `~/archima/dev` si se quiere limpiar.


---

## Fase 6.5 — QA e2e de un cambio de runtime

**Objetivo:**  demostrar el flujo completo con un cambio real de runtime (ej. tunear `cp.sh` o el `opencode-delegv2.json`).

**Pasos:**

- [ ] Un cambio de runtime recorre `feature → dev → staging → main`, ejercitado en cada etapa con sus VMs propias en archi.
- [ ] (Futuro) convertir el QA manual en e2e (harness + turno real contra el endpoint local), alineado con el runsheet de staging.

**Criterio de hecho:**

- [ ] Un cambio de `cp.sh`/config recorre las tres etapas **sin que prod lo vea hasta elmerge a** `**main**` \+ deploy del leg de archi.


---

## Riesgos transversales

- **Golden compartida = el límite del aislamiento.**  Cambios de **script/config** se aíslan limpio por entorno (cada env su `cp.sh`/config). Un cambio a nivel **golden** (ej. bumpear opencode horneado) **no** se aísla sin una golden por-entorno (`archima-golden-<env>.qcow2`) durante el QA — si no, rebuildear la golden de staging pisa la de prod. **Sub-decisión pendiente:**  golden por-env solo cuando un cambio lo toque, o siempre. Por ahora: golden compartida; los cambios de golden son op box-wide coordinada.
- **Contención del vLLM** (los tres comparten GPU) — asumido (spec §5).
- **Box SPOF hogareña** — versionar **no** arregla disponibilidad; sigue siendo una caja con Starlink/UPS. Fuera de alcance acá.
- **CI de bash no atrapa runtime libvirt** — `shellcheck` valida sintaxis, no que la VM bootee; el QA real arranca en staging.
- **Drift de reconciliación** (F6.1) — capturar fiel el estado vivo; mitigado por el diff contra la box como criterio.

## Fuera de alcance

- Versionar el **modelo vLLM** por entorno (compartido por diseño — spec §5).
- **Canary por usuario** (spec §7, diferido).
- 2ª caja / HA / arreglar el SPOF.
- Reescribir/forkear **opencode** o **agent-vault** (black-box; deps vendorizadas/instaladas).
- Automatizar el **build de la golden en CI** (queda como mejora futura; hoy se buildea a mano en la box con la receta versionada).


---

## Set canónico (fijado en F6.0, 2026-06-16)

Determinado siguiendo el forced-command real (`~/.ssh/authorized_keys` → `vm/cp-forced.sh` → `CP=.../vm/cp.sh`) y el default del `cp.sh` vivo (línea 142: `CFG="${3:-opencode-delegv2.json}"`).

| Artefacto                                   | Canónico                                                                                   | No-canónico (se descarta al pasar a git, F6.1)                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| control-plane                               | `vm/cp.sh` (17716 B, Jun 15) — el que invoca el forced-command                             | `vm/cp-b.sh` (variante NO cableada, default `opencode-testwiki.json`) · todos los `vm/cp*.bak-*` |
| forced-command                              | `vm/cp-forced.sh`                                                                          | —                                                                                                |
| opencode config                             | `configs/opencode-delegv2.json` (mode 0600 → **tiene secretos**, de-secretear en F6.1)     | `configs/opencode-av-test.json` · `configs/opencode-testwiki.json`                               |
| resto de `vm/`                              | `build-golden.sh`, `spawn-vm.sh`, `user-data.tpl.yaml`, `vm-firewall.sh`, `warm-golden.sh` | —                                                                                                |
| resto de `configs/`                         | `AGENTS.md`, `prompts/`, `wiki-sync.mjs`                                                   | —                                                                                                |
| assets box-level (fuera del set versionado) | `agent-vault/` (binario + checkout upstream) · `vms/` (`noble-base.img` \+ golden)         | —                                                                                                |

## Log de ejecución F6.0 (2026-06-16)

- [x] **Backup** antes de borrar: `~/experiment-malocal-backup-f6.0-20260616.tar.gz` (144M, en el home de la box; excluye `vms/` y `agent-vault/` por pesados/rebuildables). Rollback de 1 paso.
- [x] `**bench/**`  **archivado** a la wiki: `tecnico/experimentos/archima/bench/` (6 scripts + `measure_turn.sh`) y removido de la box.
- [x] **Cruft borrado**: `bao/` (249M, OpenBao descartado), `.venv/` (29M, uv-venv de bench, sin refs systemd), `av-run/`, `av-test/`, `testwiki/`, `vllm-7b.log`, `vllm-coder.log`, `measure_turn.sh`. Reconfirmado read-only: ninguno referenciado por el runtime vivo (`vm/` + `configs/` \+ units + `authorized_keys`).
- [x] **du**: 953M → **676M** (\<1G). Quedan solo `agent-vault/ configs/ vm/ vms/`.
- [x] **Runtime intacto**: `vllm` active, `agent-vault.service` active, **8 VMs siguen corriendo** (incl. `-ceibo-staging` y `-ceibo-dev` — costura de aislamiento confirmada en vivo), `cp.sh` y `cp-forced.sh` parsean OK. (El "turno real verde" end-to-end lo valida el owner por el canal.)

**Pendiente para F6.1** (trabajo de repo, no toca la box): crear `packages/archima-runtime/` con el set canónico de arriba, de-secreteado.

## Log de ejecución F6.1 (2026-06-16)

Paquete  `**@ceibo/archima-runtime**` creado en worktree desde `origin/dev` → **PR #442 a** `**dev**` (repo-only, no toca la box). Estructura:

- [x] `**runtime/**`  estático de-secreteado, byte-faithful a la box: `vm/` (cp.sh, cp-forced.sh, spawn-vm.sh, build-golden.sh, warm-golden.sh, vm-firewall.sh, user-data.tpl.yaml) + `configs/` (opencode-delegv2.json, AGENTS.md stub). `+x` de los scripts preservado en git (100755).
- [x] **De-secreteado:**  un solo valor stripeado — el ref agent-vault de anthropic (era el único `0600`) → `__ANTHROPIC_VAULT_REF__`, reemplazo byte-exacto (−3 bytes, sin reformatear). El `__VLLM_KEY__` ya era placeholder (cp.sh lo sed-ea al servir desde `~/.archima/vllm.key`). **~~Pendiente F6.2:~~**  **Hecho (PR #444):**  wiring del restore del ref anthropic al servir (`cp.sh` lo sed-ea desde `~/.archima/anthropic.ref`).
- [x] **Fuente única** (`src/build.ts`): prompts generados con `print-prompt` (gateway) + `wiki-sync.mjs` vendoreado de `@ceibo/agent`, con red anti-secreto sobre el árbol de salida.
- [x] **CI/tests** (`src/*.test.ts`, 13 tests): JSON válido + sin secretos + `+x` + `shellcheck -S error` (pasa limpio en los 6 scripts) + reconciliación del build. `src/diff-box.ts` = verificador de fidelidad contra la box (operador, requiere SSH).
- [x] `**manifest.json**`: pins box-level — agent-vault **v0.23.0** (upstream Infisical, black-box, el checkout de la box `cee96bd` era estado transitorio), receta de golden, dep vLLM.
- [x] **Descartados** (no-canónicos): `cp-b.sh`, todos los `*.bak-*`, `opencode-av-test.json`, `opencode-testwiki.json`, `configs/prompts/AGENTS.md` (27K, no lo usa cp.sh).
- [x] `**biome.json**`: `runtime/**` excluido del linter (vendoreado byte-faithful; reformatear lo desincronizaría de la box).

**Verificación:**  `pnpm lint` 0 · `pnpm -r typecheck` OK · suite completa **1924 tests** verde. `diff-box` contra **archetype1 vivo**: el set estático es **byte-idéntico** (incl. los prompts generados, que matchean la box desde la base `dev`); único drift `configs/wiki-sync.mjs` (box stale, se reconcilia al deploy); BOX-ONLY = los no-canónicos descartados. Criterio F6.1 cumplido.

## Log de ejecución F6.2 repo-side (2026-06-17) — PR #444, en `dev`

La **mitad repo-side** de F6.2 (código, mergeable, cero box): squash `e74a4c1` → `dev`.

- [x] **Restore de**  `**__ANTHROPIC_VAULT_REF__**`  al servir en `cp.sh` (sed desde `~/.archima/anthropic.ref`, espejo de `__VLLM_KEY__`). El ref es el handle `vault-…` (26b) que el MITM de agent-vault resuelve a la `sk-ant-…` real (108b, en `~/.archima/anthropic.key`); la VM nunca ve la key. Verificado con scan masked en la box (no se imprimió ningún secreto).
- [x] **Self-location de paths** → el mismo archivo versionado sirve prod y staging: `spawn-vm.sh` (`RUNTIME=$HERE/..`), `cp-forced.sh` (`CP` relativo + `AV` compartido), `cp.sh` (`AVBIN` → `~/archima/agent-vault`). Cero refs a `experiment-malocal` (test lo blinda).
- [x] `**scripts/deploy-archima.sh**` + `pnpm deploy:archima:{staging,prod}` (build + rsync por entorno, dry-run default, sin restart). Standalone (no wired en `promote-prod.sh` — eso va al cutover). README/manifest actualizados.

- **Verificación:**  lint 0 · `-r typecheck` OK · **1928 tests** verde (husky) · `shellcheck -S error` en los 4 scripts. `diff-box` **no** se corre como gate ahora: el paquete diverge a propósito de la box vieja (paths `~/archima`) y vuelve a byte-idéntico **post-cutover**.

## Log de ejecución F6.2 cutover box-side (2026-06-17, archetype1) — EJECUTADO

Go-ahead explícito del owner. Estrategia: **cutover no-destructivo en dos tiempos** — staging paralelo (`~/archima/` nuevo, sin tocar `experiment-malocal` ni el daemon vivo → **cero impacto** en las 8 VMs corriendo, incl. usuarios reales) + flip de punteros. Insight: el binario de agent-vault es **byte-idéntico** → no se reinicia el daemon (sin blip de 3s).

**Pre-flight (read-only):**  backup tar de F6.0 presente; `~/archima` ausente; `anthropic.key` presente; 8 VMs running (ajs, <owner>, theethernaut42, gas, azul, <test-user>-staging, ceibo-dev, archi-sub-agente).

**Staging (cero impacto):**


1. `~/.archima/anthropic.ref` poblado (26 b, `vault-…`, `0600`) desde el config viejo (masked).
2. `~/archima/agent-vault/agent-vault` = **copia** del binario (v0.23.0; el daemon vivo intacto).
3. `deploy:archima:prod --apply` → `~/archima/prod` (16 archivos, SHA `be93828`).
4. Base image `noble-base.img` (627 M) copiada a `~/archima/prod/vms/`.
5. Verificado: scripts `+x`, `AVBIN` → `~/archima/agent-vault`, restore del ref OK (dry), cero refs a `experiment-malocal` en el árbol nuevo.

**Flip:** 6. `authorized_keys` forced-command → `~/archima/prod/vm/cp-forced.sh` (backup `.bak-cutover-*`). 7. `agent-vault.service` ExecStart → `~/archima/agent-vault/...` + `daemon-reload`, **sin restart** (backup `.bak-cutover-*`). Daemon `active` sin interrupción.

**Smoke:**  `cp.sh list` vía el forced-command nuevo OK; verbo prohibido (`rm`) rechazado; `spawn`→`serve`→`health` de `cutover-smoke` → **opencode healthy** con el config servido (anthropic `vault-…` \+ vLLM key **restaurados**, no placeholders); VM destruida limpia.

**Confirmado post-cutover (2026-06-17 \~11:45–11:48):**

- [x] **Turno de usuario real** (Ale, web, `<owner>`): gateway → forced-command nuevo → cp.sh nueva (assign+serve) → opencode → **reply OK** (`model:gemma4-31b in:16465 out:39 → $0.0000`, 148 chars). Cierra el smoke end-to-end. (No ejercitó el path anthropic-vía-MITM: el turno usó el modelo local, que es el default; el config servido del anthropic es byte-idéntico al pre-cutover igual.)
- [x] **Restart del daemon AV** (idle, sin turno en vuelo): ahora corre de `~/archima/agent-vault` (`exe` verificado), `active`, puertos 14321+14322 escuchando, unseal OK. **Ya nada usa**\*\*`experiment-malocal`\*\* **.**  Si el restart rotó tokens de VMs vivas → self-healing (próximo turno reintenta assign+serve, por diseño).

**Cleanup hecho (2026-06-17):**  `~/experiment-malocal` movido a  `**\~/backups/experiment-malocal**` (+ el tar de F6.0 consolidado en `~/backups/`), por pedido del owner (preservar, no dejar en `~`). Cero refs vivas al path viejo (authorized\_keys/service/`~/archima` limpios); el string solo queda en `~/backups/*` y en los `.bak-cutover-*` (preservados a propósito).

**Rollback (ahora 2 pasos, porque el dir se movió):**


1. `mv ~/backups/experiment-malocal ~/experiment-malocal`
2. restaurar `~/.ssh/authorized_keys.bak-cutover-*` + `~/.config/systemd/user/agent-vault.service.bak-cutover-*`, `daemon-reload` \+ restart de agent-vault.

- **Polish repo-side** (batch en un PR próximo, no urge): `deploy-archima.sh` debe tolerar el `--` que mete pnpm (`pnpm deploy:archima:prod -- --apply` hoy se rompe; el `.sh` directo anda); wiring del leg de archi en `promote-prod.sh`/`deploy-staging.sh` (necesita build independiente del working-tree — decisión de diseño, no rush).

**Siguiente fase:**  F6.3 (encender staging-runtime) sobre esta base verde.
