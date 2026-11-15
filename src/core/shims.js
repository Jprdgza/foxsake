// Decides which compatibility shims an extension needs (based on the scan + manifest),
// injects them, and rewrites hardcoded chrome-extension:// URLs. Only what's needed is added.
import { shims as SHIM_SOURCES } from "./generated/assets.js";
import { findPath, toBytes, toText } from "./archive.js";

const DIR = "foxsake";
const BG_SHIM = `${DIR}/background-shim.js`;
const CS_SHIM = `${DIR}/content-shim.js`;
const PAGE_SHIM = `${DIR}/page-shim.js`;

/** Every shim Fox Sake knows: which contexts it goes in, and why. */
const PIECES = {
  "id-remap": { file: "piece-id-remap.js", contexts: ["background", "page", "content"], why: "Messages addressed to the old Chrome ID are redirected to the extension's new Firefox ID." },
  "manifest-extras": { file: "piece-manifest-extras.js", contexts: ["background", "page", "content"], why: "chrome.runtime.getManifest() still returns the fields Fox Sake removed (e.g. update_url), so 'is this the store build?' checks keep passing." },
  "sw-globals": { file: "piece-sw-globals.js", contexts: ["background"], why: "Provides service-worker globals (self.registration, clients, skipWaiting, importScripts, install/activate events) in Firefox's background page." },
  offscreen: { file: "piece-offscreen.js", contexts: ["background"], why: "Emulates chrome.offscreen with a hidden iframe in the background page (Firefox background pages already have a DOM)." },
  sidePanel: { file: "piece-sidepanel.js", contexts: ["background", "page"], why: "Maps chrome.sidePanel calls to the Firefox/Zen sidebar." },
  identity: { file: "piece-identity.js", contexts: ["background", "page"], why: "getAuthToken fails with a clear message instead of a crash; getProfileUserInfo reports 'not signed in'." },
  storageManaged: { file: "piece-storage-managed.js", contexts: ["background", "page", "content"], why: "chrome.storage.managed returns an empty result when no admin policy exists (as in Chrome) instead of throwing." },
  portLastError: { file: "piece-port-lasterror.js", contexts: ["background", "page", "content"], why: "Port disconnect errors appear in chrome.runtime.lastError inside onDisconnect listeners, as in Chrome (Firefox puts them on port.error)." },
  tts: { file: "piece-tts.js", contexts: ["background", "page"], why: "Implements chrome.tts with the browser's built-in speech engine." },
  declarativeContent: { file: "piece-declarative-content.js", contexts: ["background"], why: "Accepts chrome.declarativeContent rules as no-ops; the toolbar button stays enabled everywhere." },
  external: { file: "piece-external-messaging.js", contexts: ["background", "page"], why: "Delivers website messages (from the bridge) to onMessageExternal listeners with a Chrome-like sender." },
};

function assemble(pieceIds, context, config) {
  const ids = pieceIds.filter((id) => PIECES[id].contexts.includes(context));
  if (!ids.length) return null;
  const body = ids
    .map((id) => `// --- ${id} ---\ntry {\n${SHIM_SOURCES[PIECES[id].file]}\n} catch (e) { console.warn("[foxsake] shim '${id}' failed to load", e); }`)
    .join("\n\n");
  return `// Fox Sake compatibility shim (${context}). Generated; loaded before the extension's own code.
(() => {
"use strict";
const FOXSAKE = ${JSON.stringify({ ...config, context })};
${SHIM_SOURCES["_prelude.js"]}
${body}
})();
`;
}

const withConfig = (file, config) => SHIM_SOURCES[file].replace("/*FOXSAKE_CONFIG*/{}", JSON.stringify(config));

const matchesDocs = (patterns = []) =>
  patterns.some((p) => p === "<all_urls>" || /^(\*|https):\/\/(\*|\*\.google\.com|docs\.google\.com)\//.test(p));

/**
 * Plans and applies shims. Mutates `files` and `manifest`.
 * @returns {{applied: Array<{id:string, why:string, where:string[]}>, notes: string[], urlRewrites: Array}}
 */
export function applyShims({ files, manifest, original, findings, background, chromeId }) {
  const has = (id) => findings.has(id);
  const origPerms = [...(original.permissions ?? []), ...(original.optional_permissions ?? [])];
  const applied = [];
  const notes = [];
  const pieces = [];
  const need = (id, reason) => { if (!pieces.includes(id)) { pieces.push(id); applied.push({ id, why: PIECES[id].why, trigger: reason, where: PIECES[id].contexts }); } };

  if (has("hardcodedId") && chromeId) need("id-remap", "its own Chrome ID appears in the code");
  const extras = {};
  for (const k of ["update_url", "key", "minimum_chrome_version"]) if (original[k] !== undefined) extras[k] = original[k];
  if (has("manifestUpdateUrl") && Object.keys(extras).length) need("manifest-extras", "the code reads update_url from its manifest");
  if (background?.wasServiceWorker && !background.isModule && (has("serviceWorkerGlobals") || has("importScripts"))) need("sw-globals", "the background was a service worker using SW-only globals");
  if (background?.wasServiceWorker && background.isModule && has("serviceWorkerGlobals")) need("sw-globals", "the background was a service worker using SW-only globals");
  if (has("offscreen") || origPerms.includes("offscreen")) need("offscreen", "uses chrome.offscreen");
  if (has("sidePanel") || original.side_panel) need("sidePanel", "uses chrome.sidePanel / side_panel");
  if (has("getAuthToken") || has("getProfileUserInfo")) need("identity", "uses chrome.identity Chrome-only methods");
  if (has("tts") || origPerms.includes("tts")) need("tts", "uses chrome.tts");
  if (has("portLastError")) need("portLastError", "reads runtime.lastError in onDisconnect handlers");
  if (has("storageManaged") || original.storage?.managed_schema) need("storageManaged", "reads chrome.storage.managed (admin policy settings)");
  if (has("declarativeContent") || origPerms.includes("declarativeContent")) need("declarativeContent", "uses chrome.declarativeContent");
  const ec = original.externally_connectable;
  const ecMatches = (ec?.matches ?? []).filter((p) => typeof p === "string");
  if (ecMatches.length) need("external", "manifest allows websites to message it (externally_connectable)");
  if (ec?.ids?.length) notes.push("externally_connectable.ids (messages from other extensions) works natively in Firefox, but other extensions must use this add-on's new ID (" + (chromeId ?? "?") + "@foxsake).");

  if (pieces.includes("offscreen") && !background) notes.push("Uses chrome.offscreen but has no background script; the offscreen shim only works from the background.");

  const config = {
    chromeId,
    externalMatches: ecMatches,
    manifestExtras: extras,
    swEntry: background?.entry ?? null,
    importedScripts: background?.importedScripts ?? [],
  };

  // --- background ---
  const bgShim = assemble(pieces, "background", config);
  if (bgShim) {
    files.set(BG_SHIM, toBytes(bgShim));
    if (manifest.background?.scripts) manifest.background.scripts.unshift(BG_SHIM);
    else if (manifest.background?.page) injectScriptTag(files, manifest.background.page, BG_SHIM);
  }

  // --- content scripts (isolated world only) ---
  const csShim = assemble(pieces, "content", config);
  if (csShim && Array.isArray(manifest.content_scripts)) {
    files.set(CS_SHIM, toBytes(csShim));
    for (const cs of manifest.content_scripts) {
      if (cs.world === "MAIN" || !Array.isArray(cs.js) || !cs.js.length) continue;
      cs.js.unshift(CS_SHIM);
    }
  }

  // --- extension pages (popup, options, sidebar, offscreen, …) ---
  const pageShim = assemble(pieces, "page", config);
  const bgPage = manifest.background?.page ? findPath(files, manifest.background.page) : null;
  const sandboxed = new Set((manifest.sandbox?.pages ?? []).map((p) => findPath(files, p)).filter(Boolean));
  if (pageShim) {
    files.set(PAGE_SHIM, toBytes(pageShim));
    for (const path of files.keys()) {
      if (!/\.html?$/i.test(path) || path.startsWith(`${DIR}/`) || path === bgPage || sandboxed.has(path)) continue;
      injectScriptTag(files, path, PAGE_SHIM);
    }
  }

  // --- website → extension bridge ---
  if (pieces.includes("external")) {
    files.set(`${DIR}/external-main.js`, toBytes(withConfig("external-main.js", { chromeId })));
    files.set(`${DIR}/external-isolated.js`, toBytes(withConfig("external-isolated.js", { chromeId })));
    manifest.content_scripts = manifest.content_scripts ?? [];
    manifest.content_scripts.push(
      { matches: ecMatches, js: [`${DIR}/external-main.js`], run_at: "document_start", all_frames: true, world: "MAIN" },
      { matches: ecMatches, js: [`${DIR}/external-isolated.js`], run_at: "document_start", all_frames: true },
    );
    applied.push({ id: "external-bridge", why: `Content scripts on ${ecMatches.join(", ")} give those websites chrome.runtime.sendMessage(<extension id>, …) and relay it to the extension.`, trigger: "externally_connectable.matches", where: ["website (MAIN world)", "content script"] });
  }

  // --- Google Docs canvas experiment ---
  const csPatterns = (manifest.content_scripts ?? []).flatMap((c) => c.matches ?? []);
  const hostPatterns = [...(manifest.host_permissions ?? []), ...(manifest.permissions ?? []).filter((p) => String(p).includes("://") || p === "<all_urls>")];
  if (has("docsCanvas") && chromeId && (matchesDocs(csPatterns) || matchesDocs(hostPatterns))) {
    files.set(`${DIR}/docs-canvas.js`, toBytes(withConfig("docs-canvas.js", { chromeId })));
    manifest.content_scripts = manifest.content_scripts ?? [];
    manifest.content_scripts.push({ matches: ["https://docs.google.com/document/*"], js: [`${DIR}/docs-canvas.js`], run_at: "document_start", all_frames: false, world: "MAIN" });
    applied.push({ id: "docs-canvas", why: "Sets Google Docs' annotated-canvas switch to the original Chrome ID before Docs loads (EXPERIMENT: may not work; see report).", trigger: "code references _docs_annotate_canvas_by_ext", where: ["docs.google.com (MAIN world)"] });
  }

  // --- sidebar for extensions that use chrome.sidePanel without declaring side_panel ---
  if (pieces.includes("sidePanel") && !manifest.sidebar_action) {
    files.set(`${DIR}/sidebar-placeholder.html`, toBytes(SHIM_SOURCES["sidebar-placeholder.html"]));
    manifest.sidebar_action = { default_panel: `${DIR}/sidebar-placeholder.html`, default_title: String(manifest.name), open_at_install: false };
    if (manifest.icons) manifest.sidebar_action.default_icon = manifest.icons;
    notes.push("Added a placeholder sidebar: Firefox only exposes the sidebar API when the manifest declares one; the extension sets the real page at runtime.");
  }

  const urlRewrites = rewriteExtensionUrls(files, chromeId);
  return { applied, notes, urlRewrites };
}

function injectScriptTag(files, htmlPath, scriptPath) {
  const p = findPath(files, htmlPath);
  if (!p) return;
  let html = toText(files.get(p));
  if (html.includes(scriptPath)) return;
  const tag = `<script src="/${scriptPath}"></script>`;
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
  else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
  else html = tag + html;
  files.set(p, toBytes(html));
}

// `Function("return this")()` is the classic "get the global object" trick. Firefox blocks it
// (the extension's security policy forbids eval) and, because content scripts see the page
// through Xray wrappers, libraries like lodash fall through to it in Firefox where they
// wouldn't in Chrome; the script then crashes. `globalThis` means exactly the same thing.
const GLOBAL_THIS_RE = /\b(?:new\s+)?Function\(\s*(["'])return this\1\s*\)\(\s*\)/g;

/** Rewrites chrome-extension:// URLs and eval-based global lookups. Returns [{file, count, kind}]. */
export function rewriteExtensionUrls(files, chromeId) {
  const log = [];
  const idRe = chromeId ? chromeId : "(?!)";
  for (const [path, bytes] of files) {
    if (path.startsWith(`${DIR}/`)) continue;
    const isJs = /\.(m?js|cjs)$/i.test(path);
    const isCss = /\.css$/i.test(path);
    const isHtml = /\.html?$/i.test(path);
    if (!isJs && !isCss && !isHtml) continue;
    let text = toText(bytes);
    const original = text;
    let globals = 0;
    if (isJs && text.includes("return this")) {
      text = text.replace(GLOBAL_THIS_RE, () => { globals++; return "globalThis"; });
      if (globals) log.push({ file: path, count: globals, kind: "global" });
    }
    if (!text.includes("chrome-extension:")) {
      if (text !== original) files.set(path, toBytes(text));
      continue;
    }
    let count = 0;
    const sub = (re, fn) => { text = text.replace(re, (...a) => { count++; return typeof fn === "function" ? fn(...a) : fn; }); };

    if (isJs) {
      // "chrome-extension://<ID>/path" → chrome.runtime.getURL("path")
      sub(new RegExp(`(["'])chrome-extension://${idRe}/([^"'\\\\\\n]*)\\1`, "g"), (_, q, p) => `(globalThis.browser||globalThis.chrome).runtime.getURL(${JSON.stringify(p)})`);
      // `chrome-extension://${chrome.runtime.id}` → moz-extension://<internal host>
      sub(/chrome-extension:\/\/\$\{\s*([\w$.]+)\.runtime\.id\s*\}/g, (_, o) => `moz-extension://\${new URL(${o}.runtime.getURL("")).host}`);
      // "chrome-extension://" + chrome.runtime.id + "/…"
      sub(/chrome-extension:\/\/(["'`])\s*\+\s*([\w$.]+)\.runtime\.id\s*\+/g, (_, q, o) => `moz-extension://${q}+new URL(${o}.runtime.getURL("")).host+`);
      // Remaining protocol checks ("chrome-extension:" === location.protocol, startsWith(...))
      sub(/chrome-extension:/g, "moz-extension:");
    } else if (isCss) {
      sub(new RegExp(`chrome-extension://(?:${idRe}|__MSG_@@extension_id__)/`, "g"), "moz-extension://__MSG_@@extension_id__/");
      sub(/chrome-extension:/g, "moz-extension:");
    } else {
      sub(new RegExp(`chrome-extension://(?:${idRe}|__MSG_@@extension_id__)/`, "g"), "/");
      sub(/chrome-extension:/g, "moz-extension:");
    }
    if (count) log.push({ file: path, count, kind: "url" });
    if (text !== original) files.set(path, toBytes(text));
  }
  return log;
}
