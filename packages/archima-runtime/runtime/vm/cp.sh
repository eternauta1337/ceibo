#!/usr/bin/env bash
# Control plane de archima: orquesta el pool de VMs sobre libvirt (= el "session
# create" de MA). Clona la GOLDEN (opencode baked) en segundos. Corre EN la box.
# Uso:
#   cp.sh spawn   <name> [ram_mb] [vcpus]   linked-clone de la golden + boot + firewall (warm, sin identidad)
#   cp.sh assign  <name> <userid>           inyecta la identidad scopeada del usuario (AV token + wiki-token)
#   cp.sh serve   <name> [config]            arranca opencode serve en la VM (+ config; [config]=modelo/tier, default Gemma), espera health
#   cp.sh wiki-setup <name> <token> <url>    prepara el acceso git a wikis (token firmado + wikibomb: clona las wikis en ~/work)
#   cp.sh state   <name>                     domstate (running|shut off|...) — para reuseOrCreate
#   cp.sh ip      <name>                     IP de la VM
#   cp.sh list                               VMs de archima y su estado
#   cp.sh suspend <name>                     managedsave (libera RAM, guarda a disco)
#   cp.sh restore <name>                     start (restaura desde managedsave)
#   cp.sh destroy <name>                     destroy + undefine + borra disco
set -euo pipefail

POOL="${ARCHIMA_POOL:-/var/lib/libvirt/images}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GOLDEN="$POOL/archima-golden.qcow2"
KEY="$HOME/.ssh/archima_vm"
AVBIN="${ARCHIMA_AVBIN:-$HOME/archima/agent-vault/agent-vault}"
VIRSH="sudo virsh -c qemu:///system"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5"
SCP="scp -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10"

cmd="${1:?spawn|assign|serve|wiki-setup|state|ip|list|suspend|restore|destroy}"
NAME="${2:-}"

# Resuelve la IP de la VM. ROBUSTO: prueba 3 fuentes (lease DHCP → arp del host →
# guest-agent) porque el lease es intermitente justo tras boot/restore → vacío → "ssh exit 1".
# Siempre retorna 0 (emite IP o vacío) para no romper el `set -e` de los callers.
vip(){
  local ip="" src
  for src in lease arp agent; do
    ip="$($VIRSH domifaddr "archima-$1" --source "$src" 2>/dev/null | awk '/ipv4/{print $4}' | cut -d/ -f1 | head -1)"
    [ -n "$ip" ] && break
  done
  printf '%s' "$ip"
}
# Como vip pero reintenta hasta ${2:-30} veces (1s c/u) — para los comandos que se
# llaman ni bien la VM arranca y el lease puede no estar todavía (serve/assign/wiki-setup).
# Mismo contrato que vip: siempre 0, emite IP o vacío.
vip_wait(){
  local ip="" i
  for i in $(seq 1 "${2:-30}"); do
    ip="$(vip "$1")"; [ -n "$ip" ] && break
    sleep 1
  done
  printf '%s' "$ip"
}

case "$cmd" in
  spawn)
    # IDEMPOTENTE (item H): si la VM ya existe, NO recrear el overlay (evita
    # `qemu-img: Failed to get write lock`). running → reusar; suspendida/apagada →
    # restaurar; sólo si falta de verdad se clona. El ArchimaBackend (#217) ya
    # chequea state antes, pero esto es defensa en profundidad ante spawn directo/race.
    st="$($VIRSH domstate "archima-$NAME" 2>/dev/null || echo missing)"
    if [ "$st" = "running" ]; then
      echo "archima-${NAME} ya corriendo @ $(vip "$NAME") (reuso)"; exit 0
    elif [ "$st" = "shut off" ] || [ "$st" = "saved" ] || [ "$st" = "paused" ]; then
      $VIRSH start "archima-$NAME" >/dev/null 2>&1 || true
      ip=""; for i in $(seq 1 30); do ip=$(vip "$NAME"); [ -n "$ip" ] && break; sleep 2; done
      echo "archima-${NAME} restaurada @ ${ip:-sin-ip-aún} (reuso)"; exit 0
    fi
    [ -f "$GOLDEN" ] || { echo "falta la golden ($GOLDEN). corre build-golden.sh"; exit 1; }
    DISK="$POOL/archima-${NAME}.qcow2"; SEED="$POOL/archima-${NAME}-seed.iso"
    sudo qemu-img create -f qcow2 -F qcow2 -b "$GOLDEN" "$DISK" 12G >/dev/null
    ud="$(mktemp)"
    cat > "$ud" <<YAML
#cloud-config
hostname: archima-${NAME}
manage_etc_hosts: true
users:
  - name: archima
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - $(cat "$KEY.pub")
ssh_pwauth: false
YAML
    sudo cloud-localds "$SEED" "$ud"; rm -f "$ud"
    sudo virt-install --connect qemu:///system --name "archima-${NAME}" \
      --memory "${3:-1024}" --vcpus "${4:-2}" \
      --disk "$DISK",device=disk,bus=virtio --disk "$SEED",device=cdrom \
      --os-variant ubuntu24.04 --import \
      --network network=default,model=virtio --graphics none --noautoconsole >/dev/null
    # esperar IP + aplicar firewall de egress
    ip=""; for i in $(seq 1 30); do ip=$(vip "$NAME"); [ -n "$ip" ] && break; sleep 2; done
    [ -z "$ip" ] && { echo "archima-${NAME}: booteando, sin IP aún"; exit 0; }
    for i in $(seq 1 20); do $SSH archima@$ip true 2>/dev/null && break; sleep 2; done
    scp -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      "$HERE/vm-firewall.sh" archima@$ip:/tmp/ >/dev/null 2>&1 && \
      $SSH archima@$ip 'sudo bash /tmp/vm-firewall.sh' >/dev/null 2>&1 && fw="firewall ON" || fw="firewall PENDIENTE"
    echo "archima-${NAME} @ $ip ($fw)"
    ;;
  assign)
    # Inyecta la IDENTIDAD scopeada de un usuario en una VM warm (= "session create"
    # con identidad de MA). Los secretos raíz (master AV) quedan en el host; la VM sólo
    # recibe un token de AGENTE scopeado al VAULT del usuario (rol proxy: inyecta creds,
    # NO puede leerlas), igual que MA monta sólo lo scopeado.
    # $3 = el VAULT del usuario (ej. `ceibo-demo-gpuhost`), que pasa ArchimaBackend como cfg.vaultId.
    # Antes esto estaba hardcodeado a `poc` (vault del experimento) → el AV no podía inyectar las
    # creds del usuario (gmail, etc.) que viven en SU vault. Ahora el agent-token proxya el vault
    # del user → las creds que el broker OAuth pushea ahí se inyectan en los MCP de esta VM.
    # NOTA: el wiki-token NO se entrega acá — lo entrega `wiki-setup` (token firmado real, corre
    # después de assign en ensureVm). El que generaba assign era vestigial (lo pisaba wiki-setup).
    VAULT="${3:?uso: cp.sh assign <name> <vault>}"
    ip="$(vip_wait "$NAME")"; [ -z "$ip" ] && { echo "VM archima-$NAME sin IP"; exit 1; }
    # Nombre del agente AV: el AV exige [a-z0-9-]{3,64}. El nombre de VM trae '_' y MAYÚSCULAS
    # (ej. ...-env_013CMPP...) → sanitizamos a lowercase+guiones, sacamos lo demás y capamos a 60.
    # Determinístico por (vault,VM) → re-assign reusa el mismo agente (idempotente, ver rotate abajo).
    agentname="$(printf 'u%s-%s' "$VAULT" "$NAME" | tr 'A-Z_' 'a-z-' | tr -cd 'a-z0-9-' | cut -c1-60)"
    # token de agente AV: rol proxy sobre el VAULT DEL USUARIO (NO puede leer creds). Idempotente:
    # `create` si es nuevo; si el agente YA existe (re-assign / re-serve), `rotate` da token fresco
    # (e invalida el viejo). Antes esto petaba silencioso porque el nombre traía '_'/mayúsculas.
    avtok="$( (AGENT_VAULT_ADDR=http://192.168.122.1:14321 "$AVBIN" agent create "$agentname" --vault "${VAULT}:proxy" --token-only 2>/dev/null || true) | tail -1)"
    if [ -z "$avtok" ]; then avtok="$( (AGENT_VAULT_ADDR=http://192.168.122.1:14321 "$AVBIN" agent rotate "$agentname" --token-only 2>/dev/null || true) | tail -1)"; fi
    [ -z "$avtok" ] && { echo "archima-$NAME: no pude mintear el agent-token AV para vault $VAULT"; exit 1; }
    # push de la identidad a la VM (env scoped al vault del user, chmod 600)
    tmp="$(mktemp -d)"
    # no_proxy = SÓLO vLLM/local. OJO: Node con NODE_USE_ENV_PROXY=1 prioriza `no_proxy` (minúscula)
    # y DESCARTA `NO_PROXY` (mayúscula, donde el AV mete 192.168.122.1 para vLLM) → la minúscula tiene
    # que incluir TAMBIÉN las exenciones de vLLM/local, o el tráfico a vLLM se va por el MITM = Bad
    # Gateway (turno cuelga en retry-loop hasta el abort de 10 min). (fix vLLM 2026-06-15)
    # SACADO ceibo.example.com (2026-06-21): era over-broad. Estaba para que el git del wiki fuera DIRECTO
    # (supuesto 429 del AV), pero (a) los MCP YA NO viven en ese host (se movieron a ceibo.example.com)
    # y (b) el git del wiki usa WIKI_SYNC_URL_LOCAL (tailscale 100.x por http) en TODAS las VMs → nunca
    # toca ceibo.example.com. Como no_proxy es host-level, este entry bypasseaba el AV para CUALQUIER cosa
    # en ese host → causó que los MCP (cuando vivían ahí) saltearan el Bearer ("Falta el token"). NO
    # re-agregar sin confirmar que algo en ceibo.example.com necesita saltear el AV. (Si alguna vez se cae
    # al fallback público https://ceibo.example.com/api/sync, el git va por el AV — clona OK por el MITM.)
    NOPROXY="192.168.122.1,localhost,127.0.0.1"
    printf 'export AGENT_VAULT_ADDR=http://192.168.122.1:14321\nexport AGENT_VAULT_TOKEN=%s\nexport AGENT_VAULT_VAULT=%s\nexport no_proxy=%s\n' "$avtok" "$VAULT" "$NOPROXY" > "$tmp/agent-vault-env"
    $SCP "$tmp/agent-vault-env" "$AVBIN" archima@$ip: >/dev/null 2>&1
    $SSH archima@$ip 'chmod 600 ~/agent-vault-env; sudo install -m755 ~/agent-vault /usr/local/bin/agent-vault && rm ~/agent-vault' >/dev/null 2>&1
    rm -rf "$tmp"
    echo "archima-$NAME asignada al vault $VAULT — agent-token AV (rol proxy) inyectado"
    ;;
  serve)
    # Arranca opencode serve DENTRO de la VM (idempotente) y espera health. Empuja la
    # config de provider a ~/work. = el "ensureSession" del lado infra.
    # El 3er arg = config (modelo/tier) → LEVER DE GRADUACIÓN: el tier del usuario elige
    # qué modelo recibe su VM (free=local-bajo, paid=local-alto/Claude-vía-AV). Default
    # = Gemma local. La POLÍTICA tier→usuario vive en ceibo (selector, diferido).
    # Args extra (en cualquier orden): [config] = modelo/tier (lever de graduación, default Gemma)
    # y/o --require-vault. Este último lo manda el caller (makeResolveBase) cuando SABE que la VM
    # debe tener vault: si falta el agent-vault-env, NO levantamos opencode PELADO (sin agent-vault =
    # sin egress = MCP externos muertos en silencio y SIN auto-heal, porque serve "exitoso" pelado
    # deja la sesión viva y nunca se re-wrappea). En ese caso fallamos → el caller corre `assign` y
    # reintenta serve, que re-wrappea opencode. Sin --require-vault, el fallback pelado sigue (compat).
    CFG="opencode-delegv2.json"
    REQUIRE_VAULT=0
    for a in "${3:-}" "${4:-}"; do
      case "$a" in
        --require-vault) REQUIRE_VAULT=1 ;;
        "") ;;
        *) CFG="$a" ;;
      esac
    done
    ip="$(vip_wait "$NAME")"; [ -z "$ip" ] && { echo "VM archima-$NAME sin IP"; exit 1; }
    if [ "$REQUIRE_VAULT" = 1 ] && ! $SSH archima@$ip 'test -f /home/archima/agent-vault-env'; then
      echo "archima-$NAME: agent-vault-env ausente con --require-vault → falta assign"; exit 1
    fi
    [ -f "$HERE/../configs/$CFG" ] || { echo "config no existe: configs/$CFG"; exit 1; }
    # La key vLLM NO va versionada: el config trae el placeholder __VLLM_KEY__ y acá lo
    # sustituimos por la key real de un archivo protegido en la box (no en el repo).
    KEYF="${ARCHIMA_VLLM_KEY_FILE:-$HOME/.archima/vllm.key}"
    cfgtmp="$(mktemp)"
    if grep -q "__VLLM_KEY__" "$HERE/../configs/$CFG" && [ -f "$KEYF" ]; then
      sed "s|__VLLM_KEY__|$(cat "$KEYF")|" "$HERE/../configs/$CFG" > "$cfgtmp"
    else
      cp "$HERE/../configs/$CFG" "$cfgtmp"
    fi
    # El provider anthropic NO lleva la API key real: el config trae el placeholder
    # __ANTHROPIC_VAULT_REF__ y acá lo sustituimos por el ref (handle vault-… que el MITM de
    # agent-vault resuelve a la key real, sin que la VM la vea) desde un archivo protegido en la
    # box. Mismo patrón que __VLLM_KEY__. Idempotente: si falta el placeholder o el file, no toca
    # nada (la VM corre envuelta en `agent-vault run`, ver más abajo).
    AREFF="${ARCHIMA_ANTHROPIC_REF_FILE:-$HOME/.archima/anthropic.ref}"
    if grep -q "__ANTHROPIC_VAULT_REF__" "$cfgtmp" && [ -f "$AREFF" ]; then
      sed -i "s|__ANTHROPIC_VAULT_REF__|$(cat "$AREFF")|" "$cfgtmp"
    fi
    # baseURL de inferencia → forwarder del host (192.168.122.1:8000). Cuando opencode corre
    # envuelto en `agent-vault run`, el HTTP a la IP tailnet de vLLM (100.64.0.10) se iría por el
    # MITM-proxy y CUELGA (el forward HTTP del AV no anda); pero `agent-vault run` mete 192.168.122.1
    # en NO_PROXY → exponer vLLM en el gateway del host (vllm-forward.service, socat) y apuntar ahí
    # = inferencia DIRECTA. Idempotente: si el config ya trae el forwarder, el sed no cambia nada.
    sed -i 's|100\.64\.0\.10:8000|192.168.122.1:8000|g' "$cfgtmp"
    $SCP "$cfgtmp" archima@$ip:work-config.json >/dev/null 2>&1 || true
    rm -f "$cfgtmp"
    # AGENTS.md = el system prompt del agente (core de ceibo + adapter-archima). Lo genera el
    # repo oficial (`pnpm --filter @ceibo/gateway print-prompt archima`); acá viaja como config.
    $SCP "$HERE/../configs/AGENTS.md" archima@$ip:work-agents.md >/dev/null 2>&1 || true
    # prompts de los agentes custom (delegv2): el opencode.json los referencia con {file:./...}
    $SCP "$HERE/../configs/prompts/ceibo.md" "$HERE/../configs/prompts/ceibo-worker.md" archima@$ip: >/dev/null 2>&1 || true
    # Arranque vía systemd-run (transient unit): retorna AL INSTANTE y no cuelga el ssh.
    # Backgroundear opencode con `nohup ... &` sobre ssh cuelga el cliente (hereda el
    # canal aunque esté detacheado); systemd se lo lleva y libera el ssh. opencode corre
    # como usuario archima (no-root) → no puede tocar el firewall. pgrep -x: nombre exacto.
    # Si existe ~/agent-vault-env (lo pushea `assign`), opencode corre ENVUELTO en `agent-vault run`:
    # eso le setea HTTPS_PROXY→MITM del AV + el CA al hijo → el AV INYECTA el Bearer per-host en los
    # MCP HTTPS (gmail con token Google, etc.) sin que la VM vea el token (mirror de MA). Sin env
    # (VM sin vault) → fallback unwrapped (compat). pgrep -x opencode encuentra al hijo igual.
    $SSH archima@$ip 'mkdir -p ~/work && mv ~/work-config.json ~/work/opencode.json 2>/dev/null; mv ~/work-agents.md ~/work/AGENTS.md 2>/dev/null; mv ~/ceibo.md ~/work/ceibo.md 2>/dev/null; mv ~/ceibo-worker.md ~/work/ceibo-worker.md 2>/dev/null; OC="/home/archima/.opencode/bin/opencode serve --hostname 0.0.0.0 --port 14420"; if pgrep -x opencode >/dev/null && [ -f /home/archima/agent-vault-env ]; then want=$(grep -o "AGENT_VAULT_TOKEN=.*" /home/archima/agent-vault-env | cut -d= -f2); have=$(tr "\0" "\n" < /proc/$(pgrep -x opencode | head -1)/environ 2>/dev/null | grep "^AGENT_VAULT_TOKEN=" | cut -d= -f2); if [ "$want" != "$have" ]; then sudo systemctl stop opencode-serve 2>/dev/null; sudo pkill -x opencode 2>/dev/null; sleep 1; fi; fi; if pgrep -x opencode >/dev/null; then :; elif [ -f /home/archima/agent-vault-env ]; then sudo systemd-run --quiet --collect --unit=opencode-serve --uid=archima --gid=archima --setenv=HOME=/home/archima --setenv=OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1 --working-directory=/home/archima/work /bin/bash -c "set -a; . /home/archima/agent-vault-env; set +a; exec agent-vault run -- $OC"; else sudo systemd-run --quiet --collect --unit=opencode-serve --uid=archima --gid=archima --setenv=HOME=/home/archima --setenv=OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1 --working-directory=/home/archima/work $OC; fi' >/dev/null 2>&1 || true
    # health-wait 60s (cold-boot real necesita más que 40) con early-exit si el proceso murió
    # (ej. token AV rechazado por el broker tras un reboot → opencode muere al arrancar: no
    # tiene sentido esperar el loop entero; el gateway reintenta con assign + serve).
    for i in $(seq 1 60); do
      curl -sf -m2 "http://$ip:14420/global/health" >/dev/null 2>&1 && { echo "serve @ $ip:14420"; exit 0; }
      if [ "$i" -ge 5 ] && [ $((i % 5)) -eq 0 ] && ! $SSH archima@$ip 'pgrep -x opencode >/dev/null' >/dev/null 2>&1; then
        echo "opencode murió al arrancar en archima-$NAME:"
        $SSH archima@$ip 'sudo journalctl -u opencode-serve --no-pager -n 8 2>/dev/null | tail -8' 2>/dev/null || true
        exit 1
      fi
      sleep 1
    done
    echo "serve no respondió en archima-$NAME"; exit 1
    ;;
  wiki-setup)
    # Prepara el acceso a wikis de una VM por GIT NATIVO (único path autorizado). Lo llama
    # el ArchimaBackend en createSession. Empuja:
    #   - el token de identidad FIRMADO real del user (lo firma el gateway con WIKI_SYNC_SECRET;
    #     ese secreto NUNCA toca la box — acá llega ya firmado y scopeado, como un File resource).
    #     git lo usa por http.extraHeader contra el proxy git scopeado (/api/git); NO hay creds
    #     de GitHub en la VM.
    #   - los clones git de todas las wikis del user en ~/work (wikibomb, abajo).
    # Workspace = ~/work (donde corre opencode y operan sus tools de archivo).
    TOKEN="${3:?uso: cp.sh wiki-setup <name> <token> <url>}"
    URL="${4:?uso: cp.sh wiki-setup <name> <token> <url>}"
    ip="$(vip_wait "$NAME")"; [ -z "$ip" ] && { echo "VM archima-$NAME sin IP"; exit 1; }
    tmp="$(mktemp -d)"
    printf '%s' "$TOKEN" > "$tmp/wiki-token"
    $SSH archima@$ip 'mkdir -p ~/work' >/dev/null 2>&1
    $SCP "$tmp/wiki-token" archima@$ip: >/dev/null 2>&1
    $SSH archima@$ip 'chmod 600 ~/wiki-token' >/dev/null 2>&1
    rm -rf "$tmp"
    # WIKIBOMB: si se pasaron nombres de wiki ($5+), clonarlas TODAS como repos git en ~/work via
    # el proxy git scopeado (/api/git de la box). El token va por http.extraHeader scopeado al host
    # del proxy (no leakea a github). El git del agente (envuelto en agent-vault) confía en el CA del
    # AV y reenvía transparente. Backward-compat: sin wikis no hace nada (comportamiento viejo).
    shift 4 2>/dev/null || true   # $@ = nombres de wiki (sin org/)
    if [ "$#" -gt 0 ]; then
      GITBASE="$(printf '%s' "$URL" | sed -E 's#/api/sync/?$#/api/git#')"
      HOST="$(printf '%s' "$URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
      # Egress allow para el endpoint de sync derivado de la URL (sobrevive a la firewall estática:
      # permite endpoints de tailscale que vm-firewall.sh no conoce). Idempotente; se re-aplica en cada
      # wiki-setup (= en cada turno), así sobrevive a re-spawns.
      hostport="$(printf '%s' "$URL" | sed -E 's#^[a-z]+://##; s#/.*$##')"   # ej. 100.64.0.11:8821
      sync_ip="${hostport%%:*}"
      sync_port="${hostport##*:}"
      case "$URL" in https://*) [ "$sync_port" = "$sync_ip" ] && sync_port=443 ;; http://*) [ "$sync_port" = "$sync_ip" ] && sync_port=80 ;; esac
      if printf '%s' "$sync_ip" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
        $SSH archima@$ip "sudo iptables -C OUTPUT -d $sync_ip -p tcp --dport $sync_port -j ACCEPT 2>/dev/null || sudo iptables -I OUTPUT -d $sync_ip -p tcp --dport $sync_port -j ACCEPT" >/dev/null 2>&1 || true
      fi
      # token scopeado al host del proxy en el gitconfig del user archima (lo usan los git del
      # agente después: pull/push). Lee ~/wiki-token EN la VM (no viaja en claro por acá).
      $SSH archima@$ip "git config --global 'http.${HOST}/.extraHeader' \"Authorization: Bearer \$(cat ~/wiki-token)\"" >/dev/null 2>&1
      for w in "$@"; do
        case "$w" in *[!a-z0-9-]*|'') echo "  wikibomb: '$w' nombre inválido, skip"; continue;; esac
        # RETRY (3×, 2s): el clone puede fallar TRANSITORIO en cold-boot (red/route de la VM
        # no lista justo tras restore/spawn) → sin retry el dir queda ausente y el worker
        # IMPROVISA un `git init` local sin origin (la nota se pierde, no llega a la wiki).
        # Además: si el dir EXISTE pero NO es un clon válido (sin remote origin —p.ej. un init
        # improvisado o un clone parcial), `pull` no recupera → re-clonamos (rm -rf + clone).
        # Y si el origin EXISTE pero apunta a OTRA url (clon viejo con la URL pública pre-tailscale,
        # que el allowlist gatea fuera → clon congelado + writes que no pushean): MIGRAMOS re-clonando
        # contra el GITBASE actual. Sólo `pull` cuando el origin YA coincide con GITBASE/$w.
        #
        # SHALLOW (--depth 1, SOLO en el clone inicial): traemos el working copy, no la historia.
        # Las wikis acumulan cientos/miles de commits (el agente commitea por edición) → el clon full
        # es ~3.5x más pesado y crece sin parar; el grueso del costo es el cold-boot (wikibomb clona
        # TODAS las wikis), así que ahí está la ganancia. El `pull` queda --ff-only SIN --depth a
        # propósito: con --depth re-shallowea y rompe el fast-forward cuando el remote divergió (se
        # aborta). Sin --depth, el pull es incremental (barato igual) y el repo sigue shallow.
        # push/pull/ff-only desde shallow: validado. SIN downside: recuperar una nota archivada
        # (recall / search-archived) lee la historia SERVER-SIDE por la GitHub API (@ceibo/wikis), no
        # del clon de la VM —que es sólo cache de working-copy— así que no hace falta historia local.
        ok=0
        for attempt in 1 2 3; do
          if $SSH archima@$ip "cd ~/work && if [ -d '$w/.git' ] && [ \"\$(git -C '$w' remote get-url origin 2>/dev/null)\" = '${GITBASE}/$w' ]; then git -C '$w' pull --ff-only -q; else rm -rf '$w' && git clone -q --depth 1 '${GITBASE}/$w' '$w'; fi" >/dev/null 2>&1; then
            ok=1; break
          fi
          sleep 2
        done
        if [ "$ok" = 1 ]; then echo "  wikibomb: $w OK"; else echo "  wikibomb: $w FALLO (tras 3 intentos)"; fi
      done
    fi
    echo "archima-$NAME: wiki-sync entregado (script + token, url=$URL)"
    ;;
  state)   $VIRSH domstate "archima-$NAME" 2>/dev/null || echo "missing" ;;
  ip)      printf '%s\n' "$(vip "$NAME")" ;;
  list)    $VIRSH list --all | grep archima || echo "(ninguna)" ;;
  suspend) $VIRSH managedsave "archima-$NAME" >/dev/null && echo "archima-$NAME suspendida (RAM liberada)" ;;
  restore) $VIRSH start "archima-$NAME" >/dev/null && echo "archima-$NAME restaurada" ;;
  destroy) $VIRSH destroy "archima-$NAME" 2>/dev/null || true
           $VIRSH undefine "archima-$NAME" 2>/dev/null || true
           sudo rm -f "$POOL/archima-$NAME.qcow2" "$POOL/archima-$NAME-seed.iso"
           echo "archima-$NAME destruida" ;;
  *) echo "comando desconocido: $cmd"; exit 1 ;;
esac
