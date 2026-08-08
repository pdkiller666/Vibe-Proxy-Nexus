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
почасовой), оплачивать через ЮMoney (авто) или СБП (ручной перевод,
подтверждается админом) и получать/отзывать VLESS-ключи — либо получить
одну самообновляющуюся ссылку-подписку. Подписки автоматически истекают
и отзывают ключи по окончании оплаченного периода (с честным продлением
при досрочной оплате). На VPN-ноды можно поставить лимит одновременных
пользователей. Есть внутренний баланс, реферальные комиссии, почасовое
списание с баланса, доп. слоты устройств, тикет-система поддержки
и уведомления о низком балансе / истечении подписки (баннеры в ЛК
и Announce-карточка в Happ).

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
│   └── amvera-vpn-node/    # Пакет для дополнительных VPN-нод (Xray + management API)
│                           # Разворачивается на отдельных VPS; бэкенд полностью подключён
├── docs/                   # Документация для операторов и разработчиков
│   ├── SYSTEM_OVERVIEW.md  # Как система работает: подписки, биллинг, UX, безопасность
│   └── add-vpn-node.md     # Пошаговая инструкция добавления VPN-ноды (авто и ручной режим)
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
  - `paymentSettings.ts` — `GET /api/payment-settings` (публичный, без auth;
    возвращает `hasSbpQr: boolean` вместо данных QR-кода),
    `GET /api/payment-settings/sbp-qr-image` (бинарный эндпоинт, отдаёт изображение QR)
  - `subscriptions.ts` — `GET /api/subscriptions/me`, `POST /api/subscriptions`
    (monthly → создаёт pending payment; hourly → активирует сразу из баланса),
    `DELETE /api/subscriptions/:id`
  - `payments.ts` — `GET /api/payments/me`, `PATCH /api/payments/:id/note`
    (userNote опциональна, minLength 0), `PATCH /api/payments/:id/screenshot`
    (загрузка скриншота: MIME-allowlist + magic bytes + лимит 8 МБ base64),
    `GET /api/payments/:id/screenshot/image`
  - `vpnKeys.ts` — `GET /api/vpn-keys/me`, `POST /api/vpn-keys`
    (требует активную подписку и свободный слот; `nodeId` — явный или автовыбор,
    пропускает переполненные ноды), `PATCH /api/vpn-keys/:id` (обновить label/description),
    `DELETE /api/vpn-keys/:id`, `GET /api/vpn-keys/subscription-url`,
    `POST /api/vpn-keys/:id/relocate` (перенести ключ на другую ноду: выдаёт новый ключ
    на целевой ноде, отзывает старый)
  - `subscription.ts` — публичный `GET /api/sub/:token` (HMAC-токен, без cookie-авторизации).
    Поддерживает три формата через `?format=`:
    - *(по умолчанию)* — base64-список `vless://` URI всех активных ключей; работает в любом клиенте
    - `?format=xray` — Xray JSON-конфиг всех ключей + маршрутизация RF-обхода (geoip:ru / .ru / .рф / Яндекс / ВК / Сбер → direct)
    - `?format=xray&key=<id>` — Xray JSON одного устройства; выставляет `Profile-Title` = имя устройства (label из vpn_keys)
    Заголовки ответа: `Profile-Title` / `Profile-Update-Interval` / `Subscription-Userinfo` / `Announce`.
    **Announce-логика:** для hourly — баланс и предупреждение при < 24 ч (оранжевое) или < 3 ч (красное);
    для non-hourly — предупреждение об истечении при ≤ 1 дне («сегодня!») или ≤ 5 днях.
    Обновляется раз в 3 ч (`SUBSCRIPTION_UPDATE_INTERVAL_HOURS`).
  - `extraSlotOrder.ts` — `POST /api/extra-slot-order` (создать заказ на доп. устройство;
    если цена=0 и `allowFreeExtraDeviceSlot` — выдаёт сразу бесплатно),
    `DELETE /api/extra-slot-order/:id`
  - `extraTrafficOrder.ts` — `POST /api/extra-traffic-order` (заказ на доп. трафик,
    аналогично extra-slot), `DELETE /api/extra-traffic-order/:paymentId`
  - `balanceTopupOrder.ts` — `POST /api/balance-topup-order`, `DELETE /api/balance-topup-order/:id`
  - `balanceTransactions.ts` — `GET /api/balance-transactions/me`
  - `yoomoney.ts` — `POST /api/yoomoney/notification` (HMAC-подписанный вебхук от ЮMoney;
    `timingSafeEqual` проверка; при валидном уведомлении вызывает `confirmPaymentById`)
  - `support.ts` — `GET /api/support-tickets`, `POST /api/support-tickets`,
    `GET /api/support-tickets/:id`, `POST /api/support-tickets/:id/messages`
  - `health.ts` — `GET /api/healthz`
  - `admin/` — все под `requireAdmin`:
    - `dashboard.ts` — сводка: онлайн сейчас, новые пользователи 7/30 дней,
      распределение по тарифам, доход по дням за 14 дней, rolling 30-day revenue
    - `users.ts` — список пользователей с вычисляемым `activityStatus`
      (`"site"` / `"vpn"` / `"offline"`, побеждает более свежий сигнал),
      `vpnLastActiveAt`, трафик за период, лимит трафика, активный план, флаг `isBanned`;
      `PATCH /admin/users/:id/role` (блокирует понижение последнего админа),
      `PATCH /admin/users/:id` (профиль),
      `DELETE /admin/users/:id` (Xray deprovision first → DB TX; блокирует себя и последнего админа),
      `PATCH /admin/users/:id/subscription`, `PATCH /admin/users/:id/extra-slots`,
      `POST /admin/users/:id/force-logout`,
      `POST /admin/users/:id/ban` (атомарно: isBanned=true + revoke active keys + delete sessions → Xray non-fatal),
      `POST /admin/users/:id/unban` (isBanned=false + ensureActiveKeyForUser non-fatal),
      `PATCH /admin/users/:id/note` (приватная заметка),
      `GET /admin/users/:id/balance-transactions`,
      `PATCH /admin/users/:id/set-password`,
      `PATCH /admin/users/:id/set-balance` (с audit balance_transaction)
    - `passwordReset.ts` — выдать ссылку сброса пароля пользователю
    - `payments.ts` — `GET /admin/payments`, `POST /admin/payments/:id/confirm`
      (транзакционно, идемпотентно; ветви: subscription / extra_device_slot /
      balance_topup; subscription-подтверждение начисляет реферальную комиссию;
      делегирует в `lib/confirmPayment.ts`),
      `POST /admin/payments/:id/reject`
    - `plans.ts` — CRUD тарифов (monthly и hourly)
    - `vpnNodes.ts` — CRUD нод, ответ включает `activeUserCount`
    - `paymentSettings.ts` — `PATCH /admin/payment-settings` (СБП-реквизиты,
      `sbpPaymentUrl`, `showManualSbpDetails`, цена доп. слота, реферальный %,
      минимальное пополнение для почасового, primaryDomain, флаг/дни пробного периода);
      `PUT /admin/payment-settings/sbp-qr` (загрузить QR-код);
      `DELETE /admin/payment-settings/sbp-qr` (удалить QR-код)
    - `support.ts` — `GET /admin/support-tickets`, `GET /admin/support-tickets/:id`,
      `POST /admin/support-tickets/:id/messages`, `PATCH /admin/support-tickets/:id/status`
    - `vpnKeys.ts` — `GET /admin/vpn-keys`, `POST /admin/vpn-keys/issue` (выдать ключ вручную),
      `DELETE /admin/vpn-keys/:id`
    - `inviteLinks.ts` — `GET /admin/invite-links`, `POST /admin/invite-links` (создать ссылку;
      опционально: `planId` — переопределяет тариф для регистрирующихся по этой ссылке, `maxUses`,
      `expiresAt`, `note`), `PATCH /admin/invite-links/:id` (обновить), `DELETE /admin/invite-links/:id`,
      `GET /admin/invite-links/:id/users` (список зарегистрировавшихся по ссылке)
    - `notifications.ts` — `GET /admin/notifications` (сводка системных событий для бейджа)
    - `referrals.ts` — `GET /admin/referrals` (аналитика реферальной программы)
    - `systemEvents.ts` — `GET /admin/system-events` (список системных событий:
      `xray_config_remount`, `node_overloaded`, `node_unreachable`, `node_recovered` и др.),
      `POST /admin/system-events/:id/acknowledge` (пометить как просмотренное)
    - `vpnNodeProvisioning.ts` — `POST /admin/vpn-nodes/:id/provision` (запустить SSH-провижининг
      на VPS: устанавливает Docker, Xray, management API, генерирует секрет, возвращает job-id),
      `GET /admin/vpn-nodes/:id/provision` (SSE-стрим логов выполнения)
    - `auditLog.ts` — `GET /admin/audit-log` (журнал действий с фильтрами и CSV-экспортом;
      использует кастомный `AuditLogQuery` с `z.coerce.date()` — сгенерированный
      `GetAdminAuditLogQueryParams` использует `z.date()` без принуждения и роняет 400 на
      любой date-фильтр из query-строки)
    - `billingDebug.ts` — `GET /admin/debug/billing` (диагностика застывших почасовых подписок),
      `POST /admin/debug/billing/fix/:subscriptionId` (принудительно исправить startsAt)

- `src/lib/`:
  - `auth.ts` — middlewares: `requireAuth` (сессия + проверка `isBanned` → 403 AccountBanned), `requireAuthAllowBanned` (только сессия, без `isBanned` — только для `GET /me`), `requireAdmin`
  - `session.ts` — БД-сессии (кука `vpn_session`, 30 дней), троттлированное
    обновление `users.lastActiveAt` (раз/мин), `ONLINE_THRESHOLD_MS` = 5 мин;
    токены хэшируются SHA-256 перед записью в БД
  - `subscriptionLifecycle.ts` — `startSubscriptionExpiryJob()`: периодически истекает
    просроченные подписки и отзывает ключи (если нет другой активной подписки);
    24-часовой grace period; lazy-expiry defense-in-depth в `meResponse.ts` / `vpnKeys.ts` / `subscription.ts`
  - `trafficPolling.ts` — `startTrafficPollingJob()`: каждые 60 с опрашивает Xray gRPC
    Stats API (`QueryStats(reset: false)`), вычисляет дельту через `lastSeen*`,
    обновляет `trafficUpBytes`/`trafficDownBytes`/`periodUpBytes`/`periodDownBytes`/`lastTrafficAt`,
    отзывает ключи при превышении `trafficLimitGb`
  - `hourlyBilling.ts` — `startHourlyBillingJob()`: каждые 5 мин списывает
    `hourlyRateKopecks` с баланса активных пользователей на hourly-тарифах,
    только если `lastTrafficAt` в пределах `IDLE_GRACE_MS` = 15 мин;
    оптимистичная блокировка через `lastBilledAt` (защита от двойного списания);
    при нулевом балансе истекает подписку и отзывает ключи
  - `balanceCheckout.ts` — `checkoutFromBalance(userId, target)`: транзакционная оплата
    подписки с баланса (`billingType: hourly` и ежемесячные через баланс);
    `FOR UPDATE` + inner dedup (confirmed+pending) защищает от двойного дебита при retry;
    используется `autoRenew.ts` и напрямую из роута подписки
  - `autoRenew.ts` — `runAutoRenew()` / `startAutoRenewJob()`: раз в час ищет ежемесячные
    подписки с auto-renew, у которых до истечения < 24 ч, и пытается продлить через
    `checkoutFromBalance`; при нехватке средств — уведомляет пользователя; при техошибке —
    пишет admin system-event
  - `reconcileBalancePayments.ts` — `runReconciliation()`: каждые 10 мин ищет зависшие
    pending balance-платежи (старше 5 мин) и компенсирует их — возвращает деньги на баланс,
    переводит статус в `rejected`
  - `confirmPayment.ts` — транзакционное, идемпотентное подтверждение платежа;
    `FOR UPDATE` lock, расчёт цепочки `startsAt`/`endsAt`, реферальная комиссия,
    `ensureActiveKeyForUser` (вне транзакции — намеренно)
  - `nodeMonitoring.ts` — `startNodeMonitoringJob()`: периодически опрашивает health + system/status
    каждой remote-ноды; после 3 неуспешных проб подряд — автоматически деактивирует ноду
    (`isActive = false`), мигрирует все активные ключи, пишет system event `node_unreachable`;
    как только нода отвечает снова — восстанавливает `isActive = true`, пишет `node_recovered`;
    также записывает метрики CPU/RAM/Disk в `node_metric_snapshots` (не чаще раза в 5 мин)
  - `sshProvisioner.ts` — SSH-провижининг удалённых нод: подключается к VPS по SSH (node-ssh),
    устанавливает Docker+Nginx/Caddy+контейнер management API, генерирует TLS-сертификат,
    пишет лог построчно в `provisioning_jobs`; фанаутит live-логи через SSE
  - `xrayClientConfig.ts` — генерация Xray JSON-конфига для клиента (`buildXrayClientConfig`):
    VLESS outbound(ы) + правила маршрутизации RF-обхода (geoip:ru, .ru/.рф домены, Яндекс/ВК/Сбер);
    **не** использует `geoip:ru` через тег (Happ iOS не имеет этой категории в geoip.dat)
  - `xrayStats.ts` — gRPC-клиент для Xray Stats API (protobufjs)
  - `password.ts` — хэширование паролей (scrypt, N=16384)
  - `passwordReset.ts` — токены сброса (32 байта hex, SHA-256 в БД, TTL 30 мин, одноразовые)
  - `loginRateLimit.ts` — 5 попыток / 15 мин, in-memory Map (не синхронизируется при multi-instance)
  - `rateLimit.ts` — общий rate-limiting middleware поверх in-memory Map
  - `vless.ts` — генерация UUID и VLESS+WS-ссылок, `generatePaymentReference`; `buildServingVlessLink`: пропускает замену домена на `vpnexus.pro` для удалённых нод (`managementApiUrl != null`); для IP-нод: `pinnedPeerCertSha256` если задан `certSha256`, иначе `allowInsecure=1`; определение флага страны по полю `region` (word-boundary regex, `vdsina` исключён из правила России)
  - `subscription.ts` — HMAC-токены подписочной ссылки, `BRAND_NAME`, `SUBSCRIPTION_UPDATE_INTERVAL_HOURS` = 3
  - `xray.ts` — правка живого конфига Xray на диске + `supervisorctl restart xray`; `addXrayClient(uuid, email, limitIp?)` принимает опциональный `limitIp` и добавляет его в объект клиента (backward-compatible); все новые ключи получают `limitIp: 1`
  - `domain.ts` — `resolveServingDomain(req)`: выбирает активный домен между `primaryDomain`
    из настроек и техническим Amvera-доменом из запроса (с fallback через healthz-check)
  - `happIosRouting.ts` — правила маршрутизации для Happ iOS: корректно собирает routing rules
    без тегов geoip/geosite, которых нет в минимальном geoip.dat Happ
  - `imageValidation.ts` — `validateImageUpload`: MIME allowlist (jpeg/png/webp), magic-byte check,
    лимит 8 МБ base64 — используется при загрузке скриншотов и QR-кодов
  - `referralCode.ts` — генерация и валидация уникальных реферальных кодов
  - `appDownloadLinks.ts` — `getAppDownloadLinks()`: ссылки на скачивание VPN-клиентов (Happ,
    v2rayNG, v2rayN, Streisand) — используются на лендинге и странице ключей
  - `corsOrigins.ts` — допустимые CORS-origins (dev/prod)
  - `csrf.ts` — Origin-based CSRF check (активен: `app.use("/api", csrfCheck)`); блокирует state-changing запросы с Origin, не совпадающим с Host; пропускает запросы без Origin (curl, вебхуки)
  - `staticServer.ts` — отдаёт собранный фронтенд из `STATIC_DIR`
  - `meResponse.ts` — общий билдер данных для `/api/me`; считает `deviceSlots` =
    `plan.devicesIncluded + subscription.extraDeviceSlots`; `trafficLimitGb` =
    `plan.trafficLimitGb + subscription.extraTrafficGb` (эффективный лимит)
  - `keyIssuance.ts` — логика выдачи VPN-ключа (проверка слотов, нод, добавление в Xray); передаёт `limitIp: 1` в `addXrayClient` и `addRemoteXrayClient` — покрывает все пути выдачи (ручной, auto после оплаты/анбана, trial)
  - `seedAdmin.ts` — при старте создаёт первого админа из `ADMIN_EMAIL`/`ADMIN_PASSWORD`
  - `backfillReferralCodes.ts` — при старте назначает `referral_code` старым строкам, у которых он пустой
  - `auditLog.ts` — `auditLogMiddleware()` (перехватывает все 2xx POST/PATCH/PUT/DELETE через
    `res.on("finish")`), `logAdminAction()` (строит запись + делает SELECT email для описания);
    `ACTION_MAP` (34 пути → имена действий); `normalizeRoutePath` заменяет числовые сегменты
    и любые `:param` на `:id` для мэтчинга. **Важно**: middleware зарегистрирован в `admin/index.ts`
    как отдельный `router.use()` без пути — Express 4 молча не вызывает fn3+ при
    `router.use(regex, fn1, fn2, fn3)`. Фильтр по роли/методу внутри самого middleware.
  - `auditLogCleanup.ts` — `startAuditLogCleanupJob()`: каждые 24 ч удаляет записи
    `admin_audit_log` старше 90 дней
  - `logger.ts` — pino

**VPN-транспорт**: VLESS поверх WebSocket на обычном HTTPS-домене. Xray на `127.0.0.1:10000`, Node-сервер проксирует апгрейд `/vpnws`. Клиенты: `security=tls&type=ws&sni=<домен>`. Подробности — `.agents/memory/amvera-raw-tcp-port.md`.

**Auth**: email+password, сессии в БД (Clerk убран в июле 2026, см. `.agents/memory/session-auth-migration.md`).

## artifacts/vpn-portal — фронтенд

React + Vite + TypeScript, роутинг через `wouter`, состояние сервера — через TanStack Query.

- `src/App.tsx` — маршруты: публичные (`/`, `/sign-in`, `/sign-up`, `/forgot-password`,
  `/reset-password`), защищённые через `ProtectedRoute` (после auth-guard проверяет `me.isBanned` → экран «Аккаунт заблокирован»), админские через `AdminRoute` (аналогичная проверка `isBanned` перед `role !== "admin"`).
- `src/pages/`:
  - `home` — лендинг; герой со статами (`∞ / интернет без границ`, `0 ₽ / Попробовать`,
    `5 с / До первого ключа`, `24/7 / Поддержка`); секции: «Три шага», «Что вы получаете»
    (3 карточки, grid/carousel), «Приложения» (бесконечный тикер), тарифы, отзывы
    (авто-карусель + dots), FAQ
  - `sign-in` / `sign-up` / `forgot-password` / `reset-password` — auth
  - `dashboard` — дашборд пользователя (статус подписки, баланс, быстрые действия,
    реферальная программа, трафик за период). **Уведомления:** оранжевый баннер при
    истечении подписки ≤ 5 дней; оранжевый баннер (3–24 ч) или красный алерт (< 3 ч)
    при низком балансе для hourly-тарифов. Ссылки «Пополнить» ведут на `/payments`.
  - `plans` — тарифы (snap-карусель на мобильных; dot-навигация; активный тариф пользователя
    выделен зелёным бейджем «Активный» + кнопка «Текущий тариф» заблокирована —
    матчинг по `me.currentPlanName && me.hasActiveSubscription`)
  - `checkout` — оплата подписки (СБП-реквизиты с toggle видимости, ЮMoney-кнопки,
    загрузка скриншота обязательна, примечание необязательно, кнопка «Я оплатил(а)»
    активна только при наличии скриншота)
  - `balance-topup` — пополнение баланса (те же правила: скриншот обязателен)
  - `slot-checkout` — оплата доп. устройства (скриншот обязателен)
  - `traffic-checkout` — оплата доп. трафика (скриншот обязателен)
  - `keys` — ключи и устройства. Три блока: **«Ссылка подписки»** (универсальная, для всех клиентов, с QR); **«Xray-конфиг с автообходом РФ»** (per-device ссылки `?format=xray&key=<id>` с QR на каждое устройство, предупреждение Happ вверху блока); **список ключей** (карточки с именем/нодой, кнопки переименования и смены сервера)
  - `payments` — история платежей + **история операций с балансом** (под виджетом баланса)
  - `support` — тикеты поддержки (список + переписка)
  - `profile` — смена имени/email/пароля
  - `admin` — панель администратора (дашборд, платежи со скриншотами, тарифы, ноды,
    ключи, пользователи с activityStatus, реквизиты СБП + QR-код, поддержка)
  - `not-found` — 404
- `src/components/`:
  - `layout.tsx` — обвязка личного кабинета (сайдбар, email, баланс, логаут)
  - `yoomoney-payment-buttons.tsx` — кнопки ЮMoney (карта/SberPay) + СБП-кнопка
    с QR-лайтбоксом; внутри вызывает `useGetPaymentSettings`
  - `payment-screenshot-upload.tsx` — загрузка скриншота: пропс `required`, превью
    миниатюры, лайтбокс, инвалидирует `getListMyPaymentsQueryKey()` после загрузки
  - `onboarding-tip.tsx`, `copy-field.tsx` и др.
- `src/lib/query-client.ts` — конфиг TanStack Query (4xx-ошибки не ретраятся).
- Vite слушает `0.0.0.0:$PORT`, `allowedHosts: true`, базовый путь — `BASE_PATH`.

**Визуальный стиль**: весь UI-текст на русском, чёрно-оранжево-белая индустриальная
палитра, шрифты Space Grotesk/Space Mono, острые углы (`--radius: 0rem`), без эмодзи.

## artifacts/mockup-sandbox — песочница компонентов

Отдельный Vite-сервер для изолированного превью React-компонентов на канвасе.
`mockupPreviewPlugin.ts` сканирует `src/components/mockups/` и генерирует карту;
открывается по `/preview/:ComponentName`. Не часть продакшн-приложения.

## lib/ — общие пакеты

Цепочка кодогенерации API (инструмент — **Orval**):

```
lib/api-spec/openapi.yaml  (источник истины — ВСЕГДА редактировать здесь)
        │  pnpm --filter @workspace/api-spec run codegen
        ├──▶ lib/api-zod/src/generated          (Zod-схемы → валидация в api-server)
        └──▶ lib/api-client-react/src/generated (React Query хуки → используются в vpn-portal)
```

**Правила кодогенерации:**
- Никогда не редактировать файлы под `generated/` вручную — только через codegen. Исключение: если codegen недоступен (нет скрипта `generate` в api-zod), допускается прямое редактирование zod-файла с одновременным обновлением openapi.yaml.
- Никогда не называть компонент схемы `<operationId>Body/Params/Response/QueryParams` — Orval генерирует такие имена сам, будет коллизия.
- Подробности — `.agents/memory/openapi-spec-drift.md`.

После правки `lib/db/src/schema/` — пересобрать пакет db перед тайпчеком:
`pnpm --filter @workspace/db exec tsc -p .`

## Схема базы данных

| Таблица | Ключевые поля | Назначение |
|---|---|---|
| `users` | email (unique), passwordHash, name, role (user/admin), balanceKopecks (default 0), referralCode (unique), referredByUserId (nullable FK→users **ON DELETE SET NULL**), lastActiveAt (nullable), adminNote (nullable), isBanned (boolean, default false) | пользователи; `lastActiveAt` — основа онлайн-статуса "на сайте"; `balanceKopecks` — внутренний кошелёк; `referralCode` — уникальный код для приглашения; `isBanned` — заблокирован (middleware 403 AccountBanned); `adminNote` — приватная заметка администратора |
| `sessions` | token (SHA-256 хэш, PK), userId, expiresAt | БД-сессии (кука `vpn_session`, 30 дней); токен хранится захэшированным |
| `password_reset_tokens` | token (SHA-256 хэш, PK), userId, expiresAt | одноразовые токены сброса пароля (TTL 30 мин); токен хранится захэшированным |
| `plans` | name, description, priceRub, durationDays, devicesIncluded (default 1), trafficLimitGb (nullable=безлимит), billingType (monthly/hourly), hourlyRateKopecks (nullable), isActive | тарифные планы |
| `subscriptions` | userId, planId, status (pending_payment/active/expired/cancelled/rejected), startsAt, endsAt (nullable для hourly), lastBilledAt (nullable, для hourly), extraDeviceSlots (default 0), extraTrafficGb (default 0), trafficLimitExceededAt (nullable), revokedReason (nullable) | подписки; `extraDeviceSlots`/`extraTrafficGb` — доп. слоты/трафик, купленные в рамках этой подписки |
| `payments` | subscriptionId (nullable), userId, type (subscription/extra_device_slot/balance_topup/extra_traffic), provider (manual_sbp/yoomoney/freekassa[legacy]), amountRub, status (pending/confirmed/rejected), reference (уникальный код), userNote (nullable, minLength 0), screenshotData (base64, Postgres), screenshotMimeType, hasScreenshot (вычисляемое), rejectionReason | платежи |
| `payment_settings` | sbpPhone, sbpBank, sbpRecipientName, instructions, sbpPaymentUrl (ссылка на платёж в банке), showManualSbpDetails (toggle реквизитов), sbpQrCodeData (base64 QR), sbpQrCodeMimeType, extraDeviceSlotPriceRub, allowFreeExtraDeviceSlot, trialEnabled, trialDays, minHourlyTopupRub, primaryDomain, referralCommissionPercent, yookassaEnabled, sbpEnabled | синглтон-настройки оплаты и продуктовые параметры |
| `vpn_nodes` | name, region, host, port (default 443), sni, publicKey, shortId, isActive, maxUsers (nullable=безлимит), managementApiUrl (nullable), managementApiSecret (nullable), certSha256 (nullable) | VPN-ноды; `activeUserCount` вычисляется на лету; `managementApiUrl != null` = удалённая нода; `certSha256` — SHA-256 fingerprint сертификата для IP-нод (вместо `allowInsecure=1`) |
| `vpn_keys` | userId, nodeId, uuid (unique), label, description (nullable), vlessLink, deepLink, revokedAt, trafficUpBytes, trafficDownBytes, periodUpBytes, periodDownBytes, periodStartedAt, lastSeenUpBytes, lastSeenDownBytes, lastTrafficAt (nullable) | выданные ключи; `period*` — сбрасываются при продлении; `lastSeen*` — предыдущий снимок из Xray для вычисления дельты |
| `balance_transactions` | userId, amountKopecks, type (topup/debit/refund/referral), paymentId (nullable FK), description | лог всех движений баланса; отображается на странице Платежи |
| `support_tickets` | userId, subject, status (open/answered/closed) | тикеты поддержки |
| `support_messages` | ticketId, authorId, body | сообщения в тикетах |
| `invite_links` | code (unique, 12 символов), note (nullable), createdByUserId, planId (nullable FK→plans — переопределяет тариф при регистрации), maxUses (nullable=∞), usedCount (default 0), isActive, expiresAt (nullable) | инвайт-ссылки, создаваемые администратором; приоритетнее `users.referral_code` при регистрации |
| `system_events` | eventType (xray_config_remount / node_overloaded / node_unreachable / node_recovered / auto_renew_failed / auto_renew_error / key_migrated и др.), userId (nullable), metadata (JSONB), acknowledgedAt (nullable) | системные события от фоновых задач и мониторинга нод; отображаются в админ-панели |
| `node_metric_snapshots` | nodeId (FK→vpn_nodes), cpuPercent, ramPercent, diskPercent, createdAt | исторические метрики нод (CPU/RAM/Disk), запись раз в 5 мин на ноду; строки старше 90 дней удаляются |
| `provisioning_jobs` | nodeId (nullable FK→vpn_nodes), status (pending/running/done/failed), logs (JSONB-массив строк с уровнем/текстом/timestamp), createdAt, updatedAt | журнал SSH-провижининга новых нод; логи пишутся построчно, отдаются клиенту через SSE |
| `admin_audit_log` | adminId (FK→users), adminEmail, action (строка из ACTION_MAP), method, path, targetType (nullable), targetId (nullable), targetDescription (nullable), details (JSONB: requestBody+queryParams, sensitive fields redacted), responseStatus, durationMs, ipAddress, userAgent, createdAt | журнал всех мутирующих действий администратора; записывается middleware автоматически; хранится 90 дней |

Миграции — через `drizzle-kit push` (`pnpm --filter @workspace/db run push` в dev;
в проде — шагом в `entrypoint.sh` при каждом старте контейнера, без файлов миграций).
`heal-schema.mjs` — нетривиальные DDL-изменения (уникальные индексы, FK constraints,
DROP COLUMN), которые drizzle-kit push не может выполнить автоматически без промпта.
Все PL/pgSQL блоки используют `DO $$ … $$` (двойное dollar-quoting).
Текущие миграции: M-0→M-15 (исторические), M-16 (`users.is_banned`), M-17 (`users.referred_by_user_id` FK → ON DELETE SET NULL), M-24 (`vpn_nodes.cert_sha256`), M-36 (`admin_audit_log` таблица), M-37 (`support_messages.attachment_data`/`attachment_mime_type`: text→text[] — drizzle-kit push падал при кастинге при каждом старте).

## deploy/ — деплой

- **`deploy/amvera-all-in-one/`** — актуальная схема продакшена: один Docker-контейнер,
  `supervisord` управляет Xray-core (`127.0.0.1:10000`) и Node.js (порт `8080`).
  README описывает все секреты и порядок настройки.
- **`deploy/amvera-vpn-node/`** — пакет для дополнительных VPN-нод на отдельных VPS
  (Xray + management API, `X-Management-Secret`). Бэкенд полностью подключён (`remoteNode.ts`,
  `keyIssuance.ts`). **Активно используется**: живой NL-узел на VDSina
  (`v917715.hosted-by-vdsina.com`, Let's Encrypt, Xray 26.x). Инструкция — `docs/add-vpn-node.md`.

Требуемые переменные в проде:
`DATABASE_URL`, `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `PORT` (дефолт 8080),
`YOOMONEY_NOTIFICATION_SECRET`, `YOOMONEY_RECEIVER`.

### Amvera retry-audit — идемпотентность POST-операций создания

Amvera proxy может повторить медленный POST-запрос при таймауте, что создаёт риск
дублирования записей. Ниже — аудит эндпоинтов создания с выводом по каждому.

| Эндпоинт | Файл | Защита |
|---|---|---|
| `POST /api/extra-slot-order` | `extraSlotOrder.ts` | ✅ app-guard + DB unique index |
| `POST /api/extra-traffic-order` | `extraTrafficOrder.ts` | ✅ app-guard + DB unique index |
| `POST /api/balance-topup-order` | `balanceTopupOrder.ts` | ✅ app-guard + DB unique index |
| `POST /api/subscriptions` (не-hourly, включая ЮMoney) | `subscriptions.ts` | ✅ app-guard на subscriptions + DB unique index через tx |
| `POST /api/subscriptions` (hourly) | `subscriptions.ts` | ⚠️ только app-guard; tx самоисправляется (см. ниже) |

**Механизм защиты для order-эндпоинтов:**

Схема таблицы `payments` содержит уникальный частичный индекс
`payments_one_pending_per_user_type_idx` по `(userId, type) WHERE status = 'pending'`
(применён в `heal-schema.mjs`). Он гарантирует: даже если два конкурентных запроса
одновременно пройдут app-level SELECT-проверку, второй INSERT упадёт с ошибкой
уникальности — дублирование на уровне БД невозможно.

Для `POST /subscriptions` (не-hourly): транзакция создаёт одновременно строку
в `subscriptions` и `payments`. Если гонка обходит app-guard, INSERT payment-строки
со статусом `pending` и `type='subscription'` нарушает тот же индекс → вся транзакция
откатывается, subscription-строка не сохраняется. Пользователь получает 500 вместо 409
в момент гонки — не идеально, но дублей нет.

**Hourly-подписки (пониженный риск):**

`POST /subscriptions` с hourly-тарифом не создаёт payment-строку (активация мгновенная,
биллинг постфактный). App-guard (`existingActiveHourly`) — check-then-act без DB unique
constraint. Однако транзакция атомично выполняет «пометить все active → expired, вставить
новую active»: второй concurrent-запрос `UPDATE` захватывает строку первого и помечает её
expired, а затем создаёт свою. Итог: одна active-строка (последняя), финансовый вред нулевой.
Это известный пониженный риск, не требующий срочного исправления.

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
                          support_tickets, support_messages,
                          invite_links, system_events,
                          node_metric_snapshots, provisioning_jobs,
                          admin_audit_log)

ЮMoney → POST /api/yoomoney/notification (HMAC webhook) → confirmPaymentById()

VPN-клиент → ссылка-подписка (/api/sub/:token) или отдельный vless:// линк
                    │  VLESS поверх WebSocket+TLS, sni = веб-домен
                    │  Announce-заголовок: предупреждения о балансе/истечении
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
