"""Reads/writes the live Xray config.json to add or remove VLESS clients,
then asks supervisord to restart the xray process so the change takes effect.
Also provides get_stats() to query per-user traffic counters via Xray's gRPC
Stats API (used by the /stats endpoint in api_server.py).
"""
import json
import os
import re
import subprocess
import threading
from pathlib import Path

import grpc
import command_pb2
import command_pb2_grpc

CONFIG_PATH = Path(os.environ.get("XRAY_CONFIG_PATH", "/etc/xray/config.json"))
XRAY_API_ADDR = os.environ.get("XRAY_API_ADDR", "127.0.0.1:10085")

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
    # supervisord manages the xray process under the name "xray"
    subprocess.run(["supervisorctl", "restart", "xray"], check=False)


def add_client(uuid: str, label: str) -> None:
    with _lock:
        config = _load_config()
        clients = config["inbounds"][0]["settings"]["clients"]

        if any(c.get("id") == uuid for c in clients):
            return

        # WebSocket transport does not use XTLS flow — the "flow" field is
        # only required for VLESS + XTLS-Reality/Vision (raw TCP). Omitting
        # it here keeps the config valid for the WS inbound.
        clients.append({"id": uuid, "email": label})
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


def get_stats() -> list[dict]:
    """Query Xray Stats gRPC API and return per-user byte counters.

    Uses reset=False (absolute cumulative counts), consistent with the
    central server's trafficPolling.ts which computes deltas against
    last_seen_*_bytes stored in the DB. This means a crash between a poll
    and the DB commit simply re-computes the same delta on the next poll
    rather than losing that traffic window.

    Stat name format: "user>>>{uuid}>>>traffic>>>uplink" / ">>>downlink"
    Returns: [{"uuid": str, "uplinkBytes": int, "downlinkBytes": int}, ...]
    """
    counters: dict[str, dict] = {}
    try:
        with grpc.insecure_channel(XRAY_API_ADDR) as channel:
            stub = command_pb2_grpc.StatsServiceStub(channel)
            resp = stub.QueryStats(
                command_pb2.QueryStatsRequest(pattern="user>>>", reset=False)
            )
        for stat in resp.stat:
            m = re.match(r"^user>>>(.+)>>>traffic>>>(uplink|downlink)$", stat.name)
            if not m:
                continue
            uuid, direction = m.group(1), m.group(2)
            entry = counters.setdefault(
                uuid, {"uuid": uuid, "uplinkBytes": 0, "downlinkBytes": 0}
            )
            if direction == "uplink":
                entry["uplinkBytes"] += stat.value
            else:
                entry["downlinkBytes"] += stat.value
    except grpc.RpcError as exc:
        # Xray may not be running yet (startup) or stats not enabled — return empty
        print(f"get_stats: gRPC error: {exc}", flush=True)

    return list(counters.values())
