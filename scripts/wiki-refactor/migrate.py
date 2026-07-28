#!/usr/bin/env python3
# Aplana la wiki al modelo nuevo: workspaces sin distinción tarea/nota,
# `archived/` → `_archived/`, y `_index.md` por carpeta viva.
#
# Reglas:
#   projects/<p>/tasks/{pending,staged,active}/X.md  → projects/<p>/X.md
#       (strip frontmatter; strip "## Notas" header; prepend "- [ ] <title>")
#   projects/<p>/tasks/{done,archived}/X.md          → projects/<p>/_archived/X.md
#       (strip frontmatter; strip "## Notas" header; sin checkbox)
#   projects/<p>/notes/X.md                          → projects/<p>/X.md
#   projects/<p>/notes/archived/X.md                 → projects/<p>/_archived/X.md
#   <any>/archived/                                  → <any>/_archived/  (recursivo)
#   notes/X.md (root) y notes/archived/ (root) — análogo (workspace top-level "notes")
#
# Uso: migrate.py [--apply] <wiki_dir>

import argparse
import os
import re
import shutil
import sys
from pathlib import Path

FRONTMATTER_RE = re.compile(r"\A---\n.*?\n---\n", re.DOTALL)
NOTAS_HEADER_RE = re.compile(r"\A##\s*Notas\s*\n+", re.IGNORECASE)


def strip_task_metadata(text: str) -> str:
    """Quita frontmatter de tarea (status/due/priority/created/huly_id) y header '## Notas'."""
    m = FRONTMATTER_RE.match(text)
    if m:
        fm = m.group(0)
        # Si parece frontmatter de tarea, lo dropeamos entero. Como umbral: contiene "status:".
        if re.search(r"^status:", fm, re.MULTILINE):
            text = text[m.end():]
    text = NOTAS_HEADER_RE.sub("", text.lstrip("\n"))
    return text.rstrip() + "\n"


def title_from_filename(path: Path) -> str:
    return path.stem


class Plan:
    def __init__(self, root: Path):
        self.root = root
        self.moves: list[tuple[Path, Path, str]] = []  # (src, dst, kind)
        self.renames: list[tuple[Path, Path]] = []    # (src, dst) — archived → _archived
        self.deletes: list[Path] = []                  # archivos a borrar (CLAUDE.md)
        self.indexes: list[Path] = []                  # carpetas donde generar _index.md

    def add_move(self, src: Path, dst: Path, kind: str):
        self.moves.append((src, dst, kind))

    def add_rename(self, src: Path, dst: Path):
        self.renames.append((src, dst))

    def report(self):
        print(f"\n=== plan para {self.root} ===")
        by_kind: dict[str, int] = {}
        for _, _, k in self.moves:
            by_kind[k] = by_kind.get(k, 0) + 1
        for k, n in sorted(by_kind.items()):
            print(f"  {k}: {n} archivos")
        print(f"  renames archived→_archived: {len(self.renames)}")
        print(f"  deletes (CLAUDE.md per-wiki): {len(self.deletes)}")
        print(f"  _index.md a generar: {len(self.indexes)}")

    def report_verbose(self, limit: int = 8):
        self.report()
        from collections import defaultdict
        groups = defaultdict(list)
        for s, d, k in self.moves:
            groups[k].append((s, d))
        for k, items in groups.items():
            print(f"\n  -- {k} (muestra hasta {limit}) --")
            for s, d in items[:limit]:
                print(f"    {s.relative_to(self.root)} → {d.relative_to(self.root)}")
            if len(items) > limit:
                print(f"    ... y {len(items) - limit} más")
        if self.renames:
            print(f"\n  -- renames archived→_archived (muestra) --")
            for s, d in self.renames[:limit]:
                print(f"    {s.relative_to(self.root)} → {d.relative_to(self.root)}")
            if len(self.renames) > limit:
                print(f"    ... y {len(self.renames) - limit} más")


def plan_wiki(root: Path) -> Plan:
    plan = Plan(root)

    # 1) projects/<p>/tasks/{pending,staged,active}/X.md  → projects/<p>/X.md
    # 2) projects/<p>/tasks/{done,archived}/X.md          → projects/<p>/_archived/X.md
    # 3) projects/<p>/notes/X.md                          → projects/<p>/X.md
    # 4) projects/<p>/notes/archived/X.md                 → projects/<p>/_archived/X.md
    projects_dir = root / "projects"
    if projects_dir.is_dir():
        for p_dir in sorted(projects_dir.iterdir()):
            if not p_dir.is_dir():
                continue
            if p_dir.name == "archived":
                # toda esta rama es archivo histórico; sólo recibirá rename → _archived
                continue
            tasks_dir = p_dir / "tasks"
            if tasks_dir.is_dir():
                # archivos sueltos en tasks/ (ej. Session.vim) → subir a projects/<p>/
                for f in tasks_dir.iterdir():
                    if f.is_file():
                        plan.add_move(f, p_dir / f.name, "stray→flat")
                for state_dir in tasks_dir.iterdir():
                    if not state_dir.is_dir():
                        continue
                    state = state_dir.name
                    if state in ("pending", "staged", "active"):
                        for f in state_dir.iterdir():
                            if not f.is_file():
                                continue
                            kind = "open-task→flat" if f.suffix == ".md" else "stray→flat"
                            plan.add_move(f, p_dir / f.name, kind)
                    elif state in ("done", "archived"):
                        for f in state_dir.iterdir():
                            if not f.is_file():
                                continue
                            kind = "closed-task→_archived" if f.suffix == ".md" else "stray→_archived"
                            plan.add_move(f, p_dir / "_archived" / f.name, kind)
            notes_dir = p_dir / "notes"
            if notes_dir.is_dir():
                for f in notes_dir.iterdir():
                    if not f.is_file():
                        continue
                    kind = "project-note→flat" if f.suffix == ".md" else "stray→flat"
                    plan.add_move(f, p_dir / f.name, kind)
                notes_archived = notes_dir / "archived"
                if notes_archived.is_dir():
                    for f in notes_archived.iterdir():
                        if not f.is_file():
                            continue
                        kind = "project-archived-note→_archived" if f.suffix == ".md" else "stray→_archived"
                        plan.add_move(f, p_dir / "_archived" / f.name, kind)

    # 5) notes/X.md (top-level): stays in notes/ (it's a workspace itself).
    # 6) notes/archived/ rename handled in the recursive archived→_archived pass below.

    # 7) Recursive archived → _archived (catches projects/archived, notes/archived top,
    #    y cualquier *archived* anidada que haya quedado dentro de proyectos archivados).
    #    Lo hacemos BFS para renombrar carpetas internas correctamente después del move.
    for dirpath, dirnames, _ in os.walk(root):
        # No descender en .git
        dirnames[:] = [d for d in dirnames if d != ".git"]
        for d in list(dirnames):
            if d == "archived":
                src = Path(dirpath) / d
                dst = Path(dirpath) / "_archived"
                plan.add_rename(src, dst)

    # CLAUDE.md per-wiki: borrar (la convención queda en el CLAUDE.md raíz del wiki + agent.yaml).
    claude_md = root / "CLAUDE.md"
    if claude_md.exists():
        plan.deletes.append(claude_md)

    return plan


def apply_plan(plan: Plan):
    root = plan.root
    # 1) Moves (con strip de frontmatter/header según kind).
    for src, dst, kind in plan.moves:
        dst.parent.mkdir(parents=True, exist_ok=True)
        text = src.read_text(encoding="utf-8")
        if kind == "open-task→flat":
            body = strip_task_metadata(text)
            checkbox = f"- [ ] {title_from_filename(src)}\n\n"
            new = checkbox + body if body.strip() else checkbox.rstrip() + "\n"
            dst.write_text(new, encoding="utf-8")
            src.unlink()
        elif kind == "closed-task→_archived":
            body = strip_task_metadata(text)
            dst.write_text(body if body.strip() else "\n", encoding="utf-8")
            src.unlink()
        elif kind in ("project-note→flat", "project-archived-note→_archived",
                      "stray→flat", "stray→_archived"):
            # nota o stray: sin transformación de contenido
            if dst.exists():
                print(f"  WARN destino existe, salteo: {dst.relative_to(root)} (src={src.relative_to(root)})")
                continue
            shutil.move(str(src), str(dst))
        else:
            raise RuntimeError(f"kind desconocido: {kind}")

    # 2) Borrar carpetas vacías que sobraron (bottom-up).
    EMPTY_CLEANUP_NAMES = {"tasks", "notes", "pending", "staged", "active",
                            "done", "archived", "_archived"}
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        dirnames[:] = [d for d in dirnames if d != ".git"]
        name = Path(dirpath).name
        if name in EMPTY_CLEANUP_NAMES:
            try:
                if not any(Path(dirpath).iterdir()):
                    os.rmdir(dirpath)
            except OSError:
                pass

    # 3) Renames archived → _archived (después de los moves para no chocar).
    # Re-evaluamos en vivo porque la estructura ya cambió.
    pending_renames = []
    for dirpath, dirnames, _ in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != ".git"]
        for d in list(dirnames):
            if d == "archived":
                pending_renames.append((Path(dirpath) / d, Path(dirpath) / "_archived"))
    # Renombrar de raíz-más-larga a más-corta para evitar pisar paths
    pending_renames.sort(key=lambda p: len(str(p[0])), reverse=True)
    for src, dst in pending_renames:
        if not src.exists():
            continue
        if dst.exists():
            # ya migrado por una rama anterior; mergear contenido
            for child in src.iterdir():
                target = dst / child.name
                if target.exists():
                    print(f"  WARN colisión en merge: {target} ya existe, salteo {child}")
                    continue
                shutil.move(str(child), str(target))
            try:
                src.rmdir()
            except OSError:
                pass
        else:
            src.rename(dst)

    # 4) Deletes (CLAUDE.md per-wiki).
    for f in plan.deletes:
        if f.exists():
            f.unlink()

    # 5) _index.md por carpeta viva.
    generate_indexes(root)


def first_preview_line(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return ""
    # saltea frontmatter si quedara
    m = FRONTMATTER_RE.match(text)
    if m:
        text = text[m.end():]
    stem_lower = path.stem.lower()
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):  # heading
            continue
        # quita marker de checkbox
        s = re.sub(r"^-\s*\[\s*[ xX]?\s*\]\s*", "", s).strip()
        if not s:
            continue
        # si la línea es sólo el título (post-checkbox = filename), seguí buscando
        if s.lower() == stem_lower:
            continue
        return s[:120]
    return ""


def generate_indexes(root: Path):
    """Genera _index.md en cada carpeta no-archivada que tenga > 1 hijos relevantes."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d != ".git")
        rel_parts = Path(dirpath).relative_to(root).parts
        # saltar carpetas archivadas (ni miramos)
        if any(p == "_archived" for p in rel_parts):
            dirnames[:] = []
            continue
        # saltar la raíz del repo (queda raro un _index.md en la raíz; opcional)
        if dirpath == str(root):
            continue
        md_files = sorted(f for f in filenames if f.endswith(".md") and f != "_index.md")
        subdirs = sorted(d for d in dirnames if not d.startswith("."))
        if not md_files and not subdirs:
            continue
        lines = [f"# {Path(dirpath).name}", ""]
        if md_files:
            for f in md_files:
                preview = first_preview_line(Path(dirpath) / f)
                if preview:
                    lines.append(f"- [{f[:-3]}]({f}) — {preview}")
                else:
                    lines.append(f"- [{f[:-3]}]({f})")
        if subdirs:
            if md_files:
                lines.append("")
            for d in subdirs:
                if d == "_archived":
                    lines.append(f"- `{d}/` — archivo frío (ignorar salvo pedido)")
                else:
                    n = sum(1 for x in (Path(dirpath) / d).rglob("*.md") if "_archived" not in x.parts)
                    lines.append(f"- [`{d}/`]({d}/) — {n} archivo{'s' if n != 1 else ''}")
        (Path(dirpath) / "_index.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Aplica los cambios. Sin esto, solo dry-run.")
    ap.add_argument("--verbose", "-v", action="store_true", help="Muestra muestras de moves.")
    ap.add_argument("wiki_dir", help="Path al repo wiki (ej. ~/wikis/personal)")
    args = ap.parse_args()

    root = Path(os.path.expanduser(args.wiki_dir)).resolve()
    if not root.is_dir():
        print(f"no existe: {root}", file=sys.stderr)
        sys.exit(2)

    plan = plan_wiki(root)
    if args.verbose:
        plan.report_verbose()
    else:
        plan.report()

    if args.apply:
        apply_plan(plan)
        print(f"\naplicado en {root}.")
    else:
        print("\n(dry-run; pasa --apply para ejecutar)")


if __name__ == "__main__":
    main()
