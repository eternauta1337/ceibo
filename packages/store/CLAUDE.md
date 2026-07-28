# @ceibo/store

Data layer de ceibo: usuarios, canales, repos, sesiones, ledger de usage + pricing.

- **Depende de (interno):** nada (hoja)
- **Consumido por:** channels, cli, mcps, oauth, gateway, web-server (6 — hoja profunda)

> ⚠️ Hoja profunda: 6 paquetes dependen de `store`. Un cambio de contrato acá
> repercute en todos. Si tocás una firma/exported type, el cambio cruza paquetes —
> declaralo en `.claude/active-scope` y verificá `pnpm -r typecheck`.

## Scope

Estás trabajando en `@ceibo/store`. Editá **solo** dentro de `packages/store/`. Si el
cambio necesita tocar otros paquetes, pará: declará el scope cruzado en
`.claude/active-scope` (ej. `store <otro>`) o vacialo si el cambio cruza a propósito —
no edites otros paquetes "de paso". El guard de scope lo enforcea. Ver el `CLAUDE.md` raíz.
