// The container tier's janitor on a Docker daemon several stacks share: it removes only its own stack's leftovers.
// Another stack's hosts are not in this stack's database, so to this one they all look dead; before the stack label,
// each stack's hosts removed every other stack's sandboxes every 10 seconds.
import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
	ContainerRunner,
	type ContainerRunnerOptions,
	OWNER_LABEL,
	SESSION_LABEL,
	STACK_LABEL,
} from "../src/sandbox/container.ts";
import type { MinioWorkspace } from "../src/workspace.ts";

interface FakeObject {
	readonly Id: string;
	readonly Labels: Record<string, string>;
}

const OPTIONS: ContainerRunnerOptions = {
	socket: "/nonexistent.sock",
	image: "harbour-sandbox:test",
	runtime: "runc",
	network: "harbour-sbx",
	vaultContainer: "harbour-vault-proxy",
	proxyUrl: "http://vault-proxy:3128",
	memoryBytes: 1,
	nanoCpus: 1,
};

/** Docker's label filter: every `key` or `key=value` must match. */
function matches(labels: Record<string, string>, filter: readonly string[]): boolean {
	return filter.every((entry) => {
		const [key, value] = entry.split(/=(.*)/s, 2) as [string, string | undefined];
		return key in labels && (value === undefined || labels[key] === value);
	});
}

/** A ContainerRunner over an in-memory daemon, recording what it removes. */
class FakeDaemonRunner extends ContainerRunner {
	readonly removed: string[] = [];
	constructor(
		options: ContainerRunnerOptions,
		readonly containers: FakeObject[],
		readonly networks: FakeObject[],
		readonly honourFilters = true,
	) {
		super(options, {} as MinioWorkspace, {} as pg.Pool);
	}

	override async docker(path: string, init: RequestInit = {}): Promise<Response> {
		const url = new URL(`http://docker${path}`);
		if (init.method === "DELETE") {
			this.removed.push(url.pathname.split("/").pop() ?? "");
			return new Response(null, { status: 204 });
		}
		const filter = (JSON.parse(url.searchParams.get("filters") ?? "{}") as { label?: string[] }).label ?? [];
		const pick = (objects: FakeObject[]) =>
			Response.json(this.honourFilters ? objects.filter((object) => matches(object.Labels, filter)) : objects);
		if (url.pathname === "/containers/json") return pick(this.containers);
		if (url.pathname === "/networks") return pick(this.networks);
		throw new Error(`unexpected docker call ${init.method ?? "GET"} ${path}`);
	}
}

const labelled = (id: string, stack: string, owner: string, session = "ses_1"): FakeObject => ({
	Id: id,
	Labels: { [STACK_LABEL]: stack, [OWNER_LABEL]: owner, [SESSION_LABEL]: session },
});

describe("the container tier's janitor", () => {
	const daemon = () => ({
		containers: [
			labelled("mine-dead", "harbour-vault-proxy", "host-a-old"),
			labelled("mine-alive", "harbour-vault-proxy", "host-a-now"),
			labelled("ci-sandbox", "harbour-ci-1-vault-proxy", "host-a-ci"),
			// What a host on the old code made: no stack label.
			{ Id: "legacy", Labels: { "harbour.owner": "someone", [SESSION_LABEL]: "ses_1" } },
		],
		networks: [labelled("net-mine-dead", "harbour-vault-proxy", "host-a-old"), labelled("net-ci", "ci", "host-a-ci")],
	});
	const alive = async (owner: string) => owner === "host-a-now";

	it("removes only its own stack's containers and networks whose owner is dead", async () => {
		const { containers, networks } = daemon();
		const runner = new FakeDaemonRunner(OPTIONS, containers, networks);
		expect(await runner.reapDeadOwners(alive)).toBe(1);
		expect(runner.removed.sort()).toEqual(["mine-dead", "net-mine-dead"]);
	});

	it("checks the stack itself, even if the daemon ignored the filter", async () => {
		const { containers, networks } = daemon();
		const runner = new FakeDaemonRunner(OPTIONS, containers, networks, false);
		await runner.reapDeadOwners(alive);
		expect(runner.removed.sort()).toEqual(["mine-dead", "net-mine-dead"]);
	});

	it("reaps a session's leftovers in its own stack only", async () => {
		const containers = [
			labelled("mine", "harbour-vault-proxy", "x", "ses_shared"),
			labelled("theirs", "harbour-m1sh-vault-proxy", "y", "ses_shared"),
		];
		const runner = new FakeDaemonRunner(OPTIONS, containers, []);
		expect(await runner.reap("ses_shared")).toBe(1);
		expect(runner.removed).toEqual(["mine"]);
	});

	it("names its stack after its vault container unless given one", () => {
		expect(new FakeDaemonRunner(OPTIONS, [], []).stack).toBe("harbour-vault-proxy");
		expect(new FakeDaemonRunner({ ...OPTIONS, stack: "ci-7" }, [], []).stack).toBe("ci-7");
	});
});
