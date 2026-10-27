// The gateway in process, over a real socket, with no stack: the same end-to-end pass the compose test makes, plus
// the HTTP adapter's limits and the bootstrap file's permissions.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { bootstrap, createGatewayComponents } from "../../src/gateway/components.ts";
import { createGateway } from "../../src/gateway/gateway.ts";
import { writePrivateFile } from "../../src/gateway/main.ts";
import { type Listening, listen } from "../../src/gateway/node-http.ts";
import { type E2eTarget, runGatewayE2e } from "./e2e.ts";

const REQUEST_TIMEOUT_MS = 1000;

let server: Listening;
let target: E2eTarget;
let scratch: string;
let close: () => Promise<void>;

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "harbour-gateway-"));
	await writeFile(join(scratch, "index.html"), '<!doctype html><div id="root"></div>');
	const components = createGatewayComponents();
	const seeded = await bootstrap(components, { organisation: "Test", project: "test" });
	const gateway = createGateway({ components, consoleDir: scratch });
	server = await listen(gateway.fetch, 0, { host: "127.0.0.1", requestTimeoutMs: REQUEST_TIMEOUT_MS });
	target = { baseUrl: server.url, ...seeded };
	close = async () => {
		await gateway.close();
		await server.close();
		await components.close();
	};
});

afterAll(async () => {
	await close();
	await rm(scratch, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the gateway serves every mounted API end to end", async () => {
	const checks = await runGatewayE2e(target);
	expect(checks.filter((check) => !check.ok)).toEqual([]);
	expect(checks.length).toBeGreaterThan(15);
});

test("static paths cannot leave the console directory", async () => {
	const outside = join(scratch, "..", `harbour-outside-${crypto.randomUUID()}.txt`);
	await writeFile(outside, "outside-sentinel");
	try {
		const name = outside.split("/").pop();
		for (const path of [`/..%2f${name}`, `/%2e%2e/${name}`, `/assets/../../${name}`, `/../${name}`]) {
			const response = await fetch(`${server.url}${path}`);
			expect(await response.text()).not.toContain("outside-sentinel");
		}
	} finally {
		await rm(outside, { force: true });
	}
});

test("HEAD answers with headers and no body", async () => {
	const response = await fetch(`${server.url}/`, { method: "HEAD" });
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/html");
	expect(await response.text()).toBe("");
});

test("a body over the limit is refused with 413", async () => {
	const response = await fetch(`${target.baseUrl}/v1/sessions`, {
		method: "POST",
		headers: { authorization: `Bearer ${target.apiKey}`, "content-type": "application/json" },
		body: "x".repeat(5 * 1024 * 1024),
	});
	expect(response.status).toBe(413);
});

test("a request whose body never finishes is cut off, but an event stream outlives the request timeout", async () => {
	// A client that sends half a body and stalls.
	const port = new URL(server.url).port;
	const closedAfter = await new Promise<number>((resolve, reject) => {
		const started = Date.now();
		const socket = connect(Number(port), "127.0.0.1", () => {
			socket.write(
				`POST /v1/sessions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"pro`,
			);
		});
		const watchdog = setTimeout(() => {
			socket.destroy();
			reject(new Error("the stalled request was never cut off"));
		}, REQUEST_TIMEOUT_MS * 10);
		socket.on("data", () => {});
		socket.on("close", () => {
			clearTimeout(watchdog);
			resolve(Date.now() - started);
		});
		socket.on("error", () => {});
	});
	expect(closedAfter).toBeLessThan(REQUEST_TIMEOUT_MS * 10);

	// An event stream stays open well past the request timeout.
	const created = await fetch(`${target.baseUrl}/v1/sessions`, {
		method: "POST",
		headers: { authorization: `Bearer ${target.apiKey}`, "content-type": "application/json" },
		body: JSON.stringify({ projectId: target.projectId, agentId: "echo" }),
	});
	const { id } = (await created.json()) as { id: string };
	const events = await fetch(`${target.baseUrl}/v1/sessions/${id}/events`, {
		headers: { authorization: `Bearer ${target.apiKey}` },
	});
	expect(events.ok).toBe(true);
	const reader = events.body?.getReader();
	if (reader === undefined) throw new Error("no event stream");
	await reader.read();
	await sleep(REQUEST_TIMEOUT_MS * 2.5);
	const next = await Promise.race([reader.read(), sleep(300).then(() => "open" as const)]);
	expect(next === "open" || next.done === false).toBe(true);
	await reader.cancel();
}, 20_000);

test("the bootstrap file is private even when it replaces a readable one", async () => {
	const path = join(scratch, "state", "bootstrap.json");
	await writePrivateFile(path, "first");
	await writeFile(path, "old", { mode: 0o644 });
	const { chmod } = await import("node:fs/promises");
	await chmod(path, 0o644);
	await writePrivateFile(path, '{"apiKey":"hbr_secret"}');
	expect((await stat(path)).mode & 0o777).toBe(0o600);
	expect(await readFile(path, "utf8")).toBe('{"apiKey":"hbr_secret"}');
});
