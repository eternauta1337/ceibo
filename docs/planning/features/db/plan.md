# db — plan (sistema nuevo: notas en DB + búsqueda + Hermes multitenant en archi)

> Plan de ejecución completo, con downtime/migración/backups/rollback por fase. Diseño y racional: `spec.md`. Absorbe al ex-feature `embeddings` (borrado 2026-07-11). Ampliado 2026-07-11 tras la segunda ronda de estudio: **MA (nube) quedaAFUERA** (no se usa → se borra, no se migra), y la Movida C entra al plan como fases concretas (Hermes multitenant, todo-en-archi). (act. 2026-07-11)

## Arquitectura destino

```
archi (el fierro — 99% de los recursos = la GPU)
├─ vLLM (gemma4-31b, …) + modelo embeddings (Onyx)   ← lo único que pesa
├─ Hermes multitenant (1 proceso node, todos los usuarios)
├─ DB (SQLite: notas + versiones + vectores + conversaciones)
└─ cola de jobs (subagentes/delegaciones)

<hosting-provider> (opcional al final)
└─ ingress público (TLS, app.example.com) + réplica de backups — SIN cómputo
```

Principios que salieron del estudio (detalle en spec):

- **No hay sesiones vivas**: conversación = filas en DB; turno = request stateless (proceso levanta contexto → vLLM → escribe → muere). El clear diario pasa a ser una operación de datos.
- **Excepción de performance**: prefill warm vs cold = 0.2s vs 20s (275×) → la "sesión" sobrevive solo como **localidad de caché**: prefix caching de vLLM + afinidad de turnos consecutivos de una conversación. Un renglón, no una pieza.
- **Subagentes = jobs**: cola con N workers; su concurrencia es la misma cuenta de turnos contra vLLM. `ceibo-worker` muere (sus trabajos = `note_write`/`note_batch`).
- **Identidad multitenant**: UN chokepoint de inyección por-uid (`get_session_env`) para \~10 servicios. Es EL ítem duro de la Movida C (precedente: colisión del matcher gmail).
- **Techo de concurrencia** = vLLM (batchea; \~3–5 prefills simultáneos y las latencias se estiran). Todo lo demás es negligible.

## Datos del terreno (heredados de embeddings, verificados 2026-07-10)

- Modelo ya corriendo en archi (stack Onyx): `Alibaba-NLP/gte-multilingual-base`, **768 dim, normalizado** (cosine = dot). `POST http://<host>:9000/encoder/bi-encoder-embed` body `{ texts, model_name, text_type:"query"|"passage", max_context_length:512, normalize_embeddings:true }` → `{ embeddings:[[…768…]] }` (probado en vivo). Indexing server = GPU (backfill), inference = CPU (queries). Hoy sin puerto publicado (red docker `onyx_default`, IPs inestables). GPU a 95/98 GB: solo llamadas API, OK.
- Seams: fósil `control_note_search` denegado (`opencode-delegv2.json:121`, test `prompt-compose.test.ts:67`) · hook de commit con paths cambiados (`recordWikiChange` `store/src/index.ts:753`, `POST /api/sync/commit` `web-server/src/wiki-sync.ts:153`) · guía grep: `adapter-archima.md:41`, `worker-archima.md:34`.

## Fases

### F0 — Contrato + wiring (downtime: 0)

- [x] Contrato de notas **borrador** (2026-07-11): `contrato.md` — escrito contra la superficie real del código (relevamiento con líneas). **Falta OK delowner** (3 preguntas abiertas al final del doc). Sorpresas: decay NO existe en código (es spec en diseño → el contrato solo le deja columnas), REM ya no usa GitHub MCP, y la superficie real suma emojis/archivado/recall/blame/move cross-wiki — todo cubierto.
- [x] Publicar puerto Onyx + smoke string→768 floats (2026-07-11): override de compose en archi (`~/onyx_data/deployment/docker-compose.override.yml`) publica el inference server SOLO en tailscale → `**EMBED_URL=http://<tailnet-ip>:9000**`. Verificado desde la box: dim=768, norma=1.0; LAN no expuesta.
- [x] Confirmar red box→archi (2026-07-11): tailscale directo (archi=<tailnet-ip>).

### F1 — DB como índice derivado (downtime: 0 · rollback: DROP tablas)

> **Estado 2026-07-11: implementado, PR #699 → dev** (owner dio OK al contrato). Diseño que quedó: el sync NO se engancha a los call-sites — es un RECONCILIADOR en web-server que compara `wiki_heads` (ya mantenido por watcher + writes) vs `notes_index_meta`; backfill = meta ausente ⇒ snapshot completo; delta imposible ⇒ rebuild (self-healing). Chunker/embedder en `store` (hoja) porque el gateway (F2) los necesita para queries.

- [x] Schema en `store`: `notes` · `note_chunks` (BLOB f32) · FTS5 external-content · `notes_index_meta` (guard). (`store/src/notes-index.ts`)
- [x] Sync git→DB: reconciliador backfill + incremental (`web-server/src/notes-indexer.ts`).
- [x] Chunker + cliente `Embedder` (batch/retry, smoke en vivo contra archi OK) — `store/src/notes-embed.ts`. Backfill de vectores = el mismo loop (async, degrada a léxico si archi no responde).
- [x] Guard: `model_id` \+ head por wiki; mismatch de modelo ⇒ re-embed automático.
- [ ] Merge a dev (OK owner) → probar en dev → promoción normal dev→staging→main.

### F2 — `note_search`/`note_list`/`note_read` como MCP (downtime: 0)

> **Estado 2026-07-11: implementado, PR #700 → dev.**  Tools reales: `notes_search`/ `notes_read`/`notes_list` (server `notes`, opencode prefija — el "resucitar control\_note\_search" quedó superseded, los deny fósiles se borraron). Con test de no-contaminación (embedder adversarial apuntando a la nota privada de otro usuario).

- [x] MCP `notes` en el gateway in-process (patrón `control`, ident. per-uid, :8831).
- [x] Búsqueda léxica (FTS5) + semántica (mejor-chunk, coseno) + híbrida (RRF); degradación a léxica si `EMBED_URL` no responde.
- [x] archima: server montado + `"notes*": "allow"` \+ cred per-uid en prepareSession.
- [x] Prompts híbridos en adapter-archima (notes\_search primero, grep fallback) + test.
- [x] Runner `**eval:notes-recall**` (hit@k + MRR: grep vs léxica vs semántica vs híbrida, contra DB real). — **GATE de F3 pendiente de CORRERLO** con casos reales sobre la wiki del owner (necesita F1/F2 andando en dev + backfill hecho).
- [x] **GATE CORRIDO** (2026-07-11, 152 notas reales de <wiki-trabajo> embebidas contra archi, 16 queries de paráfrasis con ground truth, k=5):

| modo                   | hit@5   | MRR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| grep (baseline actual) | 31%     | 0.20                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| léxica FTS5 (OR)       | 56%     | 0.42                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| semántica              | 75%     | 0.50                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **híbrida**            | **69%** | **0.65** — La híbrida DUPLICA el hit-rate del grep actual y rankea mejor que todo (MRR). Hallazgo del gate: el AND implícito de FTS5 daba **0%** con paráfrasis → léxica pasada a OR (PR fix/notes-lexical-or). Veredicto: **F3 habilitada** en lo que a calidad de búsqueda respecta. (Casos: queries estilo-owner con ground truth armado por el agente dev; sumar queries del owner cuando pruebe en vivo.) **Caso en vivo del owner (staging, 2026-07-11)** : "template de pagos generales" —la búsqueda que siempre le fallaba— devuelve `ops/templates/Pagos mensuales generales.md` (<wiki-personal>) como PRIMER resultado con la híbrida real. |

- [x] **Deploy a staging** (2026-07-11, autorizado por owner): promoción #702 (sha `3ad5b5d`, verificada por contenido), envs `NOTES_MCP_*` (puerto 8833; prod reservará 8832) + location nginx `/mcp/notes/` en el block de staging. **Gotchade red**: la ACL de tailscale sólo deja a la box hablarle a archi por ssh → `EMBED_URL=http://127.0.0.1:19000` vía túnel ssh persistente (unit `ceibo-embed-tunnel`, key dedicada `restrict,port-forwarding,permitopen=` solo al puerto del bi-encoder). Indexer backfilleó las wikis reales del owner (228 notas, 6 wikis) apenas arrancó. Smoke del MCP por URL pública: OK.
- [x] **Confirmado por el owner EN VIVO** (staging): `notes_search` encontró su nota. El camino destapó dos trampas documentadas en memoria del agente dev: el deploy tiene DOS patas (`deploy-archima.sh` aparte de la box, + reiniciar opencode en las VMs) y el prompt vivo del coordinador es `coordinator-archima.md` (fix #703/#704).
- [ ] Deploy a prod: mismo checklist (envs con puerto 8832, nginx en el block de prod, reusa el túnel) — cuando el owner lo pida tras probar staging.

### F3 — Promoción: DB fuente de verdad (⚠️ ÚNICA ventana de downtime real)

- [x] `note_versions` + `note_write(expected_version)` + `note_batch` (**F3a, PR #705 →dev**, 2026-07-11): optimistic concurrency por versión entera, conflicto devuelve el estado actual (merge3 sin GET), batch atómico con conflictos por-path, historia con autor/origen + cursor `mirrored_at` para el espejo. Aditivo, sin consumidores aún (los escritores migran con flag en F3c).
- [x] Editor web: save = UPDATE transaccional (**F3c, PR #707 → dev**, flag `NOTES_WRITE_MODE=db`): sha del protocolo = versión opaca ⇒ CERO cambios de front (la saga draft/banners muere en la limpieza post-cutover, no acá). Read-your-writes en GET/explorer.
- [x] Agente archima y REM por tools: las tools de escritura del MCP están (write/ create/delete/move/batch, conflicto como dato, scoping per-uid) — la MIGRACIÓN del worker/REM y los prompts van en el cutover (coreografía sin cambios hasta ahí).
- [x] Reindex FTS transaccional con el write (triggers) + vectores async; el guard de F1 QUEDA como red de seguridad (upsert ahora conserva vectores si el contenido es idéntico → el roundtrip write→espejo→reconcile converge barato).
- [x] Espejo git **una vía** DB→GitHub, al MISMO repo (**F3b, PR #706 → dev**, 2026-07-11): cursor `mirrored_at` reintentable (nunca pierde un write), colapso por path, autoría real, move cross-wiki con rastro en ambos repos. Pre-cutover es no-op. (El "repo read-only" se materializa recién en el cutover.)
- [ ] Flujos que escribían por git (agente dev) → tool/CLI (`./ceibo notes …`).

**Ensayo en staging — HECHO 2026-07-13 (con las wikis REALES del owner):**  flag `NOTES_WRITE_MODE=db` prendido en staging; el owner editó por la web (create → edit → renombre → move a subcarpeta → borrado). Verificado en vivo: cada save dejó su `note_version` con autoría, el espejo git commiteó a su repo real **byte-idéntico** (0 mismatches, 0 versions sin espejar), los renombres se espejaron como put+delete, y el borrado por contrato sacó la nota de git. Nota de prueba limpiada; staging devuelto a `NOTES_WRITE_MODE=git`. **Aprendizaje operativo:**  staging y prod comparten los repos GitHub (`<wikis-org>`) → el modo db en staging escribe a los repos REALES; el ensayo se hizo con eso entendido. **Veredicto: F3c validado end-to-end; listo para la ventana decutover en prod cuando el owner la programe.**

**Cutover (ventana \~30–60 min, lecturas siguen andando):**


1. Congelar writes (web-server en read-only + aviso en editor; agentes siguen leyendo).
2. Import final git→DB + **verificación por contenido**: diff byte-a-byte DB vs HEAD de cada repo (mismo espíritu que `verify-prod.sh` — por contenido, no por sha declarado).
3. Flip de editor + agentes a tools; primer export del espejo; smoke (crear/editar/buscar).
4. Descongelar. **Rollback** (si el smoke falla): flip atrás a git-write — la working copy sigue intacta porque nada la tocó durante la ventana.

- [ ] Post-cutover 1 semana: diff diario espejo-git vs DB como verificación continua.

### ✅ CUTOVER PROD EJECUTADO — 2026-07-13

**Prod está en modo DB (fuente de verdad).**  Secuencia real ejecutada, autorizada por el owner ("todo ahora, incluida la ventana"):


1. Tooling nuevo: freeze por archivo (touch/rm, sin restart) + verify byte-a-byte (`cutover:verify`, exit 0 = flip seguro). PRs #709 (tooling), y el fix #712 abajo.
2. Deploy a prod (sha `65a7ca5`, verificado por contenido): F1+F2+F3 + envs `NOTES_MCP_*` (puerto 8832) + nginx `/mcp/notes/` \+ túnel de embeddings compartido (`ceibo-embed-tunnel`, `127.0.0.1:19000`) + runtime archima. Índice backfilleó las 21 wikis (270 notas).
3. **La ventana** (\~3 min, no 30-60): backup DB (`pre-cutover-*.db`) → freeze (writes 503, lecturas OK) → `cutover:verify` **LIMPIO en las 21 wikis, 0 diferencias** → flip `NOTES_WRITE_MODE=db` \+ restart → unfreeze → smoke (create/edit/read/delete + espejo round-trip + búsqueda) TODO OK.
4. Rollback disponible en todo momento (flip a git-mode; el espejo mantiene git al día).

**Pendientes post-cutover (NO bloqueantes, prod anda):**

- Embeddings de prod terminando de backfillear (\~60/270 al cierre de la ventana) → la búsqueda semántica mejora sola a medida que completan. La léxica ya cubre todo.
- **Bug del espejo encontrado y fixeado (#712)** : un create+delete de una nota antes de espejarla dejaba un `delete` de path inexistente en git → BadObjectState → cola de espejo trabada. Fix: filtrar deletes de paths que no están en git HEAD. Detectado por el smoke, desatascado a mano en prod, endurecido en código, y **fix deployado a prod (** #712→#**714, sha af7435e) y reproducido/confirmado en vivo**: create+delete rápido ya no traba la cola.
- El **agente (worker) sigue escribiendo por git** (converge vía reconciler; hueco de history en edits del agente). Migrarlo a `notes_batch` = follow-up que cierra el hueco.
- Verificación continua: diff diario espejo-git vs DB la primera semana.

### ✅ GIT DESCONECTADO + BACKUP OFF-BOX — 2026-07-13

**Prod: las notas viven SOLO en la DB; git desconectado del camino de notas.**  (owner: "sacar git del todo, sin espejo"). Hecho:


1. **Backup diario cifrado off-box** (reemplaza al espejo git, que era el único backup continuo — no existía snapshot todavía): unit `ceibo-db-backup.timer` (05:00 GMT-3): `sqlite3 .backup` → gzip → AES-256 (passphrase en `~/ceibo/secrets/db-backup.key` \+ en poder del owner) → sftp a archi (`ceibo-backups/`, key SFTP-only, retención 14). **Restore drill PASADO** (integridad ok, 270 notas == prod). Backup pre-cutover también guardado (`pre-cutover-*.db`).
2. **Agente por tools** (PR #715/#717): worker/coordinador/AGENTS.md reescritos — leen y escriben notas SOLO por `notes_*` (`notes_batch` para masivos), sin git/clones. **Validado EN VIVO en staging**: el agente creó una nota (`note_versions.source=agent`, git bloqueado + espejo off → única vía = las tools). Prod: prompts en las 8 VMs (`notes_batch`×3), opencode reiniciado.
3. **git push del agente bloqueado** en db-mode (`git-receive-pack` → 409 `git-disconnected`; clone/pull sigue). Verificado en prod.
4. **Espejo apagado** (`NOTES_MIRROR=0` en prod): git deja de recibir → **repos congeladoscomo archivo en el tiempo** (backup point-in-time). El reconciler idle (git no cambia).

**Backup posture nuevo:**  git congelado (point-in-time hasta 2026-07-13) + snapshot diario cifrado off-box en archi (RPO ≤24h) con restore drill probado. Nada pendiente.

### F4 — Limpieza (downtime: 0)

- [ ] **MA: borrar, no migrar** (no se usa): agent toolset, `adapter-ma.md`, wiki-sync hydrate, publish-agent de MA. El `notes` MCP queda con un solo cliente.
- [ ] Muere `ceibo-worker`; opcional apagar `read/grep/glob/list` (o scratch dir).
- [ ] `packages/wikis` fuera del camino caliente (queda solo el exporter del espejo).

### F5 — Capa de identidad multitenant (downtime: 0 — se construye al costado)

- [ ] Tool-clients por servicio (gmail/calendar/drive/sheets/notion/wacli/schedule/ viewer/control) con Bearer por-uid vía `get_session_env` — UN chokepoint de inyección, testeado con e2e de no-contaminación (userA jamás ve cred de userB).
- [ ] Conversaciones a la DB (mensajes/threads como filas) — reemplaza el session-state de opencode; el clear diario pasa a ser un WHERE.
- [ ] Cola de jobs para subagentes/delegaciones (N workers contra vLLM).

### F6 — Hermes multitenant en archi (downtime: 0 global — canary por usuario)

- [ ] Hermes en archi con turnos stateless + prefix caching/afinidad por conversación.
- [ ] **Cutover por-usuario** usando el backend-selector existente: owner primero (canary), después el resto. Cada flip = la conversación arranca fresca (aviso).
- [ ] **Rollback por-usuario**: flip atrás al backend VM — las VMs quedan DORMIDAS (no borradas) hasta el sunset.
- [ ] Sunset: tras N semanas estables, apagar VMs y retirar `archima-runtime`.

### F7 — Consolidación + decisión de ingress (downtime: minutos, programado)

- [ ] Mover DB + gateway/notes-MCP a archi (junto a Hermes): ventana de minutos — congelar writes, copiar SQLite (`.backup`), flip, verificar, descongelar.
- [ ] **Decisión owner**: <hosting-provider> queda como (a) ingress TLS + réplica de backups (recomendado: archi caído ≠ URL muerta, backup off-box gratis) o (b) se apaga (DNS directo a archi vía tailscale funnel/similar; todo en un fierro).

## Backups (el reemplazo de "GitHub tiene todo")

Hoy el backup implícito de notas son los repos GitHub. En el sistema nuevo:

| Qué                                                    | Cómo                                                                                            | RPO  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---- |
| Contenido + historia de notas                          | **Espejo git una vía → GitHub** (por write)                                                     | \~0  |
| DB completa (versiones, conversaciones, users, grants) | Snapshot diario `sqlite3 .backup` \+ cifrado (patrón `crypto.ts`) → off-box (<hosting-provider> y/o cloud) | ≤24h |
| Vectores/FTS                                           | **NO se backupean** — derivados, se regeneran con un backfill GPU                               | n/a  |
| Secretos/env de archi                                  | Ya fuera de la DB; entran al snapshot cifrado                                                   | ≤24h |

- [ ] Implementar snapshot + retención (7 diarios / 4 semanales) + verificación de restore.
- [ ] **Restore drill** (checkbox obligatorio, no opcional): en una máquina limpia, levantar el sistema desde espejo git + último snapshot y pasar el smoke. RTO objetivo: ≤1h. Sin drill exitoso no se hace F7(b).
- [ ] Decisión owner: ¿las conversaciones se backupean o TTL? (privacidad vs continuidad).

## Resumen de downtime

| Fase          | Downtime                                                            |
| ------------- | ------------------------------------------------------------------- |
| F0–F2, F4, F5 | **Cero** (aditivo / al costado; restarts rutinarios de gateway)     |
| F3 cutover    | **Writes congelados \~30–60 min**, lecturas siguen                  |
| F6            | Cero global; por usuario: conversación fresca al flipear (segundos) |
| F7            | Minutos (copiar DB + flip), programado                              |

## Riesgos

- **Contaminación cruzada en multitenant** (F5/F6): el proceso tiene tokens de todos. Mitigación: agente tool-only (sin bash), UN chokepoint de inyección, e2e de no-contaminación, canary por usuario con rollback inmediato.
- **Almacén central** (F3): notas de todos en una DB. Mitigación: cifrado at-rest + espejo git + snapshots off-box. **El owner bendice antes de F3.**
- **Archi único punto de falla** (F7): mitigación = opción (a) del ingress + backups off-box + restore drill probado.
- **Swap de modelo de embeddings** = re-backfill de una tabla (job GPU) — trivial vs plan viejo (re-push a N repos).
- **Onyx caído** ⇒ sin semántica, léxica sigue (todo local). `EMBED_URL` pluggable.
- **Prefill contention** (\~3–5 turnos simultáneos): prefix caching + afinidad; si el producto crece, es problema de capacidad GPU, no de arquitectura.
- Import/export fieles (frontmatter, nombres raros): verificación por contenido en el cutover + diff diario la primera semana.
