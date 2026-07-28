# ceibo

Un asistente personal multi-usuario que vive donde ya estás: **Telegram**, **WhatsApp** y
una **web con push-to-talk**. Cada usuario tiene sus propias notas (wikis en git), sus
propias cuentas conectadas (Gmail, Calendar, Drive, Sheets, Notion) y su propio agente,
con aislamiento real entre usuarios en cada capa.

No es un wrapper de chat. Es la infraestructura alrededor del modelo: identidad,
permisos, canales, memoria persistente, voz, tareas programadas y contabilidad de gasto.

> **Estado:** proyecto personal, hoy archivado como muestra de trabajo. Corrió en
> producción varios meses con usuarios reales. El código está tal cual salió de esa
> operación, con los identificadores de la infraestructura reemplazados por ejemplos.
>
> Los comentarios y la documentación están **en español**, que es como se escribió.

---

## Qué tiene de interesante

**Dos backends de modelo, intercambiables por usuario.** El mismo asistente corre sobre
[Managed Agents](https://docs.anthropic.com/) en la nube de Anthropic, o sobre un modelo
propio (Gemma en vLLM) dentro de una VM libvirt efímera por usuario. Se cambia con un
comando (`ceibo user set-backend <handle> ma|local`) sin tocar código. La capa de canales
y la de datos no saben cuál está activo.

**Los MCP son la frontera de permisos, no un detalle de plomería.** Hay diez servidores
MCP self-hosted. Cada uno tiene dos gates independientes: un *path-secret* que gatea la
URL (y que por eso se asume filtrado en los logs del proxy) y una *clave HMAC* separada
que firma un Bearer de identidad por usuario. El agente de un usuario no puede alcanzar
los datos de otro aunque adivine la URL.

**Las notas son repos git de verdad.** Cada usuario tiene una o más wikis, que son repos
reales creados on-demand vía GitHub App, con tokens de instalación efímeros acotados al
repo exacto. El agente escribe notas, el editor web escribe notas, y ambos comparten
historia, blame y merge. Hay un proxy git smart-HTTP scopeado para que una VM de
inferencia pueda clonar sólo las wikis de su dueño.

**Voz de punta a punta, por encima del modelo.** El modelo no tiene audio: el bridge
transcribe lo que entra y sintetiza lo que sale, con dos providers intercambiables
(faster-whisper + edge-tts local, o Inworld por HTTP).

**Contabilidad honesta.** Cada turno registra los tokens crudos de la sesión como delta
contra un snapshot, no una estimación. `ceibo usage` reporta gasto real por usuario y por
día.

---

## Arquitectura en 30 segundos

```
   Telegram ─┐
   WhatsApp ─┼─► gateway ──► agente (MA cloud │ modelo local)
   web/SSE ──┘      │              │
                    │              └──► MCP servers ──► Gmail · Calendar · Drive
                    │                     (self-hosted)   Sheets · Notion · crons
                    │                                     WhatsApp · notas · control
                    ▼
                 SQLite  ◄──  web-server ──► wikis (repos git vía GitHub App)
                                  │
                                  └──► SPA (React) + SSE
```

Cuatro procesos detrás de un ingress nginx que rutea por path:

| Proceso | Qué hace | Puerto |
|---|---|---|
| `gateway` | Recibe de los canales, rutea a usuario/sesión, contabiliza turnos. Sirve los MCP `control` y `notes` in-process. | 8830 / 8832 |
| `web-server` | SPA + SSE + login + el plano de notas. Sirve el MCP `viewer`. | 8820 |
| `oauth` | Enrola cuentas externas y escribe la credencial cifrada en el vault del usuario. | 8801 |
| `mcps` | Launcher único de los MCP stateless (gmail, calendar, drive, sheets, notion, schedule, wacli). | 8810 |

El detalle está en **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Los paquetes

Monorepo pnpm, 15 paquetes con una regla: **sin ciclos**. Las hojas no dependen de nada
interno; los dos deploy targets consumen casi todo.

| Paquete | Rol | Depende de |
|---|---|---|
| `@ceibo/store` | Data layer: usuarios, identidades por canal, repos y accesos N:N, sesiones, ledger de uso, índice de notas (FTS + vectores). SQLite. | — |
| `@ceibo/agent` | Cliente de Managed Agents: la sesión como stream bidireccional sin turnos, más helpers de vault. Channel-agnostic. | — |
| `@ceibo/wikis` | Substrato de wikis: crea repos on-demand y mintea tokens efímeros scoped por usuario. Backend: GitHub App. | — |
| `@ceibo/speech` | STT/TTS channel-agnostic, dos providers. | — |
| `@ceibo/web` | SPA: orbe push-to-talk, editor de notas, explorador. React + Vite. | — |
| `@ceibo/orb` | El orbe animado (canvas), aislado para poder iterarlo en un sandbox. | — |
| `@ceibo/channels` | Contrato channel-agnostic + canales concretos (telegram, cli, wacli) + canal remoto. | `agent`, `store` |
| `@ceibo/mcps` | Los MCP stateless + el launcher único. | `speech`, `store` |
| `@ceibo/oauth` | Broker OAuth: PKCE, cifrado at-rest de los grants, refresh. | `agent`, `store` |
| `@ceibo/backend-local` | Cliente del backend local: control-plane de VMs, opencode sobre HTTP. | `agent`, `store` |
| `@ceibo/archima-runtime` | El runtime versionado de las VMs (control-plane, provisioning, config), de-secreteado y con tests que lo mantienen así. | — |
| `@ceibo/rem-runner` | Consolidación batch de wikis: planifica y ejecuta refactors de notas fuera de línea. | varios |
| `@ceibo/gateway` | Proceso always-on. El corazón. | 7 internos |
| `@ceibo/web-server` | Servicio web standalone. | 6 internos |
| `@ceibo/cli` | CLI de administración (`ceibo`): usuarios, canales, repos, enrollment, gasto. | `oauth`, `store`, `wikis` |

`store` es hoja profunda: seis paquetes dependen de ella, así que un cambio de contrato
ahí repercute en todo. Cada paquete tiene su propio `CLAUDE.md` con su contrato y su
frontera.

---

## Correr esto

Necesitás **Node 22+**, **pnpm 10** y una API key de Anthropic. Todo lo demás es opcional.

```bash
pnpm install
cp .env.example .env         # completá ANTHROPIC_API_KEY, AGENT_ID, ENV_ID
                             # y WEB_SESSION_KEY / REMOTE_CHANNEL_SECRET
pnpm dev:setup               # una vez: crea la DB y un usuario dev@ceibo.local / "dev"
pnpm dev                     # gateway + web-server + web juntos
```

Login en `http://localhost:5173`. El modo dev corre entero contra una DB local y no toca
nada remoto.

`.env.example` documenta las ~145 variables agrupadas por subsistema, con lo requerido
marcado. Casi todo tiene un default razonable o apaga su feature si falta.

Verificación:

```bash
pnpm lint          # biome
pnpm typecheck     # tsc --noEmit en los 15 paquetes
pnpm test          # ~2200 tests
```

El pre-push de husky corre los tres. Detalle del setup de dev, incluido el backend local:
**[dev.md](dev.md)**.

---

## Cosas que valen la pena mirar

Si venís a leer código y no a correrlo, estos son los archivos donde está lo bueno:

- `packages/web-server/src/wiki-git-proxy.ts` — el proxy git scopeado, con las dos
  fronteras de seguridad documentadas en el encabezado.
- `packages/mcps/src/launch.ts` — cómo un solo proceso monta N servidores MCP y por qué
  el path-secret está desacoplado de la clave HMAC.
- `packages/store/src/crypto.ts` — cifrado at-rest de los tokens OAuth, y por qué la clave
  maestra vive fuera de la DB.
- `packages/gateway/prompt/` — los prompts del agente, compuestos de un núcleo común más
  un adaptador por backend.
- `packages/archima-runtime/src/build.ts` — cómo se versiona un runtime de VMs sin
  versionar sus secretos, con tests que rompen el build si se cuela un literal.
- `vitest.config.ts` — pisos de cobertura por archivo, con ratchet manual a propósito.

---

## Licencia

MIT. Ver [LICENSE](LICENSE).

Las dependencias son todas permisivas (MIT / ISC / Apache-2.0 / BSD); no hay copyleft en
el árbol.
