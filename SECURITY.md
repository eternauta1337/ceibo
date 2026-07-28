# Seguridad

Este repo es una **muestra de trabajo archivada**. No hay un despliegue soportado ni un
canal de respuesta a incidentes: si encontrás algo, abrí un issue público — no hay
usuarios en riesgo detrás de este código.

Lo que sigue es lo que hay que saber si vas a correrlo de verdad.

## Modelo de amenaza asumido

El diseño supone:

- **Un único reverse proxy confiable** delante de los cuatro procesos. Los procesos
  escuchan en loopback y confían en que el proxy es el único camino.
- **El `.env` es el perímetro.** Todos los secretos viven ahí, `chmod 600`, fuera del
  repo. La DB por sí sola no alcanza para suplantar a nadie ni para leer credenciales
  OAuth: la clave de cifrado no está adentro.
- **Los path-secrets de los MCP se consideran filtrados.** Van en la URL, así que se
  asumen visibles en los access logs. Por eso la identidad se firma con una clave
  distinta.

## Lo que tenés que configurar bien

### `X-Forwarded-For` (importante)

El código toma el **último hop** de `X-Forwarded-For` como IP del cliente, tanto para el
rate limit como para la allowlist del proxy git (`WIKI_GIT_ALLOWED_IPS`).

Eso es correcto sólo si **tu reverse proxy sobrescribe o apendea ese header**. Si lo
propaga tal cual venga del cliente, la IP es controlada por el atacante y la allowlist es
spoofeable.

En nginx:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

Y asegurate de que los puertos de los procesos (8801, 8810, 8820, 8830, 8832) **no sean
alcanzables** salvo a través del proxy.

### Secretos que no son opcionales

| Variable | Si falta |
|---|---|
| `WEB_SESSION_KEY` | el web-server no arranca |
| `REMOTE_CHANNEL_SECRET` | el web-server no arranca |
| `OAUTH_ENC_KEY` | el broker se niega a escribir grants (nunca en claro) |
| `<NAME>_MCP_HMAC_KEY` | el server que firma identidad no monta |

Generá todo con `openssl rand -hex 32`. **Perder `OAUTH_ENC_KEY` deja todos los grants
ilegibles** — los usuarios tienen que reconectar sus cuentas. Backupéala junto con el
resto del `.env`.

### Access logs

Apagá el log de acceso en los locations `/mcp/`, o vas a tener los path-secrets en texto
plano en disco con rotación indefinida.

## Lo que ya está cubierto

- Passwords con scrypt (salt por usuario, parámetros embebidos).
- Tokens OAuth cifrados at-rest con AES-256-GCM, clave fuera de la DB.
- Comparación de secretos en tiempo constante en todos los gates.
- Cookies `HttpOnly; Secure; SameSite=Lax` y chequeo de origin anti-CSRF.
- Rate limit por IP en login y por usuario en POSTs autenticados.
- Gate único de paths relativos contra traversal, compartido por el editor y el agente.
- PKCE en el broker OAuth.
- Tokens de GitHub App efímeros y acotados al repo exacto, minteados por request.
- Toda consulta SQL usa parámetros bindeados; no hay concatenación de valores.
- Los tests del runtime de VMs fallan si se cuela un literal-secreto en el árbol.
