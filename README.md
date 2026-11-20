# Fox Sake

Run Chrome Web Store extensions in [Zen Browser](https://zen-browser.app) and other Firefox-based browsers.

Fox Sake downloads a Chrome extension, converts it to a Firefox add-on, patches the
Chrome-only APIs it relies on, and installs it in Zen. It also writes a report of every
change it made and every API it couldn't make work.

It runs as a browser add-on: open an extension's page on the Chrome Web Store, click
**Add to Zen**, review what will and won't work, and click **Install**. Everything happens in the
browser. There's also a command-line version that does the same thing.

> **Personal use only.** Converted extensions are other people's software. Don't redistribute them.

## Install the add-on

### Use a separate profile

Setting `xpinstall.signatures.required` to `false` affects the whole profile, not just Fox Sake. Firefox
also stops checking the signatures of add-ons you already have, so any program running on your computer
could swap the files of, say, your password manager without Firefox noticing. Keep converted extensions in
their own Zen profile (open `about:profiles` and click **Create a New Profile**), and keep password
managers, banking, and add-ons that can control your browser or run programs in a profile where signatures
stay required. Fox Sake's page lists the add-ons in its profile that this applies to.

Never install `.xpi` files someone sends you in this profile: with signing off, Zen can't tell them apart from
real updates, and an update gets all of the extension's saved data. Install extensions through Fox Sake only.

### Steps

1. Allow unsigned add-ons (in the profile you'll use for converted extensions). Converted extensions can't be signed by Mozilla, so open `about:config`,
   search for `xpinstall.signatures.required` and set it to `false`. Zen honours this pref. In Firefox,
   use Developer Edition, Nightly or ESR; regular Firefox ignores it.
2. Download `foxsake-<version>.xpi` from the [latest release](https://github.com/Jprdgza/foxsake/releases/latest)
   and drag it into a Zen window, or build it yourself (see below).

## Use it

- On any extension page on [chromewebstore.google.com](https://chromewebstore.google.com/), click **🦊 Add to Zen**.
  A Fox Sake tab opens, downloads the extension and converts it. You'll see what was patched and what can't
  work in Firefox before anything is installed.
- Click **Install**. Zen asks twice: **Continue to Installation**, then **Add**. Firefox only lets an add-on
  start an install from a click, and the first bar appears for any install that isn't from addons.mozilla.org.
- The toolbar button opens the same page. From there you can also paste a store link or ID, convert a
  `.crx`, `.zip` or unpacked folder, see the extensions you've converted, and update them. Fox Sake checks
  the store for new versions once a day and shows a badge when there are some.

Each extension gets its own Firefox ID (`<chromeId>-<random>@foxsake`), and Fox Sake reuses it for updates,
so they keep its settings, storage and logins. Because part of it is random, nobody else can build a file
that installs over it. If a converted extension is replaced by a file Fox Sake didn't install anyway (for
example one converted before 2.0.5, which keeps its old `<chromeId>@foxsake` ID), Fox Sake shows a red
warning and asks you to remove it. When an update asks for new permissions, Fox Sake lists them in red above
the Install button. The Chrome ID part only comes from a signature Fox Sake has checked: a `.crx` with a forged or broken signature is refused,
and unsigned `.zip` files and folders get an ID based on their contents (`local-…@foxsake`), so they can't take
over an extension you already have. If a file you picked would replace an installed extension, Fox Sake asks
twice, because the new file gets all of that extension's saved data. The same goes for a file with the same
version number as the installed one but different contents. Fox Sake never installs an older version over a
newer one unless you pick **Install older version** (older versions can have security holes), and it
refuses old-format CRX2 files, which Chrome stopped accepting in 2019.

**Privacy.** Fox Sake only contacts Google's update servers (`clients2.google.com` and
`clients2.googleusercontent.com`): to download the extension you picked, and to ask for the latest version
of the ones you've converted. Nothing is sent anywhere else, and there's no analytics.

## Command-line version

Same converter, plus a `web-ext lint` check before installing. macOS and Node.js 20+.

```bash
git clone https://github.com/Jprdgza/foxsake.git
cd foxsake
npm install
npm link        # puts `foxsake` on your PATH
```

```bash
foxsake <web store url | extension id | file.crx | file.zip | folder>   # convert + install
foxsake scan <source>       # report Chrome-only usage without converting
foxsake convert <source>    # convert only: out/<name>-<version>.xpi + out/<name>.report.md
foxsake install <name>      # install something already converted
foxsake list                # converted extensions, installed versions, shims used
foxsake update [name]       # rebuild + reinstall anything with a newer store version
foxsake run <name>          # load it in a separate test profile, console saved to out/logs/
```

Like the add-on, the CLI won't replace an installed extension with an older version, a different build of
the same version, or a file that didn't come straight from the store. Add `--allow-downgrade` or `--replace`
to do it anyway. The CLI keeps each extension's Firefox ID in `out/ids.json`. If the add-on also manages an
extension, an update installed with the CLI looks like a foreign replacement to it; click
**I installed it myself** on its warning.

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

Every conversion produces a report (the add-on's **Save report**, or `out/<name>.report.md` from the CLI). It lists the compatibility findings (with file and line), the shims
injected and why, every manifest change with a before/after, the rewritten files, and the
CLI's `web-ext lint` results. If lint finds an error in `manifest.json`, the CLI stops instead of
handing Zen a package it would reject as "corrupt".

## Building the add-on

```bash
npm install
npm run build:addon      # out/foxsake-<version>.xpi and the unpacked out/addon/
```

The add-on is `addon/` plus an unmodified copy of `src/core/` and [fflate](https://github.com/101arrowz/fflate).
Nothing is minified. The only generated file is `lib/core/generated/assets.js`: shim sources and a Firefox
support table built from `@mdn/browser-compat-data` by `scripts/build-assets.js`. The build is deterministic,
so the same commit and lockfile give the same `.xpi`. `node scripts/build-addon.js --source` also writes the
source archive that addons.mozilla.org asks for.

## Development

```bash
npm run fixtures   # download real CRX fixtures to test/fixtures/real/ (not committed)
npm test
```

`src/core/` is pure (no filesystem or network access) and runs in Node and in the add-on.
`src/node/` holds the CLI side: Zen detection, lint, install. `addon/` is the add-on's own UI.

Debugging a conversion: `FOXSAKE_BIDI_PORT=9222 foxsake run <name>` starts a test window
you can drive with `scripts/zen-driver.js` and `scripts/drv.js` (WebDriver BiDi). To
evaluate code in an add-on's background or read its console, use `scripts/rdp.js`
(Firefox Remote Debugging Protocol).

## Changes

See [CHANGELOG.md](CHANGELOG.md) and the [releases page](https://github.com/Jprdgza/foxsake/releases).

## License

[MIT](LICENSE). "Chrome" and "Chrome Web Store" are trademarks of Google LLC. This project
is not affiliated with Google, Mozilla, or Zen.
