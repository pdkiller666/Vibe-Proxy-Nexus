# Как добавить новый VPN-сервер

### Что происходит в двух словах

Сейчас у вас один сервер на Amvera — он делает всё: сайт, API и VPN в одном контейнере. Когда хочется добавить второй сервер (например, в другой стране) — его запускают отдельно. Наш основной бэкенд умеет с ним общаться через защищённый REST API: выдавать ключи, отзывать, собирать статистику трафика.

---

## Шаг 1. Арендовать VPS

Подойдёт любой хостер с поддержкой Docker. Несколько вариантов:

| Хостер | Примерная цена | Хорошо подходит |
|---|---|---|
| **Hetzner** (Германия/Финляндия) | от €4/мес | Европа, надёжность |
| **DigitalOcean** | от $6/мес | Глобально, простой UI |
| **Contabo** | от €5/мес | Много трафика |
| **VDSina** | от 200₽/мес | Россия |

Минимальные требования: **1 CPU, 512 МБ RAM, Ubuntu 22.04**.

---

## Шаг 2. Поставить Docker и Caddy на VPS

Подключитесь к серверу по SSH и выполните:

```bash
# Docker
curl -fsSL https://get.docker.com | sh

# Caddy (он сам получит сертификат Let's Encrypt)
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install caddy
```

---

## Шаг 3. Настроить домен для новой ноды

В DNS вашего домена добавьте A-запись на IP нового VPS. Например:

```
node2.vpnexus.pro → 1.2.3.4  (IP вашего нового VPS)
```

---

## Шаг 4. Сгенерировать секрет для management API

На VPS выполните:

```bash
openssl rand -hex 32
```

Скопируйте результат — это будет `MGMT_API_SECRET`. Он защищает API управления нодой от посторонних.

---

## Шаг 5. Скопировать файлы ноды на VPS

На VPS:

```bash
git clone https://github.com/pdkiller666/Vibe-Proxy-Nexus.git
cd Vibe-Proxy-Nexus/deploy/amvera-vpn-node
```

---

## Шаг 6. Запустить контейнер

```bash
docker build -t vpn-node .

docker run -d \
  --name vpn-node \
  --restart unless-stopped \
  -p 10000:10000 \
  -p 8443:8443 \
  -e MGMT_API_SECRET="вставьте_секрет_из_шага_4" \
  -e PORT=8443 \
  vpn-node
```

Проверка что запустилось:

```bash
curl http://localhost:8443/health
# Должно вернуть: {"status":"ok"}
```

---

## Шаг 7. Настроить Caddy (HTTPS + проксирование)

Создайте файл `/etc/caddy/Caddyfile`:

```
node2.vpnexus.pro {
    # VPN-трафик (WebSocket от клиентов)
    handle /vpnws* {
        reverse_proxy localhost:10000
    }

    # Management API (наш бэкенд)
    handle {
        reverse_proxy localhost:8443
    }
}
```

Перезапустите Caddy:

```bash
systemctl reload caddy
```

Caddy автоматически получит SSL-сертификат. Проверка:

```bash
curl https://node2.vpnexus.pro/health
# Должно вернуть: {"status":"ok"}
```

---

## Шаг 8. Добавить ноду в админке

Откройте `https://vpnexus.pro/admin` → раздел **Узлы** → кнопка **Добавить ноду**.

Заполните:

| Поле | Что вводить |
|---|---|
| **Название** | Например: `Германия (Hetzner)` |
| **Регион** | Например: `de` |
| **Host** | `node2.vpnexus.pro` |
| **Port** | `443` |
| **SNI** | `node2.vpnexus.pro` |
| **Management API URL** | `https://node2.vpnexus.pro` |
| **Management API Secret** | секрет из шага 4 |
| **Лимит пользователей** | оставьте пустым = без лимита |

Поля `publicKey` и `shortId` оставьте пустыми — они используются только для Reality, у нас VLESS+WS.

Сохраните.

---

## Шаг 9. Проверить

После сохранения ноды:

1. Перейдите в **Ключи** в личном кабинете (или в **Ключи** в разделе Пользователей в админке).
2. Выдайте новый ключ — при создании появится выбор ноды. Выберите новую.
3. Ключ должен создаться и появиться в подписке.
4. Импортируйте ссылку-подписку в Happ/v2rayNG — новый сервер появится в списке.

---

## Что происходит «под капотом»

Когда выдаётся ключ на удалённую ноду, наш бэкенд:
1. Генерирует UUID
2. Зовёт `POST https://node2.vpnexus.pro/clients` с заголовком `X-Management-Secret`
3. Нода добавляет клиента в Xray и перезагружает конфиг
4. Пользователь сразу может подключиться

Трафик опрашивается каждые 60 секунд через `GET /stats` — так же, как и с локальной нодой.

---

## Возможные проблемы

**Ключ создался, но не подключается** → проверьте, что Caddy проксирует WebSocket: заголовок `upgrade` должен пробрасываться. По умолчанию Caddy это делает автоматически.

**`/health` не отвечает** → контейнер не запустился. Посмотрите логи: `docker logs vpn-node`.

**Ошибка 401 при выдаче ключа** → `MGMT_API_SECRET` в контейнере и в админке не совпадают.
