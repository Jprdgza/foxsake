#!/usr/bin/env node
// Tiny client for scripts/zen-driver.js (developer testing only).
//   node scripts/drv.js tabs                 list open tabs
//   node scripts/drv.js nav <url> [tab#]     open a URL (waits for load)
//   node scripts/drv.js eval '<js>' [tab#]   run JS in the page (awaits promises)
//   node scripts/drv.js shot <file.png> [tab#]
//   node scripts/drv.js errors [N]           last N warnings/errors from the console log
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const call = async (method, params = {}) => {
  const r = await fetch("http://127.0.0.1:9333", { method: "POST", headers: { "x-foxsake-driver": "1" }, body: JSON.stringify({ method, params }) });
  const j = await r.json();
  if (j.type === "error") throw new Error(`${j.error}: ${j.message}`);
  return j.result;
};
const tabs = async () => (await call("browsingContext.getTree", { maxDepth: 0 })).contexts;
const ctx = async (n = 0) => (await tabs())[Number(n)].context;

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "tabs") (await tabs()).forEach((t, i) => console.log(i, t.url));
else if (cmd === "nav") console.log((await call("browsingContext.navigate", { context: await ctx(b), url: a, wait: "complete" })).url);
else if (cmd === "eval") {
  const r = await call("script.evaluate", { expression: a, target: { context: await ctx(b) }, awaitPromise: true, resultOwnership: "none" });
  console.log(r.type === "exception" ? `EXCEPTION: ${r.exceptionDetails.text}` : JSON.stringify(r.result.value ?? r.result));
} else if (cmd === "shot") {
  const r = await call("browsingContext.captureScreenshot", { context: await ctx(b) });
  writeFileSync(a, Buffer.from(r.data, "base64"));
  console.log(a);
} else if (cmd === "errors") {
  const dir = join(ROOT, "out", "logs");
  const f = readdirSync(dir).filter((x) => x.startsWith("bidi-")).sort().at(-1);
  const entries = readFileSync(join(dir, f), "utf8").trim().split("\n").map(JSON.parse)
    .filter((m) => m.method === "log.entryAdded" && ["warn", "error"].includes(m.params.level))
    .filter((m) => !/challenges\.cloudflare|turnstile/.test(JSON.stringify(m.params.stackTrace ?? "")));
  for (const m of entries.slice(-(Number(a) || 20))) {
    const fr = m.params.stackTrace?.callFrames?.[0];
    console.log(m.params.level, (m.params.text ?? "").slice(0, 300).replace(/\n/g, " "), fr ? `@ ${fr.url.slice(-70)}:${fr.lineNumber}` : "");
  }
} else console.log("usage: tabs | nav <url> [tab] | eval <js> [tab] | shot <file> [tab] | errors [N]");

// Real user input (trusted events): click the first element matching a CSS selector, then type.
if (cmd === "type") {
  const [sel, text, tab] = [a, b, process.argv[5]];
  const context = await ctx(tab);
  const r = await call("script.evaluate", { expression: `(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({block:"center"}); const b = e.getBoundingClientRect(); return JSON.stringify([Math.round(b.x + 20), Math.round(b.y + 15)]); })()`, target: { context }, awaitPromise: false });
  const [x, y] = JSON.parse(r.result.value);
  const keys = [...text].flatMap((ch) => [{ type: "keyDown", value: ch }, { type: "keyUp", value: ch }]);
  await call("input.performActions", { context, actions: [
    { type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", x, y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] },
  ] });
  await call("input.performActions", { context, actions: [{ type: "key", id: "kbd", actions: keys }] });
  console.log(`clicked ${sel} at ${x},${y} and typed ${text.length} chars`);
}
