# Arquitectura

Cómo está armado ceibo y, sobre todo, **por qué**. Las decisiones que parecen raras casi
siempre son cicatrices de algo que se rompió en producción.

---

## 1. Cuatro procesos, un ingress

El edge (TLS) proxea todo a un solo puerto local. nginx rutea por path a cuatro procesos
que escuchan en loopback:

```
                    ┌─────────────────────────────────────────┐
  edge (TLS) ──────►│ nginx :8000                             │
                    │                                          │
                    │  /oauth/       → oauth        :8801      │
                    │  /mcp/viewer/  → web-server   :8820      │
                    │  /mcp/control/ → gateway      :8830      │
                    │  /mcp/notes/   → gateway      :8832      │
                    │  /mcp/         → mcps         :8810  (*) │
                    │  /api/  ·  /   → web-server   :8820      │
                    └─────────────────────────────────────────┘
   (*) el único location que STRIPPEA el prefijo: el launcher recibe /<server>/<secret>
```

Esa asimetría del strip es una trampa real: si agregás un MCP in-process nuevo y te
olvidás su `location`, cae al launcher y devuelve **404 en silencio**. El síntoma es "el
agente perdió una herramienta", no un error.

Los cuatro procesos comparten **un solo `.env`** en la raíz, cargado con
`process.loadEnvFile()`. Ojo con eso: `loadEnvFile` **pisa** el entorno del proceso, así
que `PORT` y `HOST` no pueden vivir en el `.env` compartido (colisionarían) — van en cada
unit de systemd.

Todos apuntan a la **misma DB SQLite**, en modo WAL, desde procesos distintos. El feed de
cambios de la web se implementa taileando esa DB, no con un bus de mensajes.

---

## 2. El agente: dos backends detrás de un contrato

`@ceibo/agent` modela la sesión con el modelo como un **stream bidireccional sin turnos**:
no hay request/response, hay eventos que entran y salen mientras la sesión vive. Eso es lo
que permite que el agente hable solo (crons, recordatorios) sin que nadie haya preguntado
nada.

Hay dos implementaciones:

- **`ma`** — Managed Agents en la nube de Anthropic. El agente, sus skills y su roster de
  sub-agentes viven del lado de Anthropic; `publish-agent.ts` los sincroniza desde el
  repo. Los secretos nunca salen de nuestra infra: los MCP se declaran por URL y la
  autenticación viaja en un vault por sesión.
- **`local`** — un modelo propio (Gemma en vLLM) dentro de una VM libvirt efímera por
  usuario, orquestada por un control-plane propio (`archima`). La VM no ve ninguna API
  key: un MITM (`agent-vault`) resuelve referencias de credencial a claves reales.

Se elige **por usuario**, en la DB, no por deploy:

```bash
ceibo user set-backend alicia local
```

El flip resetea la sesión guardada — un `session_id` de un backend no significa nada en el
otro. Las capas de canales, notas y contabilidad no saben cuál está activo.

---

## 3. Canales: el core no importa ningún canal

La dirección de las dependencias es deliberada: **ningún canal importa el core, y el core
no importa ningún canal**. `@ceibo/channels` define un contrato (`PostTarget`,
`ChannelPolicy`) y los canales concretos lo implementan. El gateway y el web-server los
montan.

El canal *remoto* es el más interesante: el web-server no habla con el modelo, habla con
el gateway por un unix socket con un protocolo propio autenticado por HMAC. Eso permite
que **el plano de notas siga funcionando con el gateway caído** — podés editar tus notas
aunque el asistente esté muerto.

La identidad de un usuario en cada canal vive en `channel_identities`, que hace de
allowlist y de router a la vez. Un número de WhatsApp o un id de Telegram desconocido
simplemente no matchea a ningún usuario, y no pasa nada.

---

## 4. Notas: repos git de verdad

Cada usuario tiene una o más *wikis*, que son **repos git reales**, creados on-demand vía
GitHub App. Nada de un blob en una tabla.

Las escrituras vienen de tres lados —el agente, el editor web, y el batch de
consolidación— y todas terminan en la misma historia git, con blame y merge reales.

Hay dos modos, conmutables sin migración:

| `NOTES_WRITE_MODE` | Fuente de verdad | git |
|---|---|---|
| `git` | el repo | es la fuente |
| `db` | la tabla `note_versions` | espejo de sólo-lectura, exportado en background |

El modo `db` existe porque git como fuente de verdad primaria tiene una latencia de
escritura que se siente en un editor. El espejo mantiene el backup continuo y la historia.

Encima hay un **índice derivado** en la misma DB: FTS léxico siempre, más vectores si hay
un `EMBED_URL` configurado. Es derivado a propósito: se puede borrar y reconstruir.

### El proxy git scopeado

Para que una VM de inferencia pueda clonar las wikis de su dueño sin recibir jamás las
credenciales del GitHub App, `web-server` expone `/api/git/*` como proxy smart-HTTP con
**dos fronteras independientes**:

1. **Source-IP**, fail-closed. Sin allowlist configurada, todo devuelve 403.
2. **Token de identidad** firmado con HMAC, que determina el `userId`; el repo pedido se
   valida contra los repos de ese usuario antes de forwardear nada.

Recién ahí el server mintea un installation token efímero **acotado al repo exacto** y lo
inyecta hacia GitHub. El token del App nunca viaja a la VM; el token de la VM nunca viaja
a GitHub.

> ⚠️ La frontera 1 lee el **último hop** de `X-Forwarded-For`. Eso es correcto sólo si tu
> reverse proxy sobrescribe o apendea ese header. Ver [SECURITY.md](../SECURITY.md).

---

## 5. MCP: dos gates que no se pisan

Diez servidores MCP, tres formas de servirlos:

- **stateless** (gmail, calendar, drive, sheets, notion, schedule, wacli) → un launcher
  único, `packages/mcps`. Agregar uno es importarlo y sumarlo al `REGISTRY`.
- **in-process en el gateway** (control, notes) → necesitan el estado de la sesión viva.
- **in-process en el web-server** (viewer) → necesita el plano de notas.

Cada server tiene **dos secretos con roles distintos**, y esto es el punto:

| | Dónde vive | Qué protege |
|---|---|---|
| `<NAME>_MCP_PATH_SECRET` | en la URL: `/mcp/<name>/<secret>` | el acceso al mount |
| `<NAME>_MCP_HMAC_KEY` | sólo en el `.env`, nunca en una URL | la **identidad** del usuario en cada llamada |

Están separados porque el path-secret **va en la URL y por lo tanto termina en los access
logs del proxy**. Si el mismo valor firmara la identidad, cualquiera con acceso a los logs
podría hacerse pasar por cualquier usuario. Con la separación, filtrar los logs cuesta el
acceso al mount, no la suplantación.

Los mounts se levantan sólo si su path-secret está configurado, así que el `.env` decide
qué subconjunto de herramientas existe.

---

## 6. Seguridad de datos

- **Passwords**: scrypt con salt por usuario y parámetros embebidos en el hash
  (`scrypt$N$r$p$salt$hash`). Sin secreto de servidor: robar la DB no permite forjar, sólo
  crackear.
- **Tokens OAuth**: AES-256-GCM con nonce aleatorio por escritura. La clave maestra
  (`OAUTH_ENC_KEY`) vive **fuera** de la DB, así que robar el `.db` sin el `.env` no sirve.
- **Cookies de sesión**: `HttpOnly; Secure; SameSite=Lax`, firmadas con HMAC.
- **Comparaciones**: todo secreto se compara con `timingSafeEqual`, con guarda de longitud
  previa para no tirar.
- **Rate limit**: ventana móvil por IP en los endpoints de login, ventana fija por usuario
  en los POST autenticados.
- **Paths**: un único gate (`isSafeRelPath`) compartido por el editor web y el agente, que
  rechaza `..`, absolutos, null-bytes y backslashes.

---

## 7. Contabilidad

En cada `status_idle` / `end_turn` el agente lee el `usage` **acumulado** de la sesión y el
store guarda el **delta** contra el snapshot anterior en `usage_turns`. Los tokens crudos
son la verdad; `cost_usd` es derivado (precio público × markup configurable).

Se guarda el delta y no el total porque una sesión puede vivir días: sumar totales
contaría el mismo token muchas veces.

```bash
ceibo usage             # por usuario
ceibo usage --daily     # por día
```

---

## 8. Convenciones del repo

- **Sin ciclos.** Las hojas (`store`, `agent`, `wikis`, `speech`, `web`, `orb`) no importan
  nada interno. Los dos deploy targets (`gateway`, `web-server`) están arriba de todo.
- **Se corre con `tsx` sobre `src`, sin build.** La única excepción es la SPA, que sí
  buildea con Vite.
- **Tests co-locados** (`*.test.ts` al lado del código) y un solo `vitest run` desde la
  raíz. Los pisos de cobertura son **por archivo** y se suben a mano: preferimos un diff
  revisado a un config que se reescribe solo.
- **Un `CLAUDE.md` por paquete** con su contrato y su frontera. Este repo se escribió con
  agentes de código, y esos archivos son su documentación operativa.
