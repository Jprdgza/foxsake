// Firefox IDs for converted add-ons.
//
// The ID decides which installed add-on a package replaces and whose saved data it gets. With signing
// off, Firefox installs any .xpi with an existing ID as an update of that add-on. So since 2.0.5 each
// extension gets an ID nobody can guess: <base>-<16 random hex>@foxsake, picked once and then reused
// for every update Fox Sake makes. <base> is the verified Chrome ID, or local-<hash> for unsigned files.
// Add-ons converted before 2.0.5 keep their old <base>@foxsake ID, so they don't lose their data.

export const ID_SUFFIX = "@foxsake";
const BASE = "[a-p]{32}|local-[0-9a-f]{16}";
const ID_RE = new RegExp(`^(${BASE})(?:-([0-9a-f]{16}))?${ID_SUFFIX}$`);
const BASE_RE = new RegExp(`^(${BASE})$`);

/** The base (Chrome ID or local-<hash>) of a converted add-on's ID, or null if it isn't one. */
export function idBase(geckoId) {
  return ID_RE.exec(String(geckoId))?.[1] ?? null;
}

/** The Chrome ID inside a converted add-on's ID (null for local packages and anything else). */
export function chromeIdOf(geckoId) {
  const base = idBase(geckoId);
  return base && !base.startsWith("local-") ? base : null;
}

/** True for the old, guessable form <base>@foxsake. */
export function isGuessableId(geckoId) {
  return !!idBase(geckoId) && !ID_RE.exec(geckoId)[2];
}

/**
 * Picks the ID for a conversion. `known` maps a base to the ID already used for it (an installed
 * add-on, or one Fox Sake picked earlier); without one, a new random ID is made.
 * @returns {{geckoId: string, isNew: boolean}}
 */
export function chooseGeckoId(base, known = {}) {
  if (!BASE_RE.test(base ?? "")) throw new Error("Internal error: no valid ID for the converted add-on.");
  const existing = known?.[base];
  if (typeof existing === "string" && idBase(existing) === base) return { geckoId: existing, isNew: false };
  const random = globalThis.crypto.getRandomValues(new Uint8Array(8));
  const hex = [...random].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { geckoId: `${base}-${hex}${ID_SUFFIX}`, isNew: true };
}

/** Builds `known` for chooseGeckoId() from a list of installed add-on IDs plus saved choices. */
export function knownIds(installedIds, saved = {}) {
  const known = {};
  for (const [base, id] of Object.entries(saved ?? {})) if (idBase(id) === base) known[base] = id;
  // An installed add-on wins over a saved choice: updating it is what keeps its data.
  for (const id of installedIds) {
    const base = idBase(id);
    if (base && !installedIds.includes(known[base])) known[base] = id;
  }
  return known;
}
