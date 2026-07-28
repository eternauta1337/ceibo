Tooling del cutover de F3 (git→DB fuente de verdad): modo mantenimiento/freeze por archivo
(touch/rm sin restart) que 503ea las escrituras de notas — editor, git push del agente y
sync commit — dejando pasar lecturas y ops estructurales; + verificación byte-a-byte DB vs
git HEAD (`cutover:verify`, exit 0 = flip seguro) como gate del flip.
