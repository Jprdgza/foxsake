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
  → unwrap CRX3 (CRX2 is refused) → read ZIP
  → scan JS for Chrome-only usage
  → rewrite manifest (BCD-driven)
  → inject shims + rewrite code
  → write .xpi → web-ext lint → report → registry
  → open Zen's install prompt
```

Everything up to "write .xpi" lives in `src/core/` and has no Node dependencies.

## CRX parsing

CRX3: `"Cr24"`, uint32 version, uint32 header length, protobuf `CrxFileHeader`, then the ZIP.
CRX2 (version 2) is refused outright. Its signatures use SHA-1, and Chrome stopped installing it in 2019,
so a CRX2 file is always an old package from somewhere other than the store. The download URLs ask Google
for CRX3 only.
The parser bounds-checks every offset and requires the payload to start with a ZIP signature.
ZIP entries with `..` or absolute paths are rejected, and entry count and total size are capped.
Fox Sake never executes downloaded code.

Signatures are checked with WebCrypto, so the CLI and the add-on run the same code:

- CRX3 signs `"CRX3 SignedData\0"`, the uint32 LE length of `signed_header_data`, `signed_header_data`
  and the ZIP. Proofs can be RSASSA-PKCS1-v1_5/SHA-256 (header field 2) or ECDSA P-256/SHA-256
  (field 3, DER signatures). Every proof must verify, as in Chrome, and `crx_id` must be the
  SHA-256 prefix of one of the keys that signed. Store downloads carry two proofs: the developer's key
  and the Web Store's publisher key.

## Add-on IDs

The Firefox ID decides which installed add-on a conversion replaces, and so whose saved data
(`storage`, IndexedDB, granted permissions) the new code inherits. It only comes from a verified signature:

- Store downloads: the base is the Chrome ID, and the download has to be signed by the extension that was asked for.
- A signed `.crx` file: the Chrome ID of the key whose signature verified.
- Unsigned packages (`.zip`, folders): `local-<first 16 hex of SHA-256 of the package>`. `manifest.key`
  is ignored because it's a public key anyone can copy. A changed file gets a new base, so it installs
  alongside the old one instead of taking over its data.

The Firefox ID is `<base>-<16 random hex>@foxsake` (`src/core/ids.js`). The random part is picked the first
time an extension is converted and saved (`storage.local.ids` in the add-on, `out/ids.json` in the CLI), and
every later conversion reuses the ID of the installed copy, so updates keep its data. It has to be random:
with signing off, Firefox installs any `.xpi` that carries an existing ID as an update of that add-on, data
included, and a Chrome ID is public. Add-ons converted before 2.0.5 keep `<base>@foxsake`, since a new ID
would mean starting with empty storage; the watcher below covers them.

### Replacements Fox Sake didn't make

Fox Sake can't stop someone from installing a ready-made `.xpi` with a converted add-on's ID, and it can't
undo it either: `management.setEnabled` only works on themes (and on add-ons installed by enterprise policy),
and there is no way for one add-on to uninstall another. So it detects and tells:

- Before navigating to the install blob, the page saves a token `{version, sha256, permissions, expires}`
  (15 minutes) in `storage.local.pending`.
- `management.onInstalled`, in the background and on the page, accepts an install of a converted add-on
  only with a matching token, and records it in `installs`. Anything else goes into `flagged`: the badge
  turns into a red "!" and the background opens the page, whose red card tells the user to remove the add-on
  in `about:addons` unless they installed it themselves. "I installed it myself" asks twice.
- The browser doesn't promise to wake an idle event page for other add-ons' installs, so the background also
  compares installed versions with `installs` at startup and every 15 minutes (`checkReplacements()`).
  An add-on seen for the first time is taken as it is. This check can't see a same-version replacement; the
  event listener can.
- Installs made with the CLI aren't seen by the add-on, so they're flagged if the add-on also tracks that
  extension. "I installed it myself" clears it.

## Replacing an installed add-on

A valid signature only proves who made a package, not that it's the release you should have. An old
release with a known hole is still genuinely signed, and installing it over the current one gives it all of
that extension's data. `checkReplacement()` (`src/core/replace.js`) decides what happens, and the add-on
page and the CLI both use it:

| Incoming vs. installed | Add-on page | CLI |
|---|---|---|
| Not installed | Install | installs |
| Newer, fresh store download | Update | installs |
| Newer, local file | "Replace …" asks twice | needs `--replace` |
| Same version, same build | Reinstall | installs |
| Same version, different build | "Replace …" asks twice, says it isn't the same build | needs `--replace` |
| Same version, installed build unknown | store: Reinstall; file: asks twice | store: installs; file: needs `--replace` |
| Older (any source, the store too) | no Install button; a separate "Install older version…" asks twice | needs `--allow-downgrade` |

Versions are compared numerically (`1.2.10` > `1.2.9`). The "build" is `packageSha256`, the SHA-256 of
the extension's ZIP (inside a CRX, the ZIP after the header), so a re-signed copy of the same files still
matches. Each converted add-on carries it in `foxsake/source.json`; the CLI reads it back from
`<profile>/extensions/<id>.xpi`. The add-on page can't read other add-ons' files, so it saves
`{version, sha256}` in `storage.local.installs` when `management.onInstalled` reports an install it
started, and forgets it on uninstall. Add-ons converted before 2.0.4 have no record ("unknown").

## Manifest rewriting

- `browser_specific_settings.gecko.id` (see "Add-on IDs"), `strict_min_version = "128.0"`
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
  closing offscreen documents. As in Chrome, `createDocument` only accepts a page inside the
  extension; other URLs are refused.
- **sidePanel**: `sidebarAction.open()`/`toggle()` must run synchronously inside a user
  gesture, so those wrappers deliberately avoid `await`.
- **external messaging**: the main-world script chains to any existing
  `chrome.runtime.sendMessage`, so several converted extensions can share a page. The
  background hides bridged messages from ordinary `onMessage` listeners. Patterns Chrome
  refuses (`<all_urls>`, a `*` host, or `*.` followed by a public suffix such as `com`, `co.uk` or
  `github.io`) are dropped and listed in the report. The suffix check is a short built-in list,
  not the full Public Suffix List.

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
- `management` lists installed add-ons and reports when an install finishes. The page only shows the ones
  this Fox Sake converted (IDs kept in `storage.local.reports`), not every `*@foxsake` ID. A daily alarm
  asks Google's update service for the latest versions and sets a badge. Update buttons only appear for
  newer versions, and a store download is still checked against the installed version, so the store can't
  roll an extension back.
- The page also lists other add-ons in the profile that aren't Fox Sake conversions and either use
  `nativeMessaging` or have host access to every site (`<all_urls>`, `*://*/*`), with a notice to use a
  separate profile: with signing off, their files could be swapped without the browser noticing. It only
  reads `management.getAll()`; it never disables or changes other add-ons.
- The store is a single-page app that keeps earlier pages in the DOM, hidden. The content script only
  anchors the button next to visible elements and re-places it when its spot gets hidden.
- Host access to Google's servers can be missing even though it's in `host_permissions` (it wasn't granted
  when updating from 1.0, and users can switch it off). The page checks `permissions.contains()` and asks
  with `permissions.request()` from a click, since Firefox only allows that inside a user action.
- Zen's `runtime.getBrowserInfo()` returns `name: "Firefox"` plus a `zen: {version}` field, which is how
  the button knows to say "Add to Zen".
- The Gecko version used for compatibility decisions comes from `rv:` in the user agent.

What the CLI does that the add-on doesn't: run `web-ext lint` (Node-only) before installing.
