# @ceibo/orb

La orbe push-to-talk (WebGL): anillos de contorno topográficos deformados por ruido 3D
domain-warped (ondulación) + picos de frecuencia (visualizador de audio). Config **por estado**.

- **Depende de (interno):** nada (hoja)
- **Consumido por:** `@ceibo/web` (vía `createOrb` + `orbConfig`).

## Estructura

- `src/core.ts` — WebGL vanilla: shader + loop + interpolación entre estados. `createOrb`.
- `src/types.ts` — `OrbConfig` (params por estado) · `PARAM_META` · `DEFAULT_CONFIG`.
- `orb.config.json` — la config tuneada (**fuente de verdad**). La escribe el harness, la lee la app.
- `src/panel.ts` — panel del harness: botones de estado + sliders por estado + Guardar/Copiar.
- `dev/` — harness standalone (Vite).

## Formas geométricas = estado del agente

La figura del orbe **ya NO es random**: cada forma comunica QUÉ está haciendo el agente. El set
(geométrico, líneas rectas, sin pétalos/estrellas) vive en `types.ts` → `ORB_SHAPES` / `OrbShape`:
círculo (reposo/IO) · triángulo (pensando) · cuadrado (usando tool) · pentágono (sub-agente) ·
hexágono (reservado). El consumidor setea la forma con `orb.setShape(name)`; el orbe morfea con
ease-in-out + un paso de rotación. El **mapeo estado→forma** (status/activity/sub-agente) vive en
`@ceibo/web` (`agentShape.ts`, testeable). El motor "gatea" las formas por estado: sólo el estado
cuyo config trae `poly>0` (pensando) las muestra; el resto se ve redondo. El harness tiene botones
de forma para previsualizarlas.

## Iterar

```sh
pnpm --filter @ceibo/orb dev    # → http://localhost:5173
```

Los **botones** transicionan el orbe a cada estado; el panel edita los params de **ese** estado;
**Guardar** escribe `orb.config.json` (la app lo toma directo, sin baking a mano). Hot reload.
El "nivel" (slider o mic real) drivea los estados reactivos (recording/speaking). Tecla `` ` ``
oculta el panel.

## Prod liviano

Una sola pasada de shader (sin post/FBO), buffer fijo (512·dpr), loop **pausado** cuando la
pestaña/orbe no se ve. El panel **no** se monta en prod (solo en el harness).

## Scope

Editás `@ceibo/orb`. Solo dentro de `packages/orb/`. Cambios de contrato (`OrbConfig`, props)
repercuten en `web`.
