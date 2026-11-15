// Unwraps Chrome extension packages (.crx) into their inner ZIP archive.
// Works in Node and in the browser (no Node-only APIs).
//
// CRX3 layout: "Cr24" | uint32 LE version=3 | uint32 LE header length | protobuf CrxFileHeader | ZIP
// CRX2 layout: "Cr24" | uint32 LE version=2 | uint32 LE pubkey length | uint32 LE signature length
//              | public key | signature | ZIP
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
  const publicKeys = [];
  let crxId = null;
  for (const { field, bytes } of readFields(header)) {
    if (field === 2 || field === 3) {
      // AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
      const key = readFields(bytes).find((f) => f.field === 1);
      if (key) publicKeys.push({ type: field === 2 ? "rsa" : "ecdsa", key: key.bytes });
    } else if (field === 10000) {
      // SignedData { bytes crx_id = 1; }
      const id = readFields(bytes).find((f) => f.field === 1);
      if (id && id.bytes.length === 16) crxId = bytesToChromeId(id.bytes);
    }
  }
  return { publicKeys, crxId };
}

/**
 * Unwraps a CRX2/CRX3 (or passes through a plain ZIP).
 * @param {Uint8Array} bytes
 * @returns {Promise<{format: "crx3"|"crx2"|"zip", zip: Uint8Array, chromeId: string|null, publicKey: Uint8Array|null}>}
 */
export async function unwrapCrx(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (startsWith(bytes, ZIP_LOCAL) || startsWith(bytes, ZIP_EMPTY)) {
    return { format: "zip", zip: bytes, chromeId: null, publicKey: null };
  }
  if (bytes.length < 12 || !startsWith(bytes, MAGIC)) {
    throw new CrxError("Not a Chrome extension: missing the 'Cr24' signature (and not a ZIP either).");
  }
  const version = u32(bytes, 4);
  let zipStart;
  let chromeId = null;
  let publicKey = null;

  if (version === 3) {
    const headerLen = u32(bytes, 8);
    if (headerLen > MAX_HEADER) throw new CrxError(`CRX3 header length ${headerLen} is implausibly large.`);
    zipStart = 12 + headerLen;
    if (zipStart > bytes.length) throw new CrxError("CRX3 header length points past the end of the file.");
    const { publicKeys, crxId } = parseCrx3Header(bytes.subarray(12, zipStart));
    // The declared crx_id must match the SHA-256 of one of the included public keys.
    for (const pk of publicKeys) {
      if ((await chromeIdFromPublicKey(pk.key)) === crxId) {
        publicKey = pk.key;
        break;
      }
    }
    if (crxId && !publicKey) throw new CrxError("CRX3 header is inconsistent: crx_id doesn't match any included public key.");
    chromeId = crxId;
  } else if (version === 2) {
    const keyLen = u32(bytes, 8);
    const sigLen = u32(bytes, 12);
    if (keyLen > MAX_HEADER || sigLen > MAX_HEADER) throw new CrxError("CRX2 key/signature length is implausibly large.");
    zipStart = 16 + keyLen + sigLen;
    if (zipStart > bytes.length) throw new CrxError("CRX2 header lengths point past the end of the file.");
    publicKey = bytes.slice(16, 16 + keyLen);
    chromeId = await chromeIdFromPublicKey(publicKey);
  } else {
    throw new CrxError(`Unsupported CRX version ${version} (only 2 and 3 exist).`);
  }

  const zip = bytes.subarray(zipStart);
  if (!startsWith(zip, ZIP_LOCAL) && !startsWith(zip, ZIP_EMPTY)) {
    throw new CrxError("CRX payload is not a ZIP archive (bad offsets or corrupt file).");
  }
  return { format: version === 3 ? "crx3" : "crx2", zip, chromeId, publicKey };
}
