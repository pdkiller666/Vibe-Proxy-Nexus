"""Reads/writes the live Xray config.json to add or remove VLESS clients,
then asks supervisord to restart the xray process so the change takes effect.
"""
import json
import os
import subprocess
import threading
from pathlib import Path

CONFIG_PATH = Path(os.environ.get("XRAY_CONFIG_PATH", "/etc/xray/config.json"))

_lock = threading.Lock()


def _load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_config(config: dict) -> None:
    tmp_path = CONFIG_PATH.with_suffix(".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    tmp_path.replace(CONFIG_PATH)


def _reload_xray() -> None:
    # supervisord manages the xray process under the name "xray" (see supervisord.conf)
    subprocess.run(["supervisorctl", "restart", "xray"], check=False)


def add_client(uuid: str, label: str) -> None:
    with _lock:
        config = _load_config()
        clients = config["inbounds"][0]["settings"]["clients"]

        if any(c.get("id") == uuid for c in clients):
            return

        clients.append(
            {
                "id": uuid,
                "email": label,
                "flow": "xtls-rprx-vision",
            }
        )
        _save_config(config)
        _reload_xray()


def remove_client(uuid: str) -> bool:
    with _lock:
        config = _load_config()
        clients = config["inbounds"][0]["settings"]["clients"]
        before = len(clients)
        clients[:] = [c for c in clients if c.get("id") != uuid]

        if len(clients) == before:
            return False

        _save_config(config)
        _reload_xray()
        return True


def list_clients() -> list[dict]:
    with _lock:
        config = _load_config()
        return list(config["inbounds"][0]["settings"]["clients"])
