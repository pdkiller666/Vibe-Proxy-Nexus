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
XRAY_BINARY = os.environ.get("XRAY_BINARY", "/usr/local/bin/xray")
WS_INBOUND_TAG = "vless-ws"
REALITY_INBOUND_TAG = "vless-reality"

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


def _inbound(config: dict, transport: str) -> dict:
    if transport not in {"ws", "reality"}:
        raise ValueError("transport must be 'ws' or 'reality'")
    tag = REALITY_INBOUND_TAG if transport == "reality" else WS_INBOUND_TAG
    for inbound in config.get("inbounds", []):
        if inbound.get("tag") == tag:
            return inbound
    raise ValueError(f"Xray inbound {tag!r} is not configured")


def add_client(
    uuid: str, label: str, limit_ip: int | None = None, transport: str = "ws"
) -> None:
    with _lock:
        config = _load_config()
        target = _inbound(config, transport)
        desired_client: dict = {
            "id": uuid,
            "email": uuid if transport == "reality" else label,
        }
        if transport == "reality":
            desired_client["flow"] = "xtls-rprx-vision"
        if limit_ip is not None and limit_ip > 0:
            desired_client["limitIp"] = limit_ip

        managed_inbounds = [
            inbound
            for inbound in config.get("inbounds", [])
            if inbound.get("tag") in {WS_INBOUND_TAG, REALITY_INBOUND_TAG}
        ]
        target_clients = target["settings"]["clients"]
        existing_target = [client for client in target_clients if client.get("id") == uuid]
        existing_elsewhere = [
            client
            for inbound in managed_inbounds
            if inbound is not target
            for client in inbound.get("settings", {}).get("clients", [])
            if client.get("id") == uuid
        ]
        if len(existing_target) == 1 and not existing_elsewhere and existing_target[0] == desired_client:
            return

        # Reality clients require Vision flow; WS clients must not carry it.
        #
        # limitIp is retained as a compatibility hint for a custom Xray build.
        # The pinned vanilla core does not reliably enforce it. Do not add a
        # raw WebSocket/session limit here: one phone opens many WS tunnels.
        # Xray's traffic-stat name is keyed by `email`. Reality stats must
        # reconcile with the central DB by UUID, not by a user-facing label.
        # Treat POST /clients as an idempotent upsert. Removing this UUID from
        # both managed inbounds and adding it to the requested one in the same
        # config write prevents a WS/Reality duplicate and avoids a disconnect
        # between separate remove/add requests.
        for inbound in managed_inbounds:
            clients = inbound.get("settings", {}).get("clients", [])
            clients[:] = [client for client in clients if client.get("id") != uuid]
        target_clients.append(desired_client)
        _save_config(config)
        _reload_xray()


def _derive_reality_public_key(private_key: str) -> str:
    """Derive only the public half of a Reality keypair; never log the input."""
    try:
        result = subprocess.run(
            [XRAY_BINARY, "x25519", "-i", private_key],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        raise ValueError("Unable to derive the loaded Reality public key") from None

    if result.returncode != 0:
        raise ValueError("Unable to derive the loaded Reality public key")
    match = re.search(r"Password \(PublicKey\):\s*(\S+)", result.stdout)
    if not match:
        raise ValueError("Xray did not return a Reality public key")
    return match.group(1)


def get_reality_identity() -> dict:
    """Return public Reality settings from the live Xray config, never its secret key."""
    with _lock:
        config = _load_config()
        inbound = _inbound(config, "reality")
        stream = inbound.get("streamSettings", {})
        reality = stream.get("realitySettings", {})
        private_key = reality.get("privateKey")
        if not isinstance(private_key, str) or not private_key:
            raise ValueError("The loaded Reality inbound has no private key")

        server_names = reality.get("serverNames", [])
        short_ids = reality.get("shortIds", [])
        if not isinstance(server_names, list) or not all(isinstance(x, str) for x in server_names):
            raise ValueError("The loaded Reality inbound has invalid server names")
        if not isinstance(short_ids, list) or not all(isinstance(x, str) for x in short_ids):
            raise ValueError("The loaded Reality inbound has invalid short IDs")

        return {
            "publicKey": _derive_reality_public_key(private_key),
            "port": inbound.get("port"),
            "network": stream.get("network"),
            "security": stream.get("security"),
            "serverNames": server_names,
            "shortIds": short_ids,
            "dest": reality.get("dest"),
        }


def remove_client(uuid: str) -> bool:
    with _lock:
        config = _load_config()
        removed = 0
        for inbound in config.get("inbounds", []):
            if inbound.get("tag") not in {WS_INBOUND_TAG, REALITY_INBOUND_TAG}:
                continue
            clients = inbound.get("settings", {}).get("clients", [])
            removed += sum(1 for c in clients if c.get("id") == uuid)
            clients[:] = [c for c in clients if c.get("id") != uuid]

        if removed == 0:
            return False

        _save_config(config)
        _reload_xray()
        return True


def list_clients() -> list[dict]:
    with _lock:
        config = _load_config()
        result = []
        for inbound in config.get("inbounds", []):
            if inbound.get("tag") not in {WS_INBOUND_TAG, REALITY_INBOUND_TAG}:
                continue
            transport = "reality" if inbound.get("tag") == REALITY_INBOUND_TAG else "ws"
            for client in inbound.get("settings", {}).get("clients", []):
                result.append({**client, "transport": transport})
        return result


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
