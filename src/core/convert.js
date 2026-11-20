// The converter pipeline: CRX/ZIP bytes in → Firefox .xpi bytes + report out.
// Pure (no file system / network), so it runs in Node or a browser.
import { unwrapCrx } from "./crx.js";
import { readZip, writeZip, findPath, parseLenientJson, toBytes, toText } from "./archive.js";
import { scanExtension } from "./scan.js";
import { rewriteManifest, displayName, slugify } from "./manifest.js";
import { applyShims } from "./shims.js";
import { createSupport, DEFAULT_TARGET } from "./support.js";
import { classifyFindings, renderReport } from "./report.js";

export const FOXSAKE_VERSION = "2.0.4";

/**
 * Opens a package and returns {files, manifest, chromeId, localId, format, packageSha256} without changing anything.
 *
 * The Chrome ID decides which installed add-on (and whose saved data) a conversion replaces, so it
 * only comes from a verified signature. `givenId` is the ID the user asked the Web Store for: the
 * download must be signed with that extension's key. Unsigned local packages have no Chrome ID; they
 * get `localId`, derived from their bytes, so one local file can't take over another's ID.
 * `manifest.key` is ignored: it's a public key anyone can copy.
 * `packageSha256` fingerprints the extension's own files (the ZIP inside a CRX), so two downloads of
 * the same release match even if Google re-signs it.
 */
export async function openPackage(bytes, { chromeId: givenId } = {}) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const crx = await unwrapCrx(bytes);
  if (givenId && crx.chromeId !== givenId) {
    throw new Error(crx.chromeId
      ? `The download is signed as extension ${crx.chromeId}, not ${givenId} as requested. Not converting it.`
      : `The download for ${givenId} isn't signed by that extension. Not converting it.`);
  }
  let files = readZip(crx.zip);

  // ZIPs of an unpacked folder often wrap everything in one top-level directory.
  if (!files.has("manifest.json")) {
    const tops = new Set([...files.keys()].map((p) => p.split("/")[0]));
    const [only] = tops;
    if (tops.size === 1 && files.has(`${only}/manifest.json`)) {
      files = new Map([...files].map(([p, d]) => [p.slice(only.length + 1), d]).filter(([p]) => p));
    }
  }
  const manifestPath = findPath(files, "manifest.json");
  if (!manifestPath) throw new Error("No manifest.json found: this doesn't look like a browser extension.");
  const manifest = parseLenientJson(toText(files.get(manifestPath)));
  if (manifestPath !== "manifest.json") {
    files.set("manifest.json", files.get(manifestPath));
    files.delete(manifestPath);
  }

  const chromeId = crx.chromeId;
  const localId = chromeId ? null : `local-${(await sha256Hex(bytes)).slice(0, 16)}`;
  return { files, manifest, chromeId, localId, format: crx.format, packageSha256: await sha256Hex(crx.zip) };
}

async function sha256Hex(bytes) {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Where a converted add-on records which package it was built from (read back by the CLI). */
export const SOURCE_FILE = "foxsake/source.json";

/** Scan only: what would need patching. */
export async function scanPackage(bytes, opts = {}) {
  const support = createSupport(opts.targetVersion ?? DEFAULT_TARGET);
  const { files, manifest, chromeId, format } = await openPackage(bytes, opts);
  const findings = scanExtension(files, { chromeId, support });
  const name = displayName(manifest, files);
  return { name, version: manifest.version, chromeId, format, manifest, findings, support, fileCount: files.size };
}

/**
 * Full conversion.
 * @param {Uint8Array} bytes CRX or ZIP
 * @param {{chromeId?: string, targetVersion?: string, source?: string, knownIds?: Object<string, string>}} opts
 *   `knownIds` maps an ID base (Chrome ID or local-<hash>) to the Firefox ID already in use for it, so
 *   updates keep the same ID. Without an entry, the conversion gets a new random ID (meta.newId).
 */
export async function convert(bytes, opts = {}) {
  const support = createSupport(opts.targetVersion ?? DEFAULT_TARGET);
  const { files, manifest: original, chromeId, localId, format, packageSha256 } = await openPackage(bytes, opts);
  const name = displayName(original, files);
  const shortName = original.short_name ? displayName({ ...original, name: original.short_name }, files) : null;
  const removedFiles = [];

  // Chrome Web Store signature/hash metadata: meaningless to Firefox.
  for (const p of [...files.keys()]) {
    if (p.startsWith("_metadata/")) { files.delete(p); removedFiles.push(p); }
  }
  if (files.has("foxsake/background-shim.js") || files.has(SOURCE_FILE)) throw new Error("Package already contains Fox Sake shims (was it converted twice?).");

  const findings = scanExtension(files, { chromeId, support });
  const slug = slugify(shortName && !shortName.startsWith("__MSG_") && shortName.length < name.length ? shortName : name);
  const rewritten = rewriteManifest(original, { files, chromeId, localId, support, knownIds: opts.knownIds });
  const manifest = rewritten.manifest;
  const shimResult = applyShims({ files, manifest, original, findings, background: rewritten.background, chromeId, geckoId: rewritten.geckoId });

  const missing = checkReferencedFiles(manifest, files);
  files.set("manifest.json", toBytes(JSON.stringify(manifest, null, 2)));
  files.set(SOURCE_FILE, toBytes(JSON.stringify({ packageSha256, chromeId, version: manifest.version }, null, 2)));
  const xpi = writeZip(files);

  const classified = classifyFindings(findings, shimResult, rewritten.background);
  const meta = {
    name,
    slug,
    version: manifest.version,
    chromeId,
    geckoId: rewritten.geckoId,
    idBase: rewritten.idBase,
    newId: rewritten.newId,
    permissions: declaredPermissions(manifest),
    format,
    packageSha256,
    source: opts.source ?? null,
    shims: shimResult.applied.map((s) => s.id),
    unsupported: classified.filter((f) => f.status === "unsupported").map((f) => f.title),
    convertedAt: new Date().toISOString(),
    foxsakeVersion: FOXSAKE_VERSION,
  };
  const report = renderReport({
    meta, original, manifest, support, classified,
    changes: rewritten.changes, warnings: [...rewritten.warnings, ...missing], notes: shimResult.notes,
    applied: shimResult.applied, urlRewrites: shimResult.urlRewrites, removedFiles, background: rewritten.background,
  });
  return { xpi, manifest, meta, report, classified };
}

/**
 * Every permission the converted manifest asks for, required or optional, API or host, as one sorted
 * list. Optional ones are marked "(optional)". Used to show what an update adds.
 */
export function declaredPermissions(m) {
  const out = new Set();
  const add = (list, optional) => (Array.isArray(list) ? list : []).forEach((p) => {
    if (typeof p === "string") out.add(optional ? `${p} (optional)` : p);
  });
  add(m.permissions, false);
  add(m.host_permissions, false);
  add(m.optional_permissions, true);
  add(m.optional_host_permissions, true);
  // Required beats optional when both list the same thing.
  for (const p of [...out]) if (p.endsWith(" (optional)") && out.has(p.slice(0, -11))) out.delete(p);
  return [...out].sort();
}

function checkReferencedFiles(m, files) {
  const refs = [];
  const add = (p, where) => { if (typeof p === "string" && !/^(https?:|data:|moz-extension:)/.test(p)) refs.push([p.split(/[?#]/)[0], where]); };
  (m.background?.scripts ?? []).forEach((s) => add(s, "background.scripts"));
  add(m.background?.page, "background.page");
  (m.content_scripts ?? []).forEach((cs, i) => [...(cs.js ?? []), ...(cs.css ?? [])].forEach((f) => add(f, `content_scripts[${i}]`)));
  add((m.action ?? m.browser_action)?.default_popup, "action.default_popup");
  add(m.options_page, "options_page");
  add(m.options_ui?.page, "options_ui.page");
  add(m.sidebar_action?.default_panel, "sidebar_action.default_panel");
  return refs.filter(([p]) => !findPath(files, p.replace(/^\//, ""))).map(([p, w]) => `Missing file referenced by ${w}: ${p}`);
}
