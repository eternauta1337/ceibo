#!/bin/bash
# Forced command para el nodo ceibo-prod (acceso ssh de Exe a gpuhost). SÓLO deja correr
# cp.sh y agent-vault con sus verbos conocidos; cualquier otra cosa (shell/comando arbitrario)
# se rechaza. Acota el blast radius: Exe sólo maneja VMs (cp.sh) y vaults (agent-vault).
#
# Va en ~/.ssh/authorized_keys de gpuhost (user demo), prefijado a la pubkey dedicada de Exe.
# Una pubkey (= forced-command) POR ENTORNO; el path apunta al dir del entorno:
#   restrict,command="/home/ceibo/archima/prod/vm/cp-forced.sh"    ssh-ed25519 AAAA... ceibo-prod
#   restrict,command="/home/ceibo/archima/staging/vm/cp-forced.sh" ssh-ed25519 AAAA... ceibo-staging
set -euo pipefail
# CP se autolocaliza (relativo a este script) → el MISMO archivo sirve prod y staging según
# desde qué dir lo invoque el forced-command. AV es el binario COMPARTIDO entre entornos.
HERE="$(cd "$(dirname "$0")" && pwd)"
CP="$HERE/cp.sh"
AV="${ARCHIMA_AVBIN:-$HOME/archima/agent-vault/agent-vault}"
CP_VERBS="spawn assign serve wiki-setup state ip list suspend restore destroy"
AV_VERBS="vault"   # el backend usa `agent-vault vault create|credential|service`
set -- ${SSH_ORIGINAL_COMMAND:-}   # args sin espacios (nombres/números/ids/tokens/urls/flags)
prog="${1:-}"; verb="${2:-}"
case "$(basename "$prog" 2>/dev/null)" in
  cp.sh)
    case " $CP_VERBS " in *" $verb "*) ;; *) echo "denegado: cp.sh verbo '$verb'" >&2; exit 1;; esac
    shift; exec "$CP" "$@" ;;
  agent-vault)
    case " $AV_VERBS " in *" $verb "*) ;; *) echo "denegado: agent-vault verbo '$verb'" >&2; exit 1;; esac
    shift; exec env AGENT_VAULT_ADDR="${AGENT_VAULT_ADDR:-http://192.168.122.1:14321}" "$AV" "$@" ;;
  *) echo "denegado: solo cp.sh|agent-vault (recibi: ${SSH_ORIGINAL_COMMAND:-<vacio>})" >&2; exit 1 ;;
esac
