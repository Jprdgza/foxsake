// Converted extensions installed in this browser, update checks against the Chrome Web Store, and
// other add-ons in the same profile worth warning about.
// Only add-ons this Fox Sake converted count: their IDs are the keys of storage.local "reports",
// written when a conversion finishes. Anything else that happens to use an @foxsake ID (a sideloaded
// add-on, or one converted with the command-line version) isn't listed or offered updates.
import { latestVersion, compareVersions } from "../lib/core/webstore.js";
import { chromeIdOf, idBase, knownIds } from "../lib/core/ids.js";

const OWN_ID = "button@foxsake";

export async function convertedAddons() {
  const [all, { reports = {} }] = await Promise.all([browser.management.getAll(), browser.storage.local.get("reports")]);
  const ours = new Set(Object.keys(reports));
  return all
    .filter((a) => a.type === "extension" && ours.has(a.id) && a.id !== OWN_ID)
    .map((a) => ({ id: a.id, name: a.name, version: a.version, enabled: a.enabled, chromeId: chromeIdOf(a.id) }))
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
  await updateBadge();
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

// --- Firefox IDs ---------------------------------------------------------------------------------

/** The IDs a new conversion should reuse: installed converted add-ons, then IDs Fox Sake picked before. */
export async function idsForConversion() {
  const [all, { ids = {} }] = await Promise.all([browser.management.getAll(), browser.storage.local.get("ids")]);
  return knownIds(all.filter((a) => idBase(a.id)).map((a) => a.id), ids);
}

/** Remembers a newly picked ID so the next update of that extension reuses it. */
export async function saveId(meta) {
  if (!meta.newId) return;
  const { ids = {} } = await browser.storage.local.get("ids");
  ids[meta.idBase] = meta.geckoId;
  await browser.storage.local.set({ ids });
}

// --- Replacements Fox Sake didn't make -----------------------------------------------------------
// With signing off, any .xpi that carries a converted add-on's ID installs as an update of it and gets
// its saved data. Fox Sake notes each install it starts (a short-lived "pending" token) and the version
// it installed ("installs"). An install or version change of a converted add-on without a token is
// flagged. Firefox only lets add-ons turn off themes, and no add-on can remove another one, so the
// user is told to remove it; nothing is changed automatically.

const PENDING_MS = 15 * 60 * 1000; // time to get through the browser's two install prompts

/** Called right before the page starts an install of `meta` (from the click). */
export function expectInstall(meta) {
  return browser.storage.local.get("pending").then(({ pending = {} }) => {
    pending[meta.geckoId] = { version: meta.version, sha256: meta.packageSha256, permissions: meta.permissions, expires: Date.now() + PENDING_MS };
    return browser.storage.local.set({ pending });
  });
}

function validToken(pending, id, version, now) {
  const t = pending[id];
  return t && t.version === version && t.expires > now ? t : null;
}

/**
 * Handles management.onInstalled (from the background or the page; both may see the same event).
 * Returns "ours", "foreign" (newly flagged), "flagged" (already flagged) or null (not a converted add-on).
 */
export async function noteInstalled(info, now = Date.now()) {
  const { reports = {}, pending = {}, installs = {} } = await browser.storage.local.get(["reports", "pending", "installs"]);
  if (!reports[info.id] || info.id === OWN_ID) return null;
  const token = validToken(pending, info.id, info.version, now);
  if (!token) return (await flagReplaced(info, now)) ? "foreign" : "flagged";
  // The token stays until it expires, so a second listener seeing the same event agrees.
  installs[info.id] = { version: info.version, sha256: token.sha256 ?? null, permissions: token.permissions ?? null };
  await browser.storage.local.set({ installs });
  return "ours";
}

/**
 * Compares installed converted add-ons with the versions Fox Sake installed, for changes that happened
 * while nothing was listening (Fox Sake's background sleeps when idle, and the browser doesn't wake it
 * for other add-ons' installs). Add-ons with no record yet are taken as they are now.
 */
export async function checkReplacements(now = Date.now()) {
  const [all, { reports = {}, pending = {}, installs = {}, flagged = {} }] = await Promise.all([
    browser.management.getAll(),
    browser.storage.local.get(["reports", "pending", "installs", "flagged"]),
  ]);
  let changed = false;
  const newlyFlagged = [];
  for (const a of all) {
    if (!reports[a.id] || a.id === OWN_ID || flagged[a.id]) continue;
    const rec = installs[a.id];
    if (!rec) { installs[a.id] = { version: a.version, sha256: null, permissions: null }; changed = true; continue; }
    if (rec.version === a.version) continue;
    const token = validToken(pending, a.id, a.version, now);
    if (token) { installs[a.id] = { version: a.version, sha256: token.sha256 ?? null, permissions: token.permissions ?? null }; changed = true; }
    else if (await flagReplaced(a, now)) newlyFlagged.push(a.id);
  }
  for (const [id, t] of Object.entries(pending)) if (t.expires <= now) { delete pending[id]; changed = true; }
  if (changed) await browser.storage.local.set({ installs, pending });
  return newlyFlagged;
}

async function flagReplaced(info, now) {
  const { flagged = {} } = await browser.storage.local.get("flagged");
  if (flagged[info.id]?.version === info.version) return false;
  flagged[info.id] = { name: info.name, version: info.version, at: now };
  await browser.storage.local.set({ flagged });
  await updateBadge();
  return true;
}

/** The user says they installed it themselves (after confirming on the page). */
export async function trustReplacement(id) {
  const [{ flagged = {}, installs = {} }, info] = await Promise.all([
    browser.storage.local.get(["flagged", "installs"]),
    browser.management.get(id).catch(() => null),
  ]);
  delete flagged[id];
  if (info) installs[id] = { version: info.version, sha256: null, permissions: null };
  await browser.storage.local.set({ flagged, installs });
  await updateBadge();
}

/** Forgets everything about an uninstalled add-on except its report. */
export async function forgetAddon(id) {
  const { flagged = {}, installs = {}, pending = {} } = await browser.storage.local.get(["flagged", "installs", "pending"]);
  delete flagged[id]; delete installs[id]; delete pending[id];
  await browser.storage.local.set({ flagged, installs, pending });
  await updateBadge();
}

/** Flagged add-ons that are still installed. */
export async function replacedAddons() {
  const [all, { flagged = {} }] = await Promise.all([browser.management.getAll(), browser.storage.local.get("flagged")]);
  const installed = new Set(all.map((a) => a.id));
  return Object.entries(flagged).filter(([id]) => installed.has(id)).map(([id, f]) => ({ id, ...f }));
}

/** "!" when something was replaced, otherwise the number of available updates. */
export async function updateBadge() {
  const { flagged = {}, updates } = await browser.storage.local.get(["flagged", "updates"]);
  const n = Object.keys(updates?.versions ?? {}).length;
  const alarm = Object.keys(flagged).length > 0;
  await browser.action.setBadgeText({ text: alarm ? "!" : n ? String(n) : "" });
  await browser.action.setBadgeBackgroundColor({ color: alarm ? "#c5221f" : "#ff7139" });
}
