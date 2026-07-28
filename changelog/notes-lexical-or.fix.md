Búsqueda léxica de notas: tokens unidos por OR en vez del AND implícito de FTS5 — con
queries reales (paráfrasis) el AND daba 0% hit@5; con OR la léxica sube a 56-69% y la
híbrida queda en hit@5 69% / MRR 0.65 vs grep 31% / 0.20 (eval sobre la wiki real,
16 queries). + fix del parseo de `--` en eval:notes-recall.
