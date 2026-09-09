# tareas — plan de ejecución

> Plan por fases. Diseño y racional: `spec.md`. Arrancado 2026-07-16 con las decisiones cerradas (cuerpo=nota, subtareas=filas, recurrencia propia). Todo el feature es **aditivo**: no hay migración de datos, no hay downtime, no hay cutover. Rollback de cualquier fase = revertir el PR (y `DROP TABLE items, item_views` si hiciera falta, que no borra ninguna nota). (act. 2026-07-17: F1–F4 implementadas; F4 sin el prompt de deploy)

## Estado (2026-07-17)

**Todo consolidado en una rama:**  #722 `feat/tareas` → `dev` (draft). La pila apilada #718→#719→#720→#721 se cerró a favor de esta — un solo PR de revisión. El feature se sigue construyendo commiteando sobre `feat/tareas`.

| Fase                                                     | Estado                        |
| -------------------------------------------------------- | ----------------------------- |
| F1 store (`items`+`item_views`)                          | ✅                             |
| F2 overlay de lectura                                    | ✅                             |
| F3 captura + reconciliación + editor                     | ✅ (primera pieza visible)     |
| F4/1 fechas relativas                                    | ✅                             |
| F4/2 tools `taskview_*` \+ vocabulario                   | ✅ (falta el prompt de deploy) |
| F5 recurrencia · F6 otros canales · F7 aviso · migración | pendiente                     |

⚠️ Sin mergear a `dev` todavía. Lo más caro de cambiar es el **esquema** (`store/items.ts`); si el owner quiere algo distinto, mejor antes de F5.

## Principio de orden

Cada fase deja el sistema **andando y verificable a mano**, y ninguna rompe la anterior. El orden lo manda una sola pregunta:  *¿cuál es la primera cosa que el owner puede VER?* Por eso el overlay de lectura (F2) va antes que la captura (F3) y mucho antes que la IA (F4): una vista que muestra tareas reales, aunque las tareas se hayan cargado a mano por SQL, ya prueba el 80% del diseño.

## ⚠️ El invariante que gobierna todo: el overlay NUNCA va dentro de `content`

**Este plan decía, en su primera versión, "appendear las secciones renderizadas al**\*\*`content`\*\* **". Estaba mal y hay que dejar escrito por qué**, porque es la trampa más cara del feature y cualquiera que lo retome la va a pisar:

> El editor autoguarda con debounce de 2.5s y devuelve `prefix + body` al PUT (`Editor.tsx:546-552`). Un overlay dentro de `content` **se escribiría dentro de lanota**: cada tilde de un checkbox sería un `note_version`, la historia de la nota se volvería ruido de tildar cosas, y el overlay quedaría como texto permanente. Es exactamente lo que la spec prohíbe.

⇒ El overlay viaja **como campo aparte** (`{ content, sha, path, overlay }`) y se dibuja en un **editor aparte**. La nota guarda tu prosa y nada más.

## F1 — Store: `items` + `item_views` (downtime: 0 · aditivo) ✅

- [x] Schema `items` (subtareas por `parent_id`, cuerpo por `note_id`, plantillas por `is_template`/`recur_expr`/`next_fire`/`template_id`) + `item_views`.
- [x] Primitivas CRUD + vistas (`get`/`put`/`delete`/`moveItemViews`) + recurrencia (`listTemplatesDue`/`openInstanceOf`/`materializeTemplate`/`listTemplates`).
- [x] `filterSql`: `ItemFilter` → SQL. Tests + mutación (escape de LIKE / no-apilar).

## F2 — Overlay de lectura: la vista se VE (downtime: 0) ✅

- [x] `store/src/items-view.ts`: render puro ítems → markdown, junto a `items.ts` porque el render y el parseo (F3) tienen que **round-trippear**: separados, divergen.
- [x] `renderOverlayWithIds`: el markdown y el binding salen del **mismo recorrido**. Un render por un lado y un mapeo de ids por otro sería la id de la línea 7 apuntando al ítem de la 8 — tildás una tarea y se tilda otra.
- [x] Enganche en el GET de `/api/file`, **después** del `if` de `NOTES_WRITE_MODE`: se ve igual en modo DB y git. Nunca tira: si el render falla, la nota abre sin overlay.
- [x] e2e en **ambas** ramas. Mutación: mezclar el overlay dentro de `content` mata el test.

### Decisiones de render que quedaron clavadas (cada una es un bug evitado)

| Decisión                                                       | Si no                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Espacio después de `]`                                         | El parser GFM exige `/^\[[ xX]\][ \t]/` para emitir `TaskMarker` → sin él **no hay checkbox** (el bug de `checklab.tsx`) |
| Cada ítem cae en **una sola** sección (la primera que matchea) | Tildarlo de un lado deja la otra copia sin tildar                                                                        |
| Las secciones **vacías** se emiten igual                       | Es dónde vas a escribir el próximo ítem — y de dónde F3 saca los atributos que hereda lo nuevo                           |
| Los huérfanos del filtro caen en `## Otras`                    | La falla peor de una vista es **tragarse** un ítem que escribiste                                                        |
| Las subtareas NO se filtran por status                         | Un padre abierto muestra sus subtareas hechas: el progreso 1/2 **es** el dato                                            |
| `mergeFilters` = shallow, la sección pisa a la vista           | La vista dice "de qué carpeta", la sección "cuál de esos"                                                                |
| `normalizeTitle` al escribir, no al mostrar                    | Un título con `\n` partiría el ítem en dos al guardar                                                                    |

## F3 — Captura y reconciliación: la vista se ESCRIBE (downtime: 0) ✅

Primera pieza VISIBLE: la nota-vista muestra sus tareas, se tildan, se editan y se escriben nuevas.

### La decisión de arquitectura: DOS editores, no uno

El overlay **no** vive en el documento CodeMirror de la nota. `Editor.tsx` hace, en cada tecla: `saveDraft(prefix+value)`→IndexedDB · `baseContentRef = full`→base del merge3 del 409 · `withTrailingNewline(prefix+body)`→el PUT · `applyExternalToView`→cambios de afuera. Los **cinco** asumen `doc == contenido de la nota`. Meterlo adentro lo metería en los drafts del usuario y haría que merge3 mergee líneas de tareas contra prosa cuando REM toca la nota. No es "más difícil": es contaminar cinco cosas que hoy andan.

Y este editor **no necesita nada de eso**: la DB ya es la verdad. Sin draft, sin merge3, sin sha (la concurrencia va por `renderedIds`). Toda esa maquinaria protege texto que sólo vive en tu browser; el overlay nunca está en esa situación.

- [x] `items-parse.ts`: el parser, mitad "leer" del par que round-trippea con el render. Se traga lo escrito a mano (`-`/`*`/`+`, encabezados, 2/4 espacios o tabs, marcadores).
- [x] `reconcileOverlay`: la tabla de la spec. Transaccional (test con trigger que aborta).
- [x] `**renderedIds**` — la trampa que cuesta datos: reconciliar contra "lo que el filtro trae AHORA" archivaría el ítem que anotaste por WhatsApp después del render. Sólo se archiva lo que **este cliente vio**. Verificado por mutación.
- [x] `POST /api/items/overlay`: endpoint propio (dos escrituras a dos lugares, `items` vs `notes`). Devuelve el estado canónico (overlay + ids) para cerrar el lazo en un viaje.
- [x] `overlayIds.ts` (molde `blame.ts`): las ids **no están en el texto** — son posiciones que CM6 remapea. Ancladas **dentro** de la línea, no al inicio.
- [x] **La tarea duplicada por tipear rápido**: escribís `- [​ ] a`, el autosave dispara, el server crea el ítem 42, pero seguiste tipeando. Sin atar esa id a tu línea, el próximo save la crea de nuevo (ítem 43). Fix: la respuesta trae `createdByLine` y el cliente mapea la posición por los cambios desde entonces. Verificado por mutación.
- [x] Tests: 13 headless de CM6 + e2e del endpoint. Invariante en dos niveles: tildar deja **0** `**note_versions**` y el contenido intacto.

**Consecuencia conocida, no escondida:**  las líneas que no son ítem ni encabezado se ignoran ⇒ prosa suelta tipeada entre las tareas no sobrevive al refresh. Inherente a que el overlay no se persista. La prosa vive arriba, en la nota.

## F4 — Compilar el filtro (la única IA del lazo) (downtime: 0)

### F4/1 — Fechas relativas ✅

`dueBefore`/`dueAfter` aceptan tokens (`now`, `today`, `±N(h|d|w)`) resueltos **alconsultar**, respetando la zona horaria (en GMT-3 "hoy" arranca a las 03:00 UTC). Sin esto, una vista "tareas de hoy" se congelaría el día que la compiló la IA. `now`/`tz` inyectables ⇒ testeable sin reloj. Bug latente arreglado: un ítem nuevo bajo sección con fecha guardaba el token literal en `due`; ahora guarda el `now` resuelto.

- [x] **tz-naive**: el endpoint todavía no pasa la tz del usuario (usa UTC). El token igual se resuelve fresco; sólo el corte del día es UTC. Cablear la tz real = follow-up.

### F4/2 — Tools `taskview_*` \+ vocabulario ✅

Viven en el MCP `notes` (no un server nuevo): las task-views son POR NOTA y ese server ya tiene auth per-uid, listener, nginx y el allow `"notes*"`. Van SIEMPRE montadas (item\_views no depende de `NOTES_WRITE_MODE`).

- [x] `taskvocab`: carpetas y tags REALES del usuario (con conteo) — aterriza la compilación para que el modelo no invente `folder: "trabajo"` cuando vivís en `laburo`.
- [x] `taskview_set`: valida el filtro compilado, lo asocia a la nota (sin tocar su prosa) y devuelve un PREVIEW del overlay; preview vacío avisa "¿el folder/tag existe?".
- [x] `taskview_get` / `taskview_clear`: leer la vista actual y volver la nota normal.
- [x] `parseItemView` (store): valida y devuelve el error COMO DATO (el modelo lo corrige).
- [x] Tests: validación, vocabulario, scoping (ana no toca la nota de beto).

### Pendiente de F4 (toca deploy — NO se corre desde una sesión de código)

- [ ] **Prompt del coordinador**: enseñarle el gesto "armame una vista de tareas acá" (cuándo llamar `taskvocab` → `taskview_set`, cómo leer el preview). Va en `coordinator-archima.md` / `adapter-archima.md`.
- [ ] `pnpm --filter @ceibo/gateway publish-agent` tras setear el prompt. Las TOOLS aparecen solas al reiniciar el gateway (el MCP las lista); el PROMPT necesita el publish.
- [ ] Decidir el gesto de **recompilación** (menor abierta de la spec): ¿sección nueva? ¿descripción editada? ¿explícito?
- [ ] Verificación en vivo: describir una vista en prosa y que traiga lo que corresponde.

## F5 — Recurrencia: el barrido determinista (downtime: 0)

- [ ] Barrido en el tick del scheduler del gateway (donde ya vive `fireDueCrons`, `engine.ts:2541`): `listTemplatesDue(db, now)` → `materializeTemplate(db, t, now, nextFireFrom(t.recur_expr, t.tz, now))`. **Sin IA y sin canal** — termina en un INSERT, no en un prompt. La lógica ya está en `store`: falta llamarla.
- [ ] UI/gesto para crear una plantilla (o por tool del agente).
- [ ] Verificación: plantilla diaria, no tildarla, confirmar que **no apila**.

## F6 — Captura desde otros canales (downtime: 0)

- [ ] Tools de ítems para el agente (crear/listar/tildar) — así "che, anotá que tengo que comprar leche" por WhatsApp crea la fila, y aparece en la vista al abrir la web.

## F7 — Aviso (opcional, independiente de F5)

- [ ] Tarea con `due` que notifica ⇒ crea un **cron** (que sí tiene canal y prosa).
- [ ] Resolver `inbox.kind`: el CHECK es `('cron','rem','system','viewer')` y SQLite no altera un CHECK ⇒ o se rebuildea la tabla, o se reusa `'cron'`.

## Migración de lo que ya existe

No es una migración de datos (no hay tabla vieja): es **importar dos notas escritas a mano**.

- [ ] `tecnico/tareas-ceibo.md` y `memu/tareas-memu.md` → filas de `items`, parseando lo que ya codifican por posición. El parser de F3 ya lo hace; falta el comando que lo corra y asocie la vista.
- [ ] Es el test de aceptación real: si el parser no puede con esas dos notas, el diseño no sirve.

## Riesgos

- **El editor es un wrapper de terceros parcheado** (`@atomic-editor/editor@0.4.3` + `patches/`). F3 lo resolvió con el molde de `blame.ts`. Gotcha: tocar `patches/` exige `pnpm install` en la box.
- **Bug de TaskMarker** (`checklab.tsx`): el parser GFM no emite `TaskMarker` sin espacio después de `]`. Cubierto por test — pero si alguien "limpia" el render, vuelve.
- **Dos ramas DB/git** en el GET y el PUT: un hook en una sola rama = comportamiento distinto por entorno.
- **Notas chicas del** `**note_id**`: costo elegido en la decisión 1. Si contaminan la búsqueda, se mitiga con una condición en el indexer.
- **Recompilación implícita**: si la IA recompila el filtro cuando no querías, la vista cambia sola. Por eso el gesto se decide explícito.
