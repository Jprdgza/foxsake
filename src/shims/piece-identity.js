// Piece: chrome.identity Chrome-only methods. Firefox has no browser-level Google account, so
// getAuthToken fails with a clear message (no fake tokens). getProfileUserInfo answers
// "not signed in", which is exactly what Chrome returns for signed-out users.
{
  let I = API.identity;
  if (!I) { I = {}; defineApi("identity", I); I = API.identity || I; }
  const UNSUPPORTED = "chrome.identity.getAuthToken is not available in Firefox/Zen: it signs in with the Chrome browser's Google account, which Zen doesn't have. Fox Sake cannot emulate it.";
  if (typeof I.getAuthToken !== "function") define(I, "getAuthToken", cbify(async () => { throw new Error(UNSUPPORTED); }));
  if (typeof I.getProfileUserInfo !== "function") define(I, "getProfileUserInfo", cbify(async () => ({ email: "", id: "" })));
  if (typeof I.removeCachedAuthToken !== "function") define(I, "removeCachedAuthToken", cbify(async () => {}));
  if (typeof I.clearAllCachedAuthTokens !== "function") define(I, "clearAllCachedAuthTokens", cbify(async () => {}));
  if (typeof I.getAccounts !== "function") define(I, "getAccounts", cbify(async () => []));
  if (!I.onSignInChanged) define(I, "onSignInChanged", stubEvent());
}
