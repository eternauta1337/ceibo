#!/usr/bin/env python3
"""ceibo monitor — watchdog de facturación de Inworld vía Gmail.

Inworld NO expone API de saldo, pero **manda mails**: recibos (cada cobro/recarga)
y —si los emite— avisos de saldo bajo. Este watchdog mira el Gmail del owner (vía
el skill google-workspace de hermes, ya autenticado en gpuhost) y alerta a Telegram
cuando aparece un mail **transaccional** nuevo de Inworld. Excluye el marketing
(`CATEGORY_PROMOTIONS`) para no dar falsos positivos.

Pensado para correr como job `--no-agent` de hermes: stdout vacío = silencio,
stdout no-vacío = se entrega verbatim. Determinístico, sin tokens de LLM.

Señales que disparan alerta (mail de un remitente `*inworld.ai` y NO promociones):
  - **recibo**: from `invoice+statements@inworld.ai`  → hubo un cobro/recarga.
  - **saldo bajo**: asunto/snippet matchea `LOW_BALANCE_RE` (por si Inworld emite uno).

Dedup: guarda los message-id ya avisados en
~/.local/state/ceibo-monitor/inworld-seen.txt. En la PRIMERA corrida siembra los
matches actuales SIN alertar (baseline), para no avisar de mails viejos al instalar.

Config (env o el env-file ~/.config/ceibo-monitor/env):
  CEIBO_GAPI_PYTHON   python con las google libs (default: venv de hermes)
  CEIBO_GAPI_SCRIPT   ruta a google_api.py del skill
  INWORLD_LOOKBACK_DAYS   ventana de búsqueda (default 3)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

STATE_PATH = Path.home() / ".local/state/ceibo-monitor/inworld-seen.txt"
HERMES = Path.home() / ".hermes/hermes-agent"
DEFAULT_GAPI_PY = HERMES / "venv/bin/python"
DEFAULT_GAPI = HERMES / "skills/productivity/google-workspace/scripts/google_api.py"

RECEIPT_FROM = "invoice+statements@inworld.ai"
LOW_BALANCE_RE = re.compile(
    r"\b(low balance|running low|out of credits|credits?\s+(are\s+)?low|"
    r"top\s?up|insufficient|balance is low|add credits to keep|reload failed)\b",
    re.I,
)


def _load_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


def _env_file_path() -> Path | None:
    cands = []
    if os.environ.get("CEIBO_MONITOR_ENV"):
        cands.append(Path(os.environ["CEIBO_MONITOR_ENV"]))
    cands.append(Path.home() / ".config/ceibo-monitor/env")
    for p in cands:
        if p.is_file():
            return p
    return None


_p = _env_file_path()
_FILE_VALS = _load_env_file(_p) if _p else {}


def _get(name: str, default: str = "") -> str:
    v = os.environ.get(name)
    if v:
        return v
    return _FILE_VALS.get(name) or default


def _gmail_search(query: str, max_results: int = 25) -> list[dict]:
    py = _get("CEIBO_GAPI_PYTHON", str(DEFAULT_GAPI_PY))
    gapi = _get("CEIBO_GAPI_SCRIPT", str(DEFAULT_GAPI))
    res = subprocess.run(
        [py, gapi, "gmail", "search", query, "--max", str(max_results)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip()[:300] or f"google_api exit {res.returncode}")
    out = res.stdout.strip()
    if not out or out[0] not in "[{":
        return []  # "No messages found." u otra salida no-JSON → sin resultados
    data = json.loads(out)
    return data if isinstance(data, list) else data.get("messages", [])


def _is_transactional(msg: dict) -> str | None:
    """Devuelve el tipo de alerta ('recibo'/'saldo bajo') o None si no aplica."""
    frm = (msg.get("from") or "").lower()
    if "inworld.ai" not in frm:
        return None
    labels = set(msg.get("labels") or [])
    if "CATEGORY_PROMOTIONS" in labels:
        return None  # marketing/onboarding → no es transaccional
    if RECEIPT_FROM in frm:
        return "recibo"
    text = f"{msg.get('subject', '')} {msg.get('snippet', '')}"
    if LOW_BALANCE_RE.search(text):
        return "saldo bajo"
    return None


def _load_seen() -> set[str]:
    try:
        return set(STATE_PATH.read_text().split())
    except OSError:
        return set()


def _save_seen(ids: set[str]) -> None:
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text("\n".join(sorted(ids)) + "\n")
    except OSError:
        pass


def main() -> int:
    lookback = _get("INWORLD_LOOKBACK_DAYS", "7")
    try:
        msgs = _gmail_search(f"from:inworld.ai newer_than:{lookback}d")
    except Exception as e:  # noqa: BLE001 — alertar en vez de morir mudo
        print(f"⚠️ Inworld monitor: error leyendo Gmail: {e}")
        return 0

    hits = [(m, t) for m in msgs if (t := _is_transactional(m))]
    seen = _load_seen()
    first_run = not STATE_PATH.exists()

    new_hits = [(m, t) for (m, t) in hits if m.get("id") not in seen]

    # persistir todos los ids transaccionales vistos (baseline + nuevos)
    _save_seen(seen | {m.get("id", "") for m, _ in hits})

    if first_run or not new_hits:
        return 0  # baseline silencioso, o nada nuevo → silencio

    lines = []
    for m, t in new_hits:
        icon = "🧾" if t == "recibo" else "⚠️"
        lines.append(f"{icon} Inworld ({t}): \"{m.get('subject', '?')}\" — {m.get('date', '')}")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
