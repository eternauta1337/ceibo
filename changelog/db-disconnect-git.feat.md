Notas desconectadas de git (feature db, F4): el agente archima (coordinador y worker) pasa a
leer y escribir notas SOLO por las tools del servicio `notes` (notes_search/read/list +
create/write/delete/move/batch) en vez de git+archivos. En modo DB el git push del agente
(git-receive-pack) queda bloqueado (409). Con NOTES_MIRROR=0 en el entorno, git queda del
todo fuera del camino de notas (repos congelados como archivo en el tiempo).
