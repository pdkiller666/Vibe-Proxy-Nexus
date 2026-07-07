import { useListPlans } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Shield, ArrowRight, Check, Zap, Eye, Lock, Globe, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

function useCountUp(target: number, duration = 1200) {
  const [count, setCount] = useState(0);
  const started = useRef(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          const start = performance.now();
          const tick = (now: number) => {
            const p = Math.min((now - start) / duration, 1);
            const ease = 1 - Math.pow(1 - p, 3);
            setCount(Math.round(ease * target));
            if (p < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [target, duration]);

  return { count, ref };
}

function StatCard({
  value,
  label,
  suffix = "",
}: {
  value: number;
  label: string;
  suffix?: string;
}) {
  const { count, ref } = useCountUp(value);
  return (
    <div ref={ref} className="text-center">
      <div className="text-4xl md:text-5xl font-black tracking-tighter text-gray-900">
        {count}
        {suffix}
      </div>
      <div className="text-xs text-gray-400 mt-1.5 font-semibold uppercase tracking-widest">
        {label}
      </div>
    </div>
  );
}

export default function Home() {
  const { data: plans } = useListPlans();
  const activePlans = plans?.filter((p: { isActive: boolean }) => p.isActive) ?? [];

  return (
    <div className="min-h-screen bg-white text-gray-900 font-sans overflow-x-hidden">
      <style>{`
        @keyframes fade-up {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50%       { transform: translateY(-8px); }
        }
        @keyframes shimmer {
          0%   { background-position: -200% center; }
          100% { background-position:  200% center; }
        }
        .animate-fade-up   { animation: fade-up .65s ease both; }
        .animate-fade-up-1 { animation: fade-up .65s .12s ease both; opacity:0; }
        .animate-fade-up-2 { animation: fade-up .65s .24s ease both; opacity:0; }
        .animate-fade-up-3 { animation: fade-up .65s .36s ease both; opacity:0; }
        .animate-float     { animation: float 5s ease-in-out infinite; }

        .gradient-text {
          background: linear-gradient(135deg, #ea580c 0%, #f97316 60%, #fb923c 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .shimmer-text {
          background: linear-gradient(90deg, #ea580c 0%, #c2410c 40%, #f97316 60%, #ea580c 100%);
          background-size: 200% auto;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          animation: shimmer 3s linear infinite;
        }

        .btn-orange {
          background: #ea580c;
          transition: background .2s, box-shadow .2s, transform .15s;
        }
        .btn-orange:hover {
          background: #c2410c;
          box-shadow: 0 8px 24px rgba(234,88,12,.35);
          transform: translateY(-1px);
        }
        .btn-outline {
          border: 1.5px solid #e5e7eb;
          transition: border-color .2s, background .2s, transform .15s;
        }
        .btn-outline:hover {
          border-color: #ea580c;
          background: #fff7ed;
          transform: translateY(-1px);
        }

        .feature-card {
          border: 1.5px solid #f3f4f6;
          transition: border-color .2s, box-shadow .2s, transform .2s;
        }
        .feature-card:hover {
          border-color: #fed7aa;
          box-shadow: 0 8px 32px rgba(234,88,12,.08);
          transform: translateY(-3px);
        }

        .plan-card {
          border: 1.5px solid #f3f4f6;
          transition: box-shadow .2s, transform .2s;
        }
        .plan-card:hover { box-shadow: 0 12px 40px rgba(0,0,0,.08); transform: translateY(-3px); }
        .plan-card-featured {
          border-color: #ea580c !important;
          box-shadow: 0 8px 32px rgba(234,88,12,.12);
        }

        .step-number {
          font-variant-numeric: tabular-nums;
          line-height: 1;
        }
        .divider-dot {
          width: 6px; height: 6px;
          background: #fed7aa;
          border-radius: 50%;
          flex-shrink: 0;
        }
      `}</style>

      {/* ─── HEADER ───────────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-50 bg-white/90 border-b border-gray-100 px-6 py-4
                   flex items-center justify-between"
        style={{ backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-orange-600 flex items-center justify-center">
            <Shield className="w-4.5 h-4.5 text-white" />
          </div>
          <span className="font-black text-xl tracking-tight">VPNexus</span>
        </div>

        <nav className="hidden md:flex items-center gap-8 text-sm text-gray-500">
          <a href="#benefits" className="hover:text-gray-900 transition-colors">Преимущества</a>
          <a href="#how"      className="hover:text-gray-900 transition-colors">Как работает</a>
          <a href="#plans"    className="hover:text-gray-900 transition-colors">Тарифы</a>
        </nav>

        <div className="flex items-center gap-3">
          <Link href="/sign-in" className="text-sm font-medium text-gray-500 hover:text-gray-900 transition-colors px-3 py-2">
            Войти
          </Link>
          <Link href="/sign-up" className="btn-orange text-sm font-bold text-white px-5 py-2.5 flex items-center gap-1.5">
            Начать бесплатно <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </header>

      {/* ─── HERO ─────────────────────────────────────────────────── */}
      <section className="relative pt-20 pb-28 px-6 flex flex-col items-center text-center overflow-hidden">
        {/* subtle warm background — full-width so no sharp side edges */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-0 right-0 h-[520px]
                          bg-gradient-to-b from-orange-50/70 to-transparent" />
          {/* decorative rings */}
          <div className="absolute top-16 left-1/2 -translate-x-1/2 w-[700px] h-[700px]
                          rounded-full border border-orange-100 opacity-50" />
          <div className="absolute top-24 left-1/2 -translate-x-1/2 w-[500px] h-[500px]
                          rounded-full border border-orange-100 opacity-30" />
        </div>

        {/* Badge */}
        <div className="animate-fade-up relative inline-flex items-center gap-2 bg-orange-50 border border-orange-200
                        rounded-full px-4 py-1.5 mb-8 text-xs font-semibold text-orange-700 tracking-wide uppercase">
          <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
          Закрытый VPN-сервис · Приватная инфраструктура
        </div>

        <h1 className="animate-fade-up-1 relative text-5xl md:text-7xl lg:text-[88px] font-black
                       tracking-tighter leading-[0.92] mb-6 max-w-4xl">
          Интернет<br />
          <span className="gradient-text">без слежки</span><br />
          и блокировок
        </h1>

        <p className="animate-fade-up-2 relative text-lg md:text-xl text-gray-500 max-w-xl mb-10 leading-relaxed font-light">
          Ваш трафик не видит никто — ни провайдер, ни государство.<br className="hidden md:block" />
          Не массовый VPN, а персональная защита.
        </p>

        <div className="animate-fade-up-3 relative flex flex-col sm:flex-row gap-3 items-center">
          <Link href="/sign-up"
            className="btn-orange font-bold text-white px-8 py-4 text-base
                       flex items-center gap-2 w-full sm:w-auto justify-center">
            Попробовать бесплатно
            <ArrowRight className="w-4 h-4" />
          </Link>
          <Link href="/sign-in"
            className="btn-outline text-gray-600 hover:text-gray-900 font-medium px-8 py-4
                       text-base flex items-center gap-2 w-full sm:w-auto justify-center bg-white">
            Войти в аккаунт
          </Link>
        </div>

        <p className="animate-fade-up-3 relative mt-5 text-xs text-gray-400">
          Бесплатный пробный период · Без привязки карты · Отмена в любой момент
        </p>

        {/* Floating icon */}
        <div className="animate-float relative mt-20">
          <div className="w-24 h-24 md:w-28 md:h-28 bg-white rounded-3xl
                          flex items-center justify-center mx-auto shadow-xl shadow-orange-100"
               style={{ border: "1.5px solid #fed7aa" }}>
            <Shield className="w-11 h-11 md:w-14 md:h-14 text-orange-600" />
          </div>
          <div className="absolute -top-2 -right-4 bg-green-50 border border-green-200
                          rounded-full px-3 py-1 text-xs font-bold text-green-700">
            ● Защищено
          </div>
        </div>
      </section>

      {/* ─── STATS ────────────────────────────────────────────────── */}
      <section className="border-y border-gray-100 bg-gray-50/50 py-14 px-6">
        <div className="max-w-4xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-10">
          <StatCard value={99} suffix="%" label="Uptime гарантия" />
          <StatCard value={0}            label="Логов о вас"      />
          <StatCard value={5}  suffix=" с" label="До первого ключа" />
          <StatCard value={24} suffix="/7" label="Поддержка"       />
        </div>
      </section>

      {/* ─── BENEFITS ─────────────────────────────────────────────── */}
      <section id="benefits" className="py-24 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <p className="text-orange-600 text-xs font-bold uppercase tracking-widest mb-3">Почему VPNexus</p>
            <h2 className="text-4xl md:text-5xl font-black tracking-tighter">
              Что вы получаете<br />
              <span className="gradient-text">с первого дня</span>
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-5">
            {[
              {
                icon: <Eye className="w-5 h-5 text-orange-600" />,
                title: "Вас никто не видит",
                desc: "Трафик шифруется и маскируется под HTTPS. Провайдер видит только зашифрованный поток — не сайты, не приложения, не вас.",
                tag: "Протокол VLESS + WebSocket",
              },
              {
                icon: <Zap className="w-5 h-5 text-orange-600" />,
                title: "Скорость не падает",
                desc: "Жёсткий лимит пользователей на каждый узел. Вы не делите канал с тысячами — ресурсы сервера работают именно для вас.",
                tag: "Без перегрузки узла",
              },
              {
                icon: <Lock className="w-5 h-5 text-orange-600" />,
                title: "Работает везде и всегда",
                desc: "Блокировки обходятся на уровне протокола — маскировка под легальный трафик крупных сервисов. DPI не справляется.",
                tag: "Не блокируется DPI",
              },
              {
                icon: <Globe className="w-5 h-5 text-orange-600" />,
                title: "Несколько устройств",
                desc: "Один аккаунт — несколько устройств одновременно. Телефон, ноутбук, планшет. Всё под защитой с одной подпиской.",
                tag: "iOS, Android, Windows, macOS",
              },
              {
                icon: <Shield className="w-5 h-5 text-orange-600" />,
                title: "Полный контроль",
                desc: "Личный кабинет: ваши ключи, статус подписки, история платежей. Полная прозрачность — никаких скрытых условий.",
                tag: "Личный кабинет 24/7",
              },
              {
                icon: <ArrowRight className="w-5 h-5 text-orange-600" />,
                title: "Минуты до старта",
                desc: "Зарегистрировались → получили ключ → подключились. Без сложных инструкций, без технических знаний. Три шага.",
                tag: "Настройка за 2 минуты",
              },
            ].map((b, i) => (
              <div key={i} className="feature-card bg-white p-6 space-y-3">
                <div className="w-9 h-9 rounded-lg bg-orange-50 border border-orange-100 flex items-center justify-center">
                  {b.icon}
                </div>
                <h3 className="font-bold text-base text-gray-900">{b.title}</h3>
                <p className="text-gray-500 text-sm leading-relaxed">{b.desc}</p>
                <div className="text-xs text-orange-600/70 font-mono pt-1 border-t border-gray-50">
                  {b.tag}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── HOW IT WORKS ─────────────────────────────────────────── */}
      <section id="how" className="py-24 px-6 bg-gray-50/60">
        <div className="max-w-2xl mx-auto text-center">
          <p className="text-orange-600 text-xs font-bold uppercase tracking-widest mb-3">Простой старт</p>
          <h2 className="text-4xl md:text-5xl font-black tracking-tighter mb-14">
            Три шага<br /><span className="gradient-text">до защиты</span>
          </h2>

          <div className="space-y-4 text-left">
            {[
              {
                n: "01",
                title: "Регистрируйтесь",
                desc: "Email и пароль — больше ничего. Пробный период стартует автоматически сразу после создания аккаунта.",
              },
              {
                n: "02",
                title: "Получите VPN-ключ",
                desc: "В личном кабинете нажмите «Добавить устройство». Ключ создаётся мгновенно — скопируйте ссылку или отсканируйте QR.",
              },
              {
                n: "03",
                title: "Подключитесь",
                desc: "Вставьте ключ в приложение v2rayNG, Happ или любой VLESS-клиент. Готово — ваш трафик защищён.",
              },
            ].map((step) => (
              <div key={step.n} className="bg-white border border-gray-100 p-6 flex gap-6 items-start
                                           shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all">
                <div className="step-number text-4xl font-black text-orange-200 w-12 shrink-0 font-mono select-none">
                  {step.n}
                </div>
                <div>
                  <h3 className="font-bold text-base text-gray-900 mb-1">{step.title}</h3>
                  <p className="text-gray-500 text-sm leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── PLANS ────────────────────────────────────────────────── */}
      <section id="plans" className="py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-14">
            <p className="text-orange-600 text-xs font-bold uppercase tracking-widest mb-3">Тарифы</p>
            <h2 className="text-4xl md:text-5xl font-black tracking-tighter">
              Честная цена<br />
              <span className="gradient-text">без сюрпризов</span>
            </h2>
            <p className="text-gray-400 mt-4 text-sm">Попробуйте бесплатно — оплата только если понравится</p>
          </div>

          {activePlans.length > 0 ? (
            <div
              className={`grid gap-5 ${
                activePlans.length === 1
                  ? "max-w-sm mx-auto"
                  : activePlans.length === 2
                  ? "md:grid-cols-2 max-w-2xl mx-auto"
                  : "md:grid-cols-3"
              }`}
            >
              {activePlans.map(
                (plan: { id: string; name: string; description?: string; priceRub: number; durationDays: number; devicesIncluded: number },
                  i: number) => {
                  const featured =
                    activePlans.length > 1 && i === Math.floor(activePlans.length / 2);
                  return (
                    <div
                      key={plan.id}
                      className={`plan-card bg-white relative p-7 flex flex-col ${
                        featured ? "plan-card-featured" : ""
                      }`}
                    >
                      {featured && (
                        <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-orange-600
                                        text-white text-[10px] font-bold px-4 py-1 uppercase tracking-widest whitespace-nowrap">
                          Популярный
                        </div>
                      )}
                      <div className="mb-5">
                        <h3 className="font-black text-xl mb-1 text-gray-900">{plan.name}</h3>
                        {plan.description && (
                          <p className="text-gray-400 text-sm">{plan.description}</p>
                        )}
                      </div>
                      <div className="mb-6 flex items-end gap-2">
                        <span className="text-5xl font-black text-gray-900">
                          {plan.priceRub.toLocaleString()}
                        </span>
                        <span className="text-gray-400 text-sm mb-1.5">
                          ₽&nbsp;/&nbsp;{plan.durationDays}&nbsp;дней
                        </span>
                      </div>
                      <ul className="space-y-2.5 mb-8 flex-1">
                        {[
                          `${plan.devicesIncluded} ${
                            plan.devicesIncluded === 1
                              ? "устройство"
                              : plan.devicesIncluded < 5
                              ? "устройства"
                              : "устройств"
                          }`,
                          "Без ограничения трафика",
                          "VPN-ключи в личном кабинете",
                          "Техподдержка",
                        ].map((feat) => (
                          <li key={feat} className="flex items-center gap-2.5 text-sm text-gray-600">
                            <Check className="w-4 h-4 text-orange-500 shrink-0" />
                            {feat}
                          </li>
                        ))}
                      </ul>
                      <Link
                        href="/sign-up"
                        className={`block text-center font-bold py-3.5 text-sm transition-all ${
                          featured
                            ? "btn-orange text-white"
                            : "bg-gray-900 text-white hover:bg-orange-600"
                        }`}
                      >
                        Выбрать тариф
                      </Link>
                    </div>
                  );
                }
              )}
            </div>
          ) : (
            <div className="text-center bg-gray-50 border border-gray-100 p-12 max-w-md mx-auto">
              <Shield className="w-10 h-10 text-orange-600 mx-auto mb-4" />
              <p className="text-gray-500 text-sm">Тарифы скоро появятся</p>
              <Link href="/sign-up"
                className="btn-orange inline-flex text-white font-bold px-6 py-3 mt-6 text-sm items-center gap-2">
                Зарегистрироваться <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          )}
        </div>
      </section>

      {/* ─── FINAL CTA ────────────────────────────────────────────── */}
      <section className="py-24 px-6 bg-gray-50/60">
        <div className="max-w-2xl mx-auto">
          <div className="bg-white border border-orange-100 p-12 md:p-16 text-center
                          shadow-xl shadow-orange-50">
            <div className="w-14 h-14 bg-orange-50 border border-orange-200
                            flex items-center justify-center mx-auto mb-6">
              <Shield className="w-7 h-7 text-orange-600" />
            </div>
            <h2 className="text-4xl md:text-5xl font-black tracking-tighter mb-4 text-gray-900">
              Начните прямо<br />
              <span className="gradient-text">сейчас</span>
            </h2>
            <p className="text-gray-400 mb-10 leading-relaxed text-sm max-w-md mx-auto">
              Бесплатный пробный период. Никакой привязки карты.<br />
              Если не понравится — просто не продлевайте.
            </p>
            <Link href="/sign-up"
              className="btn-orange inline-flex items-center gap-2.5 text-white font-bold px-10 py-4 text-base">
              Попробовать бесплатно
              <ArrowRight className="w-4 h-4" />
            </Link>
            <p className="mt-5 text-xs text-gray-400">
              Уже есть аккаунт?{" "}
              <Link href="/sign-in" className="text-orange-600 hover:text-orange-700 transition-colors font-medium">
                Войти →
              </Link>
            </p>
          </div>
        </div>
      </section>

      {/* ─── FOOTER ───────────────────────────────────────────────── */}
      <footer className="border-t border-gray-100 py-10 px-6">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 bg-orange-600 flex items-center justify-center shrink-0">
              <Shield className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="font-black text-sm tracking-tight">VPNexus</span>
          </div>
          <p className="text-gray-400 text-xs text-center">
            Приватная инфраструктура. Никаких логов. Никаких компромиссов.
          </p>
          <div className="flex gap-5 text-xs text-gray-400">
            <Link href="/sign-in" className="hover:text-gray-700 transition-colors">Вход</Link>
            <Link href="/sign-up" className="hover:text-gray-700 transition-colors">Регистрация</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
