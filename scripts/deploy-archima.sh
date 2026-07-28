#!/usr/bin/env bash
# deploy-archima.sh — deployar el runtime de archima (paquete @ceibo/archima-runtime) a la box
# gpuhost, por entorno. Es el "leg de gpuhost" del deploy: el SHA de prod/staging cubre el
# cliente (box ceibo) Y el runtime (box archima) — misma branch, dos máquinas.
#
# Qué hace (NO mergea ni pushea — la promoción dev→staging→main es por PR, igual que los otros
# deploys):
#   1. fetch origin + sanity: el working tree DEBE ser == origin/<branch del entorno>
#      (deploy SIEMPRE desde la branch mergeada; el operador hace checkout+pull antes).
#   2. ensambla el árbol DESPLEGABLE con el build del paquete (de-secreteado + prompts generados
#      vía print-prompt + wiki-sync vendoreado). El árbol lleva los placeholders __VLLM_KEY__ /
#      __ANTHROPIC_VAULT_REF__: la box los sustituye al servir desde ~/.archima/*.
#   3. rsync del árbol → ~/archima/<env>/ (sin --delete: preserva vms/ —base image box-level— y
#      el agent-vault COMPARTIDO en ~/archima/agent-vault, que vive fuera del dir del entorno).
#   4. escribe ~/archima/<env>/.deployed-sha. NO reinicia nada: cp.sh se forkea por turno (lee los
#      archivos nuevos en el próximo spawn/serve). agent-vault.service solo se toca si cambió su
#      binario/path (operación de cutover aparte, ver staging-plan-2 F6.2/F6.4).
#
# Uso:
#   ./scripts/deploy-archima.sh prod              # dry-run
#   ./scripts/deploy-archima.sh prod --apply      # deploy real
#   ./scripts/deploy-archima.sh staging --apply
#   ./scripts/deploy-archima.sh dev --apply       # dev: runtime en gpuhost, gateway corre en la mac
#
# Prerequisito: el cutover de la box (F6.2/F6.4: ~/archima/<env> existe, refs re-apuntados,
# ~/.archima/anthropic.ref poblado) ya hecho. Sin eso, el primer deploy crea el árbol pero la
# box todavía no lo consume. (dev: ~/archima/dev + key forced-command ceibo-dev — ver staging-plan-2 F6.4.)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_TARGET="${ARCHIMA_DEPLOY_SSH:-gpuhost}"   # cuenta dueña de ~/archima (demo@gpuhost), NO el forced-command
PKG_DIST="$REPO_ROOT/packages/archima-runtime/dist/runtime"

ENV="${1:-}"; shift || true
case "$ENV" in
  prod)    TARGET_BRANCH="main";    REMOTE_DIR="archima/prod" ;;
  staging) TARGET_BRANCH="staging"; REMOTE_DIR="archima/staging" ;;
  dev)     TARGET_BRANCH="dev";     REMOTE_DIR="archima/dev" ;;
  *) echo "Uso: $0 <prod|staging|dev> [--apply]" >&2; exit 1 ;;
esac

APPLY=false
for arg in "$@"; do
  case "$arg" in
    --) ;;  # separador que inserta `pnpm run … -- --apply`; ignorar
    --apply) APPLY=true ;;
    *) echo "Uso: $0 <prod|staging|dev> [--apply]" >&2; exit 1 ;;
  esac
done

[[ "$APPLY" == false ]] && echo "=== DRY-RUN archima/$ENV (pasá --apply para el deploy real) ==="

# ── 1. Sanity: el working tree es == origin/<branch> del entorno ─────────────
echo ""
echo "→ Actualizando remote..."
git -C "$REPO_ROOT" fetch origin
if ! git -C "$REPO_ROOT" diff --quiet "origin/$TARGET_BRANCH"; then
  echo "ERROR: el working tree difiere de origin/$TARGET_BRANCH." >&2
  echo "       El runtime de archima/$ENV se deploya SIEMPRE desde origin/$TARGET_BRANCH:" >&2
  echo "         git checkout $TARGET_BRANCH && git pull --ff-only origin $TARGET_BRANCH" >&2
  git -C "$REPO_ROOT" diff --stat "origin/$TARGET_BRANCH" | head -20 >&2
  exit 1
fi
NEW_SHA="$(git -C "$REPO_ROOT" rev-parse --short "origin/$TARGET_BRANCH")"
echo "   origin/$TARGET_BRANCH: $NEW_SHA"

# ── 2. Ensamblar el árbol desplegable (build del paquete) ────────────────────
echo ""
echo "→ Ensamblando el runtime desplegable (build + prompts generados + wiki-sync vendoreado)..."
pnpm --filter @ceibo/archima-runtime build >/dev/null
[[ -d "$PKG_DIST" ]] || { echo "ERROR: el build no dejó $PKG_DIST" >&2; exit 1; }

# ── 3. rsync del árbol → ~/archima/<env>/ ────────────────────────────────────
echo ""
echo "→ rsync runtime → $SSH_TARGET:~/$REMOTE_DIR/ (sin --delete: preserva vms/ y agent-vault compartido)"
RSYNC_FLAGS=(-a --exclude=.DS_Store)
[[ "$APPLY" == false ]] && RSYNC_FLAGS+=(-vn) || RSYNC_FLAGS+=(-v)
# crea el dir del entorno si falta (idempotente); -p para no fallar si ya existe.
[[ "$APPLY" == true ]] && ssh "$SSH_TARGET" "mkdir -p ~/$REMOTE_DIR"
rsync "${RSYNC_FLAGS[@]}" "$PKG_DIST/" "$SSH_TARGET:$REMOTE_DIR/"

# ── 4. Registrar el SHA (la box no es git). NO se reinicia nada ──────────────
echo ""
if [[ "$APPLY" == true ]]; then
  ssh "$SSH_TARGET" "printf '%s\n$TARGET_BRANCH\n%s\n' '$NEW_SHA' \"\$(date -u +%FT%TZ)\" > ~/$REMOTE_DIR/.deployed-sha"
  echo "=== Deploy archima/$ENV completado. SHA: $NEW_SHA · dir: ~/$REMOTE_DIR ==="
  echo "    (cp.sh se forkea por turno → el próximo spawn/serve usa el runtime nuevo; nada que reiniciar.)"
else
  echo "   [dry-run] escribir ~/$REMOTE_DIR/.deployed-sha = $NEW_SHA"
  echo "=== Dry-run archima/$ENV completado. Pasá --apply para el deploy real. SHA: $NEW_SHA ==="
fi
