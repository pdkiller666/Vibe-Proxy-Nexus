/**
 * Happ iOS routing profile helpers.
 *
 * iOS Happ separates VPN connection (subscription URL) from routing
 * (happ://routing/add/<base64> deep link). This module:
 *   - Defines the default direct-bypass profile (Russian services + RFC-1918)
 *   - Merges admin-supplied overrides with the fixed infrastructure fields
 *   - Builds the ready-to-use happ:// deep link URL
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** The admin-editable subset of a Happ iOS routing profile. */
export interface HappIosRoutingProfile {
  /** Profile name shown in Happ (e.g. "VPNexus"). */
  name: string;
  /**
   * Sites that go directly (bypass tunnel). Use Xray domain-matcher format:
   *   "domain:example.ru"   → matches example.ru and all subdomains
   *   "regexp:\\.ru$"       → matches any .ru TLD (can be added here too)
   * Admin UI strips/adds the "domain:" prefix for display convenience.
   */
  directsites: string[];
  /** CIDR ranges that go directly (bypass tunnel), e.g. "10.0.0.0/8". */
  directip: string[];
}

// ── Default direct-sites list ─────────────────────────────────────────────────

/** Full default direct-bypass domain list compiled from the Happ iOS routing
 *  profile shared by the operator. These are Russian services that must remain
 *  accessible without the VPN tunnel. Admin can override via admin panel. */
export const DEFAULT_DIRECT_SITES: string[] = [
  "domain:1tv.ru",
  "domain:2gis.com",
  "domain:2gis.ru",
  "domain:5ka.ru",
  "domain:aeroflot.ru",
  "domain:aif.ru",
  "domain:akbars.ru",
  "domain:alfa.me",
  "domain:alfabank.ru",
  "domain:alfastrah.ru",
  "domain:apteka.ru",
  "domain:auchan.ru",
  "domain:auth-nsdi.ru",
  "domain:auto.ru",
  "domain:av.ru",
  "domain:aviasales.ru",
  "domain:avito.ru",
  "domain:avito.st",
  "domain:banki.ru",
  "domain:beeline.ru",
  "domain:belkacar.ru",
  "domain:boxberry.ru",
  "domain:bristol.ru",
  "domain:burgerking.ru",
  "domain:cbr.ru",
  "domain:cdek.ru",
  "domain:cdn-vk.ru",
  "domain:chestnyznak.ru",
  "domain:chibbis.ru",
  "domain:cian.ru",
  "domain:citilink.ru",
  "domain:citydrive.ru",
  "domain:council.gov.ru",
  "domain:crpt.ru",
  "domain:dash.cloudflare.com",
  "domain:delimobil.ru",
  "domain:delivery-club.ru",
  "domain:dellin.ru",
  "domain:detmir.ru",
  "domain:dixy.ru",
  "domain:dnevnik.ru",
  "domain:dns-shop.ru",
  "domain:dodopizza.ru",
  "domain:dom.ru",
  "domain:domclick.ru",
  "domain:dpd.ru",
  "domain:drive2.ru",
  "domain:drom.ru",
  "domain:duma.gov.ru",
  "domain:dzen.ru",
  "domain:eapteka.ru",
  "domain:eldorado.ru",
  "domain:emias.info",
  "domain:epp.genproc.gov.ru",
  "domain:ertelecom.ru",
  "domain:fivepost.ru",
  "domain:fix-price.com",
  "domain:flysmartavia.com",
  "domain:gazeta.ru",
  "domain:gazprombank.ru",
  "domain:gismeteo.ru",
  "domain:gloria-jeans.ru",
  "domain:goldapple.ru",
  "domain:gorzdrav.org",
  "domain:goskey.ru",
  "domain:gosuslugi.ru",
  "domain:government.ru",
  "domain:grandtrain.ru",
  "domain:hh.ru",
  "domain:hoff.ru",
  "domain:ingos.ru",
  "domain:ivi.ru",
  "domain:iz.ru",
  "domain:izibirkom.ru",
  "domain:justletswork.com",
  "domain:kari.com",
  "domain:kinopoisk.ru",
  "domain:kion.ru",
  "domain:kommersant.ru",
  "domain:kp.ru",
  "domain:krasnoeibeloe.ru",
  "domain:kremlin.ru",
  "domain:kuper.ru",
  "domain:lamoda.ru",
  "domain:lamoda.tech",
  "domain:lemanapro.ru",
  "domain:lenta.com",
  "domain:lenta.ru",
  "domain:letu.ru",
  "domain:litres.ru",
  "domain:lmru.tech",
  "domain:m2.ru",
  "domain:magnit.com",
  "domain:magnit.ru",
  "domain:mail.ru",
  "domain:matchtv.ru",
  "domain:max.ru",
  "domain:mchs.gov.ru",
  "domain:megafon.ru",
  "domain:megamarket.ru",
  "domain:metro-cc.ru",
  "domain:mfc.ru",
  "domain:mgnt.ru",
  "domain:mir-pay.ru",
  "domain:mironline.ru",
  "domain:mk.ru",
  "domain:moex.com",
  "domain:mos.ru",
  "domain:mosmetro.ru",
  "domain:motivtelecom.ru",
  "domain:mradx.net",
  "domain:mts.ru",
  "domain:mtsbank.ru",
  "domain:mvd.ru",
  "domain:mvideo.ru",
  "domain:my-documents.ru",
  "domain:mybook.ru",
  "domain:mycdn.me",
  "domain:myspar.ru",
  "domain:nalog.gov.ru",
  "domain:nordwindairlines.ru",
  "domain:nspk.ru",
  "domain:ntv.ru",
  "domain:ok.ru",
  "domain:okcdn.ru",
  "domain:okko.ru",
  "domain:okko.tv",
  "domain:okmarket.ru",
  "domain:oneme.ru",
  "domain:orgp.spb.ru",
  "domain:ostrovok.ru",
  "domain:ozon.ru",
  "domain:ozone.ru",
  "domain:perekrestok.ru",
  "domain:petrovich.ru",
  "domain:planetazdorovo.ru",
  "domain:pobeda.aero",
  "domain:pochta.ru",
  "domain:premier.one",
  "domain:profi.ru",
  "domain:psbank.ru",
  "domain:rabota.ru",
  "domain:rambler.ru",
  "domain:rbc.ru",
  "domain:res-nsdi.ru",
  "domain:reso.ru",
  "domain:rg.ru",
  "domain:rgs.ru",
  "domain:ria.ru",
  "domain:rigla.ru",
  "domain:rivegauche.ru",
  "domain:rosseti.ru",
  "domain:rostelecom.ru",
  "domain:rostics.ru",
  "domain:rsv.ru",
  "domain:rt.com",
  "domain:rt.ru",
  "domain:rustore.ru",
  "domain:rutube.ru",
  "domain:rutubelist.ru",
  "domain:rzd.ru",
  "domain:s7.ru",
  "domain:samokat.ru",
  "domain:sberdevices.ru",
  "domain:sberhealth.ru",
  "domain:sferum.ru",
  "domain:smotreshka.tv",
  "domain:smotrim.ru",
  "domain:sochi.ru",
  "domain:sogaz.ru",
  "domain:sportmaster.ru",
  "domain:sravni.ru",
  "domain:start.ru",
  "domain:superjob.ru",
  "domain:sutochno.ru",
  "domain:t2.ru",
  "domain:tanuki.ru",
  "domain:tass.ru",
  "domain:taximaxim.ru",
  "domain:tele2.ru",
  "domain:trudvsem.ru",
  "domain:tutu.ru",
  "domain:uchi.ru",
  "domain:uralairlines.ru",
  "domain:urent.ru",
  "domain:userapi.com",
  "domain:utair.ru",
  "domain:vgtrk.ru",
  "domain:vk-portal.net",
  "domain:vk.com",
  "domain:vk.ru",
  "domain:vkusnoitochka.ru",
  "domain:vkusvill.ru",
  "domain:vkvideo.ru",
  "domain:vprok.ru",
  "domain:vseinstrumenty.ru",
  "domain:vsk.ru",
  "domain:vtb.ru",
  "domain:vybory.gov.ru",
  "domain:wb.ru",
  "domain:whoosh.bike",
  "domain:wifire.ru",
  "domain:wildberries.ru",
  "domain:wink.ru",
  // .рф punycode domains
  "domain:xn--80ajghhoc2aj1c8b.xn--p1ai",
  "domain:xn--80aqf2ac.xn--p1ai",
  "domain:xn--90acagbhgpca7c8c7f.xn--p1ai",
  "domain:xn--90aivcdt6dxbc.xn--p1ai",
  "domain:xn--b1aew.xn--p1ai",
  "domain:ya.ru",
  "domain:yandex.com",
  "domain:yandex.net",
  "domain:yandex.ru",
  "domain:yastatic.net",
  "domain:yota.ru",
  "domain:youla.io",
  "domain:youla.ru",
  "domain:zarplata.ru",
  "domain:zvuk.com",
];

export const DEFAULT_DIRECT_IP: string[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "255.255.255.255",
];

export const DEFAULT_PROFILE_NAME = "VPNexus";

// ── Fixed infrastructure fields ────────────────────────────────────────────────
// These are never editable by admin — they control how Happ handles DNS and
// downloads its geo databases. Changing them would require a code update.

const FIXED_FIELDS = {
  blockip: [] as string[],
  blocksites: [] as string[],
  proxyip: [] as string[],
  proxysites: [] as string[],
  globalproxy: true,
  domainStrategy: "IPIfNonMatch",
  // Loyalsoldier distribution: includes geoip:ru and geosite:ru, which the
  // bundled Happ dat files lack. Happ downloads these on profile import.
  geoipurl:
    "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat",
  geositeurl:
    "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat",
  domesticdnsdomain: "https://dns.google/dns-query",
  domesticdnsip: "77.88.8.8",
  domesticdnstype: "DoU",
  remotednsdomain: "https://dns.google/dns-query",
  remotednsip: "8.8.8.8",
  remotednstype: "DoH",
  dnshosts: { "dns.google": "8.8.8.8" },
  fakedns: false,
  routeorder: "block-direct-proxy",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Merges an optional admin-supplied profile with the defaults.
 * Always returns a fully-populated HappIosRoutingProfile (never null).
 */
export function resolveHappIosRoutingProfile(
  stored: HappIosRoutingProfile | null | undefined,
): HappIosRoutingProfile {
  return {
    name: stored?.name ?? DEFAULT_PROFILE_NAME,
    directsites: stored?.directsites ?? DEFAULT_DIRECT_SITES,
    directip: stored?.directip ?? DEFAULT_DIRECT_IP,
  };
}

/**
 * Builds the full Happ iOS routing profile object (including fixed infra fields)
 * and returns the ready-to-use deep link URL: happ://routing/add/<base64>.
 */
export function buildHappIosRoutingUrl(profile: HappIosRoutingProfile): string {
  const fullProfile = {
    ...FIXED_FIELDS,
    name: profile.name,
    directsites: profile.directsites,
    directip: profile.directip,
  };
  const json = JSON.stringify(fullProfile);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  return `happ://routing/add/${b64}`;
}
