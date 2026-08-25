# VPN Node — Xray-core (VLESS+WebSocket)

Самостоятельный Docker-контейнер для **дополнительной VPN-ноды**. Разворачивается на любом VPS и подключается к основному серверу (Amvera) через защищённый REST Management API.

> **Статус:** production, активно используется. Живой NL-узел на VDSina
> (`v917715.hosted-by-vdsina.com`, Let's Encrypt, Xray 26.x) работает параллельно
> с локальной нодой на Amvera. Основной бэкенд (`remoteNode.ts`, `keyIssuance.ts`)
> выдаёт и отзывает ключи, собирает статистику трафика через Management API.

---

## Что запускается внутри контейнера

Три процесса под управлением `supervisord`:

| Процесс | Адрес | Назначение |
|---|---|---|
| **xray** | `127.0.0.1:10000` | VLESS+WebSocket, слушает только loopback |
| **mgmt-api** | `0.0.0.0:$PORT` (дефолт 8443) | HTTP REST API для управления ключами из основного сервера |
| **telegram-bot** | — | Опциональный бот для проверки статуса ноды; **не запускается автоматически** |

TLS-терминацию выполняет **Nginx/Caddy на хосте** — Xray работает в plain-WS, наружу торчит только прокси.

---

## Переменные окружения

| Переменная | Обязательна | Назначение |
|---|---|---|
| `MGMT_API_SECRET` | ✅ | Shared-секрет. Передаётся в заголовке `X-Management-Secret` на каждый вызов API. Генерация: `openssl rand -hex 32` |
| `PORT` | — | Порт management API внутри контейнера (дефолт `8443`) |
| `TELEGRAM_BOT_TOKEN` | — | Токен бота; если не задан — telegram-bot не запускается |
| `TELEGRAM_ADMIN_CHAT_ID` | — | Ограничивает бот одним чатом администратора |

> **REALITY_* переменные не нужны.** Транспорт — VLESS+WebSocket, не Reality.
> Reality требует raw TCP и несовместим с TLS-терминацией на прокси.

---

## Management API

Все эндпоинты (кроме `/health`) требуют заголовок `X-Management-Secret`.

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/health` | Liveness-проба (без авторизации) |
| `POST` | `/clients` | Добавить VLESS-клиента в Xray |
| `DELETE` | `/clients/{uuid}` | Удалить клиента (404 — идемпотентно) |
| `GET` | `/clients` | Список активных клиентов (диагностика) |
| `GET` | `/stats` | Трафик по UUID (абсолютные счётчики, `reset=false`) |
| `GET` | `/system/status` | CPU, RAM, uptime контейнера |
| `GET` | `/system/logs` | Последние строки логов supervisord |
| `POST` | `/system/restart-xray` | Перезапустить Xray внутри контейнера |

---

## Пошаговый план: подключение нового сервера

### Шаг 0. Подготовка

Убедитесь, что у VPS:
- ОС: **Ubuntu 22.04 или 24.04**
- Открыты порты: **80, 443** (для TLS) и **9090** (Cockpit, если нужен снаружи)
- Доступ: SSH от root или пользователя с `sudo`

Определитесь с вариантом:

| Вариант | Когда использовать |
|---|---|
| **A — Caddy + домен** | Есть домен, A-запись направлена на IP этого VPS. Let's Encrypt автоматически. |
| **B — Nginx + bare IP** | Нет домена, `setup-vps.sh` делает всё сам включая самоподписанный сертификат. |

---

### Вариант A: Caddy + домен

**1. Установить Docker и Caddy:**

```bash
curl -fsSL https://get.docker.com | sh
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

**2. Скачать только нужную папку (sparse checkout — не тянет весь монорепо):**

```bash
git clone --filter=blob:none --sparse \
  https://TOKEN@github.com/pdkiller666/Vibe-Proxy-Nexus.git /opt/vpn-node
cd /opt/vpn-node
git sparse-checkout set deploy/amvera-vpn-node
cd deploy/amvera-vpn-node
```

> Замените `TOKEN` на GitHub Personal Access Token с правом `repo:read`.

**3. Создать `.env`:**

```bash
cp .env.example .env
# Записать секрет в .env:
sed -i "s/^MGMT_API_SECRET=.*/MGMT_API_SECRET=$(openssl rand -hex 32)/" .env
cat .env   # убедиться, что секрет проставлен
```

**4. Собрать и запустить контейнер:**

```bash
docker compose up -d --build
# Удалить сборочный кэш (освобождает ~1 ГБ, образ уже запущен):
docker builder prune -af --filter "until=1h"
```

**5. Настроить Caddy:**

```bash
cat > /etc/caddy/Caddyfile << 'EOF'
node.example.com {
    handle /vpnws* {
        reverse_proxy localhost:10000
    }
    handle {
        reverse_proxy localhost:8443
    }
}
EOF
# Заменить домен:
sed -i 's/node.example.com/ВАШ_ДОМЕН/g' /etc/caddy/Caddyfile
systemctl reload caddy
```

**6. Проверка:**

```bash
curl https://ВАШ_ДОМЕН/health   # → {"status":"ok"}
```

**7. Зарегистрировать ноду** — см. раздел [«Регистрация ноды в админ-панели»](#регистрация-ноды-в-админ-панели) ниже.

---

### Вариант B: Nginx + bare IP (рекомендуется, если домена нет)

`setup-vps.sh` делает шаги 1–6 полностью автоматически:

**1. Скачать только нужную папку (sparse checkout):**

```bash
git clone --filter=blob:none --sparse \
  https://TOKEN@github.com/pdkiller666/Vibe-Proxy-Nexus.git /opt/vpn-node
cd /opt/vpn-node
git sparse-checkout set deploy/amvera-vpn-node
cd deploy/amvera-vpn-node
```

> Замените `TOKEN` на GitHub Personal Access Token с правом `repo:read`.

**2. Запустить скрипт:**

```bash
chmod +x setup-vps.sh && sudo ./setup-vps.sh
```

Скрипт автоматически:
- ✅ Устанавливает Docker и Nginx
- ✅ Генерирует `MGMT_API_SECRET` и создаёт `.env`
- ✅ Собирает Docker-образ и запускает контейнер
- ✅ Удаляет сборочный кэш (`docker builder prune`) — экономит ~1 ГБ
- ✅ Генерирует самоподписанный TLS-сертификат
- ✅ Настраивает Nginx (WS-прокси на Xray + HTTPS на mgmt-API)
- ✅ Устанавливает Cockpit и **разрешает root-логин** (убирает `/etc/cockpit/disallowed-users`)
- ✅ Закрывает порт 9090 снаружи через UFW (Cockpit — только через SSH-туннель)
- ✅ Выводит все данные для регистрации ноды

**3. Зарегистрировать ноду** — см. раздел [«Регистрация ноды в админ-панели»](#регистрация-ноды-в-админ-панели) ниже.

---

## Регистрация ноды в админ-панели

Откройте `/admin` → **VPN Nodes** → **Добавить ноду**:

| Поле | Значение |
|---|---|
| Название | Например: `Netherlands (VDSina)` |
| Регион | Код страны, например: `nl`, `de`, `ru` |
| Host | IP-адрес VPS или домен (если есть Let's Encrypt сертификат) |
| Port | `443` |
| SNI | То же, что Host |
| Management API URL | `http://IP:8443` (bare IP) или `https://домен` |
| Management API Secret | Значение `MGMT_API_SECRET` из `.env` |
| Public Key / Short ID | Оставить пустыми (не используются для VLESS+WS) |
| Cert SHA256 | SHA-256 fingerprint самоподписанного сертификата — только для bare-IP нод без домена; домены с Let's Encrypt оставьте пустым |

> **Cert SHA256** для bare-IP выводится в конце `setup-vps.sh`. Вручную:
> ```bash
> openssl x509 -noout -fingerprint -sha256 -in /etc/nginx/ssl/vpn-node.crt \
>   | sed 's/sha256 Fingerprint=//I;s/://g' | tr '[:upper:]' '[:lower:]'
> ```

После сохранения нода появится в списке. Кнопка **«Проверить соединение»** подтверждает доступность Management API.

---

## Обновление ноды

```bash
cd /opt/vpn-node
git pull
cd deploy/amvera-vpn-node
docker compose build
docker compose up -d
nginx -t && systemctl reload nginx
# Удалить старые Docker-слои и build cache (освобождает 1–2 ГБ):
docker system prune -af --volumes=false
```

> **Sparse checkout** настраивается один раз при клонировании — `git pull` после этого
> подтягивает только изменения в `deploy/amvera-vpn-node/`, не скачивая артефакты и библиотеки.

Существующие ключи сохраняются — `render-config.sh` при каждом старте переносит
список `clients` из persistent-тома `/etc/xray` в обновлённый конфиг.

---

## Диагностика

```bash
# Логи всех процессов
docker compose logs -f

# Проверить management API
curl http://localhost:8443/health

# Проверить список клиентов в Xray
curl -H "X-Management-Secret: $(grep MGMT_API_SECRET .env | cut -d= -f2)" \
  http://localhost:8443/clients

# CPU / RAM / uptime контейнера
curl -H "X-Management-Secret: $(grep MGMT_API_SECRET .env | cut -d= -f2)" \
  http://localhost:8443/system/status

# Последние логи Xray внутри контейнера
curl -H "X-Management-Secret: $(grep MGMT_API_SECRET .env | cut -d= -f2)" \
  "http://localhost:8443/system/logs?program=xray&lines=50"
```

---

## Аварийный доступ (Cockpit)

**Cockpit** — браузерный терминал + мониторинг ресурсов (порт 9090). Нужен как резервный инструмент, когда SSH-клиента нет под рукой.

`setup-vps.sh` устанавливает Cockpit автоматически. При ручной установке:

```bash
apt install -y cockpit
systemctl enable --now cockpit.socket

# Разрешить root-логин (Ubuntu 24.04 блокирует его по умолчанию):
sed -i '/^root$/d' /etc/cockpit/disallowed-users
systemctl restart cockpit.socket

# Закрыть прямой доступ к порту (только SSH-туннель):
ufw deny 9090
```

### Доступ через SSH-туннель (рекомендуется)

```bash
ssh -L 9090:localhost:9090 root@<IP_VPS>
# или с ключом:
ssh -i ~/.ssh/id_rsa -L 9090:localhost:9090 root@<IP_VPS>
```

После этого откройте **http://localhost:9090** в браузере и войдите под `root`.

На Android/iOS: Termius, JuiceSSH, Blink — любой SSH-клиент с поддержкой туннелей.

### Доступ через Nginx-прокси (альтернатива)

Если SSH-туннель неудобен, можно проксировать Cockpit за HTTPS + HTTP Basic Auth.
Готовый блок находится в `nginx-vps.conf` в виде закомментированного `server`-блока.

---

## Производительность Xray: DNS, sniffing и блокировка QUIC

Все настройки ниже уже включены в шаблон `xray/config.json.template`.

**DNS — быстрые серверы первыми:**
```json
"dns": {
  "servers": ["1.1.1.1", "8.8.8.8", "localhost"],
  "queryStrategy": "UseIPv4"
}
```

**`sniffing` — выключен** (`"enabled": false`).

> Включение sniffing с `destOverride: ["quic"]` заставляет Xray туннелировать
> UDP/QUIC-трафик через WebSocket (TCP). Это создаёт проблему "UDP over TCP":
> два конкурирующих слоя управления потоком резко снижают скорость на сайтах,
> активно использующих HTTP/3 (Gemini, Google Search, YouTube). Sniffing на
> VLESS+WS без дополнительных routing-правил никакой пользы не даёт.

**Блокировка QUIC (UDP port 443) — обязательно:**
```json
"routing": {
  "rules": [
    {
      "type": "field",
      "network": "udp",
      "port": "443",
      "outboundTag": "blocked"
    }
  ]
}
```

Когда QUIC заблокирован, браузер и VPN-клиент (Happ, v2rayNG) мгновенно
переключаются на HTTP/2 (TCP) — работает стабильно и быстро через WS-туннель.

**`connIdle: 60`** в `policy.levels.0` — закрывает простаивающие соединения
через 60 с, высвобождая ресурсы при большом числе пользователей.
