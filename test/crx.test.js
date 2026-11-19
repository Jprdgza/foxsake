import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unwrapCrx, CrxError } from "../src/core/crx.js";
import { readZip, toText } from "../src/core/archive.js";
import { makeZip, makeCrx2, makeCrx3, signingKey, idFromKey, realFixture } from "./helpers.js";
import { REAL_FIXTURES } from "./fixtures/list.js";

const zip = makeZip({ "manifest.json": '{"name":"t","version":"1","manifest_version":3}' });
const key = signingKey("rsa");
const ecKey = signingKey("ecdsa");
const publisher = signingKey("rsa"); // stands in for the Web Store's own publisher key

test("CRX3 (RSA): verifies the signature, unwraps the ZIP, and takes the ID from the signing key", async () => {
  const r = await unwrapCrx(makeCrx3(zip, key));
  assert.equal(r.format, "crx3");
  assert.equal(r.verified, true);
  assert.equal(r.chromeId, idFromKey(key.der));
  assert.match(toText(readZip(r.zip).get("manifest.json")), /"name":"t"/);
});

test("CRX3 (ECDSA P-256) verifies", async () => {
  const r = await unwrapCrx(makeCrx3(zip, ecKey));
  assert.equal(r.verified, true);
  assert.equal(r.chromeId, idFromKey(ecKey.der));
});

test("CRX3 with a second (publisher) signature: every signature must verify", async () => {
  const r = await unwrapCrx(makeCrx3(zip, [key, publisher]));
  assert.equal(r.chromeId, idFromKey(key.der));
});

test("CRX2: verifies the RSA/SHA-1 signature and derives the ID from the key", async () => {
  const r = await unwrapCrx(makeCrx2(zip, key));
  assert.equal(r.format, "crx2");
  assert.equal(r.verified, true);
  assert.equal(r.chromeId, idFromKey(key.der));
  assert.ok(readZip(r.zip).has("manifest.json"));
});

test("plain ZIP passes through, unverified and without an ID", async () => {
  const r = await unwrapCrx(zip);
  assert.equal(r.format, "zip");
  assert.equal(r.verified, false);
  assert.equal(r.chromeId, null);
});

test("forged CRX3: a real public key with a fake signature is rejected", async () => {
  await assert.rejects(unwrapCrx(makeCrx3(zip, key, { badSignature: true })), /signature is invalid/);
  await assert.rejects(unwrapCrx(makeCrx3(zip, ecKey, { badSignature: true })), /signature is invalid/);
});

test("CRX3 whose ZIP was changed after signing is rejected", async () => {
  const crx = makeCrx3(zip, key);
  crx[crx.length - 30] ^= 1;
  await assert.rejects(unwrapCrx(crx), /signature is invalid/);
});

test("CRX3 whose crx_id was changed after signing is rejected", async () => {
  const crx = makeCrx3(zip, key);
  const want = createHash("sha256").update(key.der).digest().subarray(0, 16);
  const at = Buffer.from(crx).indexOf(want);
  crx[at] ^= 1;
  await assert.rejects(unwrapCrx(crx), /signature is invalid/);
});

test("CRX3 signed by the wrong key for its crx_id is rejected", async () => {
  // Validly signed, but crx_id names a key that isn't in the file.
  await assert.rejects(unwrapCrx(makeCrx3(zip, key, { idOverride: new Uint8Array(16) })), /inconsistent/);
});

test("CRX3 with a good signature plus a forged one is rejected", async () => {
  const good = makeCrx3(zip, [key]);
  const forged = makeCrx3(zip, [key, publisher], { badSignature: true });
  await unwrapCrx(good);
  await assert.rejects(unwrapCrx(forged), /signature is invalid/);
});

test("forged CRX2 is rejected", async () => {
  await assert.rejects(unwrapCrx(makeCrx2(zip, key, { badSignature: true })), /signature is invalid/);
});

test("rejects garbage, wrong versions, and lying offsets", async () => {
  await assert.rejects(unwrapCrx(new TextEncoder().encode("hello world, not a crx")), CrxError);
  const bad = makeCrx3(zip, key);
  bad[4] = 9; // version 9
  await assert.rejects(unwrapCrx(bad), /Unsupported CRX version 9/);
  const huge = makeCrx3(zip, key);
  new DataView(huge.buffer).setUint32(8, 0xfffffff0, true); // header length past EOF
  await assert.rejects(unwrapCrx(huge), CrxError);
  const shifted = makeCrx3(zip, key);
  new DataView(shifted.buffer).setUint32(8, new DataView(shifted.buffer).getUint32(8, true) - 3, true);
  await assert.rejects(unwrapCrx(shifted), CrxError);
  await assert.rejects(unwrapCrx(makeCrx3(zip, key).subarray(0, 10)), CrxError);
});

test("ZIP paths that try to escape the folder are refused", () => {
  assert.throws(() => readZip(makeZip({ "../evil.js": "x" })), /Unsafe/);
});

for (const fx of REAL_FIXTURES) {
  test(`real CRX: ${fx.name}`, { skip: !realFixture(fx.file) && "run `npm run fixtures` first" }, async () => {
    const r = await unwrapCrx(realFixture(fx.file));
    assert.equal(r.format, "crx3");
    assert.equal(r.verified, true);
    assert.equal(r.chromeId, fx.id);
    assert.ok(readZip(r.zip).has("manifest.json"));
  });
}
