// Session ready and time to first token, from the client (a signed-in page on the hostname). Each run:
//   1. POST /v1/sessions -> 201: the new session can take a prompt (cold ready);
//   2. open its WebSocket (GET /v1/sessions/:id/events, upgraded) until the snapshot frame arrives;
//   3. POST …/prompt -> 202, then the first streamed token (a `text` op, thinking or text) and the first answer text,
//      then the run's end (status idle): the cold time to first token, from the moment the prompt was sent;
//   4. close the socket and open it again until the snapshot: an open session ready to take a prompt (warm ready);
//   5. a second prompt on the same session: the warm time to first token;
//   6. POST …/close.
// args: { runs, prompt, agentId, workspaceId }. With `workspaceId`, each session is on that workspace, so (after #202)
// it is offered the coding tools; it still leases nothing until a command.
const runs = args.runs ?? 50;
const workspaceId = args.workspaceId;
const prompt = args.prompt ?? "Reply with the single word: ok";
const agentId = args.agentId ?? "assistant";
const json = { "content-type": "application/json" };
const now = () => performance.now();
const round = (ms) => Math.round(ms * 10) / 10;

const projects = await (await fetch("/v1/projects")).json();
const projectId = (projects.items ?? projects)[0].id;

/** Opens the session's socket; resolves once the snapshot frame is in, with a handle to wait on later frames. */
function openSocket(sessionId) {
	const started = now();
	const url = new URL(`/v1/sessions/${sessionId}/events`, location.href);
	url.protocol = "wss:";
	const ws = new WebSocket(url);
	const waiters = [];
	const seen = [];
	ws.onmessage = (message) => {
		const at = now();
		let frames;
		try {
			frames = JSON.parse(message.data);
		} catch {
			return;
		}
		for (const frame of Array.isArray(frames) ? frames : [frames]) {
			seen.push({ at, frame });
			for (const waiter of [...waiters]) if (waiter.test(frame)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve(at);
			}
		}
	};
	const wait = (test, timeoutMs = 120_000) =>
		new Promise((resolve, reject) => {
			for (const { at, frame } of seen) if (test(frame)) return resolve(at);
			const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
			waiters.push({ test, resolve: (at) => (clearTimeout(timer), resolve(at)) });
		});
	const ready = wait((frame) => frame.type === "snapshot").then((at) => at - started);
	ws.onerror = () => {};
	return { ws, ready, wait, clear: () => (seen.length = 0) };
}

const ops = (frame) => (frame.type === "delta" ? frame.delta.ops : []);
// The model's first output reaches the client as a `text` op, or (a short reply in one chunk) inside the assistant item.
const assistant = (op) => (op.op === "append" || op.op === "replace") && op.item?.kind === "assistant";
const firstToken = (frame) =>
	ops(frame).some(
		(op) => (op.op === "text" && op.append !== "") || (assistant(op) && ((op.item.text ?? "") !== "" || (op.item.thinking ?? "") !== "")),
	);
const firstAnswer = (frame) =>
	ops(frame).some(
		(op) => (op.op === "text" && op.field !== "thinking" && op.append !== "") || (assistant(op) && (op.item.text ?? "") !== ""),
	);
const settled = (frame) =>
	ops(frame).some((op) => op.op === "status" && ["idle", "failed", "cancelled", "done"].includes(op.status));

async function promptOn(socket, sessionId) {
	socket.clear();
	const sent = now();
	const r = await fetch(`/v1/sessions/${sessionId}/prompt`, {
		method: "POST",
		headers: json,
		body: JSON.stringify({ text: prompt, requestId: crypto.randomUUID() }),
	});
	const accepted = now();
	if (r.status !== 202) throw new Error(`prompt answered ${r.status}: ${await r.text()}`);
	const token = await socket.wait(firstToken);
	const answer = await socket.wait(firstAnswer);
	const done = await socket.wait(settled);
	return { accept: round(accepted - sent), ttft: round(token - sent), firstText: round(answer - sent), done: round(done - sent) };
}

async function one() {
	const t0 = now();
	const r = await fetch("/v1/sessions", {
		method: "POST",
		headers: json,
		body: JSON.stringify({
			projectId,
			agentId,
			title: "Session-ready measurement",
			labels: { measurement: "session-ready" },
			...(workspaceId === undefined ? {} : { workspaceId }),
		}),
	});
	const created = now();
	if (r.status !== 201) throw new Error(`create answered ${r.status}: ${await r.text()}`);
	const session = await r.json();
	try {
		const first = openSocket(session.id);
		const streamCold = await first.ready;
		const cold = await promptOn(first, session.id);
		first.ws.close();
		const second = openSocket(session.id);
		const streamWarm = await second.ready;
		const warm = await promptOn(second, session.id);
		second.ws.close();
		return { status: 201, sessionId: session.id, create: round(created - t0), streamCold: round(streamCold), cold, streamWarm: round(streamWarm), warm };
	} finally {
		await fetch(`/v1/sessions/${session.id}/close`, { method: "POST", headers: json, body: "{}" });
	}
}

const q = (xs, p) => {
	const sorted = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
	return sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
};
const pq = (xs) => ({ p50: q(xs, 0.5), p95: q(xs, 0.95), min: q(xs, 0), max: q(xs, 1), n: xs.filter((x) => typeof x === "number").length });

const warmup = await one().catch((error) => ({ error: String(error) }));
const results = [];
for (let i = 0; i < runs; i++) results.push(await one().catch((error) => ({ error: String(error) })));
const ok = results.filter((x) => x.error === undefined);
return {
	prompt,
	projectId,
	agentId,
	warmup,
	runs: results,
	summary: {
		ok: ok.length,
		failed: results.length - ok.length,
		readyCold: pq(ok.map((x) => x.create)),
		readyWarm: pq(ok.map((x) => x.streamWarm)),
		streamCold: pq(ok.map((x) => x.streamCold)),
		acceptCold: pq(ok.map((x) => x.cold.accept)),
		acceptWarm: pq(ok.map((x) => x.warm.accept)),
		ttftCold: pq(ok.map((x) => x.cold.ttft)),
		ttftWarm: pq(ok.map((x) => x.warm.ttft)),
		firstTextCold: pq(ok.map((x) => x.cold.firstText)),
		firstTextWarm: pq(ok.map((x) => x.warm.firstText)),
	},
};
