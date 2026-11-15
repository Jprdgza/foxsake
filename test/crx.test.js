import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapCrx, CrxError } from "../src/core/crx.js";
import { readZip, toText } from "../src/core/archive.js";
import { makeZip, makeCrx2, makeCrx3, publicKeyDer, idFromKey, realFixture } from "./helpers.js";
import { REAL_FIXTURES } from "./fixtures/list.js";

const zip = makeZip({ "manifest.json": '{"name":"t","version":"1","manifest_version":3}' });
const der = publicKeyDer();

test("CRX3: unwraps ZIP and derives the extension ID from the header", async () => {
  const r = await unwrapCrx(makeCrx3(zip, der));
  assert.equal(r.format, "crx3");
  assert.equal(r.chromeId, idFromKey(der));
  assert.match(toText(readZip(r.zip).get("manifest.json")), /"name":"t"/);
});

test("CRX2: unwraps ZIP and derives the ID from the public key", async () => {
  const r = await unwrapCrx(makeCrx2(zip, der));
  assert.equal(r.format, "crx2");
  assert.equal(r.chromeId, idFromKey(der));
  assert.ok(readZip(r.zip).has("manifest.json"));
});

test("plain ZIP passes through", async () => {
  const r = await unwrapCrx(zip);
  assert.equal(r.format, "zip");
  assert.equal(r.chromeId, null);
});

test("rejects garbage, wrong versions, and lying offsets", async () => {
  await assert.rejects(unwrapCrx(new TextEncoder().encode("hello world, not a crx")), CrxError);
  const bad = makeCrx3(zip, der);
  bad[4] = 9; // version 9
  await assert.rejects(unwrapCrx(bad), /Unsupported CRX version 9/);
  const huge = makeCrx3(zip, der);
  new DataView(huge.buffer).setUint32(8, 0xfffffff0, true); // header length past EOF
  await assert.rejects(unwrapCrx(huge), CrxError);
  const shifted = makeCrx3(zip, der);
  new DataView(shifted.buffer).setUint32(8, new DataView(shifted.buffer).getUint32(8, true) - 3, true);
  await assert.rejects(unwrapCrx(shifted), CrxError);
  await assert.rejects(unwrapCrx(makeCrx3(zip, der).subarray(0, 10)), CrxError);
});

test("rejects a CRX3 whose declared ID doesn't match its key", async () => {
  await assert.rejects(unwrapCrx(makeCrx3(zip, der, { idOverride: new Uint8Array(16) })), /inconsistent/);
});

test("ZIP paths that try to escape the folder are refused", () => {
  assert.throws(() => readZip(makeZip({ "../evil.js": "x" })), /Unsafe/);
});

for (const fx of REAL_FIXTURES) {
  test(`real CRX: ${fx.name}`, { skip: !realFixture(fx.file) && "run `npm run fixtures` first" }, async () => {
    const r = await unwrapCrx(realFixture(fx.file));
    assert.equal(r.format, "crx3");
    assert.equal(r.chromeId, fx.id);
    assert.ok(readZip(r.zip).has("manifest.json"));
  });
}
