import { useListPlans } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Shield, Lock, Zap } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function Home() {
  const { data: plans, isLoading } = useListPlans();

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      <header className="w-full bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-orange-600 flex items-center justify-center shrink-0">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-xl tracking-tight">NEXUS</span>
        </div>
        <div className="flex gap-4">
          <Link href="/sign-in" className="text-sm font-medium text-gray-600 hover:text-gray-900 px-4 py-2">
            Вход
          </Link>
          <Link href="/sign-up" className="text-sm font-bold bg-orange-600 text-white px-4 py-2 hover:bg-orange-700 transition-colors">
            Регистрация
          </Link>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center p-6 text-center max-w-4xl mx-auto w-full py-20">
        <h1 className="text-4xl md:text-6xl font-bold tracking-tighter text-gray-900 mb-6">
          Частный узел <span className="text-orange-600">безопасности</span>
        </h1>
        <p className="text-lg text-gray-600 font-mono mb-12 max-w-2xl">
          Это не массовый VPN-сервис. Это персональная инфраструктура для закрытого клуба. Никаких логов, никаких перегруженных серверов. Только чистый, надежный доступ.
        </p>

        <div className="grid md:grid-cols-3 gap-8 mb-20 w-full">
          <div className="bg-white p-6 border border-gray-200 text-left">
            <Lock className="w-8 h-8 text-orange-600 mb-4" />
            <h3 className="font-bold text-lg mb-2">VLESS + Reality</h3>
            <p className="text-gray-600 text-sm">Современные протоколы обхода блокировок. Трафик маскируется под обычный HTTPS.</p>
          </div>
          <div className="bg-white p-6 border border-gray-200 text-left">
            <Zap className="w-8 h-8 text-orange-600 mb-4" />
            <h3 className="font-bold text-lg mb-2">Высокая скорость</h3>
            <p className="text-gray-600 text-sm">Гарантированная пропускная способность за счет жесткого лимита пользователей на узел.</p>
          </div>
          <div className="bg-white p-6 border border-gray-200 text-left">
            <Shield className="w-8 h-8 text-orange-600 mb-4" />
            <h3 className="font-bold text-lg mb-2">Без компромиссов</h3>
            <p className="text-gray-600 text-sm">Полный контроль над инфраструктурой. Серверы настроены вручную для максимальной надежности.</p>
          </div>
        </div>

        <h2 className="text-2xl font-bold mb-8">Тарифные планы</h2>
        <div className="grid md:grid-cols-2 gap-6 w-full max-w-2xl mx-auto">
          {isLoading ? (
            <>
              <Skeleton className="h-48 w-full rounded-none" />
              <Skeleton className="h-48 w-full rounded-none" />
            </>
          ) : plans?.filter(p => p.isActive).map((plan) => (
            <div key={plan.id} className="bg-white p-6 border border-gray-200 text-left flex flex-col">
              <h3 className="font-bold text-xl mb-1">{plan.name}</h3>
              <div className="text-3xl font-bold mb-2">{plan.priceRub} ₽ <span className="text-sm font-normal text-gray-500">/ {plan.durationDays} дней</span></div>
              <p className="text-gray-600 text-sm mb-6 flex-1">{plan.description}</p>
              <Link href="/sign-up" className="block w-full text-center bg-gray-900 text-white font-medium py-3 hover:bg-orange-600 transition-colors">
                Выбрать
              </Link>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
