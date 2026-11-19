import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readZip, toText } from "../src/core/archive.js";
import { FOXSAKE_VERSION } from "../src/core/convert.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const addonManifest = JSON.parse(readFileSync(join(ROOT, "addon", "manifest.json"), "utf8"));

test("CLI, converter and add-on report the same version", () => {
  assert.equal(pkg.version, FOXSAKE_VERSION);
  assert.equal(addonManifest.version, FOXSAKE_VERSION);
});

test("add-on build bundles the converter core unchanged", () => {
  execFileSync(process.execPath, [join(ROOT, "scripts", "build-addon.js")], { stdio: "pipe" });
  const files = readZip(readFileSync(join(ROOT, "out", `foxsake-${FOXSAKE_VERSION}.xpi`)));
  for (const f of readdirSync(join(ROOT, "src", "core")).filter((f) => f.endsWith(".js"))) {
    const original = readFileSync(join(ROOT, "src", "core", f), "utf8");
    const bundled = toText(files.get(`lib/core/${f}`));
    assert.equal(bundled, original.replace(/from "fflate";/g, 'from "../fflate.js";'), f);
  }
  for (const p of ["manifest.json", "background.js", "content.js", "app/app.html", "app/app.js", "app/worker.js", "lib/fflate.js", "lib/core/generated/assets.js"]) {
    assert.ok(files.has(p), p);
  }
});

test("add-on asks only for the permissions it uses", () => {
  assert.deepEqual(addonManifest.permissions.sort(), ["alarms", "management", "storage"]);
  assert.deepEqual(addonManifest.host_permissions, ["https://clients2.google.com/*", "https://clients2.googleusercontent.com/*"]);
  assert.deepEqual(addonManifest.browser_specific_settings.gecko.data_collection_permissions, { required: ["none"] });
});

test("add-on pages never build HTML from strings", () => {
  for (const f of ["background.js", "content.js", "app/app.js", "app/library.js", "app/worker.js"]) {
    const src = readFileSync(join(ROOT, "addon", f), "utf8");
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, f);
  }
});

test("the library only lists add-ons this Fox Sake converted (FS-5)", async () => {
  execFileSync(process.execPath, [join(ROOT, "scripts", "build-addon.js")], { stdio: "pipe" });
  const ours = "abcdefghijklmnopabcdefghijklmnop@foxsake";
  const local = "local-0123456789abcdef@foxsake";
  const sideloaded = "ponmlkjihgfedcbaponmlkjihgfedcba@foxsake";
  globalThis.browser = {
    management: { getAll: async () => [
      { id: ours, type: "extension", name: "Ours", version: "1", enabled: true },
      { id: local, type: "extension", name: "Local", version: "1", enabled: true },
      { id: sideloaded, type: "extension", name: "Sideloaded", version: "1", enabled: true },
      { id: "button@foxsake", type: "extension", name: "Fox Sake", version: "2", enabled: true },
    ] },
    storage: { local: { get: async () => ({ reports: { [ours]: {}, [local]: {}, "gone@foxsake": {} } }) } },
  };
  try {
    const { convertedAddons } = await import(join(ROOT, "out", "addon", "app", "library.js"));
    const list = await convertedAddons();
    assert.deepEqual(list.map((a) => a.id), [local, ours]);
    assert.equal(list.find((a) => a.id === ours).chromeId, "abcdefghijklmnopabcdefghijklmnop");
    assert.equal(list.find((a) => a.id === local).chromeId, null);
  } finally {
    delete globalThis.browser;
  }
});
