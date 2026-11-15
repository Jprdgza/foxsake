// Node side of downloading: picks the Chrome version to ask for, then uses the shared
// download code in src/core/webstore.js (the add-on uses the same code).
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { downloadCrx as download, latestVersion as latest, DEFAULT_CHROME_VERSION } from "../core/webstore.js";

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

export const downloadCrx = (id) => download(id, { chromeVersion: chromeVersion(), headers: HEADERS });
export const latestVersion = (id) => latest(id, { chromeVersion: chromeVersion(), headers: HEADERS });
export const readLocal = (path) => new Uint8Array(readFileSync(path));
