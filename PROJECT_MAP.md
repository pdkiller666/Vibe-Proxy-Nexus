# Карта проекта — Vibe Proxy Nexus

> Этот файл — ориентир для следующих агентов. Он описывает структуру монорепозитория,
> назначение каждой папки/пакета, как всё связано друг с другом и куда лезть за чем.
> Для конкретных архитектурных решений и user preferences — см. `replit.md`.
> Для узких технических уроков прошлых сессий — см. `.agents/memory/`.

## Что это за проект

**Vibe Proxy Nexus** — приватный VPN-сервис по приглашениям на протоколе
VLESS (Xray-core), поверх WebSocket+TLS на обычном веб-домене (без сырого
TCP и без Reality). Веб-панель позволяет пользователям регистрироваться
(только по реферальной ссылке), выбирать тарифный план (ежемесячный или
почасовой), оплачивать через СБП (ручной перевод, подтверждается админом)
и получать/отзывать VLESS-ключи — либо получить одну самообновляющуюся
ссылку-подписку. Подписки автоматически истекают и отзывают ключи по
окончании оплаченного периода (с честным продлением при досрочной оплате).
На VPN-ноды можно поставить лимит одновременных пользователей. Есть
внутренний баланс, реферальные комиссии, почасовое списание с баланса,
доп. слоты устройств и тикет-система поддержки.

Продакшен-домены: `https://vibeproxynexus-pdkiller666.waw0.amvera.tech/` и `https://vpnexus.pro/`.

Разворачивается **одним Docker-образом** на Amvera Cloud: React-фронтенд +
Express-бэкенд + сам Xray-core живут в одном контейнере. В Replit — только
среда разработки, снаружи остаётся только PostgreSQL.

## Структура репозитория (pnpm workspace)

```
.
├── artifacts/              # Приложения (то, что реально запускается)
│   ├── api-server/         # Express-бэкенд (API + отдача статики фронта)
│   ├── vpn-portal/         # React/Vite фронтенд (панель пользователя и админа)
│   └── mockup-sandbox/     # Изолированный превью-сервер для UI-компонентов (canvas)
├── lib/                    # Общие пакеты (используются из artifacts/*)
│   ├── db/                 # Drizzle ORM: схема БД + клиент подключения
│   ├── api-spec/           # openapi.yaml — источник истины по API + конфиг orval
│   ├── api-zod/            # Сгенерированные Zod-схемы (валидация на бэкенде)
│   └── api-client-react/   # Сгенерированный React Query клиент (хуки для фронта)
├── deploy/
│   ├── amvera-all-in-one/  # Реальный деплой: Dockerfile-компаньоны, README, entrypoint
│   └── amvera-vpn-node/    # ОТДЕЛЬНЫЙ пакет для будущей мульти-региональной схемы
│                           # (Xray + защищённый management API) — сейчас НЕ используется
├── scripts/                # Служебные скрипты монорепо (deploy.mjs, post-merge.sh)
├── .agents/memory/         # Долгосрочная память агентов (нетривиальные уроки/решения)
├── attached_assets/        # Загруженные пользователем файлы/скриншоты/логи
├── amvera.yml              # Конфигурация деплоя на Amvera (порт, volume)
├── Dockerfile              # Сборка all-in-one образа для Amvera
├── deploy.sh               # Деплой на прод через GitHub API (см. "Деплой" ниже)
├── pnpm-workspace.yaml     # Список пакетов workspace + pnpm catalog (версии зависимостей)
└── replit.md               # Главный README проекта: стек, архитектурные решения, preferences
```

## artifacts/api-server — бэкенд

Express 5 + TypeScript, ESM, собирается в один файл через esbuild (`build.mjs` → `dist/index.mjs`).

- `src/index.ts` — точка входа, слушает `PORT`. Также сам проксирует
  WebSocket-апгрейд по пути `/vpnws` на локальный Xray-инбаунд (`127.0.0.1:10000`).
- `src/app.ts` — сборка приложения: `trust proxy: 1`, pino-логгер, CORS,
  cookie-parser (подписанные куки, ключ — `SESSION_SECRET`), монтирование роутов
  под `/api`, отдача статики фронта (`STATIC_DIR`), запуск фоновых джоб:
  очистка просроченных сессий, истечение подписок, трафик-поллинг, почасовое биллинг.
- `src/routes/` — все эндпоинты:
  - `auth.ts` — `POST /api/auth/register` (требует `?ref=CODE` или `body.referralCode`;
    если включён пробный период — сразу создаёт активную подписку на самый дешёвый
    активный тариф и автоматически выдаёт первый VPN-ключ), `login`, `logout`,
    `forgot-password`, `reset-password`
  - `me.ts` — `GET /api/me`, `PATCH /api/me` (имя), `PATCH /api/me/email`
    (требует текущий пароль), `PATCH /api/me/password`
  - `plans.ts` — `GET /api/plans`
  - `vpnNodes.ts` — `GET /api/vpn-nodes`
  - `paymentSettings.ts` — `GET /api/payment-settings`
  - `subscriptions.ts` — `GET /api/subscriptions/me`, `POST /api/subscriptions`
    (monthly → создаёт pending payment; hourly → активирует сразу из баланса),
    `DELETE /api/subscriptions/:id`
  - `payments.ts` — `GET /api/payments/me`, `PATCH /api/payments/:id/note`,
    `PATCH /api/payments/:id/screenshot` (загрузка скриншота перевода, base64 в Postgres),
    `GET /api/payments/:id/screenshot/image`
  - `vpnKeys.ts` — `GET /api/vpn-keys/me`, `POST /api/vpn-keys`
    (требует активную подписку и свободный слот; `nodeId` — явный или автовыбор,
    пропускает переполненные ноды), `DELETE /api/vpn-keys/:id`,
    `GET /api/vpn-keys/subscription-url`
  - `subscription.ts` — публичный `GET /api/sub/:token` (HMAC-токен,
    без cookie-авторизации): base64 всех активных ключей + заголовки
    `Profile-Title`/`Profile-Update-Interval`/`Subscription-Userinfo`
  - `extraSlotOrder.ts` — `POST /api/extra-slot-order` (создать заказ на доп. устройство;
    если цена=0 и `allowFreeExtraDeviceSlot` — выдаёт сразу бесплатно),
    `DELETE /api/extra-slot-order/:id`
  - `balanceTopupOrder.ts` — `POST /api/balance-topup-order`, `DELETE /api/balance-topup-order/:id`
  - `balanceTransactions.ts` — `GET /api/balance-transactions/me`
  - `support.ts` — `GET /api/support-tickets`, `POST /api/support-tickets`,
    `GET /api/support-tickets/:id`, `POST /api/support-tickets/:id/messages`
  - `health.ts` — `GET /api/healthz`
  - `admin/` — все под `requireAdmin`:
    - `dashboard.ts` — сводка: онлайн сейчас, новые пользователи 7/30 дней,
      распределение по тарифам, доход по дням за 14 дней, rolling 30-day revenue
    - `users.ts` — список пользователей с вычисляемым `activityStatus`
      (`"site"` / `"vpn"` / `"offline"`, побеждает более свежий сигнал),
      `vpnLastActiveAt`, трафик за период, лимит трафика, активный план;
      `PATCH /admin/users/:id/role`, `PATCH /admin/users/:id`,
      `DELETE /admin/users/:id`, `PATCH /admin/users/:id/subscription`,
      `PATCH /admin/users/:id/extra-slots`
    - `passwordReset.ts` — выдать ссылку сброса пароля пользователю
    - `payments.ts` — `GET /admin/payments`, `POST /admin/payments/:id/confirm`
      (транзакционно, идемпотентно; ветви: subscription / extra_device_slot /
      balance_topup; subscription-подтверждение начисляет реферальную комиссию),
      `POST /admin/payments/:id/reject`
    - `plans.ts` — CRUD тарифов (monthly и hourly)
    - `vpnNodes.ts` — CRUD нод, ответ включает `activeUserCount`
    - `paymentSettings.ts` — обновление реквизитов СБП, цены доп. слота,
      реферального %, минимального пополнения для почасового, primaryDomain,
      флага пробного периода
    - `support.ts` — `GET /admin/support-tickets`, `GET /admin/support-tickets/:id`,
      `POST /admin/support-tickets/:id/messages`, `PATCH /admin/support-tickets/:id/status`
    - `vpnKeys.ts` — `GET /admin/vpn-keys`, `POST /admin/vpn-keys/issue` (выдать ключ вручную),
      `DELETE /admin/vpn-keys/:id`

- `src/lib/`:
  - `auth.ts` — middlewares `requireAuth` / `requireAdmin`
  - `session.ts` — БД-сессии (кука `vpn_session`, 30 дней), троттлированное
    обновление `users.lastActiveAt` (раз/мин), `ONLINE_THRESHOLD_MS` = 5 мин
  - `subscriptionLifecycle.ts` — `startSubscriptionExpiryJob()`: периодически истекает
    просроченные подписки и отзывает ключи (если нет другой активной подписки);
    lazy-expiry defense-in-depth в `meResponse.ts` / `vpnKeys.ts` / `subscription.ts`
  - `trafficPolling.ts` — `startTrafficPollingJob()`: каждые 60 с опрашивает Xray gRPC
    Stats API (`QueryStats(reset: false)`), вычисляет дельту через `lastSeen*`,
    обновляет `trafficUpBytes`/`trafficDownBytes`/`periodUpBytes`/`periodDownBytes`/`lastTrafficAt`,
    отзывает ключи при превышении `trafficLimitGb`
  - `hourlyBilling.ts` — `startHourlyBillingJob()`: каждые 5 мин списывает
    `hourlyRateKopecks` с баланса активных пользователей на hourly-тарифах,
    только если `lastTrafficAt` в пределах `IDLE_GRACE_MS` = 15 мин;
    при нулевом балансе истекает подписку и отзывает ключи
  - `xrayStats.ts` — gRPC-клиент для Xray Stats API (protobufjs)
  - `password.ts` — хэширование паролей (scrypt)
  - `passwordReset.ts` — токены сброса (32 байта hex, TTL 30 мин, одноразовые)
  - `loginRateLimit.ts` — 5 попыток / 15 мин, in-memory Map
  - `vless.ts` — генерация UUID и VLESS+WS-ссылок, `generatePaymentReference`
  - `subscription.ts` — HMAC-токены подписочной ссылки, `BRAND_NAME`, интервал обновления
  - `xray.ts` — правка живого конфига Xray на диске + `supervisorctl restart xray`
  - `staticServer.ts` — отдаёт собранный фронтенд из `STATIC_DIR`
  - `meResponse.ts` — общий билдер данных для `/api/me`; считает `deviceSlots` =
    `plan.devicesIncluded + subscription.extraDeviceSlots`
  - `keyIssuance.ts` — логика выдачи VPN-ключа (проверка слотов, нод, добавление в Xray)
  - `seedAdmin.ts` — при старте создаёт первого админа из `ADMIN_EMAIL`/`ADMIN_PASSWORD`
  - `backfillReferralCodes.ts` — при старте назначает `referral_code` старым строкам, у которых он пустой
  - `logger.ts` — pino

**VPN-транспорт**: VLESS поверх WebSocket на обычном HTTPS-домене. Xray на `127.0.0.1:10000`, Node-сервер проксирует апгрейд `/vpnws`. Клиенты: `security=tls&type=ws&sni=<домен>`. Подробности — `.agents/memory/amvera-raw-tcp-port.md`.

**Auth**: email+password, сессии в БД (Clerk убран в июле 2026, см. `.agents/memory/session-auth-migration.md`).

## artifacts/vpn-portal — фронтенд

React + Vite + TypeScript, роутинг через `wouter`, состояние сервера — через TanStack Query.

- `src/App.tsx` — маршруты: публичные (`/`, `/sign-in`, `/sign-up`, `/forgot-password`,
  `/reset-password`), защищённые через `ProtectedRoute`, админские через `AdminRoute`.
- `src/pages/`:
  - `home` — лендинг
  - `sign-in` / `sign-up` / `forgot-password` / `reset-password` — auth
  - `dashboard` — дашборд пользователя (статус подписки, баланс, быстрые действия)
  - `plans` — тарифы (snap-карусель на мобильных; dot-навигация; выделение ring+shadow без scale-сдвига; `scrollIntoView` для корректной работы со snap-mandatory)
  - `checkout` — оплата подписки (СБП-реквизиты, загрузка скриншота, примечание)
  - `slot-checkout` — оплата доп. устройства
  - `keys` — ключи и устройства (ссылка-подписка + QR; список всех ключей всегда виден; для обычных пользователей — название/описание устройства; для админа — полный vless-линк)
  - `payments` — история платежей
  - `support` — тикеты поддержки (список + переписка)
  - `profile` — смена имени/email/пароля
  - `admin` — панель администратора (дашборд, платежи, тарифы, ноды, ключи, пользователи с activityStatus, реквизиты, поддержка)
  - `not-found` — 404
- `src/components/layout.tsx` — обвязка личного кабинета (сайдбар, email, баланс, логаут).
- `src/components/ui/` — UI-примитивы в стиле shadcn/ui, острые углы (`--radius: 0rem`).
- `src/lib/query-client.ts` — конфиг TanStack Query (4xx-ошибки не ретраятся).
- Vite слушает `0.0.0.0:$PORT`, `allowedHosts: true`, базовый путь — `BASE_PATH`.

**Визуальный стиль**: весь UI-текст на русском, чёрно-оранжево-белая индустриальная палитра, шрифты Space Grotesk/Space Mono, без эмодзи.

## artifacts/mockup-sandbox — песочница компонентов

Отдельный Vite-сервер для изолированного превью React-компонентов на канвасе. `mockupPreviewPlugin.ts` сканирует `src/components/mockups/` и генерирует карту; открывается по `/preview/:ComponentName`. Не часть продакшн-приложения.

## lib/ — общие пакеты

Цепочка кодогенерации API (инструмент — **Orval**):

```
lib/api-spec/openapi.yaml  (источник истины — ВСЕГДА редактировать здесь)
        │  pnpm --filter @workspace/api-spec run codegen
        ├──▶ lib/api-zod/src/generated          (Zod-схемы → валидация в api-server)
        └──▶ lib/api-client-react/src/generated (React Query хуки → используются в vpn-portal)
```

Никогда не редактировать файлы под `generated/` вручную. Никогда не называть
компонент схемы `<operationId>Body/Params/Response/QueryParams` — Orval генерирует
такие имена сам, будет коллизия. Подробности — `.agents/memory/openapi-spec-drift.md`.

После правки `lib/db/src/schema/` — пересобрать пакет db перед тайпчеком:
`pnpm --filter @workspace/db exec tsc -p .`

## Схема базы данных

| Таблица | Ключевые поля | Назначение |
|---|---|---|
| `users` | email (unique), passwordHash, name, role (user/admin), balanceKopecks (default 0), referralCode (unique), referredByUserId (nullable FK→users), lastActiveAt (nullable) | пользователи; `lastActiveAt` — основа онлайн-статуса "на сайте"; `balanceKopecks` — внутренний кошелёк; `referralCode` — уникальный код для приглашения; `referredByUserId` — кто пригласил |
| `sessions` | token (PK), userId, expiresAt | БД-сессии (кука `vpn_session`, 30 дней) |
| `password_reset_tokens` | token (PK), userId, expiresAt | одноразовые токены сброса пароля (TTL 30 мин) |
| `plans` | name, description, priceRub, durationDays, devicesIncluded (default 1), trafficLimitGb (nullable=безлимит), billingType (monthly/hourly), hourlyRateKopecks (nullable), isActive | тарифные планы; `devicesIncluded` — базовое число слотов; `trafficLimitGb` — лимит трафика за период; `billingType` — тип биллинга |
| `subscriptions` | userId, planId, status (pending_payment/active/expired/cancelled/rejected), startsAt, endsAt (nullable для hourly), lastBilledAt (nullable, для hourly), extraDeviceSlots (default 0) | подписки; `extraDeviceSlots` — доп. слоты, купленные в рамках этой подписки; `lastBilledAt` — до куда уже выставлен счёт (hourly) |
| `payments` | subscriptionId (nullable), userId, type (subscription/extra_device_slot/balance_topup), provider (manual_sbp/yookassa), amountRub, status (pending/confirmed/rejected), reference (уникальный код платежа), userNote, screenshotData (base64, в Postgres), screenshotMimeType, rejectionReason | платежи; `yookassa` — задел на будущее |
| `payment_settings` | sbpPhone, sbpBank, sbpRecipientName, instructions, extraDeviceSlotPriceRub (default 0), allowFreeExtraDeviceSlot (default false), trialEnabled, trialDays (default 5), minHourlyTopupRub (default 0), primaryDomain (default ""), referralCommissionPercent (default 0) | синглтон-настройки СБП и продуктовые параметры |
| `vpn_nodes` | name, region, host, port (default 443), sni, publicKey, shortId, isActive, maxUsers (nullable=безлимит) | VPN-ноды; `activeUserCount` (число неотозванных ключей) вычисляется на лету |
| `vpn_keys` | userId, nodeId, uuid, label, description (nullable), vlessLink, deepLink, revokedAt, trafficUpBytes, trafficDownBytes, periodUpBytes, periodDownBytes, periodStartedAt, lastSeenUpBytes, lastSeenDownBytes, lastTrafficAt (nullable) | выданные ключи; `period*` — сбрасываются при продлении; `lastSeen*` — предыдущий снимок из Xray для вычисления дельты; `lastTrafficAt` — когда последний раз был ненулевой трафик |
| `balance_transactions` | userId, amountKopecks, type (topup/debit/refund/referral), paymentId (nullable FK), description | лог всех движений баланса |
| `support_tickets` | userId, subject, status (open/answered/closed) | тикеты поддержки |
| `support_messages` | ticketId, authorId, body | сообщения в тикетах (пользователь и любой админ) |

Миграции — через `drizzle-kit push` (`pnpm --filter @workspace/db run push` в dev;
в проде — шагом в `entrypoint.sh` при каждом старте контейнера, без файлов миграций).

## deploy/ — деплой

- **`deploy/amvera-all-in-one/`** — актуальная схема продакшена: один Docker-контейнер,
  `supervisord` управляет Xray-core (`127.0.0.1:10000`) и Node.js (порт `8080`).
  README описывает все секреты и порядок настройки.
- **`deploy/amvera-vpn-node/`** — задел на будущее (мульти-региональная схема,
  отдельные VPN-ноды с management API, `X-Management-Secret`). **Не используется.**

Требуемые переменные в проде:
`DATABASE_URL`, `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `PORT` (дефолт 8080).

### Грабли деплоя на Amvera

- `amvera.yml` не поддерживает `run.ports` (список) — только `run.containerPort` (одно число).
- Сырой TCP (Reality или голый VLESS) через публичный порт Amvera не работает.
- `env:` в `amvera.yml` не поддерживается — секреты только в панели Amvera.
- Смысловую историю изменений смотри на GitHub (не в Amvera-коммитах «Merge branch main»).
- Все уроки по деплою — `.agents/memory/amvera-*.md`.

## scripts/

- `scripts/deploy.mjs` (запускается через `./deploy.sh "сообщение"`) — деплой на прод:
  пушит в GitHub через Git Data REST API (не `git push`). Сообщение — **всегда на русском**.
- `scripts/post-merge.sh` — после мержа задач: `pnpm install --frozen-lockfile` +
  `pnpm --filter db push`.

## .agents/memory/ — память агентов

- `MEMORY.md` — индекс, всегда подгружается в контекст; ссылки на топик-файлы.
  Там: Amvera-грабли, миграция с Clerk, подписочная ссылка, семантика истечения,
  дизайн device-slots, drizzle-грабли и т.д.

## Как всё связано (снимок)

```
Пользователь → vpn-portal (React/Vite, dev-порт из workflow)
                    │  fetch через @workspace/api-client-react
                    ▼
              api-server (Express, /api/*)
                    │  drizzle-orm
                    ▼
              PostgreSQL (users, sessions, password_reset_tokens, plans,
                          subscriptions, payments, payment_settings,
                          vpn_nodes, vpn_keys, balance_transactions,
                          support_tickets, support_messages)

VPN-клиент → ссылка-подписка (/api/sub/:token) или отдельный vless:// линк
                    │  VLESS поверх WebSocket+TLS, sni = веб-домен
                    ▼
Прод (Amvera, один контейнер, порт 8080 наружу):
  supervisord ─┬─ xray-core (VLESS+WS, только 127.0.0.1:10000)
               └─ node dist/index.mjs (api-server)
                       ├─ раздаёт /api/*
                       ├─ раздаёт собранный vpn-portal (STATIC_DIR)
                       └─ проксирует апгрейд /vpnws на локальный Xray
```

## Куда смотреть в первую очередь

- Продуктовое описание для людей — `README.md`
- Общий обзор и решения по архитектуре — `replit.md`
- Структура workspace/TypeScript — скилл `pnpm-workspace`
- Нетривиальные уроки прошлых сессий — `.agents/memory/MEMORY.md` → топик-файлы
- Конкретные эндпоинты API — `lib/api-spec/openapi.yaml` (источник истины)
- Деплой/секреты — `deploy/amvera-all-in-one/README.md`
