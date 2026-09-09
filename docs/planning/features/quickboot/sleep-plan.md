# quickboot — sleep de VMs + warmup

> Estado: **plan de trabajo, en discusión** (2026-06-19) · autor: claude (opus). NO es spec cerrada. Índice: `plan.md`. Dual de fondo: `sessions-plan.md`.
>
> **Una línea:**  **dormir** VMs ociosas (libera RAM del host; palanca de escala) y **despertarlas calientes** (warmup) antes del primer mensaje, para que el cold-start no se note. Sleep y warmup son **duales** y se diseñan juntos: sin warmup, el sleep solo empeora el cold.

## 1\. Reencuadre importante — el sleep NO es lo que arregla la lentitud de hoy

Medido 2026-06-19: archi tiene **93 GB RAM, 78 GB libres**; cada VM archima usa  **\~1 GBRSS** (5 VMs ≈ 5 GB). La RAM del host **no está bajo presión**. Y el KV-cache de gemma vive en **VRAM** (89/98 GB usados): **dormir una VM (managedsave) NO libera ni preserva esecache**. Por lo tanto:

- El **sleep** es una palanca de **escala** (decenas de VMs familiares) y de prolijidad — **baja prioridad hoy**.
- Lo que mata el dolor matutino es el **warmup** (re-prefilear off-peak). Por eso este plan prioriza warmup y trata sleep como su complemento para cuando la escala lo pida.

## 2\. Warmup / quickboot (la pieza de alto impacto)

Un job que, antes de la hora típica del primer mensaje (o disparado por señal), por cada usuario local **activo**:


1. `**ensureVm**`  **+**  `**cp.sh serve**` — si la VM estaba dormida/apagada, paga el boot + el opencode health-wait off-peak (el **Frío 2**). Path actual: `archima-backend.ts` (`reuseOrCreate` → estado VM → spawn/restore) + `cp.sh serve` (health-wait 40–60s en cold).
2. **Prompt no-op chico** — re-prefilea el contexto reciente de la sesión en el KV-cache de vLLM (el **Frío 1**). Tras esto el primer mensaje real cae en cache caliente (\~0.1s de prefill).

### Matices de diseño

- **Cache compartido y finito:**  warmear **pocos** usuarios (owner + activos), no todos, o se evictan entre sí. Definir criterio de “activo” (ej. tuvo turnos en las últimas 48–72h).
- **Disparo:**  empezar por **cron fijo configurable** (ej. 07:30 BA, por usuario o global); **predictivo** (aprende la hora del primer mensaje por usuario) es v2.
- **Cuelga del REM o timer aparte:**  el REM nocturno ya toca las VMs (corre en archetype1 host, ver memoria `rem-batch-runs-on-archetype1-host`). Evaluar reusar esa maquinaria vs un timer dedicado. El warmup quiere correr **cerca de la hora de uso**, no a las 04:00 como el REM → probablemente timer aparte.
- **Idempotencia:**  si la VM ya está caliente, el warmup debe ser barato y no-op.

## 3\. Sleep / idle de VMs (complemento, baja prioridad)

Suspender (managedsave, `cp.sh suspend`) VMs ociosas tras X horas de inactividad, para liberar RAM del host. Hoy no hay idle-shutdown automático; las VMs quedan running entre turnos.

- **Cuándo importa:**  al escalar a muchas VMs familiares (la RAM hoy sobra). Documentarlo como palanca lista pero **no urgente**.
- **Regla de oro:**  **sleep SOLO si va pegado al warmup.**  Dormir ocioso → despertar con warmup antes del horario esperado. Sin esa coordinación, el sleep traslada/empeora el cold y reintroduce el dolor que estamos sacando.
- **Mecánica:**  `cp.sh suspend <name>` ya existe (managedsave libera RAM a disco); `cp.sh restore` la levanta. Falta el **scheduler** (quién decide ociosa → dormir) y el **acoplamiento** con el warmup (despertar antes de uso).

## 4\. Fases

- **Fase 0 — instrumentar.**  Loguear wall-clock del primer turno diario por usuario y estado de VM (running/shut off) al momento. Medir el baseline antes de tocar nada.
- **Fase 1 — warmup por cron fijo.**  Despierta+prefilea a los usuarios activos antes del horario. Mata el dolor matutino end-to-end. **Empezar acá.**
- **Fase 2 — sleep idle (opcional, gated por escala).**  Suspend tras inactividad larga, acoplado al warmup de Fase 1. Solo si la RAM empieza a apretar.
- **Fase 3 — warmup predictivo.**  Aprende la hora del primer mensaje por usuario; afina el criterio de “activo” y el horario.

## 5\. Open questions


1. **Dónde vive el warmup:**  ¿monorepo (gateway timer, versionado, fluye dev→staging→prod) o archi (junto a cp.sh/REM)? **Preferencia fuerte por el monorepo** — no sumar estado no-versionado en archi (cp.sh ya está hotfixeado a mano y sin versionar, memoria `cp-assign-hotfix-box`).
2. **Criterio de “usuario activo”**  a warmear (cuántos, qué ventana de actividad).
3. **Forma del prompt no-op** que re-prefilea sin generar respuesta visible ni costo de decode (¿`max_tokens=1`? ¿un endpoint de warmup en opencode?).
4. **Horario:**  cron fijo global vs por-usuario; zona horaria; cómo no pisar el REM.
5. **Aislamiento por entorno:**  dev/staging/prod comparten vLLM; el warmup de uno calienta/ evicta cache de los otros. Medir.
6. **Sleep + el bug de reboot:**  tras restore, `cp.sh serve/assign` puede fallar hasta que la VM toma IP (memoria `archi-reboot-breaks-gateway`); el warmup debe tolerar reintentos.

## 6\. Relación con el otro plan

`sessions-plan.md` **abarata** el prefill (contexto compactado); este plan lo **paga off-peak**. Juntos: el warmup prefilea un contexto ya chico → primer mensaje caliente Y barato. El sleep solo se justifica cuando la RAM apriete, y siempre con warmup.
