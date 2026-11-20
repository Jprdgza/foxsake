// The CLI's conversion pipeline:
// get the package → convert → save xpi/report/original → lint → record → (optionally) install.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { convert } from "../core/convert.js";
import { parseExtensionId } from "../core/webstore.js";
import { writeZip, safePath, safeFilePart } from "../core/archive.js";
import { downloadCrx, readLocal } from "./fetch-crx.js";
import { lintXpi, renderLint } from "./lint.js";
import { OUT, ORIGINALS, ensureDirs, recordConversion } from "./library.js";
import { zenGeckoVersion, installedAddons, openInZen, addonFileMtime, installedPackageSha256 } from "./zen.js";
import { checkReplacement } from "../core/replace.js";

/** Where progress messages go (printed by default; tests can redirect them). */
export const output = { say: (...a) => console.log(...a) };
const say = (...a) => output.say(...a);
const fail = (msg) => { throw new Error(msg); };


/** Turns user input into package bytes. Downloaded content is treated as data only. */
export async function obtain(input) {
  if (!input) fail("Tell me what to convert: a Chrome Web Store link, an extension ID, or a .crx/.zip file.");
  const asPath = resolve(input);
  if (existsSync(asPath)) {
    if (statSync(asPath).isDirectory()) return { bytes: zipFolder(asPath), source: asPath, chromeId: null, downloaded: false };
    return { bytes: readLocal(asPath), source: asPath, chromeId: null, downloaded: false };
  }
  const id = parseExtensionId(input);
  if (!id) fail(`"${input}" isn't a file, a Chrome Web Store link, or a 32-letter extension ID.`);
  say(`↓ Downloading ${id} from the Chrome Web Store…`);
  const bytes = await downloadCrx(id);
  say(`  ${(bytes.length / 1024).toFixed(0)} KB`);
  return { bytes, source: `https://chromewebstore.google.com/detail/${id}`, chromeId: id, downloaded: true };
}

function zipFolder(dir) {
  const files = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue; // never follow links out of the folder
      if (st.isDirectory()) walk(full);
      else files.set(safePath(relative(dir, full)), new Uint8Array(readFileSync(full)));
    }
  };
  walk(dir);
  return writeZip(files);
}

/** Converts and writes out/<slug>-<version>.xpi + out/<slug>.report.md. Returns paths + meta. */
export async function doConvert(input, opts = {}) {
  const pkg = await obtain(input);
  ensureDirs();
  const gecko = zenGeckoVersion();
  say("⚙ Converting…");
  const result = await convert(pkg.bytes, { chromeId: pkg.chromeId, targetVersion: gecko ?? undefined, source: pkg.source });
  const { meta } = result;
  if (pkg.downloaded) writeFileSync(join(ORIGINALS, `${safeFilePart(meta.chromeId)}-${safeFilePart(meta.version)}.crx`), pkg.bytes);

  // The version comes from the (untrusted) package, so it's sanitized before going into a path.
  const xpiPath = join(OUT, `${safeFilePart(meta.slug)}-${safeFilePart(meta.version)}.xpi`);
  writeFileSync(xpiPath, result.xpi);
  let report = result.report;
  if (!opts["no-lint"]) {
    say("🔎 Running web-ext lint…");
    const lint = await lintXpi(result.xpi);
    report += "\n" + renderLint(lint);
    // Errors in manifest.json make Firefox reject the add-on as "corrupt", so they block installing.
    // Exception: name/short_name length limits only apply on addons.mozilla.org (verified: Zen
    // installs Grammarly, whose name is longer than 45 characters).
    const amoOnly = (e) => /^\/(name|short_name)$/.test(e.instancePath ?? "") || /"\/(name|short_name)" must NOT have more than/.test(e.message ?? "");
    const blocking = lint.errors.filter((e) => (!e.file || e.file === "manifest.json") && !amoOnly(e)).map((e) => `${e.code}: ${e.message}`);
    meta.lint = { errors: lint.errors.length, warnings: lint.warnings.length, blocking };
  }
  const reportPath = join(OUT, `${safeFilePart(meta.slug)}.report.md`);
  writeFileSync(reportPath, report);
  recordConversion(meta, { xpiPath, reportPath, source: pkg.source, sourceKind: pkg.downloaded ? "webstore" : "file" });

  say(`\n✔ ${meta.name} ${meta.version} → ${relative(process.cwd(), xpiPath) || xpiPath}`);
  say(`  Firefox ID: ${meta.geckoId}`);
  say(`  Shims: ${meta.shims.length ? meta.shims.join(", ") : "none needed"}`);
  if (meta.unsupported.length) say(`  ⚠ Won't work in Firefox: ${meta.unsupported.join("; ")}`);
  if (meta.lint) say(`  Lint: ${meta.lint.errors} error(s), ${meta.lint.warnings} warning(s)`);
  say(`  Report: ${relative(process.cwd(), reportPath) || reportPath}`);
  return { xpiPath, reportPath, meta, fromStore: pkg.downloaded };
}

/** Throws (with a plain-English reason) if Firefox would reject this package. */
export function assertInstallable(meta) {
  const b = meta.lint?.blocking ?? [];
  if (b.length) {
    throw new Error(`Not opening Zen's install prompt: Firefox would reject this add-on as "corrupt" because of a manifest problem Fox Sake doesn't fix yet:\n  ${b.join("\n  ")}\nThe report has details.`);
  }
}

/**
 * Throws (with a plain-English reason) if installing would replace the installed add-on with an older
 * version, a different build of the same version, or a file that didn't come from the store, unless
 * the matching option was given. The replacement would get all of the installed add-on's saved data.
 * `installed` is {version, sha256} or null; `meta` needs version and packageSha256.
 */
export function assertReplaceable(meta, installed, { fromStore = false, allowDowngrade = false, replace = false } = {}) {
  const check = checkReplacement({ installed, incoming: { version: meta.version, sha256: meta.packageSha256 ?? null }, fromStore });
  const name = meta.name ?? meta.geckoId;
  if (check.kind === "downgrade" && !allowDowngrade) {
    throw new Error(`Not installing: ${name} ${installed.version} is installed and this is the older ${meta.version}. ` +
      `Older versions can have security holes that were fixed later, and this one would get all of the installed version's ` +
      `settings, logins and other saved data. If you really need the older version, run the same command with --allow-downgrade.`);
  }
  if (check.kind !== "downgrade" && check.confirm && !replace) {
    const why = {
      "different-build": `it is version ${meta.version}, the same as the installed one, but it isn't the same build: its contents differ`,
      "unknown-build": `it is version ${meta.version}, the same as the installed one, and Fox Sake can't confirm it's the same build`,
      upgrade: "it didn't come straight from the Chrome Web Store",
    }[check.kind];
    throw new Error(`Not installing: this would replace the installed ${name} ${installed.version} and get all of its settings, ` +
      `logins and other saved data, and ${why}. If you trust where it came from, run the same command with --replace.`);
  }
  return check;
}

export async function installAndWait(xpiPath, meta, opts = {}) {
  assertInstallable(meta);
  const before = installedAddons().get(meta.geckoId);
  const installedSha = before && installedPackageSha256(meta.geckoId);
  const check = assertReplaceable(meta, before ? { version: before.version, sha256: installedSha } : null, opts);
  if (check.kind === "downgrade") say(`⚠ Installing the older ${meta.version} over ${before.version} (--allow-downgrade).`);
  const beforeMtime = addonFileMtime(meta.geckoId);
  say(`\n🦊 Opening Zen's install prompt. In Zen, click "Add" (and "Okay" if asked).`);
  if (before && check.kind !== "downgrade") say(`  (Replacing ${before.version} with ${meta.version}. Saved data and logins are kept: same Firefox ID.)`);
  openInZen(xpiPath);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = installedAddons().get(meta.geckoId);
    if (now && now.version === meta.version && addonFileMtime(meta.geckoId) !== beforeMtime) {
      if (now.location === "app-temporary") say("⚠ Installed only temporarily (it will disappear on restart).");
      else say(`✔ Installed permanently in Zen (${now.active ? "enabled" : "disabled"}).`);
      return true;
    }
  }
  say("… I didn't see the install finish within 2 minutes. If you clicked Add, run `foxsake list` to check.");
  return false;
}

