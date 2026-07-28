---
name: wiki-notes
description: >-
  Convención de las wikis del usuario: cada archivo es una nota, las carpetas son
  workspaces, las tareas son `- [ ]` dentro de notas; archivar una nota = borrarla y
  anotarla en `.archived.md` (queda en la historia de git).
  Usar cuando el usuario quiere crear/leer/mover/listar/archivar notas o tareas en sus
  wikis markdown.
---

# Notas en las wikis

Las wikis del usuario son repos git (montados como working copy en tu dir de trabajo).
Convención deliberadamente plana:

- **Un archivo `.md` es una nota.** No hay tipos distintos (no hay "tareas" como
  entidad propia).
- **Las carpetas son workspaces** — agrupan notas relacionadas. La carpeta no
  significa nada sobre el contenido (no es "estado", no es "categoría"). **La
  raíz del repo es el workspace top-level**: notas sueltas viven directo en la
  raíz; sub-carpetas son sub-workspaces (ej. un proyecto, un tema). No hay
  envoltorios `notes/` ni `projects/`.
- **Una tarea es un `- [ ]` dentro de una nota.** Si está marcado `- [x]`, ya
  se hizo. Cualquier nota puede tener cero, una o muchas tareas.
- **Archivar = sacar de la vista, conservar en la historia.** No hay carpeta especial:
  archivar una nota es **borrarla** y anotarla en el `.archived.md` de su carpeta. El
  contenido sale de la working copy pero queda en la historia de git (recuperable). Para
  listar/buscar notas vivas no salteás nada — lo archivado ya no está ahí. Solo mirás
  `.archived.md` cuando el pedido es sobre lo archivado ("qué archivé de X", "recuperá Y").
- **Las notas vivas se encuentran greppeando/leyendo el corpus local.** Tenés el repo entero
  en la working copy: `grep`/`rg` sobre ella es tu herramienta para encontrar cualquier nota —
  no hay índice manual que mantener ni actualizar.
- **`.archived.md`** en cada carpeta es el índice de lo archivado de esa carpeta (no se
  muestra en la web). *(Las wikis viejas pueden tener el nombre legacy `_archivado.md`: tratalo
  igual — leelo y agregá entradas ahí si ya existe; sólo al crearlo de cero usá `.archived.md`.)* Sus links apuntan a archivos **BORRADOS A PROPÓSITO** (viven en la historia,
  se recuperan con `recall`/`search-archived`) — **NO son links rotos**. Solo AGREGÁS entradas
  al archivar; **NUNCA** las quitás ni "limpiás"/vacías el archivo por apuntar a archivos
  inexistentes. Borrar esas entradas = perder el índice de lo archivado.

## Operaciones

Trabajás sobre la **working copy local** con tus tools de escritura, y subís los cambios
con el **script de sync** de tu entorno (un commit por push). Mirá tu adapter para la
invocación exacta del script. **NUNCA uses git crudo** (`git pull`/`clone`/`fetch`/`push`)
para sincronizar una wiki: en tu entorno el git nativo se cuelga — bajar/refrescar/subir va
SIEMPRE por el script de sync, con su verbo (`hydrate`/`pull`/`push`).

**Crear una nota** → escribí un `.md` nuevo en `<workspace>/<título legible>.md`. Sin
frontmatter salvo que la convención puntual de esa wiki diga otra cosa.

**Agregar una tarea** → editás la nota relevante y agregás un `- [ ]`. Si no
hay nota natural donde meterla, creás una nueva.

**Marcar una tarea hecha** → cambiás `- [ ]` por `- [x]` en la nota.

**Listar pendientes** → grep por `- [ ]` en el workspace (o en toda la wiki). Lo archivado
no aparece (ya no está en la working copy).

**Mover una nota entre workspaces** → escribí el archivo en el destino y borralo en el
origen (git reconoce el rename si el contenido casi no cambia). Borrar es seguro: queda en
la historia.

**Archivar una nota** → borrá el `.md` y agregá una línea en el `.archived.md` de su
carpeta (creálo si no existe): `- [título](archivo.md) — fecha — preview`. Las dos cosas en
UN push. Distinto de **descartar basura** (una nota que no sirve): ahí borrás sin anotar
en `.archived.md` (igual queda en la historia, pero no se indexa). **Confirmá con el
usuario antes de archivar en lote.**

**Buscar en lo archivado** → por **título/preview** alcanza con grepear los `.archived.md`
(los tenés en la working copy). Por **contenido** (el término está en el cuerpo de una nota
archivada, que NO está en la working copy) corré el verbo `search-archived <wiki> <término>`
del script de sync: lee las notas archivadas desde la historia y devuelve los matches con su
path. No cubre lo descartado-como-basura (borrado sin anotar en `.archived.md`).

**Recuperar una nota archivada** → corré el verbo `recall` del script de sync con el path
original (lo sacás del `.archived.md` o de un `search-archived`): trae la última versión viva
desde la historia a la working copy. Después sacá su línea del `.archived.md` y hacé un push
— vuelve a estar viva.

**Mantener el índice de archivado** → al archivar una nota, agregá su línea en el
`.archived.md` de esa carpeta (creálo si no existe).
Formato: `- [título](archivo.md) — fecha — preview`.

## Tareas vs recordatorios (crons)

Una tarea es un `- [ ]` persistente en una nota. Un **cron** (`schedule_*`)
dispara un prompt al vencer y no deja archivo. "Acordame de X a tal hora" →
cron. "Anotá que hay que hacer X" → agregás `- [ ]` a una nota.
