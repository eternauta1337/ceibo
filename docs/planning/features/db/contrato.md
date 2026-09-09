# Contrato de notas (F0) — borrador para revisar

> Deriva de `plan.md` F0. Escrito contra la superficie REAL del código (relevada 2026-07-11, paths y líneas abajo). Estado: **borrador, falta OK del owner**.

## Principio

Una tool por operación que hoy existe, con **versión entera por nota** en lugar de blob sha. El contrato es la superficie completa: si una operación no está acá, no existe en mundo-DB (y eso es una decisión, no un olvido).

## Modelo de datos

- **Wiki = repo actual.**  `users`/`repos`/`repo_access` NO cambian — el multi-wiki, el sharing N:N con roles y las invitaciones ya viven en el store (`repo_access`, `store/src/index.ts:394`) y son ortogonales a dónde vive el contenido.
- `**notes**`: `id` estable (sobrevive renames — la historia no se corta), `wiki_id`, `path` (UNIQUE por wiki, sigue siendo la clave humana), `content`, `version` (entero monotónico), `emoji` (muere el sidecar `.ceibo/emojis.json`), `archived_at` (muere el manifest `.archived.md`), `accessed_at`/`read_count` (columnas listas para decay — feature en diseño, hoy SIN código; el bump es gratis en `note_read`).
- `**note_versions**`: `(note_id, version, content, author_uid, source 'web'|'agent'|'rem'|'batch'|'import', op, at)`. Historial canónico: cubre historia, `recall`, y es la fuente del blame y del espejo git.
- `note_chunks` (vectores) + FTS5: derivados del write (F1/F3), no parte del contrato.

## Tools

| Tool                              | Firma (esencia)                                                                                                                                                                                         | Reemplaza a                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `note_read`                       | `(wiki, path) → {content, version, emoji, archived}`                                                                                                                                                    | GET `/api/file` · `getFile` · `read` del agente            |
| `note_write`                      | `(wiki, path, content, expected_version) → {version}` ó **CONFLICT** `**{current_content, current_version}**`                                                                                           | PUT `/api/file` + `putFile(baseSha)` · 409                 |
| `note_create`                     | `(wiki, path, content?) → {version:1}` — EXISTS si ya está                                                                                                                                              | POST `/api/file` · `createFile`                            |
| `note_delete`                     | `(wiki, path, expected_version)`                                                                                                                                                                        | DELETE `/api/file` · `deleteFile`                          |
| `note_move`                       | `(from_wiki, from, to_wiki, to, expected_version, new_content?)` — intra-wiki conserva `note_id` (historia sigue)                                                                                       | POST `/api/file/move` · `moveFile` (incl. cross-wiki)      |
| `note_list`                       | `(wiki) → [{path, emoji, archived, updated_at}]`                                                                                                                                                        | GET `/api/explorer` · `listFiles` · `glob/list` del agente |
| `note_search`                     | `(wikis[], q, mode: lexical\|semantic\ — hybrid, k, include_archived?) → [{path, snippet, score}]` — `grep` del agente · `searchArchived`                                                               |                                                            |
| `note_batch`                      | `(wiki, changes:[{op: put\|delete\ — move, path, …, expected_version?}]) → ok \ — {conflict_paths}` — **atómico** (una transacción) — `POST /api/sync/commit` + `commit(Change[])` · scripts del worker |                                                            |
| `note_history`                    | `(wiki, path, limit) → [{version, author, at, op}]` (+ `note_read_version`)                                                                                                                             | `git log/diff` · `blame` · `recall`                        |
| `note_archive` / `note_unarchive` | `(wiki, path)` — flag reversible                                                                                                                                                                        | POST `/api/file/archive` \+ manifests                      |

Notas al contrato:

- **El CONFLICT devuelve el contenido actual** → el editor mantiene el rebase transparente (merge3 en el cliente, `Editor.tsx:436`) sin el GET extra ni la saga draft/baseSha. Misma UX, la mitad de las piezas.
- `**note_batch**` **ya existe en espíritu**: el substrato git tiene `commit(repo, baseRef, Change[])` con conflictos por-path (`substrate.ts:22`, `wikis/src/index.ts:191`) y el sync le pone límite de 30 MB "generoso para cambios masivos". El contrato conserva esa semántica cambiando sha→version. Los "cambios masivos con UN script" del worker (`worker-archima.md:40`) pasan a ser: el agente ARMA la lista de changes (leyendo con `note_search`/`note_read`) y la manda en UN `note_batch`.
- **Permisos**: cada tool recibe `uid` del chokepoint de identidad y valida contra `repo_access` (mismo gate que hoy hace `userRepoNames` en web.ts). Roles owner/member sin cambios; el contrato no inventa ACL nueva.
- **Emojis/label/invites/miembros**: quedan como endpoints web (no tools de agente) — hoy tampoco las toca el agente. Solo cambia su storage (columna vs sidecar).
- **Change feed**: cada write inserta en `wiki_changes` (semántica de `recordWikiChange`/`recordWikiEdit` con coalescing 180s intacta — los consumidores del feed no se enteran). `wiki_commit_sources`, watermarks y heads MUEREN (eran plomería del sync).
- **Blame**: v1 = historia por versión (`note_history`, autoría real por save — más fino que el blame git). El blame por-línea del editor (GET `/api/file/blame`) se reconstruye derivándolo de `note_versions` — mismo dato, sin GraphQL de GitHub.
- **Espejo git (F3)** : el exporter consume `note_versions` → commits al MISMO repo con `gitAuthorFor(handle)` como hasta ahora; materializa `.archived.md` y emojis-sidecar para que el repo siga legible. El espejo es efecto, no parte del contrato.

## Mapeo de consumidores (quién llama qué)

| Consumidor hoy                                                                                                      | En mundo-DB                                                                        |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Editor web (PUT/POST/DELETE `/api/file`, move, archive)                                                             | mismos endpoints, implementados sobre las tools (web-server llama al mismo módulo) |
| Explorer (GET `/api/explorer`)                                                                                      | `note_list`                                                                        |
| Agente archima (read/grep/glob + git del worker)                                                                    | `note_read`/`note_search`/`note_list` + `note_batch`; **muere** `**ceibo-worker**` |
| REM (toolset local + `wiki-sync.mjs push` — OJO: ya NO usa GitHub MCP, docstring viejo en `oauth/src/index.ts:355`) | `note_batch` (su commit único mapea 1:1) + `note_history`                          |
| `/api/sync/*` (Bearer HMAC server↔VM)                                                                               | **muere entero** — no hay working copy que sincronizar                             |
| Agente dev (edita wiki por git desde su sesión)                                                                     | CLI `./ceibo notes …` sobre las mismas tools                                       |

## Sorpresas del relevamiento (corrigen supuestos del plan)


1. **Decay no existe en código** — es spec en diseño (`features/decay/`). El contrato le deja columnas (`accessed_at`, `read_count`, `archived_at` reversible) y `note_versions` como tier frío equivalente a "la historia de git". Nada que migrar.
2. **REM ya no usa GitHub MCP** — usa working copy + wiki-sync como el worker. Simplifica F3: un solo patrón de escritura de agentes que migrar, no dos.
3. La superficie real incluye piezas que el plan no nombraba: **emojis** (sidecar), **archivado** (manifests + estado per-usuario de wikis), **recall/searchArchived**, **blame**, **move cross-wiki**, **change feed con coalescing**. Todas quedan cubiertas arriba — ninguna rompe el modelo.

## Abierto para el owner


1. ¿Blame por-línea se reconstruye en v1 o alcanza la historia por versión hasta que alguien lo pida? (recomiendo: historia por versión primero)
2. ¿`note_move` cross-wiki entra day-1 o v2? (hoy existe y el editor lo usa; recomiendo day-1, es un UPDATE de `wiki_id` \+ chequeo de permiso en destino)
3. OK general al contrato → F1 arranca (schema + sync git→DB derivado).
