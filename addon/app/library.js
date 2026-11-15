// Converted extensions installed in this browser (any add-on whose ID ends in @foxsake),
// and update checks against the Chrome Web Store.
import { latestVersion, compareVersions } from "../lib/core/webstore.js";

const OWN_ID = "button@foxsake";
const CHROME_ID = /^([a-p]{32})@foxsake$/;

export async function convertedAddons() {
  const all = await browser.management.getAll();
  return all
    .filter((a) => a.type === "extension" && a.id.endsWith("@foxsake") && a.id !== OWN_ID)
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
