// Piece: chrome.sidePanel → Firefox/Zen sidebar (sidebarAction).
// Limits: Firefox can't enable/disable the sidebar per tab, and open() only works right after a
// user click (same rule as Chrome).
{
  const SB = API.sidebarAction;
  if (SB) {
    const KEY = "__foxsake_sidepanel_behavior";
    let behavior = { openPanelOnActionClick: false };
    try { behavior = Object.assign(behavior, JSON.parse(globalThis.localStorage.getItem(KEY) || "{}")); } catch (e) {}
    const base = RUNTIME.getURL("/");
    const tabArg = (tabId) => (tabId != null ? { tabId } : {});

    if (FOXSAKE.context === "background") {
      const action = API.action || API.browserAction;
      // Must stay synchronous: sidebarAction.toggle() requires the click's user-gesture context.
      if (action && action.onClicked) action.onClicked.addListener(() => { if (behavior.openPanelOnActionClick) SB.toggle(); });
    }

    const sync = (fn) => function (opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = undefined; }
      let p;
      try { p = Promise.resolve(fn(opts || {})); } catch (e) { p = Promise.reject(e); }
      if (!cb) return p;
      p.then(() => cb(), (e) => withLastError(e, () => cb()));
    };

    defineApi("sidePanel", {
      setOptions: cbify(async ({ tabId, path } = {}) => {
        if (path) await SB.setPanel(Object.assign({ panel: new URL(path, base).href }, tabArg(tabId)));
      }),
      getOptions: cbify(async ({ tabId } = {}) => {
        const panel = await SB.getPanel(tabArg(tabId));
        return Object.assign({ enabled: true, path: panel && panel.startsWith(base) ? panel.slice(base.length) : panel }, tabArg(tabId));
      }),
      setPanelBehavior: cbify(async (b = {}) => {
        behavior = Object.assign({}, behavior, b);
        try { globalThis.localStorage.setItem(KEY, JSON.stringify(behavior)); } catch (e) {}
      }),
      getPanelBehavior: cbify(async () => Object.assign({}, behavior)),
      open: sync(() => SB.open()),
      close: sync(() => SB.close()),
      getLayout: cbify(async () => ({ side: "left" })),
      onOpened: stubEvent(),
      onClosed: stubEvent(),
    });
  }
}
