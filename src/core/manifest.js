// Rewrites a Chrome manifest.json into one Firefox accepts. Every change is logged with a reason.
import { findPath, resolveRelative, toText } from "./archive.js";

export const GECKO_SUFFIX = "@foxsake";
export const STRICT_MIN_VERSION = "128.0"; // first Firefox with MAIN-world content scripts

/** Keys Chrome uses that Firefox has no use for, with a plain-English reason. */
const KNOWN_DROPS = {
  update_url: "Points at Google's update server; Fox Sake handles updates itself (`foxsake update`).",
  key: "Chrome's public signing key; meaningless to Firefox.",
  minimum_chrome_version: "Chrome-only version gate.",
  offline_enabled: "Chrome-only (Chrome apps) flag.",
  differential_fingerprint: "Chrome Web Store internal field.",
  oauth2: "Configuration for chrome.identity.getAuthToken, which Firefox does not have.",
  current_locale: "Chrome-internal field.",
  storage: "Only holds `managed_schema` (admin-policy settings), which Firefox does not support.",
  side_panel: "Converted to Firefox's `sidebar_action` (see below).",
  externally_connectable: "Firefox doesn't support website → extension messaging natively; Fox Sake adds a bridge instead.",
  import: "Depends on a Chrome 'shared module' extension. Firefox has no equivalent: this can't work.",
  export: "Chrome 'shared module' declaration; Firefox has no equivalent.",
  trial_tokens: "Chrome origin-trial tokens.",
  requirements: "Chrome hardware requirement hints (3D/plugins).",
};

const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * @returns {{manifest: object, changes: Array<{path:string, action:string, before?:any, after?:any, reason:string}>, background: object|null, warnings: string[]}}
 */
export function rewriteManifest(original, { files, chromeId, support, fallbackSlug }) {
  const m = clone(original);
  const changes = [];
  const warnings = [];
  const log = (path, action, reason, before, after) => changes.push({ path, action, reason, before, after });

  if (m.manifest_version !== 3 && m.manifest_version !== 2) {
    warnings.push(`Unexpected manifest_version ${m.manifest_version}.`);
  }

  // --- Firefox ID: deterministic so reinstalls/updates keep data and logins ---
  // Without a Chrome ID (local packages with no "key"), fall back to the name so two different
  // local extensions don't share one Firefox ID and overwrite each other.
  const geckoId = `${chromeId ?? `local-${(fallbackSlug || "extension").replace(/[^a-z0-9-]/g, "")}`}${GECKO_SUFFIX}`;
  const bss = m.browser_specific_settings ?? {};
  const before = clone(bss);
  bss.gecko = { ...(bss.gecko ?? {}), id: geckoId, strict_min_version: STRICT_MIN_VERSION };
  delete bss.gecko.update_url;
  m.browser_specific_settings = bss;
  delete m.applications;
  log("browser_specific_settings.gecko", "set", "Gives the add-on a fixed Firefox ID (<chromeId>@foxsake) so updates keep its saved data, and sets the minimum Firefox version.", before.gecko, bss.gecko);

  // --- Background: service worker → event page scripts ---
  let background = null;
  if (m.background?.service_worker) {
    const sw = m.background.service_worker;
    const swPath = findPath(files, sw);
    if (!swPath) warnings.push(`Background service worker "${sw}" is missing from the package.`);
    const isModule = m.background.type === "module";
    const imports = swPath && !isModule ? collectImportScripts(files, swPath, warnings) : { scripts: [], dynamic: [] };
    const scripts = [...imports.scripts, swPath ?? sw];
    const newBg = { scripts };
    if (isModule) newBg.type = "module";
    log("background", "converted", "Firefox runs extension backgrounds as 'event pages' (background.scripts), not service workers." +
      (imports.scripts.length ? ` Static importScripts() files were added in load order: ${imports.scripts.join(", ")}.` : ""),
      clone(m.background), newBg);
    m.background = newBg;
    background = { wasServiceWorker: true, isModule, entry: swPath ?? sw, importedScripts: imports.scripts, dynamicImports: imports.dynamic };
  } else if (m.background) {
    background = { wasServiceWorker: false, isModule: m.background.type === "module" };
    if (m.background.scripts) m.background.scripts = m.background.scripts.map((s) => findPath(files, s) ?? s);
  }

  // --- side_panel → sidebar_action ---
  if (m.side_panel?.default_path) {
    const sidebar = {
      default_panel: m.side_panel.default_path,
      default_title: (m.action ?? m.browser_action)?.default_title ?? m.name,
      open_at_install: false,
    };
    if (m.icons) sidebar.default_icon = m.icons;
    m.sidebar_action = sidebar;
    log("sidebar_action", "added", "Chrome's side panel becomes a Firefox/Zen sidebar with the same page. It does not open by itself at install, matching Chrome.", m.side_panel, sidebar);
  }

  // --- author: Chrome accepts {"email": "..."}; Firefox requires a string ---
  if (m.author && typeof m.author === "object") {
    const str = m.author.name ?? m.author.email ?? null;
    log("author", str ? "changed" : "removed", "Firefox requires author to be plain text; Chrome also allows an object.", original.author, str ?? undefined);
    if (str) m.author = String(str); else delete m.author;
  }

  // --- search engine icon: Firefox MV3 only accepts a file inside the add-on, not a web URL ---
  const sp = m.chrome_settings_overrides?.search_provider;
  if (sp && typeof sp.favicon_url === "string" && /^(https?:)?\/\//i.test(sp.favicon_url)) {
    const icons = m.icons ?? {};
    const local = icons["32"] ?? icons["16"] ?? icons["48"] ?? Object.values(icons)[0];
    log("chrome_settings_overrides.search_provider.favicon_url", local ? "changed" : "removed",
      "Firefox (MV3) only accepts a search-engine icon packaged inside the add-on; a web address makes Firefox reject the whole add-on as 'corrupt'.",
      sp.favicon_url, local);
    if (local) sp.favicon_url = local; else delete sp.favicon_url;
  }

  // --- incognito: split may be unsupported on older Firefox ---
  if (m.incognito === "split" && support.manifestSubKey("incognito", "split") === false) {
    log("incognito", "changed", '"split" isn\'t supported by this Firefox version; "spanning" is the closest.', "split", "spanning");
    m.incognito = "spanning";
  }

  // --- web_accessible_resources: drop use_dynamic_url and other unsupported sub-keys ---
  if (Array.isArray(m.web_accessible_resources) && m.manifest_version === 3) {
    m.web_accessible_resources.forEach((entry, i) => {
      if (entry && typeof entry === "object" && "use_dynamic_url" in entry) {
        log(`web_accessible_resources[${i}].use_dynamic_url`, "removed", "Not supported by Firefox (Firefox's extension URLs are already random per install).", entry.use_dynamic_url);
        delete entry.use_dynamic_url;
      }
    });
  }

  // --- Unsupported sub-keys inside object/array-valued keys (BCD-driven) ---
  for (const key of ["content_scripts", "action", "browser_action", "commands", "chrome_url_overrides", "options_ui", "sandbox"]) {
    const val = m[key];
    const items = Array.isArray(val) ? val.map((v, i) => [`${key}[${i}]`, v]) : val && typeof val === "object" ? [[key, val]] : [];
    for (const [path, obj] of items) {
      if (!obj || typeof obj !== "object") continue;
      for (const sub of Object.keys(obj)) {
        if (key === "commands") continue; // command names are user-defined; BCD's entries are key names, not sub-keys
        if (support.manifestSubKey(key, sub) === false) {
          log(`${path}.${sub}`, "removed", `Firefox ${support.target} doesn't support this setting (MDN compat data).`, obj[sub]);
          delete obj[sub];
        }
      }
    }
  }
  if (m.chrome_url_overrides) {
    for (const k of Object.keys(m.chrome_url_overrides)) {
      if (k !== "newtab") {
        log(`chrome_url_overrides.${k}`, "removed", "Firefox only lets extensions replace the New Tab page.", m.chrome_url_overrides[k]);
        delete m.chrome_url_overrides[k];
      }
    }
    if (!Object.keys(m.chrome_url_overrides).length) delete m.chrome_url_overrides;
  }

  // --- Permissions: drop what Firefox rejects (BCD), log each ---
  for (const listKey of ["permissions", "optional_permissions"]) {
    if (!Array.isArray(m[listKey])) continue;
    const kept = [];
    for (const perm of m[listKey]) {
      const isHost = typeof perm === "string" && (perm.includes("://") || perm === "<all_urls>" || perm.includes("*"));
      if (isHost || support.permission(perm) === true) {
        kept.push(perm);
      } else {
        const why = support.permission(perm) === false ? `Firefox ${support.target} doesn't support it` : "Firefox doesn't recognize it";
        log(`${listKey}: ${perm}`, "removed", `${why} (MDN compat data).${PERMISSION_NOTES[perm] ? " " + PERMISSION_NOTES[perm] : ""}`, perm);
      }
    }
    m[listKey] = kept;
    if (!kept.length) delete m[listKey];
  }

  // --- Chrome MV3 grants blocking auth listeners via webRequestAuthProvider; Firefox also wants
  //     webRequestBlocking for a "blocking" listener (found via LastPass) ---
  if (Array.isArray(m.permissions) && m.permissions.includes("webRequestAuthProvider") && !m.permissions.includes("webRequestBlocking")) {
    m.permissions.push("webRequestBlocking");
    log("permissions: webRequestBlocking", "added", "Firefox requires it for blocking webRequest listeners, which Chrome allows here via webRequestAuthProvider.", undefined, "webRequestBlocking");
  }

  // --- Top-level keys Firefox doesn't support ---
  for (const key of Object.keys(m)) {
    if (key === "browser_specific_settings" || key === "sidebar_action") continue;
    if (key in KNOWN_DROPS) {
      log(key, "removed", KNOWN_DROPS[key], original[key]);
      if (key === "import") warnings.push("This extension depends on a Chrome shared module (manifest 'import'). That cannot work in Firefox.");
      delete m[key];
      continue;
    }
    const s = support.manifestKey(key);
    if (s === false || s === undefined) {
      log(key, "removed", s === false ? `Firefox ${support.target} doesn't support this key (MDN compat data).` : "Not a manifest key Firefox knows (MDN compat data).", original[key]);
      delete m[key];
    }
  }

  return { manifest: m, changes, background, warnings, geckoId };
}

const PERMISSION_NOTES = {
  offscreen: "Fox Sake emulates offscreen documents instead.",
  sidePanel: "Mapped to Firefox's sidebar instead.",
  tts: "Fox Sake provides chrome.tts via the browser's speech engine instead.",
  declarativeContent: "Fox Sake stubs chrome.declarativeContent; the toolbar button is simply always enabled.",
  identity: "",
};

/** Follows static importScripts("a.js", 'b.js') calls (recursively) in a classic service worker. */
function collectImportScripts(files, entry, warnings) {
  const scripts = [];
  const dynamic = [];
  const seen = new Set([entry]);
  const visit = (file) => {
    const bytes = files.get(file);
    if (!bytes) return;
    const text = toText(bytes);
    const callRe = /\bimportScripts\s*\(([^)]*)\)/g;
    for (let m; (m = callRe.exec(text)); ) {
      const args = m[1].trim();
      const literals = [...args.matchAll(/(["'`])([^"'`]+?)\1/g)].map((x) => x[2]);
      const isStatic = literals.length && args.replace(/(["'`])[^"'`]*?\1/g, "").replace(/[\s,]/g, "") === "";
      if (!isStatic) {
        if (args) dynamic.push(`${file}: importScripts(${args.slice(0, 80)})`);
        continue;
      }
      for (const lit of literals) {
        if (/^(https?:)?\/\//.test(lit)) {
          dynamic.push(`${file}: remote script ${lit} (not allowed in Firefox MV3)`);
          continue;
        }
        // Per the worker spec, importScripts URLs resolve against the service worker's own URL.
        let resolved = null;
        try { resolved = findPath(files, resolveRelative(entry, lit)); } catch {}
        if (!resolved) {
          warnings.push(`importScripts("${lit}") in ${file} points to a missing file.`);
          continue;
        }
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        visit(resolved); // nested imports load first, as they would at runtime
        scripts.push(resolved);
      }
    }
  };
  visit(entry);
  return { scripts, dynamic };
}

/** Resolves __MSG_name__ in the manifest name using default_locale messages (for nicer file names). */
export function displayName(manifest, files) {
  const raw = String(manifest.name ?? "extension");
  const m = /^__MSG_(.+)__$/.exec(raw);
  if (!m) return raw;
  const locale = manifest.default_locale ?? "en";
  for (const loc of [locale, locale.replace("-", "_"), "en", "en_US"]) {
    const p = findPath(files, `_locales/${loc}/messages.json`);
    if (!p) continue;
    try {
      const msgs = JSON.parse(toText(files.get(p)));
      const key = Object.keys(msgs).find((k) => k.toLowerCase() === m[1].toLowerCase());
      if (key) return msgs[key].message;
    } catch {}
  }
  return raw;
}

export const slugify = (name) =>
  String(name).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 60) || "extension";
