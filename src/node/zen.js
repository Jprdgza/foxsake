// Locates Zen on this Mac (binary, Gecko version, default profile) and reads which add-ons are
// installed. Read-only: never modifies Zen's files.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { readZip } from "../core/archive.js";
import { SOURCE_FILE, declaredPermissions } from "../core/convert.js";

const SUPPORT_DIR = join(homedir(), "Library", "Application Support", "zen");

export function findZenApp() {
  const candidates = [process.env.FOXSAKE_ZEN_APP, "/Applications/Zen.app", join(homedir(), "Applications", "Zen.app")].filter(Boolean);
  for (const c of candidates) if (existsSync(join(c, "Contents", "MacOS", "zen"))) return c;
  try {
    const found = execFileSync("mdfind", ["kMDItemCFBundleIdentifier == 'app.zen-browser.zen'"], { encoding: "utf8" }).split("\n").find(Boolean);
    if (found && existsSync(join(found, "Contents", "MacOS", "zen"))) return found;
  } catch {}
  return null;
}

export function zenBinary() {
  const app = findZenApp();
  if (!app) throw new Error("Couldn't find Zen. Install it in /Applications, or set FOXSAKE_ZEN_APP=/path/to/Zen.app.");
  return join(app, "Contents", "MacOS", "zen");
}

/** The Gecko (Firefox engine) version Zen is built on, e.g. "160.0". */
export function zenGeckoVersion() {
  const app = findZenApp();
  if (!app) return null;
  for (const ini of ["Contents/Resources/application.ini", "Contents/Resources/platform.ini"]) {
    try {
      const text = readFileSync(join(app, ini), "utf8");
      const m = /^MaxVersion=([\d.]+)/m.exec(text) || /^Milestone=([\d.]+)/m.exec(text);
      if (m) return m[1];
    } catch {}
  }
  return null;
}

export function zenVersion() {
  const app = findZenApp();
  try { return /^Version=(.+)$/m.exec(readFileSync(join(app, "Contents/Resources/application.ini"), "utf8"))?.[1] ?? null; } catch { return null; }
}

/** Default profile directory (from profiles.ini's [Install…] section, else the first profile). */
export function zenDefaultProfile() {
  const iniPath = join(SUPPORT_DIR, "profiles.ini");
  if (!existsSync(iniPath)) return null;
  const sections = {};
  let cur = null;
  for (const line of readFileSync(iniPath, "utf8").split(/\r?\n/)) {
    const h = /^\[(.+)\]$/.exec(line.trim());
    if (h) { cur = sections[h[1]] = {}; continue; }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (kv && cur) cur[kv[1].trim()] = kv[2].trim();
  }
  const install = Object.entries(sections).find(([k, v]) => k.startsWith("Install") && v.Default);
  let rel = install?.[1].Default;
  if (!rel) {
    const prof = Object.values(sections).find((s) => s.Default === "1" && s.Path) ?? Object.values(sections).find((s) => s.Path);
    rel = prof?.Path;
  }
  if (!rel) return null;
  return rel.startsWith("/") ? rel : join(SUPPORT_DIR, rel);
}

/** Add-ons Zen has installed in the profile: Map<id, {version, active, location, signedState}>. */
export function installedAddons(profileDir = zenDefaultProfile()) {
  const map = new Map();
  if (!profileDir) return map;
  try {
    const json = JSON.parse(readFileSync(join(profileDir, "extensions.json"), "utf8"));
    for (const a of json.addons ?? []) {
      map.set(a.id, { version: a.version, active: a.active, userDisabled: a.userDisabled, location: a.location, signedState: a.signedState, name: a.defaultLocale?.name });
    }
  } catch {}
  return map;
}

export function isZenRunning() {
  try {
    return execFileSync("pgrep", ["-f", "Zen.app/Contents/MacOS/zen"], { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Hands an .xpi to Zen, which shows its "Add <name>?" prompt (the user clicks Add).
 * On macOS `open -a Zen file.xpi` does nothing, but passing a file:// URL to
 * Zen's own binary works whether or not Zen is already running.
 */
export function openInZen(xpiPath) {
  const child = spawn(zenBinary(), ["--new-tab", pathToFileURL(xpiPath).href], { detached: true, stdio: "ignore" });
  child.unref();
}

/**
 * The package fingerprint Fox Sake recorded inside an installed add-on (null if it has none, e.g.
 * converted by a version before 2.0.4). Only used to tell whether a same-version replacement is the
 * same build.
 */
export function installedPackageSha256(id, profileDir = zenDefaultProfile()) {
  try {
    const files = readZip(new Uint8Array(readFileSync(join(profileDir, "extensions", `${id}.xpi`))));
    const sha = JSON.parse(new TextDecoder().decode(files.get(SOURCE_FILE))).packageSha256;
    return typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Everything the installed version of an add-on declares (see declaredPermissions), or null. */
export function installedPermissions(id, profileDir = zenDefaultProfile()) {
  try {
    const files = readZip(new Uint8Array(readFileSync(join(profileDir, "extensions", `${id}.xpi`))));
    return declaredPermissions(JSON.parse(new TextDecoder().decode(files.get("manifest.json"))));
  } catch {
    return null;
  }
}

/** Modification time of the installed add-on file (changes on every reinstall). */
export function addonFileMtime(id, profileDir = zenDefaultProfile()) {
  try { return statSync(join(profileDir, "extensions", `${id}.xpi`)).mtimeMs; } catch { return null; }
}

/**
 * Snapshot of Zen's profile bookkeeping (profiles.ini, installs.ini, profile-group databases).
 * Taken before/after test runs: a test browser must never change these. A copied
 * profile keeps its profile-group ID and re-registers itself in the group; see docs/design.md.
 */
export function profileConfigSnapshot() {
  const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
  const snap = { ini: read(join(SUPPORT_DIR, "profiles.ini")), installs: read(join(SUPPORT_DIR, "installs.ini")), groups: {} };
  const dir = join(SUPPORT_DIR, "Profile Groups");
  try {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sqlite"))) {
      try { snap.groups[f] = execFileSync("sqlite3", ["-readonly", join(dir, f), "SELECT id, path FROM Profiles ORDER BY id;"], { encoding: "utf8" }); } catch {}
    }
  } catch {}
  return snap;
}

export function diffProfileConfig(a, b) {
  const out = [];
  if (a.ini !== b.ini) out.push("profiles.ini");
  if (a.installs !== b.installs) out.push("installs.ini");
  for (const k of new Set([...Object.keys(a.groups), ...Object.keys(b.groups)])) if (a.groups[k] !== b.groups[k]) out.push(`Profile Groups/${k}`);
  return out;
}
