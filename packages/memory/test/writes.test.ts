import {
	type CallContext,
	KantelError,
	type MemoryProposal,
	type MemorySource,
	type MemorySpace,
} from "@kantel/contracts";
import { createMemoryMemory } from "@kantel/memory/memory";
import { withBundlePublishing } from "@kantel/memory/publish";
import {
	memoryWriteOperations,
	parseMemoryWrite,
	parseOwner,
	parseSnapshot,
	runMemoryWrite,
} from "@kantel/memory/writes";
import { ManualClock, RecordingAuditSink } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const human: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-a" };
const agent: CallContext = {
	actor: { kind: "agent", agentId: "agent-1", sessionId: "session-1" },
	organisationId: "org-a",
};
const concept = {
	id: "projects/kantel/ci",
	title: "CI",
	statement: "CI runs on push.",
	scope: { kind: "global" },
	sources: ["test"],
};

async function code(call: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
	try {
		await (typeof call === "function" ? call() : call);
		return undefined;
	} catch (error) {
		return error instanceof KantelError ? error.code : `not a KantelError: ${String(error)}`;
	}
}

describe("memory write parsers", () => {
	it("read every owner and write shape, and refuse unknown or missing fields as invalid", async () => {
		expect(parseOwner({ kind: "project", organisationId: "org-a", projectId: "p" })).toEqual({
			kind: "project",
			organisationId: "org-a",
			projectId: "p",
		});
		expect(parseOwner({ kind: "user", organisationId: "org-a", userId: "u" }).kind).toBe("user");
		expect(await code(() => parseOwner({ kind: "platform" }))).toBe("invalid");
		expect(await code(() => parseOwner({ kind: "organisation", organisationId: "org-a", extra: 1 }))).toBe("invalid");
		expect(await code(() => parseOwner({ kind: "project", organisationId: "org-a" }))).toBe("invalid");

		expect(parseMemoryWrite({ op: "remember", concept })).toEqual({ op: "remember", concept });
		const described = { ...concept, description: "" };
		expect(parseMemoryWrite({ op: "remember", concept: described })).toEqual({ op: "remember", concept: described });
		expect(parseMemoryWrite({ op: "correct", concept, expectedVersion: 2 }).op).toBe("correct");
		expect(
			parseMemoryWrite({ op: "supersede", conceptId: concept.id, expectedVersion: 1, replacement: concept }).op,
		).toBe("supersede");
		expect(parseMemoryWrite({ op: "forget", conceptId: concept.id, expectedVersion: 1, reason: "Wrong" }).op).toBe(
			"forget",
		);
		for (const bad of [
			null,
			[],
			{ op: "erase" },
			{ op: "remember" },
			{ op: "remember", concept, expectedVersion: 1 },
			{ op: "remember", concept: { ...concept, title: "" } },
			{ op: "remember", concept: { ...concept, secret: "x" } },
			{ op: "remember", concept: { ...concept, description: 1 } },
			{ op: "remember", concept: { ...concept, scope: { kind: "project" } } },
			{ op: "remember", concept: { ...concept, scope: { kind: "global", project: "x" } } },
			{ op: "correct", concept, expectedVersion: 0 },
			{ op: "forget", conceptId: concept.id, expectedVersion: 1.5, reason: "Wrong" },
		]) {
			expect(await code(() => parseMemoryWrite(bad)), JSON.stringify(bad)).toBe("invalid");
		}

		const snapshot = parseSnapshot({
			sourceId: "team-memory",
			ref: "abc",
			concepts: [{ ...concept, setBy: "owner", status: "active", updatedAt: 1 }],
		});
		expect(snapshot.concepts[0]?.setBy).toBe("owner");
		expect(
			await code(() =>
				parseSnapshot({
					sourceId: "s",
					ref: "r",
					concepts: [{ ...concept, setBy: "owner", status: "gone", updatedAt: 1 }],
				}),
			),
		).toBe("invalid");
	});
});

describe("runMemoryWrite", () => {
	it("parses then runs each operation as the caller, so the memory's own rules apply", async () => {
		const memory = createMemoryMemory();
		const space = (await runMemoryWrite(memory, human, "memory.createSpace", {
			owner: { kind: "organisation", organisationId: "org-a" },
			name: "Team",
		})) as MemorySpace;
		expect(space.name).toBe("Team");
		const proposal = (await runMemoryWrite(memory, agent, "memory.propose", {
			spaceId: space.id,
			write: { op: "remember", concept },
		})) as MemoryProposal;
		expect(proposal.status).toBe("pending");
		expect(
			await code(runMemoryWrite(memory, agent, "memory.decide", { proposalId: proposal.id, outcome: "apply" })),
		).toBe("forbidden");
		const applied = await runMemoryWrite(memory, human, "memory.decide", {
			proposalId: proposal.id,
			outcome: "apply",
			note: "Fine",
		});
		expect("status" in applied && applied.status).toBe("applied");
		expect((await memory.getConcept(human, space.id, concept.id)).setBy).toBe("learned");
		expect(await code(runMemoryWrite(memory, human, "memory.decide", { proposalId: "x", outcome: "maybe" }))).toBe(
			"invalid",
		);
		expect(await code(runMemoryWrite(memory, human, "memory.erase", {}))).toBe("not_found");
		expect(await code(runMemoryWrite(memory, human, "toString", {}))).toBe("not_found");
		expect(await code(runMemoryWrite(memory, human, "memory.publishBundle", { spaceId: space.id }))).toBe(
			"not_supported",
		);
		expect(
			Object.values(memoryWriteOperations)
				.filter((operation) => operation.agents)
				.map((op) => op.name),
		).toEqual(["memory.propose"]);
	});
});

describe("withBundlePublishing", () => {
	function setup(publish: MemorySource["publish"]) {
		const clock = new ManualClock();
		const audit = new RecordingAuditSink();
		const inner = createMemoryMemory({ clock, audit });
		const calls: { spaceId: string; paths: string[] }[] = [];
		const source: MemorySource = {
			id: "team-memory",
			async publish(spaceId, files) {
				calls.push({ spaceId, paths: files.map((file) => file.path).sort() });
				return publish(spaceId, files);
			},
		};
		const memory = withBundlePublishing({ memory: inner, sourceFor: () => source, audit, clock });
		return { memory, audit, calls };
	}

	async function propose(memory: ReturnType<typeof setup>["memory"], spaceId: string, id: string, statement: string) {
		return memory.propose(agent, spaceId, {
			op: "remember",
			concept: { ...concept, id, title: id, statement, scope: { kind: "global" } },
		});
	}

	it("publishes the whole bundle after an applied write, never after a rejected one, and audits it", async () => {
		let commits = 0;
		const { memory, audit, calls } = setup(async () => ({ ref: `commit-${++commits}` }));
		const space = await memory.createSpace(human, {
			owner: { kind: "organisation", organisationId: "org-a" },
			name: "Team",
		});
		const first = await propose(memory, space.id, "projects/kantel/ci", "CI runs on push.");
		const second = await propose(memory, space.id, "projects/kantel/lint", "Biome lints the code.");
		await memory.decide(human, second.id, { outcome: "reject" });
		expect(calls).toEqual([]);
		await memory.decide(human, first.id, { outcome: "apply" });
		expect(calls).toEqual([{ spaceId: space.id, paths: ["index.md", "projects/kantel/ci.md"] }]);
		expect(audit.ofType("memory.bundle.published").map((event) => event.data)).toEqual([
			{ sourceId: "team-memory", ref: "commit-1", files: 2 },
		]);
		expect(await memory.publishBundle(human, space.id)).toEqual({
			spaceId: space.id,
			sourceId: "team-memory",
			ref: "commit-2",
			files: 2,
		});
		expect(await code(memory.publishBundle(agent, space.id))).toBe("forbidden");
		expect(await code(memory.publishBundle({ ...human, organisationId: "org-b" }, space.id))).toBe("not_found");
	});

	it("keeps an applied write when the publish fails, audits only the code, and catches up on the next publish", async () => {
		let failing = true;
		const { memory, audit, calls } = setup(async () => {
			if (failing) throw new Error("push to https://token@example.com/repo.git failed");
			return { ref: "commit-ok" };
		});
		const space = await memory.createSpace(human, {
			owner: { kind: "organisation", organisationId: "org-a" },
			name: "Team",
		});
		const proposal = await propose(memory, space.id, "projects/kantel/ci", "CI runs on push.");
		expect((await memory.decide(human, proposal.id, { outcome: "apply" })).status).toBe("applied");
		expect((await memory.getConcept(human, space.id, "projects/kantel/ci")).version).toBe(1);
		const failed = audit.ofType("memory.bundle.publish_failed");
		expect(failed.map((event) => event.data)).toEqual([{ sourceId: "team-memory", error: "error" }]);
		expect(JSON.stringify(failed)).not.toContain("token");
		expect(await code(memory.publishBundle(human, space.id))).toBe("unavailable");
		failing = false;
		expect((await memory.publishBundle(human, space.id)).ref).toBe("commit-ok");
		expect(calls.length).toBe(3);
	});

	it("publishes one space at a time, and applies arriving during a publish share the next one", async () => {
		const releases: (() => void)[] = [];
		let running = 0;
		let most = 0;
		let commits = 0;
		const { memory, calls } = setup(async () => {
			running += 1;
			most = Math.max(most, running);
			await new Promise<void>((resolve) => releases.push(resolve));
			running -= 1;
			return { ref: `commit-${++commits}` };
		});
		const space = await memory.createSpace(human, {
			owner: { kind: "organisation", organisationId: "org-a" },
			name: "Team",
		});
		const proposals = [
			await propose(memory, space.id, "projects/kantel/ci", "CI runs on push."),
			await propose(memory, space.id, "projects/kantel/lint", "Biome lints the code."),
			await propose(memory, space.id, "projects/kantel/tests", "Vitest runs the tests."),
		];
		const first = memory.decide(human, proposals[0]!.id, { outcome: "apply" });
		await vi_waitFor(() => releases.length === 1);
		const rest = [1, 2].map((index) => memory.decide(human, proposals[index]!.id, { outcome: "apply" }));
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(releases.length).toBe(1);
		releases.shift()?.();
		await first;
		await vi_waitFor(() => releases.length === 1);
		releases.shift()?.();
		await Promise.all(rest);
		expect(most).toBe(1);
		expect(calls.length).toBe(2);
		expect(calls[1]?.paths).toEqual([
			"index.md",
			"projects/kantel/ci.md",
			"projects/kantel/lint.md",
			"projects/kantel/tests.md",
		]);
	});

	it("publishes nothing for a space without a source", async () => {
		const memory = withBundlePublishing({ memory: createMemoryMemory(), sourceFor: () => undefined });
		const space = await memory.createSpace(human, {
			owner: { kind: "organisation", organisationId: "org-a" },
			name: "Team",
		});
		const proposal = await propose(memory as never, space.id, "projects/kantel/ci", "CI runs on push.");
		expect((await memory.decide(human, proposal.id, { outcome: "apply" })).status).toBe("applied");
		expect(await code(memory.publishBundle(human, space.id))).toBe("not_supported");
	});
});

async function vi_waitFor(condition: () => boolean): Promise<void> {
	for (let tries = 0; tries < 200 && !condition(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 1));
	expect(condition()).toBe(true);
}
