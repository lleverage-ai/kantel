// First bash call: the isolate-ready measurement (`POST /v1/measurements/isolate-ready`, docs/measurements/m1-cf1), whose
// `isolate` step is a session's first shell command (`ls -1R`) through the tiered sandboxes, lease acquisition included.
// Cold: a new session each run (the first command). Warm: 50 more commands on one open session.
// args: { runs, backend, tools }. With `tools` (after #202), each cold run first runs the session's file tools on the
// workspace (read, ls, write), and answers their times and the leases held before its first command. With `warmTools`
// (after #214), only the warm batch runs, each run the file tools on the open session before its command: the tools'
// own times.
const runs = args.runs ?? 50;
const backend = args.backend ?? "in-process";
const tools = args.tools === true;
const warmTools = args.warmTools === true;
const call = async (body) => {
	const t0 = performance.now();
	const r = await fetch("/v1/measurements/isolate-ready", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ backend, ...body }),
	});
	const j = await r.json();
	return {
		status: r.status,
		wall: performance.now() - t0,
		sessionId: j.sessionId,
		warm: j.warm,
		server: j.timings?.total,
		session: j.timings?.session,
		isolate: j.timings?.isolate,
		signIn: j.timings?.signIn,
		lookup: j.timings?.lookup,
		timings: j.timings,
		exit: j.exitCode,
		listed: j.listed,
		leasedBeforeBash: j.leasedBeforeBash,
		...(r.status === 200 ? {} : { error: j.error }),
		...(body.placement ? { placement: j.placement } : {}),
	};
};
const q = (xs, p) => {
	const sorted = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
	return sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
};
const pq = (xs) => ({ p50: q(xs, 0.5), p95: q(xs, 0.95), min: q(xs, 0), max: q(xs, 1) });

const coldBody = tools ? { tools: true } : {};
const coldWarmup = warmTools ? undefined : await call({ placement: true, ...coldBody });
const cold = [];
if (!warmTools) for (let i = 0; i < runs; i++) cold.push(await call(coldBody));

const warmup = await call({ keep: true, placement: true });
const warm = [];
let closed;
try {
	for (let i = 0; i < runs; i++) {
		warm.push(await call({ sessionId: warmup.sessionId, ...(warmTools ? { tools: true } : {}) }));
	}
} finally {
	closed = (
		await fetch(`/v1/sessions/${warmup.sessionId}/close`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		})
	).status;
}
const okOf = (xs) => xs.filter((x) => x.status === 200 && x.exit === 0);
return {
	backend,
	coldWarmup,
	cold,
	warmup,
	warm,
	closed,
	summary: {
		backend,
		coldOk: okOf(cold).length,
		warmOk: okOf(warm).length,
		coldWall: pq(okOf(cold).map((x) => x.wall)),
		coldServer: pq(okOf(cold).map((x) => x.server)),
		coldSession: pq(okOf(cold).map((x) => x.session)),
		firstBashCold: pq(okOf(cold).map((x) => x.isolate)),
		...(tools
			? {
					readCold: pq(okOf(cold).map((x) => x.timings?.read)),
					lsCold: pq(okOf(cold).map((x) => x.timings?.ls)),
					writeCold: pq(okOf(cold).map((x) => x.timings?.write)),
					leasedBeforeBash: [...new Set(cold.map((x) => x.leasedBeforeBash))],
				}
			: {}),
		...(warmTools
			? {
					readWarm: pq(okOf(warm).map((x) => x.timings?.read)),
					lsWarm: pq(okOf(warm).map((x) => x.timings?.ls)),
					writeWarm: pq(okOf(warm).map((x) => x.timings?.write)),
					isolateWarm: pq(okOf(warm).map((x) => x.isolate)),
					leasedBeforeBashWarm: [...new Set(warm.map((x) => x.leasedBeforeBash))],
				}
			: {}),
		warmWall: pq(okOf(warm).map((x) => x.wall)),
		bashWarm: pq(okOf(warm).map((x) => x.server)),
		placement: warmup.placement
			? { object: warmup.placement.objectColo, edge: warmup.placement.edgeColo, d1: warmup.placement.d1?.region }
			: undefined,
	},
};
