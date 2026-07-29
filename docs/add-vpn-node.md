# Как добавить новый VPN-сервер

### Что происходит в двух словах

Основной сервер на Amvera умеет управлять несколькими VPN-нодами через защищённый REST API:
выдавать ключи, отзывать их, собирать статистику трафика. Новую ноду можно поднять
на любом VPS с поддержкой Docker — в любой стране.

---

## Шаг 1. Арендовать VPS

Подойдёт любой хостер с поддержкой Docker. Несколько вариантов:

| Хостер | Примерная цена | Хорошо подходит |
|---|---|---|
| **Hetzner** (Германия/Финляндия) | от €4/мес | Европа, надёжность |
| **DigitalOcean** | от $6/мес | Глобально, простой UI |
| **Contabo** | от €5/мес | Много трафика |
| **VDSina** | от 200₽/мес | Россия |

Минимальные требования: **1 CPU, 512 МБ RAM, Ubuntu 22.04+**.

---

## Шаг 2. Определить сценарий: домен или bare IP?

Выбор влияет на то, чем терминировать TLS.

| | Домен | Только IP |
|---|---|---|
| **TLS-сертификат** | Let's Encrypt (бесплатно, авто) | Самоподписанный |
| **Инструмент** | Caddy (автоматический TLS) | Nginx (ручной TLS) |
| **Клиенты** | Доверяют сертификату по умолчанию | `pinnedPeerCertSha256` (новые клиенты) или `allowInsecure=1` (старые) |
| **Рекомендация** | Предпочтительно | Работает; укажите `Cert SHA256` в настройках ноды для поддержки Xray 26+/Happ 2.17+ |

> **Почему Caddy с доменом, а Nginx без?**
> Caddy умеет автоматически получать Let's Encrypt, но **только для доменных имён** —
> для голых IP это недоступно по условиям CA/Browser Forum. Без домена Caddy теряет
> свой главный плюс и его пришлось бы настраивать точно как Nginx. Поэтому:
> с доменом → Caddy (меньше мороки), без домена → Nginx (стандарт для ручного TLS).

---

## Вариант A: с доменом (Caddy + Let's Encrypt)

### Шаг A1. Установить Docker и Caddy на VPS

```bash
# Docker
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# Caddy
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

### Шаг A2. Настроить домен

В DNS вашего домена добавьте A-запись на IP нового VPS:
```
node2.vpnexus.pro → 1.2.3.4
```

### Шаг A3. Получить файлы и запустить контейнер

```bash
# GITHUB_TOKEN — токен вашего GitHub-аккаунта (репозиторий приватный)
git clone https://GITHUB_TOKEN@github.com/pdkiller666/Vibe-Proxy-Nexus.git /opt/vpn-node
cd /opt/vpn-node/deploy/amvera-vpn-node

# Создать .env с секретом
cp .env.example .env
sed -i "s/^MGMT_API_SECRET=.*/MGMT_API_SECRET=$(openssl rand -hex 32)/" .env

# Собрать и запустить (host-сеть: Xray на 127.0.0.1:10000, mgmt на 0.0.0.0:8443)
docker compose up -d --build
```

### Шаг A4. Настроить Caddy

Создайте `/etc/caddy/Caddyfile`:

```
node2.vpnexus.pro {
    # VPN-трафик — WebSocket от клиентов
    handle /vpnws* {
        reverse_proxy localhost:10000
    }
    # Management API — запросы от основного сервера
    handle {
        reverse_proxy localhost:8443
    }
}
```

```bash
systemctl reload caddy

# Проверка (Caddy сам получит сертификат Let's Encrypt)
curl https://node2.vpnexus.pro/health   # {"status":"ok"}
```

### Шаг A5. Добавить ноду в админке

Откройте `/admin` → **VPN Nodes** → **Добавить ноду**:

| Поле | Значение |
|---|---|
| Название | Например: `Германия (Hetzner)` |
| Регион | Например: `de` (используется для определения флага страны) |
| Host | `node2.vpnexus.pro` |
| Port | `443` |
| SNI | `node2.vpnexus.pro` |
| Management API URL | `https://node2.vpnexus.pro` |
| Management API Secret | значение из `.env` |
| Cert SHA256 | оставить пустым (Let's Encrypt сертификат — доверенный) |

---

## Вариант B: без домена, только IP (Nginx + самоподписанный сертификат)

Используйте готовый скрипт `setup-vps.sh` — он автоматически делает всё:

```bash
# GITHUB_TOKEN — токен вашего GitHub-аккаунта (репозиторий приватный)
git clone https://GITHUB_TOKEN@github.com/pdkiller666/Vibe-Proxy-Nexus.git /opt/vpn-node
cd /opt/vpn-node/deploy/amvera-vpn-node
chmod +x setup-vps.sh && sudo ./setup-vps.sh
```

Скрипт сам: установит Docker и Nginx, сгенерирует секрет, соберёт образ,
создаст самоподписанный сертификат на 10 лет, настроит Nginx и выведет данные
для регистрации ноды.

> **Важно (bare-IP нода):** у самоподписанного сертификата нет доверенного CA.
> Для Xray 26+ / Happ 2.17+ укажите **Cert SHA256** в настройках ноды — сервер
> подставит `pinnedPeerCertSha256` в VLESS-ссылки и клиент верифицирует сертификат
> по отпечатку. Для старых клиентов без поддержки `pinnedPeerCertSha256` поле
> оставьте пустым — сервер подставит `allowInsecure=1` автоматически.
>
> Получить SHA256-отпечаток самоподписанного сертификата:
> ```bash
> openssl x509 -in /etc/nginx/ssl/self-signed.crt -noout -fingerprint -sha256 \
>   | sed 's/.*=//;s/://g' | tr 'A-F' 'a-f'
> ```

После выполнения скрипт напечатает:
```
Host:               1.2.3.4
Port:               443
Management API URL: http://1.2.3.4:8443
Management Secret:  abc123...
```

Добавьте ноду в `/admin` → **VPN Nodes** с этими значениями.

---

## Шаг 3. Проверить выдачу ключей

1. В админке выдайте ключ любому тестовому пользователю.
2. В логах ноды (`docker compose logs -f`) должен появиться `POST /clients` и перезапуск Xray.
3. Пользователь импортирует ссылку-подписку — новый сервер появится в списке.

---

## Что происходит под капотом

При выдаче ключа основной сервер:
1. Генерирует UUID
2. Вызывает `POST http(s)://нода/clients` с заголовком `X-Management-Secret`
3. Нода добавляет клиента в конфиг Xray и перезапускает его
4. Пользователь сразу может подключиться

Трафик опрашивается каждые 60 секунд через `GET /stats`.

---

## Обновление ноды

```bash
cd /opt/vpn-node
git pull
docker compose build
docker compose up -d
```

Существующие ключи сохраняются — `render-config.sh` при каждом старте переносит
список клиентов из persistent-тома в обновлённый конфиг.

---

## Возможные проблемы

**Ключ создался, но не подключается** → проверьте, что Nginx/Caddy пробрасывает WebSocket-заголовки
(`Upgrade` и `Connection`). В конфиге Nginx это уже настроено.

**`/health` не отвечает** → контейнер не запустился. Смотрите: `docker compose logs`.

**Ошибка 401 при выдаче ключа** → `MGMT_API_SECRET` в `.env` и в поле Management API Secret в админке не совпадают.

**Клиент не подключается (TLS error)** → для IP-ноды убедитесь, что в записи ноды указан реальный IP
(не домен), тогда сервер автоматически добавит `allowInsecure=1` в ссылку.
