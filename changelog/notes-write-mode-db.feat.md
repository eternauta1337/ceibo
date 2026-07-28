Modo DB para las notas (feature db, F3c) detrás de NOTES_WRITE_MODE=db: el editor web
lee y escribe contra la DB (save = UPDATE transaccional con versión; sha del protocolo =
versión opaca → CERO cambios de front), el explorer y el GET tienen read-your-writes, y
el MCP notes gana tools de escritura (write/create/delete/move/batch, conflicto como
dato para que el modelo mergee). Default git: comportamiento de siempre.
