#!/usr/bin/env bash
# Spawnea una VM KVM de archima por linked-clone de la base Ubuntu + cloud-init.
# Corre EN la box (gpuhost). Usa el SYSTEM libvirt (qemu:///system) para tener la
# red NAT default (virbr0): la VM toma IP en 192.168.122.0/24, llega al host por
# 192.168.122.1, y es alcanzable por ssh desde el host. Discos en el pool de libvirt
# (/var/lib/libvirt/images) por AppArmor. CPU-only (no GPU).
# Uso: ./spawn-vm.sh <nombre> [ram_mb] [vcpus]
set -euo pipefail

NAME="${1:?uso: spawn-vm.sh <nombre> [ram_mb] [vcpus]}"
RAM="${2:-2048}"
VCPUS="${3:-2}"
POOL="${ARCHIMA_POOL:-/var/lib/libvirt/images}"
RUNTIME="${ARCHIMA_RUNTIME:-$(cd "$(dirname "$0")/.." && pwd)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="$POOL/archima-noble-base.img"
DISK="$POOL/archima-${NAME}.qcow2"
SEED="$POOL/archima-${NAME}-seed.iso"

[ -f "$HOME/.ssh/archima_vm.pub" ] || { echo "falta ~/.ssh/archima_vm.pub (corre provision.sh)"; exit 1; }
[ -f "$RUNTIME/vms/noble-base.img" ] || { echo "falta la cloud image base (corre provision.sh)"; exit 1; }

# base pristina en el pool (copiada del runtime una vez)
[ -f "$BASE" ] || sudo cp "$RUNTIME/vms/noble-base.img" "$BASE"

# overlay linked-clone (no toca la base) + espacio para crecer (growpart al boot)
sudo qemu-img create -f qcow2 -F qcow2 -b "$BASE" "$DISK" 12G >/dev/null

# seed de cloud-init con la pubkey real
ud="$(mktemp)"
sed "s|__SSH_PUBKEY__|$(cat "$HOME/.ssh/archima_vm.pub")|" "$HERE/user-data.tpl.yaml" > "$ud"
sudo cloud-localds "$SEED" "$ud"
rm -f "$ud"

sudo virt-install --connect qemu:///system --name "archima-${NAME}" \
  --memory "$RAM" --vcpus "$VCPUS" \
  --disk "$DISK",device=disk,bus=virtio \
  --disk "$SEED",device=cdrom \
  --os-variant ubuntu24.04 --import \
  --network network=default,model=virtio \
  --graphics none --noautoconsole

echo "VM 'archima-${NAME}' booteando (${RAM}MB, ${VCPUS}vcpu)."
echo "IP: sudo virsh -c qemu:///system domifaddr archima-${NAME}  (esperá ~1 min)"
