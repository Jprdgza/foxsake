// Piece: website → extension messaging (externally_connectable / onMessageExternal).
// Messages from allowed websites arrive via Fox Sake's content-script bridge as normal runtime
// messages tagged __foxsakeExternal. This piece hides them from the extension's ordinary
// onMessage listeners and delivers them to onMessageExternal listeners instead, with a
// Chrome-like `sender` (url, origin, tab).
{
  const isExternal = (msg) => !!(msg && typeof msg === "object" && msg.__foxsakeExternal);
  const external = new Set();

  if (FOXSAKE.context === "background") {
    // Registered before any extension code runs, using the real (unwrapped) event.
    RUNTIME.onMessage.addListener((msg, sender) => {
      if (!isExternal(msg) || sender.id !== RUNTIME.id) return undefined;
      const { message, url, origin } = msg.__foxsakeExternal;
      const xsender = { url, origin, tab: sender.tab, frameId: sender.frameId };
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
