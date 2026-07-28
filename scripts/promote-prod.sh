#!/usr/bin/env bash
# promote-prod.sh — deployar la branch `main` (ya mergeada por PR) en prod (DESTRUCTIVO)
#
# ⚠️  DESTRUCTIVO: el restart del gateway corta las sesiones MA vivas de todos los
#     usuarios. Antes de correr: verificar que no hay turnos en vuelo largos (pueden
#     durar minutos; ver CLAUDE.md / memory "gateway-restart-inflight-check").
#
# La PROMOCIÓN staging→main se hace por PR (CI-gated, coverage; branches PR-only). Este
# script NO mergea ni pushea: asume que el PR staging→main YA está mergeado en origin/main
# y hace solo la mitad de BOX del deploy:
#   1. Confirmación explícita + recordatorio de turnos en vuelo
#   2. Sanity: que no queden commits de staging sin promover (--no-merges)
#   3. Gate de migración (scripts/migration-gate.sh --apply) salvo --skip-migration-gate
#   4. rsync del árbol tracked de origin/main → ~/ceibo/packages/ (vía git archive: solo
#      archivos tracked → artefactos de dev quedan fuera por construcción)
#   5. Si tocó packages/web → rebuild limpio en la box
#   6. Escribe .deployed-sha ANTES del restart (si no, /api/version queda un deploy atrasado)
#   7. Restart de los servicios de PROD + smoke check
#
# Uso:
#   ./scripts/promote-prod.sh                                # dry-run (no toca la box)
#   ./scripts/promote-prod.sh --apply                        # deploy real (pide confirmación)
#   ./scripts/promote-prod.sh --apply --skip-migration-gate  # peligroso, solo emergencias
#
# Prerrequisitos:
#   - QA manual en staging completado
#   - PR staging→main mergeado y CI verde (coverage OK)
#   - Sin turnos MA en vuelo (ver instrucción más abajo)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOX="deploy@ceibo.example.com"
REMOTE_TREE="ceibo"
TARGET_BRANCH="main"
SOURCE_BRANCH="staging"
PUBLIC_URL="https://ceibo.example.com"
PROD_SERVICES=(
  "ceibo-gateway"
  "ceibo-webserver"
  "ceibo-oauth"
  "ceibo-mcps"
)

APPLY=false
SKIP_MIGRATION_GATE=false
FORCE_WEB=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --skip-migration-gate) SKIP_MIGRATION_GATE=true ;;
    --rebuild-web) FORCE_WEB=true ;; # forzar el rebuild del bundle web aunque el diff no lo detecte
    *) echo "Uso: $0 [--apply] [--skip-migration-gate] [--rebuild-web]" >&2; exit 1 ;;
  esac
done

[[ "$APPLY" == false ]] && { echo "=== DRY-RUN (pasá --apply para el deploy real) ==="; echo ""; }

# ── CONFIRMACIÓN EXPLÍCITA (solo en --apply) ─────────────────────────────────
if [[ "$APPLY" == true ]]; then
  echo "╔══════════════════════════════════════════════════════════════════╗"
  echo "║  ⚠️   PROMOTE A PROD — ACCIÓN DESTRUCTIVA                         ║"
  echo "║                                                                  ║"
  echo "║  El restart del ceibo-gateway corta las sesiones MA vivas de     ║"
  echo "║  TODOS los usuarios. No hay rollback automático.                 ║"
  echo "╚══════════════════════════════════════════════════════════════════╝"
  echo ""
  echo "Checklist PRE-DEPLOY (confirmá cada punto):"
  echo "  1. ¿El QA del runsheet está completo?"
  echo "  2. ¿El PR staging→main fue mergeado y CI verde (coverage OK)?"
  echo "  3. ¿Verificaste que no hay turnos MA en vuelo?"
  echo "     ssh $BOX 'journalctl -u ceibo-gateway --since \"5 min ago\" | tail'"
  echo "     (los turnos pueden durar minutos; esperá a que terminen)"
  echo ""
  read -r -p "¿Confirmás el promote a prod? Escribí 'si' para continuar: " CONFIRM
  [[ "$CONFIRM" != "si" ]] && { echo "Cancelado."; exit 0; }
  echo ""
fi

# ── 1. Actualizar el remote ──────────────────────────────────────────────────
echo "→ Actualizando remote..."
git -C "$REPO_ROOT" fetch origin

# ── 2. Sanity: ¿el contenido de staging ya está promovido a main? ────────────
# Comparamos CONTENIDO (diff de árbol), NO ancestría: las promociones por PR pueden ser
# squash → los SHAs de staging no quedan como ancestros de main aunque el contenido sí.
if ! git -C "$REPO_ROOT" diff --quiet "origin/$TARGET_BRANCH" "origin/$SOURCE_BRANCH"; then
  echo "ERROR: origin/$SOURCE_BRANCH tiene contenido que NO esta en origin/$TARGET_BRANCH." >&2
  echo "       Merge primero el PR $SOURCE_BRANCH -> $TARGET_BRANCH (CI-gated, coverage). Este script solo deploya." >&2
  git -C "$REPO_ROOT" diff --stat "origin/$TARGET_BRANCH" "origin/$SOURCE_BRANCH" | head -20 >&2
  exit 1
fi

NEW_SHA="$(git -C "$REPO_ROOT" rev-parse --short "origin/$TARGET_BRANCH")"
echo "   origin/$TARGET_BRANCH: $NEW_SHA"

# ── 3. Gate de migración ─────────────────────────────────────────────────────
echo ""
if [[ "$SKIP_MIGRATION_GATE" == true ]]; then
  echo "⚠️  WARNING: gate de migración SALTADO (--skip-migration-gate). Solo para emergencias."
elif [[ "$APPLY" == true ]]; then
  echo "→ Corriendo gate de migración..."
  bash "$REPO_ROOT/scripts/migration-gate.sh" --apply
else
  echo "→ [dry-run] bash scripts/migration-gate.sh --apply"
fi

# ── 4. Detectar qué cambió vs lo deployado en prod ───────────────────────────
# OJO: PREV_SHA sale de .deployed-sha, que PUEDE MENTIR (ver paso 7b/verify-prod.sh).
# Por eso es solo una OPTIMIZACIÓN (saltear rebuild/pnpm install si nada cambió); la
# verdad la dice el verify por contenido del paso 7. Ante la duda → asumimos cambió.
PREV_SHA="$(ssh "$BOX" "head -1 ~/$REMOTE_TREE/.deployed-sha 2>/dev/null" || true)"
echo ""
echo "   deployado hoy en prod (según .deployed-sha, NO confiable): ${PREV_SHA:-"(desconocido)"}"
WEB_CHANGED=true
DEPS_CHANGED=true   # pnpm-lock.yaml o patches/ → hay que correr pnpm install en la box
if [[ -n "$PREV_SHA" ]] && git -C "$REPO_ROOT" cat-file -e "${PREV_SHA}^{commit}" 2>/dev/null; then
  CHANGED="$(git -C "$REPO_ROOT" diff --name-only "$PREV_SHA" "origin/$TARGET_BRANCH")"
  # El bundle web incluye sus deps internas (hoy @ceibo/orb): un cambio SÓLO en orb igual exige
  # rebuild (se compila DENTRO de web). Si no, prod sirve el bundle viejo (mismo bug que mordió
  # staging con el settle del orbe, 2026-06).
  echo "$CHANGED" | grep -qE '^packages/(web|orb)/' && WEB_CHANGED=true || WEB_CHANGED=false
  # Un patch (pnpm patch) NO cambia package.json pero SÍ el contenido del dep → si no
  # corremos pnpm install, node_modules queda stale y el fix "no aparece" (caso autoclosing).
  echo "$CHANGED" | grep -qE '^(pnpm-lock\.yaml|patches/|package\.json)' && DEPS_CHANGED=true || DEPS_CHANGED=false
fi
[[ "$FORCE_WEB" == true ]] && WEB_CHANGED=true
echo "→ packages/web cambió: $WEB_CHANGED · deps/patches cambiaron: $DEPS_CHANGED"

# ── 5. rsync del árbol tracked de origin/main → prod ─────────────────────────
# Sincronizamos packages/ Y los archivos de raíz que afectan el runtime de la box:
# package.json / pnpm-lock.yaml / patches/. Sin estos, un patch (pnpm patch) nunca llega
# a la box aunque esté en main (el git archive viejo solo traía packages/).
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
RSYNC_FLAGS=(-a --exclude=node_modules --exclude=dist --exclude='*.db' --exclude=data --exclude=.DS_Store)
[[ "$APPLY" == false ]] && RSYNC_FLAGS+=(-vn) || RSYNC_FLAGS+=(-v)
rsync "${RSYNC_FLAGS[@]}" "$TMP/packages/" "$BOX:$REMOTE_TREE/packages/"
# Archivos de raíz: copia directa al root del árbol (sin --delete, no pisan data/.env/secrets).
ROOT_SYNC=()
for f in "${ROOT_FILES[@]}"; do [[ -e "$TMP/$f" ]] && ROOT_SYNC+=("$TMP/$f"); done
[[ ${#ROOT_SYNC[@]} -gt 0 ]] && rsync "${RSYNC_FLAGS[@]}" -r "${ROOT_SYNC[@]}" "$BOX:$REMOTE_TREE/"

# ── 5b. pnpm install si cambiaron deps/patches (re-aplica los pnpm patch) ─────
if [[ "$DEPS_CHANGED" == true ]]; then
  echo ""
  echo "→ deps/patches cambiaron — pnpm install --frozen-lockfile en la box (re-aplica patches)..."
  if [[ "$APPLY" == true ]]; then
    ssh "$BOX" "cd ~/$REMOTE_TREE && pnpm install --frozen-lockfile"
  else
    echo "   [dry-run] ssh $BOX 'cd ~/$REMOTE_TREE && pnpm install --frozen-lockfile'"
  fi
fi

# ── 6. Rebuild limpio de packages/web (si cambió) ────────────────────────────
if [[ "$WEB_CHANGED" == true ]]; then
  echo ""
  echo "→ packages/web cambió — rebuild limpio en prod (rm -rf dist)..."
  if [[ "$APPLY" == true ]]; then
    ssh "$BOX" "cd ~/$REMOTE_TREE && rm -rf packages/web/dist && pnpm --filter @ceibo/web build"
    ssh "$BOX" "ls ~/$REMOTE_TREE/packages/web/dist/assets/index-*.js 2>/dev/null | head -1 || echo '(sin assets)'"
  else
    echo "   [dry-run] ssh $BOX 'rm -rf ~/$REMOTE_TREE/packages/web/dist && pnpm --filter @ceibo/web build'"
  fi
fi

# ── 7. GUARD: verificar por CONTENIDO que la box == origin/main ───────────────
# El paso clave. NO confiamos en que el rsync hizo lo correcto: comparamos sha256
# archivo por archivo (verify-prod.sh). Si hay drift → ABORTAMOS antes de escribir
# .deployed-sha y antes del restart (no dejamos prod a medio deployar ni el sha
# mintiendo). Esto es lo que habría cazado el deploy fantasma del 2026-06-21.
echo ""
if [[ "$APPLY" == true ]]; then
  echo "→ GUARD: verificando contenido deployado vs origin/$TARGET_BRANCH..."
  if ! bash "$REPO_ROOT/scripts/verify-prod.sh" --ref "origin/$TARGET_BRANCH" --box "$BOX" --tree "$REMOTE_TREE"; then
    echo "" >&2
    echo "ABORT: la box NO coincide con origin/$TARGET_BRANCH tras el rsync. NO escribo .deployed-sha" >&2
    echo "       y NO reinicio (prod sigue con el código anterior). Revisá el drift de arriba y reintentá." >&2
    exit 1
  fi
else
  echo "   [dry-run] bash scripts/verify-prod.sh --ref origin/$TARGET_BRANCH (guard de contenido)"
fi

# ── 7b. Escribir .deployed-sha (SOLO tras pasar el guard) ─────────────────────
# Antes del restart, para que /api/version lo lea al boot. Y solo acá, post-verify:
# así .deployed-sha nunca puede afirmar un deploy que no ocurrió de verdad.
echo ""
if [[ "$APPLY" == true ]]; then
  echo "→ Registrando SHA en prod (verificado por contenido)..."
  ssh "$BOX" "printf '%s\n$TARGET_BRANCH\n%s\n' '$NEW_SHA' \"\$(date -u +%FT%TZ)\" > ~/$REMOTE_TREE/.deployed-sha"
else
  echo "   [dry-run] escribir ~/$REMOTE_TREE/.deployed-sha = $NEW_SHA (tras el guard, antes del restart)"
fi

# ── 8. Restart servicios de PROD ─────────────────────────────────────────────
# OJO: el restart del gateway corta las sesiones MA vivas. Ver confirmación arriba.
echo ""
echo "→ Restart servicios de PROD: ${PROD_SERVICES[*]}"
if [[ "$APPLY" == true ]]; then
  ssh "$BOX" "sudo systemctl restart ${PROD_SERVICES[*]}"
  ssh "$BOX" "systemctl is-active ${PROD_SERVICES[*]}"
else
  echo "   [dry-run] ssh $BOX 'sudo systemctl restart ${PROD_SERVICES[*]}'"
fi

# ── 9. Smoke check ───────────────────────────────────────────────────────────
echo ""
if [[ "$APPLY" == true ]]; then
  HTTP=$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_URL/" || echo 'ERR')
  echo "→ Smoke check: $PUBLIC_URL/ → $HTTP"
  echo "  /api/version → $(curl -s "$PUBLIC_URL/api/version" || echo '?')"
  if [[ "$HTTP" != "200" ]]; then
    echo "WARNING: smoke check = $HTTP. Logs: ssh $BOX 'journalctl -u ceibo-gateway -n 30'" >&2
    echo "Rollback manual: SHA anterior en ~/ceibo/.deployed-sha (no hay rollback automático)." >&2
  fi
  echo ""
  echo "=== Promote a prod completado. SHA: $NEW_SHA · Prod: $PUBLIC_URL/ ==="
else
  echo "=== Dry-run completado. Pasá --apply para el deploy real. SHA: $NEW_SHA ==="
  echo "    Commits en $SOURCE_BRANCH aún no en $TARGET_BRANCH:"
  git -C "$REPO_ROOT" log --oneline "origin/$TARGET_BRANCH..origin/$SOURCE_BRANCH" | head -20
fi
