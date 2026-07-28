#!/usr/bin/env bash
# scope-guard: PreToolUse hook (matcher Edit|Write). Acota las ediciones al/los
# paquete(s) en foco declarados en .claude/active-scope.
#
# active-scope: una línea con cero o más nombres de paquete (separados por espacio
# o coma). Líneas que empiezan con # se ignoran.
#   - vacío / ausente  → sin scope: permite editar en cualquier lado (modo cross-cutting).
#   - "speech"         → solo packages/speech/**
#   - "store gateway"  → solo packages/store/** y packages/gateway/** (cambio que cruza).
#
# El piso estático (deploy/, secrets/, lockfile) lo cubren las deny rules de
# settings.json, que se evalúan ANTES que este hook.
set -euo pipefail

input="$(cat)"
tool="$(printf '%s' "$input" | jq -r '.tool_name // empty')"
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"

# Solo gobernamos Edit/Write con file_path. Cualquier otra cosa: no opinamos.
case "$tool" in
  Edit|Write|NotebookEdit) ;;
  *) exit 0 ;;
esac
[ -n "$file" ] || exit 0

proj="${CLAUDE_PROJECT_DIR:-$(printf '%s' "$input" | jq -r '.cwd // empty')}"
[ -n "$proj" ] || exit 0
scope_file="$proj/.claude/active-scope"

# Sin archivo de scope, o vacío de paquetes → no restringimos.
[ -f "$scope_file" ] || exit 0
scopes="$(grep -vE '^\s*#' "$scope_file" 2>/dev/null | tr ',' ' ' | tr -s '[:space:]' ' ' | sed 's/^ //;s/ $//' || true)"
[ -n "$scopes" ] || exit 0

# Normalizar file a absoluto.
case "$file" in
  /*) abs="$file" ;;
  *)  abs="$proj/$file" ;;
esac

for pkg in $scopes; do
  prefix="$proj/packages/$pkg/"
  case "$abs/" in
    "$prefix"*) exit 0 ;;  # dentro del scope → permitido
  esac
done

reason="Edición fuera del scope activo ($scopes). Intentó: $file. Para trabajar acá, ajustá .claude/active-scope o vacialo si el cambio cruza paquetes a propósito."
jq -n --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
exit 0
