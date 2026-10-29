// Cold session ready, create only: POST /v1/sessions -> 201 (timed), then POST …/close, `runs` times in a row, with no
// workspace and no prompt (no model call). The same request as session-ready.js's cold create.
// args: { runs, label }
const json = { "content-type": "application/json" };
const projects = await (await fetch("/v1/projects")).json();
const projectId = (projects.items ?? projects)[0].id;
const runs = args.runs ?? 50;
const rows = [];
for (let i = 0; i < runs; i++) {
	const at = new Date().toISOString();
	const t0 = performance.now();
	const r = await fetch("/v1/sessions", {
		method: "POST",
		headers: json,
		body: JSON.stringify({ projectId, agentId: "assistant", title: "Cold create measurement", labels: { measurement: args.label ?? "create-cold" } }),
	});
	const create = performance.now() - t0;
	const s = await r.json();
	const t1 = performance.now();
	const c = await fetch(`/v1/sessions/${s.id}/close`, { method: "POST", headers: json, body: "{}" });
	rows.push({ at, status: r.status, create: Math.round(create), close: Math.round(performance.now() - t1), closeStatus: c.status });
}
const ok = rows.filter((x) => x.status === 201).map((x) => x.create);
const q = (xs, p) => {
	const s = [...xs].sort((x, y) => x - y);
	return s[Math.max(0, Math.ceil(p * s.length) - 1)] ?? null;
};
return {
	runs: rows,
	summary: {
		ok: ok.length,
		of: runs,
		createP50: q(ok, 0.5),
		createP95: q(ok, 0.95),
		min: Math.min(...ok),
		max: Math.max(...ok),
		closeP50: q(rows.map((x) => x.close), 0.5),
		statuses: [...new Set(rows.map((x) => `${x.status}/${x.closeStatus}`))],
	},
};
