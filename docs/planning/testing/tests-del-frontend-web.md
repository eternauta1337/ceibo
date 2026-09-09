# Tests del frontend web (Ola 4)

Mueve el package `web` de **0%** . Es el único track que pide toolchain nuevo (navegador simulado), por eso va separado del resto.

## Objetivo

- Testear la lógica de cliente de `web` (hooks, no pixels) en un DOM simulado, con `fetch`/`EventSource` mockeados — sin levantar el server real.
- Es **unit/component**, hermético, corre en CI como el resto. NO es el browser real (eso es [tests con agente en vivo](tests%20con%20agente%20en%20vivo.md)).

## Qué cubrir

- `**useChannel.ts**` (677 líneas, el grueso): el hook que maneja la conversación.
  - carga inicial / paginación de historial (`fetch` de `/api/...` mockeado)
  - envío optimista + reconciliación con la respuesta del server
  - suscripción SSE (`EventSource` fake): llega `ready`, llegan mensajes empujados, reconexión al cortarse el stream
  - estados de error (401 → re-login, 5xx → retry/backoff)
- `**listHang.ts**` (39): el helper de "colgar la lista mientras llega" — lógica pura de scheduling, fácil, va de arranque.
- Otros hooks/util que aparezcan al abrir el package.

## Toolchain (lo nuevo)

- **jsdom** o **happy-dom** como `environment` de vitest. happy-dom es más liviano/rápido; jsdom más fiel. Arrancar con happy-dom, saltar a jsdom si algo no se simula bien.
- `**@testing-library/react**` + `@testing-library/dom` para montar hooks/ componentes y consultar el DOM por rol/texto.
- **vitest per-project / workspace**: `web` necesita `environment: "happy-dom"`, el resto del monorepo sigue en `node`. Definir un proyecto vitest aparte (`vitest.workspace.ts` o `test.environmentMatchGlobs`) para no cargar el DOM en los packages de backend.
- **Mock de** `**EventSource**`: no existe en jsdom por default → fake propio que expone `.onmessage`/`.dispatchEvent` para empujar eventos desde el test.
- `**fetch**`: `vi.stubGlobal("fetch", ...)` ruteado por URL, igual que en los MCP servers.

## Decisiones / riesgos

- **No testear render visual** (CSS, layout): fuera de alcance, da falsos positivos. Testeamos comportamiento (qué pide, qué muestra ante qué dato), no apariencia.
- El per-project de vitest es el cambio de infra más delicado — verificar que `pnpm test:cov` sigue agregando coverage de TODOS los proyectos en un solo reporte (el ratchet lee ese reporte).
- Meta de coverage: `web` 0 → \~40-50% (los hooks; el árbol de componentes JSX puro queda informacional).

## Tareas

- [ ] Elegir happy-dom vs jsdom (spike con `useChannel`)
- [ ] Configurar proyecto vitest per-environment sin romper el reporte agregado
- [ ] Fake de `EventSource` reutilizable
- [ ] Tests de `useChannel` (historial, envío, SSE, errores)
- [ ] Tests de `listHang` y helpers puros
- [ ] Subir piso del ratchet para `web/src/*` en `vitest.config.ts`
- [ ] Actualizar [unit-and-ci](unit-and-ci.md) (coverage por package)
