import { describe, expect, it } from "vitest";
import type { ComputeSource, EgressGrant, ProxySettings, ProxySettingsChange } from "./compute-model.ts";
import { EgressEditor } from "./egress-editor.ts";
import { type EgressOverview, loadEgressOverview, type RuleScope, rulesOf } from "./egress-overview.ts";
import { accountHostProblem, hostProblem } from "./egress-rules.ts";
import { createComputeFixtures, LLEVERAGE } from "./fixtures.ts";

const BACKEND: RuleScope = { kind: "environment", id: "env_backend", name: "backend-dev" };

/** A promise the test settles. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** Sample data, with a hold on environment grant writes and a switch that fails reading environments. */
function harness() {
	const source = createComputeFixtures();
	const sent: (readonly EgressGrant[])[] = [];
	const proxyChanges: ProxySettingsChange[] = [];
	let hold: Promise<void> | undefined;
	let failReads = false;
	const wrapped: ComputeSource = {
		...source,
		environments: {
			...source.environments,
			list: (accountId) =>
				failReads ? Promise.reject(new Error("Kantel can't be reached.")) : source.environments.list(accountId),
			setGrants: async (id, grants) => {
				sent.push(grants);
				if (hold !== undefined) await hold;
				return source.environments.setGrants(id, grants);
			},
		},
		proxy: {
			...source.proxy,
			update: (accountId, change) => {
				proxyChanges.push(change);
				return source.proxy.update(accountId, change);
			},
		},
	};
	const published: EgressOverview[] = [];
	const make = async () =>
		new EgressEditor({
			source: wrapped,
			accountId: LLEVERAGE.id,
			initial: await loadEgressOverview(wrapped, LLEVERAGE.id),
			publish: (overview) => published.push(overview),
		});
	return {
		make,
		sent,
		proxyChanges,
		published,
		holdWrites: () => {
			const gate = deferred();
			hold = gate.promise;
			return () => {
				hold = undefined;
				gate.resolve();
			};
		},
		failReads: (on: boolean) => {
			failReads = on;
		},
	};
}

const backendGrants = (overview: EgressOverview) =>
	overview.environments.find((env) => env.id === "env_backend")?.grants.map((grant) => grant.id) ?? [];

const backendRule = (overview: EgressOverview, grantId: string) => {
	const rule = rulesOf(overview).find((each) => each.grant?.id === grantId);
	if (rule === undefined) throw new Error(`No rule for ${grantId}`);
	return rule;
};

describe("the Egress page's changes", () => {
	it("runs one at a time: a second change while one is saving writes nothing", async () => {
		const h = harness();
		const editor = await h.make();
		const release = h.holdWrites();
		const removing = editor.removeRule(backendRule(editor.current, "grt_gh"));
		expect(editor.running).toBe(backendRule(editor.current, "grt_gh").key);
		const adding = await editor.addRule({ action: "allow", host: "pypi.org", methods: [], paths: [], scope: BACKEND });
		expect(adding).toEqual({ status: "busy" });
		expect(h.sent).toHaveLength(1);
		release();
		expect(await removing).toEqual({ status: "saved" });
		expect(editor.running).toBeUndefined();

		// Then the addition is written from the list without the removed grant: both changes stand.
		expect(await editor.addRule({ action: "allow", host: "pypi.org", methods: [], paths: [], scope: BACKEND })).toEqual(
			{ status: "saved" },
		);
		const grants = editor.current.environments.find((env) => env.id === "env_backend")?.grants ?? [];
		expect(grants.map((grant) => grant.host)).toEqual([
			"api.github.com",
			"registry.npmjs.org",
			"*.example-tracker.io",
			"pypi.org",
		]);
		expect(grants.some((grant) => grant.id === "grt_gh")).toBe(false);
	});

	it("keeps a change Kantel accepted when reading the rest again fails", async () => {
		const h = harness();
		const editor = await h.make();
		h.failReads(true);
		const first = await editor.removeRule(backendRule(editor.current, "grt_gh"));
		expect(first.status).toBe("saved-unrefreshed");
		expect(backendGrants(editor.current)).toEqual(["grt_gh_delete", "grt_npm", "grt_tracker"]);
		expect(h.published.at(-1)).toBe(editor.current);

		// The next change is written from what the first answered, so it doesn't bring grt_gh back.
		await editor.removeRule(backendRule(editor.current, "grt_npm"));
		expect(h.sent.at(-1)?.map((grant) => grant.id)).toEqual(["grt_gh_delete", "grt_tracker"]);
	});

	it("leaves the snapshot as it was when a write fails", async () => {
		const h = harness();
		const editor = await h.make();
		const before = editor.current;
		const failing = new EgressEditor({
			source: {
				...createComputeFixtures(),
				environments: {
					...createComputeFixtures().environments,
					setGrants: () => Promise.reject(new Error("No.")),
				},
			},
			accountId: LLEVERAGE.id,
			initial: before,
			publish: () => {},
		});
		await expect(failing.removeRule(backendRule(before, "grt_gh"))).rejects.toThrow("No.");
		expect(failing.current).toBe(before);
		expect(failing.running).toBeUndefined();
	});

	it("chooses Allowed hosts with its first host in one write, from Nothing", async () => {
		const h = harness();
		const editor = await h.make();
		await editor.updateProxy("policy", { policy: "closed" });
		expect(editor.current.proxy).toMatchObject({ policy: "closed", allow: [] });

		h.proxyChanges.length = 0;
		await editor.choosePolicy("allowlist", "pypi.org");
		expect(h.proxyChanges).toEqual([{ policy: "allowlist", allow: ["pypi.org"] }]);
		expect(editor.current.proxy).toMatchObject({ policy: "allowlist", allow: ["pypi.org"] });
	});

	it("makes a rule allowing a host for every sandbox while closed Allowed hosts, in one write", async () => {
		const h = harness();
		const editor = await h.make();
		await editor.updateProxy("policy", { policy: "closed" });
		h.proxyChanges.length = 0;
		await editor.addRule({ action: "allow", host: "1.1.1.1", methods: [], paths: [], scope: { kind: "account" } });
		expect(h.proxyChanges).toEqual([{ policy: "allowlist", allow: ["1.1.1.1"] }]);
		expect(editor.current.proxy).toMatchObject({ policy: "allowlist", allow: ["1.1.1.1"] });
	});

	it("reads Allowed hosts with no host as Nothing, as Kantel's API does", async () => {
		const editor = await harness().make();
		for (const rule of rulesOf(editor.current).filter(
			(each) => each.scope.kind === "account" && each.action === "allow",
		)) {
			await editor.removeRule(rule);
		}
		expect(editor.current.proxy).toMatchObject({ policy: "closed", allow: [] });
	});

	it("shows the policy the write answered with, not the one asked for", async () => {
		const source = createComputeFixtures();
		// As Kantel's API reads it with no host allowed for every sandbox.
		const asApi = (next: ProxySettings): ProxySettings =>
			next.allow.length === 0 && next.policy === "allowlist" ? { ...next, policy: "closed" } : next;
		const initial = await loadEgressOverview(source, LLEVERAGE.id);
		const editor = new EgressEditor({
			source: {
				...source,
				// The read after the write fails: the write's own answer is what the page shows.
				environments: { ...source.environments, list: () => Promise.reject(new Error("down")) },
				proxy: {
					get: async (accountId) => asApi(await source.proxy.get(accountId)),
					update: async (accountId, change) => asApi(await source.proxy.update(accountId, change)),
				},
			},
			accountId: LLEVERAGE.id,
			initial,
			publish: () => {},
		});
		expect((await editor.updateProxy("allow", { allow: [] })).status).toBe("saved-unrefreshed");
		expect(editor.current.proxy.policy).toBe("closed");
	});
});

describe("hosts for the account's lists", () => {
	it("takes an IPv4 address there, and only there", () => {
		expect(accountHostProblem("1.1.1.1")).toBeUndefined();
		expect(accountHostProblem("203.0.113.9")).toBeUndefined();
		expect(accountHostProblem("api.github.com")).toBeUndefined();
		expect(accountHostProblem("*.example.com")).toBeUndefined();
		expect(accountHostProblem("https://1.1.1.1")).toBeDefined();
		expect(accountHostProblem("1.1.1.1/32")).toBeDefined();
		expect(accountHostProblem("256.1.1.1")).toBeDefined();
		// Grants and bindings keep names only.
		expect(hostProblem("1.1.1.1")).toBeDefined();
	});
});
