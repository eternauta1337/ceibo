# @ceibo/rem-runner

REM = consolidación automática de wikis (notas) tipo "sueño": un batch que detecta deltas en
las wikis, **planifica** consolidaciones (fusionar, archivar, mover, dedup) y las **ejecuta**,
sin intervención del usuario. Corre en **gpuhost** (no en la box de prod) como cron-pull.

- **Depende de (interno):** gateway (solo las funciones puras de `@ceibo/gateway/logic`:
  prompts, parsing del plan, guardrails)
- **Consumido por:** nadie (deploy target — corre en gpuhost vía systemd)

## Arquitectura (cron-pull, sin VMs)

```
gpuhost (timer diario)                    web-server (ceibo.example.com)
  rem-batch.cjs                           GET /api/rem/batch  → wikis con delta + scope + pushToken
   └─ runRemBatch (batch.ts)              POST /api/rem/report → avanza watermarks + digest Telegram
       └─ runRemForWiki (runner.ts)  ──── por wiki, secuencial:
            clone efímero → planner → executor → push → rm -rf (siempre)
```

- **Planner** (default `gemma4-31b` local vía vLLM; `claude-sonnet-4-6` opt-in): lee el contenido
  de la wiki y devuelve un plan JSON estructurado (`RemStructuredPlan`: `risk`, `should_execute`,
  `requires_user_confirmation`, `actions[]`). NO edita ni pushea.
- **Executor** (default `gemma4-31b` local vía opencode-serve en gpuhost): ejecuta el plan exacto
  y hace UN commit. NO pushea (lo hace el runner).
- **Watermark** (en la DB del web-server): último SHA consolidado por wiki; avanza solo si no
  hubo error. El delta desde el watermark es lo que el planner ve como `scope`.

## Planner configurable (vllm | anthropic)

`REM_PLANNER_PROVIDER=vllm|anthropic` (**default `vllm`** = gemma local, OpenAI-compat en
`REM_VLLM_BASE`, default `http://127.0.0.1:8000/v1`, costo 0). `anthropic` (sonnet) es opt-in y
solo entonces se exige `ANTHROPIC_API_KEY`/`~/.archima/anthropic.key`. Tradeoff: con gemma REM
corre 100% local/gratis; sonnet da un plan más fuerte (planner fuerte + executor barato) a costo
y red. El default es gemma para que REM sea autónomo y barato; subí a sonnet si el plan flojea.

## Sandbox / dry-run (para iterar sobre REM)

`run:dry` corre una pasada **sin pushear nunca** — la herramienta para mejorar REM:

```bash
# Contra una carpeta local de notas (no usa red, no toca el original):
pnpm --filter @ceibo/rem-runner run:dry mywiki --local ~/wikis/personal
# + ejecutar gemma y ver el diff que dejaría (sigue sin pushear):
pnpm --filter @ceibo/rem-runner run:dry mywiki --local ~/wikis/personal --execute --keep
# Comparar contra el planner sonnet (default es gemma):
pnpm --filter @ceibo/rem-runner run:dry mywiki --local ~/wikis/personal --planner anthropic
```

Sin `--local` clona por el proxy git (necesita `REM_PUSH_TOKEN`). `--keep` conserva el scratch.

## Guardrails (no tocar a la ligera — nacieron de incidentes)

Viven en `@ceibo/gateway/logic` y los aplica el sync del gateway, no este runner:
- **`REM_MAX_DELETIONS`** (default 10): si una pasada borra netas más de N notas `.md`, se
  revierte entera (incidente 2026-06-09: archivó 37 notas reales).
- **Atribución de commits**: solo se imputan a REM los borrados que hizo REM, no los de un
  push del usuario en el medio (review 2026-06-10).

## Deploy (manual — NO lo cubre ningún script de deploy)

El bundle (`dist/rem-batch.cjs`, `dist/rem-runner.cjs`, `dist/rem-dry.cjs`) y las units de
`systemd/` se copian a mano a gpuhost (`~/rem-runner/` + `~/.config/systemd/user/`). Config en
`~/.config/ceibo/rem-batch.env`. El timer está **DISABLED por default**; se habilita tras un
smoke manual:

```bash
systemctl --user enable --now ceibo-rem-batch.timer
journalctl --user -u ceibo-rem-batch.service -f
```

## Scope

Estás trabajando en `@ceibo/rem-runner`. Editá **solo** dentro de `packages/rem-runner/`. Si el
cambio cruza paquetes, declaralo en `.claude/active-scope` o vacialo. Ver el `CLAUDE.md` raíz.
