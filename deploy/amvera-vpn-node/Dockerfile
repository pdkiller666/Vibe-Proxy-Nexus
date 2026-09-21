FROM python:3.12-slim

ARG XRAY_VERSION=26.3.27
ARG XRAY_SHA256=23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        unzip \
        gettext-base \
        ca-certificates \
        supervisor \
        nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/xray.zip \
        "https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-64.zip" \
    && echo "${XRAY_SHA256}  /tmp/xray.zip" | sha256sum --check --strict \
    && unzip /tmp/xray.zip -d /usr/local/bin xray \
    && chmod +x /usr/local/bin/xray \
    && rm -rf /tmp/xray.zip

RUN mkdir -p /var/log/supervisor

WORKDIR /app

COPY bot/requirements.txt ./bot/requirements.txt
RUN pip install --no-cache-dir --require-hashes --no-deps -r bot/requirements.txt

COPY bot ./bot

# Compile the Xray Stats gRPC proto to Python stubs so xray_manager.py can
# call the Stats API without needing a .proto-to-Python compile at runtime.
RUN python -m grpc_tools.protoc \
    -I./bot \
    --python_out=./bot \
    --grpc_python_out=./bot \
    ./bot/command.proto
COPY xray ./xray
COPY supervisord.conf ./supervisord.conf
COPY render-config.sh ./render-config.sh
RUN chmod +x ./render-config.sh

EXPOSE 443 8443

ENV XRAY_CONFIG_PATH=/etc/xray/config.json

# Check the supervised Xray process and the live Management API. Supervisord
# (PID 1) stays alive when a child crashes, so both checks are required.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD supervisorctl status xray | grep -q RUNNING \
      && python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8443/health', timeout=3).read()" \
      || exit 1

ENTRYPOINT ["/app/render-config.sh"]
