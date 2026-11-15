// Fox Sake: Google Docs experiment. Docs draws text on a canvas and only exposes it to
// extensions whose (Chrome) ID is on Google's allow-list. The page checks this window
// variable; we set it to the extension's ORIGINAL Chrome ID before Docs loads.
// Whether Docs honours it in Firefox/Zen is an experiment; see the report.
(() => {
  const FOXSAKE = /*FOXSAKE_CONFIG*/{};
  try { window._docs_annotate_canvas_by_ext = FOXSAKE.chromeId; } catch (e) {}
})();
