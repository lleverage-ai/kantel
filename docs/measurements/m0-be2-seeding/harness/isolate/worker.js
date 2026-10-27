// harbour-m0-seed-isogit: isomorphic-git status, diff and log in a Worker isolate (128 MB cap)
// over a lazy workspace: the manifest is listed once, and each file body is fetched on demand
// as its own object. The objects are the Worker's static assets (iso/<repo>/f/<id>), standing in
// for an object-store-backed workspace (see the README for why not R2).
//   GET /bench?repo=n8n&cone=packages/cli,packages/core&skew=0
import { runBench } from "./bench.js";

export default {
	async fetch(req, env) {
		if (req.headers.get("authorization") !== `Bearer ${env.BENCH_TOKEN}`) return new Response("no", { status: 401 });
		const url = new URL(req.url);
		const repo = url.searchParams.get("repo");
		const cone = (url.searchParams.get("cone") ?? "").split(",").filter(Boolean);
		const skew = Number(url.searchParams.get("skew") ?? 0);
		const asset = (p) => env.ASSETS.fetch(new Request(`https://assets.local/iso/${repo}/${p}`));
		const t0 = performance.now();
		const m = await asset("manifest.json");
		if (!m.ok) return new Response("no manifest", { status: 404 });
		const manifest = await m.json();
		const listMs = Math.round(performance.now() - t0);
		let gets = 0;
		const backend = {
			async read(_off, _len, _path, entry) {
				gets++;
				const r = await asset(`f/${entry.id}`);
				if (!r.ok) throw new Error(`asset ${entry.id} ${r.status}`);
				return new Uint8Array(await r.arrayBuffer());
			},
		};
		try {
			const r = await runBench({ manifest, backend, cone, statSkewMs: skew });
			r.phases = { list: listMs, ...r.phases };
			return Response.json({ ok: true, target: "cloudflare-worker", repo, skew, object_gets: gets, ...r });
		} catch (e) {
			return Response.json({ ok: false, repo, skew, error: String(e?.stack ?? e) }, { status: 500 });
		}
	},
};
