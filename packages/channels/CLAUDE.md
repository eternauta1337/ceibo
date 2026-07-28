# @ceibo/channels

Capa de canales: contrato channel-agnostic (PostTarget, ChannelPolicy, facts) + canales (telegram, cli, whatsapp) + canal remoto. El gateway los monta; ningún canal importa el core.

- **Depende de (interno):** agent, store
- **Consumido por:** gateway, web-server

## Canal WhatsApp (`whatsapp.ts` + `wacli-*.ts`)

El número **propio de ceibo** (el "bot") vía `wacli` (whatsmeow), espejo del canal Telegram:
la gente le escribe al bot y el agente responde. Mismo contrato (`port.handleIncoming` +
`postTarget`) → los slash-commands salen gratis (viven en el core, no en el canal). WhatsApp
no tiene menú de autocomplete de comandos: funcionan tipeándolos.

- **Recepción**: `wacli sync --follow --download-media --webhook <loopback> --webhook-secret`
  (respawn con backoff) → `WacliWebhookServer` valida el HMAC → `normalizeWebhookMessage`
  (pura, testeable) → `handleIncoming`. **v1 sólo DMs** (descarta `@g.us`).
- **Egress**: `post`→`wacli send text` (chunked), `postVoice`→`wacli send voice`, `startTyping`
  no-op (cada presence abriría otro socket que patearía el follow). `postTarget(jid)` sirve
  también el egress proactivo (crons/REM).
- **Media entrante** (voz STT / imágenes / PDF): read-only desde el store del bot vía
  `readWacliMediaInfoAt`/`fetchWacliMediaBytes` de `@ceibo/store` (sin tomar el lock del follow).
- **NO confundir** con el wacli per-usuario de `@ceibo/mcps` (ése **lee** el WhatsApp del
  usuario). Este es el número del bot, en `wacliBotStoreDir()`, pareado aparte:
  `pnpm --filter @ceibo/channels pair-bot`. Lo prende `WHATSAPP_BOT_ENABLED` en el gateway.

## Scope

Estás trabajando en `@ceibo/channels`. Editá **solo** dentro de `packages/channels/`. Si el
cambio necesita tocar otros paquetes, pará: declará el scope cruzado en
`.claude/active-scope` (ej. `channels <otro>`) o vacialo si el cambio cruza a propósito —
no edites otros paquetes "de paso". El guard de scope lo enforcea. Ver el `CLAUDE.md` raíz.
