// Answers "does Firefox (version N) support X?" using the table generated from
// @mdn/browser-compat-data. No hardcoded guesses.
import { support } from "./generated/assets.js";
import { compareVersions } from "./webstore.js";

export const DEFAULT_TARGET = "140.0";

export function createSupport(targetVersion = DEFAULT_TARGET) {
  const ok = (v) => v != null && compareVersions(v, targetVersion) <= 0;
  return {
    bcdVersion: support.bcdVersion,
    target: targetVersion,
    /** true / false / undefined (BCD doesn't know the key at all). */
    manifestKey: (key) => (key in support.manifestKeys ? ok(support.manifestKeys[key]) : undefined),
    manifestSubKey: (key, sub) => {
      const k = `${key}.${sub}`;
      return k in support.manifestSubKeys ? ok(support.manifestSubKeys[k]) : undefined;
    },
    permission: (perm) => (perm in support.permissions ? ok(support.permissions[perm]) : undefined),
    apiNamespace: (ns) => (ns in support.apis ? ok(support.apis[ns].__ns) : undefined),
    apiMember: (ns, member) => {
      const n = support.apis[ns];
      if (!n || !(member in n)) return undefined;
      return ok(n[member]);
    },
    knownApiNamespaces: () => Object.keys(support.apis),
  };
}
