// Chrome Web Store helpers: parse URLs/IDs and build Google's update-service URLs.
// Pure functions (no network) so they work in Node and in the browser.

const ID_RE = /^[a-p]{32}$/;
export const DEFAULT_CHROME_VERSION = "157.0.0.0";

/** Returns the 32-letter extension ID from a Web Store URL or bare ID, or null. */
export function parseExtensionId(input) {
  const s = String(input).trim();
  if (ID_RE.test(s)) return s;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const okHost = url.hostname === "chromewebstore.google.com" || url.hostname === "chrome.google.com";
  if (!okHost) return null;
  // chromewebstore.google.com/detail/<slug>/<id>  or  /detail/<id>
  // chrome.google.com/webstore/detail/<slug>/<id>
  const id = url.pathname.split("/").find((part) => ID_RE.test(part));
  return id ?? null;
}

/** URL that 302-redirects to the CRX file. */
export function crxDownloadUrl(id, chromeVersion = DEFAULT_CHROME_VERSION) {
  const x = encodeURIComponent(`id=${id}&uc`);
  return `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${chromeVersion}&acceptformat=crx2,crx3&x=${x}`;
}

/** URL that returns XML describing the latest version (no download). */
export function updateCheckUrl(id, chromeVersion = DEFAULT_CHROME_VERSION) {
  const x = encodeURIComponent(`id=${id}&uc`);
  return `https://clients2.google.com/service/update2/crx?prodversion=${chromeVersion}&acceptformat=crx2,crx3&x=${x}`;
}

/** Extracts {version, codebase, status} from the update-check XML response. */
export function parseUpdateCheck(xml) {
  const tag = /<updatecheck\b([^>]*)\/?>/.exec(xml);
  if (!tag) return null;
  const attr = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag[1])?.[1] ?? null;
  return { status: attr("status"), version: attr("version"), codebase: attr("codebase") };
}

/** Compares dotted version strings ("1.2.10" > "1.2.9"). Returns -1, 0 or 1. */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
