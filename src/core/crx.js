// Unwraps Chrome extension packages (.crx) into their inner ZIP archive.
// Works in Node and in the browser (no Node-only APIs).
//
// CRX3 layout: "Cr24" | uint32 LE version=3 | uint32 LE header length | protobuf CrxFileHeader | ZIP
// CRX2 (version 2, signed with SHA-1) is refused, as Chrome has done since 2019.
// All offsets are bounds-checked: downloaded files are untrusted data.

const MAGIC = [0x43, 0x72, 0x32, 0x34]; // "Cr24"
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04]; // "PK\3\4"
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06]; // "PK\5\6" (empty archive)
const MAX_HEADER = 1024 * 1024; // a real CRX header is a few KB; refuse absurd sizes

export class CrxError extends Error {}

const startsWith = (bytes, sig, at = 0) => sig.every((b, i) => bytes[at + i] === b);

function u32(bytes, offset) {
  if (offset + 4 > bytes.length) throw new CrxError("File is truncated (header runs past end of file).");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

/** Converts 16 raw bytes into Chrome's a–p extension ID alphabet. */
export function bytesToChromeId(bytes16) {
  let id = "";
  for (const b of bytes16.slice(0, 16)) id += String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15));
  return id;
}

/** Chrome extension ID = first 128 bits of SHA-256(public key), in a–p letters. */
export async function chromeIdFromPublicKey(publicKey) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", publicKey));
  return bytesToChromeId(digest);
}

// --- Minimal protobuf reader (only what the CRX3 header needs) -------------------------
function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new CrxError("Malformed CRX3 header (varint runs past end).");
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [result, pos];
    shift += 7n;
  }
  throw new CrxError("Malformed CRX3 header (varint too long).");
}

/** Returns [{field, bytes}] for length-delimited fields; skips other wire types safely. */
function readFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      [, pos] = readVarint(buf, pos);
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      const end = pos + Number(len);
      if (len > BigInt(buf.length) || end > buf.length) throw new CrxError("Malformed CRX3 header (field length out of range).");
      fields.push({ field, bytes: buf.subarray(pos, end) });
      pos = end;
    } else {
      throw new CrxError(`Malformed CRX3 header (unsupported wire type ${wire}).`);
    }
    if (pos > buf.length) throw new CrxError("Malformed CRX3 header (field runs past end).");
  }
  return fields;
}

function parseCrx3Header(header) {
  const proofs = [];
  let crxId = null;
  let signedHeaderData = new Uint8Array(0);
  for (const { field, bytes } of readFields(header)) {
    if (field === 2 || field === 3) {
      // AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
      const parts = readFields(bytes);
      const key = parts.find((f) => f.field === 1);
      const signature = parts.find((f) => f.field === 2);
      if (!key || !signature) throw new CrxError("Malformed CRX3 header (a key proof is missing its key or signature).");
      proofs.push({ type: field === 2 ? "rsa" : "ecdsa", key: key.bytes, signature: signature.bytes });
    } else if (field === 10000) {
      // signed_header_data: a serialized SignedData { bytes crx_id = 1; }
      signedHeaderData = bytes;
      const id = readFields(bytes).find((f) => f.field === 1);
      if (id && id.bytes.length === 16) crxId = bytesToChromeId(id.bytes);
    }
  }
  return { proofs, crxId, signedHeaderData };
}

// --- Signature checks (WebCrypto, so the same code runs in Node and in the add-on) ------
const subtle = () => globalThis.crypto.subtle;
const CRX3_PREFIX = new TextEncoder().encode("CRX3 SignedData\x00");

/** CRX3 signs: "CRX3 SignedData\0" | uint32 LE length of signed_header_data | signed_header_data | ZIP. */
function crx3SignedBytes(signedHeaderData, zip) {
  const out = new Uint8Array(CRX3_PREFIX.length + 4 + signedHeaderData.length + zip.length);
  out.set(CRX3_PREFIX, 0);
  new DataView(out.buffer).setUint32(CRX3_PREFIX.length, signedHeaderData.length, true);
  out.set(signedHeaderData, CRX3_PREFIX.length + 4);
  out.set(zip, CRX3_PREFIX.length + 4 + signedHeaderData.length);
  return out;
}

/** CRX signatures are DER (SEQUENCE { INTEGER r, INTEGER s }); WebCrypto wants r and s as 32 bytes each. */
function ecdsaDerToRaw(der) {
  let pos = 0;
  const readLen = () => {
    if (pos >= der.length) throw new Error("short");
    let len = der[pos++];
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n < 1 || n > 2) throw new Error("bad length");
      len = 0;
      for (let i = 0; i < n; i++) {
        if (pos >= der.length) throw new Error("short");
        len = (len << 8) | der[pos++];
      }
    }
    return len;
  };
  const readInt = () => {
    if (der[pos++] !== 0x02) throw new Error("not an INTEGER");
    const len = readLen();
    if (pos + len > der.length) throw new Error("short");
    let v = der.subarray(pos, pos + len);
    pos += len;
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) throw new Error("integer too large");
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  if (der[pos++] !== 0x30) throw new Error("not a SEQUENCE");
  const seqLen = readLen();
  if (pos + seqLen !== der.length) throw new Error("trailing bytes");
  const raw = new Uint8Array(64);
  raw.set(readInt(), 0);
  raw.set(readInt(), 32);
  if (pos !== der.length) throw new Error("trailing bytes");
  return raw;
}

async function verifyProof({ type, key, signature }, data) {
  const hash = "SHA-256";
  try {
    if (type === "rsa") {
      const k = await subtle().importKey("spki", key, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
      return await subtle().verify("RSASSA-PKCS1-v1_5", k, signature, data);
    }
    const k = await subtle().importKey("spki", key, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await subtle().verify({ name: "ECDSA", hash: "SHA-256" }, k, ecdsaDerToRaw(signature), data);
  } catch {
    return false; // unparseable key or signature
  }
}

/**
 * Unwraps a CRX3 (or passes through a plain ZIP) and checks its signatures. CRX2 is refused.
 * A package is rejected if any signature in it is invalid. `chromeId` is only set when it comes
 * from a public key whose signature over this exact package verifies (`verified: true`);
 * anything else (plain ZIPs, CRX3 files without a crx_id) has `chromeId: null`.
 * @param {Uint8Array} bytes
 * @returns {Promise<{format: "crx3"|"zip", zip: Uint8Array, chromeId: string|null, publicKey: Uint8Array|null, verified: boolean}>}
 */
export async function unwrapCrx(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (startsWith(bytes, ZIP_LOCAL) || startsWith(bytes, ZIP_EMPTY)) {
    return { format: "zip", zip: bytes, chromeId: null, publicKey: null, verified: false };
  }
  if (bytes.length < 12 || !startsWith(bytes, MAGIC)) {
    throw new CrxError("Not a Chrome extension: missing the 'Cr24' signature (and not a ZIP either).");
  }
  const version = u32(bytes, 4);
  let zip;
  let chromeId = null;
  let publicKey = null;

  if (version === 3) {
    const headerLen = u32(bytes, 8);
    if (headerLen > MAX_HEADER) throw new CrxError(`CRX3 header length ${headerLen} is implausibly large.`);
    const zipStart = 12 + headerLen;
    if (zipStart > bytes.length) throw new CrxError("CRX3 header length points past the end of the file.");
    zip = bytes.subarray(zipStart);
    checkZip(zip);
    const { proofs, crxId, signedHeaderData } = parseCrx3Header(bytes.subarray(12, zipStart));
    if (!proofs.length) throw new CrxError("This CRX isn't signed (no signatures in its header).");
    const data = crx3SignedBytes(signedHeaderData, zip);
    for (const proof of proofs) {
      if (!(await verifyProof(proof, data))) {
        throw new CrxError("This CRX's signature is invalid: the file was modified or forged after it was signed.");
      }
    }
    if (crxId) {
      for (const p of proofs) {
        if ((await chromeIdFromPublicKey(p.key)) === crxId) { publicKey = p.key; break; }
      }
      if (!publicKey) throw new CrxError("CRX3 header is inconsistent: crx_id doesn't match any of its signing keys.");
      chromeId = crxId;
    }
  } else if (version === 2) {
    // CRX2 signatures use SHA-1, which can be forged with enough money. Chrome stopped installing
    // CRX2 files in 2019, so anything in this format is an old package from somewhere other than the store.
    throw new CrxError("This is an old-format CRX (CRX2, signed with SHA-1). Chrome stopped accepting this format in 2019, " +
      "so it can't have come from the Chrome Web Store recently. Fox Sake doesn't convert it.");
  } else {
    throw new CrxError(`Unsupported CRX version ${version} (Fox Sake only reads CRX3).`);
  }

  return { format: "crx3", zip, chromeId, publicKey, verified: !!chromeId };
}

function checkZip(zip) {
  if (!startsWith(zip, ZIP_LOCAL) && !startsWith(zip, ZIP_EMPTY)) {
    throw new CrxError("CRX payload is not a ZIP archive (bad offsets or corrupt file).");
  }
}
