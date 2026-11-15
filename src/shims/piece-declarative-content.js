// Piece: chrome.declarativeContent (show the toolbar button only on matching pages).
// Firefox has no equivalent; rules are accepted and ignored, and the toolbar button stays
// enabled everywhere. A global action.disable() (used to hide the button until a rule
// matches) is ignored so the button doesn't end up permanently disabled.
{
  class Noop { constructor(o) { Object.assign(this, o || {}); } }
  const onPageChanged = Object.assign(stubEvent(), {
    addRules: (rules, cb) => { if (cb) cb(rules || []); },
    removeRules: (ids, cb) => { const f = typeof ids === "function" ? ids : cb; if (f) f(); },
    getRules: (ids, cb) => { const f = typeof ids === "function" ? ids : cb; if (f) f([]); },
  });
  defineApi("declarativeContent", {
    onPageChanged, PageStateMatcher: Noop, ShowAction: Noop, ShowPageAction: Noop, SetIcon: Noop, RequestContentScript: Noop,
  });
  for (const t of TARGETS) {
    const action = t.action || t.browserAction;
    if (!action || typeof action.disable !== "function") continue;
    const orig = action.disable;
    define(action, "disable", function (tabId, cb) {
      if (tabId == null || typeof tabId === "function") {
        const f = typeof tabId === "function" ? tabId : cb;
        if (f) f();
        return Promise.resolve();
      }
      return orig.apply(action, arguments);
    });
  }
}
