// Piece: website → extension messaging (externally_connectable / onMessageExternal).
// Messages from allowed websites arrive via Fox Sake's content-script bridge as normal runtime
// messages tagged __foxsakeExternal. This piece hides them from the extension's ordinary
// onMessage listeners and delivers them to onMessageExternal listeners instead, with a
// Chrome-like `sender` (url, origin, tab).
{
  const isExternal = (msg) => !!(msg && typeof msg === "object" && msg.__foxsakeExternal);
  const external = new Set();

  // Chrome match pattern → RegExp (scheme://host/path with * wildcards).
  const toRegExp = (pattern) => {
    const m = /^(\*|https?|wss?|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)$/.exec(pattern);
    if (!m) return null;
    const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const scheme = m[1] === "*" ? "https?" : esc(m[1]);
    const host = m[2] === "*" ? "[^/]+" : m[2] && m[2].startsWith("*.") ? "(?:[^/]+\\.)?" + esc(m[2].slice(2)) : esc(m[2] || "");
    const path = m[3].split("*").map(esc).join(".*");
    return new RegExp("^" + scheme + "://" + host + "(?::\\d+)?" + path + "$");
  };
  const allowed = (FOXSAKE.externalMatches || []).map(toRegExp).filter(Boolean);
  const isAllowedUrl = (url) => typeof url === "string" && allowed.some((re) => re.test(url));

  if (FOXSAKE.context === "background") {
    // Registered before any extension code runs, using the real (unwrapped) event.
    RUNTIME.onMessage.addListener((msg, sender) => {
      if (!isExternal(msg) || sender.id !== RUNTIME.id) return undefined;
      // Use the URL Firefox reports for the sending frame, not one supplied in the message.
      const url = sender.url;
      if (!isAllowedUrl(url)) return Promise.resolve({ ok: false, error: "This site isn't allowed to message the extension." });
      const { message } = msg.__foxsakeExternal;
      const xsender = { url, origin: new URL(url).origin, tab: sender.tab, frameId: sender.frameId };
      if (sender.documentId) xsender.documentId = sender.documentId;
      return new Promise((resolve) => {
        let done = false;
        let pending = false;
        const respond = (response) => { if (!done) { done = true; resolve({ ok: true, response }); } };
        for (const fn of external) {
          let ret;
          try { ret = fn(message, xsender, respond); } catch (e) { console.error(e); }
          if (ret === true) pending = true;
          else if (ret && typeof ret.then === "function") {
            pending = true;
            ret.then(respond, (e) => { if (!done) { done = true; resolve({ ok: false, error: String((e && e.message) || e) }); } });
          }
        }
        if (!pending && !done) { done = true; resolve({ ok: true, response: undefined }); }
      });
    });
  }

  for (const t of TARGETS) {
    const rt = t.runtime;
    const ev = rt.onMessage;
    const wrapped = new WeakMap();
    const wrap = (fn) => {
      let w = wrapped.get(fn);
      if (!w) {
        w = function (msg, ...rest) { return isExternal(msg) ? undefined : fn.call(this, msg, ...rest); };
        wrapped.set(fn, w);
      }
      return w;
    };
    define(rt, "onMessage", {
      addListener: (fn) => ev.addListener(wrap(fn)),
      removeListener: (fn) => ev.removeListener(wrapped.get(fn) || fn),
      hasListener: (fn) => ev.hasListener(wrapped.get(fn) || fn),
      hasListeners: () => (typeof ev.hasListeners === "function" ? ev.hasListeners() : false),
    });
    const realExt = rt.onMessageExternal;
    define(rt, "onMessageExternal", {
      addListener: (fn) => { external.add(fn); if (realExt) realExt.addListener(fn); },
      removeListener: (fn) => { external.delete(fn); if (realExt) realExt.removeListener(fn); },
      hasListener: (fn) => external.has(fn),
      hasListeners: () => external.size > 0,
    });
  }
}
