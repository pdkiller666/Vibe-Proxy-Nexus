import { describe, expect, it } from "vitest";
import { DEFAULT_APP_LINKS, resolveAppLinks } from "./appDownloadLinks";

describe("resolveAppLinks", () => {
  it("returns the complete default list when settings are empty", () => {
    expect(resolveAppLinks(null)).toEqual(DEFAULT_APP_LINKS);
    expect(resolveAppLinks(undefined)).toEqual(DEFAULT_APP_LINKS);
  });

  it("converts the previous fixed-key settings format", () => {
    const links = resolveAppLinks({
      happAndroid: " https://example.com/android ",
      happIos: "https://example.com/ios",
      v2rayng: "https://example.com/v2rayng",
      v2rayn: "https://example.com/v2rayn",
    });

    expect(links.map((link) => link.id)).toEqual([
      "happ-android",
      "happ-ios",
      "happ-windows",
      "v2rayng-android",
      "v2rayn-windows",
    ]);
    expect(links[0].url).toBe("https://example.com/android");
    expect(links[2].url).toBe(
      "https://github.com/Happ-proxy/happ-desktop/releases/latest/download/setup-Happ.x64.exe",
    );
  });

  it("normalizes, filters, and sorts the new list format", () => {
    const links = resolveAppLinks([
      {
        id: "later",
        title: "Later",
        url: " https://later.example ",
        platforms: ["windows", "windows"],
        visible: false,
        sortOrder: 20,
      },
      {
        id: "first",
        title: "First",
        url: "https://first.example",
        platforms: ["android"],
        visible: true,
        sortOrder: 10,
      },
      {
        id: "invalid",
        title: "",
        url: "https://invalid.example",
        platforms: ["ios"],
        visible: true,
        sortOrder: 0,
      },
    ]);

    expect(links).toEqual([
      {
        id: "first",
        title: "First",
        url: "https://first.example",
        platforms: ["android"],
        visible: true,
        sortOrder: 10,
      },
      {
        id: "later",
        title: "Later",
        url: "https://later.example",
        platforms: ["windows"],
        visible: false,
        sortOrder: 20,
      },
    ]);
  });

  it("preserves an intentionally empty custom list", () => {
    expect(resolveAppLinks([])).toEqual([]);
  });
});