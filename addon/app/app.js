// Fox Sake page: gets a Chrome extension (store download, file or folder), converts it in a
// worker, shows what will and won't work, and installs it.
// Installing must start directly from a click on this page: Firefox cancels add-on installs
// that don't come from a user gesture, so the Install button navigates to the package itself.
import { downloadCrx, parseExtensionId } from "../lib/core/webstore.js";
import { safeFilePart } from "../lib/core/archive.js";
import { checkReplacement } from "../lib/core/replace.js";
import { convertedAddons, checkUpdates, sharedProfileRisks } from "./library.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
};

// Zen reports its Gecko (Firefox engine) version as "rv:NNN" in the user agent; the converter
// uses it to decide which Firefox APIs and manifest keys are available.
const geckoVersion = (() => {
  const m = /rv:(\d+)(\.\d+)?/.exec(navigator.userAgent);
  return m ? `${m[1]}${m[2] ?? ".0"}` : undefined;
})();
const MAX_FOLDER_BYTES = 512 * 1024 * 1024;
// Google's update servers. Firefox can leave these ungranted (e.g. after updating from a version
// that didn't need them), and permissions.request() only works directly inside a click handler.
const DOWNLOAD_ACCESS = { origins: ["https://clients2.google.com/*", "https://clients2.googleusercontent.com/*"] };
const askForAccess = () => browser.permissions.request(DOWNLOAD_ACCESS).catch(() => false);
let pendingStoreJob = null; // a store download waiting for the user to allow access
const MAX_REPORT_CHARS = 200_000;

let browserName = "Firefox";
let busy = false;
let current = null; // { meta, installUrl, urls, confirm, older }

// --- conversion job -------------------------------------------------------------------------

function setStatus(text, kind = "") {
  $("job-status").textContent = text;
  $("job-status").className = kind || "muted";
}

function setProgress(done, total) {
  const bar = $("job-progress");
  bar.hidden = done === false;
  if (total) { bar.max = total; bar.value = done; } else bar.removeAttribute("value");
}

function startJob(title) {
  if (current) current.urls.forEach((u) => URL.revokeObjectURL(u));
  current = null;
  $("job").hidden = false;
  $("job-title").textContent = title;
  $("job-result").hidden = true;
  $("install-hint").hidden = true;
  $("install-older").hidden = true;
  setStatus("Starting…");
  setProgress(0, 0);
  $("job").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function run(title, getPackage) {
  if (busy) return;
  busy = true;
  startJob(title);
  try {
    const pkg = await getPackage();
    setStatus("Converting…");
    setProgress(0, 0);
    const result = await convertInWorker({ ...pkg, targetVersion: geckoVersion });
    await showResult(result, { fromStore: !!pkg.chromeId });
  } catch (e) {
    setProgress(false);
    $("job-title").textContent = e instanceof NeedsAccess ? "One more step" : "Couldn't convert";
    setStatus(friendlyError(e), e instanceof NeedsAccess ? "" : "error");
  } finally {
    busy = false;
  }
}

function friendlyError(e) {
  const msg = String(e && e.message ? e.message : e);
  if (/NetworkError|Failed to fetch/i.test(msg)) return "Couldn't reach the Chrome Web Store. Check your connection and try again.";
  return msg;
}

function convertInWorker(job) {
  return new Promise((resolve, reject) => {
    const w = new Worker("worker.js", { type: "module" });
    w.onmessage = ({ data }) => { w.terminate(); data.ok ? resolve(data) : reject(new Error(data.error)); };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || "The converter crashed.")); };
    const transfer = job.bytes ? [job.bytes.buffer] : job.files.map(([, b]) => b.buffer);
    w.postMessage(job, transfer);
  });
}

class NeedsAccess extends Error {}

async function checkAccess() {
  const ok = await browser.permissions.contains(DOWNLOAD_ACCESS);
  $("access").hidden = ok;
  return ok;
}

const fromStore = (chromeId) => async () => {
  if (!(await checkAccess())) {
    pendingStoreJob = chromeId;
    throw new NeedsAccess("Fox Sake needs access to Google's download servers first. Click \"Allow access\" above, and it will continue.");
  }
  setStatus("Downloading from the Chrome Web Store…");
  const bytes = await downloadCrx(chromeId, {
    onProgress: (n, total) => {
      setProgress(n, total);
      setStatus(`Downloading from the Chrome Web Store… ${(n / 1e6).toFixed(1)} MB`);
    },
  });
  return { bytes, chromeId, source: `https://chromewebstore.google.com/detail/${chromeId}` };
};

const fromFile = (file) => async () => {
  setStatus(`Reading ${file.name}…`);
  return { bytes: new Uint8Array(await file.arrayBuffer()), source: file.name };
};

const fromFolder = (fileList) => async () => {
  const list = [...fileList];
  const size = list.reduce((s, f) => s + f.size, 0);
  if (size > MAX_FOLDER_BYTES) throw new Error("That folder is over 512 MB; refusing.");
  setStatus(`Reading ${list.length} files…`);
  const files = await Promise.all(list.map(async (f) => [f.webkitRelativePath || f.name, new Uint8Array(await f.arrayBuffer())]));
  return { files, source: list[0]?.webkitRelativePath.split("/")[0] ?? "folder" };
};

// What the page says and does when a conversion would replace an installed add-on. The replacement
// gets everything the installed one saved, so older versions and other builds need a deliberate choice.
function replacementPlan(kind, installed, meta, fromStore) {
  const keep = "its settings, logins, and any other stored data";
  const trust = "Only continue if you trust where this file came from.";
  switch (kind) {
    case "new":
      return { status: "Converted. Nothing is installed until you click Install.", button: `Install in ${browserName}` };
    case "upgrade":
      return fromStore
        ? { status: `Version ${installed.version} is installed. Installing replaces it and keeps its settings and data.`, button: `Update in ${browserName}` }
        : {
          status: `This file would replace ${installed.name} ${installed.version}, which is installed, and get all of its saved data.`,
          error: true,
          button: `Replace ${installed.name}…`,
          warning: `This file didn't come straight from the Chrome Web Store. Installing it replaces ${installed.name} ` +
            `and gives the new code everything ${installed.name} has saved: ${keep}. ${trust} Click "Replace anyway" to continue.`,
        };
    case "same-build":
      return { status: `This is the same build of ${installed.name} ${installed.version} that's installed. Reinstalling keeps its settings and data.`, button: "Reinstall" };
    case "unknown-build":
      if (fromStore) return { status: `Version ${installed.version} is installed. Installing reinstalls it from the Chrome Web Store and keeps its settings and data.`, button: "Reinstall" };
      // falls through: a same-version file Fox Sake can't match to what's installed
    case "different-build": {
      const what = kind === "different-build"
        ? "isn't the same build as the one installed: its contents are different"
        : "may not be the same build as the one installed (Fox Sake has no record of what was installed)";
      return {
        status: `${installed.name} ${installed.version} is installed. This file has the same version number but ${what}. It would get all of the installed add-on's saved data.`,
        error: true,
        button: `Replace ${installed.name}…`,
        warning: `The version number matches, but this ${kind === "different-build" ? "isn't" : "might not be"} the build you have installed: ` +
          `someone may have changed it, or it came from somewhere else. Installing it gives that code everything ${installed.name} has saved: ${keep}. ` +
          `${trust} Click "Replace anyway" to continue.`,
      };
    }
    case "downgrade":
      return {
        status: `This is version ${meta.version}, older than the ${installed.version} you have installed. Fox Sake doesn't replace a newer version ` +
          `with an older one: older versions can have security holes that were fixed later, and this one would get all of ${installed.name}'s saved data.`,
        error: true,
        older: `Installing ${installed.name} ${meta.version} replaces ${installed.version} and gives the older code everything ${installed.name} has saved: ${keep}. ` +
          `Older versions may have security holes that newer ones fixed, and someone could send you one on purpose. ` +
          `Only do this if you know why you need this version and trust where it came from. Click "Install older version anyway" to continue.`,
      };
    default:
      throw new Error(`Unknown replacement kind ${kind}`);
  }
}

async function showResult({ xpi, meta, report, classified }, { fromStore }) {
  setProgress(false);
  $("job-title").textContent = `${meta.name} ${meta.version}`;

  let installed = null;
  try { installed = await browser.management.get(meta.geckoId); } catch { /* not installed */ }
  // The package fingerprint Fox Sake saved when it installed this add-on, if it's still that version.
  const { installs = {} } = await browser.storage.local.get("installs");
  const record = installed && installs[meta.geckoId]?.version === installed.version ? installs[meta.geckoId] : null;
  const { kind } = checkReplacement({
    installed: installed && { version: installed.version, sha256: record?.sha256 ?? null },
    incoming: { version: meta.version, sha256: meta.packageSha256 },
    fromStore,
  });
  const plan = replacementPlan(kind, installed, meta, fromStore);
  setStatus(plan.status, plan.error ? "error" : "");

  const summary = $("job-summary");
  summary.replaceChildren();
  const item = (cls, text) => summary.append(el("li", { className: cls, textContent: text }));
  const unsupported = classified.filter((f) => f.status === "unsupported");
  const experiments = classified.filter((f) => f.status === "experiment");
  if (meta.shims.length) item("ok", `Patched for ${browserName}: ${meta.shims.join(", ")}`);
  for (const f of experiments) item("warn", `Experimental: ${f.title}${f.note ? `. ${f.note}` : ""}`);
  for (const f of unsupported) item("bad", `Won't work: ${f.title}${f.note ? `. ${f.note}` : ""}`);
  if (!classified.length) item("ok", "No Chrome-only code found.");
  else if (!meta.shims.length && !unsupported.length && !experiments.length) item("ok", "Nothing needed patching.");

  const base = `${safeFilePart(meta.slug)}-${safeFilePart(meta.version)}`;
  const installUrl = URL.createObjectURL(new Blob([xpi], { type: "application/x-xpinstall" }));
  const saveUrl = URL.createObjectURL(new Blob([xpi], { type: "application/octet-stream" }));
  const reportUrl = URL.createObjectURL(new Blob([report], { type: "text/markdown" }));
  current = { meta, installUrl, urls: [installUrl, saveUrl, reportUrl], confirm: plan.warning ?? null, older: plan.older ?? null };
  Object.assign($("save-xpi"), { href: saveUrl, download: `${base}.xpi` });
  Object.assign($("save-report"), { href: reportUrl, download: `${base}.report.md` });
  // A downgrade has no normal Install button, only the separate, clearly labeled one.
  $("install").hidden = !!plan.older;
  $("install").textContent = plan.button ?? "";
  $("install").disabled = false;
  $("install-older").hidden = !plan.older;
  $("install-older").textContent = "Install older version…";
  $("install-older").disabled = false;
  $("report").textContent = report;
  $("job-result").hidden = false;

  const { reports = {} } = await browser.storage.local.get("reports");
  reports[meta.geckoId] = { meta, report: report.slice(0, MAX_REPORT_CHARS) };
  await browser.storage.local.set({ reports });
}

function startInstall() {
  // Synchronous on purpose: the navigation has to happen inside the click.
  location.href = current.installUrl;
  const hint = $("install-hint");
  hint.className = "hint";
  hint.textContent = `${browserName} will ask you twice: click "Continue to Installation", then "Add". ` +
    `If it says the add-on "could not be verified", unsigned add-ons aren't allowed yet (see the note at the bottom).`;
  hint.hidden = false;
}

// First click on a risky action only explains; the second one installs.
function warnFirst(button, text, again) {
  const hint = $("install-hint");
  hint.className = "hint warn";
  hint.textContent = text;
  hint.hidden = false;
  button.textContent = again;
}

$("install").addEventListener("click", () => {
  if (!current || current.older) return;
  if (current.confirm) {
    warnFirst($("install"), current.confirm, "Replace anyway");
    current.confirm = null;
    return;
  }
  startInstall();
});

$("install-older").addEventListener("click", () => {
  if (!current || !current.older) return;
  if (!current.olderConfirmed) {
    warnFirst($("install-older"), current.older, "Install older version anyway");
    current.olderConfirmed = true;
    return;
  }
  startInstall();
});

browser.management.onInstalled.addListener(async (info) => {
  if (current && info.id === current.meta.geckoId) {
    const hint = $("install-hint");
    hint.className = "hint ok";
    hint.textContent = `Installed ${info.name} ${info.version}.`;
    hint.hidden = false;
    $("install").disabled = true;
    $("install-older").disabled = true;
    // Remember which package was installed, so a later file with the same version can be checked.
    if (info.version === current.meta.version) {
      const { installs = {} } = await browser.storage.local.get("installs");
      installs[info.id] = { version: info.version, sha256: current.meta.packageSha256 };
      await browser.storage.local.set({ installs });
    }
  }
  refreshLibrarySoon();
});
browser.management.onUninstalled.addListener(async (info) => {
  const { installs = {} } = await browser.storage.local.get("installs");
  if (installs[info.id]) {
    delete installs[info.id];
    await browser.storage.local.set({ installs });
  }
  refreshLibrarySoon();
});
browser.management.onEnabled.addListener(() => refreshLibrarySoon());
browser.management.onDisabled.addListener(() => refreshLibrarySoon());

// onInstalled can fire before management.getAll() lists the new add-on, so refresh twice.
function refreshLibrarySoon() {
  renderLibrary();
  renderSharedProfile();
  setTimeout(() => { renderLibrary(); renderSharedProfile(); }, 1000);
}

// --- inputs -----------------------------------------------------------------------------------

$("allow").addEventListener("click", async () => {
  const granted = await askForAccess(); // first thing in the click, as Firefox requires
  await checkAccess();
  if (granted && pendingStoreJob) {
    const id = pendingStoreJob;
    pendingStoreJob = null;
    run("Converting…", fromStore(id));
  }
});

$("by-id").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const access = askForAccess(); // must start inside the click; resolves at once if already granted
  const id = parseExtensionId($("source").value);
  if (!id) {
    startJob("Couldn't convert");
    setProgress(false);
    setStatus("That isn't a Chrome Web Store link or a 32-letter extension ID.", "error");
    return;
  }
  await access;
  run("Converting…", fromStore(id));
});

$("pick-file").addEventListener("change", (ev) => {
  const file = ev.target.files[0];
  if (file) run(`Converting ${file.name}…`, fromFile(file));
  ev.target.value = "";
});

$("pick-folder").addEventListener("change", (ev) => {
  if (ev.target.files.length) run("Converting folder…", fromFolder(ev.target.files));
  ev.target.value = "";
});

const drop = $("drop");
drop.addEventListener("dragover", (ev) => { ev.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (ev) => {
  ev.preventDefault();
  drop.classList.remove("over");
  const file = ev.dataTransfer.files[0];
  if (file) run(`Converting ${file.name}…`, fromFile(file));
});

// --- library ----------------------------------------------------------------------------------

let renderSeq = 0;
async function renderLibrary() {
  const seq = ++renderSeq;
  const [list, { updates }] = await Promise.all([convertedAddons(), browser.storage.local.get("updates")]);
  if (seq !== renderSeq) return; // a newer refresh started meanwhile
  const versions = updates?.versions ?? {};
  const ul = $("library");
  ul.replaceChildren();
  if (!list.length) {
    ul.append(el("li", { className: "muted", textContent: "Nothing yet." }));
  }
  for (const a of list) {
    const li = el("li", {},
      el("span", { className: "name", textContent: a.name + (a.enabled ? "" : " (disabled)") }),
      el("span", { className: "ver", textContent: a.version }));
    const latest = versions[a.id];
    if (latest && a.chromeId) {
      const b = el("button", { className: "primary", textContent: `Update to ${latest}` });
      b.addEventListener("click", async () => {
        await askForAccess();
        run(`Updating ${a.name}…`, fromStore(a.chromeId));
      });
      li.append(b);
    }
    ul.append(li);
  }
  $("updates-status").textContent = updates?.checkedAt
    ? `Last checked ${new Date(updates.checkedAt).toLocaleString()}.`
    : "";
}

// Other add-ons in this profile that could do real damage if their files were swapped. With signing
// off, Zen no longer checks them. Read-only: Fox Sake never disables or changes them.
let sharedSeq = 0;
async function renderSharedProfile() {
  const seq = ++sharedSeq;
  const { risky, convertedInstalled } = await sharedProfileRisks();
  if (seq !== sharedSeq) return;
  $("shared-profile").hidden = !risky.length;
  $("shared-profile-text").textContent = convertedInstalled
    ? `Signing is off in this profile, so these add-ons can be modified without ${browserName} noticing. Use a separate profile for converted extensions.`
    : `Converted extensions need signing turned off, and that applies to the whole profile: these add-ons could then be modified without ${browserName} noticing. Use a separate profile for converted extensions.`;
  $("shared-profile-list").replaceChildren(...risky.map((a) => el("li", {},
    el("span", { className: "name", textContent: a.name + (a.enabled ? "" : " (disabled)") }),
    el("span", { className: "why", textContent: a.reasons.join(", ") }))));
}

$("check-updates").addEventListener("click", async () => {
  await askForAccess();
  checkAccess();
  const b = $("check-updates");
  b.disabled = true;
  $("updates-status").textContent = "Checking…";
  try {
    const found = await checkUpdates();
    await renderLibrary();
    $("updates-status").textContent = Object.keys(found).length ? "Updates available." : "Everything is up to date.";
  } catch (e) {
    $("updates-status").textContent = `Update check failed: ${friendlyError(e)}`;
  } finally {
    b.disabled = false;
  }
});

// --- start --------------------------------------------------------------------------------------

browser.runtime.getBrowserInfo().then((i) => {
  // Zen reports itself to add-ons as "Firefox" plus a `zen` field with its own version.
  browserName = i.zen ? "Zen" : i.name || "Firefox";
  renderSharedProfile();
  const version = i.zen?.version ?? i.version;
  $("browser").textContent = `${browserName} ${version}${geckoVersion ? ` · engine ${geckoVersion}` : ""}`;
}).catch(() => {});

renderLibrary();
renderSharedProfile();
checkAccess();

const wanted = /^#add=([a-p]{32})$/.exec(location.hash);
if (wanted) {
  history.replaceState(null, "", location.pathname);
  run("Converting…", fromStore(wanted[1]));
}
