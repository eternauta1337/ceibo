#!/usr/bin/env python3
# Fase 2 del refactor de wikis: aplanar `notes/` y `projects/` a la raíz del repo.
# La distinción notes vs projects no existe en el modelo plano — la raíz ES un
# workspace top-level.
#
# Operaciones:
#   <wiki>/notes/*    → <wiki>/*      (mergea _archived si ya existe en raíz)
#   <wiki>/projects/* → <wiki>/*      (mergea _archived si ya existe en raíz)
#   borra notes/ y projects/ vacías al final.
#   regenera _index.md en cada carpeta viva (sin frontmatter, sin _archived/).
#
# Uso: migrate-flatten-root.py [--apply] <wiki_dir>

import argparse
import os
import re
import shutil
import sys
from pathlib import Path

FRONTMATTER_RE = re.compile(r"\A---\n.*?\n---\n", re.DOTALL)


def first_preview_line(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return ""
    m = FRONTMATTER_RE.match(text)
    if m:
        text = text[m.end():]
    stem_lower = path.stem.lower()
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        s = re.sub(r"^-\s*\[\s*[ xX]?\s*\]\s*", "", s).strip()
        if not s or s.lower() == stem_lower:
            continue
        return s[:120]
    return ""


def merge_dir(src: Path, dst: Path):
    """Mueve contenido de src dentro de dst, mergeando recursivamente. Borra src vacía."""
    dst.mkdir(parents=True, exist_ok=True)
    for child in list(src.iterdir()):
        target = dst / child.name
        if child.is_dir():
            if target.exists():
                merge_dir(child, target)
            else:
                shutil.move(str(child), str(target))
        else:
            if target.exists():
                if child.name == "_index.md":
                    # se regenera después; descartamos uno
                    child.unlink()
                    continue
                print(f"  WARN colisión: {target} ya existe; salteo {child}")
                continue
            shutil.move(str(child), str(target))
    try:
        src.rmdir()
    except OSError as e:
        print(f"  WARN no pude borrar {src}: {e}")


def flatten_root(root: Path) -> tuple[int, int]:
    moves = 0
    merges = 0
    for wrapper in ("notes", "projects"):
        wdir = root / wrapper
        if not wdir.is_dir():
            continue
        for child in list(wdir.iterdir()):
            target = root / child.name
            if child.name == "_index.md":
                # se regenera al final; descartamos
                child.unlink()
                continue
            if target.exists():
                if child.is_dir():
                    merge_dir(child, target)
                    merges += 1
                else:
                    print(f"  WARN colisión: {target} ya existe; salteo {child}")
                continue
            shutil.move(str(child), str(target))
            moves += 1
        try:
            wdir.rmdir()
        except OSError as e:
            print(f"  WARN {wrapper}/ no quedó vacía: {e}")
    return moves, merges


def generate_indexes(root: Path):
    """Genera _index.md en cada carpeta no-archivada que tenga > 1 hijos relevantes."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d != ".git")
        rel_parts = Path(dirpath).relative_to(root).parts
        if any(p == "_archived" for p in rel_parts):
            dirnames[:] = []
            continue
        md_files = sorted(f for f in filenames if f.endswith(".md") and f != "_index.md")
        subdirs = sorted(d for d in dirnames if not d.startswith("."))
        if not md_files and not subdirs:
            continue
        # raíz: nombramos por carpeta del repo
        title = Path(dirpath).name if dirpath != str(root) else root.name
        lines = [f"# {title}", ""]
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


def plan(root: Path) -> dict:
    p = {"notes_kids": [], "projects_kids": [], "merges_expected": []}
    for wrapper in ("notes", "projects"):
        wdir = root / wrapper
        if not wdir.is_dir():
            continue
        for child in wdir.iterdir():
            key = f"{wrapper}_kids"
            p[key].append(child.name)
            if (root / child.name).exists() and child.name not in ("_index.md",):
                p["merges_expected"].append(f"{wrapper}/{child.name} → root/{child.name} (merge)")
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("wiki_dir")
    args = ap.parse_args()
    root = Path(os.path.expanduser(args.wiki_dir)).resolve()
    if not root.is_dir():
        print(f"no existe: {root}", file=sys.stderr); sys.exit(2)
    pl = plan(root)
    print(f"=== flatten-root para {root} ===")
    print(f"  notes/ kids: {pl['notes_kids']}")
    print(f"  projects/ kids: {pl['projects_kids']}")
    if pl["merges_expected"]:
        print(f"  merges esperados:")
        for m in pl["merges_expected"]:
            print(f"    - {m}")
    if not args.apply:
        print("\n(dry-run; pasa --apply para ejecutar)")
        return
    moves, merges = flatten_root(root)
    print(f"\n  moves: {moves} | merges: {merges}")
    generate_indexes(root)
    print(f"aplicado.")


if __name__ == "__main__":
    main()
