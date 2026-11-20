// Converted extensions installed in this browser, update checks against the Chrome Web Store, and
// other add-ons in the same profile worth warning about.
// Only add-ons this Fox Sake converted count: their IDs are the keys of storage.local "reports",
// written when a conversion finishes. Anything else that happens to use an @foxsake ID (a sideloaded
// add-on, or one converted with the command-line version) isn't listed or offered updates.
import { latestVersion, compareVersions } from "../lib/core/webstore.js";

const OWN_ID = "button@foxsake";
const CHROME_ID = /^([a-p]{32})@foxsake$/;

export async function convertedAddons() {
  const [all, { reports = {} }] = await Promise.all([browser.management.getAll(), browser.storage.local.get("reports")]);
  const ours = new Set(Object.keys(reports));
  return all
    .filter((a) => a.type === "extension" && ours.has(a.id) && a.id !== OWN_ID)
    .map((a) => ({ id: a.id, name: a.name, version: a.version, enabled: a.enabled, chromeId: CHROME_ID.exec(a.id)?.[1] ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Asks the store for each converted extension's latest version. Updates the toolbar badge. */
export async function checkUpdates() {
  const list = await convertedAddons();
  const updates = {};
  await Promise.all(list.filter((a) => a.chromeId).map(async (a) => {
    try {
      const v = await latestVersion(a.chromeId);
      if (v && compareVersions(v, a.version) > 0) updates[a.id] = v;
    } catch { /* offline or removed from the store: skip */ }
  }));
  await browser.storage.local.set({ updates: { checkedAt: Date.now(), versions: updates } });
  const n = Object.keys(updates).length;
  await browser.action.setBadgeText({ text: n ? String(n) : "" });
  await browser.action.setBadgeBackgroundColor({ color: "#ff7139" });
  return updates;
}

// Host permissions that cover every website (any scheme, any host).
const ALL_SITES = /^(<all_urls>|(\*|https?|wss?|ftp|file):\/\/\*\/.*)$/;

/**
 * Installed add-ons that Fox Sake didn't convert and that would be valuable to tamper with: they can
 * talk to programs on the computer (nativeMessaging) or read and change every website. With signing
 * off, the browser no longer notices if their files are swapped. Read-only: nothing is changed.
 * `convertedInstalled` says whether any Fox Sake conversion is installed (which means signing is off).
 */
export async function sharedProfileRisks() {
  const [all, { reports = {} }] = await Promise.all([browser.management.getAll(), browser.storage.local.get("reports")]);
  const ours = new Set(Object.keys(reports));
  const others = all.filter((a) => a.type === "extension" && a.id !== OWN_ID);
  const risky = others
    .filter((a) => !ours.has(a.id))
    .map((a) => {
      const reasons = [];
      if ((a.permissions ?? []).includes("nativeMessaging")) reasons.push("talks to programs on your computer");
      if ((a.hostPermissions ?? []).some((p) => ALL_SITES.test(p))) reasons.push("can read and change all websites");
      return { id: a.id, name: a.name, enabled: a.enabled, reasons };
    })
    .filter((a) => a.reasons.length)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { risky, convertedInstalled: others.some((a) => ours.has(a.id)) };
}
