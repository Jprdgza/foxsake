// Test helpers: build synthetic CRX3 (and refused CRX2) files around a ZIP, exactly as Chrome lays them out.
import { generateKeyPairSync, createHash, sign } from "node:crypto";
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

/** A signing key pair: {type: "rsa"|"ecdsa", privateKey, der (SPKI public key)}. */
export function signingKey(type = "rsa") {
  const { publicKey, privateKey } = type === "rsa"
    ? generateKeyPairSync("rsa", { modulusLength: 2048 })
    : generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { type, privateKey, der: new Uint8Array(publicKey.export({ type: "spki", format: "der" })) };
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

/**
 * Builds a CRX3 signed the way Chrome signs it. `keys` is one key or a list (the first one is the
 * extension's own key, used for crx_id). `badSignature` replaces the signatures with junk, i.e. a
 * forged package that carries a real public key.
 */
export function makeCrx3(zip, keys, { idOverride, badSignature } = {}) {
  keys = [keys].flat();
  const idBytes = createHash("sha256").update(keys[0].der).digest().subarray(0, 16);
  const signedHeaderData = field(1, idOverride ?? new Uint8Array(idBytes));
  const data = concat(toBytes("CRX3 SignedData\x00"), u32(signedHeaderData.length), signedHeaderData, zip);
  const proofs = keys.map((k) => {
    const sig = badSignature ? new Uint8Array(k.type === "rsa" ? 256 : 72).fill(7) : new Uint8Array(sign("sha256", data, k.privateKey));
    return field(k.type === "rsa" ? 2 : 3, concat(field(1, k.der), field(2, sig)));
  });
  const header = concat(...proofs, field(10000, signedHeaderData));
  return concat(MAGIC, u32(3), u32(header.length), header, zip);
}

/** Builds a CRX2: RSA/SHA-1 signature over the ZIP. */
export function makeCrx2(zip, key, { badSignature } = {}) {
  const sig = badSignature ? new Uint8Array(256) : new Uint8Array(sign("sha1", zip, key.privateKey));
  return concat(MAGIC, u32(2), u32(key.der.length), u32(sig.length), key.der, sig, zip);
}

/** Real Chrome Web Store downloads (fetched by `npm run fixtures`); tests skip if missing. */
export function realFixture(name) {
  const p = join(FIXTURES, "real", name);
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
}
