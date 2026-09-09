# quickboot — compactación + clear diario de sesiones

> Estado: **plan de trabajo** (2026-06-19) · autor: claude (opus). Decisiones de diseño tomadas con el owner (ver §1); quedan 2 verificaciones load-bearing (§6) antes de codear. Índice: `plan.md`. Dual operativo: `sleep-plan.md`.
>
> **Una línea:**  dos capas para acotar el prefill del Frío 1 — (A) **opencode autocompacta** intra-día cuando el contexto aprieta, con feedback de UI; (B) **clear diario a las 4am deltimezone del usuario**, para que cada mañana el hilo arranque chico.

## 1\. Decisiones (con el owner, 2026-06-19)

- **Compactación = la nativa de opencode** (no la hacemos nosotros). La activamos y la dejamos disparar "cuando sea necesario", con **feedback de UI** (mostrar "conversación compactada" en el chat).
- **Clear diario por usuario a las 4am de su timezone.**  Hoy todos GMT-3, pero el mecanismo es **por-tz** desde el día 1 (cada usuario tiene su timezone).
- Las dos capas son complementarias: compaction mantiene el hilo usable mientras crece durante el día; el clear corta de raíz cada madrugada (el prefill matutino arranca mínimo).

## 2\. Capa A — compactación nativa de opencode

### Cómo funciona (verificado en `refes/opencode/specs/v2/session.md:107-117`)

Antes de cada provider-turn, opencode estima el request completo vs `context_window − buffer`. Si excede y hay turnos viejos, **compacta antes del turno**: reemplaza la representación activa por un checkpoint con un **resumen rolling + contexto reciente acotado por tokens**, y deja el transcript completo "durable". Config (`config.md:345-361`):

```jsonc
"compaction": {
  "keep":   { "tokens": 2000 },   // historia reciente literal en el checkpoint
  "buffer": 10000                  // headroom reservado: dispara ANTES de llenar la ventana
}
```

### Hallazgo crítico — hoy NO compacta (y por qué)

El modelo `gemma4-31b` en `packages/archima-runtime/runtime/configs/opencode-delegv2.json` **no tiene bloque** `**limit**` (qwen7b tiene `context:16384`, gemma4-e4b `8192`; gemma4-31b **ninguno**). La auto-compaction se dispara contra `context_window`; **sin** \*\*`limit.context`\*\***no hay umbral → nunca compacta** → el contexto crece libre (medido: 48k tok/turno).

**Activar compaction = dos cambios en ese JSON:**


1. Setear `limit.context` para `gemma4-31b` (define la ventana efectiva — ver §4, es la palanca latencia↔contexto).
2. Agregar el bloque `compaction { buffer, keep.tokens }`.

### Feedback de UI

opencode emite eventos durables (`session.md:113`):

- `session.next.compaction.started.1` — intento iniciado (progreso, no durable).
- `session.next.compaction.ended.2` — **durable; este proyecta un mensaje model-visible decompactación.**  Es el que usamos para la UI.

Path a construir: mapear ese evento en el RelayTranslator (`packages/backend-local/src/opencode-events.ts`) → emitir un frame de sistema al Sink → el gateway lo manda por SSE → la web lo renderiza como mensaje de sistema ("conversación compactada"). opencode ya tiene el i18n `"Session compacted"` para su propia UI; en ceibo-web hay que sumar el render del frame nuevo.

#### Hand-off concreto (revisado en el código 2026-06-19)

- **Evento a manejar:**  en `RelayTranslator.handle(ev)` (`opencode-events.ts:93`), agregar un `case "session.compacted":` (el evento es global del bus, ya filtrado por sesión por el relay). Es la señal única y limpia (vimos también `message.part.updated` con `part.type:"compaction"` y un `message.updated` con `agent:"compaction",summary:true`, pero `session.compacted` alcanza).
- **OJO con el Sink:**  la interfaz `Sink` (`packages/agent/src/index.ts:69`) tiene `message()` (se muestra como dicho del agente), `status()` **log-only (NO se le muestra aluser)** , y `error()` (user-visible pero semántica de error). Ninguno encaja para un aviso de sistema neutro. **Decisión de implementación:**  o (a) **agregar un método nuevo al Sink** (ej. `notice(text)` / `system(text)`) plumbeado agent→gateway→canales→web (más limpio, consistente con cómo el clear también querrá avisar "conversación reiniciada"), o (b) reusar `message()` con un prefijo (rápido pero se ve como si lo dijera el asistente). Recomiendo (a): un solo frame de sistema sirve para compactación Y clear.
- **Gateway:**  el consumidor del Sink arma el `makeSink(ctx)` en `engine.ts`; ahí se conecta cada método del Sink a `thread.post(...)`/frames. El frame nuevo se emite igual que `subagents()`/`error()` (mirar `emitReply`/`makeSink`).
- **Web:**  renderizar el frame de sistema como una línea centrada/atenuada (estilo divisor), distinta de un bubble de usuario/asistente.

### ✅ Verificado en vivo (2026-06-19, VM de dev `ceibo-dev`)

Probé el mecanismo end-to-end en la VM de dev (opencode **1.17.8**, que matchea exacto el source del clone `refes/opencode`). Seteé `limit.context:4000` + `compaction` en `~/work/opencode.json`, reinicié opencode, y empujé una sesión más allá del umbral. Resultado:

- **Auto-compaction DISPARA** apenas hay `limit.context` (con context=0 nunca evalúa, ver `overflow.ts:29`). Eventos observados: `message.part.updated` con `part.type:"compaction"`, `"auto":true,"overflow":false`; un mensaje `role:"assistant", agent:"compaction", summary:true`; y el evento `**session.compacted**` (este es el hook de UI).
- **El resumen de gemma-31b es usable y estructurado** — template real producido: `## Goal … ## Constraints & Preferences - Palabra secreta: BANANA … ## Progress (Done/In Progress/Blocked) … ## Key Decisions … ## Next Steps … ## Critical Context`. **Preservó elhecho clave** (la "palabra secreta" plantada quedó en Constraints).
- **⚠️ Caveat de calibración:**  con el umbral torturante del test (ventana 4k → compactó 2+ veces seguidas, el filler se comió el tail reciente), tras compactar el agente entró en un loop de "no tengo próximos pasos, ¿qué querés hacer?" y **no recuperó el hecho** al preguntárselo directo, pese a estar en el resumen. **Conclusión: la calidad la define lacalibración** (ventana generosa + `preserve_recent_tokens`), no el mecanismo. Con un modelo chico como gemma-31b, compactar seguido degrada → la ventana debe ser **amplia** (compaction = red de seguridad, no rutina) y el **clear diario** (§3) es la herramienta primaria para acotar el prefill matutino.

### Config exacto (keys de la 1.17.8, NO las del spec v2)

OJO: el spec v2 renombra keys; la **1.17.8 deployada** usa estas (verificadas en `overflow.ts` + `compaction.ts`):

```jsonc
// en provider.local.models["gemma4-31b"]:
"limit": { "context": 32000, "input": 24000, "output": 1024 },
// top-level:
"compaction": {
  "auto": true,                  // default true; OPENCODE_DISABLE_AUTOCOMPACT lo apaga
  "reserved": 8000,              // headroom (el v2 lo llama "buffer"); default min(20000, maxOutput)
  "preserve_recent_tokens": 8000,// historia reciente literal (clamp 2000..8000)
  "tail_turns": 4                // turnos al final que no se compactan
}
```

Umbral efectivo (de `overflow.ts`): compacta cuando `tokens.total >= usable`, con `usable = limit.input − reserved` (o `context − maxOutput` si no hay `limit.input`). Con los números de arriba: dispara cerca de `24000 − 8000 = 16k` tokens de uso → prefill frío acotado.

## 3\. Capa B — clear diario a las 4am del timezone del usuario

### Qué es "clear"

Reusa `recreateSession` (`packages/gateway/src/engine.ts`, el path de `/new`): crea sesión opencode nueva + relay **antes** de cerrar el viejo (atómico, con test e2e en `session-reset.e2e.test.ts`). El bug histórico de "sesión muda" por recreate no-atómico **yaestá arreglado** — el clear se apoya en eso.

### Piezas que ya existen

- `recreateSession` atómico + `/new`.
- `nextFireFrom(expr, tz, afterIso)` (`store/src/index.ts:2864`) — computa el próximo disparo de un cron-expr en una tz (reusa `CronExpressionParser`). Sirve para "próximas 4am en tz".
- `listUsers(db)` — patrón de iteración batch (como el REM).
- Soporte de tz en la tabla `crons` (`tz TEXT DEFAULT 'UTC'`).

### Piezas que faltan


1. **Columna** `**users.timezone**` (hoy `tz` solo vive en `crons`, no en `users`). Migración safe: `ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'UTC'` \+ campo en la interface `User` \+ setear GMT-3 (`America/Argentina/Buenos_Aires`) a los usuarios actuales.
2. **Scheduler del clear.**  Un timer que corre seguido (ej. cada hora, o cada 15min) y para cada usuario `active` con `backend_mode=local` cuyo "4am local" cayó en la última ventana, dispara el clear. Patrón: igual que el REM batch pero por-usuario y leyendo `users.timezone`. Decisión: **timer dedicado** (no colgarlo del REM — ver §5).
3. **Frame de UI** "conversación reiniciada" (mismo mecanismo que el de compaction de §2).

### ¿Hard reset o puente-resumen?

El clear con `recreateSession` es **hard**: la sesión nueva arranca sin memoria del hilo de ayer. Es aceptable porque la **memoria durable del usuario vive en su wiki** (notas + lo que destila el REM), no en el transcript del chat. **Decisión por defecto: hard clear.**  Opción v2 si se siente abrupto: arrastrar un resumen-puente de 1 párrafo (reusando el summary de la última compaction del día).  **(confirmar con el owner — §6)**

## 4\. La palanca latencia ↔ contexto (`limit.context` de gemma4-31b)

Setear `limit.context` define cuánto puede crecer el hilo antes de compactar, y por ende el peor-caso de prefill frío:

- vLLM tiene \~263k tok de KV cache, pero el prefill es **O(n²)** : 34k≈16s, 100k≈65s frío.
- Queremos una ventana **chica** a propósito (latencia), apoyándonos en que compaction + clear diario mantienen la continuidad. Punto de partida sugerido: `context: 24000`, `buffer: 8000`, `keep.tokens: 2000` → compacta cerca de \~16k de uso real, prefill frío acotado a \~8-10s en el peor caso, y con clear diario casi siempre mucho menos.
- Es un parámetro a **tunear midiendo** (Fase 0 instrumenta prefill-time + tamaño).

## 5\. Relación con el REM (¿interfiere el clear?)

El REM corre **07:30 UTC fijo** (`rem-runner/systemd/ceibo-rem-batch.timer`), es **por-wiki** (no por-usuario) y trabaja sobre **deltas de git de la wiki** (planner sonnet + executor gemma), no sobre el transcript de la conversación. → **el clear y el REM parecen ortogonales** (el clear no le saca insumo al REM). **A verificar (§6):**  que nada lea el transcript de la sesión para destilar memoria *antes* del clear; si algo lo hiciera, el clear iría *después*. Nota: 4am GMT-3 = 07:00 UTC, justo antes del REM 07:30 UTC — si resultara que sí hay dependencia, hay que invertir el orden.

## 6\. Comandos de usuario — `/compact` y `/status`

El dispatch de slash-commands está **100% centralizado** en `packages/gateway/src/engine.ts` (`/new`, `/model`, `/voice`, `/stop`, … líneas \~1271-1510), **canal-agnóstico**: un comando nuevo agregado ahí anda en **web, telegram y whatsapp** sin tocar cada canal. Propuesta:

- `**/compact**` — compactación manual on-demand. opencode 1.17.8 expone `POST /session/{ses}/summarize` (verificado en `session.ts:303`). El gateway lo invoca vía el http-opencode-client (sumar un método `summarize()`); responde "Conversación compactada ✅". Útil cuando el usuario sabe que arranca un tema nuevo y quiere achicar el contexto sin perder el hilo (a diferencia de `/new`, que es hard reset).
- `**/status**` — estado de la sesión: tamaño de contexto actual vs ventana (`tokens.total` de la última respuesta vs `limit.context`), si hubo compactación reciente, `backend_mode` (local/ma), modelo, y hora del próximo clear diario. Los tokens salen del event-stream de opencode (ya los vemos: `tokens:{total,input,output}`); hay que cachear el último por sesión en el gateway y formatearlo. Da visibilidad de "por qué va lento" (contexto grande) y de cuándo va a resetear.
- `**/help**` — sumar las dos a la lista de comandos (revisar dónde se lista; hay `/start`).

Estos comandos comparten plomería con el feedback de UI (§2): el frame de sistema y el método `summarize()`/lectura de tokens se reusan.

## 7\. Verificaciones load-bearing


1. ✅ **RESUELTO (2026-06-19): la opencode deployada (1.17.8) SÍ inicia auto-compaction.** Verificado en vivo en la VM de dev (ver §2 "Verificado en vivo"). El caveat *partial* era del rediseño v2, no de la 1.x. Gate real: `limit.context` debe ser \> 0 (hoy es 0 → por eso no compacta). Fallback manual disponible igual: `POST …/session/:id/summarize`.
2. ✅ **RESUELTO (owner, 2026-06-19): NINGÚN proceso lee la conversación — todo es sobre lawiki.**  El clear es **ortogonal al REM** y corre a cualquier hora. Confirmado además por código: el único "transcript" es la transcripción de audios (voz→texto), no chat→wiki; y `recreateSession` no borra las filas de mensajes del store (sesión nueva + snapshot 0) → el clear es no-destructivo.
3. ✅ **RESUELTO (owner, 2026-06-19): clear = HARD reset** (sin puente-resumen). La memoria durable vive en la wiki.
4. **Calibración de la ventana** — el valor de `limit.context` / `reserved` / `preserve_recent_tokens` se tunea midiendo (el test mostró que mal calibrado degrada). Se hace en Fase 1 con instrumentación.

## 8\. Fases

- **Fase 0 — instrumentar.**  Loguear prefill-time + tamaño de contexto por turno (cold/warm). ✅ La verificación de compaction en la VM de dev ya está hecha (§2). Falta la instrumentación de métricas para tunear.

> **Validación (2026-06-19):**  Bloque 1 (render del aviso de sistema + `/compact` + `/status`) **probado OK en dev** por el owner — `/compact` muestra "Conversación compactada" como línea de sistema y `/status` reporta bien. **Auto-compaction y clear diario se validan en STAGING.** ⚠️ **Prerrequisito del test de staging:**  (1) la auto-compaction NO dispara hasta que el config nuevo llegue a las VMs de staging — re-serve con la copia de `archima-runtime` actualizada (§10); mergear `dev→staging` NO basta. (2) El usuario de prueba debe ser `backend_mode=local` (el default es `ma`; compaction y clear sólo aplican a local). El clear necesita el gateway de staging con el código nuevo (viene con el deploy del monorepo a la box).

- **Fase 1 — activar compaction.**  ✅ **HECHO (2026-06-19, branch** `**feat/quickboot-sessions**` **).** `limit.context` (32000/24000/1024) + `compaction` (`auto`, `reserved:8000`, `preserve_recent_tokens:8000`, `tail_turns:4`) en el config (keys 1.17.8, §2); `session.compacted` → `Sink.notice` nuevo → frame `notice` (agent→backend-local→gateway→channels→web-server→web) → render como línea de sistema atenuada (`role:"system"`). El mismo `notice` lo reusa el clear (F3). Telegram/cli/whatsapp caen a `post` con prefijo `ℹ️`. **typecheck + lint(mis archivos) + 1934tests OK** (sumé 2: `opencode-events` session.compacted, `frames` notice). **Ventana amplia** (compaction = red de seguridad); valores a tunear midiendo (F4). Falta deploy del config a las VMs (paso aparte, §10) — el cambio del repo NO surte efecto hasta re-servir la VM.
- **Fase 2 — comandos**  `**/compact**`  **+**   `**/status**` (§6). ✅ **HECHO (2026-06-19).**  `summarize()` en el http-opencode-client (POST /session/:id/summarize con `{providerID,modelID}` en el body) + `OpencodeClient.summarize` + `Relay.summarize?` (opcional: sólo backend local; MA no lo expone). `/compact` → `relay.summarize()` (el aviso "compactada" sale por el Sink) con ack; gateado por `backend_mode==='local'`. `/status` → backend, modelo, tamaño de contexto del último turno (`turnComplete` cachea `lastUsage`) y antigüedad de la última compactación (`notice` cachea `lastCompactedAt`). Dispatch en `runCommand` (canal-agnóstico) + menú de Telegram.  **+1 test** (summarize endpoint+body). Pendiente: sumar la hora del próximo clear diario al `/status` cuando aterrice F3.
- **Fase 3 — clear diario por-tz.**  ✅ **HECHO (2026-06-19).**  Columna `users.timezone` (default `'UTC'`, backfill de los usuarios actuales a `America/Argentina/Buenos_Aires`; nuevos toman UTC hasta setear su tz). `runDailyClears()` itera los usuarios `backend_mode=local` activos y hace HARD reset (`recreateSession`) a las 4am de su tz, computado con `nextFireFrom("0 4 * * *", tz)`. Estado in-memory `nextClearAt` con **lazy-init a futuro** → NUNCA dispara al arrancar; un restart cerca de las 4am puede saltearse UN clear (benigno). Timer **dedicado** en `index.ts` (tick 15min, `DAILY_CLEAR_TICK_MS`), separado del scheduler de crons. Aviso "Conversación reiniciada" por el `notice` de F1 (best-effort vía `lastThread`). `/status` muestra el próximo reinicio diario. **+3 tests** (timezone default, +2 e2e del invariante "no dispara en el 1er tick / ignora 'ma'"). Es la herramienta primaria para el prefill matutino.
- **Fase 4 — tuning.**  Ventana, reserved, preserve\_recent\_tokens; puente-resumen si se decide.

## 9\. Cambios por paquete (mapa de implementación)

| Cambio                                                                                              | Archivo                                                                                                   | Estado                      |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------- |
| `limit.context` + `compaction` para gemma4-31b (keys 1.17.8)                                        | `packages/archima-runtime/runtime/configs/opencode-delegv2.json`                                          | ✅ HECHO (F1)                |
| Mapear evento `session.compacted` → `Sink.notice`                                                   | `packages/backend-local/src/opencode-events.ts`                                                           | ✅ HECHO (F1)                |
| Método `notice()` en el `Sink` (aviso de sistema neutro)                                            | `packages/agent/src/index.ts`                                                                             | ✅ HECHO (F1)                |
| `PostTarget.notice` + `NoticeFrame` \+ emit en remote                                               | `packages/channels/src/{types,protocol,remote}.ts`                                                        | ✅ HECHO (F1)                |
| `makeSink.notice` → `thread.notice` (fallback a `post`)                                             | `packages/gateway/src/engine.ts`                                                                          | ✅ HECHO (F1)                |
| Reenviar frame `notice` por SSE                                                                     | `packages/web-server/src/frames.ts`                                                                       | ✅ HECHO (F1)                |
| Render mensaje de sistema (`role:"system"`, línea divisoria)                                        | `packages/web/src/{useChannel.ts,App.tsx,index.css}`                                                      | ✅ HECHO (F1)                |
| Método `summarize()` (POST /session/{ses}/summarize) + `Relay.summarize`/`OpencodeClient.summarize` | `packages/backend-local/src/http-opencode-client.ts`, `archima-backend.ts`, `packages/agent/src/index.ts` | ✅ HECHO (F2)                |
| Comandos `/compact` y `/status` (+ tokens por sesión cacheados en `turnComplete`/`notice`)          | `packages/gateway/src/engine.ts`                                                                          | ✅ HECHO (F2)                |
| `/compact` + `/status` en el menú de slash-commands                                                 | `packages/channels/src/telegram.ts`                                                                       | ✅ HECHO (F2)                |
| Columna `users.timezone` (CREATE TABLE + migración + backfill GMT-3) + `User.timezone`              | `packages/store/src/index.ts`                                                                             | ✅ HECHO (F3)                |
| `runDailyClears` (clear por-tz, lazy-init, reusa `recreateSession`+`nextFireFrom`) + timer dedicado | `packages/gateway/src/engine.ts`, `packages/gateway/src/index.ts`                                         | ✅ HECHO (F3)                |
| Aviso "Conversación reiniciada" en el clear (reusa `notice` de F1) + próximo clear en `/status`     | `packages/gateway/src/engine.ts`                                                                          | ✅ HECHO (F3)                |
| Kill-switch `DAILY_CLEAR_ENABLED` (default ON) del clear diario — higiene de prod                   | `packages/gateway/src/index.ts`                                                                           | ✅ HECHO (prod-ready)        |
| `recreateSession` atómico                                                                           | `packages/gateway/src/engine.ts`                                                                          | ✅ EXISTE                    |
| `nextFireFrom(expr,tz,afterIso)`                                                                    | `packages/store/src/index.ts:2864`                                                                        | ✅ EXISTE                    |
| Auto-compaction en opencode 1.17.8                                                                  | runtime (VM)                                                                                              | ✅ EXISTE (gate: context\>0) |
| `POST /session/{ses}/summarize` (compaction manual)                                                 | runtime (VM)                                                                                              | ✅ EXISTE                    |

## 10\. Cómo el config llega a las VMs (deploy — paso aparte)

El config `opencode-delegv2.json` vive **versionado** en `packages/archima-runtime/runtime/configs/`, pero a las VMs llega por `cp.sh serve` (`packages/archima-runtime/runtime/vm/cp.sh:142-184`):

- `cp.sh serve <name> [cfg]` copia `$HERE/../configs/$CFG` (default `opencode-delegv2.json`) + los prompts (`ceibo.md`, `ceibo-worker.md`, `AGENTS.md`) a la VM, los renombra a `~/work/opencode.json` etc., y arranca opencode con `--working-directory=/home/archima/work` (por eso opencode lee `~/work/opencode.json`).
- `**cp.sh**` **corre en archi** y lee el config de **su copia local de** `**archima-runtime**` (NO del monorepo de tu mac), en `~/archima/<env>/configs/`.
- **CORRECCIÓN (2026-06-19, revisado en el código):**  el deploy del runtime a archi **SÍ estáversionado** — `scripts/deploy-archima.sh` (`pnpm deploy:archima:{dev,staging,prod} --apply`) buildea `@ceibo/archima-runtime` (el build copia **todo** `runtime/`, incluido `configs/opencode-delegv2.json`) y lo rsyncea a `~/archima/<env>/`. El §10 viejo decía "a mano, fuera del flujo" — **desactualizado**. Lo que SÍ es cierto: ese deploy es un **leg aparte** — `deploy-staging.sh` y `promote-prod.sh` **NO lo invocan** (verificado), así que hay que correrlo a mano además del deploy del código. **Si no se corre, la auto-compaction queda OFF** (el código del gateway sí va con el deploy normal, pero el config con `limit.context` no).
- **VM ya viva → se re-sirve sola:**  `recreateSession` hace `unbind` → la próxima `ensureSession` re-resuelve `base` = `cp.sh serve` → **re-copia el config**. Como el **clear diario** (F3) hace `recreateSession` a las 4am, la primera madrugada tras `deploy:archima` la VM levanta el config nuevo **sola** (sin re-serve manual). Un `/new` del usuario hace lo mismo on-demand.

## 11\. Apéndice — reproducir el test de compaction en la VM de dev

Procedimiento exacto usado el 2026-06-19 (sirve para re-validar y para tunear la ventana).

**Entorno dev VM:**  nombre `archima-ceibo-dev-ceibo-dev`; IP libvirt dinámica (chequear con `sudo virsh domifaddr <vm> | grep -oE '192\.168\.122\.[0-9]+'`, ese día `192.168.122.168`); opencode binario `/home/archima/.opencode/bin/opencode` (v1.17.8); config `~/work/opencode.json`; acceso: `ssh archetype1` y desde ahí `ssh archima@<ip>` (key-based).

**1\. Editar el config en la VM** (gemma4-31b sin `limit` → context=0 → compaction OFF):

```python
# en ~/work/opencode.json, sobre provider.local.models["gemma4-31b"]:
g["limit"] = {"context": 4000, "input": 3000, "output": 512}   # chico A PROPÓSITO para gatillar
d["compaction"] = {"auto": True, "reserved": 500, "preserve_recent_tokens": 1000, "tail_turns": 2}
```

(Hacer `cp opencode.json opencode.json.bak-quickboot` antes, para revertir.)

**2\. Reiniciar opencode PRESERVANDO el config editado** — NO usar `cp.sh serve` (re-copia el config del repo y pisa tu edit). Reiniciar el unit transitorio directo:

```bash
sudo systemctl stop opencode-serve; sudo pkill -x opencode; sleep 3
sudo systemctl reset-failed opencode-serve   # ⚠️ imprescindible (ver gotcha)
sudo systemd-run --quiet --collect --unit=opencode-serve --uid=archima --gid=archima \
  --setenv=HOME=/home/archima --setenv=OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1 \
  --working-directory=/home/archima/work /bin/bash -c \
  "set -a; . /home/archima/agent-vault-env; set +a; exec agent-vault run -- \
   /home/archima/.opencode/bin/opencode serve --hostname 0.0.0.0 --port 14420"
sleep 5; curl -s http://127.0.0.1:14420/global/health   # {"healthy":true,"version":"1.17.8"}
```

> **Gotcha (lo pegué):**  `systemctl stop opencode-serve` puede tardar \~90s (stop-sigterm → SIGKILL). Si lanzás el `systemd-run --unit=opencode-serve` antes de que el viejo muera del todo, **colisiona el nombre del unit y el nuevo no arranca** (opencode queda DOWN). Por eso el `pkill` + `sleep` + `reset-failed` antes de re-lanzar.

**3\. Drivear la sesión** (API opencode): `POST /session {title,agent:"ceibo"}` → `ses_…`; capturar `GET /event` (SSE global) en background; `POST /session/{ses}/prompt_async` con `{parts:[{type:"text",text}], model:{providerID:"local",modelID:"gemma4-31b"}, agent:"ceibo"}`. Mandar un turno con 2.5k tokens de relleno + un hecho plantado ("palabra secreta: BANANA"),esperar idle (35s), mandar un 2º turno. Observar en `/event`: `message.part.updated part.type:"compaction"` + `message.updated agent:"compaction",summary:true`

- `**session.compacted**`. El resumen sale en un part de texto del mensaje de compactación.

**4\. Revertir** (dejar dev como estaba): `mv opencode.json.bak-quickboot opencode.json` y reiniciar opencode igual que en (2). El próximo `cp.sh serve` de dev re-copia el config del repo igual, así que aunque no revierta, dev se auto-sana al próximo re-serve.

**Resultado obtenido:**  compaction disparó (auto, no overflow); gemma-31b produjo un resumen estructurado que preservó "BANANA"; con la ventana torturante hubo degradación de comportamiento post-compactación (loop "¿qué querés hacer?"). → calibrar ventana amplia en producción.

## 12\. Runbook de deploy a staging/prod (lado backend)

Revisado en el código 2026-06-19. **No falta código de backend** — el feature anda con el tooling existente. Para que ande en staging/prod hay que correr **DOS legs** de deploy (no uno):


1. **Código (gateway/web/store):**  la promoción normal por PR (`dev→staging`, `staging→main`) + `deploy-staging.sh` / `promote-prod.sh`. Esto lleva: comandos `/compact` `/status`, el frame `notice` \+ render, el timer del **clear diario**, y la **migración** `**users.timezone**` (corre sola al abrir la DB; backfillea los usuarios actuales a GMT-3).
2. **Runtime de archima (el config opencode):**  `pnpm deploy:archima:staging --apply` (y `:prod`). **Leg APARTE** — `deploy-staging.sh`/`promote-prod.sh` **no lo invocan**. Lleva el `opencode-delegv2.json` con `limit.context`+`compaction`. **Sin esto, la auto-compaction quedaOFF** (pero el clear diario y `/compact` ya andan con el leg 1).

**Pickup del config en VMs vivas:**  no requiere re-serve manual — `recreateSession` (que usa el clear diario a las 4am, y `/new`) hace `unbind` → `cp.sh serve` re-copia el config. La primera madrugada tras `deploy:archima` la compaction se activa sola.

**Requisitos de entorno (ya deberían estar donde se usa archima):**

- Usuarios objetivo con `backend_mode='local'` (compaction y clear **sólo** aplican a local; el default es `'ma'`). El owner/archima ya son local.
- `ARCHIMA_SSH_TARGET` (y `ARCHIMA_*`) en el `.env` de la box, si no el backend local queda apagado.

**Kill-switch del clear diario:**  `DAILY_CLEAR_ENABLED` (default ON). Para un rollout escalonado: deployás el código con `DAILY_CLEAR_ENABLED=false` en el `.env` de prod, validás en staging, y recién ahí lo prendés. `DAILY_CLEAR_TICK_MS` ajusta la cadencia del barrido (default 15min).

**Orden sugerido de promoción:**  dev→staging (PR) → `deploy-staging` → `deploy:archima:staging` → validar (auto-compaction + clear) → staging→main (PR) → `promote-prod` → `deploy:archima:prod`.


---

Memorias relacionadas: `archima-prefill-economics`, `dev-local-archima-setup`, `rem-batch-runs-on-archetype1-host`, `archi-reboot-breaks-gateway`, `cp-assign-hotfix-box`, `deploy-flow-squash-merge-gotchas`, `web-connection-sse-zombie`.
