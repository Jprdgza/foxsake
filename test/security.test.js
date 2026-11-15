import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { convert } from "../src/core/convert.js";
import { safeFilePart, readZip, toText } from "../src/core/archive.js";
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

/** Sends one native-messaging frame to the helper and returns its parsed reply. */
function askHelper(payload, rawBody) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(ROOT, "src", "node", "native-host.js")]);
    let out = Buffer.alloc(0);
    p.stdout.on("data", (d) => (out = Buffer.concat([out, d])));
    p.on("exit", () => resolve(out.length >= 4 ? JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString()) : null));
    const body = rawBody ?? Buffer.from(JSON.stringify(payload));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    p.stdin.write(Buffer.concat([head, body]));
    p.stdin.end();
  });
}

test("button helper rejects anything but a 32-letter extension ID", async () => {
  for (const bad of [
    { action: "add", id: "../../etc/passwd" },
    { action: "add", id: "/Users/me/evil.crx" },
    { action: "add", id: "ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP" },
    { action: "add", id: "abcdefghijklmnopabcdefghijklmnopq" },
    { action: "run", id: "abcdefghijklmnopabcdefghijklmnop" },
    { action: "add", id: ["abcdefghijklmnopabcdefghijklmnop"] },
  ]) {
    const r = await askHelper(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /Invalid request/);
  }
});

test("button helper survives malformed input", async () => {
  const r = await askHelper(null, Buffer.from("{not json"));
  assert.equal(r.ok, false);
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
