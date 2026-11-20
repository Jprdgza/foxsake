// What happens when a conversion would replace an add-on that's already installed.
// The replacement gets everything the installed add-on saved (settings, logins, other data), so an
// older version, or a different build of the same version, must never slip in as a normal install.
// An old release can be genuinely signed and still have security holes that were fixed later.
import { compareVersions } from "./webstore.js";

/**
 * @param {{installed: {version: string, sha256?: string|null}|null,
 *          incoming: {version: string, sha256: string},
 *          fromStore: boolean}} p
 *   `installed.sha256` is the package fingerprint recorded when Fox Sake installed it (if known).
 *   `fromStore` means the package was just downloaded from the Chrome Web Store for this ID.
 * @returns {{kind: "new"|"upgrade"|"same-build"|"different-build"|"unknown-build"|"downgrade",
 *            allowed: boolean, confirm: boolean}}
 *   `allowed: false` means the normal Install action is refused (only an explicit downgrade may
 *   override it); `confirm: true` means the user has to confirm a warning first.
 */
export function checkReplacement({ installed, incoming, fromStore }) {
  if (!installed) return { kind: "new", allowed: true, confirm: false };
  const order = compareVersions(incoming.version, installed.version);
  if (order < 0) return { kind: "downgrade", allowed: false, confirm: true };
  if (order > 0) return { kind: "upgrade", allowed: true, confirm: !fromStore };
  if (installed.sha256) {
    return installed.sha256 === incoming.sha256
      ? { kind: "same-build", allowed: true, confirm: false }
      : { kind: "different-build", allowed: true, confirm: true };
  }
  // Same version, but nothing recorded about what was installed. A fresh store download of that
  // version is what the store serves for it; a file from anywhere else might not be.
  return { kind: "unknown-build", allowed: true, confirm: !fromStore };
}
