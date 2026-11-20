import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteManifest } from "../src/core/manifest.js";
import { createSupport } from "../src/core/support.js";
import { convert } from "../src/core/convert.js";
import { readZip, toBytes, toText } from "../src/core/archive.js";
import { parseExtensionId } from "../src/core/webstore.js";
import { makeZip, makeCrx3, signingKey, idFromKey, realFixture } from "./helpers.js";

const support = createSupport("140.0");
const ID = "abcdefghijklmnopabcdefghijklmnop";
const filesOf = (o) => new Map(Object.entries(o).map(([k, v]) => [k, toBytes(v)]));

test("adds an unguessable gecko ID and strips Chrome-only keys", () => {
  const { manifest, changes } = rewriteManifest(
    { manifest_version: 3, name: "x", version: "1.0", update_url: "https://clients2.google.com/service/update2/crx", key: "abc", minimum_chrome_version: "100", offline_enabled: true, differential_fingerprint: "1.x" },
    { files: new Map(), chromeId: ID, support },
  );
  assert.match(manifest.browser_specific_settings.gecko.id, new RegExp(`^${ID}-[0-9a-f]{16}@foxsake$`));
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "128.0");
  for (const k of ["update_url", "key", "minimum_chrome_version", "offline_enabled", "differential_fingerprint"]) {
    assert.equal(manifest[k], undefined, k);
    assert.ok(changes.some((c) => c.path === k && c.action === "removed"), `logged ${k}`);
  }
});

test("service worker → background.scripts, with static importScripts resolved in order", () => {
  const files = filesOf({
    "js/sw.js": "importScripts('lib/a.js', 'lib/b.js'); importScripts(dynamicName);",
    "js/lib/a.js": "importScripts('../shared/c.js');",
    "js/lib/b.js": "",
    "shared/c.js": "", // "../shared/c.js" resolves against js/sw.js, not js/lib/a.js
  });
  const { manifest, background } = rewriteManifest({ manifest_version: 3, name: "x", version: "1", background: { service_worker: "js/sw.js" } }, { files, chromeId: ID, support });
  assert.deepEqual(manifest.background, { scripts: ["shared/c.js", "js/lib/a.js", "js/lib/b.js", "js/sw.js"] });
  assert.equal(background.wasServiceWorker, true);
  assert.equal(background.dynamicImports.length, 1);
});

test("module service workers keep type: module", () => {
  const { manifest } = rewriteManifest({ manifest_version: 3, name: "x", version: "1", background: { service_worker: "sw.js", type: "module" } }, { files: filesOf({ "sw.js": "" }), chromeId: ID, support });
  assert.deepEqual(manifest.background, { scripts: ["sw.js"], type: "module" });
});

test("side_panel → sidebar_action; use_dynamic_url and unsupported permissions dropped", () => {
  const { manifest, changes } = rewriteManifest({
    manifest_version: 3, name: "x", version: "1", icons: { 16: "i.png" },
    side_panel: { default_path: "panel.html" },
    permissions: ["storage", "sidePanel", "offscreen", "tabs", "gcm"],
    web_accessible_resources: [{ resources: ["a.png"], matches: ["<all_urls>"], use_dynamic_url: true }],
    externally_connectable: { matches: ["https://example.com/*"] },
  }, { files: new Map(), chromeId: ID, support });
  assert.equal(manifest.sidebar_action.default_panel, "panel.html");
  assert.equal(manifest.sidebar_action.open_at_install, false);
  assert.equal(manifest.side_panel, undefined);
  assert.deepEqual(manifest.permissions, ["storage", "tabs"]);
  assert.equal(manifest.web_accessible_resources[0].use_dynamic_url, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  for (const p of ["sidePanel", "offscreen", "gcm"]) assert.ok(changes.some((c) => c.path === `permissions: ${p}`), p);
});

test("parses Chrome Web Store URLs and bare IDs", () => {
  assert.equal(parseExtensionId("https://chromewebstore.google.com/detail/quillbot/iidnbdjijdkbmajdffnidomddglmieko"), "iidnbdjijdkbmajdffnidomddglmieko");
  assert.equal(parseExtensionId("https://chromewebstore.google.com/detail/iidnbdjijdkbmajdffnidomddglmieko?hl=en"), "iidnbdjijdkbmajdffnidomddglmieko");
  assert.equal(parseExtensionId("https://chrome.google.com/webstore/detail/x/iidnbdjijdkbmajdffnidomddglmieko"), "iidnbdjijdkbmajdffnidomddglmieko");
  assert.equal(parseExtensionId("iidnbdjijdkbmajdffnidomddglmieko"), "iidnbdjijdkbmajdffnidomddglmieko");
  assert.equal(parseExtensionId("https://evil.example/detail/iidnbdjijdkbmajdffnidomddglmieko"), null);
});

test("end to end: offscreen + sidePanel + external messaging + chrome-extension URLs", async () => {
  const key = signingKey();
  const id = idFromKey(key.der);
  const crx = makeCrx3(makeZip({
    "manifest.json": JSON.stringify({
      manifest_version: 3, name: "Demo", version: "2.0", update_url: "x",
      background: { service_worker: "sw.js" },
      permissions: ["offscreen", "sidePanel", "storage"],
      side_panel: { default_path: "panel.html" },
      externally_connectable: { matches: ["https://demo.example/*"] },
      content_scripts: [{ matches: ["<all_urls>"], js: ["cs.js"] }],
    }),
    "sw.js": `chrome.offscreen.createDocument({url:"off.html"}); chrome.sidePanel.setOptions({path:"panel.html"}); chrome.runtime.onMessageExternal.addListener(()=>{}); chrome.runtime.sendMessage("${id}", {});`,
    "cs.js": `const u = "chrome-extension://${id}/img/a.png"; if (location.protocol === "chrome-extension:") {}`,
    "panel.html": "<html><head><title>p</title></head><body></body></html>",
    "off.html": "<html><head></head></html>",
    "style.css": `.a{background:url(chrome-extension://__MSG_@@extension_id__/img/a.png)}`,
    "_metadata/verified_contents.json": "[]",
  }), key);

  const r = await convert(crx, { targetVersion: "140.0" });
  const files = readZip(r.xpi);
  const m = JSON.parse(toText(files.get("manifest.json")));
  assert.match(m.browser_specific_settings.gecko.id, new RegExp(`^${id}-[0-9a-f]{16}@foxsake$`));
  assert.equal(m.background.scripts[0], "foxsake/background-shim.js");
  assert.ok(files.has("foxsake/background-shim.js"));
  for (const s of ["offscreen", "sidePanel", "external", "id-remap", "external-bridge"]) assert.ok(r.meta.shims.includes(s), s);
  assert.ok(m.content_scripts.some((c) => c.world === "MAIN" && c.js[0] === "foxsake/external-main.js"));
  assert.equal(m.content_scripts[0].js[0], "foxsake/content-shim.js");
  assert.match(toText(files.get("panel.html")), /<head><script src="\/foxsake\/page-shim.js"><\/script>/);
  const cs = toText(files.get("cs.js"));
  assert.match(cs, /runtime\.getURL\("img\/a\.png"\)/);
  assert.match(cs, /"moz-extension:"/);
  assert.match(toText(files.get("style.css")), /moz-extension:\/\/__MSG_@@extension_id__\/img/);
  assert.ok(![...files.keys()].some((p) => p.startsWith("_metadata/")));
  assert.match(r.report, /Shims injected/);
  // Shim code must at least be syntactically valid JavaScript.
  for (const f of ["foxsake/background-shim.js", "foxsake/content-shim.js", "foxsake/page-shim.js", "foxsake/external-main.js", "foxsake/external-isolated.js"]) {
    assert.doesNotThrow(() => new Function(toText(files.get(f))), f);
  }
});

test("real QuillBot converts with the expected shims", { skip: !realFixture("quillbot.crx") && "run `npm run fixtures` first" }, async () => {
  const r = await convert(realFixture("quillbot.crx"), { targetVersion: "140.0" });
  assert.match(r.meta.geckoId, /^iidnbdjijdkbmajdffnidomddglmieko-[0-9a-f]{16}@foxsake$/);
  assert.ok(r.meta.shims.includes("external-bridge"));
  assert.ok(r.meta.shims.includes("sidePanel"));
  assert.equal(r.manifest.sidebar_action.default_panel, "sidePanel.html");
  assert.equal(r.manifest.background.scripts.at(-1), "quillbot-sw.js");
});

test("search engine icon given as a web URL is replaced with a packaged icon", () => {
  const { manifest } = rewriteManifest({
    manifest_version: 3, name: "x", version: "1", icons: { 16: "i16.png", 48: "i48.png" },
    chrome_settings_overrides: { search_provider: { name: "S", search_url: "https://s.example/?q={searchTerms}", favicon_url: "https://s.example/f.ico", is_default: true } },
  }, { files: new Map(), chromeId: ID, support });
  assert.equal(manifest.chrome_settings_overrides.search_provider.favicon_url, "i16.png");
});

test("webRequestAuthProvider also gets webRequestBlocking; managed storage gets a shim", async () => {
  const r = await convert(makeZip({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "x", version: "1", permissions: ["webRequest", "webRequestAuthProvider"], storage: { managed_schema: "s.json" }, background: { service_worker: "sw.js" } }),
    "sw.js": "chrome.storage.managed.get(null);",
  }), { targetVersion: "160.0" });
  assert.ok(r.manifest.permissions.includes("webRequestBlocking"));
  assert.ok(r.meta.shims.includes("storageManaged"));
});
