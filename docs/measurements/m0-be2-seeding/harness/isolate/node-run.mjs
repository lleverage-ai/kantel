// Run the isolate-tier git bench in Node against a packed lazy workspace on local disk,
// sampling peak memory (heap + external + array buffers) as a proxy for the 128 MB isolate cap.
//   node --max-old-space-size=128 node-run.mjs <packed dir> <cone...>
import { openSync, readSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runBench } from "./bench.js";

const [dir, ...cone] = process.argv.slice(2);
const skew = Number(process.env.STAT_SKEW_MS ?? 0);
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const fd = openSync(join(dir, "data.bin"), "r");
const backend = {
  async read(off, len) {
    const b = new Uint8Array(len);
    readSync(fd, b, 0, len, off);
    return b;
  },
};
let peak = 0;
const sample = () => {
  const m = process.memoryUsage();
  peak = Math.max(peak, m.heapUsed + m.external + m.arrayBuffers);
};
const timer = setInterval(sample, 5);
const r = await runBench({ manifest, backend, cone, statSkewMs: skew, memory: () => (sample(), peak) });
clearInterval(timer);
console.log(JSON.stringify({ target: "node", skew, ...r, rss_mb: Math.round(process.memoryUsage().rss / 1048576) }));
