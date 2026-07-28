#!/usr/bin/env bash
# verify-prod.sh — verificar que el código deployado en la box es IDÉNTICO a un git ref.
#
# El motivo: `.deployed-sha` es un archivo que se escribe a mano y PUEDE MENTIR. Pasó
# (2026-06-21): prod corría código viejo aunque `.deployed-sha` decía `main`. El deploy
# escribió el sha pero no sincronizó nada. Este script NO confía en ese archivo: compara
# el CONTENIDO real (sha256 archivo por archivo) del árbol deployado contra el del ref.
#
# Es READ-ONLY: no toca la box, no deploya, no reinicia nada. Corrélo cuando quieras para
# responder "¿prod es REALMENTE origin/main?". También lo usa promote-prod.sh como guard
# post-deploy (aborta antes del restart si hay drift).
#
# Cómo funciona:
#   1. Lista los archivos TRACKED del ref bajo el scope de deploy (packages/ + raíz que
#      afecta runtime: package.json, pnpm-lock.yaml, patches/). Esa lista es la verdad.
#   2. Calcula sha256 de cada uno: localmente (desde `git archive`) y en la box.
#   3. Compara. Si difieren (contenido distinto o archivo faltante en la box) → DRIFT → exit 1.
#   Los archivos que existen SÓLO en la box (dist/, node_modules, locales) se ignoran: el
#   scope es "lo que el ref dice que tiene que estar", no "todo lo que hay en la box".
#
# Uso:
#   ./scripts/verify-prod.sh                       # compara origin/main vs prod
#   ./scripts/verify-prod.sh --ref origin/staging --box deploy@ceibo.example.com --tree ceibo-staging
#
# Exit: 0 = idéntico · 1 = DRIFT (lista los archivos) · 2 = error de uso/conexión.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="origin/main"
BOX="deploy@ceibo.example.com"
TREE="ceibo"
# Scope de deploy: paths tracked que afectan el runtime de la box.
SCOPE=(packages patches package.json pnpm-lock.yaml)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)  REF="$2"; shift 2 ;;
    --box)  BOX="$2"; shift 2 ;;
    --tree) TREE="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Uso: $0 [--ref <gitref>] [--box <user@host>] [--tree <dir>]" >&2; exit 2 ;;
  esac
done

# Hasher portable: sha256sum (linux) o shasum -a 256 (mac). Mismo hash hex, mismo formato.
if command -v sha256sum >/dev/null 2>&1; then LOCAL_HASH="sha256sum"; else LOCAL_HASH="shasum -a 256"; fi

echo "→ Verificando: ${BOX}:${TREE}  vs  ${REF}"
git -C "$REPO_ROOT" rev-parse --verify --quiet "${REF}^{commit}" >/dev/null || {
  echo "ERROR: ref '$REF' no existe localmente (¿hace falta 'git fetch origin'?)." >&2; exit 2; }
echo "   ${REF} = $(git -C "$REPO_ROOT" rev-parse --short "$REF")"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SRC="$TMP/tree"          # árbol extraído (lo que find recorre)
LOCAL_MAN="$TMP/local"   # manifests fuera de SRC, para que find no se incluya a sí mismo
REMOTE_MAN="$TMP/remote"
PATHS="$TMP/paths"
mkdir -p "$SRC"

# ── 1. Extraer el árbol tracked del ref (solo paths del scope que existan en el ref) ──
ARCHIVE_SCOPE=()
for p in "${SCOPE[@]}"; do
  git -C "$REPO_ROOT" cat-file -e "${REF}:${p}" 2>/dev/null && ARCHIVE_SCOPE+=("$p") || true
done
[[ ${#ARCHIVE_SCOPE[@]} -eq 0 ]] && { echo "ERROR: ningún path del scope existe en $REF." >&2; exit 2; }
git -C "$REPO_ROOT" archive "$REF" "${ARCHIVE_SCOPE[@]}" | tar -x -C "$SRC"

# ── 2. Manifest local: <path>\t<sha256>, ordenado por path ──
( cd "$SRC" && find . -type f -print0 | sort -z | xargs -0 $LOCAL_HASH ) \
  | awk '{h=$1; $1=""; sub(/^  /,""); print $0 "\t" h}' | sort > "$LOCAL_MAN"
NFILES=$(wc -l < "$LOCAL_MAN" | tr -d ' ')
echo "   archivos en scope: $NFILES"

# ── 3. Manifest remoto: hashear EXACTAMENTE esa lista de paths en la box ──
#    Los faltantes (sha256sum falla) no aparecen → se detectan como drift en el diff.
( cd "$SRC" && find . -type f | sort ) > "$PATHS"
REMOTE_RAW="$(ssh "$BOX" "cd ~/'$TREE' && xargs -d '\n' sha256sum 2>/dev/null" < "$PATHS")" || {
  echo "ERROR: no pude conectar/listar en ${BOX}:${TREE}." >&2; exit 2; }
echo "$REMOTE_RAW" | awk 'NF{h=$1; $1=""; sub(/^  /,""); print $0 "\t" h}' | sort > "$REMOTE_MAN"

# ── 4. Comparar ──
if diff -q "$LOCAL_MAN" "$REMOTE_MAN" >/dev/null; then
  echo ""
  echo "✅ OK: ${BOX}:${TREE} es IDÉNTICO a ${REF} ($NFILES archivos verificados)."
  exit 0
fi

echo ""
echo "❌ DRIFT: ${BOX}:${TREE} NO coincide con ${REF}. Archivos que difieren:"
while IFS= read -r path; do
  lh=$(grep -F "$path"$'\t' "$LOCAL_MAN"  | head -1 | cut -f2)
  rh=$(grep -F "$path"$'\t' "$REMOTE_MAN" | head -1 | cut -f2)
  if   [[ -z "$rh" ]]; then echo "   FALTA en la box   $path"
  elif [[ -z "$lh" ]]; then echo "   SOBRA en la box   $path  (no está en $REF)"
  elif [[ "$lh" != "$rh" ]]; then echo "   CONTENIDO ≠       $path"
  fi
done < <(cut -f1 "$LOCAL_MAN" "$REMOTE_MAN" | sort -u)
echo ""
echo "→ La box está corriendo código distinto a $REF. NO confíes en .deployed-sha."
echo "  Para corregir: ./scripts/promote-prod.sh --apply (re-sincroniza desde origin/main)."
exit 1
