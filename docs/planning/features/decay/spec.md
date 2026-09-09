# decay — olvido con intención (memoria que decae sobre git) · spec

> Estado: **diseño en discusión** (2026-06-25) · autor: claude (opus). Spec viva. Checkboxes de ejecución → `plan.md`. Carpeta: `~/wiki/ceibo/tecnico/features/decay/`.

**Visión:**  que la memoria de ceibo **olvide como olvida la gente** — no acumule para siempre. Lo viejo, irrelevante y nunca consultado se enfría y sale del camino; lo que se usa seguido se refuerza y queda a mano. Dos objetivos del owner, explícitos:


1. **Mantener el shallow copy de las VMs liviano y limpio** — el working tree que ve el agente debe ser sólo lo *vivo*, no el archivo histórico entero.
2. **Olvidar con intención** — el olvido es un acto reversible y auditable, no una pérdida.

REM es el vehículo: ya es el pass de consolidación. Decay se inserta como el **scoring quedecide qué se enfría**, hoy delegado a puro juicio del LLM.


---

## El insight: git ya es el tier frío (y por eso el olvido es seguro)

La arquitectura de ceibo encaja con el modelo **storage-strength vs retrieval-strength** de Bjork sin habérselo propuesto:

| Concepto de decay                   | En ceibo                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Hot** / alta retrieval-strength   | `.md` en el working tree del wiki (lo que ve el agente)                                               |
| **Cold** / storage-strength intacta | archivado = se borra el `.md` \+ línea en `.archived.md` → **vive en la historia de git**             |
| **Repaso que revierte el olvido**   | `recall` / `searchArchived` recuperan server-side vía GitHub API (octokit), NO desde el clon de la VM |

**Consecuencia central: el tier frío es gratis, lossless, versionado y auditable.**  Cada decay y cada revival es un commit. La curva de olvido del wiki es literalmente inspeccionable con `git log`. Y como archivar es **reversible**, se puede ser *agresivo* con el decay sin riesgo — lo opuesto al miedo que llevó al guardrail `REM_MAX_DELETIONS` tras el incidente del 2026-06-09 (archivó 37 notas reales).

> **Olvidar ≠ borrar.**  El `archive` actual no destruye nada: el blob sigue alcanzable desde el commit viejo. Eso *es* el decay que queremos. La nota baja de retrieval-strength, no desaparece.


---

## Dos tiers de "borrado" (no confundirlos)

```
decay (REM)        →  soft: hot → cold (git history). Reversible. El origin crece y da igual.
forget --hard      →  excisión de historia (git filter-repo). Explícito, raro, irreversible.
```

- **Soft decay** es el feature. Mueve hot→cold. El **origin** (GitHub) crece monótono — pero son notas de texto: `.git` full de TODAS las wikis = \~5.3 MB; la historia crece pocos MB/año. `git gc`/repack comprime pero **no elimina objetos alcanzables**. El costo de "borrar de verdad" (reescribir historia, romper SHAs, force-push, romper `recall`) es órdenes de magnitud mayor que los KB ahorrados → **para el 99% nunca se borra de verdad, y está bien.**
- `**forget --hard**` es el 1% que sí lo exige: **contenido sensible** que debe desaparecer (un secreto pegado, un "borrá esto de verdad"). Soft-archive es insuficiente: sigue en la historia → recuperable → no está borrado. Eso necesita reescribir la historia: irreversible, destructivo, con guardrails propios. **Comando aparte, semántica aparte. No mezclar con decay.** → en este feature queda como *nota de diseño para después*, no v0.

### El shallow no es donde se borra

Sacar algo del shallow copy de la VM **no borra nada durable** — la VM es un cache desechable que se reconstruye desde origin (clon `--depth 1`, ver \[`../../../...`\] `packages/archima-runtime/runtime/vm/cp.sh`, PR #633). El shallow controla *cuánta historiacarga cada VM*, no qué se guarda. El objetivo "shallow liviano y limpio" se logra haciendo que el **working tree** tenga sólo lo hot (decay archiva lo frío) — la historia profunda queda en origin, fuera de la VM.


---

## La base teórica (research 2026-06-25)

Todo el campo, de Ebbinghaus (1885) a los agentes LLM, modela el olvido igual: **decaimientoexponencial sobre el tiempo desde el último acceso**, modulado por una *fuerza* que crece con la repetición.

- **Ebbinghaus / spaced repetition:**  `R = e^(−t/S)` (S = estabilidad). Equivalente práctico, half-life: `p = 2^(−Δ/h)` — Δ = días desde el último visto, h = vida media. **Cada repasosube h** → la curva se aplana. Esa es toda la idea de spaced repetition.
- **Generative Agents (Park, Stanford 2023):**  retrieval = `α·recency + α·relevance + α·importance`. recency = decay exponencial sobre horas desde el último *retrieval*; importance = entero auto-asignado; relevance = similitud de embedding. Cada nodo guarda *creation* Y *last-access*.
- **Mem0 (producción 2025):**  la lección operativa = **no borran, rerankean en search-time** (boost ×1.5 a lo reciente, damping →×0.3 a lo inactivo). Y el guardrail clave: **saliencefloor** — un dato importante pero poco accedido **nunca** se poda sólo por tiempo. LRU rompe justo para lo "low-frequency, high-stakes" (una nota-índice que se lee mucho y se edita nunca).

Tres señales, en todos: **recency** (decay), **frequency** (LRU/LFU), **importance** (salience). El consenso es combinarlas, no usar una sola.


---

## El gap real: git da *last-edit*, no *last-access*

Decay necesita **last-access** (retrieval); git sólo da **last-edit** (commit). Una nota "escribir-una-vez, leer-seguido" (un índice, una referencia) no recibe commits → un decay ingenuo basado sólo en git la pisaría. Es el bug "LRU rompe para low-frequency/high-stakes" textual. Dos salidas:


1. **Access ledger** (lo correcto, más infra): loggear "nota X surfaceada en T" donde ocurre el retrieval (capa `wikis` / `gateway`). Append-only; podría ser un `.access.log` en el propio repo, o store aparte.
2. **Proxy de importancia sin ledger** (barato, v0): **inbound-links** — `grep '[[X]]'` cuenta cuántas notas apuntan a X. Centralidad tipo PageRank = salience floor sin tocar el server. Protege exactamente las notas-índice.


---

## Diseño en REM (de menos a más)

REM ya es el consolidation pass; decay se inserta como el **scoring que elige candidatos aenfriar**, hoy puro juicio del LLM.

### v0 — salience-gated archiving (sin infra nueva, todo en `rem-runner`)

REM calcula por nota un `decayScore` desde git + el árbol, y **sólo propone archivar lo queestá viejo Y sin inbound-links Y sin tocar**. El LLM decide *dentro* de ese candidato-set, no sobre todo el wiki. Señales (todas locales al clon):

- `ageDays` = días desde el primer commit que tocó el path (creation).
- `idleDays` = días desde el último commit que lo tocó (proxy de last-edit).
- `inboundLinks` = nº de `[[nombre]]` apuntando a la nota (salience floor).
- (futuro) `lastAccess` del ledger.

`decayScore = 2^(−idleDays / h)`, con **salience floor**: nunca candidato si `inboundLinks ≥ N` o si la nota está marcada importante. Reduce los falsos positivos del incidente del 09-06 de raíz (el set de candidatos es chico y defendible).

### v1 — half-life con repaso (spaced repetition emergente)

Cada vez que REM **consolida/reescribe** una nota, eso *es un repaso* → resetea su reloj (sube `h`). Las notas que REM toca seguido se vuelven resistentes al olvido; las que nunca toca decaen. Emerge gratis del pass de consolidación.

### v2 — soft decay en retrieval (necesita access ledger + server)

Con el ledger, `recall`/`searchArchived` rankean con `2^(−Δ/h)·importance` en vez de cortar duro. Pero esto vive en `wikis` / server-side, **no** en REM. Última etapa.


---

## Recomendación de arranque

**v0 + el proxy de inbound-links primero** (todo dentro de `rem-runner`, sin tocar el server, reversible por diseño). Antes de codear: correr un **análisis descriptivo** sobre una copia de las wikis personales — distribución de `ageDays` / `idleDays` / `inboundLinks` por nota — para **calibrar los umbrales (\*\*\*\***`**h**` **,**  `**N**` **) con datos reales**, no a ojo. El dry-run sandbox de `rem-runner` (`pnpm --filter @ceibo/rem-runner run:dry`, ver \[`../../../../packages/rem-runner/CLAUDE.md`\]) ya permite correrlo contra una copia local sin push.


---

## Decisiones a cerrar con el owner


1. **¿v0 sólo, o v0 contemplando** `**forget --hard**` **en el diseño desde ya?**  (el owner se inclinó por dejar `forget --hard` como nota de diseño, implementar soft primero).
2. **Umbral del salience floor** `**N**` (inbound-links mínimos para inmunidad) — calibrar con el análisis descriptivo.
3. **¿El access ledger se hace o se vive con el proxy de links?**  (depende de cuánto pesen las notas write-once-read-often en tus wikis reales).
4. **Vida media** `**h**` **inicial** y si arranca global o por-carpeta.


---

Relacionado: `quickboot/` (sessions = compactación del contexto, ortogonal al wiki), PR #633 (shallow VMs), `rem-runner` (el runner del batch en archi). Memorias: `rem-runner-pulido`, `entorno-es-archi`.

Sources del research: Mem0 eviction & forgetting · Generative Agents (Park 2023, ar5iv 2304.03442) · Ebbinghaus/half-life regression (arXiv 2004.11327) · FadeMem (arXiv 2601.18642).
