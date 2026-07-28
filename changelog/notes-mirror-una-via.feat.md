Espejo git de una vía (feature db, F3b): las escrituras del contrato de notas
(note_versions) se exportan como commits normales al MISMO repo de siempre — backup
continuo (RPO~0), historia que sigue sin cortarse, autoría real (gitAuthorFor del autor
de la versión). Conflictos reintentan con head fresco sin perder nada; NOTES_MIRROR=0
lo apaga. Pre-cutover es un no-op (no hay writes del contrato todavía).
