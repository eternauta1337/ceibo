Primitivas de escritura versionada de notas (feature db, F3a): `note_versions` (historial
canónico por save, con autor/origen) + create/write/delete/move/batch con optimistic
concurrency por versión entera. El conflicto devuelve el estado actual (merge3 sin GET
extra) y el batch es atómico con conflictos por-path (misma semántica que el commit del
substrato git). Aditivo: nada lo consume todavía — los escritores migran en F3c.
