# Procedimiento de auditoría — ceibo (código + box)

Playbook para que un agente audite ceibo de punta a punta: el código del monorepo **y** la box con el código deployado (`<box>`). Pensado para repetirse: al final hay un baseline de hallazgos fechado para diffear contra la próxima corrida.

> **Calibración de severidad.**  ceibo es un **experimento single-tenant** (un solo usuario unix `deploy`, una box, no prod). Por eso los hallazgos de permisos a nivel OS pesan **menos** que en prod, pero igual valen: son baratos de arreglar y el día que esto crezca a multi-tenant pasan a críticos. Severá en ese marco; no infles a "crítico" algo que el aislamiento single-tenant contiene hoy, pero **dejá anotado** qué se rompe al escalar.


---

## 0\. Acceso y alcance

- **Código:**  `~/ceibo/ceibo-labs/managed-2` (en local). \~2.4k LOC, 7 paquetes. Empezar por `notes/spec.md` y `README.md` para el modelo mental.
- **Box:**  `ssh <box>` (usuario `deploy`, <hosting-provider>). Sudo sin password disponible. El código vive en `~/ceibo`.
- La box **NO es un repo git** (se deploya por copia/rsync). No hay `git status` para ver drift → hay que **hashear** (paso B4).


---

## A. Auditoría de código

### A1. Modelo de aislamiento (lo más importante)

El tenet es **aislamiento por auth, no por confianza en el gateway**. Verificar que se sostiene:

- `wikis.mintToken(repos)` mintea un token de installation **scoped a EXACTAMENTElos repos del usuario** con permisos mínimos (`contents:write, metadata:read`), TTL 1h (`packages/wikis/src/index.ts`). Confirmar que el scope sale de `listReposForUser` y no de algo más ancho.
- Cada usuario tiene **su propio vault** (`users.vault_id`, lazy). La credencial del GitHub MCP y la `mcp_oauth` de Google van al vault del usuario, nunca compartido (`packages/gateway/src/index.ts:prepareSession`, `packages/oauth/src/server.ts`).
- **Entre usuarios distintos** el aislamiento es duro (tokens/vaults separados). **Entre wikis del MISMO usuario** es blando: el token se scopea a TODOS sus repos a la vez y la no-mezcla depende del **system prompt** (`agent.yaml`), no de auth. Es riesgo aceptado (spec Gate 2) — confirmá que sigue documentado y que el system prompt sigue teniendo el guardrail.

### A2. Manejo de secretos

- Ningún token se loguea. Grepear el código por `console.log` cerca de `token`/`secret`/`access_token`/`client_secret` → no debe haber.
- `setMcpCredential` / `setOauthCredential` / `revokeOauthCredential` (`packages/agent/src/index.ts`) no devuelven ni imprimen el token.
- El `client_secret` de Google se replica en cada credencial del vault (tradeoff consciente, documentado en spec §4). Confirmar que no aparece en logs ni respuestas HTTP.

### A3. Flujo OAuth (servicio público)

`packages/oauth/` — superficie de ataque inbound. Verificar:

- **Enroll token** de un solo uso: `randomBytes(32)`, TTL 30min, se consume al **completar** el callback (`markEnrollTokenUsed`), no al abrir el link (así un prefetch del preview de Telegram no lo quema). Defensa de confused-deputy.
- **PKCE** (`makePkce`, S256) + **state** anti-CSRF (`makeState`), guardado en `pending` con TTL 15min y barrido (`sweepPending`).
- `/callback` borra el `state` del `pending` al usarlo (single-use).
- Métodos \!= GET → 405. Token ausente/vencido → 400 con mensaje genérico.

### A4. Transporte MCP (servicio público)

`packages/mcps/` — inbound. Verificar:

- El gate por **path secreto** (`/<name>/<secret>`) corre en `launch.ts` ANTES de `handleMcpPost`, para TODO POST (incluido `tools/list`). Secreto malo → 404.
- `tools/call` sin Bearer → `isError`, no ejecuta.
- El cliente Google (`core/google.ts`) **forwardea** el Bearer del caller, no guarda credenciales.
- Inputs de tools: `search_messages` encodea el query; `create_draft` arma RFC822 a mano → revisar **inyección de headers** (CRLF en `to`/`subject`). Hoy solo crea borrador (no envía), impacto bajo, pero sanitizar es barato.

### A5. Higiene general

- `pnpm typecheck` y `pnpm lint` limpios.
- Deps: pocas y conocidas (`@anthropic-ai/sdk`, `@octokit/app`, `better-sqlite3`, `chat`/`@chat-adapter/telegram`). Ojo `"@chat-adapter/telegram": "latest"` y `chat: "^4.x"` — rango flojo, revisar que el lockfile pinee.
- `git ls-files | grep -iE '\.env$|\.pem$'` → solo `.env.example`, nunca un `.env` o `.pem` real. Y `git log --all --diff-filter=A` para confirmar que nunca entró uno históricamente.


---

## B. Auditoría de la box

```bash
ssh <box>
```

### B1. Servicios y procesos

```bash
systemctl list-units --type=service | grep -iE 'managed|mcp|oauth|gateway|nginx'
ps aux | grep -E 'node|tsx|nginx' | grep -v grep
```

Esperado: `ceibo-{gateway,oauth,mcps}.service` + `nginx`, todos `active`.

### B2. Permisos de secretos y datos  ⚠️ acá estuvieron los hallazgos

```bash
ls -la ~/ceibo/secrets/                    # <wikis-org>.pem debe ser 600, dir 700
stat -c '%a %n' ~/ceibo/packages/*/.env    # TODOS deben ser 600
stat -c '%a %n' ~/ceibo/data/*.db ~/ceibo/data/*.bak*   # deben ser 600
```

Cualquier `.env`, `.db` o `.pem` en **644** es hallazgo (world-readable: lo lee nginx/www-data, containerd, etc.). Los `.env` contienen el org key de Anthropic, el bot token, y `GMAIL_MCP_URL` (¡que lleva el path secreto del MCP\!).

### B3. Red: puertos e ingress

```bash
sudo ss -tlnp                                  # backends deben bindear 127.0.0.1
sudo cat /etc/nginx/sites-enabled/*            # ruteo por path
```

Esperado: nginx en `127.0.0.1:8000` (lo que proxea el edge de <hosting-provider>), rutea `/oauth/`→8801 y `/mcp/`→8810; oauth/mcps **solo en localhost**; nada salvo `:22` expuesto a `0.0.0.0`. Probar desde afuera:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<box>/oauth/start   # 400 (falta token)
curl -s -X POST https://<box>/mcp/gmail/SECRETOMALO                   # 404 (gate de secreto)
```

### B4. Drift: ¿el código corriendo == el committeado?

La box no es repo git → hashear y comparar contra local:

```bash
# en la box
cd ~/ceibo && find packages -name '*.ts' | sort | xargs sha256sum
# en local
cd ~/ceibo/ceibo-labs/managed-2 && find packages -name '*.ts' | sort | xargs shasum -a 256
```

Deben coincidir byte-a-byte. Hashear también `agent.yaml`. (El `agent.yaml` aplicado al agente MA en la cloud no se puede verificar desde la box — anotar como no-verificable.)

### B5. Higiene de logs (verificar el claim "nunca se loguea token")

```bash
for s in ceibo-gateway ceibo-oauth ceibo-mcps; do
  sudo journalctl -u $s --no-pager | grep -cE 'ghs_|ya29\.|sk-ant-|1//0|[0-9]{8,}:AA[A-Za-z0-9_-]{30}'
done                                           # todos deben dar 0
grep -cE 'CLIENT_SECRET|BOT_TOKEN|API_KEY=|ghs_|ya29|sk-ant' ~/.bash_history   # 0
```

### B6. Postura de host

```bash
node -v; corepack pnpm -v                      # vs packageManager del repo (drift de versión)
systemctl is-enabled unattended-upgrades       # ¿auto-patching?
sudo cat /etc/systemd/system/ceibo-*.service   # ¿hardening? User=deploy (no root), idealmente
                                               # NoNewPrivileges/ProtectSystem/ProtectHome/PrivateTmp
sudo nft list ruleset                          # firewall (mitigado si todo bindea localhost)
```

### B7. Sanity de la DB (sin volcar secretos)

```bash
sqlite3 ~/ceibo/data/ceibo.db \
 "SELECT (SELECT COUNT(*) FROM users), (SELECT COUNT(*) FROM users WHERE anthropic_api_key IS NOT NULL),
         (SELECT COUNT(*) FROM enroll_tokens WHERE used_at IS NULL), (SELECT COUNT(*) FROM usage_turns);"
```

`users_con_apikey` debería ser 0 (se usa el org key, no key por usuario). Tokens de enroll sin usar vivos = ojo si son muchos (acumulan, no se limpian).


---

> **Nota de esta copia pública.** El documento original sigue acá con una sección C: el
> baseline de hallazgos fechado contra el que se diffea cada corrida. Esa sección no se
> publica, porque parte de la infraestructura que describe sigue en pie. Lo que se publica
> es el procedimiento, que es lo repetible.
