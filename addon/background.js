// Fox Sake button: receives "add this extension" from the Web Store page and hands the
// extension ID to the local Fox Sake helper (native messaging). Only an ID ever leaves here.
const HOST = "foxsake";
const ID_RE = /^[a-p]{32}$/;

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "foxsake-add" || !ID_RE.test(msg.id)) return undefined;
  if (!sender.url || !sender.url.startsWith("https://chromewebstore.google.com/")) return undefined;
  return browser.runtime.sendNativeMessage(HOST, { action: "add", id: msg.id }).catch((e) => ({
    ok: false,
    error: /No such native application|not found/i.test(String(e))
      ? "The Fox Sake helper isn't set up. In Terminal, run: foxsake button install"
      : String(e && e.message ? e.message : e),
  }));
});
