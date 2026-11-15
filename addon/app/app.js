// Fox Sake page: gets a Chrome extension (store download, file or folder), converts it in a
// worker, shows what will and won't work, and installs it.
// Installing must start directly from a click on this page: Firefox cancels add-on installs
// that don't come from a user gesture, so the Install button navigates to the package itself.
import { downloadCrx, parseExtensionId } from "../lib/core/webstore.js";
import { safeFilePart } from "../lib/core/archive.js";
import { convertedAddons, checkUpdates } from "./library.js";

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
const MAX_REPORT_CHARS = 200_000;

let browserName = "Firefox";
let busy = false;
let current = null; // { meta, urls: [...] }

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
    await showResult(result);
  } catch (e) {
    setProgress(false);
    $("job-title").textContent = "Couldn't convert";
    setStatus(friendlyError(e), "error");
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

const fromStore = (chromeId) => async () => {
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

async function showResult({ xpi, meta, report, classified }) {
  setProgress(false);
  $("job-title").textContent = `${meta.name} ${meta.version}`;

  let installed = null;
  try { installed = await browser.management.get(meta.geckoId); } catch { /* not installed */ }
  setStatus(installed
    ? `Version ${installed.version} is installed. Installing replaces it and keeps its settings and data.`
    : "Converted. Nothing is installed until you click Install.");

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
  current = { meta, installUrl, urls: [installUrl, saveUrl, reportUrl] };
  Object.assign($("save-xpi"), { href: saveUrl, download: `${base}.xpi` });
  Object.assign($("save-report"), { href: reportUrl, download: `${base}.report.md` });
  $("install").textContent = installed ? `Update in ${browserName}` : `Install in ${browserName}`;
  $("install").disabled = false;
  $("report").textContent = report;
  $("job-result").hidden = false;

  const { reports = {} } = await browser.storage.local.get("reports");
  reports[meta.geckoId] = { meta, report: report.slice(0, MAX_REPORT_CHARS) };
  await browser.storage.local.set({ reports });
}

$("install").addEventListener("click", () => {
  if (!current) return;
  // Synchronous on purpose: the navigation has to happen inside the click.
  location.href = current.installUrl;
  const hint = $("install-hint");
  hint.className = "hint";
  hint.textContent = `${browserName} will ask you twice: click "Continue to Installation", then "Add". ` +
    `If it says the add-on "could not be verified", unsigned add-ons aren't allowed yet (see the note at the bottom).`;
  hint.hidden = false;
});

browser.management.onInstalled.addListener((info) => {
  if (current && info.id === current.meta.geckoId) {
    const hint = $("install-hint");
    hint.className = "hint ok";
    hint.textContent = `Installed ${info.name} ${info.version}.`;
    hint.hidden = false;
    $("install").disabled = true;
  }
  refreshLibrarySoon();
});
browser.management.onUninstalled.addListener(() => refreshLibrarySoon());
browser.management.onEnabled.addListener(() => refreshLibrarySoon());
browser.management.onDisabled.addListener(() => refreshLibrarySoon());

// onInstalled can fire before management.getAll() lists the new add-on, so refresh twice.
function refreshLibrarySoon() {
  renderLibrary();
  setTimeout(renderLibrary, 1000);
}

// --- inputs -----------------------------------------------------------------------------------

$("by-id").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const id = parseExtensionId($("source").value);
  if (!id) {
    startJob("Couldn't convert");
    setProgress(false);
    setStatus("That isn't a Chrome Web Store link or a 32-letter extension ID.", "error");
    return;
  }
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
      b.addEventListener("click", () => run(`Updating ${a.name}…`, fromStore(a.chromeId)));
      li.append(b);
    }
    ul.append(li);
  }
  $("updates-status").textContent = updates?.checkedAt
    ? `Last checked ${new Date(updates.checkedAt).toLocaleString()}.`
    : "";
}

$("check-updates").addEventListener("click", async () => {
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
  const version = i.zen?.version ?? i.version;
  $("browser").textContent = `${browserName} ${version}${geckoVersion ? ` · engine ${geckoVersion}` : ""}`;
}).catch(() => {});

renderLibrary();

const wanted = /^#add=([a-p]{32})$/.exec(location.hash);
if (wanted) {
  history.replaceState(null, "", location.pathname);
  run("Converting…", fromStore(wanted[1]));
}
