#!/usr/bin/env bash
# deploy-staging.sh — deployar la branch `staging` (ya mergeada por PR) en la box
#
# La PROMOCIÓN dev→staging se hace por PR (CI-gated; las branches están protegidas
# PR-only, así que un `git push origin staging` sería rechazado). Por eso este script
# NO mergea ni pushea: asume que el PR dev→staging YA está mergeado en origin/staging y
# hace solo la mitad de BOX del deploy:
#   1. Sanity: que no queden commits de dev sin promover (--no-merges, ignora merge-commits)
#   2. rsync del árbol tracked de origin/staging → ~/ceibo-staging/packages/
#      (vía `git archive`: solo archivos tracked → los artefactos de dev —ceibo.dev.db-wal,
#       *.sock, dist— quedan fuera por construcción, no por exclude frágil)
#   3. Si tocó packages/web → rebuild limpio en la box (rm -rf dist)
#   4. Escribe .deployed-sha ANTES del restart (el web-server lee el SHA al boot; escribirlo
#      DESPUÉS deja /api/version un deploy atrasado)
#   5. Restart de los servicios @staging + smoke check
#
# Uso:
#   ./scripts/deploy-staging.sh            # dry-run (no toca la box)
#   ./scripts/deploy-staging.sh --apply    # deploy real
#
# Prerequisito: PR dev→staging mergeado (origin/staging al día) + F3 instalada en la box.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOX="deploy@ceibo.example.com"
REMOTE_TREE="ceibo-staging"
TARGET_BRANCH="staging"
SOURCE_BRANCH="dev"
PUBLIC_URL="https://staging.ceibo.example.com"
STAGING_SERVICES=(
  "ceibo-gateway@staging"
  "ceibo-webserver@staging"
  "ceibo-oauth@staging"
  "ceibo-mcps@staging"
)

APPLY=false
FORCE_WEB=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --rebuild-web) FORCE_WEB=true ;; # forzar el rebuild del bundle web aunque el diff no lo detecte
    *) echo "Uso: $0 [--apply] [--rebuild-web]" >&2; exit 1 ;;
  esac
done

[[ "$APPLY" == false ]] && echo "=== DRY-RUN (pasá --apply para el deploy real) ==="

# ── 1. Actualizar el remote ──────────────────────────────────────────────────
echo ""
echo "→ Actualizando remote..."
git -C "$REPO_ROOT" fetch origin

# ── 2. Sanity: ¿el contenido de dev ya está promovido a staging? ─────────────
# Comparamos CONTENIDO (diff de árbol), NO ancestría de commits: las promociones por PR
# pueden ser squash → los SHAs de dev no quedan como ancestros de staging aunque el
# contenido sí esté. Un diff vacío origin/staging vs origin/dev = todo promovido.
if ! git -C "$REPO_ROOT" diff --quiet "origin/$TARGET_BRANCH" "origin/$SOURCE_BRANCH"; then
  echo "ERROR: origin/$SOURCE_BRANCH tiene contenido que NO esta en origin/$TARGET_BRANCH." >&2
  echo "       Merge primero el PR $SOURCE_BRANCH -> $TARGET_BRANCH (CI-gated). Este script solo deploya." >&2
  git -C "$REPO_ROOT" diff --stat "origin/$TARGET_BRANCH" "origin/$SOURCE_BRANCH" | head -20 >&2
  exit 1
fi

NEW_SHA="$(git -C "$REPO_ROOT" rev-parse --short "origin/$TARGET_BRANCH")"
echo "   origin/$TARGET_BRANCH: $NEW_SHA"

# ── 3. Detectar qué cambió vs lo deployado en la box ─────────────────────────
# PREV_SHA sale de .deployed-sha (que PUEDE MENTIR) → solo optimización; la verdad la
# da el verify por contenido del paso 6. Ante la duda → asumimos cambió.
PREV_SHA="$(ssh "$BOX" "head -1 ~/$REMOTE_TREE/.deployed-sha 2>/dev/null" || true)"
echo "   deployado hoy en la box (según .deployed-sha, NO confiable): ${PREV_SHA:-"(desconocido)"}"
WEB_CHANGED=true
DEPS_CHANGED=true
if [[ -n "$PREV_SHA" ]] && git -C "$REPO_ROOT" cat-file -e "${PREV_SHA}^{commit}" 2>/dev/null; then
  CHANGED="$(git -C "$REPO_ROOT" diff --name-only "$PREV_SHA" "origin/$TARGET_BRANCH")"
  # El bundle web NO es sólo packages/web: incluye sus deps internas (hoy @ceibo/orb). Un cambio
  # SÓLO en orb igual exige rebuild (se compila DENTRO de web). Si no, la box sirve el bundle viejo
  # (caso real 2026-06: el settle del orbe quedó sin efecto en staging porque no se rebuildeó).
  echo "$CHANGED" | grep -qE '^packages/(web|orb)/' && WEB_CHANGED=true || WEB_CHANGED=false
  echo "$CHANGED" | grep -qE '^(pnpm-lock\.yaml|patches/|package\.json)' && DEPS_CHANGED=true || DEPS_CHANGED=false
fi
[[ "$FORCE_WEB" == true ]] && WEB_CHANGED=true
echo ""
echo "→ packages/web cambió: $WEB_CHANGED · deps/patches cambiaron: $DEPS_CHANGED"

# ── 4. rsync del árbol tracked de origin/staging → la box ────────────────────
# packages/ + raíz (package.json, pnpm-lock.yaml, patches/): sin los root files un
# pnpm patch nunca llega a la box aunque esté mergeado.
echo ""
echo "→ rsync packages/ + raíz (package.json, pnpm-lock.yaml, patches/) de origin/$TARGET_BRANCH → $BOX:$REMOTE_TREE/"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ROOT_FILES=(package.json pnpm-lock.yaml patches)
ARCHIVE_PATHS=(packages)
for f in "${ROOT_FILES[@]}"; do
  git -C "$REPO_ROOT" cat-file -e "origin/$TARGET_BRANCH:$f" 2>/dev/null && ARCHIVE_PATHS+=("$f") || true
done
git -C "$REPO_ROOT" archive "origin/$TARGET_BRANCH" "${ARCHIVE_PATHS[@]}" | tar -x -C "$TMP"
# Excludes redundantes (el archive ya excluye lo untracked) pero defensivos.
RSYNC_FLAGS=(-a --exclude=node_modules --exclude=dist --exclude='*.db' --exclude=data --exclude=.DS_Store)
[[ "$APPLY" == false ]] && RSYNC_FLAGS+=(-vn) || RSYNC_FLAGS+=(-v)
rsync "${RSYNC_FLAGS[@]}" "$TMP/packages/" "$BOX:$REMOTE_TREE/packages/"
ROOT_SYNC=()
for f in "${ROOT_FILES[@]}"; do [[ -e "$TMP/$f" ]] && ROOT_SYNC+=("$TMP/$f"); done
[[ ${#ROOT_SYNC[@]} -gt 0 ]] && rsync "${RSYNC_FLAGS[@]}" -r "${ROOT_SYNC[@]}" "$BOX:$REMOTE_TREE/"

# ── 4b. pnpm install si cambiaron deps/patches (re-aplica los pnpm patch) ─────
if [[ "$DEPS_CHANGED" == true ]]; then
  echo ""
  echo "→ deps/patches cambiaron — pnpm install --frozen-lockfile en la box (re-aplica patches)..."
  if [[ "$APPLY" == true ]]; then
    ssh "$BOX" "cd ~/$REMOTE_TREE && pnpm install --frozen-lockfile"
  else
    echo "   [dry-run] ssh $BOX 'cd ~/$REMOTE_TREE && pnpm install --frozen-lockfile'"
  fi
fi

# ── 5. Rebuild limpio de packages/web (si cambió) ────────────────────────────
if [[ "$WEB_CHANGED" == true ]]; then
  echo ""
  echo "→ packages/web cambió — rebuild limpio en la box (rm -rf dist)..."
  if [[ "$APPLY" == true ]]; then
    ssh "$BOX" "cd ~/$REMOTE_TREE && rm -rf packages/web/dist && pnpm --filter @ceibo/web build"
    ssh "$BOX" "ls ~/$REMOTE_TREE/packages/web/dist/assets/index-*.js 2>/dev/null | head -1 || echo '(sin assets)'"
  else
    echo "   [dry-run] ssh $BOX 'rm -rf ~/$REMOTE_TREE/packages/web/dist && pnpm --filter @ceibo/web build'"
  fi
fi

# ── 6. GUARD: verificar por CONTENIDO que la box == origin/staging ───────────
# No confiamos en que el rsync hizo lo correcto: sha256 archivo por archivo. Si hay
# drift → ABORTAMOS antes de escribir .deployed-sha y antes del restart.
echo ""
if [[ "$APPLY" == true ]]; then
  echo "→ GUARD: verificando contenido deployado vs origin/$TARGET_BRANCH..."
  if ! bash "$REPO_ROOT/scripts/verify-prod.sh" --ref "origin/$TARGET_BRANCH" --box "$BOX" --tree "$REMOTE_TREE"; then
    echo "" >&2
    echo "ABORT: la box NO coincide con origin/$TARGET_BRANCH tras el rsync. NO escribo .deployed-sha" >&2
    echo "       y NO reinicio (staging sigue con el código anterior). Revisá el drift y reintentá." >&2
    exit 1
  fi
else
  echo "   [dry-run] bash scripts/verify-prod.sh --ref origin/$TARGET_BRANCH (guard de contenido)"
fi

# ── 6b. Escribir .deployed-sha (SOLO tras pasar el guard) ─────────────────────
echo ""
if [[ "$APPLY" == true ]]; then
  echo "→ Registrando SHA en la box (verificado por contenido, antes del restart)..."
  ssh "$BOX" "printf '%s\n$TARGET_BRANCH\n%s\n' '$NEW_SHA' \"\$(date -u +%FT%TZ)\" > ~/$REMOTE_TREE/.deployed-sha"
else
  echo "   [dry-run] escribir ~/$REMOTE_TREE/.deployed-sha = $NEW_SHA (tras el guard, antes del restart)"
fi

# ── 7. Restart servicios @staging ────────────────────────────────────────────
echo ""
echo "→ Restart de servicios @staging: ${STAGING_SERVICES[*]}"
if [[ "$APPLY" == true ]]; then
  ssh "$BOX" "sudo systemctl restart ${STAGING_SERVICES[*]}"
  ssh "$BOX" "systemctl is-active ${STAGING_SERVICES[*]}"
else
  echo "   [dry-run] ssh $BOX 'sudo systemctl restart ${STAGING_SERVICES[*]}'"
fi

# ── 8. Smoke check ───────────────────────────────────────────────────────────
echo ""
if [[ "$APPLY" == true ]]; then
  HTTP=$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_URL/" || echo 'ERR')
  echo "→ Smoke check: $PUBLIC_URL/ → $HTTP"
  echo "  /api/version → $(curl -s "$PUBLIC_URL/api/version" || echo '?')"
  [[ "$HTTP" != "200" ]] && echo "WARNING: smoke check = $HTTP. Logs: ssh $BOX 'journalctl -u ceibo-gateway@staging -n 30'" >&2
  # Control MCP: un POST al endpoint debe dar NO-404. 404 = el secreto de CONTROL_MCP_URL no coincide
  # con CONTROL_MCP_SECRET en el .env (el connect queda roto en silencio; incidente 2026-06-20).
  CTRL_URL=$(ssh "$BOX" "grep -E '^CONTROL_MCP_URL=' ~/${REMOTE_TREE}/.env.${TARGET_BRANCH} | cut -d= -f2-" 2>/dev/null || true)
  if [[ -n "$CTRL_URL" ]]; then
    CHTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "$CTRL_URL" || echo 'ERR')
    echo "→ Control MCP (POST) → $CHTTP"
    [[ "$CHTTP" == "404" ]] && echo "WARNING: control MCP = 404 → CONTROL_MCP_URL ≠ CONTROL_MCP_SECRET en .env.${TARGET_BRANCH}: el connect estará ROTO. Alineá el secreto." >&2
  fi
  echo ""
  echo "=== Deploy staging completado. SHA: $NEW_SHA · QA: $PUBLIC_URL/ ==="
else
  echo "=== Dry-run completado. Pasá --apply para el deploy real. SHA: $NEW_SHA ==="
fi
