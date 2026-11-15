#!/usr/bin/env node
// Developer tool: drives a `foxsake run` test window over WebDriver BiDi (Firefox's standard
// automation protocol). Holds one BiDi session, records every console message / JS error to
// out/logs/bidi-<time>.jsonl, and accepts commands on http://127.0.0.1:9333 :
//   curl -s localhost:9333 -H 'x-foxsake-driver: 1' -d '{"method":"browsingContext.getTree","params":{}}'
// Only listens on localhost.
import { createServer } from "node:http";
import { createWriteStream, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIDI_PORT = Number(process.env.BIDI_PORT || 9222);
const HTTP_PORT = Number(process.env.DRIVER_PORT || 9333);
mkdirSync(join(ROOT, "out", "logs"), { recursive: true });
const logPath = join(ROOT, "out", "logs", `bidi-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
const log = createWriteStream(logPath);

let ws;
for (let i = 0; i < 60; i++) {
  try {
    ws = new WebSocket(`ws://127.0.0.1:${BIDI_PORT}/session`);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    break;
  } catch { ws = null; await new Promise((r) => setTimeout(r, 1000)); }
}
if (!ws) { console.error("Couldn't connect to the test browser's BiDi port."); process.exit(1); }

let nextId = 1;
const waiting = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); return; }
  if (msg.type === "event") log.write(JSON.stringify({ t: Date.now(), ...msg }) + "\n");
};
ws.onclose = () => { console.log("BiDi connection closed."); process.exit(0); };
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

const s = await send("session.new", { capabilities: {} });
if (s.error) { console.error("session.new failed:", s.message); process.exit(1); }
await send("session.subscribe", { events: ["log.entryAdded", "browsingContext.load"] });

createServer((req, res) => {
  // Browsers attach Origin to cross-site requests and can't add custom headers without a CORS
  // preflight (which this server never approves), so web pages can't drive the test browser.
  if (req.headers.origin || req.headers["x-foxsake-driver"] !== "1" || req.method !== "POST") {
    res.statusCode = 403;
    return res.end();
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    try {
      const { method, params } = JSON.parse(body || "{}");
      const r = await send(method, params);
      res.end(JSON.stringify(r));
    } catch (err) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
}).listen(HTTP_PORT, "127.0.0.1", () => console.log(`driver ready on 127.0.0.1:${HTTP_PORT}; log: ${logPath}`));
