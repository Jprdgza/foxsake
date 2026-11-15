// Downloads extensions from the Chrome Web Store via Google's public update service.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { crxDownloadUrl, updateCheckUrl, parseUpdateCheck, DEFAULT_CHROME_VERSION } from "../core/webstore.js";

const MAX_CRX = 300 * 1024 * 1024;
const HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36" };

/** Uses the locally installed Chrome's version if there is one (Google serves builds per Chrome version). */
export function chromeVersion() {
  const plist = "/Applications/Google Chrome.app/Contents/Info.plist";
  if (existsSync(plist)) {
    try {
      const v = execFileSync("defaults", ["read", plist.replace(/\.plist$/, ""), "CFBundleShortVersionString"], { encoding: "utf8" }).trim();
      if (/^\d+(\.\d+)*$/.test(v)) return v;
    } catch {}
  }
  return DEFAULT_CHROME_VERSION;
}

export async function downloadCrx(id) {
  const res = await fetch(crxDownloadUrl(id, chromeVersion()), { redirect: "follow", headers: HEADERS });
  if (res.status === 204 || res.status === 404) throw new Error(`The Chrome Web Store has no downloadable extension with ID ${id} (HTTP ${res.status}). It may be removed, region-locked, or paid.`);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_CRX) throw new Error(`Extension is ${Math.round(len / 1e6)} MB; refusing anything over 300 MB.`);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_CRX) throw new Error("Download is over 300 MB; refusing.");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  if (bytes.length === 0) throw new Error(`Empty download for ${id}: the store returned nothing.`);
  return bytes;
}

/** Latest version on the store, without downloading the package. */
export async function latestVersion(id) {
  const res = await fetch(updateCheckUrl(id, chromeVersion()), { headers: HEADERS });
  if (!res.ok) throw new Error(`Update check failed: HTTP ${res.status}`);
  const info = parseUpdateCheck(await res.text());
  if (!info || info.status !== "ok") return null;
  return info.version;
}

export const readLocal = (path) => new Uint8Array(readFileSync(path));
