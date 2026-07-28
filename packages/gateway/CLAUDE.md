# @ceibo/gateway

Proceso always-on: recibe de los canales (Chat SDK), rutea a usuario/sesión y contabiliza.

- **Depende de (interno):** agent, channels, mcps, oauth, speech, store, wikis (7)
- **Consumido por:** nadie (deploy target)

## MCP `control` (el agente corre los comandos de usuario)

El agente puede correr por chat/voz los MISMOS comandos que el usuario tipea (`/connect`,
`/model`, `/new`, …) vía la tool `ceibo_command`. El dispatch de comandos vive en
`runCommand` (engine.ts) y lo comparten el path de canal (`handleIncoming`) y la tool
(`runCommandForUser`) → una sola fuente de verdad; cubre todos los comandos actuales y futuros
sin un wrapper por comando.

- **In-process** (`control-mcp.ts` + listener HTTP en `index.ts`), NO en el launcher de
  `@ceibo/mcps`, porque `runCommandForUser` necesita el estado vivo por usuario (`ctxByUser`).
  Mismo patrón que el viewer en el web-server. Reusa el transport de `@ceibo/mcps`.
- **Auth**: secreto en el path (`/mcp/control/<secret>` = `CONTROL_MCP_SECRET`, timing-safe) +
  Bearer firmado (`<userId>.<exp>.<hmac>`, HMAC con `CONTROL_MCP_HMAC_KEY` — C1: clave SEPARADA
  del path-secret, que vive en los access logs; con expiración) → el userId. La cred per-usuario
  la mintea `prepareSession` al vault (como schedule/viewer).
- **Auto-disrupción**: `/new`, `/model` y `/wiki set` recrean la sesión MA del usuario — la
  misma donde el agente corre la tool. El turno que la invocó queda huérfano (su respuesta se
  pierde); `runCommandForUser` detecta el cambio de `sessionId` y postea la confirmación al chat
  out-of-band. Es la semántica esperada de esos comandos (descartar contexto).
- **Config** (todo opcional; sin esto el MCP no se monta): requiere AMBAS `CONTROL_MCP_SECRET`
  (path-gate) **y** `CONTROL_MCP_HMAC_KEY` (firma del Bearer, distinta del secret) — falta
  cualquiera → control OFF y connect roto en silencio. Más `CONTROL_MCP_URL`
  (`https://ceibo.example.com/mcp/control/<secret>`, con el MISMO secret embebido) y
  `CONTROL_MCP_PORT` (default 8830). nginx: `proxy_pass` de `/mcp/control/` al puerto SIN strip
  (longest-prefix sobre `/mcp/`). Es cambio de config del agente → tras setear el env, correr
  `pnpm --filter @ceibo/gateway publish-agent`.

## MCP `notes` (búsqueda híbrida sobre el índice derivado — feature db F2)

Mismo patrón que control, listener propio (`notes-mcp.ts` + bloque en `index.ts`): path-secret
`/mcp/notes/<NOTES_MCP_SECRET>` + Bearer firmado con `NOTES_MCP_HMAC_KEY` → userId → scope de
wikis vía `listReposForUser`. Tools (opencode las expone como `notes_search`/`notes_read`/
`notes_list`): búsqueda híbrida (FTS5 + vectores del bi-encoder en gpuhost, `EMBED_URL`) con
degradación a léxica, lectura y listado. El índice lo mantiene el web-server (reconciliador);
acá sólo se lee. Config: `NOTES_MCP_SECRET` + `NOTES_MCP_HMAC_KEY` (ambas o OFF), `NOTES_MCP_URL`
(`https://ceibo.example.com/mcp/notes/<secret>`, mismo secret embebido — fail-fast al bootear),
`NOTES_MCP_PORT` (default 8831), `EMBED_URL`/`EMBED_MODEL` opcionales. nginx: `proxy_pass` de
`/mcp/notes/` al puerto SIN strip. Con `NOTES_WRITE_MODE=db` (F3c) el server monta también las tools de escritura del contrato (`notes_write`/`notes_create`/`notes_delete`/`notes_move`/`notes_batch`, conflicto como dato). Eval de calidad: `pnpm --filter @ceibo/gateway
eval:notes-recall -- --cases <casos.json>` (grep vs léxica vs semántica vs híbrida — el gate de
F3 del plan db).

## Scope

Estás trabajando en `@ceibo/gateway`. Editá **solo** dentro de `packages/gateway/`. Si el
cambio necesita tocar otros paquetes, pará: declará el scope cruzado en
`.claude/active-scope` (ej. `gateway <otro>`) o vacialo si el cambio cruza a propósito —
no edites otros paquetes "de paso". El guard de scope lo enforcea. Ver el `CLAUDE.md` raíz.
