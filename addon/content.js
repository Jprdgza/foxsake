// Fox Sake button: puts "Add to Zen" next to the Web Store's own button on extension pages.
// The Web Store is a single-page app, so the page is re-checked whenever the URL changes.
(() => {
  const ID_RE = /\/detail\/(?:[^/]+\/)?([a-p]{32})(?:[/?#]|$)/;
  let current = null;

  function findAnchor() {
    // The store's own "Add to Chrome" / "Remove from Chrome" button; fall back to the page title.
    const buttons = [...document.querySelectorAll("button")];
    return buttons.find((b) => /(add to|remove from|available on) chrome/i.test(b.textContent || "")) || document.querySelector("main h1");
  }

  function render() {
    const m = ID_RE.exec(location.pathname);
    const id = m ? m[1] : null;
    if (id === current && document.getElementById("foxsake-add")) return;
    document.getElementById("foxsake-add")?.remove();
    current = id;
    if (!id) return;
    const anchor = findAnchor();
    if (!anchor) return;

    const wrap = document.createElement("div");
    wrap.id = "foxsake-add";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "🦊 Add to Zen";
    const status = document.createElement("div");
    status.className = "foxsake-status";
    wrap.append(btn, status);
    anchor.insertAdjacentElement("afterend", wrap);

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Converting…";
      status.textContent = "Downloading and converting. This can take up to a minute for big extensions.";
      status.dataset.kind = "";
      let res;
      try {
        res = await browser.runtime.sendMessage({ type: "foxsake-add", id });
      } catch (e) {
        res = { ok: false, error: String(e) };
      }
      btn.disabled = false;
      if (res && res.ok) {
        btn.textContent = "🦊 Add to Zen";
        status.dataset.kind = "ok";
        status.textContent = `Converted ${res.name} ${res.version}. Zen's install prompt is open: click "Add".` +
          (res.unsupported && res.unsupported.length ? ` Won't work in Zen: ${res.unsupported.join("; ")}.` : "") +
          (res.shims && res.shims.length ? ` Patched with: ${res.shims.join(", ")}.` : "");
      } else {
        btn.textContent = "🦊 Try again";
        status.dataset.kind = "error";
        status.textContent = `Couldn't convert: ${(res && res.error) || "unknown error"}`;
      }
    });
  }

  render();
  let last = location.href;
  new MutationObserver(() => {
    if (location.href !== last) { last = location.href; current = null; }
    render();
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
