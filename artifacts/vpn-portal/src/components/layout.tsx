import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useLogout,
  useGetAdminDashboardSummary,
  getGetAdminDashboardSummaryQueryKey,
  useListMyNotifications,
  useAcknowledgeNotification,
  getListMyNotificationsQueryKey,
} from "@workspace/api-client-react";
import { LogOut, Shield, Key, CreditCard, LayoutDashboard, Settings, Menu, X, MessageCircle, UserCircle, AlertCircle, Bell } from "lucide-react";
import { ReferralFirstPaymentDialog } from "@/components/referral-offer";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { data: me } = useGetMe();
  const isAdmin = me?.role === "admin";
  const [mobileOpen, setMobileOpen] = useState(false);

  const { data: summary } = useGetAdminDashboardSummary({
    query: { queryKey: getGetAdminDashboardSummaryQueryKey(), enabled: isAdmin, refetchInterval: 60_000 },
  });
  const adminAlertCount = isAdmin
    ? (summary?.pendingPayments ?? 0) + (summary?.openTickets ?? 0)
    : 0;

  // User-facing notifications (payment rejections, confirmations, key migrations, etc.)
  const { data: notifications } = useListMyNotifications({
    query: { queryKey: getListMyNotificationsQueryKey(), enabled: !!me, refetchInterval: 60_000 },
  });
  const { mutate: acknowledgeNotification } = useAcknowledgeNotification({
    mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListMyNotificationsQueryKey() }) },
  });
  const unreadNotifications = notifications ?? [];
  const paymentBadgeCount = unreadNotifications.filter(
    (n) =>
      n.eventType === "payment_rejected" ||
      n.eventType === "payment_confirmed" ||
      n.eventType === "balance_low" ||
      n.eventType === "balance_exhausted"
  ).length;

  const logoutMutation = useLogout({
    mutation: {
      onSuccess: () => {
        queryClient.clear();
        navigate("/");
      },
    },
  });

  const navItems = [
    { href: "/dashboard", label: "Панель", icon: LayoutDashboard, badge: 0 },
    { href: "/plans", label: "Тарифы", icon: Shield, badge: 0 },
    { href: "/keys", label: "Ключи VPN", icon: Key, badge: 0 },
    { href: "/payments", label: "Платежи", icon: CreditCard, badge: paymentBadgeCount },
    { href: "/support", label: "Поддержка", icon: MessageCircle, badge: 0 },
    { href: "/profile", label: "Профиль", icon: UserCircle, badge: 0 },
  ];

  if (isAdmin) {
    navItems.push({ href: "/admin", label: "Админ", icon: Settings, badge: 0 });
  }

  const NavContent = () => (
    <>
      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => {
          const isActive = location === item.href || location.startsWith(`${item.href}/`);
          const navBadge = item.href === "/admin" ? adminAlertCount : (item.badge ?? 0);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-orange-50 text-orange-600 border-l-4 border-orange-600"
                  : "text-gray-600 hover:bg-gray-50 hover:text-gray-900 border-l-4 border-transparent"
              }`}
            >
              <item.icon className="w-4 h-4 shrink-0" />
              <span className="flex-1">{item.label}</span>
              {navBadge > 0 && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-orange-600 text-white text-[10px] font-bold leading-none">
                  {navBadge > 99 ? "99+" : navBadge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-gray-200">
        <div className="mb-4 px-4 text-xs font-mono text-gray-500 truncate">
          {me?.email}
        </div>
        <button
          onClick={() => logoutMutation.mutate()}
          disabled={logoutMutation.isPending}
          className="flex items-center gap-3 px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors w-full disabled:opacity-50"
        >
          <LogOut className="w-4 h-4" />
          Выход
        </button>
        <div className="mt-3 px-4 flex flex-wrap gap-x-3 gap-y-1">
          <a href="/terms" className="text-xs text-gray-400 hover:text-gray-600 transition-colors">Оферта</a>
          <a href="/privacy" className="text-xs text-gray-400 hover:text-gray-600 transition-colors">Конфиденциальность</a>
        </div>
      </div>
    </>
  );

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[#F4F4F5] font-sans overflow-x-hidden">
      {/* Mobile header */}
      <header className="md:hidden flex items-center justify-between bg-white border-b border-gray-200 px-4 py-3 sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-orange-600 flex items-center justify-center">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-lg tracking-tight">VPNexus</span>
        </div>
        <div className="flex items-center gap-2">
          {adminAlertCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[20px] h-[20px] px-1 rounded-full bg-orange-600 text-white text-[10px] font-bold">
              {adminAlertCount > 99 ? "99+" : adminAlertCount}
            </span>
          )}
          <button
            onClick={() => setMobileOpen((v) => !v)}
            className="p-2 text-gray-600 hover:text-gray-900 transition-colors"
            aria-label="Меню"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </header>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-20 bg-black/40"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={`md:hidden fixed top-0 left-0 h-full w-72 max-w-[85vw] bg-white z-40 flex flex-col shadow-xl transition-transform duration-300 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-6 border-b border-gray-200 flex items-center gap-3">
          <div className="w-8 h-8 bg-orange-600 flex items-center justify-center">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-lg tracking-tight">VPNexus</span>
        </div>
        <NavContent />
      </aside>

      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-64 bg-white border-r border-gray-200 flex-col">
        <div className="p-6 border-b border-gray-200 flex items-center gap-3">
          <div className="w-8 h-8 bg-orange-600 flex items-center justify-center">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-lg tracking-tight">VPNexus</span>
        </div>
        <NavContent />
      </aside>

      {/* Main Content */}
      <main className="flex-1 min-w-0 p-4 md:p-8 overflow-y-auto overflow-x-hidden">
        <div className="max-w-5xl mx-auto">
          <ReferralFirstPaymentDialog />
          {/* User notification banners (payment confirmed/rejected + key migrations).
              subscription_expired intentionally belongs to Dashboard, where it
              is matched to the current expired subscription and cannot conflict
              with the persistent access-state card. */}
          {unreadNotifications
            .filter((n) =>
              n.eventType === "payment_rejected" ||
              n.eventType === "payment_confirmed" ||
              n.eventType === "key_migrated" ||
              n.eventType === "admin_message"
            )
            .map((n) => {
              if (n.eventType === "admin_message") {
                const meta = n.metadata as { title?: string; message?: string };
                return (
                  <div
                    key={n.id}
                    className="mb-4 flex items-start gap-3 bg-blue-50 border border-blue-200 text-blue-900 px-4 py-3 text-sm"
                  >
                    <Bell className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" />
                    <div className="flex-1 min-w-0">
                      {meta.title && (
                        <span className="font-semibold">{meta.title}{meta.message ? " — " : ""}</span>
                      )}
                      {meta.message}
                    </div>
                    <button
                      onClick={() => acknowledgeNotification({ id: n.id })}
                      className="shrink-0 text-blue-400 hover:text-blue-600 transition-colors"
                      aria-label="Закрыть"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                );
              }

              if (n.eventType === "key_migrated") {
                const meta = n.metadata as { oldNodeName?: string; newNodeName?: string };
                return (
                  <div
                    key={n.id}
                    className="mb-4 flex items-start gap-3 bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 text-sm"
                  >
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-yellow-500" />
                    <div className="flex-1 min-w-0">
                      <span className="font-semibold">Автоматическая миграция VPN-ключа</span>
                      {" — "}
                      {"Ваш VPN-ключ был автоматически перемещён"}
                      {meta.oldNodeName ? ` с ${meta.oldNodeName}` : ""}
                      {meta.newNodeName ? ` на ${meta.newNodeName}` : ""}
                      {". Обновите конфигурацию подключения."}
                    </div>
                    <button
                      onClick={() => acknowledgeNotification({ id: n.id })}
                      className="shrink-0 text-yellow-400 hover:text-yellow-600 transition-colors"
                      aria-label="Закрыть"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                );
              }

              const meta = n.metadata as Record<string, unknown>;
              const isConfirmed = n.eventType === "payment_confirmed";
              const typeLabel =
                meta.type === "extra_device_slot" ? "доп. устройство" :
                meta.type === "balance_topup"     ? "пополнение баланса" :
                meta.type === "extra_traffic"     ? "доп. трафик" :
                                                    "подписка";
              return (
                <div
                  key={n.id}
                  className={`mb-4 flex items-start gap-3 px-4 py-3 text-sm border ${
                    isConfirmed
                      ? "bg-green-50 border-green-200 text-green-800"
                      : "bg-red-50 border-red-200 text-red-800"
                  }`}
                >
                  <AlertCircle className={`w-4 h-4 mt-0.5 shrink-0 ${isConfirmed ? "text-green-500" : "text-red-500"}`} />
                  <div className="flex-1 min-w-0">
                    <span className="font-semibold">
                      {isConfirmed ? "Платёж подтверждён" : "Платёж отклонён"}
                    </span>
                    {" — "}
                    {typeLabel}
                    {meta.amountRub ? ` · ${meta.amountRub} ₽` : ""}
                    {!isConfirmed && meta.reason
                      ? <span className="text-red-600"> · {String(meta.reason)}</span>
                      : null}
                  </div>
                  <button
                    onClick={() => acknowledgeNotification({ id: n.id })}
                    className={`shrink-0 transition-colors ${
                      isConfirmed
                        ? "text-green-400 hover:text-green-600"
                        : "text-red-400 hover:text-red-600"
                    }`}
                    aria-label="Закрыть"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          {children}
        </div>
      </main>
    </div>
  );
}
