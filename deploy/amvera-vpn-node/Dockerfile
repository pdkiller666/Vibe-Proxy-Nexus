FROM python:3.12-slim

ARG XRAY_VERSION=26.3.27

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        unzip \
        gettext-base \
        ca-certificates \
        supervisor \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/xray.zip \
        "https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-64.zip" \
    && unzip /tmp/xray.zip -d /usr/local/bin xray \
    && chmod +x /usr/local/bin/xray \
    && rm -rf /tmp/xray.zip

WORKDIR /app

COPY bot/requirements.txt ./bot/requirements.txt
RUN pip install --no-cache-dir -r bot/requirements.txt

COPY bot ./bot
COPY xray ./xray
COPY supervisord.conf ./supervisord.conf
COPY render-config.sh ./render-config.sh
RUN chmod +x ./render-config.sh

EXPOSE 443 8443

ENV XRAY_CONFIG_PATH=/etc/xray/config.json

# Check that Xray is responding. supervisord (PID 1) stays alive even if xray
# crashes, so without this the orchestrator never sees the container as unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD xray -version || exit 1

ENTRYPOINT ["/app/render-config.sh"]
