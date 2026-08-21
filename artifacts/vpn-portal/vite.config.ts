import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

function generatePublicRouteHtml() {
  const pages = {
    terms: {
      title: "Публичная оферта — VPNexus",
      description: "Условия оказания услуг VPNexus, порядок оплаты, возврата и использования сервиса.",
      content: `<main><h1>Публичная оферта об оказании услуг</h1><p>Настоящий документ является публичной офертой VPNexus и определяет условия предоставления защищённого VPN-доступа.</p><h2>Предмет оферты</h2><p>VPNexus предоставляет пользователю доступ к сервису защищённого туннелирования интернет-трафика в соответствии с выбранным тарифом.</p><h2>Стоимость и возврат</h2><p>Оплата производится в рублях через доступные платёжные сервисы. При длительной технической невозможности оказания услуги пользователь может обратиться за пропорциональным возвратом.</p><p><a href="/">На главную</a> · <a href="/privacy">Политика конфиденциальности</a></p></main>`,
    },
    privacy: {
      title: "Политика конфиденциальности — VPNexus",
      description: "Как VPNexus обрабатывает и защищает персональные данные пользователей сервиса.",
      content: `<main><h1>Политика конфиденциальности и обработки персональных данных</h1><p>Эта политика описывает, как VPNexus обрабатывает персональные данные пользователей в соответствии с законодательством Российской Федерации.</p><h2>Какие данные мы собираем</h2><p>Для работы сервиса используются email, имя (по желанию), сведения о подписке и платежах, а также технические данные обращений к API.</p><h2>Защита данных</h2><p>Передача данных защищена TLS. Мы не храним реквизиты банковских карт и не используем сторонние маркетинговые системы аналитики.</p><p><a href="/">На главную</a> · <a href="/terms">Публичная оферта</a></p></main>`,
    },
  };

  return {
    name: "vpnexus-public-route-html",
    apply: "build" as const,
    async closeBundle() {
      const outputDir = path.resolve(import.meta.dirname, "dist/public");
      const template = await readFile(path.join(outputDir, "index.html"), "utf8");
      for (const [route, page] of Object.entries(pages)) {
        const html = template
          .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>\s*/, "")
          .replace(/<title>[^<]*<\/title>/, `<title>${page.title}</title>`)
          .replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${page.description}" />`)
          .replace(/<link rel="canonical" href="[^"]*"\s*\/>/, `<link rel="canonical" href="https://vpnexus.pro/${route}/" />`)
          .replace(/<meta property="og:title" content="[^"]*"\s*\/>/, `<meta property="og:title" content="${page.title}" />`)
          .replace(/<meta property="og:description" content="[^"]*"\s*\/>/, `<meta property="og:description" content="${page.description}" />`)
          .replace(/<meta property="og:url" content="[^"]*"\s*\/>/, `<meta property="og:url" content="https://vpnexus.pro/${route}" />`)
          .replace(/<meta name="twitter:title" content="[^"]*"\s*\/>/, `<meta name="twitter:title" content="${page.title}" />`)
          .replace(/<meta name="twitter:description" content="[^"]*"\s*\/>/, `<meta name="twitter:description" content="${page.description}" />`)
          .replace(/<div id="root">[\s\S]*?<\/div>\s*<script>/, `<div id="root">${page.content}</div>\n    <script>`);
        await mkdir(path.join(outputDir, route), { recursive: true });
        await writeFile(path.join(outputDir, route, "index.html"), html);
      }
      const privateRoutes = [
        "dashboard", "plans", "payments", "keys", "support", "profile", "admin",
        "sign-in", "sign-up", "forgot-password", "reset-password", "checkout", "balance-topup",
      ];
      for (const route of privateRoutes) {
        const html = template
          .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>\s*/, "")
          .replace(/<meta name="robots" content="[^"]*"\s*\/>/, '<meta name="robots" content="noindex, nofollow" />')
          .replace(/<link rel="canonical" href="[^"]*"\s*\/>/, `<link rel="canonical" href="https://vpnexus.pro/${route}/" />`)
          .replace(/<div id="root">[\s\S]*?<\/div>\s*<script>/, `<div id="root"><main><h1>VPNexus</h1></main></div>\n    <script>`);
        await mkdir(path.join(outputDir, route), { recursive: true });
        await writeFile(path.join(outputDir, route, "index.html"), html);
      }
    },
  };
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    generatePublicRouteHtml(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
