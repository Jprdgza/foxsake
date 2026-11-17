# Changelog

Notable changes to Fox Sake. Versions follow [semver](https://semver.org). Since 2.0.0 the add-on
and the CLI share one version number.

## 2.0.1 — 2026-11-16

### Fixed

- The **Add to Zen** button now appears when you move between extensions inside the store. Before, you
  had to refresh: the store keeps earlier pages in the page, hidden, and the button attached itself to one of them.
- "Couldn't reach the Chrome Web Store" when Firefox hadn't granted access to Google's download servers.
  That happens after updating from 1.0, or if the access is turned off in the add-on's settings. Fox Sake
  now notices and shows an **Allow access** button, then carries on with the download.

### Changed

- A simpler fox icon. `docs/icon-128.png` is the PNG version for store listings.

## 2.0.0 — 2026-11-15

Fox Sake is now a browser add-on that does everything by itself: no Terminal, Node.js, or helper program.

### Added

- **Converter in the add-on.** Click **Add to Zen** on a Chrome Web Store page, review what was patched
  and what can't work, then click **Install**. The same converter as the CLI; the output is byte-identical.
- **Fox Sake page** (toolbar button): convert from a store link or ID, a `.crx`/`.zip` file, or an
  unpacked folder; list converted extensions; update them.
- Daily update check with a toolbar badge.
- `npm run build:addon` builds the add-on from source; `--source` writes the archive AMO asks for.

### Changed

- The button says "Add to Zen" in Zen and "Add to Firefox" elsewhere.
- Download code moved into the shared core and now rejects non-string IDs.

### Removed

- The native messaging helper and `foxsake button install|uninstall`. If you set up 1.0, you can delete
  `foxsake.json` from `~/Library/Application Support/Mozilla/NativeMessagingHosts/` and
  `~/Library/Application Support/zen/NativeMessagingHosts/`.

## 1.0.0 — 2026-11-15

First release.

### Converter

- Takes a Chrome Web Store URL, extension ID, `.crx` (v2 or v3), `.zip` or unpacked folder.
- Rewrites the manifest for Firefox: Gecko ID `<chromeId>@foxsake`, service worker →
  event page (static `importScripts` followed), `side_panel` → `sidebar_action`.
  Unsupported keys and permissions are dropped based on `@mdn/browser-compat-data`
  for the installed Zen's Gecko version.
- Shims for `offscreen`, `sidePanel`, external messaging from websites, service-worker
  globals, `tts`, `identity`, `declarativeContent`, `storage.managed` and port errors.
  Each is injected only when the scan says the extension needs it.
- Code rewrites for `chrome-extension://` URLs and `Function("return this")()`
  (fixes lodash-based content scripts under Firefox's CSP).
- A Markdown report per extension: findings with file and line, shims and why,
  manifest diff, `web-ext lint` results.
- Refuses to hand Zen a package whose `manifest.json` fails lint, instead of letting
  Zen reject it as "corrupt".

### CLI

- `foxsake <source>`, `scan`, `convert`, `install`, `list`, `update`, `run`, `button`.
- Installs into Zen permanently (unsigned) and waits until the add-on shows up in the profile.
- `run` uses its own test profile in `out/dev-profile` and checks that Zen's profile
  files weren't touched.

### "Add to Zen" button (add-on 1.0.1)

- Adds an **Add to Zen** button to Chrome Web Store pages, backed by a local
  native messaging helper (`foxsake button install`).
- The helper only accepts a 32-letter extension ID, from this add-on only.

### Hardening

- Downloads are streamed with a 300 MB cap; ZIPs are limited to 20,000 entries and
  512 MB, checked against the real decompressed size.
- Package-supplied values (like `version`) are sanitized before being used in file names.
- Folder input never follows symlinks.
- The website bridge trusts Firefox's `sender.url`, not URLs inside messages.

### Tested with

uBlock Origin Lite, Dark Reader, Grammarly, LastPass, Honey, Adobe Acrobat, React DevTools,
Vimium, Tampermonkey, Loom, Momentum, Google Translate, Volume Master, ChatGPT search and
QuillBot all install in Zen 1.24 (Gecko 160). See [docs/design.md](docs/design.md) for known gaps.
