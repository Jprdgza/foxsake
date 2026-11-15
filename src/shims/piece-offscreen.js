// Piece: chrome.offscreen. Chrome needs a hidden "offscreen document" because its service
// worker has no DOM. Firefox's background page already has a DOM, so the offscreen page is
// loaded in a hidden iframe inside it. runtime messaging between them keeps working because
// the iframe is a normal extension page.
{
  let frame = null;
  let creating = null;
  const REASONS = ["TESTING", "AUDIO_PLAYBACK", "IFRAME_SCRIPTING", "DOM_SCRAPING", "BLOBS", "DOM_PARSER",
    "USER_MEDIA", "DISPLAY_MEDIA", "WEB_RTC", "CLIPBOARD", "LOCAL_STORAGE", "WORKERS", "BATTERY_STATUS",
    "MATCH_MEDIA", "GEOLOCATION"];

  const offscreen = {
    Reason: Object.fromEntries(REASONS.map((r) => [r, r])),
    createDocument: cbify(async (params = {}) => {
      if (frame || creating) throw new Error("Only a single offscreen document may be created.");
      const url = new URL(params.url, RUNTIME.getURL("/")).href;
      creating = new Promise((resolve, reject) => {
        const f = document.createElement("iframe");
        f.src = url;
        f.style.display = "none";
        f.setAttribute("aria-hidden", "true");
        f.addEventListener("load", () => resolve(f), { once: true });
        f.addEventListener("error", () => reject(new Error("Failed to load offscreen document " + params.url)), { once: true });
        (document.body || document.documentElement).appendChild(f);
      });
      try {
        frame = await creating;
        globalThis.__foxsakeOffscreenUrl = url;
      } finally {
        creating = null;
      }
    }),
    closeDocument: cbify(async () => {
      if (!frame) throw new Error("No current offscreen document.");
      frame.remove();
      frame = null;
      globalThis.__foxsakeOffscreenUrl = null;
    }),
    hasDocument: cbify(async () => !!frame),
  };
  defineApi("offscreen", offscreen);

  // runtime.getContexts: include the emulated offscreen document; strip the type Firefox doesn't know.
  for (const t of TARGETS) {
    const rt = t.runtime;
    const orig = typeof rt.getContexts === "function" ? rt.getContexts.bind(rt) : null;
    define(rt, "getContexts", cbify(async (filter = {}) => {
      const types = filter.contextTypes;
      const wantOffscreen = !types || types.includes("OFFSCREEN_DOCUMENT");
      let real = [];
      const realTypes = types && types.filter((x) => x !== "OFFSCREEN_DOCUMENT");
      if (orig && (!types || realTypes.length)) {
        const f = Object.assign({}, filter);
        if (types) f.contextTypes = realTypes;
        try { real = await orig(f); } catch (e) { real = []; }
      }
      if (wantOffscreen && frame) {
        const url = globalThis.__foxsakeOffscreenUrl;
        const ctx = { contextType: "OFFSCREEN_DOCUMENT", contextId: "foxsake-offscreen", tabId: -1, windowId: -1,
          frameId: -1, documentId: "foxsake-offscreen", documentUrl: url, documentOrigin: new URL(url).origin, incognito: false };
        if (!filter.documentUrls || filter.documentUrls.includes(url)) real = real.concat([ctx]);
      }
      return real;
    }));
  }
}
