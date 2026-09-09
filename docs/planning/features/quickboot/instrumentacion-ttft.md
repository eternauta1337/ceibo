# quickboot — plan de instrumentación de TTFT (warm/cold del prefill)

> Estado: **plan de trabajo** (2026-06-23) · autor: claude (opus). Disparado por `mediciones.md` §3/§7: hoy los logs son **ciegos** al warm/cold del prefill (`cache:0/0` es siempre 0). Índice: `plan.md`.
>
> **Una línea:**  medir el **TTFT real por turno** (delta entre `relay.send` y el primer token del asistente) + el desglose del session-open (serve + MCP reconcile), y loguearlo. Es el prerequisito de TODO lo demás (tunear la ventana de compaction, validar el warmup, saber si el dolor matutino es prefill o MCP). Cambio **solo-logging, sin cambio de comportamiento**.

## 1\. Qué medir y por qué

De `mediciones.md`: la única variable que mueve la latencia es el **estadodel prefix-cache de vLLM** (cold 20s@48k vs warm 0.2s), y **no se ve en ningún log**. Un turno `$ [8] in:47819 cache:0/0` puede haber tardado 0.2s o 22s. Queremos descomponer cada turno en:

```
tRecv ──ensureRelay──> tRelayReady ──applyProfiles──> tSend ──prefill──> tFirstTok ──decode──> tIdle
        (serve+sesión)              (MCP reconcile)            (TTFT)              (generación)
```

- `**open**`  **= tRelayReady − tRecv** — `cp.sh serve` \+ crear/atachar sesión (Frío 2 + opencode).
- `**mcp**`  **= tSend − tRelayReady** — `applyProfileServers` → reconcileMcp (\~24s en cold).
- `**ttft**`  **= tFirstTok − tSend** — ≈ **prefill** (la señal cold/warm que falta). ★ EL DATO CLAVE.
- `**gen**`  **= tIdle − tFirstTok** — generación (output tokens / tok-s de decode).

## 2\. Hallazgo de diseño (verificado en el código, 2026-06-23)

- El texto del asistente se **bufferea** en el `RelayTranslator` y se flushea en bordes (`opencode-events.ts` `flushText()` en tool-call:124 / step-finish:149 / idle:184). `sink.message()` **NO es incremental** → no sirve para TTFT. **El primer token real se ve en**\*\*`opencode-events.ts:120`\*\* (primer `message.part.updated` `type:text role:assistant`). Ahí va el stamp de `tFirstTok`. (Para turnos que arrancan con tool-call, el primer borde es `type:tool`:123 → stampear en ambos, lo que ocurra primero.)
- `tSend` se conoce en el backend (`archima-backend.ts` `attach()`/`send()`), NO en el translator. Se comparten por un ref mutable en la closure de `attach` (el translator se construye ahí).
- `open` y `mcp` son **gateway-side** y ya tienen los await exactos: `engine.ts:1252` (`ensureRelay`) y `engine.ts:1261` (`applyProfileServers`). Stamp con `Date.now()` alrededor.

## 3\. Cambios (mapa de implementación)

**Parte A — TTFT + duración de turno (núcleo). Paquetes: agent · backend-local · gateway.**

| Cambio                                                                                                                                                                                   | Archivo                                                                                 | Detalle                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Tercer arg opcional `timing?: {ttftMs?,turnMs?}` en `Sink.turnComplete`                                                                                                                  | `packages/agent/src/index.ts` (\~L85, firma de `turnComplete`)                          | No tocar `TurnUsage` (queda puro = usage de MA). MA deja `timing` undefined.                                                                   |
| Ref `turnTiming={sentAt,firstAt}` en la closure de `attach`; `send()` setea `sentAt=Date.now()`                                                                                          | `packages/backend-local/src/archima-backend.ts` `attach()` (L478+)                      | Un ref por relay; el translator lo lee/escribe.                                                                                                |
| Stamp `firstAt` en el 1er part de asistente (texto o tool) del turno; en `session.idle` calcular `ttftMs=firstAt−sentAt`, `turnMs=idleAt−sentAt` y pasarlos a `turnComplete(...,timing)` | `packages/backend-local/src/opencode-events.ts` (texto:120, tool:143-145, idle:183-196) | `resetTurn()` (L196) limpia `firstAt`. Guard: si `sentAt==0` (turno no iniciado por send, ej. prompt sintético de background) → omitir timing. |
| Loguear el timing en la línea de turno                                                                                                                                                   | `packages/gateway/src/engine.ts` `turnComplete` (L956-959)                              | Ver formato §4.                                                                                                                                |

**Parte B — desglose del session-open (serve + MCP). Paquete: gateway.**

| Cambio                                                                                                   | Archivo                                           | Detalle                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Stamp `tRecv` al entrar; `openMs` tras `ensureRelay` (L1252); `mcpMs` tras `applyProfileServers` (L1261) | `packages/gateway/src/engine.ts` `handleIncoming` | Vars locales; adjuntarlas al `ctx` para que `turnComplete` las loguee SOLO en el 1er turno de la sesión (si fueron \> umbral, ej. \>500ms). |

## 4\. Formato de log (extensión de la línea existente)

Hoy (`engine.ts:956`): `$ [8] in:47819 out:87 cache:0/0 model:gemma4-31b → $0.0024`

Propuesto: agregar timing al final (compacto, parseable):

```
$ [8] in:47819 out:87 cache:0/0 model:gemma4-31b ttft:21.4s gen:1.2s → $0.0024
```

y en el **primer turno** de una sesión, una línea aparte con el open:

```
⏱ [8] open:5.1s mcp:23.8s (cold session-open)
```

`ttft` alto = prefill frío; `ttft` \< 0.5s con `in` grande = prefix-cache hit (warm). Por fin distinguible de un vistazo y grepeable (`grep 'ttft:[0-9][0-9]'` = turnos lentos).

## 5\. (Opcional, recomendado) Persistir para análisis histórico

Añadir `ttft_ms`, `turn_ms`, `open_ms`, `mcp_ms` (nullable) a `usage_turns` (`store/src/index.ts`, tabla y `recordTurn` \~L3262/3300). Permite responder con SQL:

- "¿qué % de los primeros turnos del día tardan \>10s?" (mide el dolor matutino antes/después).
- "¿el warmup bajó el ttft del 1er mensaje?" (valida el sleep-plan).
- "¿el clear diario achicó el `in` y por ende el ttft cold?" (valida el sessions-plan). Migración additive-only (mismo patrón que `users.timezone` de F3). Es lo que convierte la instrumentación en una herramienta de tuning (Fase 4 del sessions-plan), no solo un log.

## 6\. (Opcional, complementario) Métricas de vLLM — salud de flota

vLLM expone Prometheus en `/metrics` (host archi, `<tailnet-ip>:8000/metrics`, misma api-key): `vllm:time_to_first_token_seconds` (histograma), `vllm:prefix_cache_hits_total` / `vllm:prefix_cache_queries_total` (→ hit-rate real, hoy 93.5% lifetime), `vllm:num_requests_running`. Un scrape periódico (cron en archi, **fuera del monorepo**, read-only) da la tendencia agregada del prefix-cache y la cola — útil para ver eviction bajo carga de las 7 VMs. NO correlaciona con un turno de usuario (eso lo da la Parte A); es monitoreo de salud.

## 7. `/status` — exponer el último ttft al usuario

El comando `/status` (sessions-plan F2) ya cachea `lastUsage` por sesión. Sumarle el último `ttft`/`turnMs` (mismo cache) da al owner visibilidad directa de "por qué fue lento este turno" (contexto grande + cold = ttft alto). Costo casi nulo, reusa la plomería de F2.

## 8\. Tests

- `opencode-events.test.ts`: stream sintético (user msg → 1er part texto → step-finish → idle) con timestamps mockeados → asserta `ttftMs`/`turnMs` en el `turnComplete`; y el guard `sentAt==0` (prompt sintético) no emite timing. (Mismo patrón que el test de `session.compacted` de F1.)
- `engine` (gateway): asserta el formato de la línea de log con timing (o, si se persiste, que `recordTurn` recibe/escribe los `*_ms`).

## 9\. Riesgo y rollout

- **Riesgo: mínimo.**  Solo-logging + 4 columnas nullable (si se hace §5). Cero cambio de comportamiento del turno. `Date.now()` (no perf-now: cruza procesos/ticks, ms basta).
- **Scope:**  `.claude/active-scope = agent backend-local gateway` (+ `store` si §5).
- **Flujo:**  PR a `dev` (CI: lint+typecheck) → soak local → `dev→staging` → `staging→main` (deploy normal del monorepo; NO requiere `deploy:archima`, es código del gateway/backend). Una vez en prod, las líneas `ttft:` aparecen en `journalctl -u ceibo-gateway@prod` y por fin se ve el warm/cold en tráfico real.
- **Orden sugerido:**  Parte A (núcleo) primero — con eso ya se ve el cold/warm. Parte B y §5/§7 como follow-ups baratos si se quiere el desglose completo y el histórico.


---

Memorias: \[\[archima-prefill-cache-invisible\]\], `archima-vm-forensics-access`. Mediciones que lo motivan: `mediciones.md`.
