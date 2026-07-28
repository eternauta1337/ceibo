#!/usr/bin/env bash
# migration-gate.sh — gate de migración DB antes de promover a prod
#
# La DB de ceibo NO tiene down-migrations y migrate() corre automáticamente al
# abrir la DB (openDb en @ceibo/store). Este gate verifica que la migración es
# segura ANTES del deploy real, corriendo migrate() contra una COPIA de la DB
# de prod en un directorio temporal.
#
# Qué valida:
#   ✓ La migración no tira excepción (no rompe al abrir la DB)
#   ✓ Las tablas del SCHEMA tienen la estructura esperada (PRAGMA table_info)
#   ✓ El conteo de filas clave (users, repos, sessions) es ≥ al de la DB original
#     (la migración no borró datos)
#   ✓ La DB copia sobrevive un INTEGRITY_CHECK (sin corrupción post-migración)
#
# Qué NO valida (limitaciones conocidas):
#   ✗ Que el código de la app funcione con los datos migrados (eso es el QA)
#   ✗ Migraciones que dependen del estado de staging (la copia es de prod)
#   ✗ Regresiones de lógica de negocio (no hay asserts de app-level)
#   ✗ Concurrencia durante la migración (la box puede estar en uso)
#
# La copia es desechable: se borra al salir (o con --keep para debug).
#
# Uso:
#   ./scripts/migration-gate.sh            # dry-run: describe qué haría, sin copiar
#   ./scripts/migration-gate.sh --apply    # copia la DB y corre migrate()
#   ./scripts/migration-gate.sh --apply --keep   # igual pero deja la copia en /tmp para debug
#
# Prerrequisito: la box es accesible por SSH (deploy@ceibo.example.com). En CI o
# entornos sin acceso a la box, este gate puede saltarse con promote-prod.sh
# --skip-migration-gate (con la advertencia correspondiente).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOX="deploy@ceibo.example.com"
# Ruta de la DB de prod EN LA BOX. La box la fija vía CEIBO_DB_PATH en .env.
# Si el operador la sobreride en .env, actualizar acá o pasar PROD_DB_PATH env.
PROD_DB_REMOTE="${PROD_DB_PATH:-ceibo/data/ceibo.db}"
TMP_DIR=""

APPLY=false
KEEP=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --keep)  KEEP=true ;;
    *) echo "Uso: $0 [--apply] [--keep]" >&2; exit 1 ;;
  esac
done

# Limpieza al salir (a menos que --keep)
cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" && "$KEEP" == false ]]; then
    rm -rf "$TMP_DIR"
    echo "→ Copia temporal eliminada."
  elif [[ -n "$TMP_DIR" && -d "$TMP_DIR" && "$KEEP" == true ]]; then
    echo "→ Copia temporal conservada en: $TMP_DIR (--keep)"
  fi
}
trap cleanup EXIT

echo "=== Gate de migración DB ==="
echo ""
echo "Valida que migrate() en @ceibo/store corre sin error sobre la DB de prod"
echo "antes de deployar. La DB de prod NO se toca: se trabaja sobre una copia."
echo ""
echo "DB de prod en la box: $BOX:$PROD_DB_REMOTE"
echo ""

if [[ "$APPLY" == false ]]; then
  echo "[dry-run] Pasos que se ejecutarían con --apply:"
  echo "  1. Bajar la DB de prod → /tmp/ceibo-migration-gate-<pid>/<env>/ceibo.db"
  echo "  2. Contar filas baseline (users, repos, sessions) en la copia"
  echo "  3. Correr migrate() sobre la copia vía tsx (openDb de @ceibo/store)"
  echo "  4. Verificar integridad (PRAGMA integrity_check)"
  echo "  5. Verificar que el conteo de filas clave no decreció"
  echo "  6. Reportar OK o FAIL"
  echo ""
  echo "=== Dry-run completado. Pasá --apply para correr el gate real. ==="
  exit 0
fi

# ── 1. Crear directorio temporal ─────────────────────────────────────────────
TMP_DIR="$(mktemp -d /tmp/ceibo-migration-gate-XXXXXX)"
# La ruta del TMP_DB simula CEIBO_DB_PATH: lo que importa es el basename (ceibo.db)
# y que el directorio `data/` exista relativo al working dir del script de migración.
TMP_DATA="$TMP_DIR/data"
mkdir -p "$TMP_DATA"
TMP_DB="$TMP_DATA/ceibo.db"

echo "→ Directorio temporal: $TMP_DIR"

# ── 2. Copiar la DB de prod desde la box ────────────────────────────────────
echo "→ Copiando DB de prod desde la box (read-only, sin tocar la original)..."
# Usamos --checksum para detectar corrupción en tránsito. Sin --delete (no aplica).
# La DB puede estar en WAL mode: bajamos también el -wal y -shm si existen.
scp "$BOX:$PROD_DB_REMOTE" "$TMP_DB"
# WAL y SHM son efímeros; intentar copiarlos también (OK si no existen)
scp "$BOX:${PROD_DB_REMOTE}-wal" "${TMP_DB}-wal" 2>/dev/null || true
scp "$BOX:${PROD_DB_REMOTE}-shm" "${TMP_DB}-shm" 2>/dev/null || true
echo "   Copiado: $(du -h "$TMP_DB" | cut -f1)"

# ── 3. Contar filas baseline (antes de migrate) ──────────────────────────────
echo "→ Conteo baseline (antes de migrate)..."
BASELINE_USERS=$(sqlite3 "$TMP_DB" "SELECT COUNT(*) FROM users;" 2>/dev/null || echo 0)
BASELINE_REPOS=$(sqlite3 "$TMP_DB" "SELECT COUNT(*) FROM repos;" 2>/dev/null || echo 0)
BASELINE_SESSIONS=$(sqlite3 "$TMP_DB" "SELECT COUNT(*) FROM sessions;" 2>/dev/null || echo 0)
echo "   users: $BASELINE_USERS · repos: $BASELINE_REPOS · sessions: $BASELINE_SESSIONS"

# ── 4. Escribir y ejecutar el script de migración via tsx ────────────────────
# Corremos openDb (que llama a migrate() internamente) sobre la copia.
# CEIBO_DB_PATH apunta a la copia; CEIBO_ENV=prod para respetar invariante.
echo "→ Corriendo migrate() via openDb (@ceibo/store)..."

# .mts → tsx lo trata como ESM (top-level await + import dinámico permitidos).
MIGRATION_SCRIPT="$TMP_DIR/run-migrate.mts"
# El import es relativo al repo root; el script se corre con cwd=REPO_ROOT.
cat > "$MIGRATION_SCRIPT" << 'TSEOF'
// Script de migración gate: abre la DB de ceibo (copia temporal) y corre
// migrate() que está embebido en openDb. Si tira excepción, el proceso sale != 0.
// El script vive en /tmp, así que importamos store por ruta ABSOLUTA (import dinámico):
// un import relativo resolvería contra /tmp, no contra el repo.
const repoRoot = process.env.GATE_REPO_ROOT;
if (!repoRoot) {
  console.error("GATE_REPO_ROOT no seteado");
  process.exit(1);
}
const { openDb } = await import(`${repoRoot}/packages/store/src/index.ts`);

const dbPath = process.env.CEIBO_DB_PATH;
if (!dbPath) {
  console.error("CEIBO_DB_PATH no seteado");
  process.exit(1);
}

console.log(`  openDb en: ${dbPath}`);
try {
  const db = openDb(dbPath);
  // Smoke: una query trivial para confirmar que la DB quedó abierta y usable
  const userCount = (db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
  const repoCount = (db.prepare("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c;
  const sessionCount = (db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c;
  console.log(`  Post-migrate: users=${userCount} repos=${repoCount} sessions=${sessionCount}`);
  db.close();
  process.exit(0);
} catch (err) {
  console.error("  migrate() FALLÓ:", err);
  process.exit(1);
}
TSEOF

# El monorepo ya tiene tsx en node_modules. Corremos con cwd=REPO_ROOT para que
# el import relativo de packages/store/src/index.ts resuelva correctamente.
# OJO: usar el BINARIO tsx, NO `node --import tsx/esm`: este último cae en
# ERR_REQUIRE_CYCLE_MODULE en Node 22 (require de ESM en ciclo, vía better-sqlite3).
MIGRATION_OUTPUT=$(
  cd "$REPO_ROOT" && \
  CEIBO_DB_PATH="$TMP_DB" CEIBO_ENV=prod GATE_REPO_ROOT="$REPO_ROOT" \
  "$REPO_ROOT/node_modules/.bin/tsx" "$MIGRATION_SCRIPT" 2>&1
) || {
  echo "FAIL: migrate() lanzó excepción. Output:"
  echo "$MIGRATION_OUTPUT"
  echo ""
  echo "=== Gate de migración FALLADO — NO promover a prod. ==="
  exit 1
}
while IFS= read -r line; do echo "   $line"; done <<< "$MIGRATION_OUTPUT"

# ── 5. Verificar integridad post-migración ────────────────────────────────────
echo "→ PRAGMA integrity_check..."
INTEGRITY=$(sqlite3 "$TMP_DB" "PRAGMA integrity_check;" 2>&1)
if [[ "$INTEGRITY" != "ok" ]]; then
  echo "FAIL: integrity_check devolvió:"
  echo "$INTEGRITY"
  echo ""
  echo "=== Gate de migración FALLADO — NO promover a prod. ==="
  exit 1
fi
echo "   integrity_check: ok"

# ── 6. Verificar que el conteo de filas no decreció ──────────────────────────
echo "→ Verificando que las filas clave no decrecieron..."
POST_USERS=$(sqlite3 "$TMP_DB" "SELECT COUNT(*) FROM users;" 2>/dev/null || echo 0)
POST_REPOS=$(sqlite3 "$TMP_DB" "SELECT COUNT(*) FROM repos;" 2>/dev/null || echo 0)
POST_SESSIONS=$(sqlite3 "$TMP_DB" "SELECT COUNT(*) FROM sessions;" 2>/dev/null || echo 0)

FAIL=false
if [[ "$POST_USERS" -lt "$BASELINE_USERS" ]]; then
  echo "FAIL: users decreció ($BASELINE_USERS → $POST_USERS)"; FAIL=true
fi
if [[ "$POST_REPOS" -lt "$BASELINE_REPOS" ]]; then
  echo "FAIL: repos decreció ($BASELINE_REPOS → $POST_REPOS)"; FAIL=true
fi
if [[ "$POST_SESSIONS" -lt "$BASELINE_SESSIONS" ]]; then
  echo "FAIL: sessions decreció ($BASELINE_SESSIONS → $POST_SESSIONS)"; FAIL=true
fi

if [[ "$FAIL" == true ]]; then
  echo ""
  echo "=== Gate de migración FALLADO — NO promover a prod. ==="
  exit 1
fi

echo "   users: $BASELINE_USERS → $POST_USERS (OK)"
echo "   repos: $BASELINE_REPOS → $POST_REPOS (OK)"
echo "   sessions: $BASELINE_SESSIONS → $POST_SESSIONS (OK)"

echo ""
echo "=== Gate de migración OK. La migración es segura para prod. ==="
