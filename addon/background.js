// Fox Sake background: opens the converter page (from the toolbar button or the Web Store
// button), and once a day checks whether converted extensions have a newer store version.
import { checkUpdates } from "./app/library.js";

const ID_RE = /^[a-p]{32}$/;
const STORE = "https://chromewebstore.google.com/";

function openApp(hash = "", opener) {
  return browser.tabs.create({
    url: browser.runtime.getURL("app/app.html") + hash,
    ...(opener && Number.isInteger(opener.index) ? { index: opener.index + 1, openerTabId: opener.id } : {}),
  });
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== "string") return undefined;
  if (msg.type === "foxsake-add") {
    // Only the Web Store content script may ask, and only with a 32-letter extension ID.
    if (typeof msg.id !== "string" || !ID_RE.test(msg.id)) return undefined;
    if (typeof sender.url !== "string" || !sender.url.startsWith(STORE)) return undefined;
    // sender.tab is only used to place the new tab next to the store page (it can be missing).
    return openApp(`#add=${msg.id}`, sender.tab).then(() => ({ ok: true }));
  }
  if (msg.type === "foxsake-browser-name") {
    return browser.runtime.getBrowserInfo().then((i) => (i.zen ? "Zen" : i.name), () => "Firefox");
  }
  return undefined;
});

browser.action.onClicked.addListener(() => openApp());

const scheduleUpdates = () => browser.alarms.create("foxsake-updates", { delayInMinutes: 5, periodInMinutes: 24 * 60 });
browser.runtime.onInstalled.addListener(scheduleUpdates);
browser.runtime.onStartup.addListener(scheduleUpdates);
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === "foxsake-updates") checkUpdates().catch(() => {});
});
