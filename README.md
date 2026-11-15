# Fox Sake

Run Chrome Web Store extensions in [Zen Browser](https://zen-browser.app) and other Firefox-based browsers.

Fox Sake downloads a Chrome extension, converts it to a Firefox add-on, patches the
Chrome-only APIs it relies on, and installs it in Zen. It also writes a report of every
change it made and every API it couldn't make work.

```
$ foxsake https://chromewebstore.google.com/detail/quillbot/iidnbdjijdkbmajdffnidomddglmieko
↓ Downloading iidnbdjijdkbmajdffnidomddglmieko from the Chrome Web Store…
⚙ Converting…
🔎 Running web-ext lint…

✔ Quillbot 4.124.1 → out/quillbot-4.124.1.xpi
  Firefox ID: iidnbdjijdkbmajdffnidomddglmieko@foxsake
  Shims: id-remap, sw-globals, sidePanel, external, external-bridge, docs-canvas
  Report: out/quillbot.report.md

🦊 Opening Zen's install prompt. In Zen, click "Add".
✔ Installed permanently in Zen (enabled).
```

> **Personal use only.** Converted extensions are other people's software. Don't redistribute them.

## Requirements

- macOS (Zen detection and the native helper are macOS-only for now)
- Node.js 20+
- Zen Browser with unsigned add-ons allowed: in `about:config`, set
  `xpinstall.signatures.required` to `false`. Zen release builds honour this pref;
  stock Firefox Release does not (use Developer Edition, Nightly or ESR there).

## Install

```bash
git clone https://github.com/Jprdgza/foxsake.git
cd foxsake
npm install
npm link        # puts `foxsake` on your PATH
```

## Usage

```bash
foxsake <web store url | extension id | file.crx | file.zip | folder>   # convert + install
foxsake scan <source>       # report Chrome-only usage without converting
foxsake convert <source>    # convert only: out/<name>-<version>.xpi + out/<name>.report.md
foxsake install <name>      # install something already converted
foxsake list                # converted extensions, installed versions, shims used
foxsake update [name]       # rebuild + reinstall anything with a newer store version
foxsake run <name>          # load it in a separate test profile, console saved to out/logs/
foxsake button install      # add an "Add to Zen" button to the Chrome Web Store
```

Each extension gets the deterministic Firefox ID `<chromeId>@foxsake`, so reinstalls and
updates keep its storage, settings and logins.

### "Add to Zen" button

`foxsake button install` installs a small add-on that puts an **Add to Zen** button on
Chrome Web Store pages. The button sends the extension ID to a local
[native messaging](https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
helper, which runs the same pipeline as the CLI and opens Zen's install prompt.
The helper only accepts a 32-character extension ID; it never takes paths or commands.

## What gets converted

**Manifest.** Fox Sake adds `browser_specific_settings.gecko`, turns
`background.service_worker` into `background.scripts` (following static `importScripts`),
turns `side_panel` into `sidebar_action`, and drops keys and permissions that Firefox doesn't
support. Support is decided by [`@mdn/browser-compat-data`](https://github.com/mdn/browser-compat-data)
for the installed Zen's Gecko version, not by a hand-written list.

**Shims.** A shim is injected only if the static scan or the manifest shows the extension needs it:

| Shim | Purpose |
|---|---|
| `sw-globals` | `self.registration`, `clients`, `skipWaiting`, `importScripts`, install/activate events in a background page |
| `offscreen` | `chrome.offscreen` as a hidden iframe in the background page (which already has a DOM) |
| `sidePanel` | `chrome.sidePanel` → `sidebarAction` |
| `external`, `external-bridge` | Lets sites in `externally_connectable` call `chrome.runtime.sendMessage(id, …)` (main-world script → `postMessage` → content script → `onMessageExternal`) |
| `id-remap` | Messages addressed to the old Chrome ID go to the new Firefox ID |
| `manifest-extras` | `getManifest()` still returns removed fields such as `update_url` |
| `identity` | `getAuthToken` fails with a clear error; `getProfileUserInfo` reports signed out |
| `tts` | `chrome.tts` on top of the Web Speech API |
| `storageManaged` | `storage.managed.get()` returns `{}` without a policy instead of throwing |
| `portLastError` | Port disconnect errors show up in `runtime.lastError` inside `onDisconnect`, as in Chrome |
| `declarativeContent` | Rules accepted as no-ops |
| `docs-canvas` | Sets Google Docs' `_docs_annotate_canvas_by_ext` to the original ID (experimental) |

**Code rewrites.** `chrome-extension://` URLs become `runtime.getURL()` or `moz-extension://`,
and `Function("return this")()` becomes `globalThis`. That second one matters: in Firefox
content scripts, lodash's global-object check fails because of Xray wrappers, and the
eval fallback is then blocked by the extension CSP, which takes down the whole script.

**Not shimmed.** Some APIs have no Firefox equivalent: `tabCapture`, `desktopCapture`,
`debugger`, `gcm`, `identity.getAuthToken` (Chrome-account sign-in), and so on. The
report marks them as unsupported instead of faking them.

See [docs/design.md](docs/design.md) for the details.

## Reports

`out/<name>.report.md` lists the compatibility findings (with file and line), the shims
injected and why, every manifest change with a before/after, the rewritten files, and the
`web-ext lint` results. If lint finds an error in `manifest.json`, Fox Sake stops instead of
handing Zen a package it would reject as "corrupt".

## Development

```bash
npm run fixtures   # download real CRX fixtures to test/fixtures/real/ (not committed)
npm test
```

`src/core/` is pure (no filesystem or network access) and runs in Node or a browser.
`src/node/` holds the CLI side: Zen detection, downloads, lint, install, and the native helper.

Debugging a conversion: `FOXSAKE_BIDI_PORT=9222 foxsake run <name>` starts a test window
you can drive with `scripts/zen-driver.js` and `scripts/drv.js` (WebDriver BiDi). To
evaluate code in an add-on's background or read its console, use `scripts/rdp.js`
(Firefox Remote Debugging Protocol).

## Changes

See [CHANGELOG.md](CHANGELOG.md) and the [releases page](https://github.com/Jprdgza/foxsake/releases).

## License

[MIT](LICENSE). "Chrome" and "Chrome Web Store" are trademarks of Google LLC. This project
is not affiliated with Google, Mozilla, or Zen.
