// FS-6: an installed extension can't be replaced by an older version, a different build of the same
// version, or (without saying so) a file from outside the store. The replacement would get its data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convert } from "../src/core/convert.js";
import { checkReplacement } from "../src/core/replace.js";
import { assertReplaceable } from "../src/node/pipeline.js";
import { installedPackageSha256 } from "../src/node/zen.js";
import { readZip, toText } from "../src/core/archive.js";
import { makeZip, makeCrx2, makeCrx3, signingKey, idFromKey } from "./helpers.js";

const victim = signingKey();
const victimId = idFromKey(victim.der);
const ext = (version, code = "") => makeZip({
  "manifest.json": JSON.stringify({ manifest_version: 3, name: "Victim", version, background: { service_worker: "bg.js" } }),
  "bg.js": code,
});
const opts = { targetVersion: "140.0" };

test("checkReplacement: the decision table", () => {
  const sha = "a".repeat(64);
  const other = "b".repeat(64);
  const at = (installed, version, sha256, fromStore) => checkReplacement({ installed, incoming: { version, sha256 }, fromStore }).kind;
  assert.equal(at(null, "1.0", sha, false), "new");
  assert.equal(at({ version: "5.0" }, "5.1", sha, true), "upgrade");
  assert.equal(at({ version: "5.0" }, "1.0", sha, true), "downgrade", "the store can't roll you back either");
  assert.equal(at({ version: "5.0" }, "4.99.9", sha, false), "downgrade");
  assert.equal(at({ version: "1.2.10" }, "1.2.9", sha, true), "downgrade", "versions compare numerically");
  assert.equal(at({ version: "5.0", sha256: sha }, "5.0", sha, false), "same-build");
  assert.equal(at({ version: "5.0", sha256: sha }, "5.0.0", other, true), "different-build");
  assert.equal(at({ version: "5.0" }, "5.0", sha, false), "unknown-build");

  const d = checkReplacement({ installed: { version: "5.0" }, incoming: { version: "1.0", sha256: sha }, fromStore: true });
  assert.deepEqual(d, { kind: "downgrade", allowed: false, confirm: true });
  assert.equal(checkReplacement({ installed: { version: "5.0" }, incoming: { version: "5.1", sha256: sha }, fromStore: true }).confirm, false);
  assert.equal(checkReplacement({ installed: { version: "5.0" }, incoming: { version: "5.1", sha256: sha }, fromStore: false }).confirm, true);
  assert.equal(checkReplacement({ installed: { version: "5.0" }, incoming: { version: "5.0", sha256: sha }, fromStore: true }).confirm, false);
});

test("a genuinely signed old release keeps its ID but can't be installed over a newer one (PoC case 8)", async () => {
  const old = await convert(makeCrx3(ext("1.0"), victim), opts);
  assert.equal(old.meta.chromeId, victimId, "the signature is real, so the ID is the victim's");
  const installed = { version: "5.0", sha256: null };
  assert.throws(() => assertReplaceable(old.meta, installed, { fromStore: false }), /older 1\.0.*--allow-downgrade/s);
  assert.throws(() => assertReplaceable(old.meta, installed, { fromStore: true }), /older 1\.0/, "not even from the store");
  assert.throws(() => assertReplaceable(old.meta, installed, { replace: true }), /--allow-downgrade/, "--replace isn't enough");
  assert.equal(assertReplaceable(old.meta, installed, { allowDowngrade: true }).kind, "downgrade");
});

test("a genuinely signed CRX2 is refused outright (PoC case 9)", async () => {
  await assert.rejects(convert(makeCrx2(ext("0.9"), victim), opts), /CRX2, signed with SHA-1/);
});

test("same version, different build: refused without --replace", async () => {
  const installed = await convert(makeCrx3(ext("5.0"), victim), opts);
  const sameAgain = await convert(makeCrx3(ext("5.0"), [victim, signingKey()]), opts); // re-signed, same files
  const rebuilt = await convert(makeCrx3(ext("5.0", "steal()"), victim), opts);
  assert.equal(sameAgain.meta.packageSha256, installed.meta.packageSha256, "the fingerprint covers the files, not the signatures");
  assert.notEqual(rebuilt.meta.packageSha256, installed.meta.packageSha256);
  const rec = { version: "5.0", sha256: installed.meta.packageSha256 };
  assert.equal(assertReplaceable(sameAgain.meta, rec, {}).kind, "same-build");
  assert.throws(() => assertReplaceable(rebuilt.meta, rec, { fromStore: true }), /isn't the same build.*--replace/s);
  assert.equal(assertReplaceable(rebuilt.meta, rec, { replace: true }).kind, "different-build");
  // Nothing recorded about the installed build: a file needs --replace, a fresh store download doesn't.
  assert.throws(() => assertReplaceable(rebuilt.meta, { version: "5.0", sha256: null }, {}), /can't confirm/);
  assert.equal(assertReplaceable(rebuilt.meta, { version: "5.0", sha256: null }, { fromStore: true }).kind, "unknown-build");
});

test("a newer file from outside the store needs --replace; from the store it doesn't", async () => {
  const newer = await convert(makeCrx3(ext("6.0"), victim), opts);
  assert.throws(() => assertReplaceable(newer.meta, { version: "5.0" }, {}), /didn't come straight from the Chrome Web Store/);
  assert.equal(assertReplaceable(newer.meta, { version: "5.0" }, { fromStore: true }).kind, "upgrade");
  assert.equal(assertReplaceable(newer.meta, null, {}).kind, "new");
});

test("the converted add-on records its package fingerprint, and the CLI reads it back from the profile", async () => {
  const r = await convert(makeCrx3(ext("5.0"), victim), opts);
  const rec = JSON.parse(toText(readZip(r.xpi).get("foxsake/source.json")));
  assert.deepEqual(rec, { packageSha256: r.meta.packageSha256, chromeId: victimId, version: "5.0" });
  assert.match(r.meta.packageSha256, /^[0-9a-f]{64}$/);

  const profile = mkdtempSync(join(tmpdir(), "foxsake-profile-"));
  try {
    mkdirSync(join(profile, "extensions"));
    writeFileSync(join(profile, "extensions", `${r.meta.geckoId}.xpi`), r.xpi);
    assert.equal(installedPackageSha256(r.meta.geckoId, profile), r.meta.packageSha256);
    assert.equal(installedPackageSha256("missing@foxsake", profile), null);
    writeFileSync(join(profile, "extensions", "old@foxsake.xpi"), makeZip({ "manifest.json": "{}" }));
    assert.equal(installedPackageSha256("old@foxsake", profile), null, "converted before 2.0.4: no record");
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test("a package that already carries a Fox Sake source record is refused", async () => {
  const pkg = makeZip({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "x", version: "1" }), "foxsake/source.json": "{}" });
  await assert.rejects(convert(pkg, opts), /converted twice/);
});
