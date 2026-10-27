/**
 * Regressions for the findings of the PR #40 review that the conformance suites do not cover.
 */
import { describe, expect, test } from "vitest";
import { HarbourEnv } from "../src/env.ts";
import { SPIKE_OWNER, sessionContext } from "../src/identity.ts";
import { runShell, type ShellRequest, type WorkspacePort } from "../src/isolate/shell.ts";
import { MemoryObjectStore } from "../src/object-store.ts";
import { injectHeader } from "../src/redact.ts";
import { CloudflareSandboxes, containerWins } from "../src/sandbox.ts";
import { ObjectStoreWorkspaces } from "../src/workspace.ts";
import { inProcessIsolate, SimulatedContainer } from "./backends.ts";

const ctx = sessionContext("sess-review");
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function fixture() {
	const store = new MemoryObjectStore();
	const workspaces = new ObjectStoreWorkspaces({ store });
	const record = await workspaces.create(ctx, { owner: SPIKE_OWNER, sessionId: "sess-review" });
	return { store, workspaces, id: record.id };
}

describe("workspace manifests", () => {
	test("paths named like Object.prototype members are ordinary files", async () => {
		const { workspaces, id } = await fixture();
		const names = ["__proto__", "constructor", "toString", "dir/__proto__/hasOwnProperty"];
		// Deleting a name that only exists on Object.prototype is not a delete of an existing file.
		await expect(
			workspaces.commit(ctx, id, { baseVersion: 0, changes: [{ op: "delete", path: "constructor" }] }),
		).rejects.toMatchObject({ code: "not_found" });
		const put = await workspaces.commit(ctx, id, {
			baseVersion: 0,
			changes: names.map((path) => ({ op: "put", path, content: new TextEncoder().encode(path) })),
		});
		for (const path of names) expect(text((await workspaces.read(ctx, id, path)).content)).toBe(path);
		// A fresh instance reads the manifest back from storage: the names survive JSON.
		const listed = await workspaces.list(ctx, id, { recursive: true });
		expect(listed.items.filter((entry) => entry.kind === "file").map((entry) => entry.path)).toEqual(
			expect.arrayContaining(names),
		);
		await workspaces.commit(ctx, id, { baseVersion: put.version, changes: [{ op: "delete", path: "__proto__" }] });
		await expect(workspaces.read(ctx, id, "__proto__")).rejects.toMatchObject({ code: "not_found" });
		expect(text((await workspaces.read(ctx, id, "constructor")).content)).toBe("constructor");
	});

	test("history pages cost their size in manifest reads, wherever they start", async () => {
		const { store, workspaces, id } = await fixture();
		let head = 0;
		for (let i = 0; i < 40; i++) {
			head = (
				await workspaces.commit(ctx, id, {
					baseVersion: head,
					changes: [{ op: "put", path: "f", content: new TextEncoder().encode(String(i)) }],
				})
			).version;
		}
		// A cold reader, so nothing is cached.
		const cold = new ObjectStoreWorkspaces({ store });
		const seen: number[] = [];
		let cursor: string | undefined;
		let maxGets = 0;
		do {
			const before = store.gets;
			const page = await cold.history(ctx, id, { limit: 5, ...(cursor === undefined ? {} : { cursor }) });
			maxGets = Math.max(maxGets, store.gets - before);
			seen.push(...page.items.map((item) => item.version));
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		expect(seen).toEqual(Array.from({ length: head + 1 }, (_, i) => head - i));
		// The head document, its record, and five manifests: not a rescan from the head.
		expect(maxGets).toBeLessThanOrEqual(8);
	});

	test("the in-memory store refuses a create-only put over an existing key, as R2 does", async () => {
		const store = new MemoryObjectStore();
		const first = await store.put("k", "one", { onlyIf: { etagDoesNotMatch: "*" } });
		expect(first).not.toBeNull();
		expect(await store.put("k", "two", { onlyIf: { etagDoesNotMatch: "*" } })).toBeNull();
		expect(await store.put("k", "two", { onlyIf: { etagDoesNotMatch: first!.etag } })).toBeNull();
		expect(await store.put("k", "two", { onlyIf: { etagDoesNotMatch: "other" } })).not.toBeNull();
		expect(await (await store.get("k"))!.text()).toBe("two");
	});
});

describe("HarbourEnv writes", () => {
	test("no concurrent append that reports success is lost", async () => {
		const { workspaces, id } = await fixture();
		const sandboxes = new CloudflareSandboxes({
			workspaces,
			isolate: inProcessIsolate(workspaces),
			container: new SimulatedContainer(workspaces),
		});
		const env = new HarbourEnv(ctx, "sess-review", id, workspaces, sandboxes, async () => {});
		const lines = Array.from({ length: 8 }, (_, i) => `line ${i}\n`);
		const results = await Promise.all(lines.map((line) => env.appendFile("log.txt", line)));
		// Retries are bounded, so under this much contention some appends give up with a conflict, and say so.
		const landed = lines.filter((_, i) => results[i]!.ok).map((line) => line.trim());
		for (const result of results) if (!result.ok) expect(result.error.message).toMatch(/conflict|moved|head/i);
		expect(landed.length).toBeGreaterThanOrEqual(2);
		const content = text((await workspaces.read(ctx, id, "log.txt")).content);
		expect(content.split("\n").filter(Boolean).sort()).toEqual(landed.sort());
	});
});

describe("container commits", () => {
	test("the container's tree wins over a head where file and directory swapped", () => {
		const present = new Set(["a", "b/one", "b/two", "keep"]);
		const changes = containerWins(
			[
				{ op: "put", path: "a/inner", content: new Uint8Array() },
				{ op: "put", path: "b", content: new Uint8Array() },
				{ op: "delete", path: "gone" },
			],
			present,
		);
		expect(changes.map((change) => `${change.op} ${change.path}`).sort()).toEqual([
			"delete a",
			"delete b/one",
			"delete b/two",
			"put a/inner",
			"put b",
		]);
	});

	test("a command that runs between pending and committed stays pending", async () => {
		const { workspaces, id } = await fixture();
		const container = new SimulatedContainer(workspaces);
		const sandboxes = new CloudflareSandboxes({ workspaces, isolate: inProcessIsolate(workspaces), container });
		const lease = await sandboxes.acquire(ctx, { sessionId: "sess-review", workspaceId: id, tier: "container" });
		const record = await workspaces.get(ctx, id);
		await container.exec({ ctx, lease, record, request: { command: "printf one > first" } });
		const pending = await container.pending({ ctx, lease, record });
		await container.exec({ ctx, lease, record, request: { command: "printf two > second" } });
		await container.committed(lease, record.head + 1, pending.stamp);
		const after = await container.pending({ ctx, lease, record });
		expect(after.changes.map((change) => change.path)).toEqual(["second"]);
	});
});

describe("isolate mounts", () => {
	const port: WorkspacePort = {
		entries: async () => [],
		mountEntries: async () => [{ kind: "file", path: "/project/README.md", size: 8, version: "1" } as never],
		readBlob: async () => new Uint8Array(),
		readMount: async () => new TextEncoder().encode("original"),
	};
	const request = (command: string): ShellRequest => ({
		command,
		baseVersion: 0,
		mounts: [{ path: "/project", source: "project-files", ref: "p", version: "1" } as never],
	});

	test("a recursive copy onto a mount neither changes it nor escapes as a commit", async () => {
		const outcome = await runShell(
			port,
			request(
				"mkdir -p payload/project && printf changed > payload/project/README.md; cp -r payload/. /; cat /project/README.md",
			),
		);
		expect(outcome.stdout).toBe("original");
		expect(outcome.changes.map((change) => change.path)).toEqual(["payload/project/README.md"]);
	});

	test("a redirect onto a mount fails as read-only", async () => {
		const outcome = await runShell(port, request("echo x > /project/README.md"));
		expect(outcome.exitCode).toBe(1);
		expect(outcome.stderr).toBe("bash: /project/README.md: Read-only file system\n");
		expect(outcome.changes).toEqual([]);
	});
});

describe("vault header injection", () => {
	test("a value that headers would change is refused, not sent", () => {
		const headers = new Headers();
		expect(injectHeader(headers, "authorization", "Bearer sk-plain")).toBe(true);
		expect(headers.get("authorization")).toBe("Bearer sk-plain");
		for (const value of [" padded ", "line\nbreak", "tab\tend\t", "nul\u0000"]) {
			const fresh = new Headers();
			expect(injectHeader(fresh, "authorization", value)).toBe(false);
			expect(fresh.has("authorization")).toBe(false);
		}
	});
});
