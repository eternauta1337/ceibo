#!/usr/bin/env bash
# Egress firewall de la VM de archima. Sólo deja salir a: la inferencia, el proxy
# de Agent Vault (gateway del host) y el DNS. Todo lo demás REJECT. opencode corre
# como usuario NO-root => no puede tocar estas reglas (aunque lo prompt-injecten,
# su única salida a internet es Agent Vault). Corre como root (lo invoca cloud-init).
set -euo pipefail
INFER_IP="${ARCHIMA_INFER_IP:-100.64.0.10}"   # endpoint de inferencia (host)
GW="${ARCHIMA_GW:-192.168.122.1}"               # gateway/host (AV proxy + dnsmasq)
SYNC_HOST="${ARCHIMA_SYNC_HOST:-ceibo.example.com}" # endpoint del proxy git de wikis (Exe, /api/git)

iptables -F OUTPUT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A OUTPUT -d "$INFER_IP" -j ACCEPT
iptables -A OUTPUT -d "$GW" -j ACCEPT
# Egress al proxy git de wikis (Exe): la vm gpuhost llega a /api/git con su token firmado (la
# frontera de seguridad es el TOKEN scopeado + el gate de IP del proxy, no la ACL de red). El IP
# del edge de vps.example.com se re-resuelve en cada aplicación del firewall (= en cada spawn) por si
# rota. Sólo 443 (HTTPS). Si no resuelve, seguimos sin esa salida (el sync degradará, no rompe).
sync_ips="$(getent ahostsv4 "$SYNC_HOST" 2>/dev/null | awk '{print $1}' | sort -u)"
for sip in $sync_ips; do iptables -A OUTPUT -d "$sip" -p tcp --dport 443 -j ACCEPT; done
# Egress al web-server por TAILSCALE (IP estable de gpuhost como source; inmune a rotación del IP
# público de gpuhost). ARCHIMA_SYNC_TS = "IP:PORT" del web-server en la tailnet.
if [ -n "${ARCHIMA_SYNC_TS:-}" ]; then
  ts_ip="${ARCHIMA_SYNC_TS%%:*}"; ts_port="${ARCHIMA_SYNC_TS##*:}"
  iptables -A OUTPUT -d "$ts_ip" -p tcp --dport "$ts_port" -j ACCEPT
fi
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited
iptables -P OUTPUT DROP
echo "egress firewall: salida sólo a inferencia=$INFER_IP, gateway/AV=$GW, sync=$SYNC_HOST(${sync_ips:-sin-resolver}):443${ARCHIMA_SYNC_TS:+, sync-ts=$ARCHIMA_SYNC_TS}, DNS"
