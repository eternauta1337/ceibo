MCP `notes` (feature db, F2): el agente busca en las notas por significado — `notes_search`
híbrida (FTS5 + vectores) sobre el índice derivado, con identidad por-usuario (Bearer HMAC,
scope por `repo_access`) y degradación a léxica si gpuhost no responde. + `notes_read`/
`notes_list`, prompt de archima actualizado (búsqueda primero, grep como fallback), y eval
`eval:notes-recall` (grep vs léxica vs semántica vs híbrida) como gate de F3.
