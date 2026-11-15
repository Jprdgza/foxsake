// Piece: the extension reads fields (like update_url) that Fox Sake had to remove from the
// manifest for Firefox. getManifest() returns them again so "store build" checks still pass.
for (const t of TARGETS) {
  const rt = t.runtime;
  if (!rt || typeof rt.getManifest !== "function") continue;
  const orig = rt.getManifest;
  define(rt, "getManifest", function () {
    return Object.assign({}, FOXSAKE.manifestExtras, orig.call(rt));
  });
}
