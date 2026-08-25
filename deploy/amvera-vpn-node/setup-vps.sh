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

# ── Install Docker + compose plugin ──────────────────────────────────────────
if ! command -v docker &>/dev/null; then
    info "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    info "Docker installed."
else
    info "Docker already installed."
fi

# Ensure docker compose v2 plugin is available (Ubuntu apt ships Docker without it)
if ! docker compose version &>/dev/null 2>&1; then
    info "Installing docker-compose-plugin from Docker's official repo..."
    apt-get install -y ca-certificates curl gnupg lsb-release -qq
    install -m 0755 -d /usr/share/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] \
https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y docker-compose-plugin
    info "docker compose $(docker compose version --short) installed."
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

# Remove dangling build cache immediately — the full cache can grow to 1+ GB
# and is not needed once the image is built and running.
info "Cleaning Docker build cache..."
docker builder prune -af --filter "until=1h" 2>/dev/null || true

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
# limit_conn_zone is legal only in Nginx's http context; Ubuntu includes
# /etc/nginx/conf.d/*.conf from that context by default.
install -d /etc/nginx/conf.d
cp nginx-session-limit.conf /etc/nginx/conf.d/vpn-session-limit.conf
NGINX_CONF="/etc/nginx/sites-available/vpn-node"
cp nginx-vps.conf "$NGINX_CONF"
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/vpn-node
# Disable default site if present
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable nginx
systemctl reload nginx
info "Nginx configured and reloaded."

# ── Install Cockpit (emergency browser-based access) ─────────────────────────
if ! command -v cockpit &>/dev/null && ! dpkg -s cockpit &>/dev/null 2>&1; then
    info "Installing Cockpit (browser-based emergency terminal)..."
    apt-get update -qq
    apt-get install -y --no-install-recommends cockpit cockpit-docker 2>/dev/null \
        || apt-get install -y --no-install-recommends cockpit
    systemctl enable --now cockpit.socket
    info "Cockpit installed and enabled."
else
    info "Cockpit already installed."
    systemctl enable --now cockpit.socket 2>/dev/null || true
fi

# ── Cockpit health check ──────────────────────────────────────────────────────
if systemctl is-active --quiet cockpit.socket; then
    info "cockpit.socket is active ✓"
else
    warn "cockpit.socket does not appear to be running. Check: systemctl status cockpit.socket"
fi

# ── Allow root login in Cockpit ───────────────────────────────────────────────
# Ubuntu 24.04 ships /etc/cockpit/disallowed-users containing "root" by default,
# which causes "Permission denied" even with the correct password.
if [[ -f /etc/cockpit/disallowed-users ]]; then
    sed -i '/^root$/d' /etc/cockpit/disallowed-users
    info "Cockpit: root login enabled (removed from disallowed-users)."
fi

# ── Optional: Cockpit behind Nginx HTTPS proxy ────────────────────────────────
COCKPIT_NGINX=false
read -rp "$(echo -e "${YELLOW}[?]${NC} Expose Cockpit behind Nginx HTTPS proxy? (y/N) ")" _cockpit_ans
if [[ "${_cockpit_ans,,}" == "y" ]]; then
    COCKPIT_NGINX=true
    COCKPIT_NGINX_CONF="/etc/nginx/sites-available/cockpit"
    cat > "$COCKPIT_NGINX_CONF" <<'NGINXEOF'
# Cockpit reverse proxy — reachable only after SSH tunnel or from trusted IPs.
# Access via:  ssh -L 9090:127.0.0.1:443 root@<VPS_IP>  then open https://localhost:9090
server {
    listen 127.0.0.1:9091 ssl;
    server_name localhost;

    ssl_certificate     /etc/nginx/ssl/vpn-node.crt;
    ssl_certificate_key /etc/nginx/ssl/vpn-node.key;

    # Forward Cockpit's required Origin header
    location / {
        proxy_pass https://127.0.0.1:9090;
        proxy_ssl_verify off;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-Proto https;
    }
}
NGINXEOF
    ln -sf "$COCKPIT_NGINX_CONF" /etc/nginx/sites-enabled/cockpit
    nginx -t && systemctl reload nginx
    info "Cockpit Nginx proxy enabled on 127.0.0.1:9091 (HTTPS, localhost-only)."
fi

# ── Firewall (ufw) ────────────────────────────────────────────────────────────
if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
    info "Opening firewall ports 22, 80, 443, 8443..."
    ufw allow 22/tcp   comment "SSH"    > /dev/null
    ufw allow 80/tcp   comment "HTTP"   > /dev/null
    ufw allow 443/tcp  comment "VPN"    > /dev/null
    ufw allow 8443/tcp comment "MGMT"   > /dev/null
    # Cockpit port 9090 must NOT be publicly accessible — SSH tunnel only
    ufw deny 9090      comment "Cockpit (SSH-tunnel only)" > /dev/null
    info "Port 9090 (Cockpit) blocked — accessible only via SSH tunnel."
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
echo -e "${GREEN}── Cockpit (emergency browser terminal) ────────────────${NC}"
echo -e "  Cockpit runs on port 9090 (localhost only, firewall-blocked)."
echo -e "  Open it via SSH tunnel:"
echo ""
echo -e "  ${YELLOW}ssh -N -L 9090:127.0.0.1:9090 root@${VPS_IP}${NC}"
echo ""
echo -e "  Then open ${YELLOW}http://localhost:9090${NC} in your browser."
if [[ "$COCKPIT_NGINX" == "true" ]]; then
echo -e "  (Nginx HTTPS proxy also available on 127.0.0.1:9091 via the same tunnel.)"
fi
echo ""
