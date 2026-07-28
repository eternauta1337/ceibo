#!/usr/bin/env bash
# Construye la GOLDEN image de archima: una VM molde con opencode baked, limpiada
# (cloud-init clean) para que los clones arranquen frescos. Los clones linked-clone
# de la golden bootean en segundos (no reinstalan opencode) → warm pool.
# Corre EN la box. Uso: ./build-golden.sh
set -euo pipefail

POOL="${ARCHIMA_POOL:-/var/lib/libvirt/images}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GOLDEN="$POOL/archima-golden.qcow2"
B="golden-builder"
KEY="$HOME/.ssh/archima_vm"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5"
VIRSH="sudo virsh -c qemu:///system"

# Guard (C1): re-sellar la golden mientras un linked-clone la usa de backing file CORROMPE el
# disco de esa VM (el overlay apunta al backing por path → al reabrirlo lee la golden NUEVA con
# otros offsets = se pierde el estado de esa sesión). Abortamos si hay algún overlay colgando de
# la golden. Override consciente (ya destruiste los clones): I_KILLED_THE_CLONES=1 ./build-golden.sh
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

echo ">>> spawn builder (instala opencode via cloud-init)"
$VIRSH destroy "archima-$B" 2>/dev/null || true
$VIRSH undefine "archima-$B" 2>/dev/null || true
"$HERE/spawn-vm.sh" "$B" 2048 2

echo ">>> esperando IP + cloud-init (opencode)..."
ip=""
for i in $(seq 1 40); do ip=$($VIRSH domifaddr "archima-$B" 2>/dev/null | awk '/ipv4/{print $4}' | cut -d/ -f1); [ -n "$ip" ] && break; sleep 3; done
[ -z "$ip" ] && { echo "sin IP"; exit 1; }
for i in $(seq 1 60); do $SSH archima@$ip 'test -f ~/.archima-ready && echo OK' 2>/dev/null | grep -q OK && break; sleep 5; done
echo "    builder listo en $ip"

echo ">>> limpiando para que los clones arranquen frescos (cloud-init/machine-id/ssh keys)"
$SSH archima@$ip 'sudo cloud-init clean --logs --seed 2>/dev/null; sudo truncate -s 0 /etc/machine-id; sudo rm -f /etc/ssh/ssh_host_* /home/archima/.archima-ready; sudo rm -rf /var/lib/cloud/instances/*' 2>&1 | tail -1 || true

echo ">>> apagando builder"
$VIRSH shutdown "archima-$B" >/dev/null
for i in $(seq 1 30); do [ "$($VIRSH domstate "archima-$B" 2>/dev/null)" = "shut off" ] && break; sleep 2; done

echo ">>> sellando golden (flatten overlay → standalone qcow2)"
sudo qemu-img convert -O qcow2 "$POOL/archima-$B.qcow2" "$GOLDEN"
$VIRSH undefine "archima-$B" >/dev/null 2>&1 || true
sudo rm -f "$POOL/archima-$B.qcow2" "$POOL/archima-$B-seed.iso"
echo ">>> golden lista: $GOLDEN ($(sudo qemu-img info "$GOLDEN" | awk '/disk size/{print $3$4}'))"
