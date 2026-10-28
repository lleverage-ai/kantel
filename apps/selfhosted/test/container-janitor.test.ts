// The container tier's janitor on a Docker daemon several stacks share: it removes only its own stack's leftovers.
// Another stack's hosts are not in this stack's database, so to this one they all look dead; before the stack label,
// each stack's hosts removed every other stack's sandboxes every 10 seconds.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
	/** Each list call, as `<path> <filter, joined with ",">`, in order. */
	readonly lists: string[] = [];
	/** The labels each network and container was created with. */
	readonly created: { readonly kind: "network" | "container"; readonly labels: Record<string, string> }[] = [];
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
		if (init.method === "POST" && parts[0] === "networks" && (parts[2] === "disconnect" || parts[2] === "connect")) {
			return new Response(null, { status: 200 });
		}
		if (init.method === "POST" && (path === "/networks/create" || path === "/containers/create")) {
			const body = (init as { json?: { Labels: Record<string, string> } }).json!;
			const kind = path === "/networks/create" ? "network" : "container";
			this.created.push({ kind, labels: body.Labels });
			if (kind === "network") this.networks.push({ Id: "network-new", Labels: body.Labels, members: [VAULT] });
			return Response.json({ Id: `${kind}-new` });
		}
		if (url.pathname === "/containers/json" || url.pathname === "/networks") {
			const filter = (JSON.parse(url.searchParams.get("filters") ?? "{}") as { label?: string[] }).label ?? [];
			this.filters.push(filter);
			this.lists.push(`${url.pathname} ${filter.join(",")}`);
			const objects: { Labels: Record<string, string> }[] =
				url.pathname === "/networks" ? this.networks : this.containers;
			return Response.json(this.honourFilters ? objects.filter((object) => matches(object.Labels, filter)) : objects);
		}
		if (parts[0] === "networks" && parts.length === 2) {
			const network = this.networks.find((candidate) => candidate.Id === parts[1]);
			const members = Object.fromEntries(
				(network?.members ?? []).map((name, i) => [`c${i}`, { Name: name, IPv4Address: `10.0.0.${i + 2}/24` }]),
			);
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
			// This stack's, with no owner: not the janitor's to judge.
			{ Id: "mine-unowned", Labels: { [STACK_LABEL]: VAULT, [SESSION_LABEL]: "ses_1" } },
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

	it("asks Docker for this stack's owned objects, then for old-code networks only", async () => {
		const { containers, networks } = daemon();
		const runner = new FakeDaemonRunner(OPTIONS, containers, networks);
		await runner.reapDeadOwners(alive);
		const mine = `${STACK_LABEL}=${VAULT},${OWNER_LABEL}`;
		// No old-code networks here, so no old-code containers are listed.
		expect(runner.lists).toEqual([`/containers/json ${mine}`, `/networks ${mine}`, `/networks ${LEGACY_OWNER_LABEL}`]);
	});

	it("asks Docker for the session's objects in this stack only", async () => {
		const runner = new FakeDaemonRunner(OPTIONS, [], []);
		await runner.reap("ses_9");
		const ours = `${SESSION_LABEL}=ses_9,${STACK_LABEL}=${VAULT}`;
		expect(runner.lists).toEqual([`/containers/json ${ours}`, `/networks ${ours}`]);
	});

	it("labels the networks and containers it creates with its stack and owner, not the old owner label", async () => {
		const ca = createServer((_request, response) => response.end("not a real CA\n"));
		await new Promise<void>((resolve) => ca.listen(0, "127.0.0.1", resolve));
		try {
			const options = { ...OPTIONS, proxyUrl: `http://127.0.0.1:${(ca.address() as AddressInfo).port}` };
			const runner = new FakeDaemonRunner(options, [], []);
			Object.assign(runner, { pool: { query: async () => ({ rows: [] }) } });
			runner.owner = "host-a-now";
			// The fake daemon refuses the copy-in after create, which ends the command; creation is what this checks.
			await expect(
				runner.exec({ sessionId: "ses_1", workspaceId: "ws_1", command: "true" } as never, {}),
			).rejects.toThrow(/unexpected docker call/);
			expect(runner.created.map((made) => made.kind)).toEqual(["network", "container"]);
			for (const { labels } of runner.created) {
				expect(labels).toMatchObject({
					[STACK_LABEL]: VAULT,
					[OWNER_LABEL]: "host-a-now",
					[SESSION_LABEL]: "ses_1",
				});
				expect(labels).not.toHaveProperty(LEGACY_OWNER_LABEL);
			}
		} finally {
			await new Promise((resolve) => ca.close(resolve));
		}
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
			// On an old network of this stack, but with a stack label: not old code's, so not this path's.
			{
				Id: "stacked-on-old",
				Labels: { [LEGACY_OWNER_LABEL]: "host-a-gone", [STACK_LABEL]: "harbour-ci-1-vault-proxy" },
				HostConfig: { NetworkMode: "net-old-mine" },
			},
		];
		const networks = [
			legacyNetwork("net-old-mine", "host-a-gone", ["old-mine", VAULT]),
			// Another stack's: its vault, an owner this stack doesn't know.
			legacyNetwork("net-old-theirs", "m0-host-a", ["old-theirs", "harbour-m0-vault-proxy"]),
			// A host on the old code in this stack, still alive (a rolling upgrade).
			legacyNetwork("net-old-alive", "host-a-now", ["old-mine-alive", VAULT]),
			// No vault on it any more: can't tell whose it is.
			legacyNetwork("net-old-orphan", "host-a-gone", ["old-vault-recreated"]),
			// With the old owner label and a stack label, this stack's vault on it: still not old code's.
			{
				Id: "net-stacked",
				Labels: { [LEGACY_OWNER_LABEL]: "host-a-gone", [STACK_LABEL]: "harbour-ci-1-vault-proxy" },
				members: [VAULT],
			},
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
