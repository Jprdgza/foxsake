// Static scan of an extension's JavaScript for Chrome-only behaviour.
// It reads code as text and never executes it. Minified code means "mentioned" does not always mean "used";
// the report says so.
import { toText } from "./archive.js";

const JS_EXT = /\.(m?js|cjs)$/i;
const MAX_SCAN_BYTES = 30 * 1024 * 1024;

/** Namespaces Fox Sake shims (so we don't also report them as "unsupported"). */
export const SHIMMED_NAMESPACES = new Set(["offscreen", "sidePanel", "tts", "declarativeContent"]);

/** Fixed detectors. `what` is the human-readable explanation shown in reports. */
function detectors(chromeId) {
  const list = [
    { id: "offscreen", re: /\bchrome\.offscreen\b|\boffscreen\s*\.\s*(?:createDocument|closeDocument|hasDocument)\b/g, what: "Uses chrome.offscreen (hidden helper pages). Firefox has no such API." },
    { id: "sidePanel", re: /\bsidePanel\s*\.\s*(?:setOptions|open|close|setPanelBehavior|getOptions|getPanelBehavior|getLayout)\b/g, what: "Uses chrome.sidePanel. Firefox's closest equivalent is the sidebar (sidebarAction)." },
    { id: "getAuthToken", re: /\bidentity\s*(?:\.\s*getAuthToken|\[\s*["']getAuthToken["']\s*\])/g, what: "Uses chrome.identity.getAuthToken (sign-in through the Chrome browser account). Firefox cannot do this." },
    { id: "getProfileUserInfo", re: /\bidentity\s*(?:\.\s*getProfileUserInfo|\[\s*["']getProfileUserInfo["']\s*\])/g, what: "Asks for the Chrome profile's email. Firefox has no browser-account API; Fox Sake answers 'not signed in', which Chrome also does when signed out." },
    { id: "externalMessaging", re: /\bon(?:Message|Connect)External\b/g, what: "Listens for messages from websites or other extensions (onMessageExternal)." },
    { id: "chromeExtensionUrl", re: /chrome-extension:\/\//g, what: "Contains hardcoded chrome-extension:// URLs. Firefox uses moz-extension:// with a random per-install host." },
    { id: "userAgent", re: /\bnavigator\s*\.\s*userAgent(?:Data)?\b/g, what: "Reads the browser's user-agent. Some extensions refuse to run or change behaviour if they don't see 'Chrome'." },
    { id: "tts", re: /\b(?:chrome|browser)\s*\.\s*tts\b/g, what: "Uses chrome.tts (text-to-speech). Firefox has no extension TTS API." },
    { id: "declarativeContent", re: /\bdeclarativeContent\b/g, what: "Uses chrome.declarativeContent (show the toolbar button only on some pages). Not in Firefox; the button is just always enabled." },
    { id: "importScripts", re: /\bimportScripts\s*\(/g, what: "Service-worker importScripts() calls. Static ones are resolved into the background script list." },
    { id: "docsCanvas", re: /_docs_annotate_canvas_by_ext/g, what: "Uses the Google Docs 'annotated canvas' switch, which exposes Docs text only to allow-listed extension IDs." },
    { id: "serviceWorkerGlobals", re: /\bskipWaiting\s*\(|\bclients\s*\.\s*(?:matchAll|claim|openWindow)\b|\bregistration\s*\.\s*showNotification\b|addEventListener\(\s*["'](?:install|activate)["']/g, what: "Uses service-worker-only globals (self.registration, clients, skipWaiting, install/activate events)." },
    { id: "portLastError", re: /\bonDisconnect\b/g, requires: "lastError", what: "Checks chrome.runtime.lastError when a messaging port disconnects. Firefox reports that error on port.error instead." },
    { id: "storageManaged", re: /\bstorage\s*\.\s*managed\b/g, what: "Reads chrome.storage.managed (admin policy settings). Firefox throws when no policy exists; Chrome returns nothing." },
    { id: "getContexts", re: /\bgetContexts\b/g, what: "Uses chrome.runtime.getContexts (often to check for an offscreen document)." },
    { id: "manifestUpdateUrl", re: /\bupdate_url\b/g, what: "Reads 'update_url' from its manifest, often to tell 'store build' from 'developer build'." },
    { id: "chromeInternalUrls", re: /chrome:\/\/(?:extensions|settings|newtab|flags|downloads|history)\b/g, what: "Links to chrome:// pages, which don't exist in Zen (e.g. chrome://extensions → about:addons). Extensions can't open about: pages, so these links will do nothing." },
  ];
  if (chromeId) list.push({ id: "hardcodedId", re: new RegExp(chromeId, "g"), what: `Contains its own Chrome extension ID (${chromeId}) as text. In Firefox the ID is different.` });
  return list;
}

function lineAt(text, index) {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

function snippet(text, index, length) {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}

function addHit(map, id, file, text, index, length, extra = {}) {
  let f = map.get(id);
  if (!f) map.set(id, (f = { id, count: 0, files: new Set(), examples: [], ...extra }));
  f.count++;
  f.files.add(file);
  if (f.examples.length < 3) f.examples.push({ file, line: lineAt(text, index), snippet: snippet(text, index, length) });
}

/**
 * @param {Map<string, Uint8Array>} files
 * @param {{chromeId?: string, support: ReturnType<import('./support.js').createSupport>}} opts
 * @returns {Map<string, object>} findings keyed by id
 */
export function scanExtension(files, { chromeId, support }) {
  const findings = new Map();
  const dets = detectors(chromeId);
  const apiRe = /\b(?:chrome|browser)\s*\.\s*([a-zA-Z]+)(?:\s*\.\s*([a-zA-Z]+))?/g;

  for (const [path, bytes] of files) {
    if (!JS_EXT.test(path) || bytes.length > MAX_SCAN_BYTES) continue;
    const text = toText(bytes);
    for (const d of dets) {
      if (d.requires && !text.includes(d.requires)) continue; // cheap file-level precondition
      d.re.lastIndex = 0;
      for (let m; (m = d.re.exec(text)); ) addHit(findings, d.id, path, text, m.index, m[0].length, { what: d.what });
    }
    apiRe.lastIndex = 0;
    for (let m; (m = apiRe.exec(text)); ) {
      const [, ns, member] = m;
      // `typeof chrome.loadTimes` / `"x" in chrome.foo` are feature checks, not calls.
      if (/(?:typeof\s*\(?\s*|\bin\s+)$/.test(text.slice(Math.max(0, m.index - 10), m.index))) continue;
      if (SHIMMED_NAMESPACES.has(ns)) continue;
      const nsOk = support.apiNamespace(ns);
      if (nsOk === false || (nsOk === undefined && looksLikeChromeOnlyNamespace(ns))) {
        addHit(findings, `api:${ns}`, path, text, m.index, m[0].length, {
          what: `Uses chrome.${ns}, which Firefox does not support (per MDN compat data).`,
          api: ns,
        });
      } else if (nsOk && member && support.apiMember(ns, member) === false) {
        if (ns === "identity" && member === "getAuthToken") continue; // own detector
        addHit(findings, `api:${ns}.${member}`, path, text, m.index, m[0].length, {
          what: `Uses chrome.${ns}.${member}, which Firefox does not support (per MDN compat data).`,
          api: `${ns}.${member}`,
        });
      }
    }
  }
  return findings;
}

// BCD only lists namespaces Firefox *knows*; Chrome-only ones (gcm, enterprise, …) are simply absent.
// We flag an absent namespace only if it's a real Chrome extension namespace, to avoid noise
// from unrelated objects that happen to be named `browser.something`.
const CHROME_ONLY = new Set([
  "accessibilityFeatures", "audio", "certificateProvider", "debugger", "desktopCapture", "documentScan",
  "enterprise", "fileBrowserHandler", "fileSystemProvider", "fontSettings", "gcm", "input", "instanceID",
  "loginState", "platformKeys", "power", "printerProvider", "printing", "printingMetrics", "processes",
  "readingList", "search", "system", "tabCapture", "ttsEngine", "vpnProvider", "wallpaper", "webAuthenticationProxy",
  "contentSettings", "signedInDevices", "declarativeWebRequest", "socket", "app", "webstore", "loadTimes", "csi",
]);
const looksLikeChromeOnlyNamespace = (ns) => CHROME_ONLY.has(ns);
