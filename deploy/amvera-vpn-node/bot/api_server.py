"""Secured management API for the VPN node.

The Replit backend calls this API to create/revoke Xray VLESS clients whenever
a user's subscription issues or revokes a key. Every request must carry the
`X-Management-Secret` header matching the MGMT_API_SECRET env var.
"""
import os

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

import xray_manager

MGMT_API_SECRET = os.environ.get("MGMT_API_SECRET", "")

app = FastAPI(title="Vibe Proxy Nexus — Node Management API")


def _check_secret(x_management_secret: str | None) -> None:
    if not MGMT_API_SECRET:
        raise HTTPException(
            status_code=500,
            detail="MGMT_API_SECRET is not configured on this node",
        )
    if x_management_secret != MGMT_API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")


class CreateClientBody(BaseModel):
    uuid: str
    label: str


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/clients", status_code=201)
def create_client(
    body: CreateClientBody,
    x_management_secret: str | None = Header(default=None),
) -> dict:
    _check_secret(x_management_secret)
    xray_manager.add_client(body.uuid, body.label)
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
def get_clients(x_management_secret: str | None = Header(default=None)) -> list[dict]:
    _check_secret(x_management_secret)
    return xray_manager.list_clients()
