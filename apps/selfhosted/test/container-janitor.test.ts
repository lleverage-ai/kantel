// The container tier's janitor on a Docker daemon several stacks share: it removes only its own stack's leftovers.
// Another stack's hosts are not in this stack's database, so to this one they all look dead; before the stack label,
// each stack's hosts removed every other stack's sandboxes every 10 seconds.
import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
	ContainerRunner,
	type ContainerRunnerOptions,
	LEGACY_OWNER_LABEL,
	OWNER_LABEL,
	SESSION_LABEL,
	STACK_LABEL,
} from "../src/sandbox/container.ts";
import type { MinioWorkspace } from "../src/workspace.ts";

interface FakeContainer {
	readonly Id: string;
	readonly Labels: Record<string, string>;
	readonly HostConfig?: { NetworkMode: string };
}

interface FakeNetwork {
	readonly Id: string;
	readonly Labels: Record<string, string>;
	/** Names of the containers on it. */
	readonly members?: readonly string[];
}

const VAULT = "harbour-vault-proxy";

const OPTIONS: ContainerRunnerOptions = {
	socket: "/nonexistent.sock",
	image: "harbour-sandbox:test",
	runtime: "runc",
	network: "harbour-sbx",
	vaultContainer: VAULT,
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

/** A ContainerRunner over an in-memory daemon, recording what it removes and the label filters it lists with. */
class FakeDaemonRunner extends ContainerRunner {
	readonly removed: string[] = [];
	readonly filters: string[][] = [];
	constructor(
		options: ContainerRunnerOptions,
		readonly containers: FakeContainer[],
		readonly networks: FakeNetwork[],
		readonly honourFilters = true,
	) {
		super(options, {} as MinioWorkspace, {} as pg.Pool);
	}

	override async docker(path: string, init: RequestInit = {}): Promise<Response> {
		const url = new URL(`http://docker${path}`);
		const parts = url.pathname.split("/").filter(Boolean);
		if (init.method === "DELETE") {
			this.removed.push(parts.at(-1) ?? "");
			return new Response(null, { status: 204 });
		}
		if (init.method === "POST" && parts[0] === "networks" && parts[2] === "disconnect") {
			return new Response(null, { status: 200 });
		}
		if (url.pathname === "/containers/json" || url.pathname === "/networks") {
			const filter = (JSON.parse(url.searchParams.get("filters") ?? "{}") as { label?: string[] }).label ?? [];
			this.filters.push(filter);
			const objects: { Labels: Record<string, string> }[] =
				url.pathname === "/networks" ? this.networks : this.containers;
			return Response.json(this.honourFilters ? objects.filter((object) => matches(object.Labels, filter)) : objects);
		}
		if (parts[0] === "networks" && parts.length === 2) {
			const network = this.networks.find((candidate) => candidate.Id === parts[1]);
			const members = Object.fromEntries((network?.members ?? []).map((name, i) => [`c${i}`, { Name: name }]));
			return Response.json({ Id: parts[1], Containers: members });
		}
		throw new Error(`unexpected docker call ${init.method ?? "GET"} ${path}`);
	}
}

const labelled = (id: string, stack: string, owner: string, session = "ses_1"): FakeContainer => ({
	Id: id,
	Labels: { [STACK_LABEL]: stack, [OWNER_LABEL]: owner, [SESSION_LABEL]: session },
});

const legacy = (id: string, owner: string, network: string): FakeContainer => ({
	Id: id,
	Labels: { [LEGACY_OWNER_LABEL]: owner, [SESSION_LABEL]: "ses_old" },
	HostConfig: { NetworkMode: network },
});

const legacyNetwork = (id: string, owner: string, members: readonly string[]): FakeNetwork => ({
	Id: id,
	Labels: { [LEGACY_OWNER_LABEL]: owner, [SESSION_LABEL]: "ses_old" },
	members,
});

describe("the container tier's janitor", () => {
	const daemon = () => ({
		containers: [
			labelled("mine-dead", VAULT, "host-a-old"),
			labelled("mine-alive", VAULT, "host-a-now"),
			labelled("ci-sandbox", "harbour-ci-1-vault-proxy", "host-a-ci"),
		],
		networks: [
			{ ...labelled("net-mine-dead", VAULT, "host-a-old") },
			{ ...labelled("net-mine-alive", VAULT, "host-a-now") },
			{ ...labelled("net-ci", "harbour-ci-1-vault-proxy", "host-a-ci") },
		],
	});
	const alive = async (owner: string) => owner === "host-a-now";

	it("removes only its own stack's containers and networks whose owner is dead", async () => {
		const { containers, networks } = daemon();
		const runner = new FakeDaemonRunner(OPTIONS, containers, networks);
		expect(await runner.reapDeadOwners(alive)).toBe(1);
		expect(runner.removed.sort()).toEqual(["mine-dead", "net-mine-dead"]);
	});

	it("asks Docker for this stack's objects only", async () => {
		const { containers, networks } = daemon();
		const runner = new FakeDaemonRunner(OPTIONS, containers, networks);
		await runner.reapDeadOwners(alive);
		const [containerFilter, networkFilter] = runner.filters;
		expect(containerFilter).toContain(`${STACK_LABEL}=${VAULT}`);
		expect(networkFilter).toContain(`${STACK_LABEL}=${VAULT}`);
	});

	it("checks the stack itself, even if the daemon ignored the filter", async () => {
		const { containers, networks } = daemon();
		const runner = new FakeDaemonRunner(OPTIONS, containers, networks, false);
		await runner.reapDeadOwners(alive);
		expect(runner.removed.sort()).toEqual(["mine-dead", "net-mine-dead"]);
	});

	it("reaps what a dead host on the old code left on a network with this stack's vault, and nothing else old", async () => {
		const containers = [
			legacy("old-mine", "host-a-gone", "net-old-mine"),
			legacy("old-theirs", "m0-host-a", "net-old-theirs"),
			legacy("old-mine-alive", "host-a-now", "net-old-alive"),
			legacy("old-vault-recreated", "host-a-gone", "net-old-orphan"),
		];
		const networks = [
			legacyNetwork("net-old-mine", "host-a-gone", ["old-mine", VAULT]),
			// Another stack's: its vault, an owner this stack doesn't know.
			legacyNetwork("net-old-theirs", "m0-host-a", ["old-theirs", "harbour-m0-vault-proxy"]),
			// A host on the old code in this stack, still alive (a rolling upgrade).
			legacyNetwork("net-old-alive", "host-a-now", ["old-mine-alive", VAULT]),
			// No vault on it any more: can't tell whose it is.
			legacyNetwork("net-old-orphan", "host-a-gone", ["old-vault-recreated"]),
		];
		for (const honourFilters of [true, false]) {
			const runner = new FakeDaemonRunner(OPTIONS, containers, networks, honourFilters);
			expect(await runner.reapDeadOwners(alive)).toBe(1);
			expect(runner.removed.sort()).toEqual(["net-old-mine", "old-mine"]);
		}
	});

	it("reaps a session's leftovers in its own stack only", async () => {
		const containers = [
			labelled("mine", VAULT, "x", "ses_shared"),
			labelled("mine-other-session", VAULT, "x", "ses_other"),
			labelled("theirs", "harbour-m1sh-vault-proxy", "y", "ses_shared"),
		];
		const networks = [
			{ ...labelled("net-mine", VAULT, "x", "ses_shared") },
			{ ...labelled("net-mine-other-session", VAULT, "x", "ses_other") },
			{ ...labelled("net-theirs", "harbour-m1sh-vault-proxy", "y", "ses_shared") },
		];
		for (const honourFilters of [true, false]) {
			const runner = new FakeDaemonRunner(OPTIONS, containers, networks, honourFilters);
			expect(await runner.reap("ses_shared")).toBe(1);
			expect(runner.removed.sort()).toEqual(["mine", "net-mine"]);
		}
	});

	it("names its stack after its vault container unless given one", () => {
		expect(new FakeDaemonRunner(OPTIONS, [], []).stack).toBe(VAULT);
		expect(new FakeDaemonRunner({ ...OPTIONS, stack: "ci-7" }, [], []).stack).toBe("ci-7");
	});
});
