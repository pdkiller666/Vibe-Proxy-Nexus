import type { Payment } from "@workspace/db";

/**
 * Providers that represent money received from outside the app. Payments
 * funded from the user's wallet or granted by an administrator are not
 * commissionable referral revenue.
 */
export const REFERRAL_COMMISSION_PROVIDER_VALUES = [
  "manual_sbp",
  "yoomoney",
  "yookassa",
  "freekassa",
] as const;

const referralCommissionProviders = new Set<string>(
  REFERRAL_COMMISSION_PROVIDER_VALUES,
);

export function isReferralCommissionProvider(
  provider: Payment["provider"],
): boolean {
  return referralCommissionProviders.has(provider);
}

export function isReferralCommissionEligible(
  payment: Pick<Payment, "type" | "amountRub" | "provider">,
): boolean {
  return (
    payment.type === "subscription" &&
    payment.amountRub > 0 &&
    isReferralCommissionProvider(payment.provider)
  );
}
