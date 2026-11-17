// The converter pipeline: CRX/ZIP bytes in → Firefox .xpi bytes + report out.
// Pure (no file system / network), so it runs in Node or a browser.
import { unwrapCrx, chromeIdFromPublicKey } from "./crx.js";
import { readZip, writeZip, findPath, parseLenientJson, toBytes, toText } from "./archive.js";
import { scanExtension } from "./scan.js";
import { rewriteManifest, displayName, slugify } from "./manifest.js";
import { applyShims } from "./shims.js";
import { createSupport, DEFAULT_TARGET } from "./support.js";
import { classifyFindings, renderReport } from "./report.js";

export const FOXSAKE_VERSION = "2.0.1";

/** Opens a package and returns {files, manifest, chromeId, format} without changing anything. */
export async function openPackage(bytes, { chromeId: givenId } = {}) {
  const crx = await unwrapCrx(bytes);
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

  let chromeId = crx.chromeId ?? givenId ?? null;
  if (!chromeId && typeof manifest.key === "string") {
    try {
      const der = Uint8Array.from(atob(manifest.key.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
      chromeId = await chromeIdFromPublicKey(der);
    } catch {}
  }
  return { files, manifest, chromeId, format: crx.format };
}

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
 * @param {{chromeId?: string, targetVersion?: string, source?: string}} opts
 */
export async function convert(bytes, opts = {}) {
  const support = createSupport(opts.targetVersion ?? DEFAULT_TARGET);
  const { files, manifest: original, chromeId, format } = await openPackage(bytes, opts);
  const name = displayName(original, files);
  const shortName = original.short_name ? displayName({ ...original, name: original.short_name }, files) : null;
  const removedFiles = [];

  // Chrome Web Store signature/hash metadata: meaningless to Firefox.
  for (const p of [...files.keys()]) {
    if (p.startsWith("_metadata/")) { files.delete(p); removedFiles.push(p); }
  }
  if (files.has("foxsake/background-shim.js")) throw new Error("Package already contains Fox Sake shims (was it converted twice?).");

  const findings = scanExtension(files, { chromeId, support });
  const slug = slugify(shortName && !shortName.startsWith("__MSG_") && shortName.length < name.length ? shortName : name);
  const rewritten = rewriteManifest(original, { files, chromeId, support, fallbackSlug: slug });
  const manifest = rewritten.manifest;
  const shimResult = applyShims({ files, manifest, original, findings, background: rewritten.background, chromeId });

  const missing = checkReferencedFiles(manifest, files);
  files.set("manifest.json", toBytes(JSON.stringify(manifest, null, 2)));
  const xpi = writeZip(files);

  const classified = classifyFindings(findings, shimResult, rewritten.background);
  const meta = {
    name,
    slug,
    version: manifest.version,
    chromeId,
    geckoId: rewritten.geckoId,
    format,
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
