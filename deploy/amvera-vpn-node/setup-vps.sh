#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-vps.sh — One-shot VPN node setup for a bare Ubuntu 24.04 VPS.
#
# Run as root from the deploy/amvera-vpn-node/ directory:
#   chmod +x setup-vps.sh && sudo ./setup-vps.sh
#
# What it does:
#   1. Installs Docker (if missing)
#   2. Installs Nginx (if missing)
#   3. Generates a random MGMT_API_SECRET
#   4. Creates .env
#   5. Builds and starts the Docker container (docker compose up --build -d)
#   6. Creates a self-signed TLS certificate (valid 10 years)
#   7. Writes and enables the Nginx config
#   8. Prints the values you need to paste into the admin panel
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[+]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*"; exit 1; }

[[ $EUID -eq 0 ]] || error "Run as root: sudo ./setup-vps.sh"
[[ -f "Dockerfile" ]] || error "Run this script from the deploy/amvera-vpn-node/ directory."

# ── Detect public IP ──────────────────────────────────────────────────────────
VPS_IP=$(curl -fsSL https://api.ipify.org 2>/dev/null || curl -fsSL https://ifconfig.me 2>/dev/null || echo "")
if [[ -z "$VPS_IP" ]]; then
    read -rp "Could not auto-detect public IP. Enter it manually: " VPS_IP
fi
info "VPS public IP: $VPS_IP"

# ── Install Docker ────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
    info "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    info "Docker installed."
else
    info "Docker already installed."
fi

# ── Install Nginx ─────────────────────────────────────────────────────────────
if ! command -v nginx &>/dev/null; then
    info "Installing Nginx..."
    apt-get update -qq
    apt-get install -y --no-install-recommends nginx
    info "Nginx installed."
else
    info "Nginx already installed."
fi

# ── Create .env ───────────────────────────────────────────────────────────────
if [[ -f ".env" ]]; then
    warn ".env already exists — skipping generation. Delete it and rerun to regenerate."
else
    MGMT_SECRET=$(openssl rand -hex 32)
    cat > .env <<EOF
MGMT_API_SECRET=${MGMT_SECRET}
PORT=8443
# Uncomment to enable the Telegram status bot:
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_ADMIN_CHAT_ID=
EOF
    info "Generated .env with MGMT_API_SECRET."
fi

# Read secret back from .env for the summary at the end
MGMT_SECRET=$(grep '^MGMT_API_SECRET=' .env | cut -d= -f2)

# ── Build & start container ───────────────────────────────────────────────────
info "Building Docker image (this takes ~2 min on first run)..."
docker compose build

info "Starting container..."
docker compose up -d
info "Container running."

# ── Self-signed TLS certificate ───────────────────────────────────────────────
mkdir -p /etc/nginx/ssl
if [[ ! -f /etc/nginx/ssl/vpn-node.crt ]]; then
    info "Generating self-signed TLS certificate for IP $VPS_IP ..."
    openssl req -x509 -newkey rsa:4096 \
        -keyout /etc/nginx/ssl/vpn-node.key \
        -out    /etc/nginx/ssl/vpn-node.crt \
        -days   3650 \
        -nodes \
        -subj   "/CN=${VPS_IP}" \
        -addext "subjectAltName=IP:${VPS_IP}"
    chmod 600 /etc/nginx/ssl/vpn-node.key
    info "Certificate created."
else
    info "TLS certificate already exists — skipping."
fi

# ── Nginx config ──────────────────────────────────────────────────────────────
NGINX_CONF="/etc/nginx/sites-available/vpn-node"
cp nginx-vps.conf "$NGINX_CONF"
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/vpn-node
# Disable default site if present
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable nginx
systemctl reload nginx
info "Nginx configured and reloaded."

# ── Firewall (ufw) ────────────────────────────────────────────────────────────
if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
    info "Opening firewall ports 22, 80, 443, 8443..."
    ufw allow 22/tcp   comment "SSH"    > /dev/null
    ufw allow 80/tcp   comment "HTTP"   > /dev/null
    ufw allow 443/tcp  comment "VPN"    > /dev/null
    ufw allow 8443/tcp comment "MGMT"   > /dev/null
fi

# ── Health check ─────────────────────────────────────────────────────────────
info "Waiting 5 s for services to start..."
sleep 5
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8443/health || echo "failed")
if [[ "$HTTP_STATUS" == "200" ]]; then
    info "Management API is responding ✓"
else
    warn "Management API not ready yet (status: $HTTP_STATUS). Check: docker compose logs"
fi

# ── Print registration info ───────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Node is up. Paste these values into the admin panel:${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Host:               ${YELLOW}${VPS_IP}${NC}"
echo -e "  Port:               ${YELLOW}443${NC}"
echo -e "  Management API URL: ${YELLOW}http://${VPS_IP}:8443${NC}"
echo -e "  Management Secret:  ${YELLOW}${MGMT_SECRET}${NC}"
echo ""
echo -e "  Admin panel → VPN Nodes → Добавить ноду"
echo ""
echo -e "${YELLOW}Note: self-signed cert — VPN clients need allowInsecure=true${NC}"
echo -e "      in the connection config (the server sets this automatically"
echo -e "      for nodes registered without a domain)."
echo ""
