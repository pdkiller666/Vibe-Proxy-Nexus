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

function StatCard({ value, label, suffix = "" }: { value: number; label: string; suffix?: string }) {
  const { count, ref } = useCountUp(value);
  return (
    <div ref={ref} className="text-center">
      <div className="text-4xl md:text-5xl font-black tracking-tighter text-white">
        {count}{suffix}
      </div>
      <div className="text-sm text-white/50 mt-1 font-medium uppercase tracking-widest">{label}</div>
    </div>
  );
}

export default function Home() {
  const { data: plans } = useListPlans();
  const activePlans = plans?.filter((p) => p.isActive) ?? [];

  return (
    <div className="min-h-screen bg-[#080810] text-white font-sans overflow-x-hidden">
      <style>{`
        @keyframes glow-pulse {
          0%, 100% { opacity: 0.5; transform: scale(1); }
          50% { opacity: 0.8; transform: scale(1.05); }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-12px); }
        }
        @keyframes gradient-x {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }
        @keyframes fade-up {
          from { opacity: 0; transform: translateY(24px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes beam {
          0% { transform: translateX(-100%) rotate(-45deg); }
          100% { transform: translateX(400%) rotate(-45deg); }
        }
        .animate-glow { animation: glow-pulse 4s ease-in-out infinite; }
        .animate-float { animation: float 6s ease-in-out infinite; }
        .animate-fade-up { animation: fade-up 0.7s ease forwards; }
        .animate-fade-up-delay { animation: fade-up 0.7s ease 0.15s forwards; opacity: 0; }
        .animate-fade-up-delay2 { animation: fade-up 0.7s ease 0.3s forwards; opacity: 0; }
        .gradient-text {
          background: linear-gradient(135deg, #ea580c 0%, #f97316 40%, #fb923c 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .glass {
          background: rgba(255,255,255,0.04);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(255,255,255,0.08);
        }
        .glass-hover {
          transition: all 0.3s ease;
        }
        .glass-hover:hover {
          background: rgba(255,255,255,0.07);
          border-color: rgba(234,88,12,0.4);
          transform: translateY(-2px);
        }
        .card-beam {
          position: relative;
          overflow: hidden;
        }
        .card-beam::after {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          background: linear-gradient(105deg, transparent 40%, rgba(234,88,12,0.08) 50%, transparent 60%);
          animation: beam 3s ease-in-out infinite;
        }
        .noise {
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
        }
        .btn-primary {
          background: linear-gradient(135deg, #ea580c, #c2410c);
          transition: all 0.2s ease;
          position: relative;
          overflow: hidden;
        }
        .btn-primary::before {
          content: '';
          position: absolute;
          top: 0; left: -100%;
          width: 100%; height: 100%;
          background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent);
          transition: left 0.4s ease;
        }
        .btn-primary:hover::before { left: 100%; }
        .btn-primary:hover { box-shadow: 0 0 32px rgba(234,88,12,0.5); transform: translateY(-1px); }
        .plan-card-featured {
          background: linear-gradient(135deg, rgba(234,88,12,0.15), rgba(194,65,12,0.08));
          border-color: rgba(234,88,12,0.5);
        }
        .scrollbar-hide::-webkit-scrollbar { display: none; }
      `}</style>

      {/* ─── HEADER ─────────────────────────────────────────── */}
      <header className="fixed top-0 left-0 right-0 z-50 px-6 py-4 flex items-center justify-between glass">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-orange-600 flex items-center justify-center shrink-0">
            <Shield className="w-4.5 h-4.5 text-white" />
          </div>
          <span className="font-black text-lg tracking-tight">VPNexus</span>
        </div>
        <nav className="hidden md:flex items-center gap-8 text-sm text-white/60">
          <a href="#benefits" className="hover:text-white transition-colors">Преимущества</a>
          <a href="#how" className="hover:text-white transition-colors">Как работает</a>
          <a href="#plans" className="hover:text-white transition-colors">Тарифы</a>
        </nav>
        <div className="flex items-center gap-3">
          <Link href="/sign-in" className="text-sm font-medium text-white/70 hover:text-white transition-colors px-3 py-2">
            Войти
          </Link>
          <Link href="/sign-up" className="btn-primary text-sm font-bold text-white px-5 py-2.5 flex items-center gap-1.5">
            Начать бесплатно <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </header>

      {/* ─── HERO ───────────────────────────────────────────── */}
      <section className="relative min-h-screen flex flex-col items-center justify-center px-6 pt-24 pb-20 text-center">
        {/* Background orbs */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="animate-glow absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-orange-600/10 blur-[120px]" />
          <div className="animate-glow absolute bottom-1/4 left-1/4 w-[400px] h-[400px] rounded-full bg-orange-500/6 blur-[100px]" style={{animationDelay:'2s'}} />
          <div className="animate-glow absolute top-1/2 right-1/4 w-[300px] h-[300px] rounded-full bg-amber-500/5 blur-[80px]" style={{animationDelay:'1s'}} />
          {/* Grid */}
          <div className="absolute inset-0 opacity-[0.04]" style={{backgroundImage:'linear-gradient(rgba(255,255,255,.1) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.1) 1px,transparent 1px)',backgroundSize:'60px 60px'}} />
        </div>

        {/* Pill badge */}
        <div className="animate-fade-up inline-flex items-center gap-2 glass rounded-full px-4 py-1.5 mb-8 text-xs font-semibold text-orange-400 tracking-wide uppercase">
          <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" />
          Закрытый VPN-сервис · Приватная инфраструктура
        </div>

        <h1 className="animate-fade-up-delay text-5xl md:text-7xl lg:text-8xl font-black tracking-tighter leading-[0.9] mb-6 max-w-4xl">
          Интернет<br />
          <span className="gradient-text">без слежки</span><br />
          и блокировок
        </h1>

        <p className="animate-fade-up-delay2 text-lg md:text-xl text-white/50 max-w-xl mb-12 leading-relaxed font-light">
          Ваш трафик не видит никто — ни провайдер, ни государство.<br className="hidden md:block" />
          Не массовый VPN, а персональная защита.
        </p>

        <div className="animate-fade-up-delay2 flex flex-col sm:flex-row gap-4 items-center">
          <Link href="/sign-up" className="btn-primary font-bold text-white px-8 py-4 text-base flex items-center gap-2 w-full sm:w-auto justify-center">
            Попробовать бесплатно
            <ArrowRight className="w-4 h-4" />
          </Link>
          <Link href="/sign-in" className="glass glass-hover text-white/70 hover:text-white font-medium px-8 py-4 text-base flex items-center gap-2 w-full sm:w-auto justify-center rounded-none">
            Войти в аккаунт
          </Link>
        </div>

        <p className="mt-5 text-xs text-white/25">
          Бесплатный пробный период · Без привязки карты · Отмена в любой момент
        </p>

        {/* Floating shield visual */}
        <div className="animate-float mt-20 relative">
          <div className="w-24 h-24 md:w-32 md:h-32 glass rounded-3xl flex items-center justify-center mx-auto" style={{border:'1px solid rgba(234,88,12,0.3)', boxShadow:'0 0 60px rgba(234,88,12,0.15)'}}>
            <Shield className="w-12 h-12 md:w-16 md:h-16 text-orange-500" />
          </div>
          <div className="absolute -top-2 -right-2 glass rounded-full px-3 py-1 text-xs font-bold text-green-400 border border-green-500/20">
            ● Защищено
          </div>
        </div>
      </section>

      {/* ─── STATS BAR ──────────────────────────────────────── */}
      <section className="border-y border-white/5 py-14 px-6">
        <div className="max-w-4xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-10">
          <StatCard value={99} suffix="%" label="Uptime гарантия" />
          <StatCard value={0} label="Логов о вас" />
          <StatCard value={5} suffix=" с" label="До первого ключа" />
          <StatCard value={24} suffix="/7" label="Поддержка" />
        </div>
      </section>

      {/* ─── BENEFITS ───────────────────────────────────────── */}
      <section id="benefits" className="py-24 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-orange-500 text-sm font-bold uppercase tracking-widest mb-3">Почему VPNexus</p>
            <h2 className="text-4xl md:text-5xl font-black tracking-tighter">
              Что вы получаете<br />
              <span className="gradient-text">с первого дня</span>
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-5">
            {[
              {
                icon: <Eye className="w-6 h-6 text-orange-500" />,
                title: "Вас никто не видит",
                desc: "Трафик шифруется и маскируется под обычный HTTPS. Провайдер видит только зашифрованный поток — не сайты, не приложения, не вас.",
                detail: "Протокол VLESS + WebSocket",
              },
              {
                icon: <Zap className="w-6 h-6 text-orange-500" />,
                title: "Скорость не падает",
                desc: "Жёсткий лимит пользователей на каждый узел. Вы не делите канал с тысячами людей — ресурсы сервера работают именно для вас.",
                detail: "Без перегрузки узла",
              },
              {
                icon: <Lock className="w-6 h-6 text-orange-500" />,
                title: "Работает везде и всегда",
                desc: "Блокировки обходятся на уровне протокола — не через слабые ухищрения, а за счёт маскировки под легальный трафик крупных сервисов.",
                detail: "Не блокируется DPI",
              },
              {
                icon: <Globe className="w-6 h-6 text-orange-500" />,
                title: "Несколько устройств",
                desc: "Один аккаунт — несколько устройств одновременно. Телефон, ноутбук, планшет. Всё под защитой с одной подпиской.",
                detail: "iOS, Android, Windows, macOS",
              },
              {
                icon: <Shield className="w-6 h-6 text-orange-500" />,
                title: "Полный контроль",
                desc: "Вы видите свои ключи, статус подписки и историю платежей в личном кабинете. Полная прозрачность — никаких скрытых условий.",
                detail: "Личный кабинет 24/7",
              },
              {
                icon: <ArrowRight className="w-6 h-6 text-orange-500" />,
                title: "Минуты до старта",
                desc: "Зарегистрировались → получили ключ → подключились. Без сложных инструкций, без технических знаний. Три шага и вы защищены.",
                detail: "Настройка за 2 минуты",
              },
            ].map((b, i) => (
              <div key={i} className="glass glass-hover card-beam p-6 space-y-3">
                <div className="w-10 h-10 rounded-xl bg-orange-600/15 flex items-center justify-center border border-orange-600/20">
                  {b.icon}
                </div>
                <h3 className="font-bold text-lg text-white">{b.title}</h3>
                <p className="text-white/50 text-sm leading-relaxed">{b.desc}</p>
                <div className="text-xs text-orange-500/70 font-mono pt-1">{b.detail}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── HOW IT WORKS ───────────────────────────────────── */}
      <section id="how" className="py-24 px-6 relative">
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full bg-orange-600/5 blur-[100px]" />
        </div>
        <div className="max-w-3xl mx-auto text-center relative">
          <p className="text-orange-500 text-sm font-bold uppercase tracking-widest mb-3">Простой старт</p>
          <h2 className="text-4xl md:text-5xl font-black tracking-tighter mb-16">
            Три шага<br /><span className="gradient-text">до защиты</span>
          </h2>

          <div className="space-y-5">
            {[
              { n: "01", title: "Регистрируйтесь", desc: "Создайте аккаунт за 30 секунд. Только email и пароль — больше ничего не нужно. Пробный период стартует сразу." },
              { n: "02", title: "Получите VPN-ключ", desc: "В личном кабинете нажмите «Добавить устройство». Ключ создаётся мгновенно — сканируйте QR или скопируйте ссылку." },
              { n: "03", title: "Подключитесь", desc: "Вставьте ключ в приложение Happ, v2rayNG или любой другой VLESS-клиент. Готово — ваш трафик защищён." },
            ].map((step) => (
              <div key={step.n} className="glass p-6 flex gap-6 items-start text-left">
                <div className="text-4xl font-black text-orange-600/30 leading-none w-12 shrink-0 font-mono">{step.n}</div>
                <div>
                  <h3 className="font-bold text-lg mb-1">{step.title}</h3>
                  <p className="text-white/50 text-sm leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── PLANS ──────────────────────────────────────────── */}
      <section id="plans" className="py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-orange-500 text-sm font-bold uppercase tracking-widest mb-3">Тарифы</p>
            <h2 className="text-4xl md:text-5xl font-black tracking-tighter">
              Честная цена<br />
              <span className="gradient-text">без сюрпризов</span>
            </h2>
            <p className="text-white/40 mt-4 text-sm">Попробуйте бесплатно — оплата только если понравится</p>
          </div>

          {activePlans.length > 0 ? (
            <div className={`grid gap-5 ${activePlans.length === 1 ? 'max-w-sm mx-auto' : activePlans.length === 2 ? 'md:grid-cols-2 max-w-2xl mx-auto' : 'md:grid-cols-3'}`}>
              {activePlans.map((plan, i) => {
                const featured = activePlans.length > 1 && i === Math.floor(activePlans.length / 2);
                return (
                  <div key={plan.id} className={`glass glass-hover relative p-7 flex flex-col ${featured ? 'plan-card-featured' : ''}`}>
                    {featured && (
                      <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-orange-600 text-white text-xs font-bold px-4 py-1 uppercase tracking-widest">
                        Популярный
                      </div>
                    )}
                    <div className="mb-6">
                      <h3 className="font-black text-xl mb-1">{plan.name}</h3>
                      {plan.description && (
                        <p className="text-white/40 text-sm">{plan.description}</p>
                      )}
                    </div>
                    <div className="mb-6">
                      <span className="text-5xl font-black text-white">{plan.priceRub.toLocaleString()}</span>
                      <span className="text-white/40 text-sm ml-2">₽ / {plan.durationDays} дней</span>
                    </div>
                    <ul className="space-y-2.5 mb-8 flex-1">
                      {[
                        `${plan.devicesIncluded} ${plan.devicesIncluded === 1 ? 'устройство' : plan.devicesIncluded < 5 ? 'устройства' : 'устройств'}`,
                        "Без ограничения трафика",
                        "VPN-ключи в личном кабинете",
                        "Техподдержка",
                      ].map((feat) => (
                        <li key={feat} className="flex items-center gap-2.5 text-sm text-white/70">
                          <Check className="w-4 h-4 text-orange-500 shrink-0" />
                          {feat}
                        </li>
                      ))}
                    </ul>
                    <Link
                      href="/sign-up"
                      className={`block text-center font-bold py-3.5 transition-all text-sm ${
                        featured
                          ? 'btn-primary text-white'
                          : 'border border-white/15 text-white/70 hover:border-orange-500/50 hover:text-white'
                      }`}
                    >
                      Выбрать тариф
                    </Link>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center glass p-12 max-w-md mx-auto">
              <Shield className="w-10 h-10 text-orange-600 mx-auto mb-4" />
              <p className="text-white/50 text-sm">Тарифы скоро появятся</p>
              <Link href="/sign-up" className="btn-primary inline-flex text-white font-bold px-6 py-3 mt-6 text-sm items-center gap-2">
                Зарегистрироваться <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          )}
        </div>
      </section>

      {/* ─── FINAL CTA ──────────────────────────────────────── */}
      <section className="py-24 px-6">
        <div className="max-w-2xl mx-auto text-center relative">
          <div className="absolute inset-0 -m-16 pointer-events-none">
            <div className="w-full h-full rounded-full bg-orange-600/8 blur-[80px] animate-glow" />
          </div>
          <div className="glass p-12 md:p-16 relative" style={{border:'1px solid rgba(234,88,12,0.2)', boxShadow:'0 0 80px rgba(234,88,12,0.08)'}}>
            <div className="w-14 h-14 bg-orange-600/15 border border-orange-600/30 rounded-2xl flex items-center justify-center mx-auto mb-6">
              <Shield className="w-7 h-7 text-orange-500" />
            </div>
            <h2 className="text-4xl md:text-5xl font-black tracking-tighter mb-4">
              Начните прямо<br /><span className="gradient-text">сейчас</span>
            </h2>
            <p className="text-white/40 mb-10 leading-relaxed text-sm">
              Бесплатный пробный период. Никакой привязки карты.<br />
              Если не понравится — просто не продлевайте.
            </p>
            <Link href="/sign-up" className="btn-primary inline-flex items-center gap-2.5 text-white font-bold px-10 py-4 text-base">
              Попробовать бесплатно
              <ArrowRight className="w-4 h-4" />
            </Link>
            <p className="mt-4 text-xs text-white/25">
              Уже есть аккаунт?{" "}
              <Link href="/sign-in" className="text-orange-500 hover:text-orange-400 transition-colors">
                Войти →
              </Link>
            </p>
          </div>
        </div>
      </section>

      {/* ─── FOOTER ─────────────────────────────────────────── */}
      <footer className="border-t border-white/5 py-10 px-6">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 bg-orange-600 flex items-center justify-center shrink-0">
              <Shield className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="font-black text-sm tracking-tight">VPNexus</span>
          </div>
          <p className="text-white/25 text-xs text-center">
            Приватная инфраструктура. Никаких логов. Никаких компромиссов.
          </p>
          <div className="flex gap-5 text-xs text-white/30">
            <Link href="/sign-in" className="hover:text-white/60 transition-colors">Вход</Link>
            <Link href="/sign-up" className="hover:text-white/60 transition-colors">Регистрация</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
