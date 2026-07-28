# Dev local — cómo levantar Ceibo en la mac

Dev corre en tu mac contra una DB local (`ceibo.dev.db`), **sin tocar prod jamás**.
Canal web únicamente (sin Telegram ni WhatsApp). Arquitectura: `docs/ARCHITECTURE.md`.

## Pre-requisitos

- Node 22+, pnpm 10 (`pnpm -v`)
- `pnpm install` en el root del monorepo (una sola vez, o cuando cambien deps)
- `ANTHROPIC_API_KEY` válida (necesaria para el bootstrap del gateway en ambos modos)

## Pasos

### 1. Configurar el entorno

```bash
cp .env.dev.example .env
# Editá .env según el backend de chat elegido (ver paso 2)
```

**No subas `.env` a git** — tiene secretos.

### 2. Backend de chat en dev: MA o archima

Hay dos modos para el chat. Elegí el que se ajuste a lo que estás haciendo:

---

#### Opción A — Managed Agents (MA) de Anthropic

El chat corre contra los agentes publicados en MA. Requiere cuota de la workspace.

```bash
# Publicar agentes dev (una sola vez por ENV_ID):
CEIBO_ENV=dev pnpm --filter @ceibo/gateway publish-agent
# Imprime los AGENT_ID_* generados → copiálos en .env
```

> Si no querés publicar agentes dev todavía, podés poner `AGENT_ID=dummy` y el gateway
> arranca sin poder hacer turnos MA (útil para desarrollar sin cuota).

---

#### Opción B — archima (recomendado para iterar sin gastar cuota MA)

El chat corre en archima (gemma4-31b vía vLLM compartido). Las VMs se crean
solas en el 1er turno (`cp.sh assign` idempotente). Comparte el vLLM con prod/staging —
contención aceptada para dev. `AGENT_ID=dummy` alcanza; MA no se llama para el chat
(sí se necesita `ANTHROPIC_API_KEY` para el bootstrap del gateway).

> **Runtime de dev aislado (F6.4, 2026-06-17).** archima corre **tres runtimes
> co-localizados** en gpuhost, uno por entorno: `~/archima/{prod,staging,dev}`. Cuál
> te sirve lo decide **qué key forced-command matchea** en los `authorized_keys` de
> gpuhost → qué `cp-forced.sh` → qué `cp.sh`. dev usa la key **dedicada**
> `archima_cp_dev` → nodo forced-command `ceibo-dev` → `~/archima/dev`. Las VMs de dev
> quedan namespaceadas `archima-<slug>-ceibo-dev` (prod usa el `env_…` opaco de MA;
> staging usa `-ceibo-staging`), así que no hay colisión ni contaminación entre entornos.
> El vLLM, el `agent-vault` daemon, `~/.archima/anthropic.ref` y la base image SON
> compartidos a nivel box (no per-env). **Cuidado:** usar `archima_cp` (la key de
> **prod**) en vez de `archima_cp_dev` hace que tu `pnpm dev` corra sobre el runtime de
> PROD — fue el bug que F6.4 arregló.

**Pre-requisito:** la key dedicada de dev del control-plane de archima (`archima_cp_dev`).

1. Copiá la key (pedísela al owner / bajala de la box):
   ```bash
   chmod 600 ~/.ssh/archima_cp_dev
   ```
2. Agregá a `~/.ssh/config` (necesario en la mac: fuerza la key correcta y evita caer
   a otra key con acceso full-shell que saltearía el forced-command wrapper):
   ```
   Host gpuhost-cp
       HostName 100.64.0.10
       User demo
       IdentityFile ~/.ssh/archima_cp_dev
       IdentitiesOnly yes
   ```
   > El flag `IdentitiesOnly=yes` también está en el código del gateway (`factory.ts`)
   > como defensa adicional, pero el alias `ssh/config` sigue siendo necesario para
   > fijar la key correcta en la mac.
3. En `.env`, seteá (y dejá `AGENT_ID=dummy`):
   ```
   ARCHIMA_SSH_TARGET=gpuhost-cp
   ARCHIMA_SSH_KEY=/Users/<usuario>/.ssh/archima_cp_dev # ruta ABSOLUTA (~ no expande en spawn); key DEDICADA de dev
   ARCHIMA_CP=cp.sh
   ARCHIMA_AV=agent-vault
   ARCHIMA_PROVIDER_ID=local
   ARCHIMA_MODEL_ID=gemma4-31b
   ```
4. Flipeá el usuario dev a backend local:
   ```bash
   ./ceibo user set-backend dev local
   ```

---

### 3. Seedear la DB de dev

```bash
CEIBO_ENV=dev pnpm --filter @ceibo/store seed:dev
```

Crea en `packages/store/data/ceibo.dev.db`:
- Usuario `dev` con contraseña `dev`
- Email `dev@ceibo.local` autorizado y registrado
- Wiki `dev-personal` registrada en el store (sin tocar GitHub)

Idempotente: correrlo de nuevo es no-op.

### 4. Levantar el stack (3 terminales)

**Terminal 1 — gateway:**
```bash
CEIBO_ENV=dev pnpm --filter @ceibo/gateway dev
```

Arranca el gateway en modo watch (`tsx watch`) contra `ceibo.dev.db`.
Sin `TELEGRAM_BOT_TOKEN` en el `.env`, el canal Telegram queda apagado (normal en dev).

**Terminal 2 — web-server:**
```bash
CEIBO_ENV=dev pnpm --filter @ceibo/web-server dev
```

Arranca en `http://127.0.0.1:8820` y se conecta al gateway por el canal remoto (socket unix).

**Terminal 3 — frontend (Vite dev server):**
```bash
pnpm --filter @ceibo/web dev
```

Arranca en `http://localhost:5173`. Las requests a `/api` van al web-server local (`:8820`)
por el proxy de Vite — **nunca a prod**.

### 5. Login

Abrí `http://localhost:5173`. Dos caminos:

- **Email + password**: `dev@ceibo.local` / `dev` (seteado por el seed)
- **Google**: requiere `GOOGLE_CLIENT_ID/SECRET` en `.env` con
  `http://localhost:5173/api/auth/google/callback` como redirect URI

### 6. Verificar aislamiento

El stack arranca contra `ceibo.dev.db`. Cualquier mutación (notas, sesiones, etc.)
**vive solo en esa DB local**. Prod usa `ceibo.db` en la box — completamente separado.

```bash
# Confirmar que el web-server usa la DB correcta (el log de arranque lo muestra):
# web-server arriba · env=dev · http://127.0.0.1:8820 · db=.../packages/store/data/ceibo.dev.db
```

## Flujo de trabajo

```
feature/x ──PR──► dev ──promover──► staging ──promover──► main (prod)
(worktree)        ↑
                  branch dev (esta branch)
```

- Commits de features van en worktrees (`.claude/worktrees/<feat>/`), nunca directo a `dev`.
- `dev` local no se deploya: es solo para iterar en la mac.
- Para chat MA de verdad (opción A), publicá los agentes dev (paso 2) y asegurate de que
  `ENV_ID=ceibo-dev` en el `.env` — así no consumís los agentes de prod.
- Para iterar rápido sin cuota MA, usá archima (opción B): gemma4-31b local en archima.

## Resetear la DB de dev

```bash
rm packages/store/data/ceibo.dev.db
CEIBO_ENV=dev pnpm --filter @ceibo/store seed:dev
```

## Qué NO hace dev local

- **No publica agentes a MA** automáticamente: eso es `publish-agent` con las keys del owner.
- **No toca la box de prod** (`ceibo.example.com`): el proxy Vite apunta a `:8820` local.
- **No tiene Telegram ni WhatsApp**: canal web únicamente.
- **No tiene HTTPS ni OAuth de prod**: los redirect URIs de prod no matchean `localhost`.
