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

## Test runs

`foxsake run` uses a dedicated, persistent profile in `out/dev-profile`. Don't give
web-ext a copy of a real profile. A copy keeps `toolkit.profiles.storeID`, and on startup it
registers itself in the original's profile group, rewriting `profiles.ini`, `installs.ini`
and `Profile Groups/<id>.sqlite`. `run` snapshots those files before and after each run and
warns if anything changed.

Pages under automation report `navigator.webdriver`, so Cloudflare-protected sites show a
challenge page in automated test windows.

## "Add to Zen" button

An add-on can't install other add-ons in Firefox, so the button delegates to a native
messaging helper that runs the CLI pipeline. The helper manifest is written to both
`~/Library/Application Support/Mozilla/NativeMessagingHosts/` (where Zen actually looks)
and Zen's own `NativeMessagingHosts` folder. The helper opens the install prompt *before*
replying, because Firefox may terminate a `sendNativeMessage` host as soon as it answers.
