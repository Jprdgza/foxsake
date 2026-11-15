// The conversion pipeline shared by the CLI and the "Add to Zen" button's native helper:
// get the package → convert → save xpi/report/original → lint → record → (optionally) install.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { convert } from "../core/convert.js";
import { parseExtensionId } from "../core/webstore.js";
import { writeZip, safePath, safeFilePart } from "../core/archive.js";
import { downloadCrx, readLocal } from "./fetch-crx.js";
import { lintXpi, renderLint } from "./lint.js";
import { OUT, ORIGINALS, ensureDirs, recordConversion } from "./library.js";
import { zenGeckoVersion, installedAddons, openInZen, addonFileMtime } from "./zen.js";

/** Where progress messages go (the CLI prints them; the native helper collects them). */
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
  return { xpiPath, reportPath, meta };
}

/** Throws (with a plain-English reason) if Firefox would reject this package. */
export function assertInstallable(meta) {
  const b = meta.lint?.blocking ?? [];
  if (b.length) {
    throw new Error(`Not opening Zen's install prompt: Firefox would reject this add-on as "corrupt" because of a manifest problem Fox Sake doesn't fix yet:\n  ${b.join("\n  ")}\nThe report has details.`);
  }
}

export async function installAndWait(xpiPath, meta) {
  assertInstallable(meta);
  const before = installedAddons().get(meta.geckoId);
  const beforeMtime = addonFileMtime(meta.geckoId);
  say(`\n🦊 Opening Zen's install prompt. In Zen, click "Add" (and "Okay" if asked).`);
  if (before) say(`  (Updating ${before.version} → ${meta.version}. Saved data and logins are kept: same Firefox ID.)`);
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

