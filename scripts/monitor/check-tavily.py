#!/usr/bin/env python3
"""ceibo monitor — watchdog de créditos de Tavily.

Pensado para correr como job `--no-agent` de hermes (en gpuhost): imprime NADA
cuando todo está sano (→ hermes queda en silencio) e imprime una alerta legible
—que hermes entrega verbatim— cuando el uso de Tavily cruza un umbral o la
proyección de "días hasta agotarse" baja del piso.

Fuente de datos: GET https://api.tavily.com/usage (Bearer TAVILY_API_KEY).
Devuelve `account.plan_usage` / `plan_limit` y `paygo_usage` / `paygo_limit`.

La API key se lee, en orden:
  1. env TAVILY_API_KEY
  2. el env-file en $CEIBO_MONITOR_ENV
  3. ~/.config/ceibo-monitor/env
  4. el .env del repo de ceibo (~/ceibo/ceibo/.env)

Para proyectar burn-rate se guarda cada lectura en
~/.local/state/ceibo-monitor/tavily.jsonl (una línea JSON por corrida).

Tunables por env:
  TAVILY_ALERT_USED_FRAC   alerta si usado/límite >= esto        (default 0.80)
  TAVILY_ALERT_DAYS        alerta si días-hasta-agotarse <= esto  (default 7)
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

USAGE_URL = "https://api.tavily.com/usage"
STATE_PATH = Path.home() / ".local/state/ceibo-monitor/tavily.jsonl"
BURN_WINDOW_DAYS = 14  # ventana para estimar el ritmo de consumo


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
    candidates = []
    if os.environ.get("CEIBO_MONITOR_ENV"):
        candidates.append(Path(os.environ["CEIBO_MONITOR_ENV"]))
    candidates.append(Path.home() / ".config/ceibo-monitor/env")
    candidates.append(Path.home() / "ceibo/ceibo/.env")
    for p in candidates:
        if p.is_file():
            return p
    return None


_p = _env_file_path()
_FILE_VALS = _load_env_file(_p) if _p else {}


def _get(name: str, default: str = "") -> str:
    """Config: env del proceso primero, luego el env-file, luego default."""
    v = os.environ.get(name)
    if v:
        return v
    return _FILE_VALS.get(name) or default


def _api_key() -> str:
    return _get("TAVILY_API_KEY", "")


def _fetch_usage(key: str) -> dict:
    req = urllib.request.Request(
        USAGE_URL,
        headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)


def _read_prev() -> dict | None:
    """Lectura más vieja dentro de la ventana, para estimar el ritmo."""
    try:
        lines = STATE_PATH.read_text().splitlines()
    except OSError:
        return None
    cutoff = time.time() - BURN_WINDOW_DAYS * 86400
    for line in lines:  # de viejo a nuevo → primero dentro de la ventana
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("ts", 0) >= cutoff and "plan_usage" in rec:
            return rec
    return None


def _append_state(rec: dict) -> None:
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with STATE_PATH.open("a") as f:
            f.write(json.dumps(rec) + "\n")
    except OSError:
        pass  # el watchdog no debe morir por no poder loguear


def _fmt(n: float) -> str:
    return f"{n:,.0f}" if abs(n - round(n)) < 0.5 else f"{n:,.1f}"


def main() -> int:
    used_frac_floor = float(_get("TAVILY_ALERT_USED_FRAC", "0.80"))
    days_floor = float(_get("TAVILY_ALERT_DAYS", "7"))

    key = _api_key()
    if not key:
        print("⚠️ Tavily monitor: falta TAVILY_API_KEY (ni env ni env-file).")
        return 0

    try:
        data = _fetch_usage(key)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:200]
        print(f"⚠️ Tavily monitor: HTTP {e.code} al consultar uso. {body}")
        return 0
    except Exception as e:  # noqa: BLE001 — red/JSON; alertamos en vez de morir mudo
        print(f"⚠️ Tavily monitor: error consultando uso: {e}")
        return 0

    acct = data.get("account", {}) or {}
    plan_usage = acct.get("plan_usage")
    plan_limit = acct.get("plan_limit")
    paygo_usage = acct.get("paygo_usage")
    paygo_limit = acct.get("paygo_limit")
    plan_name = acct.get("current_plan", "?")

    now = time.time()
    prev = _read_prev()
    _append_state(
        {
            "ts": now,
            "plan": plan_name,
            "plan_usage": plan_usage,
            "plan_limit": plan_limit,
            "paygo_usage": paygo_usage,
            "paygo_limit": paygo_limit,
        }
    )

    alerts: list[str] = []

    # --- créditos del plan ---
    if isinstance(plan_limit, (int, float)) and plan_limit > 0 and isinstance(
        plan_usage, (int, float)
    ):
        remaining = plan_limit - plan_usage
        used_frac = plan_usage / plan_limit
        line = (
            f"Tavily [{plan_name}]: {used_frac * 100:.0f}% del plan usado "
            f"({_fmt(plan_usage)}/{_fmt(plan_limit)} créditos, quedan ~{_fmt(remaining)})."
        )

        # ritmo de consumo a partir de la lectura previa dentro de la ventana
        proj = ""
        if prev and isinstance(prev.get("plan_usage"), (int, float)):
            dt_days = (now - prev["ts"]) / 86400
            d_usage = plan_usage - prev["plan_usage"]
            if dt_days > 0.5 and d_usage > 0:
                rate = d_usage / dt_days
                days_left = remaining / rate if rate > 0 else float("inf")
                proj = f" Ritmo ~{_fmt(rate)} créd/día → se agota en ~{days_left:.0f} días."
                if days_left <= days_floor:
                    alerts.append(line + proj)

        if used_frac >= used_frac_floor and not alerts:
            alerts.append(line + proj)

    # --- pay-as-you-go (si hay tope configurado) ---
    if isinstance(paygo_limit, (int, float)) and paygo_limit > 0 and isinstance(
        paygo_usage, (int, float)
    ):
        pf = paygo_usage / paygo_limit
        if pf >= used_frac_floor:
            alerts.append(
                f"Tavily pay-as-you-go: {pf * 100:.0f}% del tope usado "
                f"({_fmt(paygo_usage)}/{_fmt(paygo_limit)})."
            )

    if alerts:
        print("⚠️ " + "\n".join(alerts))
    # sano → stdout vacío → hermes queda en silencio
    return 0


if __name__ == "__main__":
    sys.exit(main())
