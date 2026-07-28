# @ceibo/archima-runtime

Runtime versionado de archima (control-plane + provisioning de VMs + config de opencode) que corre
en `gpuhost`. **Hoja**: 0 deps internas en runtime; el `build` invoca `@ceibo/gateway`
(`print-prompt`) y vendoriza de `@ceibo/agent` como herramientas de DEPLOY, no como deps de código.

- **Consumido por:** el deploy a gpuhost (F6.2: `deploy:archima-*`), no por otro paquete en runtime.
- **Naturaleza:** mayormente artefactos vendoreados (`.sh`, JSON, prompts). El TS de `src/` son
  herramientas (build/diff) y tests, no lógica de producto.

## Boundary

`runtime/` es el set canónico **de-secreteado** y **byte-faithful** al runtime vivo de la box: NO
reformatear sus archivos (por eso `runtime/**` está excluido de biome). Editarlos = cambiar lo que
corre en gpuhost → va por el flujo de entornos y se valida con `diff-box`. Los prompts son
**generados** (fuente única en gateway), nunca a mano acá.

Detalle y secretos: `README.md`. Arquitectura: `docs/ARCHITECTURE.md`.

## Scope

Estás trabajando en `@ceibo/archima-runtime`. Editá **solo** dentro de `packages/archima-runtime/`.
Si el cambio toca la generación de prompts, su fuente está en `@ceibo/gateway` → declará el
scope cruzado en `.claude/active-scope`. Ver el `CLAUDE.md` raíz.
