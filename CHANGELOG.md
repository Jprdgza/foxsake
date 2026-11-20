# Changelog

Notable changes to Fox Sake. Versions follow [semver](https://semver.org). Since 2.0.0 the add-on
and the CLI share one version number.

## 2.0.4 — 2026-11-19

Security fixes from a second review.

### Security

- **No more downgrades by default.** Fox Sake won't install an older version over a newer one, even when the
  older one is genuinely signed or comes from the Chrome Web Store: old releases can have security holes,
  and the replacement gets all of the installed extension's data. The add-on page has a separate
  **Install older version** button that asks twice; the CLI needs `--allow-downgrade`.
- **Same version, different contents gets a warning.** If a file has the installed version number but isn't
  the same build, the page says so and asks twice; the CLI needs `--replace`. Converted add-ons now record
  which package they were built from (`foxsake/source.json`).
- **CRX2 files are refused.** They're signed with SHA-1, and Chrome stopped accepting them in 2019.
- **The converter page warns about a shared profile.** It lists other installed add-ons that can run
  programs on your computer or read every website, such as password managers, and recommends a separate
  profile for converted extensions. It only reads the list; it never changes those add-ons.

### Changed

- The CLI no longer replaces an installed extension with a local file without `--replace`.
- Same-version files can't be compared with add-ons converted before 2.0.4, because those carry no record.
  Fox Sake asks before replacing them with a local file; a fresh store download of the same version still
  reinstalls normally.

## 2.0.3 — 2026-11-18

Security fixes from a review of 2.0.2.

### Security

- **CRX signatures are checked.** Fox Sake now verifies CRX3 signatures (RSA and ECDSA P-256) and CRX2
  signatures (RSA) before converting. A `.crx` with a forged or broken signature is refused. Before, a
  forged package that included a real extension's public key got that extension's ID, so installing it
  replaced the real extension and inherited its saved data.
- **IDs only come from verified packages.** `manifest.key` is ignored. Unsigned `.zip` files and folders get
  `local-<hash of the package>@foxsake` instead of `local-<name>@foxsake`, so a file can't take over another
  extension's ID by reusing its name. Store downloads must be signed by the extension that was asked for.
- **A second click before a local file replaces an installed extension,** with a warning that the file gets
  all of that extension's saved data.
- `externally_connectable` patterns that Chrome rejects (`<all_urls>`, `*://*/*`, `*.com`, `*.co.uk`,
  `*.github.io`, …) are dropped and listed in the report, instead of letting every website message the extension.
- The offscreen shim only loads pages packaged with the extension, as Chrome does.
- The **Converted extensions** list only shows add-ons this Fox Sake converted, not every `@foxsake` ID.

### Changed

- The README recommends a separate Zen profile for converted extensions: turning off signature checks also
  turns them off for the add-ons you already have.
- Unsigned local packages now get a new ID whenever their contents change, so a changed `.zip` or folder
  installs as a separate add-on and starts with empty settings.
- Extensions installed with the command-line version, or with Fox Sake before 2.0.3 without a saved report,
  no longer appear in the add-on's list. Convert them again from the add-on (for example with **Add to Zen**
  on their store page) to bring them back.

## 2.0.2 — 2026-11-16

### Changed

- The fox icon has eyes now.

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
