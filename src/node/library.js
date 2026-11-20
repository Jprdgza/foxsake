// Fox Sake's local library: out/ holds converted .xpi files, reports, the untouched original
// CRX downloads, and registry.json (what has been converted, from where, with which shims).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const OUT = process.env.FOXSAKE_OUT || join(ROOT, "out");
export const ORIGINALS = join(OUT, "originals");
const REGISTRY = join(OUT, "registry.json");
const IDS = join(OUT, "ids.json");

export function ensureDirs() {
  mkdirSync(ORIGINALS, { recursive: true });
}

export function loadRegistry() {
  if (!existsSync(REGISTRY)) return { extensions: {} };
  try { return JSON.parse(readFileSync(REGISTRY, "utf8")); } catch { return { extensions: {} }; }
}

export function saveRegistry(reg) {
  ensureDirs();
  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + "\n");
}

/** Firefox IDs picked for each extension (base → ID), so every later run reuses the same one. */
export function loadIds() {
  try { return JSON.parse(readFileSync(IDS, "utf8")); } catch { return {}; }
}

export function saveId(meta) {
  if (!meta.newId) return;
  const ids = loadIds();
  ids[meta.idBase] = meta.geckoId;
  ensureDirs();
  writeFileSync(IDS, JSON.stringify(ids, null, 2) + "\n");
}

/** Records a conversion. Keyed by Firefox ID so reconversions update the same entry. */
export function recordConversion(meta, paths) {
  const reg = loadRegistry();
  const prev = reg.extensions[meta.geckoId] ?? {};
  reg.extensions[meta.geckoId] = { ...prev, ...meta, ...paths, history: [...(prev.history ?? []), { version: meta.version, at: meta.convertedAt }].slice(-20) };
  saveRegistry(reg);
}
