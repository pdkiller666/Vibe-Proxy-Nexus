"""Secured management API for the VPN node.

The Replit backend calls this API to create/revoke Xray VLESS clients whenever
a user's subscription issues or revokes a key. Every request must carry the
`X-Management-Secret` header matching the MGMT_API_SECRET env var.

Endpoints:
  POST   /clients               — add a VLESS client to Xray
  DELETE /clients/{uuid}        — remove a VLESS client from Xray
  GET    /clients               — list all active clients (diagnostic)
  GET    /stats                 — per-UUID traffic counters (for trafficPolling.ts)
  GET    /health                — liveness probe (no auth required)
  GET    /system/status         — CPU, RAM, disk, uptime
  GET    /system/logs           — last N lines of xray or mgmt-api stdout
  POST   /system/restart-xray   — supervisorctl restart xray
"""
import os
import subprocess
import time

import psutil
from fastapi import FastAPI, Header, HTTPException, Query

import xray_manager

MGMT_API_SECRET = os.environ.get("MGMT_API_SECRET", "")

app = FastAPI(title="VPNexus — Node Management API")

# Processes available for log retrieval.
_ALLOWED_PROCESSES = {"xray", "mgmt-api"}


def _check_secret(x_management_secret: str | None) -> None:
    if not MGMT_API_SECRET:
        raise HTTPException(
            status_code=500,
            detail="MGMT_API_SECRET is not configured on this node",
        )
    if x_management_secret != MGMT_API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")


class CreateClientBody:
    def __init__(self, uuid: str, label: str, limitIp: int | None = None):
        self.uuid = uuid
        self.label = label
        self.limitIp = limitIp


from pydantic import BaseModel


class CreateClientBody(BaseModel):
    uuid: str
    label: str
    limitIp: int | None = None


class TrafficStat(BaseModel):
    uuid: str
    uplinkBytes: int
    downlinkBytes: int


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/clients", status_code=201)
def create_client(
    body: CreateClientBody,
    x_management_secret: str | None = Header(default=None),
) -> dict:
    _check_secret(x_management_secret)
    xray_manager.add_client(body.uuid, body.label, body.limitIp)
    return {"uuid": body.uuid, "label": body.label}


@app.delete("/clients/{client_uuid}", status_code=204)
def delete_client(
    client_uuid: str,
    x_management_secret: str | None = Header(default=None),
) -> None:
    _check_secret(x_management_secret)
    removed = xray_manager.remove_client(client_uuid)
    if not removed:
        raise HTTPException(status_code=404, detail="Client not found")


@app.get("/clients")
def get_clients(
    x_management_secret: str | None = Header(default=None),
) -> list[dict]:
    _check_secret(x_management_secret)
    return xray_manager.list_clients()


@app.get("/stats", response_model=list[TrafficStat])
def get_stats(
    x_management_secret: str | None = Header(default=None),
) -> list[dict]:
    """Return per-UUID cumulative traffic counters from Xray's Stats gRPC API.

    Uses reset=False so counters are absolute (cumulative since last Xray
    start). The central trafficPolling.ts computes deltas against its own
    last_seen_*_bytes DB columns — identical to its local Xray gRPC flow.
    """
    _check_secret(x_management_secret)
    return xray_manager.get_stats()


# ─── System management endpoints ──────────────────────────────────────────────


@app.get("/system/status")
def system_status(
    x_management_secret: str | None = Header(default=None),
) -> dict:
    """Return CPU%, RAM (used/total), disk (used/total), and container uptime."""
    _check_secret(x_management_secret)

    cpu_percent = psutil.cpu_percent(interval=0.5)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")

    with open("/proc/uptime") as f:
        uptime_seconds = int(float(f.read().split()[0]))

    return {
        "cpuPercent": cpu_percent,
        "ramUsedBytes": mem.used,
        "ramTotalBytes": mem.total,
        "diskUsedBytes": disk.used,
        "diskTotalBytes": disk.total,
        "uptimeSeconds": uptime_seconds,
    }


@app.get("/system/logs")
def system_logs(
    process: str = Query(default="xray"),
    lines: int = Query(default=100, ge=1, le=1000),
    x_management_secret: str | None = Header(default=None),
) -> dict:
    """Return the last N lines of stdout for the given supervised process.

    supervisord keeps a ring buffer in memory even when stdout_logfile=/dev/stdout.
    We request a generous byte budget (~200 bytes/line) and then trim to `lines`.
    """
    _check_secret(x_management_secret)

    if process not in _ALLOWED_PROCESSES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid process '{process}'. Allowed: {sorted(_ALLOWED_PROCESSES)}",
        )

    # Fetch from supervisord's in-memory ring buffer.
    # supervisorctl tail -<bytes> <program> reads from stdout channel.
    byte_budget = max(lines * 250, 8192)
    result = subprocess.run(
        ["supervisorctl", "tail", f"-{byte_budget}", process, "stdout"],
        capture_output=True,
        text=True,
        timeout=10,
    )
    raw = result.stdout or result.stderr or ""
    # Trim to requested line count from the bottom.
    log_lines = [l for l in raw.splitlines() if l] [-lines:]

    return {"process": process, "lines": log_lines}


@app.post("/system/restart-xray")
def restart_xray(
    x_management_secret: str | None = Header(default=None),
) -> dict:
    """Restart the xray process via supervisorctl and return refreshed system status."""
    _check_secret(x_management_secret)

    result = subprocess.run(
        ["supervisorctl", "restart", "xray"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    ok = result.returncode == 0
    output = (result.stdout or result.stderr or "").strip()

    # Return fresh system status so the UI can update immediately.
    cpu_percent = psutil.cpu_percent(interval=0.3)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    with open("/proc/uptime") as f:
        uptime_seconds = int(float(f.read().split()[0]))

    return {
        "ok": ok,
        "output": output,
        "status": {
            "cpuPercent": cpu_percent,
            "ramUsedBytes": mem.used,
            "ramTotalBytes": mem.total,
            "diskUsedBytes": disk.used,
            "diskTotalBytes": disk.total,
            "uptimeSeconds": uptime_seconds,
        },
    }
