// FS-8: the add-on notices when a converted extension is replaced by a file it didn't install.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ID = "abcdefghijklmnopabcdefghijklmnop-0011223344556677@foxsake";
let lib;

/** A fake `browser` with in-memory storage and a list of installed add-ons. */
function fakeBrowser(addons, stored = {}) {
  const store = structuredClone(stored);
  const calls = [];
  const badge = {};
  globalThis.browser = {
    storage: { local: {
      get: async (keys) => {
        const list = keys == null ? Object.keys(store) : [keys].flat();
        return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
      },
      set: async (obj) => { Object.assign(store, structuredClone(obj)); },
    } },
    management: new Proxy({
      getAll: async () => addons,
      get: async (id) => { const a = addons.find((x) => x.id === id); if (!a) throw new Error("no"); return a; },
    }, { get: (t, k) => { calls.push(k); return t[k]; } }),
    action: { setBadgeText: async ({ text }) => { badge.text = text; }, setBadgeBackgroundColor: async () => {} },
  };
  return { store, calls, badge };
}

before(async () => {
  // The add-on's layout (app/ next to lib/core/), copied to its own folder so other test files that
  // rebuild out/addon at the same time can't interfere.
  const dir = mkdtempSync(join(tmpdir(), "foxsake-addon-"));
  mkdirSync(join(dir, "app"));
  mkdirSync(join(dir, "lib", "core"), { recursive: true });
  cpSync(join(ROOT, "addon", "app", "library.js"), join(dir, "app", "library.js"));
  for (const f of readdirSync(join(ROOT, "src", "core")).filter((f) => f.endsWith(".js"))) {
    cpSync(join(ROOT, "src", "core", f), join(dir, "lib", "core", f));
  }
  lib = await import(join(dir, "app", "library.js"));
});

const tracked = { reports: { [ID]: {} } };
const v = (version) => ({ id: ID, name: "Victim", version, type: "extension", enabled: true });

test("a foreign install of a converted add-on's ID is flagged", async () => {
  const { store, calls, badge } = fakeBrowser([v("5.0")], tracked);
  assert.equal(await lib.noteInstalled(v("5.0")), "foreign");
  assert.equal(store.flagged[ID].version, "5.0");
  assert.equal(badge.text, "!");
  assert.deepEqual((await lib.replacedAddons()).map((a) => a.id), [ID]);
  assert.equal(await lib.noteInstalled(v("5.0")), "flagged", "the same event twice opens one warning");
  assert.ok(!calls.includes("setEnabled") && !calls.includes("uninstall"), "nothing is changed automatically");
});

test("Fox Sake's own install and update aren't flagged", async () => {
  const { store } = fakeBrowser([v("5.0")], tracked);
  await lib.expectInstall({ geckoId: ID, version: "5.0", packageSha256: "a".repeat(64), permissions: ["storage"] });
  assert.equal(await lib.noteInstalled(v("5.0")), "ours");
  assert.equal(await lib.noteInstalled(v("5.0")), "ours", "the page and the background can both see the event");
  assert.deepEqual(store.installs[ID], { version: "5.0", sha256: "a".repeat(64), permissions: ["storage"] });
  await lib.expectInstall({ geckoId: ID, version: "5.1", packageSha256: "b".repeat(64), permissions: ["storage"] });
  assert.equal(await lib.noteInstalled(v("5.1")), "ours");
  assert.equal(store.flagged, undefined);
});

test("a token is only good for its version and for 15 minutes", async () => {
  fakeBrowser([v("6.6")], tracked);
  await lib.expectInstall({ geckoId: ID, version: "5.1" });
  assert.equal(await lib.noteInstalled(v("6.6")), "foreign", "wrong version");
  fakeBrowser([v("5.1")], tracked);
  await lib.expectInstall({ geckoId: ID, version: "5.1" });
  assert.equal(await lib.noteInstalled(v("5.1"), Date.now() + 16 * 60 * 1000), "foreign", "expired");
});

test("add-ons that aren't Fox Sake conversions are ignored", async () => {
  const { store } = fakeBrowser([], tracked);
  assert.equal(await lib.noteInstalled({ id: "pw@example", version: "1" }), null);
  assert.equal(await lib.noteInstalled({ id: "button@foxsake", version: "9" }), null);
  assert.equal(store.flagged, undefined);
});

test("version changes made while Fox Sake was asleep are caught later", async () => {
  // First look: no record yet, so the current version becomes the baseline.
  let fake = fakeBrowser([v("5.0")], tracked);
  assert.deepEqual(await lib.checkReplacements(), []);
  assert.equal(fake.store.installs[ID].version, "5.0");
  // Someone installs 5.0.1 while nothing is listening.
  fake = fakeBrowser([v("5.0.1")], { ...tracked, installs: fake.store.installs });
  assert.deepEqual(await lib.checkReplacements(), [ID]);
  assert.deepEqual(await lib.checkReplacements(), [], "flagged once");
  // Fox Sake's own update, finished after the page was closed: the token covers it.
  fake = fakeBrowser([v("5.2")], { ...tracked, installs: { [ID]: { version: "5.0" } } });
  await lib.expectInstall({ geckoId: ID, version: "5.2", packageSha256: "c".repeat(64) });
  assert.deepEqual(await lib.checkReplacements(), []);
  assert.equal(fake.store.installs[ID].sha256, "c".repeat(64));
});

test("'I installed it myself' clears the warning; uninstalling forgets it", async () => {
  const { store, badge } = fakeBrowser([v("5.0.1")], { ...tracked, installs: { [ID]: { version: "5.0" } } });
  await lib.checkReplacements();
  assert.equal(badge.text, "!");
  await lib.trustReplacement(ID);
  assert.deepEqual(store.flagged, {});
  assert.equal(store.installs[ID].version, "5.0.1");
  assert.equal(badge.text, "");
  await lib.forgetAddon(ID);
  assert.equal(store.installs[ID], undefined);
});

test("the library and update checks understand both ID forms", async () => {
  const legacy = "ponmlkjihgfedcbaponmlkjihgfedcba@foxsake";
  fakeBrowser([v("1"), { id: legacy, name: "Old", version: "1", type: "extension", enabled: true }],
    { reports: { [ID]: {}, [legacy]: {} }, ids: { "local-0123456789abcdef": "local-0123456789abcdef-8899aabbccddeeff@foxsake" } });
  const list = await lib.convertedAddons();
  assert.deepEqual(list.map((a) => a.chromeId).sort(), ["abcdefghijklmnopabcdefghijklmnop", "ponmlkjihgfedcbaponmlkjihgfedcba"]);
  assert.deepEqual(await lib.idsForConversion(), {
    "local-0123456789abcdef": "local-0123456789abcdef-8899aabbccddeeff@foxsake",
    abcdefghijklmnopabcdefghijklmnop: ID,
    ponmlkjihgfedcbaponmlkjihgfedcba: legacy,
  });
});
