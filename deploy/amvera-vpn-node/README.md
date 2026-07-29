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
| **telegram-bot** | — | Опциональный бот для проверки статуса ноды из Telegram; **не запускается автоматически** |

TLS-терминацию выполняет **Nginx на хосте** — Xray работает в plain-WS, наружу торчит только Nginx.

---

## Переменные окружения

| Переменная | Обязательна | Назначение |
|---|---|---|
| `MGMT_API_SECRET` | ✅ | Shared-секрет. Основной сервер посылает его в заголовке `X-Management-Secret` на каждый вызов API. Генерация: `openssl rand -hex 32` |
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

---

## Быстрый старт на VPS (Ubuntu 22.04 / 24.04)

### Если есть домен → Caddy (проще)

Caddy сам получает Let's Encrypt сертификат — никаких ручных действий с TLS:

```bash
# Установить Docker и Caddy
curl -fsSL https://get.docker.com | sh
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

# Получить только нужную папку (sparse checkout — не тянет весь монорепо)
git clone --filter=blob:none --sparse https://TOKEN@github.com/pdkiller666/Vibe-Proxy-Nexus.git /opt/vpn-node
cd /opt/vpn-node
git sparse-checkout set deploy/amvera-vpn-node
cd deploy/amvera-vpn-node

# Создать .env
cp .env.example .env
# Открыть .env и вставить MGMT_API_SECRET=$(openssl rand -hex 32)

# Запустить контейнер (host-сеть: Xray на 127.0.0.1:10000, mgmt на 0.0.0.0:8443)
docker compose up -d --build

# Caddyfile
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
sed -i 's/node.example.com/ВАШ_ДОМЕН/g' /etc/caddy/Caddyfile
systemctl reload caddy

# Проверка
curl https://ВАШ_ДОМЕН/health   # {"status":"ok"}
```

### Если нет домена (bare IP) → Nginx + самоподписанный сертификат

Используйте скрипт `setup-vps.sh` — он делает всё автоматически:

```bash
# Sparse checkout: скачивается только deploy/amvera-vpn-node/, а не весь монорепо (~2 ГБ)
git clone --filter=blob:none --sparse https://TOKEN@github.com/pdkiller666/Vibe-Proxy-Nexus.git /opt/vpn-node
cd /opt/vpn-node
git sparse-checkout set deploy/amvera-vpn-node
cd deploy/amvera-vpn-node
chmod +x setup-vps.sh && sudo ./setup-vps.sh
```

Скрипт сам: установит Docker и Nginx, сгенерирует секрет и `.env`, соберёт образ,
создаст самоподписанный сертификат, настроит Nginx и выведет все данные для регистрации ноды.

> **Почему Nginx, а не Caddy без домена:**
> Caddy умеет автоматически получать Let's Encrypt только для **доменных имён** — для
> голых IP это недоступно по условиям CA/Browser Forum. Без домена Caddy пришлось бы
> конфигурировать руками точно так же как Nginx (вручную указывать пути к сертификату),
> теряя свой главный плюс. Nginx — более стандартный выбор для ручного TLS;
> его конфигурация для этого сценария хорошо известна и задокументирована.
> Если позже появится домен — переход на Caddy займёт 10 минут.

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

---

## Обновление ноды

```bash
cd /opt/vpn-node
git pull
cd deploy/amvera-vpn-node
docker compose build
docker compose up -d

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
```

---

## Аварийный доступ (Cockpit)

**Cockpit** — лёгкий системный веб-интерфейс (порт 9090): браузерный терминал, мониторинг ресурсов, управление сервисами и Docker-контейнерами. Нужен как резервный инструмент, когда SSH-клиента нет под рукой (телефон, чужой компьютер).

### Установка

`setup-vps.sh` автоматически устанавливает Cockpit и закрывает порт 9090 через UFW. При ручной установке:

```bash
apt install -y cockpit cockpit-docker   # cockpit-docker — опционально, для управления контейнерами
systemctl enable --now cockpit.socket

# Заблокировать прямой доступ к порту (только SSH-туннель):
ufw deny 9090
```

> `cockpit-docker` может отсутствовать в стандартных репозиториях старых Ubuntu — если пакет не найден, `setup-vps.sh` установит только базовый `cockpit`.

### Доступ через SSH-туннель (рекомендуется)

Порт 9090 закрыт снаружи. Для доступа пробросьте порт через SSH:

```bash
ssh -L 9090:localhost:9090 user@87.199.200.19
# или с ключом:
ssh -i ~/.ssh/id_rsa -L 9090:localhost:9090 root@87.199.200.19
```

После этого откройте **http://localhost:9090** в браузере. Войдите под системным пользователем VPS (например, `root`).

На Android/iOS используйте любой SSH-клиент с поддержкой туннелей (Termius, JuiceSSH, Blink).

### Доступ через Nginx-прокси (альтернатива)

Если SSH-туннель неудобен, можно проксировать Cockpit за HTTPS + HTTP Basic Auth. Готовый блок с инструкциями находится в `nginx-vps.conf` в виде закомментированного `server`-блока — раскомментируйте и настройте нужный домен.

---

## Производительность Xray: DNS и стратегия исходящих

По умолчанию Xray наследует системный DNS (VPS-провайдера), что даёт заметную задержку
при проксировании. Рекомендуется добавить в `config.json` секцию `dns` и стратегию
`UseIPv4` на `freedom`-аутбаунде:

```json
"dns": {
  "servers": ["1.1.1.1", "8.8.8.8", "localhost"]
},
```

и в outbound с тегом `freedom`:
```json
"settings": { "domainStrategy": "UseIPv4" }
```

Также включите `sniffing` на инбаунде для корректного определения целевых доменов:
```json
"sniffing": { "enabled": true, "destOverride": ["http", "tls", "quic"] }
```

Эти параметры уже включены в шаблон `xray/config.json.template` начиная с 29.07.2026.
