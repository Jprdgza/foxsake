# Design notes

## Installing unsigned add-ons

Zen release builds ship with `MOZ_REQUIRE_SIGNING = false` (see `AppConstants.sys.mjs` in
`omni.ja`), so `xpinstall.signatures.required = false` works and unsigned add-ons install
permanently: `extensions.json` records them as `location: "app-profile"`. If that ever
changes, the fallback is AMO unlisted signing (`web-ext sign --channel=unlisted`).

To open the install prompt, Fox Sake runs `zen --new-tab file:///…/x.xpi`. On macOS,
`open -a Zen x.xpi` silently does nothing.

## Pipeline

```
input (URL | ID | .crx | .zip | dir)
  → download (Google update service, redirect=crx)
  → unwrap CRX2/CRX3 → read ZIP
  → scan JS for Chrome-only usage
  → rewrite manifest (BCD-driven)
  → inject shims + rewrite code
  → write .xpi → web-ext lint → report → registry
  → open Zen's install prompt
```

Everything up to "write .xpi" lives in `src/core/` and has no Node dependencies.

## CRX parsing

CRX3: `"Cr24"`, uint32 version, uint32 header length, protobuf `CrxFileHeader`, then the ZIP.
CRX2: `"Cr24"`, version, key length, signature length, key, signature, then the ZIP.
The parser bounds-checks every offset. For CRX3, it requires `signed_header_data.crx_id`
to equal the first 16 bytes of SHA-256 of one of the included public keys, and it requires
the payload to start with a ZIP signature. ZIP entries with `..` or absolute paths are
rejected, and entry count and total size are capped. Fox Sake never executes downloaded code.

## Manifest rewriting

- `browser_specific_settings.gecko.id = "<chromeId>@foxsake"`, `strict_min_version = "128.0"`
  (the first release with MAIN-world content scripts).
- `background.service_worker` → `background.scripts`; `type: "module"` is preserved. Static
  `importScripts()` calls are followed recursively and placed ahead of the worker. Their
  paths resolve against the worker's URL, as in a real worker.
- `side_panel.default_path` → `sidebar_action.default_panel` (`open_at_install: false`).
- Removed: `update_url`, `key`, `minimum_chrome_version`, `oauth2`, `storage.managed_schema`,
  `use_dynamic_url`, `import`/`export`, permissions without Firefox support, and any
  top-level key BCD doesn't know.
- Paths written with a leading slash (`"/js/background.js"`) are resolved from the package root.
- `webRequestAuthProvider` also gets `webRequestBlocking`, which Firefox requires for blocking listeners.
- `author` objects become strings. A remote `search_provider.favicon_url` becomes a packaged
  icon (Firefox MV3 rejects the whole package otherwise).

## Shims

Shim sources live in `src/shims/`. `scripts/build-assets.js` bundles them with a compact
BCD table into `src/core/generated/assets.js`. Each context (background, extension pages,
isolated content scripts) gets one generated file: the selected pieces, each wrapped in a
`try` so one failing piece can't break the others, and loaded before the extension's own code.

Notable details:

- **offscreen**: the iframe lives in the background page. `runtime.getContexts` and
  `clients.matchAll` both report it, since extensions use either to check whether it exists.
  Firefox suspends idle event pages, and the iframe goes with it, which matches Chrome
  closing offscreen documents.
- **sidePanel**: `sidebarAction.open()`/`toggle()` must run synchronously inside a user
  gesture, so those wrappers deliberately avoid `await`.
- **external messaging**: the main-world script chains to any existing
  `chrome.runtime.sendMessage`, so several converted extensions can share a page. The
  background hides bridged messages from ordinary `onMessage` listeners.

## Hardening

- Output file names use `safeFilePart()`, because `version` comes from the package and could contain `../`.
- Downloads are streamed with a 300 MB cap; ZIPs are capped at 20,000 entries and 512 MB (declared and actual).
- Folder input never follows symlinks.
- The add-on's background only accepts `{type: "foxsake-add", id: <string of 32 a–p letters>}` from Web Store pages, and its pages never build HTML from strings.
- The website bridge trusts Firefox's `sender.url`, never a URL inside the message, and re-checks it
  against the extension's `externally_connectable` patterns.
- `scripts/zen-driver.js` refuses requests that carry an `Origin` header or lack `x-foxsake-driver: 1`,
  so web pages can't use it (a custom header forces a CORS preflight, which it never answers).
- `npm audit` reports low-severity `deepmerge` advisories inside `web-ext`'s linter; the suggested
  "fix" downgrades web-ext seven major versions, so it's left as is.

## Compatibility testing

16 popular extensions (uBlock Origin Lite, Dark Reader, Grammarly, LastPass, Honey, Adobe Acrobat,
React DevTools, Vimium, Tampermonkey, Loom, Momentum, Google Translate, Volume Master, ChatGPT search,
QuillBot, Bitwarden) were converted and installed into a headless Zen 1.24 / Gecko 160 via WebDriver BiDi
(`webExtension.install`). All that the store served (15) were accepted. Background startup errors were then read
over the remote debugging protocol; that pass found the `webRequestBlocking`, `storageManaged` and
`portLastError` issues.

Known gap: bundlers that load background code with `importScripts()` at runtime (webpack's
`importScripts` chunk loading, e.g. LastPass) can't be made synchronous in an event page. Those
code paths fail, and the report flags them.

## Test runs

`foxsake run` uses a dedicated, persistent profile in `out/dev-profile`. Don't give
web-ext a copy of a real profile. A copy keeps `toolkit.profiles.storeID`, and on startup it
registers itself in the original's profile group, rewriting `profiles.ini`, `installs.ini`
and `Profile Groups/<id>.sqlite`. `run` snapshots those files before and after each run and
warns if anything changed.

Pages under automation report `navigator.webdriver`, so Cloudflare-protected sites show a
challenge page in automated test windows.

## The add-on

The add-on bundles `src/core/` unchanged (`scripts/build-addon.js` only points its `fflate` import at the
bundled copy). The flow:

- The Web Store content script sends just the 32-letter ID to the background script, which checks that
  the sender is a `chromewebstore.google.com` page and opens `app/app.html#add=<id>`.
- The page downloads the CRX with the shared `downloadCrx()` (same 300 MB cap), then converts it in a
  module worker so large extensions don't block the page. QuillBot (27 MB) takes about 11 s, and the result
  is byte-identical to the CLI's.
- **Installing:** a blob URL of type `application/x-xpinstall` opened from the background script is
  cancelled with "missing user gesture activation". Setting `location.href` to that blob from a click on the
  extension page works: Zen shows its "install blocked" bar ("Continue to Installation", as for any
  non-AMO source), then the normal permissions prompt. The result is a permanent `app-profile` install
  that survives restarts.
- `management` lists installed `*@foxsake` add-ons and reports when an install finishes. A daily alarm
  asks Google's update service for the latest versions and sets a badge.
- The store is a single-page app that keeps earlier pages in the DOM, hidden. The content script only
  anchors the button next to visible elements and re-places it when its spot gets hidden.
- Host access to Google's servers can be missing even though it's in `host_permissions` (it wasn't granted
  when updating from 1.0, and users can switch it off). The page checks `permissions.contains()` and asks
  with `permissions.request()` from a click, since Firefox only allows that inside a user action.
- Zen's `runtime.getBrowserInfo()` returns `name: "Firefox"` plus a `zen: {version}` field, which is how
  the button knows to say "Add to Zen".
- The Gecko version used for compatibility decisions comes from `rv:` in the user agent.

What the CLI does that the add-on doesn't: run `web-ext lint` (Node-only) before installing.
