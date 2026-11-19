import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { convert } from "../src/core/convert.js";
import { safeFilePart, readZip, toText } from "../src/core/archive.js";
import { downloadCrx, MAX_CRX_BYTES } from "../src/core/webstore.js";
import { makeZip, makeCrx3, signingKey, idFromKey } from "./helpers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("untrusted version strings can't steer output file paths", () => {
  for (const evil of ["../../etc/x", "/abs", "..", "a/b\\c", "1.0 ; rm -rf ~"]) {
    const s = safeFilePart(evil);
    assert.ok(!s.includes("/") && !s.includes("\\") && !s.startsWith("."), `${evil} → ${s}`);
  }
  assert.equal(safeFilePart("4.124.1"), "4.124.1");
  assert.equal(safeFilePart(""), "x");
});

test("unsigned local packages get an ID from their contents, never from their name", async () => {
  const mk = (name, extra = "") => makeZip({ "manifest.json": JSON.stringify({ manifest_version: 3, name, version: "1" }), "x.js": extra });
  const a = await convert(mk("Alpha Tool"), { targetVersion: "140.0" });
  const a2 = await convert(mk("Alpha Tool"), { targetVersion: "140.0" });
  const b = await convert(mk("Alpha Tool", "different code"), { targetVersion: "140.0" });
  assert.match(a.meta.geckoId, /^local-[0-9a-f]{16}@foxsake$/);
  assert.equal(a.meta.chromeId, null);
  assert.equal(a.meta.geckoId, a2.meta.geckoId, "same bytes, same ID");
  assert.notEqual(a.meta.geckoId, b.meta.geckoId, "same name, different contents: different ID");
});

test("manifest.key can't claim another extension's ID", async () => {
  const victim = signingKey();
  const r = await convert(makeZip({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "x", version: "1", key: Buffer.from(victim.der).toString("base64") }) }), { targetVersion: "140.0" });
  assert.match(r.meta.geckoId, /^local-[0-9a-f]{16}@foxsake$/);
  assert.notEqual(r.meta.geckoId, `${idFromKey(victim.der)}@foxsake`);
});

test("a forged CRX carrying a real extension's public key is refused", async () => {
  const victim = signingKey();
  const crx = makeCrx3(makeZip({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Totally Legit Update", version: "99" }) }), victim, { badSignature: true });
  await assert.rejects(convert(crx, { targetVersion: "140.0" }), /signature is invalid/);
});

test("a validly signed CRX keeps its Chrome ID", async () => {
  const k = signingKey("ecdsa");
  const r = await convert(makeCrx3(makeZip({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "x", version: "1" }) }), k), { targetVersion: "140.0" });
  assert.equal(r.meta.geckoId, `${idFromKey(k.der)}@foxsake`);
});

test("store downloads must be signed by the extension that was asked for", async () => {
  const asked = signingKey();
  const other = signingKey();
  const pkg = makeZip({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "x", version: "1" }) });
  const id = idFromKey(asked.der);
  const ok = await convert(makeCrx3(pkg, asked), { chromeId: id, targetVersion: "140.0" });
  assert.equal(ok.meta.geckoId, `${id}@foxsake`);
  await assert.rejects(convert(makeCrx3(pkg, other), { chromeId: id, targetVersion: "140.0" }), /signed as extension/);
  await assert.rejects(convert(pkg, { chromeId: id, targetVersion: "140.0" }), /isn't signed/);
});

test("converted package never contains paths outside its root", async () => {
  const r = await convert(makeZip({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "x", version: "1" }), "a/./b.js": "" }), { targetVersion: "140.0" });
  for (const p of readZip(r.xpi).keys()) assert.ok(!p.includes("..") && !p.startsWith("/"), p);
});

test("folder input doesn't follow symlinks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foxsake-sym-"));
  const secret = mkdtempSync(join(tmpdir(), "foxsake-secret-"));
  try {
    writeFileSync(join(secret, "id_rsa"), "PRIVATE");
    mkdirSync(join(dir, "ext"));
    writeFileSync(join(dir, "ext", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Sym", version: "1" }));
    symlinkSync(secret, join(dir, "ext", "leak"));
    process.env.FOXSAKE_OUT = join(dir, "out");
    const { obtain } = await import("../src/node/pipeline.js");
    const { bytes } = await obtain(join(dir, "ext"));
    const files = readZip(bytes);
    assert.ok(files.has("manifest.json"));
    assert.ok(![...files.keys()].some((p) => p.startsWith("leak")), "symlinked folder was packed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(secret, { recursive: true, force: true });
  }
});

/** A fake fetch() that serves `body` (in chunks) with the given status and headers. */
function fakeFetch({ status = 200, body = new Uint8Array(0), headers = {}, chunk = 1 << 20 } = {}) {
  return async () => ({
    status, ok: status >= 200 && status < 300, statusText: "",
    headers: new Headers(headers),
    body: new ReadableStream({
      start(c) { for (let i = 0; i < body.length; i += chunk) c.enqueue(body.subarray(i, i + chunk)); c.close(); },
    }),
  });
}

test("downloads refuse oversized packages, even without a Content-Length", async () => {
  const id = "a".repeat(32);
  await assert.rejects(downloadCrx(id, { fetch: fakeFetch({ headers: { "content-length": String(MAX_CRX_BYTES + 1) } }) }), /over 300 MB/);
  const big = new Uint8Array(MAX_CRX_BYTES + 1);
  await assert.rejects(downloadCrx(id, { fetch: fakeFetch({ body: big, chunk: 16 << 20 }) }), /over 300 MB/);
});

test("downloads explain missing extensions and reject non-IDs", async () => {
  await assert.rejects(downloadCrx("a".repeat(32), { fetch: fakeFetch({ status: 204 }) }), /no downloadable extension/);
  let called = false;
  const spy = async () => { called = true; };
  for (const bad of ["../../x", "A".repeat(32), "a".repeat(33), ["a".repeat(32)]]) {
    await assert.rejects(downloadCrx(bad, { fetch: spy }), /Not a Chrome extension ID/);
  }
  assert.equal(called, false);
  const ok = await downloadCrx("a".repeat(32), { fetch: fakeFetch({ body: new Uint8Array([1, 2, 3]) }) });
  assert.deepEqual([...ok], [1, 2, 3]);
});

test("bridge shim only accepts the extension's allowed sites (uses Firefox's sender.url)", async () => {
  const r = await convert(makeZip({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "x", version: "1", background: { service_worker: "sw.js" }, externally_connectable: { matches: ["https://*.example.com/*"] } }),
    "sw.js": "chrome.runtime.onMessageExternal.addListener(() => {});",
  }), { targetVersion: "140.0" });
  const bg = toText(readZip(r.xpi).get("foxsake/background-shim.js"));
  assert.match(bg, /"externalMatches":\["https:\/\/\*\.example\.com\/\*"\]/);
  assert.match(bg, /const url = sender\.url;/);
});

test("externally_connectable patterns Chrome rejects don't open the bridge to every site (FS-3)", async () => {
  const mk = (matches) => makeZip({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "x", version: "1", background: { service_worker: "sw.js" }, externally_connectable: { matches } }),
    "sw.js": "chrome.runtime.onMessageExternal.addListener(() => {});",
  });
  const broad = ["*://*/*", "<all_urls>", "https://*.com/*", "https://*.co.uk/*", "https://*.github.io/*", "https://*/*"];
  const r = await convert(mk([...broad, "https://app.example.com/*", "https://*.example.com/*"]), { targetVersion: "140.0" });
  const files = readZip(r.xpi);
  const m = JSON.parse(toText(files.get("manifest.json")));
  const bridge = m.content_scripts.filter((c) => c.js.some((j) => j.startsWith("foxsake/external-")));
  assert.equal(bridge.length, 2);
  for (const c of bridge) assert.deepEqual(c.matches, ["https://app.example.com/*", "https://*.example.com/*"]);
  assert.match(toText(files.get("foxsake/background-shim.js")), /"externalMatches":\["https:\/\/app\.example\.com\/\*","https:\/\/\*\.example\.com\/\*"\]/);
  for (const p of broad) assert.ok(r.report.includes(p), `report lists ${p}`);
  assert.match(r.report, /Ignored externally_connectable\.matches/);

  const none = await convert(mk(broad), { targetVersion: "140.0" });
  const m2 = JSON.parse(toText(readZip(none.xpi).get("manifest.json")));
  assert.ok(!(m2.content_scripts ?? []).some((c) => c.js.some((j) => j.startsWith("foxsake/external-"))), "no bridge at all");
});
