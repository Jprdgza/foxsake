#!/usr/bin/env node
// Downloads the real Chrome Web Store test fixtures into test/fixtures/real/ (git-ignored).
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadCrx } from "../src/node/fetch-crx.js";
import { REAL_FIXTURES } from "../test/fixtures/list.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "real");
mkdirSync(dir, { recursive: true });
for (const fx of REAL_FIXTURES) {
  const out = join(dir, fx.file);
  if (existsSync(out)) { console.log(`✓ ${fx.name} (already there)`); continue; }
  writeFileSync(out, await downloadCrx(fx.id));
  console.log(`↓ ${fx.name}`);
}
