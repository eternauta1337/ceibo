# ceibo — instrucciones para agentes de código

Este repo se escribió con agentes de código. Este archivo es su documentación operativa;
cada paquete tiene además su propio `packages/<x>/CLAUDE.md` con contrato y frontera.

Contexto del proyecto y arquitectura: `README.md` y `docs/ARCHITECTURE.md`.

## Estructura

Monorepo pnpm. La regla que no se rompe es **sin ciclos**:

```
hojas (0 deps internas):  agent · speech · store · wikis · web · orb · archima-runtime
medios:                   channels→(agent,store)  mcps→(speech,store)
                          oauth→(agent,store)     backend-local→(agent,store)
tope (deploy targets):    gateway→(7 internos)  web-server→(6)  cli→(oauth,store,wikis)
```

`store` es **hoja profunda**: seis paquetes dependen de ella. Un cambio de contrato ahí
repercute en todos — verificá con `pnpm -r typecheck`.

## Scope de agentes

Para acotar el blast radius de un agente al paquete en foco sin fragmentar el repo hay dos
capas:

- **Piso estático** (`.claude/settings.json` → `permissions.deny`): veta *siempre*
  `secrets/`, `.env` y `pnpm-lock.yaml`. Esos no se editan a mano.
- **Scope dinámico** (`.claude/hooks/scope-guard.sh`, PreToolUse): si `.claude/active-scope`
  nombra uno o más paquetes (ej. `speech`, o `store gateway`), deniega Edit/Write fuera de
  esos `packages/<x>/`. Vacío o ausente = sin restricción (modo cross-cutting deliberado).

Regla: si trabajás en un paquete, poné su nombre en `active-scope`. Si el cambio cruza
paquetes a propósito —típico al tocar `store`— listá todos los involucrados o vacialo.
`active-scope` es estado local, gitignored.

## Verificación

```bash
pnpm install       # necesario antes de confiar en typecheck
pnpm lint          # biome
pnpm typecheck     # tsc --noEmit en los 15 paquetes
pnpm test          # ~2200 tests, vitest desde la raíz
```

El pre-push de husky corre los tres. La CLI de admin es `./ceibo <cmd>` (carga el `.env` de
la raíz y pega sobre la misma DB).

## Desarrollo local

Dev corre entero contra una DB local (`ceibo.dev.db`) y no toca nada remoto.

```bash
pnpm dev:setup     # una vez: seedea la DB con dev@ceibo.local / "dev"
pnpm dev           # gateway + web-server + web juntos ([gw]/[api]/[web])
```

Login en `http://localhost:5173`. El runner es `scripts/dev.mjs`, sin deps extra. El setup
completo del `.env`, incluido el backend local, está en `dev.md`.

## Convenciones

- **Se corre con `tsx` sobre `src`, sin build.** La única excepción es la SPA (Vite).
  `packages/web/dist` es gitignored.
- **Tests co-locados**: `foo.test.ts` al lado de `foo.ts`. Un solo `vitest run` desde la
  raíz los descubre.
- **Cobertura con ratchet manual**: los pisos son por archivo en `vitest.config.ts` y se
  suben a mano (`autoUpdate: false`). Bajar un piso es un cambio explícito y revisado.
- **Fragmentos de changelog**: cada cambio con impacto visible deja un archivo en
  `changelog.d/` (ver su `README.md`). `pnpm changelog` los renderiza.
- **Los comentarios explican el *por qué*, no el *qué*.** Buena parte de los comentarios de
  este repo son cicatrices de bugs reales; si tocás ese código, actualizá la explicación en
  vez de borrarla.
- **Español** en comentarios, docs y mensajes. Mantenelo consistente.

## Lo que no se toca a mano

`.env`, `secrets/` y `pnpm-lock.yaml`. Los dos primeros no están en el repo; el lockfile lo
maneja pnpm.
