from __future__ import annotations

import json
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

import aiogram
import aiohttp
import fastapi
import grpc
import psutil
import pydantic
import starlette
import uvicorn

import api_server
import command_pb2
import command_pb2_grpc
import xray_manager


EXPECTED_ROUTES = {
    ("GET", "/health"),
    ("POST", "/clients"),
    ("DELETE", "/clients/{client_uuid}"),
    ("GET", "/clients"),
    ("GET", "/stats"),
    ("GET", "/system/status"),
    ("GET", "/system/logs"),
    ("POST", "/system/restart-xray"),
}


def request_json(url: str, secret: str | None = None) -> tuple[int, object]:
    headers = {"X-Management-Secret": secret} if secret else {}
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def verify_running_api() -> None:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    config = uvicorn.Config(
        api_server.app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    deadline = time.monotonic() + 10
    while not server.started and thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.05)
    if not server.started:
        raise RuntimeError("Management API did not start")

    try:
        base_url = f"http://127.0.0.1:{port}"
        health_status, health = request_json(f"{base_url}/health")
        if health_status != 200 or health != {"status": "ok"}:
            raise RuntimeError(f"Unexpected health response: {health_status} {health}")

        unauthorized_status, _ = request_json(f"{base_url}/clients")
        if unauthorized_status != 401:
            raise RuntimeError(f"Unauthenticated /clients returned {unauthorized_status}")

        clients_status, clients = request_json(
            f"{base_url}/clients",
            secret="smoke-test-only",
        )
        if clients_status != 200 or clients != []:
            raise RuntimeError(f"Unexpected /clients response: {clients_status} {clients}")
    finally:
        server.should_exit = True
        thread.join(timeout=5)

    if thread.is_alive():
        raise RuntimeError("Management API did not stop cleanly")


def main() -> None:
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError(f"Python 3.12 is required, got {sys.version.split()[0]}")

    actual_routes = {
        (method, route.path)
        for route in api_server.app.routes
        for method in (route.methods or set())
    }
    missing = EXPECTED_ROUTES - actual_routes
    if missing:
        raise RuntimeError(f"Missing Management API routes: {sorted(missing)}")

    verify_running_api()

    # Keep imports referenced so static tooling cannot silently remove them.
    assert command_pb2 and command_pb2_grpc and xray_manager

    print(
        "VPN node smoke test passed",
        {
            "python": sys.version.split()[0],
            "fastapi": fastapi.__version__,
            "starlette": starlette.__version__,
            "uvicorn": uvicorn.__version__,
            "pydantic": pydantic.__version__,
            "aiogram": aiogram.__version__,
            "aiohttp": aiohttp.__version__,
            "grpcio": grpc.__version__,
            "psutil": psutil.__version__,
            "routes": len(actual_routes),
            "http": "ok",
        },
    )


if __name__ == "__main__":
    main()