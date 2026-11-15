// ZIP reading/writing plus small text helpers. Uses fflate (pure JS: Node + browser).
import { unzipSync, zipSync } from "fflate";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");
export const toText = (bytes) => dec.decode(bytes).replace(/^﻿/, "");
export const toBytes = (text) => enc.encode(text);

export const MAX_TOTAL_UNZIPPED = 512 * 1024 * 1024; // zip-bomb guard
export const MAX_FILES = 20000;

/** Makes an untrusted string (e.g. a manifest's version) safe to use inside a file name. */
export function safeFilePart(s, fallback = "x") {
  const clean = String(s ?? "").replace(/[^0-9A-Za-z._-]/g, "_").replace(/^[.]+/, "").slice(0, 64);
  return clean || fallback;
}

/** Normalizes a ZIP entry path and rejects anything that could escape the archive root. */
export function safePath(name) {
  let p = name.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) throw new Error(`Unsafe absolute path in archive: ${name}`);
  const parts = p.split("/");
  if (parts.some((part) => part === "..")) throw new Error(`Unsafe '..' path in archive: ${name}`);
  return parts.filter((part) => part !== "" && part !== ".").join("/");
}

/** Reads a ZIP into a Map<path, Uint8Array> (directories omitted, paths sanitized). */
export function readZip(zipBytes) {
  let total = 0;
  let count = 0;
  const raw = unzipSync(zipBytes, {
    filter(file) {
      count++;
      total += file.originalSize ?? 0;
      if (count > MAX_FILES) throw new Error(`Archive has more than ${MAX_FILES} files; refusing.`);
      if (total > MAX_TOTAL_UNZIPPED) throw new Error("Archive expands to more than 512 MB; refusing.");
      return !file.name.endsWith("/");
    },
  });
  // Declared sizes in a ZIP can lie, so also check what was actually decompressed.
  let actual = 0;
  for (const data of Object.values(raw)) actual += data.length;
  if (actual > MAX_TOTAL_UNZIPPED) throw new Error("Archive expands to more than 512 MB; refusing.");
  const files = new Map();
  for (const [name, data] of Object.entries(raw)) {
    const p = safePath(name);
    if (p) files.set(p, data);
  }
  return files;
}

/** Writes a Map<path, Uint8Array> into a deterministic ZIP (sorted, fixed timestamps). */
export function writeZip(files) {
  const entries = {};
  const fixedTime = new Date("2020-01-01T00:00:00Z");
  for (const path of [...files.keys()].sort()) {
    entries[path] = [files.get(path), { level: 9, mtime: fixedTime }];
  }
  return zipSync(entries);
}

/** Finds a file case-insensitively (Chrome on macOS/Windows tolerates case mismatches; Firefox does not). */
export function findPath(files, wanted) {
  // Manifest paths like "/js/bg.js" mean "from the extension root" (seen in uBlock Origin Lite).
  let clean;
  try { clean = safePath(String(wanted).replace(/^\/+/, "")); } catch { return null; }
  if (files.has(clean)) return clean;
  const lower = clean.toLowerCase();
  for (const p of files.keys()) if (p.toLowerCase() === lower) return p;
  return null;
}

/** Resolves a path relative to another file's directory ("js/bg.js" + "../lib/x.js" → "lib/x.js"). */
export function resolveRelative(fromFile, rel) {
  if (rel.startsWith("/")) return safePath(rel.slice(1));
  const base = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/") + 1) : "";
  const parts = (base + rel).split("/");
  const out = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

/** Lenient JSON parse: Chrome accepts comments and trailing commas in manifest.json. */
export function parseLenientJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Strip // and /* */ comments outside strings, then trailing commas.
    let out = "";
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        out += c;
        if (c === "\\") out += text[++i] ?? "";
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
        out += c;
      } else if (c === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        out += "\n";
      } else if (c === "/" && text[i + 1] === "*") {
        i += 2;
        while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
        i++;
      } else out += c;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  }
}
