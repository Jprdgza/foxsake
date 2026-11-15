import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { convert } from "../src/core/convert.js";
import { safeFilePart, readZip, toText } from "../src/core/archive.js";
import { downloadCrx, MAX_CRX_BYTES } from "../src/core/webstore.js";
import { makeZip } from "./helpers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("untrusted version strings can't steer output file paths", () => {
  for (const evil of ["../../etc/x", "/abs", "..", "a/b\\c", "1.0 ; rm -rf ~"]) {
    const s = safeFilePart(evil);
    assert.ok(!s.includes("/") && !s.includes("\\") && !s.startsWith("."), `${evil} → ${s}`);
  }
  assert.equal(safeFilePart("4.124.1"), "4.124.1");
  assert.equal(safeFilePart(""), "x");
});

test("local packages without a Chrome ID get distinct Firefox IDs", async () => {
  const mk = (name) => makeZip({ "manifest.json": JSON.stringify({ manifest_version: 3, name, version: "1" }) });
  const a = await convert(mk("Alpha Tool"), { targetVersion: "140.0" });
  const b = await convert(mk("Beta Tool"), { targetVersion: "140.0" });
  assert.equal(a.meta.geckoId, "local-alpha-tool@foxsake");
  assert.notEqual(a.meta.geckoId, b.meta.geckoId);
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
