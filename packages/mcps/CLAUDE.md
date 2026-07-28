# @ceibo/mcps

Familia de MCP servers self-hosted stateless (gmail, calendar, sheets, …) con core compartido (transporte MCP + Google REST) y un launcher único. Proceso público detrás del ingress.

- **Depende de (interno):** speech, store
- **Consumido por:** gateway, web-server

## Scope

Estás trabajando en `@ceibo/mcps`. Editá **solo** dentro de `packages/mcps/`. Si el
cambio necesita tocar otros paquetes, pará: declará el scope cruzado en
`.claude/active-scope` (ej. `mcps <otro>`) o vacialo si el cambio cruza a propósito —
no edites otros paquetes "de paso". El guard de scope lo enforcea. Ver el `CLAUDE.md` raíz.
