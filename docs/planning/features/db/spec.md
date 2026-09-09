# db — notas sobre DB en vez de git+VMs (estudio)

> Estudio de arquitectura (2026-07-10, sesión con el agente dev). Pregunta original: ¿una DB con buen control de acceso en vez de repos git y VMs daría más performance con los mismos features? Estado: **recomendación**, sin decisión del owner todavía. Ejecución: `plan.md` — feature combinada con búsqueda semántica (absorbió al ex-feature `embeddings`). Alcance ampliado 2026-07-11: MA afuera (se borra, no se usa), Movida C entra al plan (Hermes multitenant en archi, turnos stateless, F5–F7).

## TL;DR

- **Performance no es el argumento; corrección sí.**  Los cuellos medidos (prefill vLLM, reconcile MCP) no viven en el storage. Lo que la DB elimina **por construcción** es la clase entera de bugs de estado distribuido: drafts vs server vs working tree, banners de conflicto, `baseSha===serverSha`, autosync.
- **Ceibo no necesita bash** — verificado en código (abajo). Todo el bash existente sirve a una sola cosa: que las notas sean archivos en un repo git (sync + ediciones batch).
- **No es "otro sistema"** : `store` ya es SQLite; git es el storage de UN subsistema. De `@ceibo/wikis` dependen 3 paquetes (cli, gateway, web-server). El engine, channels, speech, MCPs, vault y web de chat no se enteran.
- Recomendación: **migrar en dos movidas, con SQLite, sin tocar las VMs todavía.**

## Auditoría de bash (verificado 2026-07-10)

| Dónde                              | Qué tiene                                | Para qué se usa                                                                                                                                                       |
| ---------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agente MA (cloud)                  | agent toolset completo (bash/write/edit) | SOLO editar la working copy de la wiki + `wiki-sync.mjs push`. Se habilitó en Fase 2c para eso; antes write/edit estaban apagados (`packages/oauth/src/index.ts:336`) |
| Agente archima (primario)          | `**"\*": "deny"**` — sin bash/write/edit | Ya es tool-only en prod: read/grep/glob/list + MCPs tipados (`opencode-delegv2.json`)                                                                                 |
| `ceibo-worker` (subagente archima) | `"*": "allow"`                           | `git -C ~/work/<wiki>` pull/push + ediciones masivas con un script (`worker-archima.md`)                                                                              |
| `control` MCP                      | no es shell                              | comandos de la app tipados (`/model`, `connect_service`) vía `runCommandForUser`                                                                                      |
| REM                                | GitHub MCP (4 tools de archivo)          | escribir la wiki, sin shell                                                                                                                                           |

Conclusión: el bash es **costo inducido por el storage git**, no una capacidad del producto. Ninguna feature (de usuario ni interna) es "ejecutar código" en sí misma. La única capacidad a reponer en mundo-DB: **ediciones batch** del worker → tool `note_batch` tipada (cubre regex/rename/move en volumen); sandbox efímero solo si algún día una transformación no la expresa. Decisión chica y diferible.

## VMs: la DB no las reemplaza — pero las achica

RLS/permisos aíslan **datos**; la VM aísla **cómputo**. Son ortogonales. La pregunta real no es "¿VMs sí o no?" sino "¿qué usuarios necesitan code-exec?" → con notas en DB: casi ninguno (el grueso del valor es tool-driven). Además hoy las VMs son *dueñas deestado* (checkout de wiki, sesión) — por eso son mascotas persistentes caras de operar. Estado en DB ⇒ el cómputo puede volverse efímero o compartido:

- **tool-only** (la mayoría): harness compartido con identidad por-uid (patrón <cliente>). Mata además el cold-open de la VM.
- **code-exec** (owner, agente dev): sandbox efímero por sesión/tarea, no VM persistente.

Ojo contaminación cruzada en cómputo compartido: la colisión de perfiles gmail en el agent-vault fue exactamente un bug de identidad mal ruteada. Con VMs esa clase es estructuralmente más difícil. Por eso el cómputo va **último** y con análisis propio.

## Recomendación

### 1\. Motor: SQLite primero, no Postgres

`store` ya es better-sqlite3; una box, un archivo, backup trivial. Notas = tablas nuevas en la misma DB: `notes`, `note_versions` (historia), **FTS5** (búsqueda full-text — hoy es grep; esto solo ya es feature nueva). El control de acceso ya lo media gateway/web-server; RLS a nivel motor importa cuando terceros hablan SQL directo (caso <cliente>/Directus), no acá. Detrás del contrato de tools, cambiar de motor después es la parte fácil.

### 2\. Secuencia: contrato → storage → cómputo

- **Movida A — contrato de notas.**  Tools tipadas que expresen TODO lo que hoy hacen editor, agente y REM: `note_read / note_write(version) / note_list / note_search / note_batch(spec)`. Embrión ya existe (`control_note_search/snippet`). `note_write` con versión esperada (optimistic concurrency) ⇒ el save del editor es un UPDATE con check de versión y la saga draft/sha/banners **se borra en vez de migrarse**.
- **Movida B — DB fuente de verdad + espejo git de UNA vía.**  Editor, agente (MA y archima) y REM escriben vía contrato. Export unidireccional DB→git: diffs/historia navegable, backup off-box, y cero reconciliación (de una vía no hay conflictos). Red de seguridad que hace la migración reversible.
- **Movida C — cómputo (después, y solo si rinde).**  Recién acá tocar VMs (ver arriba). Dividendo separado, no empaquetar con la migración de notas.

### ¿Y el historial? — no se pierde, cambia de dueño

Hoy el historial es git (gratis: log, diff, blame). En mundo-DB queda cubierto por **dos capas complementarias**:

- `**note_versions**`: cada `note_write` guarda la versión anterior (fila nueva: contenido, autor, timestamp). Es EL historial canónico — consultable por tool/UI ("mostrame cómo era esta nota hace un mes", rollback). Trivial de implementar; lo que hay que construir es la UI/tools de diff si se quieren (hoy tampoco hay UI de historia en el editor — se mira con git a mano).
- **El espejo git de una vía**: el export DB→git puede pushear al MISMO repo actual ⇒ el historial git existente **continúa sin cortarse** — log/diff/blame siguen funcionando como siempre para lectura. Lo único que cambia: los commits los hace el exporter (autoría real va en `note_versions`), y el repo es read-only.

O sea: no solo no se pierde — el historial pre-migración queda intacto en el repo, y el post-migración existe en ambos lados. Granularidad: git agrupaba por commit/push; `note_versions` versiona **cada save** (más fino; con debounce si hace ruido).

### 3\. Dónde se siente la performance

- **Cold-open**: desaparece el hydrate de wiki-sync en sesiones MA; primera lectura = SELECT.
- **Save del editor**: de draft+commit+push+reconcile a un UPDATE (ms, sin reintentos).
- **Búsqueda**: FTS5 indexado vs grep; el agente gasta menos turnos navegando archivos.
- El prefill de vLLM **no se mueve** — ese cuello es aparte (ver quickboot).

### Qué NO hacer

- Big-bang de las 3 movidas juntas — cada una deja el sistema andando y se valida sola.
- Postgres/Directus "porque <cliente>" — la convergencia es el *patrón* (fuente de verdad transaccional + identidad por tool-call), no el motor.
- Matar el espejo git el día 1 — barato y compra historia+backup+salida de emergencia. (Ojo: una vía ⇒ los flujos que hoy ESCRIBEN por git — p.ej. el agente dev editando el wiki desde su sesión — pasan a necesitar la tool/CLI.)

## Tentáculos a tocar (costo honesto de la movida B)

`packages/wikis` (GitHub App, plano repos) · `wiki-sync.mjs` \+ flujo git del worker · prompts que lo enseñan (`adapter-ma.md`, `worker-archima.md`, `core.md`) · capa drafts/sync del editor web (draftStore, saveRetry — se borra, no se migra) · config de REM. Interacción con **decay**: el metadata in-file (frontmatter `accessed`/`reads`) pasa a ser columnas — más simple, pero re-plantea los productores de bumps.

## Próximo paso

Escribir el **contrato de notas** contra los casos de uso reales (editor, chat, REM, batch del worker, sharing multi-wiki). Documento corto; ahí aparecen las sorpresas baratas. Si el contrato cierra, el resto es plomería.
