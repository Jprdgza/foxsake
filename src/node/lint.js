// Runs Mozilla's `web-ext lint` on a converted package and summarizes the result.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, closeSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readZip } from "../core/archive.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEB_EXT = join(ROOT, "node_modules", ".bin", "web-ext");
const LINT_TIMEOUT_MS = Number(process.env.FOXSAKE_LINT_TIMEOUT_MS || 180_000);

/** Extracts the xpi (paths already sanitized by readZip) to a temp dir and lints it. */
export async function lintXpi(xpiBytes) {
  const dir = mkdtempSync(join(tmpdir(), "foxsake-lint-"));
  try {
    for (const [p, data] of readZip(xpiBytes)) {
      const full = join(dir, p);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, data);
    }
    // web-ext exits before a pipe drains (output cut at 64 KB), so write straight to a file.
    const outFile = join(dir, "..", `${dir.split("/").pop()}.json`);
    const fd = openSync(outFile, "w");
    const timedOut = await new Promise((resolve) => {
      const child = spawn(WEB_EXT, ["lint", "--source-dir", dir, "--output", "json", "--self-hosted", "--no-input"], { stdio: ["ignore", fd, "ignore"] });
      // Huge minified bundles can make the linter crawl; never let it hang a conversion.
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(true); }, LINT_TIMEOUT_MS);
      child.on("exit", () => { clearTimeout(timer); resolve(false); });
      child.on("error", () => { clearTimeout(timer); resolve(false); });
    });
    closeSync(fd);
    if (timedOut) throw new Error(`web-ext lint took longer than ${LINT_TIMEOUT_MS / 60000} minutes and was stopped`);
    const stdout = readFileSync(outFile, "utf8");
    rmSync(outFile, { force: true });
    const json = JSON.parse(stdout.slice(stdout.indexOf("{")));
    return { errors: json.errors ?? [], warnings: json.warnings ?? [], notices: json.notices ?? [], summary: json.summary };
  } catch (e) {
    return { failed: String(e.message || e), errors: [], warnings: [], notices: [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Lint codes that only matter for publishing on addons.mozilla.org, not for a personal install.
const AMO_ONLY = {
  FILE_TOO_LARGE: "the linter skips files this big; Zen loads them fine",
  MISSING_DATA_COLLECTION_PERMISSIONS: "an addons.mozilla.org listing requirement",
  UNSAFE_VAR_ASSIGNMENT: "a code-review flag for reviewers",
  DANGEROUS_EVAL: "a code-review flag; the extension's security policy already governs eval",
  ANDROID_INCOMPATIBLE_API: "only relevant to Firefox for Android",
};

export function renderLint(lint) {
  if (lint.failed) return `## web-ext lint\n\nLint could not run: ${lint.failed}\n`;
  const group = (list) => {
    const by = new Map();
    for (const m of list) {
      const g = by.get(m.code) ?? { code: m.code, message: m.message, count: 0, files: new Set() };
      g.count++;
      if (m.file) g.files.add(m.file);
      by.set(m.code, g);
    }
    return [...by.values()].sort((a, b) => b.count - a.count);
  };
  let md = `## web-ext lint\n\n**${lint.errors.length} error(s), ${lint.warnings.length} warning(s), ${lint.notices.length} notice(s).**`;
  md += " Most warnings on third-party extensions are code-style flags (e.g. use of innerHTML) and don't stop it from working. Errors matter more.\n\n";
  for (const [label, list] of [["Errors", lint.errors], ["Warnings", lint.warnings]]) {
    const g = group(list);
    if (!g.length) continue;
    md += `**${label}:**\n\n`;
    for (const x of g.slice(0, 15)) md += `- \`${x.code}\` ×${x.count}: ${String(x.message).replace(/\n/g, " ")}${x.files.size ? ` (e.g. ${[...x.files].slice(0, 2).join(", ")})` : ""}${AMO_ONLY[x.code] ? ` *(Harmless here: ${AMO_ONLY[x.code]}.)*` : ""}\n`;
    md += "\n";
  }
  return md;
}
