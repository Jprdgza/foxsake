# Changelog

Notable changes to Fox Sake. Versions follow [semver](https://semver.org); the
"Add to Zen" button add-on has its own version number, noted where it changed.

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
