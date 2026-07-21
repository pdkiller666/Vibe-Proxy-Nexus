import { useListPlans } from "@workspace/api-client-react";
import { Link } from "wouter";
import {
  Shield, ArrowRight, Check, Zap, Eye, Lock,
  ChevronRight, Star,
} from "lucide-react";
import { useEffect, useRef, useState, useCallback } from "react";

/* ─── helpers ─────────────────────────────────────────────────────────── */

function formatKopecks(kopecks: number): string {
  return `${(kopecks / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ₽`;
}

/* ─── Testimonials carousel ───────────────────────────────────────────── */

const TESTIMONIALS = [
  {
    text: "Работаю удалённо из разных мест. Пробовал несколько VPN — этот единственный, который не отваливается в середине рабочего дня. Уже полгода стабильно.",
    name: "Алексей",
    meta: "Фрилансер",
    rating: 5,
  },
  {
    text: "Нужен был чтобы открыть Instagram. Зарегистрировалась, за пять минут настроила по инструкции — всё работает. Скорость не отличить от прямого подключения.",
    name: "Мария",
    meta: "Дизайнер",
    rating: 5,
  },
  {
    text: "Скептически смотрел на пробный период — ожидал искусственных ограничений. Нет, работало честно. Потом оплатил без вопросов.",
    name: "Дмитрий К.",
    meta: "IT-специалист",
    rating: 5,
  },
  {
    text: "Не хотела регистрироваться непонятно где. Тут только email и пароль, никаких лишних данных. Пользуюсь три месяца — всё как обещали.",
    name: "Анна",
    meta: "Преподаватель",
    rating: 4,
  },
];

function StarRating({ n }: { n: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={`w-4 h-4 ${i <= n ? "text-orange-500 fill-orange-500" : "text-gray-200 fill-gray-200"}`}
        />
      ))}
    </div>
  );
}

function TestimonialsCarousel() {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const touchStartX = useRef<number | null>(null);

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  // Timer set up ONCE
  useEffect(() => {
    const timer = setInterval(() => {
      if (!pausedRef.current) {
        setIdx((prev) => (prev + 1) % TESTIMONIALS.length);
      }
    }, 4500);
    return () => clearInterval(timer);
  }, []);

  const goTo = (next: number) => {
    setIdx((next + TESTIMONIALS.length) % TESTIMONIALS.length);
    setPaused(true);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    setPaused(true);
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const diff = touchStartX.current - e.changedTouches[0].clientX;
    touchStartX.current = null;
    if (Math.abs(diff) < 50) {
      // Short tap — just keep paused, resume on next auto-tick via ref
      setPaused(false);
      return;
    }
    // Swipe left → next, swipe right → prev
    setIdx((prev) => {
      const next = diff > 0 ? prev + 1 : prev - 1;
      return (next + TESTIMONIALS.length) % TESTIMONIALS.length;
    });
    setPaused(false);
  };

  return (
    <div
      className="relative select-none"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Card — key forces re-mount so CSS animation triggers on each change */}
      <div className="bg-white border border-gray-100 shadow-sm shadow-orange-50 p-8 md:p-10 min-h-[200px] flex flex-col justify-between">
        <div key={idx} className="testimonial-enter">
          <p className="text-gray-700 text-base leading-relaxed mb-6">
            «{TESTIMONIALS[idx].text}»
          </p>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-bold text-sm text-gray-900">{TESTIMONIALS[idx].name}</p>
              <p className="text-xs text-gray-400 mt-0.5">{TESTIMONIALS[idx].meta}</p>
            </div>
            <StarRating n={TESTIMONIALS[idx].rating} />
          </div>
        </div>
      </div>

      {/* Dots only */}
      <div className="flex justify-center gap-1.5 mt-4">
        {TESTIMONIALS.map((_, i) => (
          <button
            key={i}
            onClick={() => goTo(i)}
            className={`h-1.5 rounded-full transition-all duration-300 ${
              i === idx ? "w-6 bg-orange-500" : "w-1.5 bg-gray-200"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

/* ─── FAQ item ────────────────────────────────────────────────────────── */

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-100 last:border-0">
      <button
        className="w-full flex items-center justify-between px-6 py-4 text-left gap-4 hover:text-orange-600 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="font-medium text-sm text-gray-800">{q}</span>
        <span className={`text-gray-400 transition-transform duration-200 shrink-0 ${open ? "rotate-180" : ""}`}>▼</span>
      </button>
      {open && <p className="text-sm text-gray-500 px-6 pb-5 leading-relaxed">{a}</p>}
    </div>
  );
}

/* ─── App ticker ──────────────────────────────────────────────────────── */

const TICKER_ITEMS = [
  "v2rayNG", "Happ", "Nekobox", "Clash Meta",
  "Shadowrocket", "NekoRay", "Sing-box", "Streisand",
];

function AppTicker() {
  const [hovered, setHovered] = useState(false);
  const doubled = [...TICKER_ITEMS, ...TICKER_ITEMS];

  return (
    <div
      className="overflow-hidden py-5 border-y border-gray-100 bg-gray-50/40"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className="flex gap-10 whitespace-nowrap"
        style={{
          animation: "ticker 18s linear infinite",
          animationPlayState: hovered ? "paused" : "running",
          width: "max-content",
        }}
      >
        {doubled.map((name, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-2 text-sm text-gray-400 font-medium px-4"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-orange-300 shrink-0" />
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ─── Benefits carousel (mobile) / grid (desktop) ────────────────────── */

const BENEFITS = [
  {
    icon: <Eye className="w-5 h-5 text-orange-600" />,
    title: "Вас никто не видит",
    desc: "Трафик шифруется и маскируется под HTTPS. Провайдер видит только зашифрованный поток — не сайты, не приложения, не вас.",
    tag: "Фирменная маскировка VPNexus",
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
];

function BenefitsSection() {
  const [activeIdx, setActiveIdx] = useState(0);
  const pausedRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  // Prevents onScroll feedback during programmatic scrollTo
  const scrollingRef = useRef(false);

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  // Programmatic scroll helper — uses offsetLeft for exact position (accounts for gaps)
  const scrollToIdx = useCallback((i: number) => {
    const track = trackRef.current;
    if (!track) return;
    const card = track.children[i] as HTMLElement | undefined;
    if (!card) return;
    scrollingRef.current = true;
    track.scrollTo({ left: card.offsetLeft, behavior: "smooth" });
    // Clear the lock after the smooth scroll animation finishes (~600 ms)
    setTimeout(() => { scrollingRef.current = false; }, 650);
  }, []);

  // Timer set up ONCE; advances slide & scrolls together
  useEffect(() => {
    const timer = setInterval(() => {
      if (pausedRef.current) return;
      setActiveIdx((prev) => {
        const next = (prev + 1) % BENEFITS.length;
        scrollToIdx(next);
        return next;
      });
    }, 3800);
    return () => clearInterval(timer);
  }, [scrollToIdx]);

  // Detect manual swipe — ignored while programmatic scroll is in flight
  const onScroll = useCallback(() => {
    if (scrollingRef.current) return;
    const track = trackRef.current;
    if (!track) return;
    // Find which card's offsetLeft is closest to current scrollLeft
    let closest = 0;
    let minDist = Infinity;
    for (let i = 0; i < track.children.length; i++) {
      const dist = Math.abs((track.children[i] as HTMLElement).offsetLeft - track.scrollLeft);
      if (dist < minDist) { minDist = dist; closest = i; }
    }
    if (closest !== activeIdx) {
      setActiveIdx(closest);
      setPaused(true);
    }
  }, [activeIdx]);

  return (
    <section id="benefits" className="py-20 px-6">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-12">
          <p className="text-orange-600 text-xs font-bold uppercase tracking-widest mb-3">Почему VPNexus</p>
          <h2 className="text-4xl md:text-5xl font-black tracking-tighter">
            Что вы получаете<br />
            <span className="gradient-text">с первого дня</span>
          </h2>
        </div>

        {/* Desktop grid */}
        <div className="hidden md:grid md:grid-cols-3 gap-5">
          {BENEFITS.map((b, i) => (
            <div key={i} className="feature-card bg-white p-6 space-y-3">
              <div className="w-9 h-9 rounded-lg bg-orange-50 border border-orange-100 flex items-center justify-center">
                {b.icon}
              </div>
              <h3 className="font-bold text-base text-gray-900">{b.title}</h3>
              <p className="text-gray-500 text-sm leading-relaxed">{b.desc}</p>
              <div className="text-xs text-orange-600/70 font-mono pt-1 border-t border-gray-50">{b.tag}</div>
            </div>
          ))}
        </div>

        {/* Mobile carousel */}
        <div className="md:hidden">
          <div
            ref={trackRef}
            className="flex overflow-x-auto gap-4 snap-x snap-mandatory scrollbar-hide pb-2"
            style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
            onScroll={onScroll}
            onTouchStart={() => setPaused(true)}
          >
            {BENEFITS.map((b, i) => (
              <div
                key={i}
                className="feature-card bg-white p-6 space-y-3 snap-start shrink-0"
                style={{ width: "calc(100vw - 3rem)" }}
              >
                <div className="w-9 h-9 rounded-lg bg-orange-50 border border-orange-100 flex items-center justify-center">
                  {b.icon}
                </div>
                <h3 className="font-bold text-base text-gray-900">{b.title}</h3>
                <p className="text-gray-500 text-sm leading-relaxed">{b.desc}</p>
                <div className="text-xs text-orange-600/70 font-mono pt-1 border-t border-gray-50">{b.tag}</div>
              </div>
            ))}
          </div>
          {/* Dots */}
          <div className="flex justify-center gap-1.5 mt-4">
            {BENEFITS.map((_, i) => (
              <button
                key={i}
                onClick={() => { setActiveIdx(i); setPaused(true); scrollToIdx(i); }}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === activeIdx ? "w-6 bg-orange-500" : "w-1.5 bg-gray-200"
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─── Plan skeleton ───────────────────────────────────────────────────── */

function PlanSkeleton() {
  return (
    <div className="grid md:grid-cols-3 gap-5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="border border-gray-100 bg-gray-50 p-7 animate-pulse space-y-4">
          <div className="h-5 w-1/2 bg-gray-200 rounded" />
          <div className="h-10 w-2/3 bg-gray-200 rounded" />
          <div className="space-y-2.5 pt-2">
            {[0, 1, 2, 3].map((j) => (
              <div key={j} className="h-3.5 bg-gray-200 rounded w-full" />
            ))}
          </div>
          <div className="h-10 bg-gray-200 rounded mt-4" />
        </div>
      ))}
    </div>
  );
}

/* ─── Main page ───────────────────────────────────────────────────────── */

export default function Home() {
  const { data: plans, isLoading: plansLoading } = useListPlans();
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
        @keyframes ticker {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
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

        .scrollbar-hide::-webkit-scrollbar { display: none; }

        @keyframes testimonial-enter {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .testimonial-enter { animation: testimonial-enter 0.3s ease both; }
      `}</style>

      {/* ─── HEADER ─────────────────────────────────────────────── */}
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
          <a href="#how"      className="hover:text-gray-900 transition-colors">Как работает</a>
          <a href="#benefits" className="hover:text-gray-900 transition-colors">Преимущества</a>
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

      {/* ─── HERO ───────────────────────────────────────────────── */}
      <section className="relative pt-20 pb-20 px-6 flex flex-col items-center text-center overflow-hidden">
        {/* background */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-0 right-0 h-[520px]
                          bg-gradient-to-b from-orange-50/70 to-transparent" />
          <div className="absolute top-16 left-1/2 -translate-x-1/2 w-[700px] h-[700px]
                          rounded-full border border-orange-100 opacity-50" />
          <div className="absolute top-24 left-1/2 -translate-x-1/2 w-[500px] h-[500px]
                          rounded-full border border-orange-100 opacity-30" />
        </div>

        {/* Badge */}
        <div className="animate-fade-up relative inline-flex items-center gap-2 bg-orange-50 border border-orange-200
                        rounded-full px-4 py-1.5 mb-8 text-xs font-semibold text-orange-700 tracking-wide uppercase">
          <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
          Персональный VPN · Приватная инфраструктура
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

        {/* Inline stats */}
        <div className="animate-fade-up-3 relative mt-14 grid grid-cols-2 md:grid-cols-4 gap-x-10 gap-y-6">
          {[
            { val: "∞", label: "интернет без границ" },
            { val: "0 ₽",  label: "Попробовать" },
            { val: "5 с",  label: "До первого ключа" },
            { val: "24/7", label: "Поддержка" },
          ].map(({ val, label }) => (
            <div key={label} className="text-center">
              <div className="text-3xl md:text-4xl font-black tracking-tighter text-gray-900">{val}</div>
              <div className="text-[10px] text-gray-400 mt-1 font-semibold uppercase tracking-widest">{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ─── HOW IT WORKS ───────────────────────────────────────── */}
      <section id="how" className="py-20 px-6 bg-gray-50/60">
        <div className="max-w-2xl mx-auto text-center">
          <p className="text-orange-600 text-xs font-bold uppercase tracking-widest mb-3">Простой старт</p>
          <h2 className="text-4xl md:text-5xl font-black tracking-tighter mb-12">
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
                <div className="text-4xl font-black text-orange-200 w-12 shrink-0 font-mono select-none leading-none pt-0.5">
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

      {/* ─── APP TICKER ─────────────────────────────────────────── */}
      <div className="relative">
        <div className="absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-white to-transparent z-10 pointer-events-none" />
        <div className="absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-white to-transparent z-10 pointer-events-none" />
        <div className="py-2 px-2 text-center">
          <p className="text-[10px] text-gray-300 uppercase tracking-widest font-semibold mb-1">
            Работает с любым VLESS-клиентом
          </p>
        </div>
        <AppTicker />
      </div>

      {/* ─── BENEFITS ───────────────────────────────────────────── */}
      <BenefitsSection />

      {/* ─── PLANS ──────────────────────────────────────────────── */}
      <section id="plans" className="py-20 px-6 bg-gray-50/60">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <p className="text-orange-600 text-xs font-bold uppercase tracking-widest mb-3">Тарифы</p>
            <h2 className="text-4xl md:text-5xl font-black tracking-tighter">
              Честная цена<br />
              <span className="gradient-text">без сюрпризов</span>
            </h2>
            <p className="text-gray-400 mt-4 text-sm">Попробуйте бесплатно — оплата только если понравится</p>
          </div>

          {plansLoading ? (
            <PlanSkeleton />
          ) : activePlans.length > 0 ? (
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
                (
                  plan: {
                    id: number;
                    name: string;
                    description?: string | null;
                    priceRub: number;
                    durationDays: number;
                    devicesIncluded: number;
                    billingType?: string;
                    hourlyRateKopecks?: number | null;
                  },
                  i: number,
                ) => {
                  const featured = activePlans.length > 1 && i === Math.floor(activePlans.length / 2);
                  const isHourly = plan.billingType === "hourly";
                  return (
                    <div
                      key={plan.id}
                      className={`plan-card bg-white relative p-7 flex flex-col ${featured ? "plan-card-featured" : ""}`}
                    >
                      {featured && (
                        <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-orange-600
                                        text-white text-[10px] font-bold px-4 py-1 uppercase tracking-widest whitespace-nowrap">
                          Популярный
                        </div>
                      )}
                      <div className="mb-5">
                        <div className="flex items-center gap-2">
                          <h3 className="font-black text-xl mb-1 text-gray-900">{plan.name}</h3>
                          {isHourly && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 mb-1 rounded-full bg-orange-100 text-orange-700">
                              <Zap className="w-3 h-3" /> Почасовой
                            </span>
                          )}
                        </div>
                        {plan.description && <p className="text-gray-400 text-sm">{plan.description}</p>}
                      </div>

                      {isHourly ? (
                        <div className="mb-6 flex items-end gap-2">
                          <span className="text-5xl font-black text-gray-900">
                            {formatKopecks(plan.hourlyRateKopecks ?? 0)}
                          </span>
                          <span className="text-gray-400 text-sm mb-1.5">за час</span>
                        </div>
                      ) : (
                        <div className="mb-6 flex items-end gap-2">
                          <span className="text-5xl font-black text-gray-900">
                            {plan.priceRub.toLocaleString()}
                          </span>
                          <span className="text-gray-400 text-sm mb-1.5">
                            ₽&nbsp;/&nbsp;{plan.durationDays}&nbsp;дней
                          </span>
                        </div>
                      )}

                      <ul className="space-y-2.5 mb-8 flex-1">
                        {[
                          `${plan.devicesIncluded} ${
                            plan.devicesIncluded === 1 ? "устройство"
                            : plan.devicesIncluded < 5 ? "устройства"
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
                          featured ? "btn-orange text-white" : "bg-gray-900 text-white hover:bg-orange-600"
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
            <div className="text-center bg-white border border-gray-100 p-12 max-w-md mx-auto">
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

      {/* ─── TESTIMONIALS ───────────────────────────────────────── */}
      <section className="py-20 px-6">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-10">
            <p className="text-orange-600 text-xs font-bold uppercase tracking-widest mb-3">Отзывы</p>
            <h2 className="text-4xl md:text-5xl font-black tracking-tighter">
              Что говорят<br />
              <span className="gradient-text">пользователи</span>
            </h2>
            <p className="text-gray-400 text-xs mt-3">Листайте смахом или нажмите на точку</p>
          </div>
          <TestimonialsCarousel />
        </div>
      </section>

      {/* ─── FAQ ────────────────────────────────────────────────── */}
      <section className="py-20 px-6 bg-gray-50/60">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-10">
            <p className="text-orange-600 text-xs font-bold uppercase tracking-widest mb-3">FAQ</p>
            <h2 className="text-4xl md:text-5xl font-black tracking-tighter">Частые вопросы</h2>
          </div>
          <div className="bg-white border border-gray-100 divide-y divide-gray-100 shadow-sm shadow-orange-50">
            <FaqItem
              q="Мой провайдер увидит, что я использую VPN?"
              a="Нет. Технология маскировки VPNexus скрывает трафик под обычный HTTPS. Для провайдера это выглядит как обращение к обычному сайту."
            />
            <FaqItem
              q="Что будет после окончания пробного периода?"
              a="Подписка деактивируется — ключи перестанут работать. Никакого автосписания нет. Оплатите нужный тариф и доступ восстановится."
            />
            <FaqItem
              q="Как получить помощь, если что-то не работает?"
              a="В личном кабинете есть раздел «Поддержка». Опишите проблему — отвечаем в течение нескольких часов."
            />
          </div>
        </div>
      </section>

      {/* ─── FOOTER ─────────────────────────────────────────────── */}
      <footer className="border-t border-gray-100 py-10 px-6">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 bg-orange-600 flex items-center justify-center shrink-0">
              <Shield className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="font-black text-sm tracking-tight">VPNexus</span>
          </div>

          {/* Footer CTA */}
          <Link href="/sign-up"
            className="btn-orange text-white font-bold px-6 py-2.5 text-sm flex items-center gap-2">
            Попробовать бесплатно <ArrowRight className="w-3.5 h-3.5" />
          </Link>

          <div className="flex gap-5 text-xs text-gray-400">
            <Link href="/sign-in"  className="hover:text-gray-700 transition-colors">Вход</Link>
            <Link href="/sign-up"  className="hover:text-gray-700 transition-colors">Регистрация</Link>
            <Link href="/terms"    className="hover:text-gray-700 transition-colors">Условия</Link>
            <Link href="/privacy"  className="hover:text-gray-700 transition-colors">Конфиденциальность</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
