#!/usr/bin/env node
// Builds the Fox Sake add-on: addon/ + the converter core (src/core/) + fflate, unminified.
//   out/addon/                    unpacked, for about:debugging or web-ext run
//   out/foxsake-<version>.xpi     the package to install or upload to addons.mozilla.org
//   out/foxsake-<version>-source.zip   (with --source) git archive of HEAD, for AMO's source review
// Nothing is minified or transpiled: the only change to copied files is pointing the core's
// `import ... from "fflate"` at the bundled copy.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { writeZip } from "../src/core/archive.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const OUT = join(ROOT, "out");
const DIST = join(OUT, "addon");

execFileSync(process.execPath, [join(ROOT, "scripts", "build-assets.js")], { stdio: "inherit" });

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(join(ROOT, "addon"), DIST, { recursive: true, filter: (src) => !/(^|\/)\.[^/]+$/.test(src) });

const LIB = join(DIST, "lib");
mkdirSync(join(LIB, "core", "generated"), { recursive: true });
const coreDir = join(ROOT, "src", "core");
for (const f of readdirSync(coreDir).filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(join(coreDir, f), "utf8").replace(/from "fflate";/g, 'from "../fflate.js";');
  writeFileSync(join(LIB, "core", f), src);
}
cpSync(join(coreDir, "generated", "assets.js"), join(LIB, "core", "generated", "assets.js"));
const fflate = join(ROOT, "node_modules", "fflate");
cpSync(join(fflate, "esm", "browser.js"), join(LIB, "fflate.js"));
cpSync(join(fflate, "LICENSE"), join(LIB, "fflate.LICENSE.txt"));

// Every import in the add-on must be a relative file that exists (no bare package names).
const files = new Map();
const walk = (d) => readdirSync(d).forEach((n) => {
  const full = join(d, n);
  if (lstatSync(full).isDirectory()) return walk(full);
  files.set(relative(DIST, full), new Uint8Array(readFileSync(full)));
});
walk(DIST);
for (const [p, bytes] of files) {
  if (!p.endsWith(".js")) continue;
  for (const [, spec] of new TextDecoder().decode(bytes).matchAll(/^\s*(?:import|export)\s[^"'`]*?from\s+["']([^"']+)["']/gm)) {
    if (!spec.startsWith(".")) throw new Error(`${p} imports "${spec}": only relative imports work in the add-on.`);
    const target = join(DIST, p, "..", spec);
    if (!existsSync(target)) throw new Error(`${p} imports missing file ${spec}`);
  }
}

const { version } = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
const xpi = join(OUT, `foxsake-${version}.xpi`);
writeFileSync(xpi, writeZip(files));
console.log(`✔ ${relative(process.cwd(), xpi) || xpi} (${files.size} files)`);

if (process.argv.includes("--source")) {
  const src = join(OUT, `foxsake-${version}-source.zip`);
  execFileSync("git", ["archive", "--format=zip", "-o", src, "HEAD"], { cwd: ROOT });
  console.log(`✔ ${relative(process.cwd(), src) || src} (git HEAD; commit first so it matches the build)`);
}
