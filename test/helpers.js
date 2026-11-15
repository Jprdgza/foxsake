// Test helpers: build synthetic CRX2/CRX3 files around a ZIP, exactly as Chrome lays them out.
import { generateKeyPairSync, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeZip, toBytes } from "../src/core/archive.js";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function makeZip(filesObj) {
  const m = new Map();
  for (const [p, v] of Object.entries(filesObj)) m.set(p, typeof v === "string" ? toBytes(v) : v);
  return writeZip(m);
}

export function publicKeyDer() {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
}

export function idFromKey(der) {
  const h = createHash("sha256").update(der).digest();
  return [...h.subarray(0, 16)].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
}

const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const MAGIC = toBytes("Cr24");

function varint(n) {
  const out = [];
  while (n > 127) { out.push((n & 127) | 128); n >>>= 7; }
  out.push(n);
  return new Uint8Array(out);
}
const field = (num, bytes) => concat(varint((num << 3) | 2), varint(bytes.length), bytes);

export function makeCrx3(zip, der, { idOverride } = {}) {
  const idBytes = createHash("sha256").update(der).digest().subarray(0, 16);
  const proof = concat(field(1, der), field(2, new Uint8Array(256)));
  const signed = field(1, idOverride ?? new Uint8Array(idBytes));
  const header = concat(field(2, proof), field(10000, signed));
  return concat(MAGIC, u32(3), u32(header.length), header, zip);
}

export function makeCrx2(zip, der) {
  const sig = new Uint8Array(128);
  return concat(MAGIC, u32(2), u32(der.length), u32(sig.length), der, sig, zip);
}

/** Real Chrome Web Store downloads (fetched by `npm run fixtures`); tests skip if missing. */
export function realFixture(name) {
  const p = join(FIXTURES, "real", name);
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
}
