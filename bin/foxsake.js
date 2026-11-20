#!/usr/bin/env node
// Fox Sake CLI: run Chrome Web Store extensions in Zen Browser.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, createWriteStream } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { convert, SOURCE_FILE } from "../src/core/convert.js";
import { renderFindings } from "../src/core/report.js";
import { compareVersions } from "../src/core/webstore.js";
import { readZip } from "../src/core/archive.js";
import { latestVersion } from "../src/node/fetch-crx.js";
import { obtain, doConvert, installAndWait } from "../src/node/pipeline.js";
import { OUT, ROOT, loadRegistry } from "../src/node/library.js";
import { zenBinary, zenGeckoVersion, zenVersion, zenDefaultProfile, installedAddons, profileConfigSnapshot, diffProfileConfig } from "../src/node/zen.js";

const HELP = `Fox Sake: run Chrome Web Store extensions in Zen Browser

Usage:
  foxsake <web store url | extension id | file.crx | file.zip | folder>
                              Convert and install in Zen (same as "add")
  foxsake add <source>        Convert, check, and open Zen's install prompt
  foxsake convert <source>    Convert only (writes out/<name>-<version>.xpi + report)
  foxsake scan <source>       Show the compatibility report without converting
  foxsake install <name|xpi>  Install a converted extension in Zen
  foxsake run <name|source>   Test in a separate test profile, with console logs saved
  foxsake list                Show converted extensions, installed versions, and shims
  foxsake update [name]       Rebuild + reinstall anything with a newer Web Store version

Options:
  --force        (update) rebuild even if the version hasn't changed
  --replace      (add, install) replace an installed extension with a file that didn't come
                 straight from the Chrome Web Store, or with a different build of the same version
  --allow-downgrade
                 (add, install, update) install an older version over a newer one. Older versions
                 can have security holes, and they get all of the installed version's data
  --no-lint      skip web-ext lint
  --fresh        (run) use a brand-new blank test profile for this run
  -h, --help     show this help
`;

const say = (...a) => console.log(...a);
const fail = (msg) => { console.error(`\n✖ ${msg}`); process.exit(1); };

async function main() {
  const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: { force: { type: "boolean" }, replace: { type: "boolean" }, "allow-downgrade": { type: "boolean" }, "no-lint": { type: "boolean" }, fresh: { type: "boolean" }, help: { type: "boolean", short: "h" }, quiet: { type: "boolean" } },
  });
  let [cmd, ...rest] = positionals;
  if (opts.help || !cmd) return say(HELP);
  const COMMANDS = { add, convert: convertCmd, scan, install, run, list, update };
  if (!COMMANDS[cmd]) { rest = [cmd, ...rest]; cmd = "add"; }
  await COMMANDS[cmd](rest, opts);
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

async function scan([input]) {
  const { bytes, chromeId } = await obtain(input);
  // A dry-run conversion in memory (nothing is written) so statuses reflect what Fox Sake would patch.
  const r = await convert(bytes, { chromeId, targetVersion: zenGeckoVersion() ?? undefined });
  say(`\n${r.meta.name} ${r.meta.version}  (Chrome ID ${r.meta.chromeId ?? "unknown"})\n`);
  say(renderFindings(r.classified).replace(/<\/?details>|<summary>.*<\/summary>/g, ""));
  say(`Would inject: ${r.meta.shims.length ? r.meta.shims.join(", ") : "nothing"}`);
  say(`\nNothing was converted. Run "foxsake convert ${input}" to convert it.`);
}

async function convertCmd([input], opts) {
  await doConvert(input, opts);
}

const replaceOpts = (opts, fromStore) => ({ fromStore, replace: !!opts.replace, allowDowngrade: !!opts["allow-downgrade"] });

async function add([input], opts) {
  const { xpiPath, meta, fromStore } = await doConvert(input, opts);
  await installAndWait(xpiPath, meta, replaceOpts(opts, fromStore));
}

function findConverted(nameOrPath) {
  if (nameOrPath && existsSync(resolve(nameOrPath)) && nameOrPath.endsWith(".xpi")) return { xpiPath: resolve(nameOrPath) };
  const reg = loadRegistry();
  const q = String(nameOrPath ?? "").toLowerCase();
  const hits = Object.values(reg.extensions).filter((e) => [e.slug, e.chromeId, e.geckoId, e.name?.toLowerCase()].some((v) => v && String(v).toLowerCase().includes(q)));
  if (hits.length > 1) {
    const exact = hits.find((e) => e.slug === q || e.chromeId === q);
    if (exact) return exact;
    fail(`"${nameOrPath}" matches several: ${hits.map((h) => h.slug).join(", ")}`);
  }
  return hits[0] ?? null;
}

async function install([target], opts) {
  const e = findConverted(target);
  if (!e) fail(`Nothing converted matches "${target}". Run "foxsake list".`);
  if (!existsSync(e.xpiPath)) fail(`The file ${e.xpiPath} is gone; convert it again.`);
  // The version and package fingerprint come from the file itself, not from the registry.
  const meta = { ...e, ...readMetaFromXpi(e.xpiPath) };
  await installAndWait(e.xpiPath, meta, replaceOpts(opts, e.sourceKind === "webstore"));
}

function readMetaFromXpi(xpiPath) {
  const files = readZip(new Uint8Array(readFileSync(xpiPath)));
  const m = JSON.parse(new TextDecoder().decode(files.get("manifest.json")));
  let packageSha256 = null;
  try { packageSha256 = JSON.parse(new TextDecoder().decode(files.get(SOURCE_FILE))).packageSha256 ?? null; } catch { /* converted before 2.0.4 */ }
  return { geckoId: m.browser_specific_settings?.gecko?.id, version: m.version, packageSha256 };
}

async function run([target], opts) {
  let entry = target ? findConverted(target) : null;
  if (!entry) entry = await doConvert(target, opts);
  const xpi = entry.xpiPath;
  const name = basename(xpi, ".xpi");
  const srcDir = join(OUT, "run", name);
  rmSync(srcDir, { recursive: true, force: true });
  for (const [p, data] of readZip(new Uint8Array(readFileSync(xpi)))) {
    const full = join(srcDir, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
  const logDir = join(OUT, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const args = ["run", "--verbose", "--source-dir", srcDir, "--firefox", zenBinary(), "--no-reload",
    "--pref", "devtools.console.stdout.chrome=true", "--pref", "devtools.console.stdout.content=true",
    "--pref", "browser.dom.window.dump.enabled=true", "--pref", "extensions.webextensions.warnings-as-errors=false",
    "--start-url", "about:debugging#/runtime/this-firefox"];
  // Lets scripts/zen-driver.js automate and observe the test window (localhost only).
  if (process.env.FOXSAKE_BIDI_PORT) args.push(`--arg=--remote-debugging-port=${process.env.FOXSAKE_BIDI_PORT}`);
  // A dedicated, persistent test profile. NEVER a copy of the real one: a copy carries the
  // real profile's profile-group ID and registers itself in Zen's profile list.
  const devProfile = join(OUT, opts.fresh ? `dev-profile-fresh-${Date.now()}` : "dev-profile");
  mkdirSync(devProfile, { recursive: true });
  args.push("--firefox-profile", devProfile, "--keep-profile-changes", "--profile-create-if-missing");
  say(`Using Fox Sake's separate test profile (out/${basename(devProfile)}). Your real Zen profile isn't used or touched.`);
  say("Logins you make in this test window stay in the test profile for next time.");
  const before = profileConfigSnapshot();
  say(`▶ Starting a test Zen window. Console output is saved to:\n  ${logPath}\nClose that Zen window (or press Ctrl+C here) to stop.`);
  const log = createWriteStream(logPath);
  const child = spawn(join(ROOT, "node_modules", ".bin", "web-ext"), args, { stdio: ["inherit", "pipe", "pipe"] });
  // --verbose is the only way web-ext forwards the browser's console; drop its own debug chatter.
  const keep = (line) => line && !/^\[[\w/.-]+\]\[debug\]/.test(line);
  for (const s of [child.stdout, child.stderr]) {
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines.filter(keep)) { log.write(line + "\n"); if (!opts.quiet) console.log(line); }
    });
  }
  await new Promise((r) => child.on("exit", r));
  log.end();
  const changed = diffProfileConfig(before, profileConfigSnapshot());
  if (changed.length) {
    console.error(`\n⚠ Zen's profile settings changed during the test run: ${changed.join(", ")}.`);
    console.error("  That should never happen. Don't restart Zen yet; ask for help restoring them.");
    process.exitCode = 2;
  } else say("✔ Zen's profile settings were left untouched.");
}

async function list() {
  const reg = loadRegistry();
  const installed = installedAddons();
  const entries = Object.values(reg.extensions);
  say(`Zen ${zenVersion() ?? "?"} (Firefox ${zenGeckoVersion() ?? "?"}) | profile: ${basename(zenDefaultProfile() ?? "?")}\n`);
  if (!entries.length) return say('Nothing converted yet. Try: foxsake "<chrome web store link>"');
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const inst = installed.get(e.geckoId);
    const state = !inst ? "not installed" : `installed ${inst.version}${inst.active ? "" : " (disabled)"}${inst.location === "app-temporary" ? " (temporary)" : ""}`;
    say(`• ${e.name}  [${e.slug}]`);
    say(`    converted ${e.version} on ${e.convertedAt.slice(0, 10)} | Zen: ${state}`);
    say(`    shims: ${e.shims.length ? e.shims.join(", ") : "none"}${e.unsupported?.length ? ` | won't work: ${e.unsupported.join("; ")}` : ""}`);
    say(`    from: ${e.source}`);
  }
}

async function update([target], opts) {
  const reg = loadRegistry();
  let entries = Object.values(reg.extensions).filter((e) => e.sourceKind === "webstore" && e.chromeId);
  if (target) entries = entries.filter((e) => [e.slug, e.chromeId, e.name?.toLowerCase()].some((v) => v && String(v).toLowerCase().includes(target.toLowerCase())));
  if (!entries.length) return say("Nothing to update (only extensions converted from the Chrome Web Store can be updated).");
  let updated = 0;
  for (const e of entries) {
    let latest;
    try { latest = await latestVersion(e.chromeId); } catch (err) { say(`• ${e.name}: update check failed (${err.message})`); continue; }
    if (!latest) { say(`• ${e.name}: no longer available on the Chrome Web Store`); continue; }
    const newer = compareVersions(latest, e.version) > 0;
    say(`• ${e.name}: converted ${e.version}, store has ${latest}${newer ? " → updating" : opts.force ? " → rebuilding (--force)" : " (up to date)"}`);
    if (!newer && !opts.force) continue;
    const { xpiPath, meta, fromStore } = await doConvert(e.chromeId, opts);
    await installAndWait(xpiPath, meta, replaceOpts(opts, fromStore));
    updated++;
  }
  say(updated ? `\nDone: ${updated} updated.` : "\nEverything is up to date.");
}


main().catch((e) => fail(e.message || String(e)));
