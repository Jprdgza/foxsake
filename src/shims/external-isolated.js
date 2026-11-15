// Fox Sake: extension-side half of the externally_connectable bridge (isolated content script).
// Accepts requests only from the same window, tagged for this extension, and forwards them
// to the background as runtime messages.
(() => {
  const FOXSAKE = /*FOXSAKE_CONFIG*/{};
  const EXT_ID = FOXSAKE.chromeId;
  const A = globalThis.browser || globalThis.chrome;
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__foxsake !== "ext-request" || d.ext !== EXT_ID) return;
    const reply = (o) => window.postMessage(Object.assign({ __foxsake: "ext-response", ext: EXT_ID, seq: d.seq }, o), "*");
    A.runtime.sendMessage({ __foxsakeExternal: { message: d.message, url: location.href, origin: location.origin } }).then(
      (r) => reply(r && r.ok === false ? { ok: false, error: r.error } : { ok: true, response: r ? r.response : undefined }),
      (err) => reply({ ok: false, error: String((err && err.message) || err) }),
    );
  });
})();
