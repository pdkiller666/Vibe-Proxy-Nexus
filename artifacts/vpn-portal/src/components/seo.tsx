import { useEffect } from "react";

const SITE_URL = "https://vpnexus.pro";
const IMAGE_URL = `${SITE_URL}/opengraph.jpg`;

export type SeoProps = {
  title: string;
  description: string;
  path: string;
  noindex?: boolean;
  jsonLd?: Record<string, unknown> | Record<string, unknown>[];
};

function setMeta(selector: string, attribute: "content" | "href", value: string) {
  const element = document.head.querySelector(selector);
  if (element) element.setAttribute(attribute, value);
}

export function Seo({ title, description, path, noindex = false, jsonLd }: SeoProps) {
  useEffect(() => {
    const canonical = `${SITE_URL}${path}`;
    document.title = title;
    setMeta('meta[name="description"]', "content", description);
    setMeta('meta[name="robots"]', "content", noindex ? "noindex, nofollow" : "index, follow");
    setMeta('meta[property="og:title"]', "content", title);
    setMeta('meta[property="og:description"]', "content", description);
    setMeta('meta[property="og:url"]', "content", canonical);
    setMeta('meta[name="twitter:title"]', "content", title);
    setMeta('meta[name="twitter:description"]', "content", description);
    const link = document.head.querySelector('link[rel="canonical"]');
    if (link) link.setAttribute("href", canonical);

    const old = document.getElementById("vpnexus-jsonld");
    old?.remove();
    if (jsonLd) {
      const script = document.createElement("script");
      script.id = "vpnexus-jsonld";
      script.type = "application/ld+json";
      script.textContent = JSON.stringify(jsonLd);
      document.head.appendChild(script);
    }
    return () => document.getElementById("vpnexus-jsonld")?.remove();
  }, [title, description, path, noindex, jsonLd]);

  return null;
}

export const homeSeo = {
  title: "VPNexus — быстрый и защищённый VPN",
  description: "VPNexus — защищённое VPN-подключение со стабильной скоростью и простой настройкой.",
  path: "/",
  jsonLd: [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "VPNexus",
      url: SITE_URL,
      logo: IMAGE_URL,
      description: "Сервис защищённого VPN-подключения.",
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "VPNexus",
      url: SITE_URL,
      inLanguage: "ru-RU",
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        { "@type": "Question", name: "Увидит ли провайдер, какие сайты я посещаю?", acceptedAnswer: { "@type": "Answer", text: "Нет. VPNexus шифрует весь трафик и скрывает его под обычный HTTPS." } },
        { "@type": "Question", name: "Что будет после окончания пробного периода?", acceptedAnswer: { "@type": "Answer", text: "Подписка деактивируется, автосписания нет." } },
        { "@type": "Question", name: "Нужен ли инвайт для регистрации?", acceptedAnswer: { "@type": "Answer", text: "Да, регистрация открыта по приглашению действующего пользователя." } },
      ],
    },
  ],
};
