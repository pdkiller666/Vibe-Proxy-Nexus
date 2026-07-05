# Карта проекта — Vibe Proxy Nexus

> Этот файл — ориентир для следующих агентов. Он описывает структуру монорепозитория,
> назначение каждой папки/пакета, как всё связано друг с другом и куда лезть за чем.
> Для конкретных архитектурных решений и user preferences — см. `replit.md`.
> Для узких технических уроков прошлых сессий — см. `.agents/memory/`.

## Что это за проект

**Vibe Proxy Nexus** — приватный VPN-сервис по приглашениям на протоколе
VLESS (Xray-core), поверх WebSocket+TLS на обычном веб-домене (без сырого
TCP и без Reality — см. раздел про VPN-транспорт ниже). Веб-панель позволяет
пользователям регистрироваться, выбирать тарифный план, оплачивать через СБП
(ручной перевод, подтверждается админом) и получать/отзывать VLESS-ключи для
подключения — либо получить одну самообновляющуюся ссылку-подписку.
Есть админ-панель для управления тарифами, VPN-нодами, платежами и ролями.

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
├── scripts/                # Служебные скрипты монорепо (в т.ч. deploy.mjs, post-merge.sh)
├── .agents/memory/         # Долгосрочная память агентов (нетривиальные уроки/решения)
├── .local/tasks/           # Файлы описаний project tasks (черновики планов)
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
  WebSocket-апгрейд по пути `/vpnws` на локальный Xray-инбаунд (`127.0.0.1:10000`)
  — так VLESS едет поверх обычного HTTPS/WebSocket (см. «VPN-транспорт» ниже).
- `src/app.ts` — сборка приложения: `trust proxy: 1` (чтобы `req.protocol`
  корректно видел `https` за прокси Amvera, не доверяя произвольной цепочке
  заголовков), pino-логгер, CORS, cookie-parser (подписанные куки, ключ —
  `SESSION_SECRET`), монтирование роутов под `/api`, отдача статики фронта
  (см. ниже), запуск фоновой job очистки просроченных сессий.
- `src/routes/` — все эндпоинты:
  - `auth.ts` — `POST /api/auth/register|login|logout`,
    `POST /api/auth/forgot-password|reset-password`
  - `me.ts` — `GET /api/me`
  - `plans.ts` — `GET /api/plans` (публичный список активных тарифов)
  - `vpnNodes.ts` — `GET /api/vpn-nodes` (публичный список нод)
  - `paymentSettings.ts` — `GET /api/payment-settings` (публичные реквизиты СБП)
  - `subscriptions.ts` — `GET /api/subscriptions/me`, `POST /api/subscriptions`
  - `payments.ts` — `GET /api/payments/me`, `PATCH /api/payments/:id/note`
  - `vpnKeys.ts` — `GET /api/vpn-keys/me`, `POST /api/vpn-keys`,
    `DELETE /api/vpn-keys/:id`, `GET /api/vpn-keys/subscription-url`
    (выдаёт HMAC-подписанную ссылку подписки, см. `lib/subscription.ts`)
  - `subscription.ts` — публичный `GET /api/sub/:token` (без авторизации,
    токен сам себя аутентифицирует): base64 всех активных ключей + заголовки
    `Profile-Title`/`Profile-Update-Interval`/`Subscription-Userinfo`
  - `health.ts` — `GET /api/healthz`
  - `admin/` — все под `requireAdmin`:
    `dashboard.ts` (сводка), `users.ts` (список/смена роли),
    `passwordReset.ts` (выдать ссылку сброса пароля пользователю),
    `payments.ts` (список/подтверждение/отклонение), `plans.ts` (CRUD),
    `vpnNodes.ts` (CRUD), `paymentSettings.ts` (обновление реквизитов СБП)
- `src/lib/`:
  - `auth.ts` — middlewares `requireAuth` / `requireAdmin`
  - `session.ts` — БД-сессии: `createSession`/`destroySession`/`getUserBySessionToken`,
    кука `vpn_session` (httpOnly, signed, 30 дней), фоновая очистка просроченных
    сессий раз в час (`startSessionCleanupJob`); юнит-тесты в `session.test.ts`
  - `password.ts` — хэширование паролей (scrypt, без внешних зависимостей)
  - `passwordReset.ts` — токены сброса пароля (32 байта hex, TTL 30 минут,
    одноразовые — удаляются при использовании); ссылка возвращается прямо в
    ответе API/UI, т.к. email-провайдер не подключён (см.
    `.agents/memory/no-email-provider.md`)
  - `loginRateLimit.ts` — rate-limit на попытки логина (5 попыток / 15 мин,
    in-memory `Map`, сбрасывается при успешном логине)
  - `vless.ts` — генерация UUID и VLESS+WS-ссылок (`VPN_WS_PATH = "/vpnws"`)
  - `subscription.ts` — стейтлес HMAC-токены для подписочной ссылки
    (`userId.signature`, ключ — `SESSION_SECRET`), константы бренда
    (`BRAND_NAME`, интервал автообновления)
  - `xray.ts` — правка живого конфига Xray-core на диске (добавление/удаление
    клиентов) и `supervisorctl restart xray` (актуально только в проде,
    гейтится через `XRAY_CONFIG_PATH`)
  - `staticServer.ts` — отдаёт собранный фронтенд из `STATIC_DIR` (гейтится
    этой переменной; в dev не активен — фронт крутится через свой Vite-сервер)
  - `meResponse.ts` — общий билдер данных для `/api/me` и ответов login/register
  - `seedAdmin.ts` — при старте создаёт админа из `ADMIN_EMAIL`/`ADMIN_PASSWORD`,
    если такого пользователя ещё нет
  - `logger.ts` — конфигурация pino

**VPN-транспорт**: VLESS едет **поверх WebSocket на обычном HTTPS-домене**,
не сырым TCP и не через Reality. Amvera всегда терминирует TLS на своём крае
(Traefik/Envoy) и пропускает наружу только один HTTP(S)-порт — сырой VLESS
через это ломается, а Reality в принципе несовместим с терминацией TLS не
самим Xray. Рабочая схема: Xray слушает `127.0.0.1:10000` голым
VLESS+WS (`security: none`), Node-сервер сам проксирует апгрейд `/vpnws` на
него. Клиенты подключаются как к обычному HTTPS/WebSocket:
`security=tls&type=ws&sni=<веб-домен>`. Подробности и история попыток —
`.agents/memory/amvera-raw-tcp-port.md`.

**Важно про auth**: в июле 2026 Clerk был полностью убран и заменён на
собственную email+password-аутентификацию с сессиями в БД (см.
`.agents/memory/session-auth-migration.md`). Никогда не добавляй `@clerk/*`
обратно без явного запроса пользователя.

## artifacts/vpn-portal — фронтенд

React + Vite + TypeScript, роутинг через `wouter`, состояние сервера — через
TanStack Query (готовые хуки из `@workspace/api-client-react`).

- `src/App.tsx` — маршруты: публичные (`/`, `/sign-in`, `/sign-up`,
  `/forgot-password`, `/reset-password`), защищённые через `ProtectedRoute`
  (проверка через `useGetMe()`), админские через `AdminRoute` (проверка роли).
- `src/pages/` — по одной странице на маршрут:
  `home`, `sign-in`, `sign-up`, `forgot-password`, `reset-password`,
  `dashboard`, `plans`, `checkout`, `keys` (ссылка-подписка на первом плане,
  отдельные VLESS-ключи для ручного импорта спрятаны под сворачиваемый блок),
  `payments`, `admin`, `not-found`.
- `src/components/layout.tsx` — обвязка личного кабинета (сайдбар, email,
  логаут).
- `src/components/ui/` — UI-примитивы в стиле shadcn/ui, с острыми углами
  (`--radius: 0rem`) под индустриальный визуальный стиль проекта.
- `src/lib/query-client.ts` — конфиг TanStack Query (4xx-ошибки не ретраятся).
- Vite слушает `0.0.0.0:$PORT`, `allowedHosts: true` (нужно для проксирования
  Replit/Amvera), базовый путь настраивается через `BASE_PATH`.

**Визуальный стиль** (см. user preferences в `replit.md`): весь UI-текст на
русском, чёрно-оранжево-белая индустриальная палитра, шрифты Space
Grotesk/Space Mono, без корпоративного синего и без эмодзи.

## artifacts/mockup-sandbox — песочница компонентов

Отдельный Vite-сервер для изолированного превью React-компонентов на канвасе
(аналог Storybook). `mockupPreviewPlugin.ts` сканирует `src/components/mockups/`
и генерирует карту модулей; открывается по `/preview/:ComponentName`. Не часть
продакшн-приложения, используется только для дизайн-экспериментов.

## lib/ — общие пакеты

Цепочка кодогенерации API (инструмент — **Orval**):

```
lib/api-spec/openapi.yaml  (источник истины)
        │  pnpm --filter @workspace/api-spec run codegen
        ├──▶ lib/api-zod/src/generated          (Zod-схемы → валидация в api-server)
        └──▶ lib/api-client-react/src/generated (React Query хуки → используются в vpn-portal)
```

- **`@workspace/api-spec`** — только `openapi.yaml` + конфиг orval. Меняешь
  контракт API — правишь здесь и перегенерируешь.
- **`@workspace/api-zod`** — сгенерированные схемы, потребляются `api-server`
  для валидации запросов.
- **`@workspace/api-client-react`** — сгенерированные хуки (`useGetMe`,
  `useListPlans`, `useCreateVpnKey`, `useGetSubscriptionUrl` и т.д.),
  потребляются `vpn-portal`.
- **`@workspace/db`** — Drizzle ORM, PostgreSQL. Схема в `src/schema/`:

| Таблица | Ключевые поля | Назначение |
|---|---|---|
| `users` | email (unique), passwordHash, name, role (user/admin) | пользователи |
| `sessions` | token (PK), userId, expiresAt | БД-сессии (кука `vpn_session`) |
| `password_reset_tokens` | token (PK), userId, expiresAt | одноразовые токены сброса пароля (TTL 30 мин) |
| `plans` | name, description, priceRub, durationDays, isActive | тарифные планы |
| `subscriptions` | userId, planId, status (pending_payment/active/expired/cancelled/rejected), startsAt/endsAt | подписки пользователя на план |
| `payments` | subscriptionId, userId, provider (manual_sbp/yookassa), amountRub, status (pending/confirmed/rejected), reference, userNote, rejectionReason | платежи (`yookassa` — задел на будущее, не реализован) |
| `payment_settings` | sbpPhone, sbpBank, sbpRecipientName, instructions, yookassaEnabled | синглтон-настройки СБП |
| `vpn_nodes` | name, region, host, port (default 443), sni, publicKey, shortId, isActive | VPN-ноды |
| `vpn_keys` | userId, nodeId, uuid, label, vlessLink, deepLink, revokedAt | выданные VLESS-ключи |

  Миграции — через `drizzle-kit push` (`pnpm --filter @workspace/db run push`
  в dev; в проде — фоновым шагом в `entrypoint.sh` при каждом старте
  контейнера), без файлов миграций — схема применяется напрямую по
  `DATABASE_URL`.

## deploy/ — деплой

- **`deploy/amvera-all-in-one/`** — актуальная схема продакшена: один
  Docker-контейнер, `supervisord` управляет одновременно Xray-core (VLESS+WS
  на `127.0.0.1:10000`, наружу не торчит напрямую) и Node.js-процессом
  api-server (порт `8080` — единственный публичный порт: веб + API + прокси
  WebSocket-апгрейда до Xray). README в этой папке описывает все требуемые
  секреты и порядок настройки.
- **`deploy/amvera-vpn-node/`** — задел на будущее (мульти-региональная
  схема с отдельными VPN-нодами и защищённым management API,
  `X-Management-Secret`). **Не используется** в текущем all-in-one деплое —
  не путать с ним.

Требуемые переменные окружения/секреты в проде:
`DATABASE_URL`, `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (автосоздание
первого админа), `PORT` (дефолт 8080, задаётся в Dockerfile).

### Грабли деплоя на Amvera (важно!)

- **`amvera.yml` не поддерживает `run.ports` (список)** — только одиночный
  `run.containerPort` (число). Чистый лог сборки Docker ≠ валидный конфиг —
  всегда проверяй лог приложения после правок `amvera.yml`. Подробности —
  `.agents/memory/amvera-yaml-schema.md`.
- **Сырой TCP (Reality или голый VLESS) через `containerPort` не работает** —
  Amvera всегда терминирует TLS на своём HTTP(S)-контроллере. Отдельный
  TCP-контроллер (`MONGO`/`POSTGRES`/`REDIS`-домены, порты 27017/5432/6379)
  даёт настоящий passthrough по SNI, но раньше используемая схема через него
  была заменена на VLESS+WebSocket поверх обычного веб-домена — проще,
  надёжнее и не требует отдельного TCP-домена. История и обоснование —
  `.agents/memory/amvera-raw-tcp-port.md`.
- `env:` в `amvera.yml` не поддерживается — все секреты только руками в
  панели Amvera, раздел «Переменные»/«Конфигурация».
- Деплой-коммиты в GitHub (через `./deploy.sh`) — не то же самое, что
  merge-коммит, который сама Amvera создаёт в своей внутренней копии
  репозитория при синхронизации («Репозиторий» → «Merge branch main…»).
  Это техническое поведение платформы, на его текст повлиять нельзя;
  смысловую историю изменений смотри на GitHub.

## scripts/

- `scripts/deploy.mjs` (запускается через `./deploy.sh "сообщение"`) — деплой
  на прод: пушит текущее рабочее дерево в GitHub через Git Data REST API
  (не `git push`, т.к. в шелле агента он заблокирован), что триггерит
  автосборку на Amvera. Сообщение коммита — **всегда на русском**
  (см. user preferences в `replit.md`).
- `scripts/post-merge.sh` — запускается автоматически Replit-платформой после
  мержа задач/чекпоинтов: `pnpm install --frozen-lockfile`, затем
  `pnpm --filter db push` (синхронизация схемы БД). См. скилл `post_merge_setup`,
  если нужно менять эту логику.

## .agents/memory/ — память агентов

- `MEMORY.md` — индекс (всегда подгружается в контекст), там же ссылки на
  все топик-файлы с деталями (Amvera-грабли, миграция с Clerk, дизайн
  подписочной ссылки, семантика истечения сессий и т.д.).

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
                          vpn_nodes, vpn_keys)

VPN-клиент → подписочная ссылка (/api/sub/:token) или отдельный vless:// линк
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

- Общий обзор и решения по архитектуре — `replit.md`
- Структура workspace/TypeScript — скилл `pnpm-workspace`
- Нетривиальные уроки прошлых сессий — `.agents/memory/MEMORY.md` → топик-файлы
- Конкретные эндпоинты API — `lib/api-spec/openapi.yaml` (источник истины)
- Деплой/секреты — `deploy/amvera-all-in-one/README.md`
