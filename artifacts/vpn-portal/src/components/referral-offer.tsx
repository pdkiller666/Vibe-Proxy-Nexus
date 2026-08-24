import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  getListMyNotificationsQueryKey,
  useAcknowledgeNotification,
  useGetMe,
  useListMyNotifications,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Copy, Gift, Share2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { ReferralQrDialog } from "@/components/referral-qr-dialog";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function referralLinkFor(host: string, code: string) {
  return `https://${host}${basePath}/sign-up?ref=${code}`;
}

function referralDetails(me: {
  referralCode?: string;
  referralLinkHost?: string;
  referralCommissionPercent?: number;
} | undefined) {
  const commission = me?.referralCommissionPercent ?? 0;
  if (!me?.referralCode || !me.referralLinkHost || commission <= 0) return null;

  return {
    commission,
    refsNeeded: Math.ceil(100 / commission),
    link: referralLinkFor(me.referralLinkHost, me.referralCode),
  };
}

async function copyReferralLink(link: string) {
  if (!navigator.clipboard) throw new Error("Clipboard unavailable");
  await navigator.clipboard.writeText(link);
}

export function ReferralOfferCard({
  compact = false,
  onDismiss,
}: {
  compact?: boolean;
  onDismiss?: () => void;
}) {
  const { data: me } = useGetMe();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const details = referralDetails(me);

  if (!details) return null;
  const { commission, link } = details;

  async function handleCopy() {
    try {
      await copyReferralLink(link);
      setCopied(true);
      toast({ title: "Реферальная ссылка скопирована" });
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      toast({ title: "Не удалось скопировать ссылку", variant: "destructive" });
    }
  }

  async function handleShare() {
    const text = `Присоединяйся к VPNexus по моей ссылке. Я получаю ${commission}% с каждой твоей оплаты на баланс — это помогает оплачивать подписку.`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "VPNexus", text, url: link });
        return;
      }
      await copyReferralLink(link);
      setCopied(true);
      toast({ title: "Ссылка скопирована — отправьте её другу" });
      window.setTimeout(() => setCopied(false), 2_000);
    } catch (error) {
      // Closing the native share sheet is not an error the user needs to see.
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast({ title: "Не удалось поделиться ссылкой", variant: "destructive" });
    }
  }

  if (compact) {
    return (
      <div className="mt-3 border-t border-current/20 pt-3 space-y-3">
        <div className="flex items-start gap-2">
          <Gift className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="text-sm">
            Пригласите друзей: <strong>{details.commission}%</strong> с каждой их оплаты поступает на внутренний
            баланс и автоматически идёт в счёт вашей подписки. Примерно {details.refsNeeded} оплативших друзей —
            и подписка окупается.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 border border-current/30 px-3 py-2 text-xs font-bold hover:bg-white/40 transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? "Скопировано" : "Скопировать ссылку"}
          </button>
          <button
            type="button"
            onClick={handleShare}
            className="inline-flex items-center gap-1.5 border border-current/30 px-3 py-2 text-xs font-bold hover:bg-white/40 transition-colors"
          >
            <Share2 className="w-3.5 h-3.5" />
            Поделиться
          </button>
          <ReferralQrDialog
            value={link}
            title="QR-код реферальной ссылки"
            description="Отсканируйте код камерой — он откроет регистрацию по вашей реферальной ссылке."
            buttonLabel="QR-код"
          />
        </div>
      </div>
    );
  }

  return (
    <section className="relative overflow-hidden border border-orange-300 bg-gradient-to-br from-orange-50 via-amber-50 to-white p-5 text-foreground shadow-sm">
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="absolute right-3 top-3 p-1 text-orange-400 hover:text-orange-700 transition-colors"
          aria-label="Закрыть предложение"
        >
          <X className="w-4 h-4" />
        </button>
      )}
      <div className="flex items-start gap-3 pr-6">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center bg-orange-500 text-white">
          <Gift className="w-5 h-5" />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-bold uppercase tracking-widest text-orange-600">Делитесь выгодой</p>
          <h2 className="text-xl font-black tracking-tight">Приглашайте друзей — пользуйтесь бесплатно</h2>
        </div>
      </div>

      <div className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
        <p>
          Получайте <strong className="text-foreground">{details.commission}%</strong> от каждой оплаты приглашённого
          пользователя на внутренний баланс.
        </p>
        <p>Баланс автоматически идёт в счёт подписки — никакого вывода не нужно.</p>
        <p className="font-medium text-foreground">
          Пригласите примерно {details.refsNeeded} человек — и подписка окупается сама.
        </p>
      </div>

      <div className="mt-4 flex items-center gap-2 bg-white/70 border border-orange-200 px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs select-all">{details.link}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 bg-orange-500 px-4 py-2.5 text-sm font-bold text-white hover:bg-orange-600 transition-colors"
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          {copied ? "Скопировано" : "Скопировать ссылку"}
        </button>
        <button
          type="button"
          onClick={handleShare}
          className="inline-flex items-center gap-1.5 border border-orange-300 px-4 py-2.5 text-sm font-bold text-orange-800 hover:bg-orange-100 transition-colors"
        >
          <Share2 className="w-4 h-4" />
          Поделиться
        </button>
        <ReferralQrDialog
          value={details.link}
          title="QR-код реферальной ссылки"
          description="Отсканируйте код камерой — он откроет регистрацию по вашей реферальной ссылке."
          buttonLabel="QR-код"
        />
        <Link
          href="/dashboard?referrals=1"
          className="inline-flex items-center gap-1 text-sm font-semibold text-orange-700 hover:text-orange-900"
        >
          Подробнее в кабинете <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    </section>
  );
}

function paymentIdFromMetadata(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object" || !("paymentId" in metadata)) return null;
  const value = Number((metadata as { paymentId?: unknown }).paymentId);
  return Number.isInteger(value) ? value : null;
}

/**
 * Displays one dismissible referral card for a particular successful payment.
 * The dedicated referral_payment_offer event is acknowledged when claimed, so
 * a refresh or another device does not repeat the same offer while preserving
 * the normal payment_confirmed notification.
 */
export function ReferralPaymentOffer({ paymentId }: { paymentId: number }) {
  const { data: me } = useGetMe();
  const { data: notifications } = useListMyNotifications();
  const queryClient = useQueryClient();
  const { mutate: acknowledge } = useAcknowledgeNotification({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListMyNotificationsQueryKey() }),
    },
  });
  const [dismissed, setDismissed] = useState(false);
  const [shownEventId, setShownEventId] = useState<number | null>(null);
  const acknowledgedEventId = useRef<number | null>(null);

  useEffect(() => {
    setDismissed(false);
    setShownEventId(null);
    acknowledgedEventId.current = null;
  }, [paymentId]);

  const event = (notifications ?? []).find(
    (notification) =>
      notification.eventType === "referral_payment_offer" &&
      paymentIdFromMetadata(notification.metadata) === paymentId,
  );
  const offerAvailable = Boolean(referralDetails(me));

  useEffect(() => {
    // Keep the normal “payment confirmed” notification intact when referrals
    // are disabled. Also wait for /me before claiming, so an initial loading
    // race never consumes an offer that cannot yet be rendered.
    if (!event || !offerAvailable || acknowledgedEventId.current === event.id) return;
    acknowledgedEventId.current = event.id;
    // Acknowledgement is an atomic server-side claim: only the device whose
    // request changes acknowledgedAt from NULL may display this offer.
    acknowledge(
      { id: event.id },
      {
        onSuccess: () => {
          // Keep the card local after claiming it. The notification itself is
          // removed from the shared cache, preventing future reload repeats.
          setShownEventId(event.id);
        },
      },
    );
  }, [acknowledge, event, offerAvailable]);

  if (!offerAvailable || dismissed || !shownEventId) return null;

  return (
    <ReferralOfferCard
      onDismiss={() => {
        setDismissed(true);
      }}
    />
  );
}

/**
 * The server creates this event once for the user's first eligible successful
 * payment. It is acknowledged as soon as the dialog opens, not on page close,
 * so it cannot reopen after a reload or from a second device.
 */
export function ReferralFirstPaymentDialog() {
  const { data: me } = useGetMe();
  const { data: notifications } = useListMyNotifications();
  const queryClient = useQueryClient();
  const { mutate: acknowledge } = useAcknowledgeNotification({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListMyNotificationsQueryKey() }),
    },
  });
  const [open, setOpen] = useState(false);
  const handledEventId = useRef<number | null>(null);
  const firstPaymentEvent = (notifications ?? []).find(
    (notification) => notification.eventType === "referral_first_payment_offer",
  );

  useEffect(() => {
    // Wait until the loaded profile can render the offer. The notification
    // query can resolve first, or /me can still contain a cached zero
    // commission after an admin has enabled referrals. Claiming before the
    // card is renderable would make the one-time modal disappear forever.
    if (!firstPaymentEvent || !referralDetails(me) || handledEventId.current === firstPaymentEvent.id) return;
    handledEventId.current = firstPaymentEvent.id;
    // The successful acknowledgment is a server-side, cross-device claim.
    // Do not open the modal until this request wins.
    acknowledge(
      { id: firstPaymentEvent.id },
      {
        onSuccess: () => {
          setOpen(true);
        },
      },
    );
  }, [acknowledge, firstPaymentEvent, me]);

  if (!referralDetails(me)) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-xl overflow-y-auto rounded-none p-4 sm:rounded-lg sm:p-6">
        <DialogHeader className="pr-8">
          <DialogTitle>Ваша подписка активна — поделитесь выгодой</DialogTitle>
          <DialogDescription>
            Это предложение показывается один раз после первой успешной оплаты.
          </DialogDescription>
        </DialogHeader>
        <ReferralOfferCard />
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="self-start text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          Не сейчас
        </button>
      </DialogContent>
    </Dialog>
  );
}