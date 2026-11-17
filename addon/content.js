// Fox Sake: puts an "Add to Zen" button next to the Web Store's own button on extension pages.
// The Web Store is a single-page app, so the page is re-checked whenever the URL changes.
(() => {
  const ID_RE = /\/detail\/(?:[^/]+\/)?([a-p]{32})(?:[/?#]|$)/;
  let current = null;
  let browserName = "Zen";
  browser.runtime.sendMessage({ type: "foxsake-browser-name" }).then((n) => {
    if (typeof n === "string" && n) browserName = n;
    const b = document.querySelector("#foxsake-add button");
    if (b) b.textContent = `🦊 Add to ${browserName}`;
  }).catch(() => {});

  // The store is a single-page app that keeps previous pages in the DOM, hidden. Only visible
  // elements count, or the button ends up attached to a page you can't see.
  const isVisible = (e) => !!e && e.isConnected && e.getClientRects().length > 0;

  function findAnchor() {
    // The store's own "Add to Chrome" / "Remove from Chrome" button; fall back to the page title.
    const buttons = [...document.querySelectorAll("button")].filter(isVisible);
    return buttons.find((b) => /(add to|remove from|available on) chrome/i.test(b.textContent || "")) ||
      [...document.querySelectorAll("main h1")].find(isVisible) || null;
  }

  function render() {
    const m = ID_RE.exec(location.pathname);
    const id = m ? m[1] : null;
    if (id === current && isVisible(document.getElementById("foxsake-add"))) return;
    document.getElementById("foxsake-add")?.remove();
    current = id;
    if (!id) return;
    const anchor = findAnchor();
    if (!anchor) return;

    const wrap = document.createElement("div");
    wrap.id = "foxsake-add";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `🦊 Add to ${browserName}`;
    const status = document.createElement("div");
    status.className = "foxsake-status";
    wrap.append(btn, status);
    anchor.insertAdjacentElement("afterend", wrap);

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const r = await browser.runtime.sendMessage({ type: "foxsake-add", id });
        if (!r || !r.ok) throw new Error("the request was refused");
        status.dataset.kind = "ok";
        status.textContent = "Opened Fox Sake in a new tab.";
      } catch (e) {
        status.dataset.kind = "error";
        status.textContent = `Couldn't open Fox Sake: ${e && e.message ? e.message : e}`;
      }
      btn.disabled = false;
    });
  }

  render();
  let last = location.href;
  let queued = false;
  new MutationObserver(() => {
    if (location.href !== last) { last = location.href; current = null; }
    if (queued) return;
    queued = true; // the store mutates constantly; check at most once per frame
    requestAnimationFrame(() => { queued = false; render(); });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
