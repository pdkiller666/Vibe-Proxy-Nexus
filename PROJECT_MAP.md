# Карта проекта — Vibe Proxy Nexus

> Этот файл — ориентир для следующих агентов. Он описывает структуру монорепозитория,
> назначение каждой папки/пакета, как всё связано друг с другом и куда лезть за чем.
> Для конкретных архитектурных решений и user preferences — см. `replit.md`.
> Для узких технических уроков прошлых сессий — см. `.agents/memory/`.

## Что это за проект

**Vibe Proxy Nexus** — приватный VPN-сервис по приглашениям на протоколе
VLESS-XTLS-Reality (Xray-core). Веб-панель позволяет пользователям
регистрироваться, выбирать тарифный план, оплачивать через СБП (ручной перевод,
подтверждается админом) и получать/отзывать VLESS-ключи для подключения.
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
├── scripts/                # Служебные скрипты монорепо (в т.ч. post-merge.sh)
├── .agents/memory/         # Долгосрочная память агентов (нетривиальные уроки/решения)
├── .local/tasks/           # Файлы описаний project tasks (черновики планов)
├── attached_assets/        # Загруженные пользователем файлы/скриншоты/логи
├── amvera.yml              # Конфигурация деплоя на Amvera (env vars, volumes, порты)
├── Dockerfile              # Сборка all-in-one образа для Amvera
├── pnpm-workspace.yaml     # Список пакетов workspace + pnpm catalog (версии зависимостей)
└── replit.md               # Главный README проекта: стек, архитектурные решения, preferences
```

## artifacts/api-server — бэкенд

Express 5 + TypeScript, ESM, собирается в один файл через esbuild (`build.mjs` → `dist/index.mjs`).

- `src/index.ts` — точка входа, слушает `PORT`.
- `src/app.ts` — сборка приложения: pino-логгер, CORS, cookie-parser (подписанные
  куки, ключ — `SESSION_SECRET`), монтирование роутов под `/api`, отдача
  статики фронта (см. ниже), запуск фоновой job очистки просроченных сессий.
- `src/routes/` — все эндпоинты, по одному файлу на сущность:
  - `auth.ts` — `/api/auth/register|login|logout`
  - `me.ts` — `/api/me`
  - `plans.ts`, `vpnNodes.ts` — публичные списки (тарифы, ноды)
  - `subscriptions.ts`, `payments.ts`, `vpnKeys.ts` — личный кабинет пользователя
  - `admin/` — админские роуты (dashboard, users, payments, plans, vpnNodes) — все
    защищены `requireAdmin`
  - `health.ts` — `/api/healthz`
- `src/lib/`:
  - `auth.ts` — middlewares `requireAuth` / `requireAdmin`
  - `session.ts` — БД-сессии: `createSession`/`destroySession`/`getUserBySessionToken`,
    кука `vpn_session` (httpOnly, signed, 30 дней), фоновая очистка просроченных
    сессий раз в час (`startSessionCleanupJob`)
  - `password.ts` — хэширование паролей (scrypt, без внешних зависимостей)
  - `loginRateLimit.ts` — rate-limit на попытки логина (5 / 15 мин, in-memory)
  - `vless.ts` — генерация VLESS-ссылок и UUID для ключей
  - `xray.ts` — работа с локальным конфигом Xray-core и `supervisorctl restart xray`
    (актуально только в проде, гейтится через `XRAY_CONFIG_PATH`)
  - `staticServer.ts` — отдаёт собранный фронтенд из `STATIC_DIR` (гейтится этой
    переменной; в dev не активен — фронт крутится через свой Vite-сервер)
  - `meResponse.ts` — общий билдер данных для `/api/me` и ответов login/register
  - `logger.ts` — конфигурация pino

**Важно про auth**: в июле 2026 Clerk был полностью убран и заменён на
собственную email+password-аутентификацию с сессиями в БД (см.
`.agents/memory/session-auth-migration.md`). Никогда не добавляй `@clerk/*`
обратно без явного запроса пользователя.

## artifacts/vpn-portal — фронтенд

React + Vite + TypeScript, роутинг через `wouter`, состояние сервера — через
TanStack Query (готовые хуки из `@workspace/api-client-react`).

- `src/App.tsx` — маршруты: публичные (`/`, `/sign-in`, `/sign-up`), защищённые
  через `ProtectedRoute` (проверка через `useGetMe()`), админские через
  `AdminRoute` (проверка роли).
- `src/pages/` — по одной странице на маршрут:
  `home`, `sign-in`, `sign-up`, `dashboard`, `plans`, `checkout`, `keys`,
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
- **`@workspace/api-client-react`** — сгенerированные хуки (`useGetMe`,
  `useListPlans`, `useCreateVpnKey` и т.д.), потребляются `vpn-portal`.
- **`@workspace/db`** — Drizzle ORM, PostgreSQL. Схема в `src/schema/`:

| Таблица | Назначение |
|---|---|
| `users` | пользователи (email, passwordHash, role: user/admin) |
| `sessions` | БД-сессии (token PK → userId, expiresAt) |
| `plans` | тарифные планы (цена в руб., длительность) |
| `subscriptions` | подписки пользователя на план (status, startsAt/endsAt) |
| `payments` | платежи (провайдер, сумма, статус, ссылка на подписку) |
| `payment_settings` | синглтон-настройки СБП (телефон, банк, получатель) |
| `vpn_nodes` | VPN-ноды (host, sni, ключи Reality, статус) |
| `vpn_keys` | выданные VLESS-ключи (uuid, ссылка, привязка к ноде/юзеру) |

  Миграции — через `drizzle-kit push` (`pnpm --filter @workspace/db run push`),
  без файлов миграций — схема применяется напрямую по `DATABASE_URL`.

## deploy/ — деплой

- **`deploy/amvera-all-in-one/`** — актуальная схема продакшена: один
  Docker-контейнер, `supervisord` управляет одновременно Xray-core и
  Node.js-процессом api-server. Порт 443 — VPN-трафик, порт 8080 — веб/API.
  `amvera.yml` монтирует `/etc/xray` как persistent volume (чтобы не терять
  список клиентов при передеплое). README в этой папке описывает все
  требуемые секреты и порядок настройки.
- **`deploy/amvera-vpn-node/`** — задел на будущее (мульти-региональная
  схема с отдельными VPN-нодами и защищённым management API,
  `X-Management-Secret`). **Не используется** в текущем all-in-one деплое —
  не путать с ним.

Требуемые переменные окружения/секреты в проде:
`DATABASE_URL`, `SESSION_SECRET`, `REALITY_PRIVATE_KEY`, `REALITY_PUBLIC_KEY`,
`REALITY_SHORT_ID`, `REALITY_SNI` (есть дефолт), `PORT` (дефолт 8080).

## scripts/

`scripts/post-merge.sh` — запускается автоматически Replit-платформой после
мержа задач/чекпоинтов: `pnpm install --frozen-lockfile`, затем
`pnpm --filter db push` (синхронизация схемы БД). См. скилл `post_merge_setup`,
если нужно менять эту логику.

## .agents/memory/ — память агентов

- `MEMORY.md` — индекс (всегда подгружается в контекст).
- `amvera-pnpm-build.md` — почему pnpm запиннен на 10.26.1 (Corepack +
  `onlyBuiltDependencies` на Amvera).
- `deploy-env-gating.md` — как `STATIC_DIR`/`XRAY_CONFIG_PATH` разделяют
  dev/prod поведение.
- `session-auth-migration.md` — детали замены Clerk на кастомную
  email+password-аутентификацию.
- `clerk-localization.md` — устарело (Clerk убран), оставлено для истории.

## Как всё связано (снимок)

```
Пользователь → vpn-portal (React/Vite, dev-порт из workflow)
                    │  fetch через @workspace/api-client-react
                    ▼
              api-server (Express, /api/*)
                    │  drizzle-orm
                    ▼
              PostgreSQL (users, sessions, plans, subscriptions, payments, vpn_nodes, vpn_keys)

Прод (Amvera, один контейнер):
  supervisord ─┬─ xray-core (VLESS-XTLS-Reality, порт 443)
               └─ node dist/index.mjs (api-server, порт 8080)
                       раздаёт и /api/*, и собранный vpn-portal (STATIC_DIR)
```

## Куда смотреть в первую очередь

- Общий обзор и решения по архитектуре — `replit.md`
- Структура workspace/TypeScript — скилл `pnpm-workspace`
- Нетривиальные уроки прошлых сессий — `.agents/memory/MEMORY.md` → топик-файлы
- Конкретные эндпоинты API — `lib/api-spec/openapi.yaml` (источник истины)
- Деплой/секреты — `deploy/amvera-all-in-one/README.md`
