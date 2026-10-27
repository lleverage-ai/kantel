// Turn a sparse, blobless, shallow checkout into a lazy workspace: manifest.json + data.bin,
// plus one object per file under f/<id> (the layout the deployed Worker reads).
//   node pack.mjs <checkout dir> <out dir>
// The checkout comes from: git clone --depth 50 --filter=blob:none --sparse <mirror>; sparse-checkout set <cone>.
//
// isomorphic-git 1.44 reads only index version 2, and git writes version 3 for a sparse checkout
// (skip-worktree is an extended flag). So the workspace carries its own v2 index: the full tree,
// with stat data refreshed for the files that are present.
import { execFileSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

const [src, out] = process.argv.slice(2).map((p) => resolve(p));
mkdirSync(out, { recursive: true });

const gitEnv = { ...process.env, GIT_INDEX_FILE: join(src, ".git/index.v2") };
const g = (...args) =>
	execFileSync("git", ["-C", src, "-c", "core.sparseCheckout=false", ...args], {
		env: gitEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});
if (!existsSync(join(src, ".git/index.v3"))) {
	g("read-tree", "HEAD");
	g("update-index", "--index-version", "2");
	try {
		g("update-index", "-q", "--refresh", "--ignore-missing");
	} catch {
		/* non-cone files are missing: expected */
	}
	renameSync(join(src, ".git/index"), join(src, ".git/index.v3"));
	renameSync(join(src, ".git/index.v2"), join(src, ".git/index"));
}

const entries = {};
const fd = openSync(join(out, "data.bin"), "w");
let off = 0;
let nextId = 0;
mkdirSync(join(out, "f"), { recursive: true });
const walk = (rel) => {
	for (const name of readdirSync(join(src, rel))) {
		const p = rel ? `${rel}/${name}` : name;
		if (p === ".git/index.v3") continue;
		const st = lstatSync(join(src, p), { bigint: false });
		const base = {
			size: st.size,
			mode: st.mode,
			mtimeMs: st.mtimeMs,
			ctimeMs: st.ctimeMs,
			ino: st.ino,
			uid: st.uid,
			gid: st.gid,
			dev: st.dev,
		};
		if (st.isDirectory()) {
			entries[p] = { t: "d", ...base };
			walk(p);
		} else if (st.isSymbolicLink()) entries[p] = { t: "l", ...base, target: readlinkSync(join(src, p)) };
		else {
			const buf = readFileSync(join(src, p));
			writeSync(fd, buf);
			const id = nextId++;
			writeFileSync(join(out, "f", String(id)), buf);
			entries[p] = { t: "f", ...base, off, id };
			off += buf.length;
		}
	}
};
walk("");
closeSync(fd);
writeFileSync(join(out, "manifest.json"), JSON.stringify({ entries }));
console.log(JSON.stringify({ src, files: Object.keys(entries).length, dataBytes: off }));
