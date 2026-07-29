# Как добавить новый VPN-сервер

> **Быстрый путь:** в панели Admin → Узлы → **«+ Новый узел»** → **«Авто-развертывание»**.
> Введите IP, пароль SSH и домен VPS — система сделает всё остальная сама (~5 мин).
> Ручная инструкция ниже остаётся актуальной для нестандартных случаев.

---

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

> ### ⚡ Авто-развертывание (Admin → Узлы → «Авто-развертывание») — требует домен
>
> Встроенный провижинг использует **certbot + Let's Encrypt**, которые работают только
> с доменными именами — голый IP не принимается по правилам CA/Browser Forum.
>
> **Если у VPS только IP (например, fornex.com, Contabo, VDSina) — используйте бесплатный DuckDNS:**
>
> 1. Перейдите на [duckdns.org](https://duckdns.org) → войдите через GitHub/Google.
> 2. В поле «sub domain» введите любое имя (например `vpnde`) → нажмите **add domain**.
> 3. В поле **current ip** введите IP вашего VPS → нажмите **update ip**.
> 4. Готово: `vpnde.duckdns.org` теперь указывает на ваш сервер.
>
> После этого вводите `vpnde.duckdns.org` в поле «Домен» в форме авто-развертывания —
> провижинг отработает как обычно, Let's Encrypt выдаст сертификат без проблем.
>
> *(Ручная настройка без домена описана ниже в Варианте B — она подходит, если
> вы хотите обойтись без DNS и настроить самоподписанный сертификат)*

---

Выбор влияет на то, чем терминировать TLS.

| | Домен (или DuckDNS) | Только IP |
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
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
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
# Sparse checkout — скачивается только deploy/amvera-vpn-node/ (~55 МБ вместо ~2 ГБ монорепо)
# GITHUB_TOKEN — токен вашего GitHub-аккаунта с правом repo:read
git clone --filter=blob:none --sparse \
  https://GITHUB_TOKEN@github.com/pdkiller666/Vibe-Proxy-Nexus.git /opt/vpn-node
cd /opt/vpn-node
git sparse-checkout set deploy/amvera-vpn-node
cd deploy/amvera-vpn-node

# Создать .env с секретом
cp .env.example .env
sed -i "s/^MGMT_API_SECRET=.*/MGMT_API_SECRET=$(openssl rand -hex 32)/" .env

# Собрать и запустить (host-сеть: Xray на 127.0.0.1:10000, mgmt на 0.0.0.0:8443)
docker compose up -d --build

# Удалить сборочный кэш (освобождает ~1 ГБ — образ уже запущен, кэш больше не нужен)
docker builder prune -af --filter "until=1h"
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

### Шаг B1. Получить файлы

```bash
# Sparse checkout — скачивается только deploy/amvera-vpn-node/ (~55 МБ вместо ~2 ГБ монорепо)
# GITHUB_TOKEN — токен вашего GitHub-аккаунта с правом repo:read
git clone --filter=blob:none --sparse \
  https://GITHUB_TOKEN@github.com/pdkiller666/Vibe-Proxy-Nexus.git /opt/vpn-node
cd /opt/vpn-node
git sparse-checkout set deploy/amvera-vpn-node
cd deploy/amvera-vpn-node
```

### Шаг B2. Запустить скрипт

```bash
chmod +x setup-vps.sh && sudo ./setup-vps.sh
```

Скрипт автоматически:
- ✅ Устанавливает Docker и Nginx
- ✅ Генерирует `MGMT_API_SECRET` и создаёт `.env`
- ✅ Собирает Docker-образ и запускает контейнер
- ✅ Удаляет сборочный кэш (`docker builder prune`) — экономит ~1 ГБ
- ✅ Генерирует самоподписанный TLS-сертификат (10 лет)
- ✅ Настраивает Nginx (WS-прокси на Xray + HTTPS на mgmt-API)
- ✅ Устанавливает Cockpit и **разрешает root-логин** (убирает `/etc/cockpit/disallowed-users`)
- ✅ Закрывает порт 9090 снаружи через UFW (Cockpit — только через SSH-туннель)
- ✅ Выводит все данные для регистрации ноды

### Шаг B3. Добавить ноду в админке

В конце скрипт выведет:
```
Host:               1.2.3.4
Port:               443
Management API URL: http://1.2.3.4:8443
Management Secret:  abc123...
Cert SHA256:        a1b2c3...
```

Откройте `/admin` → **VPN Nodes** → **Добавить ноду** и заполните эти значения.

> **Важно (bare-IP нода):** укажите **Cert SHA256** в поле настроек ноды — сервер
> автоматически подставит `pinnedPeerCertSha256` в VLESS-ссылки (Xray 26+ / Happ 2.17+).
> Для старых клиентов без поддержки `pinnedPeerCertSha256` поле оставьте пустым —
> сервер подставит `allowInsecure=1` автоматически.
>
> Получить SHA256 вручную, если понадобится:
> ```bash
> openssl x509 -in /etc/nginx/ssl/self-signed.crt -noout -fingerprint -sha256 \
>   | sed 's/.*=//;s/://g' | tr 'A-F' 'a-f'
> ```

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
cd deploy/amvera-vpn-node
docker compose build
docker compose up -d
# Удалить старые Docker-слои и build cache (освобождает 1–2 ГБ):
docker system prune -af --volumes=false
```

> **Sparse checkout** настраивается один раз при клонировании — `git pull` после этого
> подтягивает только изменения в `deploy/amvera-vpn-node/`, не скачивая артефакты и библиотеки.

Существующие ключи сохраняются — `render-config.sh` при каждом старте переносит
список клиентов из persistent-тома `/etc/xray` в обновлённый конфиг.

---

## Диагностика

```bash
# Логи всех процессов
docker compose logs -f

# Проверить доступность ноды
curl http://localhost:8443/health   # {"status":"ok"}

# Список активных клиентов в Xray
curl -H "X-Management-Secret: $(grep MGMT_API_SECRET .env | cut -d= -f2)" \
  http://localhost:8443/clients

# CPU / RAM / uptime контейнера
curl -H "X-Management-Secret: $(grep MGMT_API_SECRET .env | cut -d= -f2)" \
  http://localhost:8443/system/status

# Последние логи Xray внутри контейнера
curl -H "X-Management-Secret: $(grep MGMT_API_SECRET .env | cut -d= -f2)" \
  "http://localhost:8443/system/logs?program=xray&lines=50"

# Перезапустить Xray внутри контейнера (без пересборки)
curl -X POST -H "X-Management-Secret: $(grep MGMT_API_SECRET .env | cut -d= -f2)" \
  http://localhost:8443/system/restart-xray
```

---

## Возможные проблемы

**Ключ создался, но не подключается** → проверьте, что Nginx/Caddy пробрасывает WebSocket-заголовки
(`Upgrade` и `Connection`). В конфиге Nginx это уже настроено.

**`/health` не отвечает** → контейнер не запустился. Смотрите: `docker compose logs`.

**Ошибка 401 при выдаче ключа** → `MGMT_API_SECRET` в `.env` и в поле Management API Secret в админке не совпадают.

**Клиент не подключается (TLS error)** → для IP-ноды убедитесь, что в записи ноды указан реальный IP
(не домен), тогда сервер автоматически добавит `allowInsecure=1` в ссылку.

**Cockpit не пускает под root** → выполните в терминале VPS:
```bash
sed -i '/^root$/d' /etc/cockpit/disallowed-users && systemctl restart cockpit.socket
```
При использовании `setup-vps.sh` это выполняется автоматически.
