# tareas — ítems en el store, notas como vista (spec)

> Spec (2026-07-16, sesión con el agente dev). Estado: **features y esquema CERRADOS,implementación arrancada**. Las tres decisiones que quedaban abiertas se cerraron el mismo día (cuerpo, subtareas, recurrencia) — ver "Decisiones cerradas". Ejecución: `plan.md`. Contexto: escrita DESPUÉS del cutover de `db` (2026-07-13, notas en DB, git desconectado) — este feature vive sobre ese mundo, no sobre archivos.

## TL;DR

- **La nota guarda la vista. El store guarda la verdad.**  El `.md` contiene solo una descripción en prosa de qué querés ver; la lista de ítems es un overlay vivo que se renderiza al leer y **nunca se persiste** en `notes.content`.
- **Tabla** `**items**` **genérica, un solo tipo implícito, sin** `**kind**` **.**  Lista de compras y backlog técnico son la misma cosa: ítems tildables con título y cuerpo opcional. Lo que los separa es **carpeta + vista**, no un tipo. `kind` se difiere hasta que un tipo pida *forma* propia (libro con rating, contacto con teléfono) — es un `ALTER TABLE`.
- `**tarea**`  **≠**  `**cron**`, y el reconocimiento del código lo confirmó más fuerte de lo esperado: `crons.what` es **prosa que se inyecta como prompt en el LLM** y exige un `channel` de egress. Un cron no sabe hacer un INSERT. ⇒ **recurrencia propia**.
- **La IA solo compila** descripción → filtro, cuando se lo pedís. Render, refresh, toggle, archivar y captura a mano son código determinista. Sin filtro, es una nota normal; con filtro, es una nota con vista.
- El caso a satisfacer ya existe y es real: `tareas-ceibo.md` — que entre sus pendientes tiene `- [​ ] Alguna forma de gestionar tareas`.

## El caso real (leer esto antes que el esquema)

`tecnico/tareas-ceibo.md` y `memu/tareas-memu.md` ya son, hoy, a mano, exactamente lo que este feature automatiza. Y ya codifican metadata **por posición y marcadores**, sin un solo `key: value`:

| Lo que hay escrito                                         | Qué está diciendo en realidad                |
| ---------------------------------------------------------- | -------------------------------------------- |
| `### WIP Backlog` / `### Pending` / `## Campaña usuario 1` | agrupamiento (la sección **es** el atributo) |
| `HIGH` / `MID` / `LOW` al principio del título             | prioridad                                    |
| `*Backend*` / `*Seguridad*` / `*Chores*` al final          | tag temático                                 |
| `*No UI*`                                                  | tag de alcance                               |
| sub-bullets bajo un ítem                                   | subtareas                                    |
| `- [​x]` vs `- [​ ]`                                       | estado                                       |

**Este es el diseño, no un accidente.**  El lugar donde escribís la tarea ES la metadata. La spec no inventa una sintaxis: adopta la que ya usás. Corolario duro: **nada de**\*\*`key:value`\*\* **ni bloques con DSL** — la descripción arriba de la nota es prosa, y el filtro compilado vive invisible en el store.

Nota de terreno: los ítems reales mezclan `-` y `*` como bullet y anidan subtareas. El parser tiene que tragarse ambos (GFM los trata igual) y las nested no puede perderlas.

## Modelo conceptual — tres piezas


1. `**items**` — la verdad. Una fila por pendiente, viva independientemente de qué nota la muestre. Un ítem puede aparecer en N vistas o en ninguna.
2. `**item_views**` — la asociación nota↔filtro. Qué ítems trae esa nota y cómo los agrupa. Es lo que convierte una nota común en una nota con vista.
3. **El overlay determinista** — el código que, al abrir la nota, corre el filtro, renderiza los ítems bajo sus secciones, y al guardar reconcilia lo que editaste contra la DB. No hay IA en este lazo.

## Por qué `items` y no `tasks`

La pregunta que la disparó:  *¿una lista de compras usa esto mismo?*  Sí, y la respuesta obliga a nombrar bien la tabla desde el día 1.

Hay **dos niveles de generalización** y solo uno se paga ahora:

- **Nivel 1 — carpetas + vistas (barato, entra ya).**  Compras, to-do, lista de lectura: todas son *ítems tildables con título y cuerpo opcional*. No difieren en forma, difieren en **dónde viven y cómo se agrupan**. Eso ya lo resuelven `folder` + `item_views` sin una línea de esquema extra. Un ítem de compras es una fila con `due=NULL` en la carpeta `compras`: **no dispara nada porque no tiene fecha, no porque sea otro tipo.**
- **Nivel 2 —**  `**kind**`  **(caro, se difiere).**  Solo se gana la vida cuando un tipo diverge en *forma*: un libro con rating y autor, un contacto con teléfono. Ahí `kind` deja de ser decoración y empieza a decidir columnas/validación/render. Hoy nada pide eso.

**Decisión: tabla** `**items**` **, un solo tipo implícito, sin columna** `**kind**` **.**  Agregarlo después es `ALTER TABLE items ADD COLUMN kind TEXT` con default — barato y reversible. Ponerlo antes es cargar con branching en filtros, render y captura para distinguir cosas que hoy se comportan idéntico. El nombre genérico se elige ahora porque **renombrar la tabladespués no es barato**; la columna sí.

**El acantilado de alcance, dicho en voz alta:**  el paso siguiente a `kind` es que el usuario defina sus propios esquemas y vistas por tipo. Eso es Notion/Airtable — un producto, no un feature. Si algún día se cruza, se cruza a propósito.

**Unificación notas↔ítems: río abajo, no ahora.**  Con `db` aterrizado, una nota ya es una fila. La tentación de que un ítem *sea* una nota (y viceversa) es real pero prematura: primero que `items` exista y se use.

## Decisiones cerradas (2026-07-16)

**1\. El cuerpo de la tarea = una nota real** (`note_id → notes.id`), no una columna `body`. Post-`db` una nota ya es una fila, así que el cuerpo gana versionado, historia, búsqueda (FTS + semántica) y el editor **gratis**, sin inventar nada. `note_id` es NULL en la enorme mayoría — "comprar leche" no crea ninguna nota; la nota nace recién cuando la tarea necesita cuerpo. `ON DELETE SET NULL`: borrar la nota **no** se lleva la tarea, sólo le saca el cuerpo. **Costo asumido, no escondido:**  la wiki se llena de notas chicas y aparecen en los resultados de búsqueda. Si molesta, se mitiga después (excluirlas del índice es una condición en el indexer, no un rediseño).

**2\. Subtareas = filas reales** (`parent_id`), no texto en el cuerpo. `tareas-ceibo.md` ya las usa anidadas de verdad, así que la alternativa (texto plano, invisible a la DB) rompía una nota que hoy funciona. Como filas se tildan, se filtran y se cuentan. La **indentación en la vista define el padre** — coherente con "el lugar donde la escribís ES la metadata". Costo: la reconciliación tiene que inferir el padre por indentación.

**3\. Recurrencia propia en** `**items**` **, NO un cron.**  Acá el reconocimiento del código **mató la propuesta original** ("un cron cuya acción es instanciar la plantilla") y la mejoró:

> `crons` **no tiene campo de acción**. `crons.what` es lenguaje natural que el scheduler inyecta como prompt sintético en la sesión del usuario (`gateway/src/engine.ts:3128`), y `channel` es NOT NULL. "Un cron que instancia una plantilla" significaría **pedirle aun LLM que haga un INSERT**, con un canal de entrega inventado. Nondeterminista, y en contra de la regla de que la IA solo compila filtros y REM.

Esto no rompió el diseño: lo **afiló**. `tarea ≠ cron` es más cierto de lo que pensábamos, y separa dos cosas que estaban pegadas:

|                  | Qué es                | Quién lo hace                                          |
| ---------------- | --------------------- | ------------------------------------------------------ |
| **Recurrencia**  | materializar una fila | barrido determinista sobre `items` — sin IA, sin canal |
| **Notificación** | mandarte un mensaje   | un **cron** — eso sí tiene canal y prosa               |

La plantilla es un ítem con `is_template=1` + `recur_expr` + `next_fire`; la instancia lleva `template_id`. **Recurrencia ≠ aviso**, y son opt-in por separado.

**La regla de no-apilar** (el detalle que decide si esto se usa o se abandona): si al disparar ya existe una instancia **abierta** de la plantilla, no se inserta una segunda — se le **corre el** `**due**` a la ocurrencia nueva. Sin esto, no tildar "sacar la basura" una semana te deja 7 filas idénticas: el modo de falla clásico de las tareas recurrentes. Vos querés UNA tarea con la fecha de hoy, no un cementerio.

**Menores, todavía abiertas:**  el gesto exacto que dispara la recompilación del filtro (¿sección nueva? ¿descripción editada?) y el formato de vistas sin secciones (planas).

## Esquema del store

Implementado en `packages/store/src/items.ts` (PR #718). Convención de nombre: `**repo**`, no `wiki` — para alinear con `notes`/`note_versions`; el MCP le dice "wiki" al usuario, el store le dice `repo`.

```sql
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder TEXT,                       -- 'compras' | 'ceibo/tecnico'; NULL = sin carpeta
  title TEXT NOT NULL,
  note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,  -- el cuerpo; NULL = sin cuerpo
  tags TEXT NOT NULL DEFAULT '[]',   -- JSON array
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','done','cancelled','archived')),
  due TEXT,                          -- ISO UTC; NULL = sin fecha (el caso compras)
  position INTEGER,                  -- orden dentro de su sección/padre
  parent_id INTEGER REFERENCES items(id) ON DELETE CASCADE,     -- subtarea de
  is_template INTEGER NOT NULL DEFAULT 0 CHECK (is_template IN (0,1)),
  recur_expr TEXT,                   -- cron-expr 5 campos; sólo plantillas
  tz TEXT NOT NULL DEFAULT 'UTC',
  next_fire TEXT,                    -- ISO UTC del próximo spawn; sólo plantillas
  template_id INTEGER REFERENCES items(id) ON DELETE SET NULL,  -- instancia → plantilla
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT,
  CHECK (is_template = 0 OR (recur_expr IS NOT NULL AND next_fire IS NOT NULL)),
  CHECK (is_template = 0 OR template_id IS NULL)
);

CREATE TABLE item_views (
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filter TEXT NOT NULL,              -- ItemFilter: qué ítems trae
  sections TEXT NOT NULL DEFAULT '[]', -- ItemSection[]: cómo agrupa (y qué hereda lo nuevo)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo, path, user_id)
);
```

`repo` en la PK porque el mundo post-`db` es multi-wiki y `path` solo no es único.

Detalles del filtro que ya son código y cuestan un bug si se pierden:

- `**tags**` **matchea por OR, no AND** — misma lección que el FTS5 de `db` (el AND daba 0% con paráfrasis). Una vista con dos tags tiene que traer los dos conjuntos.
- **El** `**LIKE**` **de subcarpetas escapa los comodines**: sin eso el folder `mi_carpeta` matchea `miXcarpeta`.
- **Las plantillas se excluyen SIEMPRE** de `listItems`: un molde no es un pendiente.
- **Toda mutación va acotada por** `**user_id**` **en el WHERE**, no con un chequeo previo — así no hay ventana entre verificar y escribir.
- Orden: `position` primero (lo que acomodaste a mano manda), después fecha, `id` como desempate **estable** — sin él la vista "tiembla" entre renders.

## La nota-vista

**Anatomía.**  Arriba, prosa tuya:  *"tareas técnicas de ceibo, agrupadas por backlog,features y bugs"* . Abajo, el overlay renderizado. La prosa es lo único que se guarda.

**Filtro bidireccional.**  El filtro no es solo lectura: define también **dónde caen losítems nuevos**. Si la vista filtra `folder=ceibo/tecnico` y escribís un ítem bajo `### Bugs`, la fila nace con `folder=ceibo/tecnico` y `tags=["bugs"]`. Escribir en la vista es escribir en la DB, sin ceremonia. (Es el `match` de cada `ItemSection`.)

**Sin filtro asociado, es una nota normal.**  Los checkboxes siguen renderizando como siempre (GFM). No hay migración forzada: una nota se vuelve vista el día que se lo pedís.

**La vista sigue a la nota** cuando la movés o renombrás (`moveItemViews`): sin eso, un rename convierte la vista en nota normal y creés que perdiste las tareas.

## El motor determinista

**Persistencia.**  El overlay **nunca** se escribe a `notes.content`. Si se escribiera, cada toggle de checkbox sería un `note_version` — el historial de la nota se convertiría en ruido de tildar cosas, y perderíamos la única propiedad que hace esto sano: la nota versiona **la vista**, los ítems versionan aparte.

**Identidad de línea.**  Cada línea renderizada lleva su `item.id` bindeado en el estado del editor (CodeMirror), **no en el texto**. Invisible, no copiable, no ensucia. La regla es de una línea:

- línea **con** id ⇒ ítem existente
- línea **sin** id ⇒ ítem nuevo

Hay **precedente exacto en el repo**: `packages/web/src/blame.ts` ya inyecta metadata invisible por línea desde afuera (`StateEffect` + `StateField<DecorationSet>` \+ un controller con `ViewPlugin`, porque el editor es un wrapper de terceros — `@atomic-editor/editor`, parcheado— que **no expone el** `**EditorView**`). El overlay copia ese molde; no hay que inventarlo. Ojo con el **prefijo H1 oculto** (`prefixRef` en `Editor.tsx`): el binding de líneas tiene que respetar ese offset, igual que lo hace blame.

**Reconciliación al guardar:**

| Lo que ve el código                   | Acción en la DB                                                         |
| ------------------------------------- | ----------------------------------------------------------------------- |
| Línea con id, checkbox `[x]`          | `status=done`, `done_at=now` por id                                     |
| Línea con id, texto cambiado          | update `title` por id                                                   |
| Línea con id, movida a otra sección   | re-asigna el atributo de esa sección (Backlog→Features = re-tag)        |
| Línea con id, reordenada              | update `position`                                                       |
| Línea con id, re-indentada            | update `parent_id` (la indentación define el padre)                     |
| Línea con id, desaparecida            | `status=archived` por id                                                |
| Línea **sin** id                      | **INSERT** — título literal, atributos = filtro base (folder) + sección |
| Línea sin id bajo sección desconocida | cambia la *estructura* ⇒ recompila (IA)                                 |

**Borrar de una vista = archivar**, no destruir. `status=archived` es recuperable; la cancelación real (`cancelled`) es explícita. Sacar algo de una vista es un gesto de limpieza, no de destrucción — y el costo de equivocarse tiene que ser cero.

**Frescura y concurrencia.**  El servidor es dueño del overlay. Si agregaste un ítem por WhatsApp y después entrás por web, el render trae lo nuevo. En un refresh, se re-renderizan los ítems de la DB **preservando las líneas nuevas sin guardar** que estés tipeando. La regla de merge: la DB gana sobre lo renderizado, vos ganás sobre lo que todavía no mandaste.

⚠️ **TOCTOU al reconciliar** (encontrado en el reconocimiento, no lo pisemos): `writeNote` valida `expected_version` **adentro** de su transacción (`notes-write.ts`). Si la reconciliación lee el estado previo *fuera* de esa transacción, se abre una ventana contra el check de versión. Tiene que caer dentro.

## Reparto: IA vs determinista

| Momento                                            | Quién                             |
| -------------------------------------------------- | --------------------------------- |
| Compilar descripción → `filter` + `sections`       | **IA**, y solo cuando se lo pedís |
| Abrir la nota / render del overlay                 | código                            |
| Refresh (ítems nuevos de otro canal)               | código                            |
| Toggle, editar título, reordenar, mover de sección | código                            |
| Captura a mano (línea nueva ⇒ INSERT)              | código                            |
| Archivar al borrar de la vista                     | código                            |
| Materializar una tarea recurrente                  | código (barrido determinista)     |
| Barridos/resúmenes periódicos                      | **IA** (REM)                      |

Dos lugares con IA: **compilar el filtro** y **REM**. Todo lo demás es determinista, y eso es lo que hace que la vista se sienta una app y no un chat. Corolario: si la IA está caída, las tareas siguen andando enteras — solo no podés crear vistas nuevas.

## Disparo y egress

Una tarea con `due` que tiene que avisarte no reimplementa scheduling: **crea un cron** cuya acción es notificar, y el cron entrega por los canales que ya existen (`crons-delivery`, tabla `inbox`). `items` no sabe entregar nada; `crons` no sabe qué es una tarea. Esto es **independiente de la recurrencia** (ver decisión 3): una tarea recurrente sin aviso no crea ningún cron.

Borde conocido: `inbox.kind` tiene `CHECK (kind IN ('cron','rem','system','viewer'))`. Un `kind` nuevo para avisos de tareas obliga a **rebuildear la tabla** (SQLite no altera un CHECK). Alternativa: reusar `'cron'`, que es lo que de hecho sería. Decisión de plomería para cuando se implemente el aviso.

## Multi-usuario

`user_id` en ambas tablas, scoping per-uid en el MCP como ya hace `notes` (el uid sale del token HMAC, **no de los args**). Una vista es de un usuario: la misma nota en una wiki compartida puede tener filtro por dueño. El test que importa es el que ya existe para notas: **userA jamás ve un ítem de userB**, con un caso adversarial explícito.

## Tentáculos a tocar

`store` (tablas nuevas; ya tiene `cron-parser`/`cronstrue` y `nextFireFrom` — no hay que inventar el cálculo de recurrencia) · MCP `notes` (`gateway/src/notes-mcp.ts`) o un `items` hermano — decisión de plomería · **web-server**: render del overlay en `/api/file` GET (`web.ts:3484` / `notes-file-ops.ts:dbReadFile`) + reconciliación en el PUT (`web.ts:1622` / `dbPutFile`). ⚠️ Ambos tienen **dos ramas** (DB y git) según `NOTES_WRITE_MODE`: un hook en una sola rama se comporta distinto según el entorno · **front**: binding de ids con el molde de `blame.ts`; ojo el bug de TaskMarker de `checklab.tsx` (pide espacio después de `]`) · `crons` para el aviso · prompts del coordinador para el gesto de "armame una vista".

## Próximo paso

Ver `plan.md`. El esquema está clavado y en PR; lo que sigue es el overlay de lectura, que es la primera cosa que se ve.
