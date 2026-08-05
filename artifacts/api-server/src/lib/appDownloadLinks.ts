/** Admin-configurable download links for recommended VPN client apps.
 *  Stored in payment_settings.app_download_links (JSONB). Null = use these defaults. */

export interface AppDownloadLinks {
  /** Happ for Android — Google Play or direct APK */
  happAndroid: string;
  /** Happ for iOS — App Store */
  happIos: string;
  /** v2rayNG for Android — Google Play */
  v2rayng: string;
  /** v2rayN for Windows — GitHub releases */
  v2rayn: string;
}

export const DEFAULT_APP_DOWNLOAD_LINKS: AppDownloadLinks = {
  happAndroid: "https://play.google.com/store/apps/details?id=com.happproxy.v2ray",
  happIos: "https://apps.apple.com/app/happ-proxy-utility/id6504287215",
  v2rayng: "https://play.google.com/store/apps/details?id=com.v2ray.ang",
  v2rayn: "https://github.com/2dust/v2rayN/releases/latest",
};

/** Returns the effective links: stored override merged with defaults. */
export function resolveAppDownloadLinks(
  stored: Partial<AppDownloadLinks> | null | undefined,
): AppDownloadLinks {
  if (!stored) return { ...DEFAULT_APP_DOWNLOAD_LINKS };
  return {
    happAndroid: stored.happAndroid?.trim() || DEFAULT_APP_DOWNLOAD_LINKS.happAndroid,
    happIos: stored.happIos?.trim() || DEFAULT_APP_DOWNLOAD_LINKS.happIos,
    v2rayng: stored.v2rayng?.trim() || DEFAULT_APP_DOWNLOAD_LINKS.v2rayng,
    v2rayn: stored.v2rayn?.trim() || DEFAULT_APP_DOWNLOAD_LINKS.v2rayn,
  };
}
