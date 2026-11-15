// Piece: when a messaging port closes because of an error, Chrome reports it through
// chrome.runtime.lastError inside onDisconnect listeners; Firefox reports it on port.error.
// Wrap ports so onDisconnect listeners see lastError like in Chrome.
{
  const wrapPort = (port) => {
    if (!port || !port.onDisconnect || port.__foxsakeWrapped) return port;
    const ev = port.onDisconnect;
    const add = ev.addListener.bind(ev);
    const wrapped = new WeakMap();
    try {
      ev.addListener = (fn) => {
        const w = (p) => {
          if (!p || !p.error) return fn(p);
          // Chrome's wording for a missing native app; extensions compare against it.
          const msg = /No such native application/i.test(String(p.error.message)) ? "Specified native messaging host not found." : p.error.message;
          return withLastError({ message: msg }, () => fn(p));
        };
        wrapped.set(fn, w);
        return add(w);
      };
      const remove = ev.removeListener.bind(ev);
      ev.removeListener = (fn) => remove(wrapped.get(fn) || fn);
      port.__foxsakeWrapped = true;
    } catch (e) { /* port object not writable: leave it alone */ }
    return port;
  };
  for (const t of TARGETS) {
    for (const [ns, method] of [["runtime", "connect"], ["runtime", "connectNative"], ["tabs", "connect"]]) {
      const obj = t[ns];
      if (!obj || typeof obj[method] !== "function") continue;
      const orig = obj[method];
      define(obj, method, function (...args) { return wrapPort(orig.apply(obj, args)); });
    }
    const onConnect = t.runtime && t.runtime.onConnect;
    if (onConnect && typeof onConnect.addListener === "function") {
      const add = onConnect.addListener.bind(onConnect);
      try { onConnect.addListener = (fn) => add((port) => fn(wrapPort(port))); } catch (e) {}
    }
  }
}
