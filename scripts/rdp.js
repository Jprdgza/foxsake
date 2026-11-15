#!/usr/bin/env node
// Developer tool: talks to a `foxsake run` test window over Firefox's Remote Debugging
// Protocol (what about:debugging → Inspect uses) to inspect an add-on's background page.
//   node scripts/rdp.js eval <addon-id-substring> '<js>'   evaluate in the background page
//   node scripts/rdp.js errors <addon-id-substring> [secs]  background console messages/errors
// The debugger port is discovered from the running test Zen process (web-ext starts it).
import { connect } from "node:net";
import { execFileSync } from "node:child_process";

function findPort() {
  const ps = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" });
  const m = /zen -start-debugger-server (\d+).*out\/dev-profile/.exec(ps) || /zen -start-debugger-server (\d+)/.exec(ps);
  if (!m) throw new Error("No test window running (start one with foxsake run).");
  return Number(m[1]);
}

class Rdp {
  constructor(port) {
    this.sock = connect(port, "127.0.0.1");
    this.buf = Buffer.alloc(0);
    this.listeners = [];
    this.sock.on("data", (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
  }
  drain() {
    for (;;) {
      const colon = this.buf.indexOf(":");
      if (colon < 0) return;
      const len = Number(this.buf.subarray(0, colon).toString());
      if (this.buf.length < colon + 1 + len) return;
      const pkt = JSON.parse(this.buf.subarray(colon + 1, colon + 1 + len).toString());
      this.buf = this.buf.subarray(colon + 1 + len);
      for (const l of [...this.listeners]) l(pkt);
    }
  }
  send(pkt) {
    const s = Buffer.from(JSON.stringify(pkt));
    this.sock.write(`${s.length}:`);
    this.sock.write(s);
  }
  next(pred, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.listeners = this.listeners.filter((x) => x !== l); reject(new Error("RDP timeout")); }, timeout);
      const l = (p) => { if (pred(p)) { clearTimeout(t); this.listeners = this.listeners.filter((x) => x !== l); resolve(p); } };
      this.listeners.push(l);
    });
  }
  async request(to, type, extra = {}) {
    const p = this.next((x) => x.from === to);
    this.send({ to, type, ...extra });
    return p;
  }
}

const fmt = (g) => {
  if (g === null || typeof g !== "object") return JSON.stringify(g);
  if (g.type === "undefined") return "undefined";
  if (g.type === "longString") return JSON.stringify(g.initial) + "…";
  if (g.preview?.ownProperties) return JSON.stringify(Object.fromEntries(Object.entries(g.preview.ownProperties).map(([k, v]) => [k, v.value?.type ? `<${v.value.class ?? v.value.type}>` : v.value])));
  return `<${g.class ?? g.type}>`;
};

const [cmd, idPart, arg] = process.argv.slice(2);
const rdp = new Rdp(findPort());
await rdp.next((p) => p.applicationType);
let addon;
if (cmd === "tab") {
  // `tab <url-substring> [secs]`: console + errors of a web page tab (includes content-script errors).
  const { tabs } = await rdp.request("root", "listTabs");
  addon = tabs.find((t) => (t.url ?? "").includes(idPart ?? ""));
  if (!addon) { console.error("Tab not found:", tabs.map((t) => t.url).join(", ")); process.exit(1); }
} else {
  const { addons } = await rdp.request("root", "listAddons");
  addon = addons.find((a) => a.id.includes(idPart ?? ""));
  if (!addon) { console.error("Add-on not found. Loaded:", addons.map((a) => a.id).join(", ")); process.exit(1); }
}
// Wake a suspended event page (Firefox stops idle backgrounds) so it can be inspected.
const wakeBackground = async () => { try { await rdp.request(addon.actor, "reload", {}); } catch {} };
if (cmd !== "tab" && process.env.RDP_WAKE) await wakeBackground();
// Modern protocol: descriptor → watcher → targets (one per extension document) + resources.
const { actor: watcher } = await rdp.request(addon.actor, "getWatcher", { isServerTargetSwitchingEnabled: true });
const targets = [];
rdp.listeners.push((p) => { if (p.type === "target-available-form") targets.push(p.target); });
await rdp.request(watcher, "watchTargets", { targetType: "frame" });
const isBg = (t) => /_generated_background_page|\/background/.test(t.url);
for (let i = 0; i < 50 && !(cmd === "tab" ? targets.length : targets.some(isBg)); i++) await new Promise((r) => setTimeout(r, 100));
const bg = targets.find(isBg) ?? targets.find((t) => !/webextension-fallback/.test(t.url)) ?? targets[0];
if (process.env.RDP_DEBUG) console.log(targets.map((t) => t.url));

const show = (e) => {
  const text = e.errorMessage ?? (e.arguments ?? []).map(fmt).join(" ");
  const where = e.sourceName ?? e.filename ?? "";
  console.log(`[${e.level ?? (e.error ? "error" : e.warning ? "warn" : "log")}] ${String(typeof text === "object" ? fmt(text) : text).slice(0, 400)} ${where ? "@ " + String(where).split("/").slice(3).join("/") + ":" + (e.lineNumber ?? "") : ""}`);
  for (const f of (e.stacktrace ?? []).slice(0, 5)) console.log(`      at ${f.functionName || "?"} ${String(f.filename).split("/").slice(3).join("/")}:${f.lineNumber}:${f.columnNumber}`);
};

const evaluate = async (text) => {
  const ack = await rdp.request(bg.consoleActor, "evaluateJSAsync", { text, eager: false });
  return rdp.next((p) => p.type === "evaluationResult" && p.resultID === ack.resultID, 60000);
};

if (cmd === "eval") {
  // Code containing `await` is wrapped in an async function (use `return` for the result);
  // the result is parked on a global and collected with a second evaluation.
  if (arg.includes("await")) {
    await evaluate(`globalThis.__rdp = undefined; (async () => { ${arg} })().then(v => { globalThis.__rdp = { v: typeof v === "string" ? v : JSON.stringify(v) }; }, e => { globalThis.__rdp = { v: "EXCEPTION: " + e }; });`);
    for (let i = 0; i < 120; i++) {
      const r = await evaluate("globalThis.__rdp ? String(globalThis.__rdp.v) : '__pending__'");
      const v = r.result?.type === "longString" ? r.result.initial : r.result;
      if (v !== "__pending__") { console.log(v); break; }
      await new Promise((res) => setTimeout(res, 250));
    }
  } else {
    const res = await evaluate(arg);
    if (res.exceptionMessage) console.log("EXCEPTION:", res.exceptionMessage);
    else console.log(fmt(res.result));
  }
} else if (cmd === "errors" || cmd === "tab") {
  // Cached + live console/error messages from every document of the add-on (background, popups, iframes).
  rdp.listeners.push((p) => {
    if (p.type !== "resources-available-array") return;
    for (const [, list] of p.array) for (const r of list) show(r.pageError ?? r.message ?? r);
  });
  await rdp.request(watcher, "watchResources", { resourceTypes: ["console-message", "error-message"] });
  await new Promise((r) => setTimeout(r, (Number(arg) || 1) * 1000));
} else if (cmd === "targets") {
  targets.forEach((t) => console.log(t.url));
} else console.log("usage: eval <addon> '<js>' | errors <addon> [secs] | targets <addon>");
process.exit(0);
