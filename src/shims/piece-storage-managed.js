// Piece: chrome.storage.managed (settings pushed by an administrator's policy). With no policy
// installed, Chrome returns an empty result while Firefox throws "Managed storage manifest not
// found". Return the empty result, as Chrome does.
for (const t of TARGETS) {
  const managed = t.storage && t.storage.managed;
  if (!managed || typeof managed.get !== "function") continue;
  const orig = managed.get;
  define(managed, "get", cbify(async (...args) => {
    try { return await orig.apply(managed, args); } catch (e) {
      if (/managed storage manifest not found/i.test(String(e && e.message))) return {};
      throw e;
    }
  }));
}
