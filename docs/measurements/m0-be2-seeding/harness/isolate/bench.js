// isomorphic-git status, diff and log over a LazyFs, as the isolate tier would run them.
import git from "isomorphic-git";
import { createTwoFilesPatch } from "diff";
import { LazyFs } from "./lazyfs.js";

const now = () => (globalThis.performance ? performance.now() : Date.now());

/**
 * @param {{ manifest: object, backend: object, cone: string[], statSkewMs?: number, edits?: number, memory?: () => number }} o
 */
export async function runBench(o) {
  const t = {};
  const mark = async (name, fn) => {
    const s = now();
    const r = await fn();
    t[name] = Math.round(now() - s);
    return r;
  };
  const fs = new LazyFs(o.manifest, o.backend, { statSkewMs: o.statSkewMs ?? 0 });
  const cache = {}; // isomorphic-git object cache, shared across calls like a long-lived isolate would
  const dir = "/";
  const out = { phases: t };

  const commits = await mark("log", () => git.log({ fs, dir, depth: 50, cache }));
  out.commits = commits.length;

  const m1 = await mark("status", () => git.statusMatrix({ fs, dir, filepaths: o.cone, cache }));
  out.status_rows = m1.length;
  out.status_dirty = m1.filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1)).length;
  out.reads_after_status = fs.stats.reads;
  out.bytes_after_status = fs.stats.bytes;

  // Edit a few files in the cone (append a line), as an agent would, then status and diff again.
  const files = m1.map((r) => r[0]).filter((f) => /\.(ts|js|md|json)$/.test(f)).slice(0, o.edits ?? 3);
  for (const f of files) {
    const body = await fs.readFile(f, "utf8");
    await fs.writeFile(f, `${body}\n// harbour m0-be2 edit\n`);
  }
  const m2 = await mark("status_after_edit", () => git.statusMatrix({ fs, dir, filepaths: o.cone, cache }));
  const changed = m2.filter(([, h, w]) => h !== w || w === 2).map((r) => r[0]);
  out.changed = changed.length;

  const head = await git.resolveRef({ fs, dir, ref: "HEAD" });
  const patches = await mark("diff", async () => {
    let lines = 0;
    for (const f of changed) {
      const { blob } = await git.readBlob({ fs, dir, oid: head, filepath: f, cache });
      const before = new TextDecoder().decode(blob);
      const after = await fs.readFile(f, "utf8");
      lines += createTwoFilesPatch(`a/${f}`, `b/${f}`, before, after).split("\n").length;
    }
    return lines;
  });
  out.patch_lines = patches;
  out.reads = fs.stats.reads;
  out.bytes = fs.stats.bytes;
  if (o.memory) out.mem_mb = Math.round(o.memory() / 1048576);
  return out;
}
