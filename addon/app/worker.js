// Runs the conversion off the page's main thread so big extensions don't freeze the page.
// Input: {bytes} (a CRX/ZIP) or {files: [[path, bytes], ...]} (a picked folder).
import { convert } from "../lib/core/convert.js";
import { writeZip } from "../lib/core/archive.js";

self.onmessage = async ({ data }) => {
  try {
    const bytes = data.files ? writeZip(new Map(data.files)) : data.bytes;
    const r = await convert(bytes, { chromeId: data.chromeId ?? undefined, targetVersion: data.targetVersion, source: data.source, knownIds: data.knownIds });
    self.postMessage({ ok: true, xpi: r.xpi, meta: r.meta, report: r.report, classified: r.classified }, [r.xpi.buffer]);
  } catch (e) {
    self.postMessage({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};
