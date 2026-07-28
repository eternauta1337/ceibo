# @ceibo/oauth

Subsistema OAuth: enrola cuentas externas (Google Web app) y escribe la credencial mcp_oauth en el vault del usuario; crece a broker de refresh. Proceso público propio.

- **Depende de (interno):** agent, store
- **Consumido por:** cli, gateway

## Scope

Estás trabajando en `@ceibo/oauth`. Editá **solo** dentro de `packages/oauth/`. Si el
cambio necesita tocar otros paquetes, pará: declará el scope cruzado en
`.claude/active-scope` (ej. `oauth <otro>`) o vacialo si el cambio cruza a propósito —
no edites otros paquetes "de paso". El guard de scope lo enforcea. Ver el `CLAUDE.md` raíz.
