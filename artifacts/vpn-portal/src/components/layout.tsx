import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMe, useLogout } from "@workspace/api-client-react";
import { LogOut, Shield, Key, CreditCard, LayoutDashboard, Settings } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { data: me } = useGetMe();
  const isAdmin = me?.role === "admin";

  const logoutMutation = useLogout({
    mutation: {
      onSuccess: () => {
        queryClient.clear();
        navigate("/");
      },
    },
  });

  const navItems = [
    { href: "/dashboard", label: "Панель", icon: LayoutDashboard },
    { href: "/plans", label: "Тарифы", icon: Shield },
    { href: "/keys", label: "Ключи VPN", icon: Key },
    { href: "/payments", label: "Платежи", icon: CreditCard },
  ];

  if (isAdmin) {
    navItems.push({ href: "/admin", label: "Админ", icon: Settings });
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[#F4F4F5] font-sans overflow-x-hidden">
      {/* Sidebar */}
      <aside className="w-full md:w-64 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-6 border-b border-gray-200 flex items-center gap-3">
          <div className="w-8 h-8 bg-orange-600 flex items-center justify-center">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-lg tracking-tight">NEXUS</span>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => {
            const isActive = location === item.href || location.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-orange-50 text-orange-600 border-l-4 border-orange-600"
                    : "text-gray-600 hover:bg-gray-50 hover:text-gray-900 border-l-4 border-transparent"
                }`}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
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
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 min-w-0 p-4 md:p-8 overflow-y-auto overflow-x-hidden">
        <div className="max-w-5xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
