#!/usr/bin/env bash
# Pre-calienta la GOLDEN: corre `opencode serve` una vez para disparar la migración
# de DB one-time de opencode (~min la 1ra vez) y la HORNEA en la imagen, así ningún
# clon paga el cold-init. Boota un builder linked-clone de la golden, lo calienta,
# limpia y lo sella de vuelta. Corre EN la box. Uso: ./warm-golden.sh
#
# OJO: destruí los clones VIVOS de la golden antes (comparten el backing file).
set -euo pipefail
POOL="${ARCHIMA_POOL:-/var/lib/libvirt/images}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GOLDEN="$POOL/archima-golden.qcow2"
CP="$HERE/cp.sh"
KEY="$HOME/.ssh/archima_vm"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5"
VIRSH="sudo virsh -c qemu:///system"
B="golden-warm"

[ -f "$GOLDEN" ] || { echo "falta la golden ($GOLDEN)"; exit 1; }

# Guard (C1): re-sellar la golden mientras un linked-clone la usa de backing file CORROMPE el
# disco de esa VM (el overlay apunta al backing por path → al reabrirlo lee la golden NUEVA con
# otros offsets = se pierde el estado de esa sesión). Abortamos si hay algún overlay colgando de
# la golden. Override consciente (ya destruiste los clones): I_KILLED_THE_CLONES=1 ./warm-golden.sh
assert_no_clones_on_golden() {
  [ "${I_KILLED_THE_CLONES:-}" = "1" ] && { echo ">>> I_KILLED_THE_CLONES=1 — salteo el chequeo de clones de la golden"; return 0; }
  local f bf deps=""
  for f in "$POOL"/archima-*.qcow2; do
    [ -e "$f" ] || continue
    [ "$f" = "$GOLDEN" ] && continue
    [ "$(basename "$f")" = "archima-$B.qcow2" ] && continue  # el builder de este script
    bf=$(sudo qemu-img info "$f" 2>/dev/null | sed -n 's/^backing file: //p' | sed 's/ (actual.*//')
    [ -n "$bf" ] && [ "$(basename "$bf")" = "archima-golden.qcow2" ] && deps="$deps ${f##*/}"
  done
  [ -z "$deps" ] && return 0
  echo "ABORT: hay clones colgando de la golden; re-sellarla los corrompería:$deps" >&2
  echo "       destruilos (cp.sh destroy <name>) y reintentá, o I_KILLED_THE_CLONES=1 si ya lo hiciste." >&2
  exit 1
}
assert_no_clones_on_golden

echo ">>> spawn builder (clon de la golden)"
bash "$CP" destroy "$B" 2>/dev/null || true
bash "$CP" spawn "$B" 2048 2 >/dev/null
ip="$(bash "$CP" ip "$B")"; [ -z "$ip" ] && { echo "sin IP"; exit 1; }
echo "    builder @ $ip"

echo ">>> pre-warm: opencode serve una vez (dispara la migración de DB)"
# OJO: el `>/dev/null 2>&1` sobre el $SSH + el subshell `(...)` son necesarios — sin
# redirigir la salida del ssh, ssh NO retorna al backgroundear el proceso remoto (espera
# el canal) y cuelga. (Mismo patrón que cp.sh serve.)
$SSH archima@$ip 'mkdir -p ~/work; (cd ~/work && setsid nohup ~/.opencode/bin/opencode serve --hostname 127.0.0.1 --port 14420 >~/work/warm.log 2>&1 </dev/null &)' >/dev/null 2>&1 || true
ok=""
for i in $(seq 1 80); do
  $SSH archima@$ip 'curl -sf -m2 http://127.0.0.1:14420/global/health >/dev/null 2>&1 && echo OK' 2>/dev/null | grep -q OK && { ok="$((i*3))s"; break; }
  sleep 3
done
[ -z "$ok" ] && { echo "    serve no respondió (¿migración colgada?)"; exit 1; }
echo "    serve healthy a los ~$ok (migración hecha)"
# el opencode.db migrado vive en ~/.local/share/opencode (persiste en la imagen);
# sólo limpiamos el cwd de trabajo, no la DB.
$SSH archima@$ip 'pkill -x opencode || true; rm -rf ~/work' || true
sleep 2

echo ">>> limpiando (cloud-init/machine-id/ssh host keys) para clones frescos"
$SSH archima@$ip 'sudo cloud-init clean --logs --seed 2>/dev/null; sudo truncate -s 0 /etc/machine-id; sudo rm -f /etc/ssh/ssh_host_*' 2>&1 | tail -1 || true

echo ">>> apagando builder"
$VIRSH shutdown "archima-$B" >/dev/null
for i in $(seq 1 30); do [ "$($VIRSH domstate "archima-$B" 2>/dev/null)" = "shut off" ] && break; sleep 2; done

echo ">>> sellando golden (flatten overlay → temp → swap atómico)"
sudo qemu-img convert -O qcow2 "$POOL/archima-$B.qcow2" "$GOLDEN.new"
sudo mv "$GOLDEN.new" "$GOLDEN"
$VIRSH undefine "archima-$B" >/dev/null 2>&1 || true
sudo rm -f "$POOL/archima-$B.qcow2" "$POOL/archima-$B-seed.iso"
echo ">>> golden PRE-CALENTADA: $GOLDEN ($(sudo qemu-img info "$GOLDEN" | awk '/disk size/{print $3$4}'))"
