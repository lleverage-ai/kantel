// The gateway in process, over a real socket, with no stack: the same end-to-end pass the compose test makes.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { bootstrap, createGatewayComponents } from "../../src/gateway/components.ts";
import { createGateway } from "../../src/gateway/gateway.ts";
import { type Listening, listen } from "../../src/gateway/node-http.ts";
import { type E2eTarget, runGatewayE2e } from "./e2e.ts";

let server: Listening;
let target: E2eTarget;
let consoleDir: string;
let close: () => Promise<void>;

beforeAll(async () => {
	consoleDir = await mkdtemp(join(tmpdir(), "harbour-console-"));
	await writeFile(join(consoleDir, "index.html"), '<!doctype html><div id="root"></div>');
	const components = createGatewayComponents();
	const seeded = await bootstrap(components, { organisation: "Test", project: "test" });
	const gateway = createGateway({ components, consoleDir });
	server = await listen(gateway.fetch, 0, "127.0.0.1");
	target = { baseUrl: server.url, ...seeded };
	close = async () => {
		await gateway.close();
		await server.close();
		await components.close();
	};
});

afterAll(async () => {
	await close();
	await rm(consoleDir, { recursive: true, force: true });
});

test("the gateway serves every mounted API end to end", async () => {
	const checks = await runGatewayE2e(target);
	expect(checks.filter((check) => !check.ok)).toEqual([]);
	expect(checks.length).toBeGreaterThan(15);
});

test("static paths cannot leave the console directory", async () => {
	for (const path of ["/..%2f..%2fetc%2fpasswd", "/%2e%2e/%2e%2e/etc/passwd.txt", "/assets/../../x.js"]) {
		const response = await fetch(`${server.url}${path}`);
		expect(response.status === 404 || response.status === 400 || response.status === 200).toBe(true);
		expect(await response.text()).not.toContain("root:");
	}
});
