// A/B: POST /v1/sessions -> 201, then close, alternating a session without a workspace (A) and one on a workspace (B),
// which since #202 gets the coding tools and an execution environment. args: { runs, workspaceId }
const json = { "content-type": "application/json" };
const projects = await (await fetch("/v1/projects")).json();
const projectId = (projects.items ?? projects)[0].id;
const runs = args.runs ?? 15;
const one = async (workspaceId) => {
	const t0 = performance.now();
	const r = await fetch("/v1/sessions", {
		method: "POST",
		headers: json,
		body: JSON.stringify({
			projectId,
			agentId: "assistant",
			title: "Create A/B measurement",
			labels: { measurement: "create-ab" },
			...(workspaceId === undefined ? {} : { workspaceId }),
		}),
	});
	const t1 = performance.now();
	const s = await r.json();
	const t2 = performance.now();
	const c = await fetch(`/v1/sessions/${s.id}/close`, { method: "POST", headers: json, body: "{}" });
	const t3 = performance.now();
	return { status: r.status, create: Math.round(t1 - t0), close: Math.round(t3 - t2), closeStatus: c.status };
};
const a = [];
const b = [];
for (let i = 0; i < runs; i++) {
	a.push(await one());
	b.push(await one(args.workspaceId));
}
const q = (xs, p) => {
	const s = [...xs].sort((x, y) => x - y);
	return s[Math.max(0, Math.ceil(p * s.length) - 1)];
};
const pq = (xs) => `${q(xs, 0.5)} / ${q(xs, 0.95)}`;
return {
	a,
	b,
	summary: {
		noWorkspaceCreate: pq(a.map((x) => x.create)),
		noWorkspaceClose: pq(a.map((x) => x.close)),
		workspaceCreate: pq(b.map((x) => x.create)),
		workspaceClose: pq(b.map((x) => x.close)),
		statuses: [...new Set([...a, ...b].map((x) => `${x.status}/${x.closeStatus}`))],
	},
};
