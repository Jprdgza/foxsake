// Converted extensions installed in this browser, and update checks against the Chrome Web Store.
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
