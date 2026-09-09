# Tests de los bordes I/O (Ola 6)

Cierra los huecos de coverage que quedan tras las olas 1-5: el I/O irreducible que los unit no tocan y los e2e fakean por arriba. Dos frentes independientes (sockets y shell-out); se pueden encarar por separado.

## Objetivo

- Ejercitar el cableado de **transporte de bajo nivel** (los sockets de los channels) y el **shell-out a binarios externos** (ffmpeg/python/ghostscript/ wacli) con el proceso/red **mockeados** — hermético, en CI.
- Distinto de la Ola 5: ahí el transporte era REAL y fakeábamos el borde lógico. Acá fakeamos `node:net` / `child_process` para cubrir el manejo de frames y el parseo de stdout/exit, que es justo lo que la Ola 5 no toca.

## Frente A — sockets de channels

Archivos: `channels/cli.ts`, `channels/remote.ts`, `channels/client.ts`.

- Mock de `**node:net**` (server + socket fakes que emiten `data`/`close`/`error`).
- Qué verificar:
  - framing NDJSON: parseo de mensajes partidos en varios `data`, líneas pegadas, basura → no rompe
  - handshake: `hello` con `externalId` → `ready`; `msg` → `port.handleIncoming`
  - auth / rechazo de `externalId` no autorizado
  - egress: `out`/`typing` se serializan y escriben al socket correcto
  - broadcast de `postTarget` a multiples sockets conectados
  - reconexión / limpieza al `close`
- El e2e de cli (#38) ya cubre el camino feliz por socket real; acá se cubren los bordes de parseo/error que un loopback feliz no ejercita.

## Frente B — shell-out profundo

Archivos: `speech/index.ts` (ffmpeg/python), `mcps/servers/wacli.ts` (binario wacli), `mcps/core/pdf.ts` (ghostscript), `gateway/wacli.ts` (spawn del follow).

- Mock de `**child_process**` (`spawn`/`execFile`): fake que controla `stdout`/`stderr`/`exit code` y permite assert sobre los **argv** construidos.
- Qué verificar:
  - se arma la línea de comando correcta (flags, paths, encoding) para cada caso
  - parseo de stdout (ej. la transcripción, el ndjson del follow de wacli)
  - manejo de exit ≠ 0 / stderr / timeout / proceso que muere
  - cleanup de temporales y de procesos colgados
- NO ejecutar los binarios reales (no están en CI, son lentos, no deterministas). Solo el contrato con ellos.

## Decisiones / riesgos

- Los helpers PUROS de estos archivos ya se cubrieron en la Ola 2 (parsers, validadores). Lo que queda acá es estrictamente el `spawn`/socket — menos ROI por línea, por eso va al final.
- El mock de `child_process` es frágil si se sobre-especifica el argv exacto; assertar lo esencial (binario + flags clave), no la línea entera.
- Meta: subir `channels` 35→60, `speech` 39→60, `gateway/wacli` 27→55, `mcps/wacli` y `pdf` a \~70. Global, empujón final hacia \~55-60.

## Tareas

- [ ] Helper de fake de `node:net` reutilizable (server + socket)
- [ ] Tests de framing/handshake/auth/broadcast de `cli`/`remote`/`client`
- [ ] Helper de fake de `child_process` (stdout/exit/argv capture)
- [ ] Tests de `speech` (ffmpeg/python), `wacli`, `pdf` (ghostscript)
- [ ] Subir pisos del ratchet de los archivos cubiertos
- [ ] Actualizar [unit-and-ci](unit-and-ci.md)
