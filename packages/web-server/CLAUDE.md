# @ceibo/web-server

Servicio web standalone: SPA + SSE + magic-link + plano repos (wikis in-process). Se conecta al gateway por el canal remoto; el plano repos NO depende del agente (D3). Proceso propio detrás del ingress.

- **Depende de (interno):** agent, channels, mcps, speech, store, wikis
- **Consumido por:** nadie (deploy target)

## Scope

Estás trabajando en `@ceibo/web-server`. Editá **solo** dentro de `packages/web-server/`. Si el
cambio necesita tocar otros paquetes, pará: declará el scope cruzado en
`.claude/active-scope` (ej. `web-server <otro>`) o vacialo si el cambio cruza a propósito —
no edites otros paquetes "de paso". El guard de scope lo enforcea. Ver el `CLAUDE.md` raíz.
