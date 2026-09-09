# Tests con agente en vivo (Lane B)

El suite de CI (olas 1-6) es 100% **hermético**: store `:memory:`, transporte real o fakeado, pero **nunca** servicios vivos, tokens reales ni modelo real. Eso deja un hueco que ningún unit/e2e hermético puede cubrir:  *¿el sistemaCOMPLETO, conectado de verdad, hace lo que tiene que hacer de punta a punta?*

Esta nota es ese otro carril: un **agente LLM (como Claude Code) maneja elsistema real por sus superficies reales** y juzga el resultado. Es el "sí" a la pregunta que quedó abierta:  *¿usamos tu Telegram? ¿tu Chrome? ¿un haiku real?*

## En qué se diferencia del CI

|              | Lane A (CI, olas 1-6)       | Lane B (esta nota)                            |
| ------------ | --------------------------- | --------------------------------------------- |
| Modelo       | fakeado (`FakeRelay`)       | **MA real** (haiku, sesión viva)              |
| Telegram     | `fakeThread()`              | **Telegram MCP**, cuenta real                 |
| Web          | hooks en jsdom              | **Chrome DevTools MCP**, browser real         |
| Store        | `:memory:`                  | DB real de un **entorno de staging**          |
| Determinismo | total                       | semántico (el agente juzga)                   |
| Dónde corre  | cada push, gratis, segundos | on-demand / scheduled, cuesta tokens, minutos |
| Qué valida   | el cableado interno         | que las **piezas reales encajan**             |

No reemplaza al CI: lo complementa. El CI prueba la lógica; esto prueba la integración con el mundo (entrega real de Telegram, render real del browser, turno real del modelo, consentimiento OAuth real).

## Quién lo corre

Un agente Claude Code (yo) con estas tools MCP ya conectadas a la sesión:

- `**mcp__telegram__\***`  — manejar una cuenta de Telegram (enviar al bot, leer la respuesta, descargar media, transcribir voice). Driver del canal Telegram.
- `**mcp__chrome-devtools__\***`  — navegar la web app, llenar el login, mandar un mensaje, leer el SSE, sacar screenshot, leer la consola/red. Driver del canal web.
- El resto de superficies (CLI socket) se manejan por Bash directo.

El agente no "corre asserts": **observa y juzga** (¿la respuesta tiene sentido? ¿el render es correcto? ¿llegó el push?). Para resultados parseables, structured output con un veredicto `{paso, ok, evidencia}`.

## Contra qué corre — CRÍTICO

- **NUNCA contra la sesión viva del owner.**  Los turnos concurrentes colisionan (contexto per-usuario). Regla dura ya anotada: no testear la sesión del dueño mientras la usa.
- Correr contra un **entorno de staging/efímero**: un usuario de prueba dedicado, su propia wiki de prueba, idealmente su propia box (o al menos su propio `agent_name`/sesión, separado del owner <telegram-id>).
- Telegram: lo ideal es un **bot/cuenta de prueba** distinto del personal. Si se usa la cuenta del owner vía MCP, restringir a DMs con el bot de staging y NUNCA tocar la sesión de prod.
- Presupuesto: haiku, turnos cortos, tope de gasto por corrida. Es dinero real.

## Escenarios candidatos

Cada uno ejercita una costura que el hermético sólo puede fakear:

- **Telegram ida y vuelta**: mando "hola" al bot por Telegram MCP → el MA real responde → leo la respuesta → juzgo que es coherente. Valida ingreso real + turno real + entrega real.
- **Web login + chat**: Chrome abre la app → login por magic-link → mando un mensaje → leo el stream SSE en vivo → screenshot. Valida el front real + SSE + turno.
- **Multimodal**: mando una imagen/voice por Telegram → el agente la procesa → respuesta coherente. (El CI no puede: PDF/imagen por MCP tiene shapes que sólo el real revela.)
- **Comando real**: `/voice`, `/wiki`, `/model` por el canal real → efecto observable (responde en voz, cambia de wiki).
- **OAuth consent real** (opcional, frágil): el flujo de conexión Google de punta a punta con consentimiento real — alto valor, alto costo de setup.
- **Edición de wiki**: el agente pide una nota, edita, y se verifica que el cambio aparece (working-copy + sync).

## Forma de la corrida

- Un **runbook** que el agente sigue paso a paso (no un script rígido: el agente adapta). Cada paso = acción por MCP + observación + veredicto.
- Reporte final: tabla de pasos con ok/fallo + evidencia (screenshot, texto recibido, ids). Si algo falla, el agente diagnostica (logs de la box, consola del browser, red).
- Disparo: manual ("corré el smoke en vivo") o **cron** (ej. diario contra staging), no en el push.

## Decisiones abiertas

- ¿Entorno dedicado de staging o usuario-de-prueba sobre prod aislado? (preferir el primero por la regla de no tocar la sesión del owner).
- ¿Cuenta/bot de Telegram de prueba propio? (sí, idealmente).
- Tope de gasto y modelo (haiku) por corrida.
- Formato del veredicto estructurado para hacer las corridas comparables en el tiempo.

## Tareas

- [ ] Definir el entorno destino (staging vs usuario-de-prueba aislado)
- [ ] Conseguir bot/cuenta de Telegram de prueba
- [ ] Escribir el runbook v1 (Telegram ida-y-vuelta + web login+chat)
- [ ] Definir el formato del reporte/veredicto
- [ ] Primera corrida manual + ajustes
- [ ] Evaluar disparo por cron contra staging
