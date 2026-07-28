Índice derivado de notas en la DB (feature db, F1): tablas `notes`/`notes_fts` (FTS5) +
`note_chunks` (vectores del bi-encoder en gpuhost, `EMBED_URL`) mantenidas por un
reconciliador en web-server contra `wiki_heads`. Git sigue siendo fuente de verdad; el
índice se puede reconstruir entero (guard por wiki: head + modelo de embeddings).
