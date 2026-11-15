#!/usr/bin/env node
// Fox Sake native-messaging helper. Zen starts this when the "Add to Zen" button is clicked.
// Protocol: 4-byte little-endian length + JSON, on stdin/stdout (Firefox native messaging).
// Accepts exactly one request shape: {action: "add", id: <32 a–p letters>}. No paths, no commands.
import { doConvert, assertInstallable, output } from "./pipeline.js";
import { openInZen } from "./zen.js";

const log = [];
output.say = (...a) => log.push(a.join(" ")); // stdout is reserved for the protocol

function readMessage() {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    process.stdin.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (len > 64 * 1024) return reject(new Error("message too large"));
        if (buf.length >= 4 + len) resolve(JSON.parse(buf.subarray(4, 4 + len).toString("utf8")));
      }
    });
    process.stdin.on("end", () => reject(new Error("no message")));
  });
}

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

try {
  const msg = await readMessage();
  if (!msg || msg.action !== "add" || !/^[a-p]{32}$/.test(String(msg.id))) throw new Error("Invalid request.");
  const { xpiPath, meta } = await doConvert(msg.id, {});
  assertInstallable(meta);
  // Open Zen's install prompt first: Firefox may end this helper as soon as it replies.
  openInZen(xpiPath);
  send({ ok: true, name: meta.name, version: meta.version, shims: meta.shims, unsupported: meta.unsupported, log });
  process.stdout.end(() => process.exit(0));
} catch (e) {
  send({ ok: false, error: String(e && e.message ? e.message : e), log });
  process.exit(0);
}
