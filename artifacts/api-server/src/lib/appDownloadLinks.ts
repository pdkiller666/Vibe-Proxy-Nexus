/** Admin-configurable links for recommended VPN client apps.
 * Stored in payment_settings.app_download_links (JSONB).
 * The resolver also understands the previous fixed-key object format. */

export const APP_PLATFORMS = ["android", "ios", "windows"] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

export interface AppLink {
  id: string;
  title: string;
  url: string;
  platforms: AppPlatform[];
  visible: boolean;
  sortOrder: number;
}

interface LegacyAppDownloadLinks {
  happAndroid?: string;
  happIos?: string;
  v2rayng?: string;
  v2rayn?: string;
}

const DEFAULT_HAPP_WINDOWS_URL =
  "https://github.com/Happ-proxy/happ-desktop/releases/latest/download/setup-Happ.x64.exe";

export const DEFAULT_APP_LINKS: AppLink[] = [
  {
    id: "happ-android",
    title: "Скачать Happ",
    url: "https://play.google.com/store/apps/details?id=com.happproxy.v2ray",
    platforms: ["android"],
    visible: true,
    sortOrder: 10,
  },
  {
    id: "happ-ios",
    title: "Скачать Happ",
    url: "https://apps.apple.com/app/happ-proxy-utility/id6504287215",
    platforms: ["ios"],
    visible: true,
    sortOrder: 10,
  },
  {
    id: "happ-windows",
    title: "Скачать Happ",
    url: DEFAULT_HAPP_WINDOWS_URL,
    platforms: ["windows"],
    visible: true,
    sortOrder: 10,
  },
  {
    id: "v2rayng-android",
    title: "Скачать v2rayNG",
    url: "https://play.google.com/store/apps/details?id=com.v2ray.ang",
    platforms: ["android"],
    visible: true,
    sortOrder: 20,
  },
  {
    id: "v2rayn-windows",
    title: "Скачать v2rayN",
    url: "https://github.com/2dust/v2rayN/releases/latest",
    platforms: ["windows"],
    visible: true,
    sortOrder: 20,
  },
];

function normalizeLink(link: unknown, index: number): AppLink | null {
  if (!link || typeof link !== "object") return null;
  const candidate = link as Partial<AppLink>;
  const platforms = Array.isArray(candidate.platforms)
    ? [...new Set(candidate.platforms.filter((platform): platform is AppPlatform =>
        (APP_PLATFORMS as readonly string[]).includes(platform),
      ))]
    : [];

  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
  if (!title || !url || platforms.length === 0) return null;

  return {
    id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : `app-link-${index + 1}`,
    title,
    url,
    platforms,
    visible: candidate.visible !== false,
    sortOrder: Number.isFinite(candidate.sortOrder) ? Number(candidate.sortOrder) : (index + 1) * 10,
  };
}

function fromLegacy(stored: LegacyAppDownloadLinks): AppLink[] {
  const legacyById: Array<[string, string, AppPlatform, string | undefined]> = [
    ["happ-android", "Скачать Happ", "android", stored.happAndroid],
    ["happ-ios", "Скачать Happ", "ios", stored.happIos],
    ["happ-windows", "Скачать Happ", "windows", DEFAULT_HAPP_WINDOWS_URL],
    ["v2rayng-android", "Скачать v2rayNG", "android", stored.v2rayng],
    ["v2rayn-windows", "Скачать v2rayN", "windows", stored.v2rayn],
  ];

  return legacyById.map(([id, title, platform, url], index) => ({
    id,
    title,
    url: url?.trim() || DEFAULT_APP_LINKS[index].url,
    platforms: [platform],
    visible: true,
    sortOrder: (index + 1) * 10,
  }));
}

/** Returns the effective links and migrates the old fixed-key object in memory. */
export function resolveAppLinks(stored: unknown): AppLink[] {
  if (Array.isArray(stored)) {
    return stored
      .map((link, index) => normalizeLink(link, index))
      .filter((link): link is AppLink => link !== null)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  if (stored && typeof stored === "object") {
    return fromLegacy(stored as LegacyAppDownloadLinks);
  }

  return DEFAULT_APP_LINKS.map((link) => ({ ...link, platforms: [...link.platforms] }));
}
