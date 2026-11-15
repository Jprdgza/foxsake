// Turns scan findings + conversion results into a plain-English Markdown report.

const STATUS_LABEL = {
  shimmed: "✅ Patched by a shim",
  rewritten: "🔧 Rewritten in the code",
  experiment: "🧪 Experiment (needs testing)",
  unsupported: "⛔ Can't work in Firefox",
  info: "ℹ️ FYI",
};

const TITLES = {
  offscreen: "chrome.offscreen", sidePanel: "chrome.sidePanel", getAuthToken: "chrome.identity.getAuthToken",
  getProfileUserInfo: "chrome.identity.getProfileUserInfo", externalMessaging: "onMessageExternal / onConnectExternal",
  chromeExtensionUrl: "Hardcoded chrome-extension:// URLs", userAgent: "User-agent checks", tts: "chrome.tts",
  declarativeContent: "chrome.declarativeContent", importScripts: "importScripts()", docsCanvas: "Google Docs canvas access",
  serviceWorkerGlobals: "Service-worker globals", getContexts: "chrome.runtime.getContexts", manifestUpdateUrl: "Reads manifest update_url",
  chromeInternalUrls: "chrome:// page links", hardcodedId: "Hardcoded Chrome extension ID",
};

/** Decides, for each finding, whether it was fixed, can't be fixed, or is just informational. */
export function classifyFindings(findings, shimResult, background) {
  const applied = new Set(shimResult.applied.map((a) => a.id));
  const out = [];
  for (const f of findings.values()) {
    let status = "info";
    let note = "";
    switch (f.id) {
      case "offscreen": status = applied.has("offscreen") ? "shimmed" : "unsupported"; break;
      case "sidePanel": status = applied.has("sidePanel") ? "shimmed" : "unsupported"; note = "Opens in Zen's sidebar instead of Chrome's side panel."; break;
      case "getAuthToken": status = "unsupported"; note = "Any feature that signs in through the Chrome browser's Google account won't work. Website-based login (in a tab) is unaffected."; break;
      case "getProfileUserInfo": status = "shimmed"; break;
      case "externalMessaging": status = applied.has("external") ? "shimmed" : "info"; if (!applied.has("external")) note = "No websites are allowed to message this extension, so only extension-to-extension messaging is involved; Firefox supports that natively."; break;
      case "chromeExtensionUrl": status = "rewritten"; break;
      case "userAgent": status = "info"; note = "Not patched. If the extension shows 'Chrome only' messages or misbehaves, this is a suspect."; break;
      case "tts": case "declarativeContent": case "hardcodedId": status = applied.has(f.id === "hardcodedId" ? "id-remap" : f.id) ? "shimmed" : "unsupported"; break;
      case "importScripts":
        if (background?.dynamicImports?.length) { status = "unsupported"; note = `Dynamic or remote importScripts can't be resolved ahead of time: ${background.dynamicImports.join("; ")}`; }
        else if (background?.importedScripts?.length) { status = "rewritten"; note = "Static imports were added to the background script list."; }
        else { status = "info"; note = "Only appears outside the background service worker (usually bundler helper code); nothing to do."; }
        break;
      case "docsCanvas": status = applied.has("docs-canvas") ? "experiment" : "info"; break;
      case "serviceWorkerGlobals": status = applied.has("sw-globals") ? "shimmed" : "info"; break;
      case "getContexts": status = applied.has("offscreen") ? "shimmed" : "info"; if (!applied.has("offscreen")) note = "Firefox supports getContexts, but not every Chrome context type."; break;
      case "manifestUpdateUrl": status = applied.has("manifest-extras") ? "shimmed" : "info"; break;
      case "chromeInternalUrls": status = "info"; break;
      default:
        if (f.id.startsWith("api:")) { status = "unsupported"; note = "No Firefox equivalent; code paths that call this will fail."; }
    }
    out.push({ ...f, files: [...f.files], title: TITLES[f.id] ?? `chrome.${f.api ?? f.id}`, status, note });
  }
  const order = ["unsupported", "experiment", "shimmed", "rewritten", "info"];
  return out.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.count - a.count);
}

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const short = (v) => (v === undefined ? "" : esc(JSON.stringify(v)).slice(0, 160));

export function renderFindings(classified) {
  if (!classified.length) return "No Chrome-only code found. 🎉\n";
  let md = "| Status | What | Times seen | Explanation |\n|---|---|---|---|\n";
  for (const f of classified) {
    md += `| ${STATUS_LABEL[f.status]} | ${esc(f.title)} | ${f.count} in ${f.files.length} file(s) | ${esc(f.what)}${f.note ? " " + esc(f.note) : ""} |\n`;
  }
  md += "\n<details><summary>Where each one was found (first examples)</summary>\n\n";
  for (const f of classified) {
    md += `**${esc(f.title)}**\n\n`;
    for (const ex of f.examples) md += `- \`${ex.file}:${ex.line}\`: \`${ex.snippet.replace(/`/g, "'").slice(0, 140)}\`\n`;
    md += "\n";
  }
  md += "</details>\n\n*Minified code often bundles helper libraries that mention APIs they never call, so 'seen' doesn't always mean 'used'.*\n";
  return md;
}

export function renderReport(r) {
  const { meta } = r;
  const unsupported = r.classified.filter((f) => f.status === "unsupported");
  const experiments = r.classified.filter((f) => f.status === "experiment");
  let md = `# ${meta.name} ${meta.version}: Fox Sake conversion report\n\n`;
  md += `| | |\n|---|---|\n`;
  md += `| Source | ${esc(meta.source ?? "local file")} (${meta.format.toUpperCase()}) |\n`;
  md += `| Chrome ID | \`${meta.chromeId ?? "unknown"}\` |\n| Firefox ID | \`${meta.geckoId}\` |\n`;
  md += `| Manifest version | ${r.original.manifest_version} |\n`;
  md += `| Compat data | @mdn/browser-compat-data ${r.support.bcdVersion}, checked against Firefox ${r.support.target} |\n`;
  md += `| Converted | ${meta.convertedAt} by Fox Sake ${meta.foxsakeVersion} |\n\n`;

  md += `## Summary\n\n`;
  md += `- **${r.applied.length} shim(s) injected**${r.applied.length ? ": " + r.applied.map((a) => a.id).join(", ") : ""}.\n`;
  md += `- **${r.changes.length} manifest change(s)** (listed below).\n`;
  if (unsupported.length) md += `- **Won't work in Firefox:** ${unsupported.map((f) => f.title).join("; ")}.\n`;
  else md += `- Nothing found that Firefox can't do.\n`;
  if (experiments.length) md += `- **Experimental:** ${experiments.map((f) => f.title).join("; ")}.\n`;
  if (r.warnings.length) md += `- **${r.warnings.length} warning(s)**, see below.\n`;
  md += "\n";

  md += `## Compatibility findings\n\n${renderFindings(r.classified)}\n`;

  md += `## Shims injected\n\n`;
  if (!r.applied.length) md += "None needed.\n\n";
  for (const a of r.applied) md += `- **${a.id}**: ${a.why} *Why: ${a.trigger}. Loaded in: ${a.where.join(", ")}.*\n`;
  if (r.notes.length) md += "\n" + r.notes.map((n) => `- Note: ${n}`).join("\n") + "\n";
  md += "\n";

  md += `## Manifest changes\n\n| Key | Change | Before | After | Why |\n|---|---|---|---|---|\n`;
  for (const c of r.changes) md += `| \`${esc(c.path)}\` | ${c.action} | ${short(c.before)} | ${short(c.after)} | ${esc(c.reason)} |\n`;
  md += `\n<details><summary>Full manifest: before and after</summary>\n\n**Before (Chrome):**\n\n\`\`\`json\n${JSON.stringify(r.original, null, 2)}\n\`\`\`\n\n**After (Firefox):**\n\n\`\`\`json\n${JSON.stringify(r.manifest, null, 2)}\n\`\`\`\n</details>\n\n`;

  if (r.urlRewrites.length || r.removedFiles.length) {
    md += `## File changes\n\n`;
    for (const u of r.urlRewrites) {
      md += u.kind === "global"
        ? `- \`${u.file}\`: ${u.count}× \`Function("return this")()\` → \`globalThis\` (Firefox blocks that eval trick in extensions; in content scripts it crashed the script)\n`
        : `- \`${u.file}\`: ${u.count} chrome-extension:// URL(s) rewritten for Firefox\n`;
    }
    if (r.removedFiles.length) md += `- Removed Chrome Web Store metadata: ${r.removedFiles.map((f) => `\`${f}\``).join(", ")}\n`;
    md += "\n";
  }
  if (r.warnings.length) md += `## Warnings\n\n${r.warnings.map((w) => `- ${w}`).join("\n")}\n\n`;
  return md;
}
