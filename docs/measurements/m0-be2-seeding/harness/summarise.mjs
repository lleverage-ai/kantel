// Summarise raw JSON lines into p50/p95 tables (Markdown).
//   node summarise.mjs ../raw/*.jsonl > ../results.md
// For each target × method × repo × stat mode: n, then p50/p95 of
//   ready  = time until the seeded tree answers `git status` (or deps are extracted), excluding container start
//   total  = container start + seeding: on Cloudflare the DO's start + exec time; self-hosted the host's
//            `docker run --rm` wall time, which also includes removing the container (seconds for n8n's 2.5 GB)
// Rows run with stat=default (git's normal stat checks) are marked; every other row used stat=minimal.
// and p50 of each phase reported by seed-op.
import { readFileSync } from "node:fs";

const rows = process.argv
  .slice(2)
  .flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
  .filter((r) => r.ok !== false);

const q = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  // nearest-rank
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const fmt = (ms) => (ms == null ? "–" : ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

const groups = new Map();
for (const r of rows) {
  const op = r.op ?? r; // Cloudflare lines nest seed-op output under op
  const key = [r.target, r.repo, r.method, r.stat ?? "minimal"].join("|");
  if (!groups.has(key)) groups.set(key, []);
  const ready = r.op ? (r.op_wall_ms ?? 0) : op.op_ms; // CF: DO-measured exec wall (+restore); self-hosted: in-container op
  const total = r.op ? r.total_ms : r.total_ms;
  groups.get(key).push({ ready, total, start: r.start_ready_ms, phases: op.phases ?? {}, restore: r.restore_ms });
}

const order = ["sal", "vite", "n8n"];
const out = ["| Target | Repo | Method | n | Ready p50 | Ready p95 | Start+ready p50 | Start+ready p95 | Phases (p50) |", "|---|---|---|---:|---:|---:|---:|---:|---|"];
const keys = [...groups.keys()].sort((a, b) => {
  const [ta, ra, ma] = a.split("|");
  const [tb, rb, mb] = b.split("|");
  return ta.localeCompare(tb) || order.indexOf(ra) - order.indexOf(rb) || ma.localeCompare(mb);
});
for (const k of keys) {
  const [target, repo, method, stat] = k.split("|");
  const g = groups.get(k);
  const phaseNames = [...new Set(g.flatMap((x) => Object.keys(x.phases)))];
  const phases = phaseNames.map((p) => `${p} ${fmt(q(g.map((x) => x.phases[p]).filter((v) => v != null), 50))}`);
  if (g.some((x) => x.restore != null)) phases.unshift(`restore ${fmt(q(g.map((x) => x.restore), 50))}`);
  if (g.some((x) => x.start != null)) phases.unshift(`start ${fmt(q(g.map((x) => x.start), 50))}`);
  out.push(
    `| ${target} | ${repo} | ${method}${stat === "default" ? " (stat=default)" : ""} | ${g.length} | ${fmt(q(g.map((x) => x.ready), 50))} | ${fmt(q(g.map((x) => x.ready), 95))} | ${fmt(q(g.map((x) => x.total), 50))} | ${fmt(q(g.map((x) => x.total), 95))} | ${phases.join(", ")} |`,
  );
}
console.log(out.join("\n"));
