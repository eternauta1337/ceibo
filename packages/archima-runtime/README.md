# @ceibo/archima-runtime

El **runtime versionado de archima**: el control-plane (`cp.sh`), el provisioning de las VMs
libvirt y la config de opencode que corren en la box `gpuhost`. Hasta ahora vivían a mano en
`~/experiment-malocal` (ni repo git — su "versionado" eran ~20 `.bak-<timestamp>`); este paquete
los trae al monorepo para que **un solo SHA cubra cliente (`@ceibo/backend-local`) y runtime**, y
para poder correr un runtime distinto por entorno (dev/staging/prod) sobre el mismo vLLM.

Arquitectura general del proyecto: `docs/ARCHITECTURE.md`.

> Estado: **F6.2 (repo-side)** — runtime listo para correr desde `~/archima/<env>` (paths
> autolocalizados, restore del ref Anthropic al servir, script `deploy:archima:*`). El **cutover
> de la box** (rename `~/experiment-malocal` → `~/archima/prod`, re-apuntar `authorized_keys` +
> `agent-vault.service`, poblar `~/.archima/anthropic.ref`, smoke) es una **operación de prod**
> aparte, en su ventana de deploy. F6.1 fue la autoridad git del runtime.

## Qué hay acá

```
runtime/                 ← el set canónico ESTÁTICO, de-secreteado (se versiona tal cual)
  vm/                      cp.sh · cp-forced.sh · spawn-vm.sh · build-golden.sh ·
                           warm-golden.sh · vm-firewall.sh · user-data.tpl.yaml
  configs/                 opencode-delegv2.json (de-secreteado) · AGENTS.md (stub)
src/
  build.ts               ensambla el árbol DESPLEGABLE (estático + prompts generados)
  diff-box.ts            operador: verifica que el paquete reproduce el runtime vivo de la box
  *.test.ts              JSON válido · sin secretos · +x · shellcheck · reconciliación
manifest.json            pins de los assets box-level (agent-vault, golden, vLLM)
```

## Fuente única (lo que NO se copia a mano)

Los **prompts del agente** los hand-copiaba la box y **driftearon** del repo; acá se **generan** en
el build, nunca se editan a mano:

- **Prompts del agente** (`configs/prompts/ceibo.md`, `ceibo-worker.md`): los genera
  `print-prompt` (gateway) desde `packages/gateway/prompt/{coordinator,worker}-archima.md`. Por eso
  `runtime/configs/prompts/` está vacío en git — los produce `build`.

(El acceso a wikis en archima es por **git nativo** contra el proxy `/api/git`; `wiki-sync.mjs`
es exclusivo de MA cloud y vive en `packages/agent`, no se vendoriza acá.)

```bash
pnpm --filter @ceibo/archima-runtime build [outDir]   # default: dist/runtime
```

## Secretos

El árbol versionado está **de-secreteado**: lo único sensible se reemplazó por placeholders que la
box sustituye al servir.

| Placeholder | Qué es | Cómo se restaura |
|---|---|---|
| `__VLLM_KEY__` | API key del vLLM local (3 providers) | `cp.sh` la sed-ea al servir desde `~/.archima/vllm.key` (mecanismo ya existente) |
| `__ANTHROPIC_VAULT_REF__` | referencia agent-vault del provider Anthropic (handle `vault-…`; el MITM de agent-vault lo resuelve a la API key real sin que la VM la vea) | `cp.sh` la sed-ea al servir desde `~/.archima/anthropic.ref` (espejo de `__VLLM_KEY__`, override `ARCHIMA_ANTHROPIC_REF_FILE`). El cutover de la box puebla ese file desde el config viejo. |

`build` y los tests fallan si cualquier literal-secreto (`vault-…`, `sk-…`, `ghp_…`, claves
privadas) aparece en el árbol.

## Deploy (leg de gpuhost)

El runtime de archima se deploya por entorno desde la branch del entorno (`main`→prod,
`staging`→staging), en la **misma box** `gpuhost` (mismo vLLM, dirs distintos):

```bash
pnpm deploy:archima:staging            # dry-run
pnpm deploy:archima:staging -- --apply # build + rsync → ~/archima/staging
pnpm deploy:archima:prod    -- --apply # build + rsync → ~/archima/prod
```

Ensambla el árbol (`build`), lo rsyncea a `~/archima/<env>/` (sin `--delete`: preserva `vms/` y el
`agent-vault` compartido en `~/archima/agent-vault`) y escribe `.deployed-sha`. **No reinicia
nada**: `cp.sh` se forkea por turno, así que el próximo `spawn`/`serve` ya usa el runtime nuevo.
Mismos paths autolocalizados → el mismo archivo versionado sirve prod y staging según el dir.

## Assets box-level (no en git)

El binario de **agent-vault** (~29M) y las **imágenes** de VM (golden + noble-base, ~600M) NO se
versionan: son black-box / blobs pesados. Sus **pins y recetas** están en `manifest.json`.

## Verificación

```bash
pnpm --filter @ceibo/archima-runtime typecheck
pnpm --filter @ceibo/archima-runtime test          # JSON válido · sin secretos · shellcheck · build

# Reconciliación contra la box (operador, requiere SSH read-only a gpuhost):
ARCHIMA_SSH_TARGET=gpuhost pnpm --filter @ceibo/archima-runtime diff-box
```

`diff-box` reporta DRIFT esperado (prompts, que se reconcilian al deploy) y BOX-ONLY
(`.bak`, variantes no-canónicas, assets, `wiki-sync.mjs` hasta el próximo deploy); falla si un
archivo estático canónico difiere.
