// Fox Sake shim prelude: helpers shared by every shim piece. Runs inside an IIFE
// where `FOXSAKE` (config) is already defined. Must be valid in both classic and module scripts.
const C = globalThis.chrome;
const B = globalThis.browser;
const TARGETS = [C, B].filter((x, i, a) => x && a.indexOf(x) === i);
const API = C || B;
const RUNTIME = API && API.runtime;

/** Sets a property even when plain assignment is blocked. Returns true on success. */
function define(obj, prop, value) {
  if (!obj) return false;
  try {
    Object.defineProperty(obj, prop, { value, configurable: true, writable: true, enumerable: true });
  } catch (e) {
    try { obj[prop] = value; } catch (e2) { /* ignore */ }
  }
  return obj[prop] === value;
}

/** Adds an API namespace (e.g. chrome.offscreen) to chrome and browser if it isn't there. */
function defineApi(ns, value) {
  for (const t of TARGETS) if (!t[ns]) define(t, ns, value);
}

/** Temporarily sets chrome.runtime.lastError while a Chrome-style callback runs. */
function withLastError(err, fn) {
  const rts = TARGETS.map((t) => t.runtime).filter(Boolean);
  const saved = rts.map((rt) => Object.getOwnPropertyDescriptor(rt, "lastError"));
  const value = { message: String((err && err.message) || err) };
  rts.forEach((rt) => { try { Object.defineProperty(rt, "lastError", { get: () => value, configurable: true }); } catch (e) {} });
  try { fn(); } finally {
    rts.forEach((rt, i) => {
      try {
        if (saved[i]) Object.defineProperty(rt, "lastError", saved[i]);
        else delete rt.lastError;
      } catch (e) {}
    });
  }
}

/**
 * Wraps fn so it supports both Chrome calling styles: promise-returning, or a trailing callback.
 * fn is called synchronously (important: some Firefox APIs need the user-gesture context).
 */
function cbify(fn) {
  return function (...args) {
    const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
    let p;
    try { p = Promise.resolve(fn.apply(this, args)); } catch (e) { p = Promise.reject(e); }
    if (!cb) return p;
    p.then((r) => cb(r), (e) => withLastError(e, () => cb()));
    return undefined;
  };
}

/** A do-nothing event object (addListener/removeListener/hasListener). */
function stubEvent() {
  const set = new Set();
  return {
    addListener: (fn) => set.add(fn),
    removeListener: (fn) => set.delete(fn),
    hasListener: (fn) => set.has(fn),
    hasListeners: () => set.size > 0,
    _fire: (...a) => set.forEach((fn) => { try { fn(...a); } catch (e) { console.error(e); } }),
  };
}
