/**
 * The load test (`scripts/load/README.md`): long sessions side by side against a Kantel gateway, each on its own staged
 * workspace, with every turn's time, every 5xx (a reset reaches a client as a 503) and, under `wrangler dev`, the
 * isolate's heap sampled through the inspector.
 *
 *   node scripts/load/run.ts --base http://localhost:8799 --sessions 3 --turns 6 \
 *     --prompt "load steps=12 out=200000 write=200000 container=2000000" [--inspector ws://localhost:9339/ws] \
 *     [--stage-bytes 3000000] [--out results.json] [--close]
 *
 * Without `--key` it asks `wrangler dev`'s `/__dev/api-key` for one.
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		base: { type: "string", default: "http://localhost:8799" },
		key: { type: "string" },
		project: { type: "string" },
		sessions: { type: "string", default: "3" },
		turns: { type: "string", default: "4" },
		prompt: { type: "string", default: "load steps=12 out=200000 write=200000" },
		model: { type: "string" },
		inspector: { type: "string" },
		"stage-bytes": { type: "string", default: "2000000" },
		"stagger-ms": { type: "string", default: "500" },
		out: { type: "string" },
		close: { type: "boolean", default: false },
		"cold-creates": { type: "string", default: "0" },
	},
});

const base = values.base.replace(/\/$/, "");
let key = values.key;
let projectId = values.project;
if (key === undefined) {
	const dev = (await (await fetch(`${base}/__dev/api-key`)).json()) as { secret: string; projectId: string };
	key = dev.secret;
	projectId ??= dev.projectId;
}
if (projectId === undefined) throw new Error("--project is needed with --key");
const auth = { authorization: `Bearer ${key}` };

interface Call {
	readonly status: number;
	readonly json: unknown;
	readonly ms: number;
}
const failures: { at: number; path: string; status: number; text: string }[] = [];
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Call> {
	const started = performance.now();
	const init: RequestInit = { method, headers: { ...auth, ...headers } };
	if (body instanceof Uint8Array) init.body = body;
	else if (body !== undefined) {
		init.body = JSON.stringify(body);
		(init.headers as Record<string, string>)["content-type"] = "application/json";
	}
	const response = await fetch(`${base}${path}`, init);
	const text = await response.text();
	const ms = performance.now() - started;
	if (response.status >= 500)
		failures.push({ at: Date.now(), path: path.split("?")[0]!, status: response.status, text: text.slice(0, 300) });
	let json: unknown;
	try {
		json = text === "" ? undefined : JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: response.status, json, ms };
}

// The heap, through the inspector (wrangler dev only): Runtime.getHeapUsage every second.
const heap: { at: number; used: number; total: number; embedder?: number; backing?: number }[] = [];
let stopHeap = () => {};
if (values.inspector !== undefined) {
	// wrangler's inspector proxy wants an Origin, as DevTools sends.
	const socket = new WebSocket(values.inspector, {
		headers: { origin: "https://devtools.devprod.cloudflare.dev" },
	} as unknown as string[]);
	await new Promise((resolve, reject) => {
		socket.onopen = resolve;
		socket.onerror = reject;
	});
	let id = 0;
	socket.onmessage = (event) => {
		const message = JSON.parse(String(event.data)) as {
			result?: { usedSize: number; totalSize: number; embedderHeapUsedSize?: number; backingStorageSize?: number };
		};
		if (message.result?.usedSize !== undefined) {
			heap.push({
				at: Date.now(),
				used: message.result.usedSize,
				total: message.result.totalSize,
				...(message.result.embedderHeapUsedSize === undefined ? {} : { embedder: message.result.embedderHeapUsedSize }),
				...(message.result.backingStorageSize === undefined ? {} : { backing: message.result.backingStorageSize }),
			});
		}
	};
	const sample = () => socket.send(JSON.stringify({ id: ++id, method: "Runtime.getHeapUsage" }));
	sample();
	const timer = setInterval(sample, 1000);
	stopHeap = () => {
		clearInterval(timer);
		socket.close();
	};
}

const filler = (bytes: number, salt: string) => {
	const line = `${salt} staged line of text for the load test 0123456789 abcdefghijklmnopqrstuvwxyz\n`;
	return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
};

/** Cold creates: sessions created one after another with nothing else running, timed. */
const coldCreates: number[] = [];
for (let i = 0; i < Number(values["cold-creates"]); i += 1) {
	const created = await api("POST", "/v1/sessions", { projectId, agentId: "assistant", title: `cold create ${i}` });
	coldCreates.push(Math.round(created.ms));
	const id = (created.json as { id?: string }).id;
	if (values.close && id !== undefined) await api("POST", `/v1/sessions/${id}/close`, {});
}

interface SessionResult {
	id?: string;
	stageMs?: number;
	createMs?: number;
	turns: { ms: number; status: string; error?: string }[];
	streamFrames: number;
	streamCloses: number;
	error?: string;
}

async function runSession(index: number): Promise<SessionResult> {
	const result: SessionResult = { turns: [], streamFrames: 0, streamCloses: 0 };
	try {
		const stageBytes = Number(values["stage-bytes"]);
		const files: Record<string, string> = {};
		const count = 20;
		for (let i = 0; i < count; i += 1)
			files[`data/file-${i}.txt`] = filler(Math.floor(stageBytes / count), `s${index}f${i}`);
		const started = performance.now();
		const workspace = await api("POST", "/v1/workspaces", {
			projectId,
			seed: { name: `load-${index}`, sources: [{ kind: "files", files }] },
		});
		const workspaceId = (workspace.json as { id?: string }).id;
		if (workspaceId === undefined)
			throw new Error(`workspace: ${workspace.status} ${JSON.stringify(workspace.json).slice(0, 300)}`);
		const binary = new Uint8Array(1_000_000).map((_, i) => (i * 31 + index) & 255);
		await api("PUT", `/v1/workspaces/${workspaceId}/content?path=${encodeURIComponent("data/blob.bin")}`, binary, {
			"if-none-match": "*",
			"content-type": "application/octet-stream",
		});
		result.stageMs = Math.round(performance.now() - started);
		const created = await api("POST", "/v1/sessions", {
			projectId,
			agentId: "assistant",
			workspaceId,
			title: `load ${index}`,
			labels: { load: "TASK-4487" },
		});
		result.createMs = Math.round(created.ms);
		const sessionId = (created.json as { id?: string }).id;
		if (sessionId === undefined)
			throw new Error(`session: ${created.status} ${JSON.stringify(created.json).slice(0, 300)}`);
		result.id = sessionId;
		// The event stream, as the console reads it.
		let open = true;
		const connect = () => {
			const url = new URL(`${base}/v1/sessions/${sessionId}/stream`);
			url.protocol = url.protocol.replace("http", "ws");
			const socket = new WebSocket(url, { headers: auth } as unknown as string[]);
			socket.onmessage = () => {
				result.streamFrames += 1;
			};
			socket.onclose = () => {
				result.streamCloses += 1;
				if (open) setTimeout(connect, 1000);
			};
			return socket;
		};
		let socket = connect();
		for (let turn = 0; turn < Number(values.turns); turn += 1) {
			const sent = performance.now();
			const message = await api("POST", `/v1/sessions/${sessionId}/messages`, {
				text: `${values.prompt} turn=${turn}`,
				...(turn === 0 && values.model !== undefined ? { model: values.model } : {}),
			});
			const submission = (message.json as { id?: string }).id;
			if (submission === undefined) {
				result.turns.push({
					ms: Math.round(message.ms),
					status: "refused",
					error: JSON.stringify(message.json).slice(0, 300),
				});
				continue;
			}
			let status = "pending";
			let error: string | undefined;
			while (status === "pending") {
				const answer = await api(
					"GET",
					`/v1/sessions/${sessionId}/result?submission=${encodeURIComponent(submission)}&timeoutMs=60000`,
				).catch(() => undefined);
				if (answer === undefined || answer.status >= 500) {
					await new Promise((resolve) => setTimeout(resolve, 2000));
					continue;
				}
				const body = answer.json as { status?: string; error?: string };
				status = body.status ?? `http ${answer.status}`;
				error = body.error;
			}
			result.turns.push({
				ms: Math.round(performance.now() - sent),
				status,
				...(error === undefined ? {} : { error }),
			});
		}
		open = false;
		socket.close();
		socket = undefined as never;
		if (values.close) await api("POST", `/v1/sessions/${sessionId}/close`, {});
	} catch (error) {
		result.error = error instanceof Error ? error.message : String(error);
	}
	return result;
}

const startedAt = Date.now();
const sessions = await Promise.all(
	Array.from({ length: Number(values.sessions) }, async (_, index) => {
		await new Promise((resolve) => setTimeout(resolve, index * Number(values["stagger-ms"])));
		return runSession(index);
	}),
);
const endedAt = Date.now();
await new Promise((resolve) => setTimeout(resolve, 2000));
stopHeap();
const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
const peak = heap.reduce((max, sample) => Math.max(max, sample.used), 0);
const summary = {
	base,
	prompt: values.prompt,
	sessions: sessions.length,
	turns: Number(values.turns),
	durationS: Math.round((endedAt - startedAt) / 1000),
	failures5xx: failures.length,
	failures,
	coldCreates,
	heap:
		heap.length === 0
			? undefined
			: { startMB: mb(heap[0]!.used), peakMB: mb(peak), endMB: mb(heap.at(-1)!.used), samples: heap.length },
	results: sessions,
};
console.log(
	JSON.stringify(
		{
			...summary,
			results: sessions.map((s) => ({
				...s,
				turns: s.turns.map((t) => `${t.status} ${t.ms}ms${t.error ? ` ${t.error}` : ""}`),
			})),
		},
		null,
		1,
	),
);
if (values.out !== undefined) {
	const { writeFileSync } = await import("node:fs");
	writeFileSync(values.out, JSON.stringify({ ...summary, heapSamples: heap }, null, 1));
}
process.exit(0);
