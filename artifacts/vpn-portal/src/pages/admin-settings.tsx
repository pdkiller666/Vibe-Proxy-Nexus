import { useState, useRef } from "react";
import {
  useGetPaymentSettings,
  getGetPaymentSettingsQueryKey,
  useListPlans,
  useUpdatePaymentSettings,
  useUploadSbpQr,
  useDeleteSbpQr,
} from "@workspace/api-client-react";
import type { Plan } from "@workspace/api-client-react";
import { queryClient } from "@/lib/query-client";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, Settings, Save, X, Check, Pencil, Trash2, Plus, Image as ImageIcon } from "lucide-react";
export function PaymentSettingsForm() {
  // Refetch every 60 s so the domain-health alert auto-clears once the domain
  // is healthy again — same cadence as the server-side healthz cache TTL.
  const { data: settings, isLoading } = useGetPaymentSettings({
    query: { queryKey: getGetPaymentSettingsQueryKey(), refetchInterval: 60_000 },
  });
  const { data: plans } = useListPlans();
  const { mutate: update, isPending } = useUpdatePaymentSettings();
  const { toast } = useToast();
  // Only monthly plans are valid for trial (hourly plans start at 0₽ and
  // immediately cut off access when the user's balance=0 hits the first tick).
  const monthlyPlans = (plans ?? []).filter((p) => p.billingType === "monthly" && p.isActive);
  const [sbpPhone, setSbpPhone] = useState("");
  const [sbpBank, setSbpBank] = useState("");
  const [sbpRecipientName, setSbpRecipientName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [extraDeviceSlotPriceRub, setExtraDeviceSlotPriceRub] = useState("");
  const [allowFreeExtraDeviceSlot, setAllowFreeExtraDeviceSlot] = useState(false);
  const [extraTrafficPriceRub, setExtraTrafficPriceRub] = useState("");
  const [extraTrafficPackageGb, setExtraTrafficPackageGb] = useState("10");
  const [allowFreeExtraTraffic, setAllowFreeExtraTraffic] = useState(false);
  const [trialEnabled, setTrialEnabled] = useState(false);
  const [trialDays, setTrialDays] = useState("5");
  const [trialPlanId, setTrialPlanId] = useState<number | null>(null);
  const [minHourlyTopupRub, setMinHourlyTopupRub] = useState("0");
  const [primaryDomain, setPrimaryDomain] = useState("");
  const [referralCommissionPercent, setReferralCommissionPercent] = useState("0");
  const [sbpPaymentUrl, setSbpPaymentUrl] = useState("");
  const [showManualSbpDetails, setShowManualSbpDetails] = useState(false);
  const [yookassaEnabled, setYookassaEnabled] = useState(true);
  const [sbpEnabled, setSbpEnabled] = useState(true);
  const [balancePaymentsEnabled, setBalancePaymentsEnabled] = useState(false);
  const [initialized, setInitialized] = useState(false);

  if (settings && !initialized) {
    setSbpPhone(settings.sbpPhone);
    setSbpBank(settings.sbpBank);
    setSbpRecipientName(settings.sbpRecipientName);
    setInstructions(settings.instructions ?? "");
    setExtraDeviceSlotPriceRub(String(settings.extraDeviceSlotPriceRub ?? 0));
    setAllowFreeExtraDeviceSlot(settings.allowFreeExtraDeviceSlot ?? false);
    setExtraTrafficPriceRub(String(settings.extraTrafficPriceRub ?? 0));
    setExtraTrafficPackageGb(String(settings.extraTrafficPackageGb ?? 10));
    setAllowFreeExtraTraffic(settings.allowFreeExtraTraffic ?? false);
    setTrialEnabled(settings.trialEnabled ?? false);
    setTrialDays(String(settings.trialDays ?? 5));
    setTrialPlanId(settings.trialPlanId ?? null);
    setMinHourlyTopupRub(String(settings.minHourlyTopupRub ?? 0));
    setPrimaryDomain(settings.primaryDomain ?? "");
    setReferralCommissionPercent(String(settings.referralCommissionPercent ?? 0));
    setSbpPaymentUrl(settings.sbpPaymentUrl ?? "");
    setShowManualSbpDetails(settings.showManualSbpDetails ?? false);
    setYookassaEnabled(settings.yookassaEnabled ?? true);
    setSbpEnabled(settings.sbpEnabled ?? true);
    setBalancePaymentsEnabled(settings.balancePaymentsEnabled ?? false);
    setInitialized(true);
  }

  function handleSubmit() {
    update(
      {
        data: {
          sbpPhone,
          sbpBank,
          sbpRecipientName,
          instructions,
          extraDeviceSlotPriceRub: Number(extraDeviceSlotPriceRub) || 0,
          allowFreeExtraDeviceSlot,
          extraTrafficPriceRub: Number(extraTrafficPriceRub) || 0,
          extraTrafficPackageGb: Number(extraTrafficPackageGb) || 10,
          allowFreeExtraTraffic,
          trialEnabled,
          trialDays: Number(trialDays) || 5,
          trialPlanId: trialPlanId ?? null,
          minHourlyTopupRub: Number(minHourlyTopupRub) || 0,
          primaryDomain: primaryDomain.trim(),
          referralCommissionPercent: Number(referralCommissionPercent) || 0,
          sbpPaymentUrl: sbpPaymentUrl.trim(),
          showManualSbpDetails,
          yookassaEnabled,
          sbpEnabled,
          balancePaymentsEnabled,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetPaymentSettingsQueryKey() });
          toast({ title: "Реквизиты обновлены" });
        },
        onError: () => toast({ title: "Ошибка сохранения реквизитов", variant: "destructive" }),
      },
    );
  }

  if (isLoading) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="bg-card border border-border p-5 space-y-3 max-w-xl">
      {/* Domain health alert: shown when the primary domain fails the healthz check */}
      {settings?.primaryDomainHealthy === false && (
        <div className="flex items-start gap-3 bg-red-50 dark:bg-red-950/30 border border-red-400 dark:border-red-700 p-4">
          <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-red-700 dark:text-red-300">
              Основной домен недоступен
            </p>
            <p className="text-xs text-red-600 dark:text-red-400">
              Домен <strong>{settings.primaryDomain || "vpnexus.pro"}</strong> не отвечает на
              проверку работоспособности. Если он заблокирован — смените поле «Основной домен»
              ниже на новый адрес и сохраните. Сервер немедленно начнёт выдавать новый URL
              подписки, а клиенты с поддержкой автообновления подпишутся на него автоматически
              при следующем рефреше (каждые 3 часа).
            </p>
          </div>
        </div>
      )}

      {/* Payment method visibility toggles */}
      <div className="border border-border p-4 space-y-3">
        <p className="text-sm font-semibold">Способы оплаты</p>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Карта / SberPay (ЮMoney)</p>
            <p className="text-xs text-muted-foreground mt-0.5">Показывать тайл «Карта / SberPay» на страницах оплаты</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={yookassaEnabled}
              onChange={(e) => setYookassaEnabled(e.target.checked)}
            />
            <div className="w-10 h-6 bg-muted peer-checked:bg-primary rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-5 after:h-5 after:rounded-full after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">СБП</p>
            <p className="text-xs text-muted-foreground mt-0.5">Показывать тайл «СБП» на страницах оплаты</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={sbpEnabled}
              onChange={(e) => setSbpEnabled(e.target.checked)}
            />
            <div className="w-10 h-6 bg-muted peer-checked:bg-primary rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-5 after:h-5 after:rounded-full after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Оплата с баланса</p>
            <p className="text-xs text-muted-foreground mt-0.5">Разрешить мгновенную оплату с кошелька (без модерации)</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={balancePaymentsEnabled}
              onChange={(e) => setBalancePaymentsEnabled(e.target.checked)}
            />
            <div className="w-10 h-6 bg-muted peer-checked:bg-primary rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-5 after:h-5 after:rounded-full after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>
      </div>

      {/* SBP online payment settings */}
      <div className="border border-border p-4 space-y-3">
        <p className="text-sm font-semibold">СБП — ссылка и QR</p>
        <div>
          <label className="text-xs font-mono text-muted-foreground uppercase block mb-1">Ссылка для кнопки «Перейти к оплате по СБП»</label>
          <Input
            placeholder="https://finance.ozon.ru/apps/sbp/... (пусто = Озон Банк по умолчанию)"
            value={sbpPaymentUrl}
            onChange={(e) => setSbpPaymentUrl(e.target.value)}
            className="rounded-none"
          />
          <p className="text-xs text-muted-foreground mt-1">Оставьте пустым чтобы использовать встроенную ссылку Озон Банк.</p>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Показывать реквизиты (телефон/банк/получатель)</p>
            <p className="text-xs text-muted-foreground mt-0.5">Отображать старую форму с реквизитами на страницах оплаты СБП</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={showManualSbpDetails}
              onChange={(e) => setShowManualSbpDetails(e.target.checked)}
            />
            <div className="w-10 h-6 bg-muted peer-checked:bg-primary rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-5 after:h-5 after:rounded-full after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>
      </div>

      {/* Manual SBP requisites (shown only when showManualSbpDetails is on) */}
      <Input placeholder="Телефон СБП" value={sbpPhone} onChange={(e) => setSbpPhone(e.target.value)} className="rounded-none" />
      <Input placeholder="Банк" value={sbpBank} onChange={(e) => setSbpBank(e.target.value)} className="rounded-none" />
      <Input
        placeholder="Имя получателя"
        value={sbpRecipientName}
        onChange={(e) => setSbpRecipientName(e.target.value)}
        className="rounded-none"
      />
      <Textarea
        placeholder="Инструкции для пользователя"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        className="rounded-none"
      />
      <div>
        <label className="text-xs font-mono text-muted-foreground uppercase block mb-1">Цена доп. устройства (₽)</label>
        <Input
          type="number"
          min="0"
          placeholder="0"
          value={extraDeviceSlotPriceRub}
          onChange={(e) => setExtraDeviceSlotPriceRub(e.target.value)}
          className="rounded-none"
        />
      </div>

      <div className="border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Бесплатные доп. устройства</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Если цена не задана (0 ₽), выдавать слот без оплаты вместо блокировки кнопки
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={allowFreeExtraDeviceSlot}
              onChange={(e) => setAllowFreeExtraDeviceSlot(e.target.checked)}
            />
            <div className="w-10 h-6 bg-muted peer-checked:bg-primary rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-5 after:h-5 after:rounded-full after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>
      </div>

      <div className="border border-border p-4 space-y-3">
        <p className="text-sm font-semibold">Доп. трафик</p>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="text-xs font-mono text-muted-foreground uppercase block mb-1">Размер пакета (ГБ)</label>
            <Input
              type="number"
              min="1"
              placeholder="10"
              value={extraTrafficPackageGb}
              onChange={(e) => setExtraTrafficPackageGb(e.target.value.replace(/[^0-9]/g, ""))}
              className="rounded-none"
            />
          </div>
          <div className="flex-1">
            <label className="text-xs font-mono text-muted-foreground uppercase block mb-1">Цена пакета (₽)</label>
            <Input
              type="number"
              min="0"
              placeholder="0"
              value={extraTrafficPriceRub}
              onChange={(e) => setExtraTrafficPriceRub(e.target.value)}
              className="rounded-none"
            />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Если цена не задана (0 ₽), выдавать пакет без оплаты вместо блокировки кнопки
          </p>
          <label className="relative inline-flex items-center cursor-pointer shrink-0 ml-3">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={allowFreeExtraTraffic}
              onChange={(e) => setAllowFreeExtraTraffic(e.target.checked)}
            />
            <div className="w-10 h-6 bg-muted peer-checked:bg-primary rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-5 after:h-5 after:rounded-full after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>
      </div>

      <div className="border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Пробный период</p>
            <p className="text-xs text-muted-foreground mt-0.5">Новые пользователи получают бесплатную подписку при регистрации</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={trialEnabled}
              onChange={(e) => setTrialEnabled(e.target.checked)}
            />
            <div className="w-10 h-6 bg-muted peer-checked:bg-primary rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-5 after:h-5 after:rounded-full after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>
        {trialEnabled && (
          <div className="space-y-3">
            <div>
              <label className="text-xs font-mono text-muted-foreground uppercase block mb-1">Длительность пробного периода (дней)</label>
              <Input
                type="number"
                min="1"
                max="365"
                placeholder="5"
                value={trialDays}
                onChange={(e) => setTrialDays(e.target.value.replace(/[^0-9]/g, ""))}
                className="rounded-none max-w-[140px]"
              />
            </div>
            <div>
              <label className="text-xs font-mono text-muted-foreground uppercase block mb-1">Тариф для пробного периода</label>
              <select
                value={trialPlanId ?? ""}
                onChange={(e) => setTrialPlanId(e.target.value ? Number(e.target.value) : null)}
                className="border border-border bg-background px-3 py-2 text-sm rounded-none w-full max-w-xs"
              >
                <option value="">Авто — наиболее дешёвый месячный тариф</option>
                {monthlyPlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.trafficLimitGb ? ` — ${p.trafficLimitGb} ГБ` : " — без лимита"}
                    {`, ${p.devicesIncluded} уст.`}
                  </option>
                ))}
              </select>
              {monthlyPlans.length === 0 && (
                <p className="text-xs text-muted-foreground mt-1">Нет активных месячных тарифов. Создайте тариф заранее.</p>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="border border-border p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold">Минимальное пополнение для почасового тарифа</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Пользователь не сможет подключить почасовой тариф, пока баланс не достигнет этой суммы. 0 — без ограничения.
          </p>
        </div>
        <Input
          type="number"
          min="0"
          placeholder="0"
          value={minHourlyTopupRub}
          onChange={(e) => setMinHourlyTopupRub(e.target.value.replace(/[^0-9]/g, ""))}
          className="rounded-none max-w-[140px]"
        />
      </div>

      <div className="border border-border p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold">Основной домен</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Показывается пользователям в ссылке подписки и ключах, пока доступен (проверяется автоматически). Если домен
            заблокируют — измените здесь, сервер сразу переключится на резервный технический адрес, пока не примените новый.
          </p>
        </div>
        <Input
          placeholder="vpnexus.pro"
          value={primaryDomain}
          onChange={(e) => setPrimaryDomain(e.target.value)}
          className="rounded-none max-w-[280px]"
        />
      </div>

      <div className="border border-border p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold">Реферальная программа</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Процент от суммы каждой реально оплаченной подписки, который начисляется на баланс пригласившего
            пользователя. 0 — вознаграждение не начисляется.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min="0"
            max="100"
            placeholder="0"
            value={referralCommissionPercent}
            onChange={(e) => setReferralCommissionPercent(e.target.value.replace(/[^0-9]/g, ""))}
            className="rounded-none max-w-[140px]"
          />
          <span className="text-sm text-muted-foreground">%</span>
        </div>
      </div>

      <button
        onClick={handleSubmit}
        disabled={isPending}
        className="bg-primary text-primary-foreground font-bold px-5 py-2.5 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        Сохранить реквизиты
      </button>

      {/* QR code section — separate mutation, not part of the main form */}
      <SbpQrSection />

      {/* iOS Happ routing profile — separate mutation */}
      <HappIosRoutingSection />

      {/* App download links — separate mutation */}
      <AppDownloadLinksSection />
    </div>
  );
}

function SbpQrSection() {
  const { data: settings } = useGetPaymentSettings();
  const { mutate: uploadQr, isPending: uploading } = useUploadSbpQr();
  const { mutate: deleteQr, isPending: deleting } = useDeleteSbpQr();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const MAX_BYTES = 8 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      toast({ title: "Файл слишком большой (макс. 8 МБ)", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1] ?? "";
      uploadQr(
        { data: { data: base64, mimeType: file.type } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetPaymentSettingsQueryKey() });
            toast({ title: "QR-код загружен" });
          },
          onError: () => toast({ title: "Ошибка загрузки QR", variant: "destructive" }),
        },
      );
    };
    reader.readAsDataURL(file);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="border border-border p-4 space-y-3 mt-2">
      <p className="text-sm font-semibold">QR-код для СБП</p>
      {settings?.hasSbpQr ? (
        <div className="space-y-2">
          <img
            src="/api/payment-settings/sbp-qr-image"
            alt="QR СБП"
            className="w-40 h-40 object-contain border border-border bg-white p-1"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
              className="border border-border px-3 py-1.5 text-sm hover:bg-muted transition-colors disabled:opacity-50"
            >
              {uploading ? "Загружаем..." : "Заменить QR"}
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() =>
                deleteQr(undefined as never, {
                  onSuccess: () => {
                    queryClient.invalidateQueries({ queryKey: getGetPaymentSettingsQueryKey() });
                    toast({ title: "QR-код удалён" });
                  },
                  onError: () => toast({ title: "Ошибка удаления QR", variant: "destructive" }),
                })
              }
              className="border border-destructive/50 text-destructive px-3 py-1.5 text-sm hover:bg-destructive/10 transition-colors disabled:opacity-50"
            >
              {deleting ? "Удаляем..." : "Удалить QR"}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">QR-код не загружен. После загрузки кнопка «Показать QR» появится на странице оплаты СБП.</p>
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-2 border border-border px-3 py-1.5 text-sm hover:bg-muted transition-colors disabled:opacity-50"
          >
            <ImageIcon className="w-4 h-4" />
            {uploading ? "Загружаем..." : "Загрузить QR-код"}
          </button>
        </div>
      )}
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
    </div>
  );
}

// ── iOS Happ routing profile editor ──────────────────────────────────────────
// Standalone section: admin edits the direct-bypass domain / CIDR list and the
// profile name. Changes are saved via PATCH /admin/payment-settings and do NOT
// require the main form to be submitted — separate "Save" button below.

/** Strip "domain:" prefix for display; keep other prefixes (regexp:, etc.) intact. */
function formatSitesForDisplay(sites: string[]): string {
  return sites
    .map((s) => (s.startsWith("domain:") ? s.slice(7) : s))
    .join("\n");
}

/** Restore full Xray matcher format from a textarea value.
 *  Lines that already contain ":" are kept as-is (regexp:, full:, etc.).
 *  Plain domain names get the "domain:" prefix added back. */
function parseSitesFromDisplay(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => (l.includes(":") ? l : `domain:${l}`));
}

function HappIosRoutingSection() {
  const { data: settings } = useGetPaymentSettings();
  const { mutate: update, isPending } = useUpdatePaymentSettings();
  const { toast } = useToast();

  const [profileName, setProfileName] = useState("");
  const [directSitesText, setDirectSitesText] = useState("");
  const [directIpText, setDirectIpText] = useState("");
  const [initialized, setInitialized] = useState(false);

  // Seed form from API (effective profile — always non-null from server).
  if (settings && !initialized) {
    const p = settings.happIosRoutingProfile;
    setProfileName(p.name);
    setDirectSitesText(formatSitesForDisplay(p.directsites));
    setDirectIpText(p.directip.join("\n"));
    setInitialized(true);
  }

  function handleSave() {
    const profile = {
      name: profileName.trim() || "VPNexus",
      directsites: parseSitesFromDisplay(directSitesText),
      directip: directIpText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    };
    update(
      { data: { happIosRoutingProfile: profile } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetPaymentSettingsQueryKey() });
          toast({ title: "Профиль iOS маршрутизации сохранён" });
        },
        onError: () => toast({ title: "Ошибка сохранения профиля", variant: "destructive" }),
      },
    );
  }

  function handleReset() {
    update(
      { data: { happIosRoutingProfile: null } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetPaymentSettingsQueryKey() });
          setInitialized(false); // re-seed form from refreshed defaults
          toast({ title: "Профиль сброшен до встроенных значений" });
        },
        onError: () => toast({ title: "Ошибка сброса профиля", variant: "destructive" }),
      },
    );
  }

  return (
    <div className="border border-border p-4 space-y-4 mt-2">
      <div>
        <p className="text-sm font-semibold">iOS Happ — профиль маршрутизации</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Управляйте списком сайтов и IP-адресов, которые будут проходить напрямую (обходить тоннель)
          у iOS-пользователей. Изменения применяются мгновенно — пользователи переимпортируют
          профиль нажатием кнопки на странице ключей.
        </p>
      </div>

      {/* Current deep link preview */}
      {settings?.happIosRoutingUrl && (
        <div className="space-y-1">
          <p className="text-xs font-mono text-muted-foreground uppercase tracking-wide">Текущая ссылка профиля</p>
          <div className="flex items-center gap-2 bg-muted/50 border border-border px-3 py-2 font-mono text-xs overflow-hidden">
            <span className="truncate flex-1">{settings.happIosRoutingUrl}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Пользователи открывают эту ссылку на iPhone — Happ применяет профиль автоматически.
          </p>
        </div>
      )}

      {/* Profile name */}
      <div className="space-y-1">
        <label className="text-xs font-mono text-muted-foreground uppercase tracking-wide">
          Название профиля
        </label>
        <Input
          value={profileName}
          onChange={(e) => setProfileName(e.target.value)}
          placeholder="VPNexus"
          className="rounded-none max-w-[240px]"
        />
        <p className="text-xs text-muted-foreground">Отображается в Happ при импорте.</p>
      </div>

      {/* Direct sites textarea */}
      <div className="space-y-1">
        <label className="text-xs font-mono text-muted-foreground uppercase tracking-wide">
          Сайты напрямую (по одному на строку)
        </label>
        <Textarea
          value={directSitesText}
          onChange={(e) => setDirectSitesText(e.target.value)}
          placeholder={"avito.ru\nsberbankl.ru\nregexp:\\.ru$"}
          rows={10}
          className="rounded-none font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          Просто доменное имя (без префикса) → будет добавлен <code>domain:</code>.
          Строки с двоеточием (например <code>regexp:\\.ru$</code>) принимаются как есть.
        </p>
      </div>

      {/* Direct IPs textarea */}
      <div className="space-y-1">
        <label className="text-xs font-mono text-muted-foreground uppercase tracking-wide">
          IP-диапазоны напрямую (CIDR, по одному на строку)
        </label>
        <Textarea
          value={directIpText}
          onChange={(e) => setDirectIpText(e.target.value)}
          placeholder={"10.0.0.0/8\n192.168.0.0/16"}
          rows={4}
          className="rounded-none font-mono text-xs"
        />
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={handleSave}
          disabled={isPending}
          className="bg-primary text-primary-foreground font-bold px-4 py-2 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {isPending ? "Сохраняем..." : "Сохранить профиль"}
        </button>
        <button
          onClick={handleReset}
          disabled={isPending}
          className="border border-border px-4 py-2 text-sm hover:bg-muted transition-colors disabled:opacity-50"
        >
          Сбросить до умолчаний
        </button>
      </div>
    </div>
  );
}

// ── App download links editor ─────────────────────────────────────────────────
// Admin configures the 4 recommended client app links shown in the keys page
// "Quick start" banners and iOS routing instructions. Saved via
// PATCH /admin/payment-settings. Separate Save/Reset from the main form.

const APP_LINK_LABELS: Record<string, string> = {
  happAndroid: "Happ — Android",
  happIos: "Happ — iOS (App Store)",
  v2rayng: "v2rayNG — Android",
  v2rayn: "v2rayN — Windows",
};

function AppDownloadLinksSection() {
  const { data: settings } = useGetPaymentSettings();
  const { mutate: update, isPending } = useUpdatePaymentSettings();
  const { toast } = useToast();

  const [links, setLinks] = useState({
    happAndroid: "",
    happIos: "",
    v2rayng: "",
    v2rayn: "",
  });
  const [initialized, setInitialized] = useState(false);

  if (settings && !initialized) {
    const l = settings.appDownloadLinks;
    setLinks({ happAndroid: l.happAndroid, happIos: l.happIos, v2rayng: l.v2rayng, v2rayn: l.v2rayn });
    setInitialized(true);
  }

  function handleSave() {
    update(
      { data: { appDownloadLinks: { happAndroid: links.happAndroid.trim(), happIos: links.happIos.trim(), v2rayng: links.v2rayng.trim(), v2rayn: links.v2rayn.trim() } } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetPaymentSettingsQueryKey() });
          toast({ title: "Ссылки на приложения сохранены" });
        },
        onError: () => toast({ title: "Ошибка сохранения ссылок", variant: "destructive" }),
      },
    );
  }

  function handleReset() {
    update(
      { data: { appDownloadLinks: null } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetPaymentSettingsQueryKey() });
          setInitialized(false);
          toast({ title: "Ссылки сброшены до встроенных значений" });
        },
        onError: () => toast({ title: "Ошибка сброса", variant: "destructive" }),
      },
    );
  }

  return (
    <div className="border border-border p-4 space-y-4 mt-2">
      <div>
        <p className="text-sm font-semibold">Ссылки на приложения</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Настройте ссылки на скачивание VPN-клиентов, которые показываются пользователям
          на странице ключей (баннер «Быстрый старт» и инструкции). Изменения применяются мгновенно.
        </p>
      </div>

      {(["happAndroid", "happIos", "v2rayng", "v2rayn"] as const).map((key) => (
        <div key={key} className="space-y-1">
          <label className="text-xs font-mono text-muted-foreground uppercase tracking-wide">
            {APP_LINK_LABELS[key]}
          </label>
          <div className="flex items-center gap-2">
            <Input
              value={links[key]}
              onChange={(e) => setLinks((prev) => ({ ...prev, [key]: e.target.value }))}
              placeholder="https://..."
              className="rounded-none font-mono text-xs"
            />
            {links[key] && (
              <a
                href={links[key]}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-xs text-muted-foreground hover:text-primary underline underline-offset-2 whitespace-nowrap"
              >
                Открыть
              </a>
            )}
          </div>
        </div>
      ))}

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={handleSave}
          disabled={isPending}
          className="bg-primary text-primary-foreground font-bold px-4 py-2 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {isPending ? "Сохраняем..." : "Сохранить ссылки"}
        </button>
        <button
          onClick={handleReset}
          disabled={isPending}
          className="border border-border px-4 py-2 text-sm hover:bg-muted transition-colors disabled:opacity-50"
        >
          Сбросить до умолчаний
        </button>
      </div>
    </div>
  );
}

interface AdminVpnKey {
  id: number;
  userId: number;
  nodeId: number;
  label: string;
  vlessLink: string;
  createdAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  xrayCleanupPendingAt: string | null;
  nodeName: string;
  userEmail: string;
  trafficUpBytes: number;
  trafficDownBytes: number;
  periodUpBytes: number;
  periodDownBytes: number;
  replacesKeyId: number | null;
  replacementPending: boolean;
}

