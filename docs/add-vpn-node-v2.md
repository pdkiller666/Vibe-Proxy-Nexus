Что нужно заранее
VPS на Ubuntu 20.04+ (любой провайдер)
Домен, A-запись которого указывает на IP этого VPS (нужен для TLS-сертификата)
SSH-доступ к серверу
Открытые порты: 443 (VPN-трафик) и 8443 (Management API)
Шаг 1 — Установить Docker и Caddy на VPS
# Docker
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
# Caddy (автоматические TLS-сертификаты)
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

Шаг 2 — Получить файлы ноды с GitHub
# Клонируем только нужную директорию (sparse checkout)
git clone --no-checkout --depth=1 https://github.com/pdkiller666/Vibe-Proxy-Nexus.git /opt/vpn-node
cd /opt/vpn-node
git sparse-checkout init --cone
git sparse-checkout set deploy/amvera-vpn-node
git checkout
# Переходим в директорию ноды
cd deploy/amvera-vpn-node

Шаг 3 — Сгенерировать секрет
openssl rand -hex 32
# Пример вывода: a3f8c2d1e4b7a9f0c3d6e8b2a5f1c4d7e9b3a6f2c5d8e1b4a7f0c3d6e9b2a5
# Сохрани это значение — понадобится в шаге 4 и в админ-панели

Шаг 4 — Создать docker-compose.yml
cat > /opt/vpn-node/docker-compose.yml << 'EOF'
version: "3.8"
services:
  vpn-node:
    build: ./deploy/amvera-vpn-node
    network_mode: host          # Xray и mgmt-api доступны на хосте напрямую
    environment:
      MGMT_API_SECRET: "ВСТАВЬ_СВОЙ_СЕКРЕТ_ИЗ_ШАГА_3"
      PORT: "8081"              # Порт management API внутри контейнера
                                # (Caddy будет проксировать 8443 → 8081)
      # Необязательно — Telegram-бот для уведомлений
      # TELEGRAM_BOT_TOKEN: "..."
      # TELEGRAM_ADMIN_CHAT_ID: "..."
    volumes:
      - xray_data:/etc/xray     # Конфиг Xray сохраняется между перезапусками
    restart: always
volumes:
  xray_data:
EOF

Важно: замени ВСТАВЬ_СВОЙ_СЕКРЕТ_ИЗ_ШАГА_3 на реальное значение из шага 3.

Шаг 5 — Настроить Caddy
cat > /etc/caddy/Caddyfile << 'EOF'
# VPN-трафик — клиенты подключаются сюда (порт 443, путь /vpnws)
node.example.com {
    @ws path /vpnws*
    handle @ws {
        reverse_proxy localhost:10000 {
            header_up Upgrade {http.request.header.Upgrade}
            header_up Connection {http.request.header.Connection}
        }
    }
    # Всё остальное — блокируем (нода не должна отдавать сайт)
    respond 404
}
# Management API — только главный сервер Amvera будет сюда обращаться
node.example.com:8443 {
    reverse_proxy localhost:8081
}
EOF
# Заменяем node.example.com на реальный домен
sed -i 's/node.example.com/ТВОЙ_ДОМЕН/g' /etc/caddy/Caddyfile
systemctl reload caddy

Шаг 6 — Открыть порты в файрволе
ufw allow 22/tcp    # SSH (если ещё не открыт)
ufw allow 443/tcp   # VPN-трафик
ufw allow 8443/tcp  # Management API
ufw enable

Шаг 7 — Собрать образ и запустить
cd /opt/vpn-node
docker compose build
docker compose up -d
# Проверить, что все три процесса запущены
docker compose logs -f

В логах должны появиться три строки о старте процессов:

xray — Xray-core запущен
mgmt-api — uvicorn слушает порт 8081
telegram-bot — бот запущен (или ошибка, если не задан токен — это нормально)
Шаг 8 — Проверить работу Management API
# Проверить health (без авторизации)
curl https://ТВОЙ_ДОМЕН:8443/health
# Ожидаемый ответ: {"status":"ok"}
# Проверить список клиентов (с секретом)
curl -H "X-Management-Secret: ТВОЙ_СЕКРЕТ" https://ТВОЙ_ДОМЕН:8443/clients
# Ожидаемый ответ: []

Если оба запроса прошли — нода готова принимать команды от главного сервера.

Шаг 9 — Добавить ноду в админ-панели
Открой Админ-панель → Узлы → Новый узел и заполни:

Поле	Значение
Название	Например: DE-Frankfurt-1
Регион	Например: Германия
Host	node.example.com (домен VPS — его видят клиенты в ключах)
Порт	443
SNI	node.example.com (тот же домен)
Management API URL	https://node.example.com:8443
Management API Secret	Секрет из шага 3
Лимит пользователей	Пусто (без лимита) или число
Reality Public Key / Short ID	Оставить пустыми (не используются при WS+TLS)
Активен	✓
Сохранить.

Шаг 10 — Проверить выдачу ключей
После добавления ноды попробуй выдать VPN-ключ любому тестовому пользователю через Админ → Пользователи → VPN-ключи → Выдать ключ. В логах ноды (docker compose logs -f) должно появиться обращение к POST /clients и перезапуск Xray.

# Убедиться что клиент появился в конфиге Xray
curl -H "X-Management-Secret: ТВОЙ_СЕКРЕТ" https://ТВОЙ_ДОМЕН:8443/clients
# Должен вернуть массив с UUID пользователя

Обновление ноды в будущем
При выходе нового кода:

cd /opt/vpn-node
git pull
docker compose build
docker compose up -d

Клиенты из конфига Xray сохранятся — render-config.sh при каждом старте переносит существующих клиентов в новый конфиг из постоянного тома /etc/xray.