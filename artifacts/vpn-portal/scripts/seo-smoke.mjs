import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const port = 4173;
const origin = `http://127.0.0.1:${port}`;
const expectedPublicUrls = new Set([
  "https://vpnexus.pro/",
  "https://vpnexus.pro/terms/",
  "https://vpnexus.pro/privacy/",
]);
const artifactToml = new URL("../.replit-artifact/artifact.toml", import.meta.url);

const publicPages = [
  {
    path: "/",
    title: "VPNexus — быстрый и защищённый VPN",
    description: "VPNexus — защищённое VPN-подключение со стабильной скоростью и простой настройкой.",
    canonical: "https://vpnexus.pro/",
    h1: "VPNexus — быстрый и защищённый VPN",
  },
  {
    paths: ["/terms", "/terms/"],
    title: "Публичная оферта — VPNexus",
    description: "Условия оказания услуг VPNexus, порядок оплаты, возврата и использования сервиса.",
    canonical: "https://vpnexus.pro/terms/",
    h1: "Публичная оферта об оказании услуг",
  },
  {
    paths: ["/privacy", "/privacy/"],
    title: "Политика конфиденциальности — VPNexus",
    description: "Как VPNexus обрабатывает и защищает персональные данные пользователей сервиса.",
    canonical: "https://vpnexus.pro/privacy/",
    h1: "Политика конфиденциальности и обработки персональных данных",
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function contentType(response) {
  return response.headers.get("content-type")?.toLowerCase() ?? "";
}

function meta(html, name) {
  const match = html.match(
    new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"\\s*/?>`, "i"),
  );
  return match?.[1];
}

function canonical(html) {
  return html.match(
    /<link\s+rel="canonical"\s+href="([^"]*)"\s*\/?>/i,
  )?.[1];
}

function parseSitemapXml(xml) {
  const tokens = xml.match(/<[^>]+>|[^<]+/g) ?? [];
  const stack = [];
  const locations = [];
  let text = "";

  for (const token of tokens) {
    if (token.startsWith("<?") || token.startsWith("<!--")) continue;
    if (token.startsWith("</")) {
      const name = token.match(/^<\/\s*([A-Za-z0-9:]+)\s*>$/)?.[1];
      assert(name && stack.at(-1) === name, `Malformed sitemap XML near ${token}`);
      stack.pop();
      if (name === "loc") {
        locations.push(text.trim());
        text = "";
      }
    } else if (token.startsWith("<")) {
      const selfClosing = /\/>$/.test(token);
      const name = token.match(/^<\s*([A-Za-z0-9:]+)/)?.[1];
      assert(name, `Malformed sitemap XML near ${token}`);
      if (!selfClosing) stack.push(name);
    } else {
      text += token;
    }
  }
  assert(stack.length === 0, "Sitemap XML has unclosed tags");
  assert(locations.length > 0, "Sitemap XML has no <loc> entries");
  return locations;
}

async function get(path) {
  const response = await fetch(`${origin}${path}`);
  const body = await response.text();
  return { response, body };
}

function hasExpectedPage(body, page) {
  return body.includes(`<title>${page.title}</title>`) &&
    meta(body, "description") === page.description &&
    canonical(body) === page.canonical &&
    body.includes(`<h1>${page.h1}</h1>`);
}

const preview = spawn(
  "pnpm",
  ["exec", "vite", "preview", "--config", "vite.config.ts", "--host", "127.0.0.1"],
  {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), BASE_PATH: "/" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let output = "";
preview.stdout.on("data", (chunk) => (output += chunk));
preview.stderr.on("data", (chunk) => (output += chunk));

try {
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await fetch(`${origin}/`);
      ready = true;
      break;
    } catch {
      await delay(200);
    }
  }
  assert(ready, `Production preview did not start.\n${output}`);

  const artifactConfig = await readFile(artifactToml, "utf8");
  for (const route of ["/terms", "/privacy"]) {
    assert(
      artifactConfig.includes(`from = "${route}"\nto = "${route}/index.html"`),
      `${route}: production rewrite must serve the generated public page directly`,
    );
  }

  const publicPaths = [
    { path: "/", page: publicPages[0] },
    ...publicPages.slice(1).flatMap((page) => page.paths.map((path) => ({ path, page }))),
  ];

  for (const { path, page } of publicPaths) {
    const { response, body } = await get(path);
    assert(response.status === 200, `${path}: expected HTTP 200, got ${response.status}`);
    assert(contentType(response).includes("text/html"), `${path}: expected HTML content type`);
    if (!hasExpectedPage(body, page) && path.endsWith("/") === false) {
      // Vite preview does not load artifact.toml rewrites; the production host
      // maps the no-slash URL to the generated slash-directory HTML file.
      const generatedPage = await get(`${path}/`);
      assert(
        hasExpectedPage(generatedPage.body, page),
        `${path}: generated public page metadata mismatch`,
      );
      continue;
    }
    assert(hasExpectedPage(body, page), `${path}: public page metadata mismatch`);
  }

  const privatePage = await get("/dashboard/");
  assert(privatePage.response.status === 200, `/dashboard: expected HTTP 200, got ${privatePage.response.status}`);
  assert(contentType(privatePage.response).includes("text/html"), "/dashboard: expected HTML content type");
  assert(meta(privatePage.body, "robots") === "noindex, nofollow", "/dashboard: must be noindex, nofollow");

  const robots = await get("/robots.txt");
  assert(robots.response.status === 200, `/robots.txt: expected HTTP 200, got ${robots.response.status}`);
  assert(contentType(robots.response).startsWith("text/plain"), "/robots.txt: expected text/plain content type");
  assert(robots.body.includes("Sitemap: https://vpnexus.pro/sitemap.xml"), "/robots.txt: sitemap declaration missing");

  const sitemap = await get("/sitemap.xml");
  assert(sitemap.response.status === 200, `/sitemap.xml: expected HTTP 200, got ${sitemap.response.status}`);
  assert(
    contentType(sitemap.response).includes("xml"),
    `/sitemap.xml: expected XML content type, got ${contentType(sitemap.response)}`,
  );
  const sitemapUrls = parseSitemapXml(sitemap.body);
  assert(
    sitemapUrls.length === expectedPublicUrls.size &&
      sitemapUrls.every((url) => expectedPublicUrls.has(url)),
    `Sitemap contains unexpected URLs: ${sitemapUrls.join(", ")}`,
  );
  console.log(`SEO smoke passed: ${publicPaths.length} public URL variants (including slash/no-slash), private noindex, robots.txt, sitemap.xml`);
} finally {
  preview.kill("SIGTERM");
}