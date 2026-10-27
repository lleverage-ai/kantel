// N requests per repo against the deployed isolate bench, C at a time; raw JSON lines out.
//   BENCH_URL=... BENCH_TOKEN_FILE=... node drive.mjs <out.jsonl> [n] [concurrency]
import { appendFileSync, readFileSync } from "node:fs";

const [out, n = "50", conc = "4"] = process.argv.slice(2);
const url = process.env.BENCH_URL;
const token = readFileSync(process.env.BENCH_TOKEN_FILE, "utf8").trim();
const cones = { vite: "packages/vite", n8n: "packages/cli,packages/core,packages/workflow" };
const jobs = Object.keys(cones).flatMap((repo) => Array.from({ length: Number(n) }, (_, i) => ({ repo, i: i + 1 })));
let next = 0;
const worker = async () => {
  while (next < jobs.length) {
    const { repo, i } = jobs[next++];
    const t0 = Date.now();
    let r;
    try {
      const res = await fetch(`${url}/bench?repo=${repo}&cone=${cones[repo]}&run=${i}-${t0}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120000) });
      const text = await res.text();
      try {
        r = JSON.parse(text);
      } catch {
        // Cloudflare error page, e.g. "Worker exceeded resource limits" (1102)
        r = { ok: false, http: res.status, error: (text.match(/<title>([^<]*)/)?.[1] ?? text.slice(0, 200)).trim() };
      }
    } catch (e) {
      r = { ok: false, error: String(e) };
    }
    appendFileSync(out, `${JSON.stringify({ target: "cloudflare-worker-isolate", method: "isogit-lazy", repo, iteration: i, client_ms: Date.now() - t0, ...r })}\n`);
  }
};
await Promise.all(Array.from({ length: Number(conc) }, worker));
