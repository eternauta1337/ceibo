# crons-delivery — canal de origen + inbox durable a web

> Estado: **plan de trabajo, diseño cerrado con el owner** (2026-06-21) · autor: claude (opus). Diseño fino acordado en sesión; falta implementar (worktree `feat/cron-delivery-channel` desde `dev`). Carpeta: `~/wiki/ceibo/tecnico/features/crons-delivery/`.

**Problema:**  el delivery por default de los crons es **siempre Telegram**, sin importar desde qué canal lo creaste. Debería entregar en el **canal donde fue creado** (web, telegram, whatsapp). Hoy si agendás un recordatorio desde la web, te pinta en Telegram — raro.

## Causa (validada 2026-06-21, read-only)

No es un olvido; es plumbing que falta + una limitación real de la entrega web.

- **El default está hardcodeado en un solo lugar:**  `packages/mcps/src/servers/schedule.ts:150`

  ```ts
  const row = createCron(db(), {
    userId,
    channel: "telegram", // v1: único canal de egress
    ...
  ```

  El fire-path (`cronTarget()` en `packages/gateway/src/index.ts:147-166`) honra ese valor; cualquier valor desconocido cae también a Telegram.
- **El MCP** `**schedule**` **es stateless/global.**  Recibe solo un Bearer firmado `<userId>.<exp>.<hmac>` → saca **únicamente el userId**. El canal desde el que hablás **no le llega**. Se conoce arriba en `handleIncoming` (`engine.ts:1107`) pero no se hilvana hasta `prepareSession` (`engine.ts:389`), que es donde se mintea el token del cron.
- **La entrega a web hoy se pierde offline.**  `channels/src/remote.ts:75-79`:  *"Si no hay clienteconectado, los posts se descartan silenciosamente."*  No hay inbox, ni cola, ni persistencia del output del cron. Por eso `web-server/src/web.ts:2452` **excluye web a propósito** del selector de canal:  *"Web queda afuera del delivery por ahora (no entrega offline / sin notificaciones)."* Telegram/WhatsApp son los únicos canales con entrega offline garantizada.

**Conclusión:**  "default = canal de origen" exige dos mitades. (1) hilvanar el canal de origen al cron; (2) hacer la entrega a web **durable** (inbox persistente + UI de notificaciones), si no un cron creado en web se pierde offline. El owner eligió el **alcance completo (las dos mitades)** .

## UI de la web hoy (relevante para el diseño)

- El chat es un **popup** (FAB abajo a la derecha), **un solo hilo continuo y efímero** (se borra al recargar — no hay historial persistido). `packages/web/src/App.tsx`, `useChannel.ts`.
- **No existe NINGUNA UI de notificaciones:**  cero unread/badge/toast para mensajes, el título del browser no cambia, no hay campanita ni inbox. (El único toast es para ops de archivos del Explorer.)
- La **Agenda** (system page, se abre del launcher) lista crons **futuros** nomás — sin historial de disparos/resultados. Ya muestra un badge de canal (Telegram/WhatsApp/Web).
- No hay tipo de frame "cron disparó"; los frames son text/voice/typing/notice/activity/etc.

## Decisiones cerradas con el owner (2026-06-21)


1. **Alcance: completo** — canal de origen  **+**  entrega durable a web.
2. **Click en una notificación → se abre en el CHAT** (burbuja del agente re-inyectada desde el inbox persistido; no vive en el chat, se baja al clickear). Burbuja "de lectura": si respondés, el agente sigue tu sesión actual (no rehidrata el contexto del turno del cron) — OK para v1.
3. **Cron de web que dispara estando offline → solo espera en el inbox web.**  Sin respaldo a Telegram. "Canal donde fue creado" puro. (Trade-off aceptado: un recordatorio con hora se puede pasar si no abrís la web a tiempo.)
4. **Badge en un FAB propio** (🔔 con contador de no-leídos), al lado del chat-fab.
5. **Inbox genérico del agente** — crons primero, pero tabla/UI diseñadas para sumar REM, avisos del sistema, push del viewer, etc.

## Plan de implementación

Cross-cutting deliberado: `store gateway mcps web-server web` (+`channels`). `active-scope` vacío en el worktree; verificar con `pnpm -r typecheck`. Va a **PR contra** `**dev**` y **NO se mergea** (queda para OK del owner). Un solo PR (feature cohesivo).

### 1. `store` (hoja profunda — el contrato)

- **Tabla nueva** `**inbox**` (genérica) en `SCHEMA` (junto a las demás `CREATE TABLE IF NOT EXISTS`, \~`packages/store/src/index.ts:533`): `id, user_id, kind ('cron'|'rem'|'system'|'viewer'), source_id (nullable), title, body, created_at, read_at (null = no leído)` \+ índice `(user_id, read_at)`. Aditivo y seguro (tabla nueva, sin ALTER; el mecanismo `SCHEMA` + `migrate()` ya existe).
- Funciones: `addInboxItem`, `listInbox(userId,{limit})`, `countUnread(userId)`, `markInboxRead(userId,id)`, `markAllInboxRead(userId)`.
- **Desacoplar el token de schedule.**  Hoy `signScheduleToken = signUserToken` y `verifyScheduleToken = verifyUserToken` (`index.ts:3053-3054`) — **alias del genérico**, que comparten wacli/viewer/control/wiki-sync/rem-batch/cookie web. **NO tocar el genérico.**  Crear funciones propias de schedule con formato de 4 partes `<userId>.<channel>.<exp>.<mac>`: `signScheduleToken(userId, channel, key)` y `verifyScheduleToken(token,key) → {userId, channel?}`. `schedule.ts` es el único consumidor de `verifyScheduleToken`, así que cambiar su shape es seguro. Tolerar tokens viejos de 3 partes (`channel` → `undefined`).

### 2. `gateway` + `mcps`

- **Origen del canal:**  hilvanar `channel` desde `handleIncoming` → `openRelay`/`prepareSession` (`engine.ts:389`) para mintear el token de schedule **con el canal de la sesión**.
- `**mcps/src/servers/schedule.ts**` **:**  usar el `channel` del token en vez del `"telegram"` hardcodeado (línea 150). Fallback `telegram` si el token no lo trae.
- **Fire-path** (`cronTarget` en `index.ts` + `fireOne` en `engine.ts:2797`): manejar `channel === "web"` → **persistir el resultado en** `**inbox**` (durable, siempre)  **+**  si hay conexión web viva, broadcast en vivo de un frame nuevo `inbox` (para que el badge suba al instante). **Sin** fallback a Telegram. Para capturar el texto: un `PostTarget` que envuelve el remote, acumula el texto del turno y en `turnDone` inserta la fila de inbox.

### 3. `web-server`

- `GET /api/inbox` → items + unread count. `POST /api/inbox/:id/read`, `POST /api/inbox/read-all`.
- Sacar el filtro que excluye `web` del selector de canal de crons (`web.ts:2452`) — web ya es un canal de entrega válido.

### 4. `web` (front)

- **FAB 🔔 propio** con contador de no-leídos (lee `GET /api/inbox` al cargar; sube en vivo con el frame `inbox`).
- **Panel de notificaciones:**  lista (título, hora, punto leído/no-leído).
- **Click en item → abre el chat e inyecta la burbuja** (role agente) con el `body`; marca leído (`POST`), baja el badge.
- Nuevo tipo de frame `inbox` en `useChannel.ts` para el push en vivo (solo sube el badge; no auto-inyecta — ver es por click).

### Tests

- `store`: inbox CRUD + token de schedule con canal (sign/verify, compat 3-partes).
- `gateway`: fire a `web` persiste en inbox y NO va a Telegram; fire a telegram/whatsapp sin cambios.
- `web-server`: endpoints `/api/inbox`.

## Limitación v1 conocida (documentar en el PR)

El canal se fija **al abrir la sesión**, no por-mensaje (el token de schedule es un credential estático del vault, seteado una vez por sesión en `engine.ts:385`). Si abrís sesión en Telegram y luego hablás por web en la **misma** sesión, el cron toma el canal de apertura. Para el uso real coincide casi siempre.

## Estado

> **Sin implementar** (2026-06-21). Worktree `feat/cron-delivery-channel` creado desde `origin/dev`, vacío. Próximo paso: implementar con loop de autocorrección → `pnpm -r typecheck`/`lint`/`test` verdes → PR a `dev` (sin mergear).

Memorias relacionadas: `connect-link-out-of-band`, `no-merge-without-explicit-ok`.
