// FS-8: converted add-ons get Firefox IDs nobody can guess, and Fox Sake keeps reusing them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseGeckoId, knownIds, idBase, chromeIdOf, isGuessableId } from "../src/core/ids.js";
import { convert, declaredPermissions } from "../src/core/convert.js";
import { makeZip, makeCrx3, signingKey, idFromKey } from "./helpers.js";

const A = "abcdefghijklmnopabcdefghijklmnop";
const opts = { targetVersion: "140.0" };

test("new IDs are <base>-<16 random hex>@foxsake and differ every time", () => {
  const one = chooseGeckoId(A);
  const two = chooseGeckoId(A);
  assert.match(one.geckoId, new RegExp(`^${A}-[0-9a-f]{16}@foxsake$`));
  assert.equal(one.isNew, true);
  assert.notEqual(one.geckoId, two.geckoId);
  assert.match(chooseGeckoId("local-0123456789abcdef").geckoId, /^local-0123456789abcdef-[0-9a-f]{16}@foxsake$/);
  assert.throws(() => chooseGeckoId("not-an-id"), /Internal error/);
});

test("a known ID for the same extension is reused; one for another extension isn't", () => {
  const mine = `${A}-0011223344556677@foxsake`;
  assert.deepEqual(chooseGeckoId(A, { [A]: mine }), { geckoId: mine, isNew: false });
  assert.deepEqual(chooseGeckoId(A, { [A]: `${A}@foxsake` }), { geckoId: `${A}@foxsake`, isNew: false }, "pre-2.0.5 IDs keep working");
  const other = "ponmlkjihgfedcbaponmlkjihgfedcba-0011223344556677@foxsake";
  assert.equal(chooseGeckoId(A, { [A]: other }).isNew, true);
  assert.equal(chooseGeckoId(A, { [A]: "evil@example" }).isNew, true);
});

test("both ID forms are recognised", () => {
  for (const id of [`${A}@foxsake`, `${A}-0011223344556677@foxsake`]) {
    assert.equal(idBase(id), A);
    assert.equal(chromeIdOf(id), A);
  }
  assert.equal(isGuessableId(`${A}@foxsake`), true);
  assert.equal(isGuessableId(`${A}-0011223344556677@foxsake`), false);
  assert.equal(chromeIdOf("local-0123456789abcdef-0011223344556677@foxsake"), null);
  assert.equal(idBase("local-0123456789abcdef@foxsake"), "local-0123456789abcdef");
  for (const bad of ["button@foxsake", `${A}-xyz@foxsake`, `${A}-0011223344556677@foxsake.evil`, `x${A}@foxsake`]) assert.equal(idBase(bad), null, bad);
});

test("an installed add-on's ID wins over a saved one, so updates keep its data", () => {
  const legacy = `${A}@foxsake`;
  const saved = `${A}-0011223344556677@foxsake`;
  assert.deepEqual(knownIds([legacy], { [A]: saved }), { [A]: legacy });
  assert.deepEqual(knownIds([legacy, saved], { [A]: saved }), { [A]: saved });
  assert.deepEqual(knownIds([], { [A]: saved }), { [A]: saved });
  assert.deepEqual(knownIds(["button@foxsake", "other@example"], {}), {});
});

test("convert: a store extension gets a random ID, and its next update reuses it", async () => {
  const k = signingKey();
  const pkg = (v) => makeCrx3(makeZip({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "x", version: v }) }), k);
  const first = await convert(pkg("1"), opts);
  assert.equal(first.meta.newId, true);
  assert.equal(first.meta.idBase, idFromKey(k.der));
  assert.notEqual(first.meta.geckoId, `${idFromKey(k.der)}@foxsake`, "not guessable from the public key");
  const update = await convert(pkg("2"), { ...opts, knownIds: { [first.meta.idBase]: first.meta.geckoId } });
  assert.equal(update.meta.geckoId, first.meta.geckoId);
  assert.equal(update.meta.newId, false);
  const legacy = await convert(pkg("2"), { ...opts, knownIds: { [first.meta.idBase]: `${first.meta.idBase}@foxsake` } });
  assert.equal(legacy.meta.geckoId, `${first.meta.idBase}@foxsake`, "an add-on installed before 2.0.5 keeps its ID");
});

test("declaredPermissions lists everything a manifest asks for (FS-9)", () => {
  assert.deepEqual(declaredPermissions({
    permissions: ["storage", "cookies"], host_permissions: ["<all_urls>"],
    optional_permissions: ["tabs", "storage"], optional_host_permissions: ["https://a.example/*"],
  }), ["<all_urls>", "cookies", "https://a.example/* (optional)", "storage", "tabs (optional)"]);
  assert.deepEqual(declaredPermissions({}), []);
});

test("CLI keeps the same ID across runs in out/ids.json", async () => {
  const out = mkdtempSync(join(tmpdir(), "foxsake-out-"));
  process.env.FOXSAKE_OUT = out;
  try {
    const { loadIds, saveId } = await import("../src/node/library.js");
    assert.deepEqual(loadIds(), {});
    saveId({ newId: true, idBase: A, geckoId: `${A}-0011223344556677@foxsake` });
    saveId({ newId: false, idBase: "local-0123456789abcdef", geckoId: "local-0123456789abcdef@foxsake" });
    assert.deepEqual(loadIds(), { [A]: `${A}-0011223344556677@foxsake` });
    assert.match(readFileSync(join(out, "ids.json"), "utf8"), /0011223344556677/);
    const { addedPermissions } = await import("../src/node/pipeline.js");
    assert.deepEqual(addedPermissions(["<all_urls>", "cookies", "storage"], ["storage", "cookies (optional)"]), ["<all_urls>"]);
    assert.deepEqual(addedPermissions(["cookies"], null), []);
  } finally {
    delete process.env.FOXSAKE_OUT;
    rmSync(out, { recursive: true, force: true });
  }
});
