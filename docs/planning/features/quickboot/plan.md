# quickboot — índice

> Estado: **planes de trabajo, en discusión** (2026-06-19) · autor: claude (opus). NO son specs cerradas: el diseño fino se acuerda con el owner antes de escribir spec. Carpeta: `~/wiki/ceibo/tecnico/features/quickboot/`.

**Problema:**  el primer mensaje tras varias horas de inactividad, para usuarios `backend_mode=local` (archima), tarda dolorosamente (decenas de segundos, a veces minutos). Turnos posteriores del mismo hilo responden normal.

**Causa (validada 2026-06-19, read-only):**  se suman **dos fríos** tras una noche.

- **Frío 1 — prefill cold de vLLM (DOMINANTE).**  El prefix-cache de gemma se evicta de noche → el primer turno **re-prefilea la conversación entera desde cero**. El prefill es O(n²) (1500–2300 tok/s; 48k tok ≈ 20–30s) y el hilo **crece sin techo**. Pega aunque la VM siga viva. Dato real de hoy: `$ [8] in:47819 out:87 model:gemma4-31b` → \~48k tok/turno.
- **Frío 2 — VM cold-start (INTERMITENTE).**  Solo si la VM quedó `shut off` (típico tras reboot nocturno de archi): boot + serve + MCP reconcile → 150–300s. Hoy NO aplicó (archi sin reboot, todas las VMs running).

**Dos planes** (el owner pidió separarlos):

- `sessions-plan.md` — **compactación / reset de sesión.**  Ataca el Frío 1 de fondo: acota el contexto para que el prefill no escale con la antigüedad del hilo. **Mayor ROI permanente.**
- `sleep-plan.md` — **sleep de VMs + warmup/quickboot.**  El sleep duerme VMs ociosas (palanca de escala; la RAM hoy sobra) y el warmup las despierta **calientes** antes del primer mensaje (mata el dolor matutino end-to-end). Son duales: se diseñan juntos.

**Orden de valor:**  sessions ≈ warmup ≫ sleep-por-sí-solo.

## Estado (2026-06-19)

> **Implementación: Fases 1-3 HECHAS (2026-06-19) → PR** \*\*#480\*\***a** `**dev**` **, CI verde (ci + changelog), mergeable.**  Branch `feat/quickboot-sessions` desde `dev`, 22 archivos (+431/−2) + fragmento de changelog. **F1** compaction nativa + frame de sistema `notice`; **F2** comandos `/compact` + `/status`; **F3** clear diario por-tz (4am del usuario). CI local verde: `pnpm lint` (0 errores) · `typecheck` · **1938 tests** (+6 nuevos). Progreso fino: §9 de `sessions-plan.md`. **Pendiente:**  (a) **Fase 4 — tuning** (calibrar `limit.context`/`reserved`/`preserve_recent_tokens` midiendo prefill-time en vivo; no es código, es medición post-deploy); (b) **deploy del config alas VMs** (paso aparte, §10 de `sessions-plan.md`): el cambio del JSON NO surte efecto hasta re-servir la VM. El sessions-plan acota el Frío 1; el `sleep-plan.md` (warmup) sigue pendiente.

- **Decisiones cerradas con el owner:**  (1) compactación = la nativa de opencode; (2) clear diario a las 4am del tz del usuario; (3) clear = **hard reset** (sin puente-resumen); (4) sumar comandos `/compact` y `/status`. Nada lee la conversación (todo es sobre la wiki) → el clear es ortogonal al REM.
- **Verificado en vivo (VM de dev):**  opencode 1.17.8 **sí** auto-compacta; el gate es `limit.context` (hoy gemma4-31b no lo declara → vale 0 → compaction OFF). Ver `sessions-plan.md` §2.
- **Implementación:**  se va a correr **desde otra compu**. Esta carpeta es el hand-off completo y autocontenido (file:line, config exacto, endpoints, procedimiento de test en la VM de dev en `sessions-plan.md` §11). Fase 1 = activar compaction + evento de UI; Fase 2 = comandos; Fase 3 = clear diario por-tz. El feature-branch arranca de `dev` (PR a `dev`).
- **Nota de deploy:**  el cambio de `archima-runtime/configs` se versiona en el repo pero su llegada a las VMs es un paso de deploy de runtime **aparte** (la copia de `archima-runtime` en archi se provisiona a mano hoy). Ver `sessions-plan.md` §10.

## Apéndice — data de validación (2026-06-19, read-only sobre archi + box)

```
archi:        up 2 days, 18:44 (boot 2026-06-16 13:30) → sin reboot nocturno
VMs archima:  5, todas running (<owner>/owner incluida)
RAM archi:    93Gi total, 34Gi free, 78Gi available; ~1GB RSS por VM
VRAM:         89458/97887 MiB (gemma cargada; KV-cache en VRAM, NO se libera al dormir VM)
gateway log:  $ [8] in:47819 out:87 cache:0/0 model:gemma4-31b  ← ~48k tok prefill/turno
```

Memorias relacionadas: `archima-prefill-economics`, `archi-reboot-breaks-gateway`, `archima-noproxy-vllm-badgateway`, `cp-assign-hotfix-box`, `rem-batch-runs-on-archetype1-host`.
