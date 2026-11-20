// Piece: the extension refers to its own Chrome ID. In Firefox it has a different ID (<chromeId>-<random>@foxsake),
// so messages addressed to the old ID are redirected to the extension itself.
for (const t of TARGETS) {
  const rt = t.runtime;
  if (!rt) continue;
  for (const method of ["sendMessage", "connect"]) {
    const orig = rt[method];
    if (typeof orig !== "function") continue;
    define(rt, method, function (...args) {
      if (args[0] === FOXSAKE.chromeId) args[0] = rt.id;
      return orig.apply(rt, args);
    });
  }
}
