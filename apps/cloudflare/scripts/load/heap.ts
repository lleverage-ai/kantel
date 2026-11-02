/**
 * The `wrangler dev` isolate's heap, through its inspector (`scripts/load/README.md`):
 *
 *   node scripts/load/heap.ts usage [ws]          used and total heap, after a full garbage collection
 *   node scripts/load/heap.ts snapshot <file> [ws] a heap snapshot (after a collection), for summary
 *   node scripts/load/heap.ts summary <file>       the snapshot's self sizes by kind and constructor, and its largest
 *                                                   strings, so a measurement can say what holds the memory
 *
 * `ws` defaults to `ws://localhost:9339/ws` (`wrangler dev --inspector-port 9339`).
 */
import { createWriteStream, readFileSync } from "node:fs";

const [command = "usage", fileOrWs, wsArg] = process.argv.slice(2);
const wsUrl = (command === "usage" ? fileOrWs : wsArg) ?? "ws://localhost:9339/ws";

async function inspector() {
	const socket = new WebSocket(wsUrl, {
		headers: { origin: "https://devtools.devprod.cloudflare.dev" },
	} as unknown as string[]);
	await new Promise((resolve, reject) => {
		socket.onopen = resolve;
		socket.onerror = reject;
	});
	let id = 0;
	const pending = new Map<number, (result: unknown) => void>();
	const listeners: ((message: { method?: string; params?: unknown }) => void)[] = [];
	socket.onmessage = (event) => {
		const message = JSON.parse(String(event.data)) as {
			id?: number;
			result?: unknown;
			method?: string;
			params?: unknown;
		};
		if (message.id !== undefined) pending.get(message.id)?.(message.result);
		else for (const listener of listeners) listener(message);
	};
	const call = (method: string, params: object = {}) =>
		new Promise<unknown>((resolve) => {
			id += 1;
			pending.set(id, resolve);
			socket.send(JSON.stringify({ id, method, params }));
		});
	return { call, listeners, close: () => socket.close() };
}

if (command === "usage") {
	const { call, close } = await inspector();
	await call("HeapProfiler.enable");
	// The inspector proxy never answers a collection, so it is sent and given a moment.
	void call("HeapProfiler.collectGarbage");
	await new Promise((resolve) => setTimeout(resolve, 1500));
	const usage = (await call("Runtime.getHeapUsage")) as { usedSize: number; totalSize: number };
	console.log(
		JSON.stringify({
			usedMB: +(usage.usedSize / 1048576).toFixed(1),
			totalMB: +(usage.totalSize / 1048576).toFixed(1),
		}),
	);
	close();
	process.exit(0);
} else if (command === "snapshot") {
	if (fileOrWs === undefined) throw new Error("snapshot <file>");
	const { call, listeners, close } = await inspector();
	const out = createWriteStream(fileOrWs);
	listeners.push((message) => {
		if (message.method === "HeapProfiler.addHeapSnapshotChunk") out.write((message.params as { chunk: string }).chunk);
	});
	await call("HeapProfiler.enable");
	// The inspector proxy never answers a collection, so it is sent and given a moment.
	void call("HeapProfiler.collectGarbage");
	await new Promise((resolve) => setTimeout(resolve, 1500));
	await call("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
	await new Promise((resolve) => out.end(resolve));
	close();
	console.log(`wrote ${fileOrWs}`);
	process.exit(0);
} else if (command === "summary") {
	if (fileOrWs === undefined) throw new Error("summary <file>");
	const snapshot = JSON.parse(readFileSync(fileOrWs, "utf8")) as {
		snapshot: { meta: { node_fields: string[]; node_types: [string[]] } };
		nodes: number[];
		strings: string[];
	};
	const fields = snapshot.snapshot.meta.node_fields;
	const types = snapshot.snapshot.meta.node_types[0];
	const width = fields.length;
	const typeAt = fields.indexOf("type");
	const nameAt = fields.indexOf("name");
	const sizeAt = fields.indexOf("self_size");
	const byKey = new Map<string, { count: number; bytes: number }>();
	const strings: { bytes: number; head: string }[] = [];
	let total = 0;
	for (let i = 0; i < snapshot.nodes.length; i += width) {
		const type = types[snapshot.nodes[i + typeAt]!]!;
		const name = snapshot.strings[snapshot.nodes[i + nameAt]!] ?? "";
		const size = snapshot.nodes[i + sizeAt]!;
		total += size;
		const key = type === "object" || type === "closure" || type === "native" ? `${type}:${name.slice(0, 60)}` : type;
		const entry = byKey.get(key) ?? { count: 0, bytes: 0 };
		entry.count += 1;
		entry.bytes += size;
		byKey.set(key, entry);
		if ((type === "string" || type === "concatenated string" || type === "sliced string") && size > 100_000) {
			strings.push({ bytes: size, head: name.slice(0, 80).replace(/\n/g, "\\n") });
		}
	}
	const mb = (bytes: number) => +(bytes / 1048576).toFixed(2);
	console.log(`total self size ${mb(total)} MB`);
	for (const [key, entry] of [...byKey].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 30)) {
		console.log(`${String(mb(entry.bytes)).padStart(8)} MB ${String(entry.count).padStart(8)}  ${key}`);
	}
	console.log("largest strings:");
	const big = strings.sort((a, b) => b.bytes - a.bytes);
	console.log(`  ${big.length} strings over 100 kB, ${mb(big.reduce((n, s) => n + s.bytes, 0))} MB`);
	for (const s of big.slice(0, 15)) console.log(`${String(mb(s.bytes)).padStart(8)} MB  ${s.head}`);
}
