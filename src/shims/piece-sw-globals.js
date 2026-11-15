// Piece: service-worker globals. Chrome ran this code as a service worker; Firefox runs it as
// a background page, where these globals don't exist. Provides harmless equivalents.
{
  const g = globalThis;
  const swUrl = RUNTIME.getURL(FOXSAKE.swEntry || "");

  if (!g.registration) {
    const registration = {
      scope: RUNTIME.getURL("/"),
      active: { state: "activated", scriptURL: swUrl, postMessage() {} },
      installing: null,
      waiting: null,
      navigationPreload: {
        enable: async () => {}, disable: async () => {}, setHeaderValue: async () => {},
        getState: async () => ({ enabled: false, headerValue: "true" }),
      },
      async showNotification(title, options = {}) {
        const N = API.notifications;
        if (!N) throw new Error('showNotification needs the "notifications" permission.');
        const icons = RUNTIME.getManifest().icons || {};
        const icon = options.icon || icons["128"] || icons["48"] || Object.values(icons)[0];
        const opts = { type: "basic", title: String(title), message: String(options.body || "") };
        if (icon) opts.iconUrl = /^[a-z-]+:/.test(icon) ? icon : RUNTIME.getURL(icon);
        await (options.tag ? N.create(String(options.tag), opts) : N.create(opts));
      },
      getNotifications: async () => [],
      update: async () => registration,
      unregister: async () => false,
      addEventListener() {}, removeEventListener() {},
    };
    define(g, "registration", registration);
  }

  if (!g.clients) {
    define(g, "clients", {
      async matchAll() {
        const list = [];
        try {
          for (const v of (API.extension && API.extension.getViews ? API.extension.getViews() : [])) {
            if (v !== g) list.push({ url: v.location.href, type: "window", frameType: "top-level", id: v.location.href, postMessage() {} });
          }
        } catch (e) {}
        if (g.__foxsakeOffscreenUrl) list.push({ url: g.__foxsakeOffscreenUrl, type: "window", frameType: "nested", id: "foxsake-offscreen", postMessage() {} });
        return list;
      },
      claim: async () => {},
      get: async () => undefined,
      openWindow: async (url) => API.tabs.create({ url }),
    });
  }

  if (typeof g.skipWaiting !== "function") define(g, "skipWaiting", async () => {});

  if (typeof g.importScripts !== "function") {
    const preloaded = new Set((FOXSAKE.importedScripts || []).map((p) => RUNTIME.getURL(p)));
    define(g, "importScripts", (...urls) => {
      for (const u of urls) {
        const abs = new URL(u, swUrl).href;
        if (preloaded.has(abs)) continue; // already loaded ahead of the service worker file
        console.warn("[foxsake] importScripts(" + u + ") wasn't known ahead of time; loading it asynchronously, which may break load order.");
        const s = document.createElement("script");
        s.src = abs;
        document.documentElement.appendChild(s);
      }
    });
  }

  // Fire the service-worker 'install' and 'activate' events once per extension version.
  const fire = (type) => {
    const ev = new Event(type);
    const waits = [];
    ev.waitUntil = (p) => waits.push(p);
    g.dispatchEvent(ev);
    if (typeof g["on" + type] === "function") { try { g["on" + type](ev); } catch (e) { console.error(e); } }
    return Promise.allSettled(waits);
  };
  g.addEventListener("load", async () => {
    const key = "__foxsake_sw_version";
    const version = RUNTIME.getManifest().version;
    let last = null;
    try { last = g.localStorage.getItem(key); } catch (e) {}
    if (last === version) return;
    await fire("install");
    await fire("activate");
    try { g.localStorage.setItem(key, version); } catch (e) {}
  }, { once: true });
}
