# decay — plan

> Checkboxes de ejecución. Diseño: `spec.md`. (act. 2026-06-29)

## Estado / replanteo (2026-06-26)

El análisis descriptivo mató el v0 original (archivar por edad/idle de git + inbound-links):

- **git-time colapsado** — el repo tiene \~32 días (import en bloque) → todas las notas parecen "nuevas", `idleDays` no discrimina. Ningún umbral da candidatos hoy.
- **87% huérfanas** (0 inbound) → inbound-links es un salience floor flojo.

→ La señal real de olvido es el **acceso**, guardado **in-file en frontmatter** (self-contained, sin log central). Eso es lo que se construye ahora.

PRs: #630 (gemma default + dry-run) ✅merged · #633 (shallow VMs) ✅merged · **#675 (toda la feature decay, PR único a dev)** 🟡abierto — unifica y reemplaza a #658/#665/#669/#670/#672 (cerrados sin mergear).

## Calibrar

- [x] Análisis descriptivo (2026-06-26): edad / idle / inbound por nota (216 notas, 5 wikis)
- [x] Conclusión: pivote a acceso-en-frontmatter (git-time y links insuficientes hoy)

## Sustrato: metadata in-file (frontmatter)

- [x] Editor esconde el frontmatter tras un chip — PR #658 (🟡 CI)
- [x] Esquema mínimo de claves: `created` / `accessed` / `reads`
- [x] Primitiva read/write server-side en `wikis` — PR #665 (parse/upsert/seed/recordAccess)
- [x] Seed one-shot en las notas existentes (`reads: 0`, `created`/`accessed` desde git) — PR #665 (`seed:decay`, dry-run/apply, idempotente)

## Productores (escriben `accessed`/`reads`, debounce ≤1/día/nota)

- [x] Plugin opencode (agente lee/edita) → bump — PR #669 (apila sobre #665; falta verificar en VM + deploy)
- [x] Viewer del web-server (tus lecturas por web) → bump — PR #670 (apila sobre #665; síncrono, debounce, e2e verde)
- [ ] (las ediciones ya las fecha git; no hace falta productor)

## REM consume el frontmatter — PR #672

- [x] `decayScore = 2^(−idle/h)` \+ salience floor por `reads` (`decay.ts`)
- [x] Gate determinístico: veta archive/delete de notas no frías; resto del plan intacto
- [x] Conservador: sin `accessed` nunca archiva. Config `REM_DECAY_GATE`/half-life/floor/threshold
- [x] dry-run muestra qué vetaría (calibración) · PR #672

## Después

- [ ] v1 — repaso: consolidar/reescribir una nota resetea su reloj (sube `h`)
- [ ] `forget --hard`: excisión de historia para contenido sensible (diseño aparte)
- [ ] vectores in-repo (mismo principio self-contained)

## Decisiones a cerrar con el owner

- [ ] Esquema de claves del frontmatter
- [ ] Heurísticos de respaldo durante el bootstrap (carpeta/fecha) mientras el ledger se llena: ¿sí?
- [ ] `h` inicial y salience floor — calibrar cuando el frontmatter tenga datos de lectura
