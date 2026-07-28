#!/usr/bin/env bash
# memwatch — logea quién se está comiendo la RAM durante el desarrollo, para cazar
# el leak que tumba la máquina. Corre en background mientras desarrollás; cuando
# colapse (o cuando quieras), mirá el log y buscá quién venía CRECIENDO turno a turno.
#
#   bash scripts/memwatch.sh            # cada 30s → ~/memwatch.log
#   INTERVAL=10 LOG=/tmp/mw.log bash scripts/memwatch.sh
#
# Columnas por muestra: timestamp, RAM libre %, swap usado, y el RSS (MB) agregado de
# los sospechosos (claude / node-vite-tsx-esbuild / Brave) + el top-5 de procesos.
# El que importa NO es el valor absoluto: es la PENDIENTE — quién sube y no baja.

set -u
INTERVAL="${INTERVAL:-30}"
LOG="${LOG:-$HOME/memwatch.log}"

# RSS agregado (MB) de los procesos cuyo comando matchea $1
agg() { ps -axo rss,command | grep -iE "$1" | grep -v grep | awk '{s+=$1} END {printf "%d", s/1024}'; }

echo "memwatch → $LOG  (cada ${INTERVAL}s, Ctrl-C para parar)"
{
  echo "# memwatch arrancado $(date -u +%FT%TZ)  intervalo=${INTERVAL}s"
  echo "# ts                 free%  swapMB   claudeMB  nodeMB  braveMB   top5(MB:proc)"
} >> "$LOG"

while true; do
  ts=$(date +%H:%M:%S)
  # % de páginas libres+inactivas sobre el total
  free=$(vm_stat | awk '/page size/{ps=$8} /Pages free/{f=$3} /Pages inactive/{i=$3} /Pages active/{a=$3} /Pages wired/{w=$4} /Pages occupied by compressor/{c=$5} END{gsub(/\./,"",f);gsub(/\./,"",i);gsub(/\./,"",a);gsub(/\./,"",w);gsub(/\./,"",c); tot=f+i+a+w+c; printf "%d", (f+i)*100/tot}')
  swap=$(sysctl -n vm.swapusage | awk '{gsub(/M/,"",$7); printf "%d", $7}')
  claude=$(agg 'claude --dangerously|Claude Helper')
  node=$(agg 'vite|tsx|esbuild|node ')
  brave=$(agg 'Brave Browser')
  top5=$(ps -axo rss,comm | sort -rn | head -5 | awk '{printf "%d:%s ", $1/1024, substr($2,1,28)}')
  printf "%-8s %5s%% %6s  %8s %7s %8s   %s\n" \
    "$ts" "$free" "$swap" "$claude" "$node" "$brave" "$top5" >> "$LOG"
  sleep "$INTERVAL"
done
