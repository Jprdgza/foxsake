// Fox Sake: website-side half of the externally_connectable bridge (runs in the page's own
// JavaScript world on the extension's allowed sites). Gives the page the Chrome-style
// chrome.runtime.sendMessage(EXTENSION_ID, message, callback) that Firefox doesn't provide,
// and relays calls to Fox Sake's isolated content script via window.postMessage.
(() => {
  const FOXSAKE = /*FOXSAKE_CONFIG*/{};
  const EXT_ID = FOXSAKE.chromeId;
  const w = window;
  const chromeObj = w.chrome || (w.chrome = {});
  const runtime = chromeObj.runtime || (chromeObj.runtime = {});
  const prev = runtime.sendMessage;
  const pending = new Map();
  let seq = 0;

  w.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== w || !d || d.__foxsake !== "ext-response" || d.ext !== EXT_ID) return;
    const settle = pending.get(d.seq);
    if (!settle) return;
    pending.delete(d.seq);
    settle(d);
  });

  const callWithLastError = (err, cb) => {
    runtime.lastError = { message: String(err.message || err) };
    try { cb(); } finally { delete runtime.lastError; }
  };

  runtime.sendMessage = function (extensionId, message, options, callback) {
    if (typeof options === "function") { callback = options; options = undefined; }
    if (extensionId !== EXT_ID) {
      if (typeof prev === "function") return prev.apply(this, arguments);
      const err = new Error("Could not establish connection. Receiving end does not exist.");
      if (typeof callback === "function") { setTimeout(() => callWithLastError(err, callback)); return undefined; }
      return Promise.reject(err);
    }
    const id = ++seq;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, (d) => (d.ok ? resolve(d.response) : reject(new Error(d.error || "Extension error"))));
    });
    w.postMessage({ __foxsake: "ext-request", ext: EXT_ID, seq: id, message }, "*");
    if (typeof callback === "function") {
      promise.then((r) => callback(r), (e) => callWithLastError(e, callback));
      return undefined;
    }
    return promise;
  };
})();
