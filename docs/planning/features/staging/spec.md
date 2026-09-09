# Entornos dev / staging / prod (spec)

> Estado: **decisiones del owner CERRADAS en la charla** (§8) · 2026-06-15 · autor: claude (opus) Plan de implementación por fases: `plan.md`. Pedido verbatim del owner:  *"Actualmente solo tengo un entorno para todos loscomponentes, todo pasa en prod. Si rompo algo se le rompe a todos. Quiero un devdonde itero rápido sin tocar usuarios, un staging donde verifico con QA antes desalir, y prod con mis usuarios estables. Lo difícil es que tengo varios componentesen distintas máquinas."*

## 1\. Objetivo y alcance

Hoy Ceibo corre **un solo entorno**: todo es prod. Un cambio mergeado se deploya (rsync + restart) y todos los usuarios lo ven al instante. No hay red de contención: una regresión rompe el sistema de toda la familia.

El objetivo es tener **tres rebanadas verticales independientes**:

- **dev** — local en la mac del owner. Loop de iteración más rápido. El 95% del trabajo vive acá.
- **staging** — desplegado, espeja la topología de prod. Acá se hace QA real (runsheet manual primero, automatizado después) antes de promover.
- **prod** — como hoy. Usuarios estables.

**Concepto central (no negociable):**  un entorno = **una versión coherente de todoel vertical** (UI + gateway + runtime + DB), identificada por **un SHA de git**, que se **promueve como una sola unidad**. Nunca UI-de-staging contra gateway-de-prod. La "versión resultante" que se promueve de staging a prod es ese SHA entero.

En alcance:

- Una palanca única `CEIBO_ENV ∈ {dev, staging, prod}` que selecciona el set coherente de componentes (puertos, DB, sockets, namespace de MA, dominio).
- Aislamiento de **estado** (DB, sesiones, tokens) por entorno.
- Manejo de los **singletons atados al exterior** (canales, OAuth, inferencia).
- Un **flujo de promoción** staging → prod gateado por QA.

Fuera de alcance (explícito):

- **Canary / rollout por usuario** ("tal usuario usa tal versión"). Es un concepto distinto (sacar una versión a un subconjunto de usuarios reales de prod), más complejo, y se difiere. Ver §6.
- Versionar el **modelo de inferencia** de archima por entorno (no hace falta; ver §5).
- Rediseñar el mecanismo de deploy (sigue siendo rsync + restart; ver plan).

## 2\. El modelo mental: dos edificios, no dos habitaciones

El entorno se elige por **la puerta** (canal / URL), y cada puerta lleva a un **edificio separado** con su propio estado. La **misma persona física** es un **registro de usuario distinto** en la DB de cada entorno: "vos" en staging ≠ "vos" en prod, no comparten estado. Romper algo en staging no toca tu yo-de-prod.

```
                       INFERENCIA (compartida — como si fuera la API de Anthropic)
                       ┌──────────────────────────────────────────────┐
                       │  archima: vLLM (1 modelo, 1 a la vez) · MA cloud │
                       └───────────────▲──────────────────▲────────────┘
                                       │                  │
  PUERTA PROD                          │                  │          PUERTA STAGING
  app.example.com ──┐                 │                  │     ┌── staging.example.com
  WhatsApp prod ─────┤                 │                  │     │
  Telegram bot prod ─┤                 │                  │     ├── Telegram bot staging
                     ▼                 │                  │     ▼
             ┌────────────────┐        │                  │  ┌────────────────┐
             │ gateway  PROD  │────────┘                  └──│ gateway  STAG  │
             │ webserver PROD │                              │ webserver STAG │
             │ DB prod        │   (mismo <hosting-provider>,            │ DB staging     │
             │ ENV_ID prod    │    árboles + puertos         │ ENV_ID staging │
             └────────────────┘    distintos)                └────────────────┘
                 SHA = N          ─── promoción del SHA ──►        SHA = N+1 (en QA)
```

dev es el mismo modelo, pero corriendo en la mac: puerta = web local; sin WhatsApp ni Telegram; DB local.

## 3\. Inventario: qué se comparte y qué se duplica por entorno

La dificultad real **no es correr varias copias del código** (con `tsx` sobre `src` \+ systemd, eso es trivial). Es **aislar el estado** y **lidiar con lossingletons atados a una cuenta/máquina real**.

### Se DUPLICA por entorno (cada uno el suyo)

| Recurso                   | Hoy (singleton)                                      | Por entorno                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Árbol de código**       | `~/ceibo` (rsync, tsx sobre src)                     | árbol propio: `~/ceibo` (prod) + `~/ceibo-staging`. **Crítico:** dos versiones ⇒ dos árboles; si ambos corren el mismo `src` son la misma versión y se rompe el aislamiento.                                                                                                                                                                                                               |
| **DB (store)**            | `CEIBO_DB_PATH` → `…/ceibo.db` (better-sqlite3, WAL) | path por entorno: `ceibo.<env>.db`                                                                                                                                                                                                                                                                                                                                                         |
| **Backend de inferencia** | archima (`backend_mode: local`) — MA no se usa       | **staging también archima** (decisión 2026-06-16, §5). `ENV_ID=ceibo-staging` + `AGENT_ID_*` mínimos solo para que el gateway bootee (MA no se invoca; sin `publish-agent`).                                                                                                                                                                                                               |
| **Telegram**              | `TELEGRAM_BOT_TOKEN` (1 bot)                         | bot por entorno (crear un 2º bot es trivial)                                                                                                                                                                                                                                                                                                                                               |
| **Dominio + TLS**         | `app.example.com`                                   | `staging.example.com` (vhost nginx + cert)                                                                                                                                                                                                                                                                                                                                            |
| **Sockets internos**      | `gateway.sock`, `remote.sock`                        | paths por entorno (`*.<env>.sock`)                                                                                                                                                                                                                                                                                                                                                         |
| **Puertos**               | `WEB_PORT=8820`                                      | offset por entorno (ej. staging 8821)                                                                                                                                                                                                                                                                                                                                                      |
| **Secretos de sesión**    | `WEB_SESSION_KEY`, `REMOTE_CHANNEL_SECRET`           | valores propios                                                                                                                                                                                                                                                                                                                                                                            |
| **OAuth redirect URIs**   | `OAUTH_REDIRECT_URI` global + clients Google/Notion  | redirect URIs propios por entorno: login Google `https://staging.example.com/api/auth/google/callback`; broker `…/oauth/callback`. El owner los registra en Google/Notion.                                                                                                                                                                                                            |
| **GitHub App de wikis**   | App + installation de prod                           | **COMPARTIDA con prod** (decisión 2026-06-16) **PERO staging apuntado a wikis de PRUEBA**, no a los repos reales. La App es la misma; el aislamiento se hace a nivel de qué repos/wikis ven los usuarios seed de staging (wikis de test dedicados). Esto neutraliza el riesgo de que staging escriba sobre wikis reales. F3 debe asegurar que el seed de staging NO mapee a repos de prod. |
| `**.env**`                | un `.env` en la raíz                                 | `.env.<env>` por entorno                                                                                                                                                                                                                                                                                                                                                                   |

### Se COMPARTE entre entornos (singleton aceptado)

| Recurso                                     | Por qué se comparte                                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **archima — vLLM (modelo de inferencia)**   | Una sola máquina (USD 15k), un modelo cargado a la vez. **No se versiona por entorno y no hace falta**: es una dependencia externa, como la API de Anthropic. prod y staging le pegan al mismo modelo. |
| **La box física <hosting-provider>**                   | staging corre en la misma máquina que prod (puertos/árboles distintos). Aislamiento lógico, no físico.                                                                                                 |
| **Cuota de la workspace de Anthropic (MA)** | ⚠️ staging consume de la misma cuota que prod. Vigilar: ya mordió antes (turnos colgados por límite de uso).                                                                                           |

### Ausente en no-prod (por decisión)

- **WhatsApp**: queda **solo en prod**. No se parea segundo número. staging valida por web + Telegram-staging. (El número de WhatsApp es el singleton más caro de duplicar; no vale la pena.)

## 4\. La palanca `CEIBO_ENV`

Hoy hay \~15 env vars sueltas e **interdependientes por diseño** (misma DB + mismo `ENV_ID` = mismo entorno), cargadas con `process.loadEnvFile()` desde un único `.env`. No existe noción de `NODE_ENV` ni de entorno (solo `users.backend_mode`, que es **per-usuario**, no per-entorno — eje distinto).

Se introduce `CEIBO_ENV ∈ {dev, staging, prod}` como **única palanca**. Un módulo de config central **deriva** de ella todo lo que se puede derivar sin secretos (reduce footguns):

- `CEIBO_DB_PATH` → `data/ceibo.<env>.db`
- sockets → `gateway.<env>.sock`, `remote.<env>.sock`
- puertos → offset por entorno
- `ENV_ID` → `ceibo-<env>`
- `WEB_PUBLIC_ORIGIN` → dominio por entorno

Lo que **no se puede derivar** (secretos, tokens, `AGENT_ID_*` que salen de `publish-agent`) vive en `.env.<env>` separados, cada uno con su `CEIBO_ENV`. Cada unit de systemd carga el `.env.<env>` correcto.

**Invariante:**  con `CEIBO_ENV=prod`, el comportamiento es **idéntico al de hoy** (el refactor es no-op funcional en prod).

## 5\. Inferencia (archima) — el eje que NO se mezcla

Archima da **dos cosas distintas**, y se tratan distinto:


1. **vLLM (inferencia)**  — un modelo, compartido. **No se versiona.**  Dependencia externa. prod y staging usan el mismo.
2. **Las VMs que corren el** ***runtime*** **del agente** — eso **sí** es código de Ceibo y puede llevar versión. El hypervisor puede levantar una VM con runtime de staging vs prod. Esa elección se hace **por entorno (la puerta), no porusuario.**  Las VMs de staging igual le pegan al **mismo vLLM**.

**Decisión (2026-06-16): staging usa archima, igual que prod.**  El owner aclaró que **hoy todo corre por archima** (`backend_mode: local`); MA no es el backend en uso. Por eso staging va por archima también — QA **fiel** al comportamiento real (testear contra MA sería testear otro backend). Implicancias:

- Los usuarios de prueba de staging van en `**backend_mode: local**` (archima), no `ma`.
- Staging **comparte el único vLLM/GPU con prod** (1 modelo a la vez) ⇒ **contención**: los turnos de QA meten latencia a los usuarios de prod mientras se testea. Aceptado para QA ocasional; mitigar testeando en ratos idle / volumen bajo. (Consistente con tratar el vLLM como dependencia compartida — §3.)
- **No hace falta** `**publish-agent**` **para staging** (MA no se usa para turnos). El gateway igual exige `AGENT_ID`/`ENV_ID` para bootear (siempre construye el `maBackend`), aunque no se invoque: se setea un set válido/mínimo con `ENV_ID=ceibo-staging`.
- Staging **reúsa el acceso a archima de prod** (ARCHIMA\_\* + la SSH key ya en la box) — sin input nuevo del owner.

> ⚠️ Reconciliar: el comentario en `packages/store/src/index.ts` ("hoy sólo 'ma' está cableado") está **desactualizado** — `backend_mode: local` (archima) sí está cableado en el gateway (`makeArchimaBackend`). Arreglar el comentario (cleanup aparte).

Las VMs de runtime versionadas por entorno (correr runtime de staging vs prod contra el mismo vLLM) siguen siendo **fase futura**, solo si se quiere QA-ear un cambio del runtime del backend local específicamente.

## 6\. Modelo de git, branches y CI

**Una branch por entorno, espejo 1:1.**  Cada branch *es* lo que está en su entorno, y a cada entorno se deploya **solo** desde su branch:

| Branch    | Entorno       | Deploy                                                     |
| --------- | ------------- | ---------------------------------------------------------- |
| `main`    | prod          | se deploya a prod **solo** desde `main`                    |
| `staging` | staging (box) | se deploya a staging **solo** desde `staging`              |
| `dev`     | dev (tu mac)  | **no se deploya** — corrés `dev` (o tu working tree) local |

`main` HEAD = exactamente lo que corre en prod; `staging` HEAD = lo que corre en staging. Sin punteros ni tags: el estado live se lee directo de la branch.

```
feature/x ──PR──► dev ───promover──► staging ───promover──► main
(worktree)        (local, tu mac)    (deploy box)           (deploy prod)
```

- El código fluye en **una sola dirección**: feature → `dev` → `staging` → `main`.
- **Promover = mergear hacia adelante** (`dev`→`staging`, luego `staging`→`main`). Cada branch va por delante de la siguiente; **nunca divergen** (el código nunca va de costado ni salta etapas).
- **Solo hay deploy en dos puntos**: `staging` → entorno staging, `main` → entorno prod. `dev` nunca sale de tu mac.
- **Leído desde el código** (qué está dónde):
  - `git log staging..dev` = está en dev y **falta** en staging.
  - `git log main..staging` = aprobado en staging y **falta** salir a prod.
  - `main` HEAD = lo live en prod.

**Invariante**: `dev` ⊇ `staging` ⊇ `main` (cada una contiene a la siguiente). Por eso prod siempre se re-deploya desde `main` y el estado de cada entorno es legible en git.

### Gates de CI (escalonados por branch destino)

Las **tres branches están protegidas** → **toda promoción es por PR**. Los checks suben de rigor a medida que el código se acerca a los usuarios:

| PR a…     | Corre (cada nivel **suma** al anterior)                                      |
| --------- | ---------------------------------------------------------------------------- |
| `dev`     | lint + typecheck (que compile). Rápido.                                      |
| `staging` | **\+ suite completa de tests** (acá van los de integración cuando existan)   |
| `main`    | **\+ coverage checks** (rechaza si baja) **\+ QA manual** (runsheet; ver F3) |

La lógica: iterás barato hacia `dev`, y el rigor sube cerca de prod.

- `**strict: true**` (branch up-to-date antes de mergear) en las **tres** branches: defiende contra "verde por separado, rojo juntos" en cada etapa, a costa de la rebase-dance en PRs paralelos (se asume).
- **Implementación**: hoy es un solo `ci.yml` (lint + typecheck + `test:cov`, siempre). Se reestructura para condicionar por `github.base_ref` (branch destino del PR): dev → job liviano · staging → tests · main → +coverage.

## 7\. No-objetivo: canary por usuario

El owner planteó "tal usuario usa tal versión de Ceibo" (pinear versión por usuario vía VM). Eso es **canary / rollout gradual**: un tercer concepto que resuelve otro problema (sacar una versión a un subconjunto de usuarios **reales deprod**). Se difiere a propósito: primero las tres puertas limpias. Cuando llegue, el mismo mecanismo de "VM de runtime versionada por request" sirve de base.

## 8\. Decisiones del owner (cerradas en la charla 2026-06-15)


1. **Tres entornos**: dev (local), staging (desplegado), prod (como hoy). ✓
2. **Modelo dos-edificios**: entorno = puerta (canal/URL) → stack + DB separados; misma persona = usuario distinto por entorno. ✓
3. **Versión unificada**: un SHA por todo el vertical; se promueve en bloque. ✓
4. **WhatsApp solo en prod.**  ✓
5. **Telegram**: bot de staging + bot de prod. ✓
6. **Web**: `staging.example.com` + `app.example.com`. ✓
7. **Dos gateways (y stack) en el mismo <hosting-provider>** (puertos/árboles distintos). ✓
8. **archima**: modelo/vLLM compartido (no versionado). **staging usa archima igualque prod** (`backend_mode: local`) — decisión 2026-06-16, "hoy todo es archima"; QA fiel a costa de contención sobre el vLLM compartido. (Revierte la idea previa de staging→MA.) MA no se usa para turnos; sin `publish-agent` para staging. ✓ (§5)
9. **QA**: la hace el owner con un **runsheet manual** al principio; automatizar después. ✓

### Decisiones abiertas

- (ninguna pendiente de diseño; lo que queda son ejecuciones de ops en F3 — ver intake.md items 4/6 y el riesgo de la GitHub App compartida.)
