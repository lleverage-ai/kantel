import {
	type CallContext,
	HarbourError,
	MODEL_PROVIDER_IDS,
	type ModelConnectors,
	type ModelProvider,
	type ModelProviderId,
	systemContext,
	type Vault,
	type VaultItem,
} from "@harbour/contracts";
import type { CpaAuthFile, CpaAuthStatus, CpaManagement } from "@harbour/models/cpa-management";
import { createMemoryModelConnectors } from "@harbour/models/directory";
import {
	createMemoryModelProviderStore,
	createModelProviders,
	type ModelProvidersOptions,
	replayModelProviders,
	SUBSCRIPTIONS_UNAVAILABLE,
} from "@harbour/models/providers";
import {
	actors,
	assertAccessDenied,
	CANARY_SECRET,
	containsCanary,
	contextFor,
	createDeps,
	createExpectAssertions,
} from "@harbour/testing/harness";
import { describe, expect, it } from "vitest";

const ORG = "org-a";
const OTHER_ORG = "org-b";
const PROJECT = "proj-a";
const operator = contextFor(actors.system("operator"), ORG);
const admin = contextFor(actors.human("admin-a"), ORG);
const viewer = contextFor(actors.human("viewer-a"), ORG);
const agent = contextFor(actors.agent("agent-1", "sess-1"), ORG, PROJECT);
const otherAdmin = contextFor(actors.human("admin-b"), OTHER_ORG);
const orgOwner = { kind: "organisation", organisationId: ORG } as const;

/** A key holding the canary, so any leak of it shows. */
const KEY = `sk-ant-${CANARY_SECRET}`;

type PutItemInput = Parameters<Vault["putItem"]>[1];

/** A vault that records each `putItem` and answers with an item, never storing anything. */
function fakeVault() {
	const calls: { readonly ctx: CallContext; readonly input: PutItemInput }[] = [];
	const vault: Pick<Vault, "putItem"> = {
		async putItem(ctx, input) {
			calls.push({ ctx, input });
			const item: VaultItem = {
				id: `item-${calls.length}`,
				owner: input.owner,
				name: input.name,
				...(input.description === undefined ? {} : { description: input.description }),
				hosts: [...input.hosts],
				injection: input.injection,
				placeholder: `harbour://${input.name}/0`,
				hasValue: input.value !== undefined,
				valueVersion: 1,
				createdAt: 1,
				updatedAt: 1,
			};
			return item;
		},
	};
	return { vault, calls };
}

/** CPA's management API, faked: each sign-in's state is `st-<provider>`, and waits until a test settles it. */
function fakeCpa() {
	const calls: string[] = [];
	const statuses = new Map<string, CpaAuthStatus>();
	const files: CpaAuthFile[] = [];
	const cpa: CpaManagement = {
		async authUrl(provider) {
			calls.push(`authUrl:${provider}`);
			return { status: "ok", url: `https://${provider}.example/oauth?state=st-${provider}`, state: `st-${provider}` };
		},
		async authStatus(state) {
			calls.push(`authStatus:${state}`);
			return statuses.get(state) ?? { status: "wait" };
		},
		async submitCallback(provider, state, redirectUrl) {
			calls.push(`callback:${provider}:${state}:${redirectUrl}`);
			return { status: "ok" };
		},
		async authFiles() {
			return { files: [...files] };
		},
	};
	return { cpa, calls, statuses, files };
}

function setup(extra: Partial<ModelProvidersOptions> = {}) {
	const deps = createDeps();
	deps.tenancy.bind(actors.human("admin-a"), ORG, "admin");
	deps.tenancy.bind(actors.human("viewer-a"), ORG, "viewer");
	deps.tenancy.bind(actors.human("admin-b"), OTHER_ORG, "admin");
	deps.tenancy.session({ id: "sess-1", organisationId: ORG, projectId: PROJECT, agentId: "agent-1" });
	const connectors = createMemoryModelConnectors({ clock: deps.clock, audit: deps.audit, access: deps.access });
	const { vault, calls } = fakeVault();
	const store = createMemoryModelProviderStore();
	const providers = createModelProviders({
		connectors,
		vault,
		access: deps.access,
		audit: deps.audit,
		clock: deps.clock,
		store,
		...extra,
	});
	return { deps, connectors, vaultCalls: calls, store, providers, a: createExpectAssertions(expect) };
}

/** The deployment's CPA connector and its `default` route, as a self-hosted gateway seeds them. */
async function seedPlatform(connectors: ModelConnectors) {
	await connectors.putConnector(operator, {
		id: "sal-cliproxyapi",
		owner: { kind: "platform" },
		preset: "cliproxyapi",
		baseUrl: "http://cpa.internal:8317/v1",
		vaultItemId: "item-cpa",
		catalogue: { refresh: "gateway" },
	});
	await connectors.putRoute(operator, {
		name: "default",
		owner: { kind: "platform" },
		connectorId: "sal-cliproxyapi",
		modelId: "claude-sonnet-5-5",
	});
}

const find = (items: readonly ModelProvider[], id: ModelProviderId) => items.find((item) => item.id === id);

async function organisationRoutes(connectors: ModelConnectors, ctx: CallContext = admin) {
	return (await connectors.listRoutes(ctx)).items
		.filter((route) => route.owner.kind === "organisation")
		.map((route) => [route.name, route.connectorId, route.modelId]);
}

/** Starts `call` after `assertAccessDenied` has counted the audit, since a refusal may be audited synchronously. */
const later = <T>(call: () => Promise<T>) => Promise.resolve().then(call);

async function code(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error instanceof HarbourError ? error.code : String(error);
	}
}

describe("createModelProviders", () => {
	it("lists every provider, subscriptions unavailable without CPA, and the platform's default", async () => {
		const { providers, connectors } = setup();
		expect((await providers.list(viewer)).defaultRoute).toBeUndefined();
		await seedPlatform(connectors);

		const list = await providers.list(viewer);
		expect(list.items.map((item) => item.id)).toEqual([...MODEL_PROVIDER_IDS]);
		expect(find(list.items, "claude")).toEqual({
			id: "claude",
			name: "Claude",
			description: expect.any(String),
			auth: "subscription",
			preset: "cliproxyapi",
			available: false,
			unavailableReason: SUBSCRIPTIONS_UNAVAILABLE,
		});
		expect(find(list.items, "anthropic")).toEqual({
			id: "anthropic",
			name: "Anthropic",
			description: expect.any(String),
			auth: "key",
			preset: "anthropic",
			baseUrl: "https://api.anthropic.com",
			defaultModel: "claude-sonnet-5-5",
			keyUrl: "https://console.anthropic.com/settings/keys",
			keyPrefix: "sk-ant-",
			available: true,
		});
		expect(find(list.items, "openai")).toMatchObject({ baseUrl: "https://api.openai.com/v1", keyPrefix: "sk-" });
		expect(find(list.items, "openrouter")).toMatchObject({
			baseUrl: "https://openrouter.ai/api/v1",
			keyPrefix: "sk-or-",
		});
		expect(find(list.items, "vercel-ai-gateway")).toMatchObject({ baseUrl: "https://ai-gateway.vercel.sh/v1" });
		const compatible = find(list.items, "openai-compatible");
		expect(compatible?.baseUrl).toBeUndefined();
		expect(compatible?.defaultModel).toBeUndefined();
		for (const item of list.items) expect(item.connection).toBeUndefined();
		expect(list.defaultRoute).toEqual({ connectorId: "sal-cliproxyapi", modelId: "claude-sonnet-5-5", owner: "platform" });
	});

	it("connects a key: a vault item on its host, then the organisation's connector and routes", async () => {
		const { providers, connectors, vaultCalls, deps, store } = setup();
		await seedPlatform(connectors);

		const connected = await providers.connectKey(admin, "anthropic", { key: KEY });
		expect(vaultCalls).toHaveLength(1);
		const [put] = vaultCalls;
		expect(put?.ctx).toBe(admin);
		expect(put?.input).toMatchObject({
			owner: orgOwner,
			hosts: ["api.anthropic.com"],
			injection: { header: "x-api-key", template: "{key}" },
			value: KEY,
		});
		expect(put?.input.name).toMatch(/^model-anthropic-[0-9a-f]{6}$/);

		expect(await connectors.getConnector(admin, "org-anthropic")).toMatchObject({
			owner: orgOwner,
			preset: "anthropic",
			baseUrl: "https://api.anthropic.com",
			vaultItemId: "item-1",
			catalogue: { refresh: "gateway" },
		});
		expect(await organisationRoutes(connectors)).toEqual([
			["anthropic", "org-anthropic", "claude-sonnet-5-5"],
			["default", "org-anthropic", "claude-sonnet-5-5"],
		]);
		expect(connected).toMatchObject({
			id: "anthropic",
			available: true,
			connection: {
				connectorId: "org-anthropic",
				routes: ["anthropic", "default"],
				modelId: "claude-sonnet-5-5",
				baseUrl: "https://api.anthropic.com",
				connectedAt: deps.clock.now(),
			},
		});

		const list = await providers.list(viewer);
		expect(find(list.items, "anthropic")?.connection).toEqual(connected.connection);
		// The organisation's own `default` is nearer than the platform's.
		expect(list.defaultRoute).toEqual({
			connectorId: "org-anthropic",
			modelId: "claude-sonnet-5-5",
			owner: "organisation",
		});

		const events = deps.audit.ofType("models.provider.connected");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			source: "models",
			organisationId: ORG,
			actor: admin.actor,
			subject: { kind: "models.provider", id: "anthropic" },
			data: { providerId: "anthropic", connectorId: "org-anthropic", routes: ["anthropic", "default"] },
		});
		const stored = await store.list(ORG);
		expect(stored).toEqual([
			{
				organisationId: ORG,
				providerId: "anthropic",
				connector: {
					id: "org-anthropic",
					owner: orgOwner,
					preset: "anthropic",
					baseUrl: "https://api.anthropic.com",
					vaultItemId: "item-1",
					catalogue: { refresh: "gateway" },
				},
				routes: [
					{ name: "anthropic", owner: orgOwner, connectorId: "org-anthropic", modelId: "claude-sonnet-5-5" },
					{ name: "default", owner: orgOwner, connectorId: "org-anthropic", modelId: "claude-sonnet-5-5" },
				],
			},
		]);
		// The key went to the vault and nowhere else.
		expect(containsCanary(deps.audit.events)).toBe(false);
		expect(containsCanary(connected)).toBe(false);
		expect(containsCanary(list)).toBe(false);
		expect(containsCanary(stored)).toBe(false);
		expect(containsCanary(await connectors.listConnectors(admin))).toBe(false);
	});

	it("puts each preset's key in its header", async () => {
		const { providers, vaultCalls } = setup();
		await providers.connectKey(admin, "openai", { key: "sk-openai-0123456789" });
		await providers.connectKey(admin, "openrouter", { key: "sk-or-0123456789" });
		await providers.connectKey(admin, "vercel-ai-gateway", { key: "vck_0123456789" });
		expect(vaultCalls.map((call) => [call.input.hosts, call.input.injection])).toEqual([
			[["api.openai.com"], { header: "Authorization", template: "Bearer {key}" }],
			[["openrouter.ai"], { header: "Authorization", template: "Bearer {key}" }],
			// Vercel's default model is a Claude one, which goes over Messages with `x-api-key`.
			[["ai-gateway.vercel.sh"], { header: "x-api-key", template: "{key}" }],
		]);
	});

	it("keeps the organisation's default unless asked, and moves it with makeDefault", async () => {
		const { providers, connectors, store } = setup();
		await providers.connectKey(admin, "anthropic", { key: "sk-ant-0123456789" });
		const openai = await providers.connectKey(admin, "openai", { key: "sk-0123456789", model: "gpt-5.6-terra" });
		expect(openai.connection).toMatchObject({ routes: ["openai"], modelId: "gpt-5.6-terra" });
		expect((await providers.list(admin)).defaultRoute).toEqual({
			connectorId: "org-anthropic",
			modelId: "claude-sonnet-5-5",
			owner: "organisation",
		});

		const moved = await providers.connectKey(admin, "openai", { key: "sk-9876543210", makeDefault: true });
		expect(moved.connection).toMatchObject({ routes: ["default", "openai"], modelId: "gpt-5" });
		expect(await organisationRoutes(connectors)).toEqual([
			["anthropic", "org-anthropic", "claude-sonnet-5-5"],
			["default", "org-openai", "gpt-5"],
			["openai", "org-openai", "gpt-5"],
		]);
		const list = await providers.list(admin);
		expect(find(list.items, "anthropic")?.connection?.routes).toEqual(["anthropic"]);
		expect(list.defaultRoute).toEqual({ connectorId: "org-openai", modelId: "gpt-5", owner: "organisation" });
		// The store follows: only OpenAI puts `default` back on a replay.
		const stored = await store.list(ORG);
		expect(stored.map((each) => [each.providerId, each.routes.map((route) => route.name)])).toEqual([
			["anthropic", ["anthropic"]],
			["openai", ["openai", "default"]],
		]);

		// Reconnecting another provider leaves `default` where it is; reconnecting its holder moves its model too.
		await providers.connectKey(admin, "anthropic", { key: "sk-ant-9876543210" });
		await providers.connectKey(admin, "openai", { key: "sk-0123456789", model: "gpt-5.6-terra" });
		expect((await providers.list(admin)).defaultRoute).toEqual({
			connectorId: "org-openai",
			modelId: "gpt-5.6-terra",
			owner: "organisation",
		});
	});

	it("takes another base URL and model, http only to localhost", async () => {
		const { providers, vaultCalls } = setup();
		const local = await providers.connectKey(admin, "openai-compatible", {
			key: "local-key-0123",
			baseUrl: "http://localhost:11434/v1/",
			model: "qwen3-32b",
		});
		expect(local).toMatchObject({
			id: "openai-compatible",
			preset: "openai-compatible",
			connection: { connectorId: "org-openai-compatible", baseUrl: "http://localhost:11434/v1", modelId: "qwen3-32b" },
		});
		expect(vaultCalls.at(-1)?.input).toMatchObject({
			hosts: ["localhost"],
			injection: { header: "Authorization", template: "Bearer {key}" },
		});
		const proxied = await providers.connectKey(admin, "openai", {
			key: "  sk-0123456789\n",
			baseUrl: "https://llm-proxy.example.com/openai/v1",
		});
		expect(proxied.connection).toMatchObject({ baseUrl: "https://llm-proxy.example.com/openai/v1", modelId: "gpt-5" });
		// A pasted key loses the whitespace around it.
		expect(vaultCalls.at(-1)?.input).toMatchObject({ hosts: ["llm-proxy.example.com"], value: "sk-0123456789" });
	});

	it("refuses malformed input as invalid, before anything is stored", async () => {
		const { providers, vaultCalls, deps } = setup();
		const valid = "sk-0123456789";
		const cases: readonly [ModelProviderId, Parameters<typeof providers.connectKey>[2]][] = [
			["claude", { key: valid }],
			["openai-compatible", { key: valid, model: "m" }],
			["openai-compatible", { key: valid, baseUrl: "https://llm.example.com/v1" }],
			["openai", { key: "short" }],
			["openai", { key: `sk ${CANARY_SECRET}` }],
			["openai", { key: "k".repeat(4097) }],
			["openai", { key: valid, baseUrl: "http://api.example.com/v1" }],
			["openai", { key: valid, baseUrl: "ftp://api.example.com/v1" }],
			["openai", { key: valid, baseUrl: "api.example.com" }],
			["openai", { key: valid, baseUrl: "https://user:pass@api.example.com/v1" }],
			["openai", { key: valid, baseUrl: "https://api.example.com/v1?x=1" }],
			["openai", { key: valid, model: "" }],
			["openai", { key: valid, model: "gpt 5" }],
			["openai", { key: valid, model: "default:gpt-5" }],
		];
		for (const [providerId, input] of cases) {
			let caught: unknown;
			try {
				await providers.connectKey(admin, providerId, input);
			} catch (error) {
				caught = error;
			}
			const label = JSON.stringify([providerId, input.baseUrl, input.model]);
			expect(caught instanceof HarbourError ? caught.code : caught, label).toBe("invalid");
			expect(containsCanary(caught instanceof Error ? caught.message : caught)).toBe(false);
		}
		expect(await code(providers.connectKey(admin, "mistral" as ModelProviderId, { key: valid }))).toBe("invalid");
		expect(vaultCalls).toHaveLength(0);
		expect(deps.audit.ofType("models.provider.connected")).toHaveLength(0);
	});

	it("refuses agents, viewers and admins of other organisations, and lets Harbour itself connect", async () => {
		const { providers, connectors, vaultCalls, deps, a } = setup();
		await assertAccessDenied(
			a,
			deps,
			later(() => providers.connectKey(agent, "anthropic", { key: KEY })),
			{ operation: "models.provider.connect" },
		);
		await assertAccessDenied(
			a,
			deps,
			later(() => providers.connectKey(viewer, "anthropic", { key: KEY })),
			{ operation: "models.provider.connect" },
		);
		await assertAccessDenied(
			a,
			deps,
			later(() => providers.disconnect(agent, "anthropic")),
			{ operation: "models.provider.disconnect" },
		);
		await assertAccessDenied(
			a,
			deps,
			later(() => providers.startSignIn(agent, "claude")),
			{ operation: "models.provider.signin" },
		);
		expect(await code(providers.list(agent))).toBe("forbidden");
		expect(vaultCalls).toHaveLength(0);

		// Admin elsewhere is nothing here: another organisation's admin connects for its own organisation only.
		await providers.connectKey(admin, "anthropic", { key: KEY });
		const theirs = await providers.list(otherAdmin);
		expect(find(theirs.items, "anthropic")?.connection).toBeUndefined();
		expect(theirs.defaultRoute).toBeUndefined();

		const system = await providers.connectKey(operator, "openai", { key: "sk-0123456789" });
		expect(system.connection?.connectorId).toBe("org-openai");
		expect((await connectors.getConnector(admin, "org-openai")).owner).toEqual(orgOwner);
	});

	it("refuses an agent without access checks too", async () => {
		const { providers, vaultCalls } = setup({ access: undefined });
		expect(await code(providers.connectKey(agent, "anthropic", { key: KEY }))).toBe("forbidden");
		expect(await code(providers.disconnect(agent, "anthropic"))).toBe("forbidden");
		expect(vaultCalls).toHaveLength(0);
	});

	it("names connectors per organisation when asked, as connector IDs are unique in a directory", async () => {
		const shared = setup();
		await shared.providers.connectKey(admin, "anthropic", { key: KEY });
		// With the default IDs a second organisation's connector would take the first one's ID.
		expect(await code(shared.providers.connectKey(otherAdmin, "anthropic", { key: KEY }))).toBe("conflict");

		const { providers } = setup({ connectorId: (organisationId, providerId) => `${organisationId}-${providerId}` });
		const ours = await providers.connectKey(admin, "anthropic", { key: KEY });
		const theirs = await providers.connectKey(otherAdmin, "anthropic", { key: KEY });
		expect([ours.connection?.connectorId, theirs.connection?.connectorId]).toEqual([
			"org-a-anthropic",
			"org-b-anthropic",
		]);
		expect(find((await providers.list(admin)).items, "anthropic")?.connection?.connectorId).toBe("org-a-anthropic");
	});

	it("marks key providers unavailable where the deployment can't use a key", async () => {
		const off = setup({ keyProviders: false });
		const list = await off.providers.list(admin);
		for (const item of list.items.filter((each) => each.auth === "key")) {
			expect(item.available).toBe(false);
			expect(item.unavailableReason).toMatch(/model gateway/);
		}
		expect(await code(off.providers.connectKey(admin, "openai", { key: "sk-0123456789" }))).toBe("unavailable");
		expect(off.vaultCalls).toHaveLength(0);

		const reasoned = setup({ keyProviders: { reason: "Keys are off on this deployment" } });
		expect(find((await reasoned.providers.list(admin)).items, "openai")?.unavailableReason).toBe(
			"Keys are off on this deployment",
		);
	});

	it("signs in to a subscription through CPA, polls it, and lists the account", async () => {
		const fake = fakeCpa();
		const { providers, connectors, deps } = setup({ subscriptions: fake.cpa });
		await seedPlatform(connectors);
		const before = await providers.list(admin);
		expect(find(before.items, "claude")).toMatchObject({ available: true });
		expect(find(before.items, "claude")?.connection).toBeUndefined();

		const started = await providers.startSignIn(admin, "claude");
		expect(started).toEqual({
			id: "st-anthropic",
			providerId: "claude",
			status: "pending",
			url: "https://anthropic.example/oauth?state=st-anthropic",
		});
		expect(await providers.signInStatus(admin, "claude", started.id)).toEqual({
			id: "st-anthropic",
			providerId: "claude",
			status: "pending",
		});
		fake.statuses.set("st-anthropic", { status: "ok" });
		expect(await providers.signInStatus(admin, "claude", started.id)).toEqual({
			id: "st-anthropic",
			providerId: "claude",
			status: "completed",
		});
		// Polled again: still audited once.
		await providers.signInStatus(admin, "claude", started.id);
		const signIns = deps.audit.ofType("models.provider.signin");
		expect(signIns.map((event) => [event.source, event.data?.signInId, event.data?.status])).toEqual([
			["models", "st-anthropic", "pending"],
			["models", "st-anthropic", "completed"],
		]);
		expect(JSON.stringify(signIns)).not.toContain("oauth?");

		fake.files.push(
			{ type: "claude", email: "tom@example.com", status: "active" },
			{ provider: "codex", email: "off@example.com", disabled: true },
		);
		const after = await providers.list(admin);
		expect(find(after.items, "claude")?.connection).toEqual({
			connectorId: "sal-cliproxyapi",
			routes: ["default"],
			account: "tom@example.com",
		});
		// A disabled credential is no connection.
		expect(find(after.items, "chatgpt")?.connection).toBeUndefined();
	});

	it("finishes a sign-in by hand, reporting a failure, and never audits the address", async () => {
		const fake = fakeCpa();
		const { providers, deps } = setup({ subscriptions: fake.cpa });
		const started = await providers.startSignIn(admin, "chatgpt");
		expect(started.id).toBe("st-codex");
		fake.statuses.set("st-codex", { status: "error", error: "The code expired" });
		const redirect = "http://localhost:1455/auth/callback?code=secret-code-123&state=st-codex";
		expect(await providers.finishSignIn(admin, "chatgpt", started.id, redirect)).toEqual({
			id: "st-codex",
			providerId: "chatgpt",
			status: "failed",
			error: "The code expired",
		});
		expect(fake.calls).toContain(`callback:codex:st-codex:${redirect}`);
		expect(JSON.stringify(deps.audit.events)).not.toContain("secret-code-123");
		expect(deps.audit.ofType("models.provider.signin").map((event) => event.data?.status)).toEqual([
			"pending",
			"failed",
		]);
		expect(await code(providers.finishSignIn(admin, "chatgpt", started.id, "not an address"))).toBe("invalid");
		expect(await code(providers.signInStatus(admin, "chatgpt", ""))).toBe("invalid");
	});

	it("keeps sign-ins to subscriptions, and needs CPA for them", async () => {
		const fake = fakeCpa();
		const { providers } = setup({ subscriptions: fake.cpa });
		expect(await code(providers.startSignIn(admin, "anthropic"))).toBe("invalid");
		expect(await code(providers.signInStatus(admin, "openai", "st"))).toBe("invalid");
		let caught: unknown;
		try {
			await providers.disconnect(admin, "claude");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(HarbourError);
		expect((caught as HarbourError).code).toBe("invalid");
		expect((caught as HarbourError).message).toBe("Sign out of a subscription in CLIProxyAPI");
		expect(fake.calls).toEqual([]);

		const without = setup();
		expect(await code(without.providers.startSignIn(admin, "claude"))).toBe("unavailable");
		expect(await code(without.providers.signInStatus(admin, "chatgpt", "st"))).toBe("unavailable");
		expect(await code(without.providers.startSignIn(admin, "openai"))).toBe("invalid");
	});

	it("reports a subscription on CPA's own connector name, and lists without it when CPA is down", async () => {
		const fake = fakeCpa();
		fake.files.push({ provider: "codex", email: "tom@example.com" });
		const { providers } = setup({ subscriptions: fake.cpa });
		expect(find((await providers.list(admin)).items, "chatgpt")?.connection).toEqual({
			connectorId: "cliproxyapi",
			routes: [],
			account: "tom@example.com",
		});

		const down = setup({
			subscriptions: {
				...fake.cpa,
				authFiles: async () => {
					throw new HarbourError("unavailable", "CLIProxyAPI's management API could not be reached");
				},
			},
		});
		const list = await down.providers.list(admin);
		expect(find(list.items, "chatgpt")).toMatchObject({ available: true });
		expect(find(list.items, "chatgpt")?.connection).toBeUndefined();
	});

	it("disconnects a key provider: its routes, default among them, and its connector", async () => {
		const { providers, connectors, store, deps } = setup();
		await seedPlatform(connectors);
		await providers.connectKey(admin, "anthropic", { key: KEY });
		await providers.connectKey(admin, "openai", { key: "sk-0123456789" });

		await providers.disconnect(admin, "anthropic");
		expect(await code(connectors.getConnector(admin, "org-anthropic"))).toBe("not_found");
		expect(await organisationRoutes(connectors)).toEqual([["openai", "org-openai", "gpt-5"]]);
		const list = await providers.list(admin);
		expect(find(list.items, "anthropic")?.connection).toBeUndefined();
		expect(find(list.items, "openai")?.connection?.routes).toEqual(["openai"]);
		// Back to the platform's `default`.
		expect(list.defaultRoute).toEqual({ connectorId: "sal-cliproxyapi", modelId: "claude-sonnet-5-5", owner: "platform" });
		expect((await store.list(ORG)).map((each) => each.providerId)).toEqual(["openai"]);
		expect(deps.audit.ofType("models.provider.disconnected")).toEqual([
			expect.objectContaining({
				source: "models",
				organisationId: ORG,
				subject: { kind: "models.provider", id: "anthropic" },
				data: { providerId: "anthropic", connectorId: "org-anthropic", routes: ["anthropic", "default"] },
			}),
		]);
		expect(await code(providers.disconnect(admin, "anthropic"))).toBe("not_found");
		expect(await code(providers.disconnect(admin, "openrouter"))).toBe("not_found");
	});

	it("replays stored connections into a fresh directory, as a system caller only", async () => {
		const { providers, store } = setup();
		await providers.connectKey(admin, "anthropic", { key: KEY });
		await providers.connectKey(admin, "openai", { key: "sk-0123456789", makeDefault: true });

		const fresh = createMemoryModelConnectors();
		expect(await code(replayModelProviders(fresh, store, admin))).toBe("forbidden");
		expect(await replayModelProviders(fresh, store, systemContext("models.replay"))).toBe(2);
		const reader = contextFor(actors.system("check"), ORG);
		const replayed = (await fresh.listConnectors(reader)).items;
		expect(replayed.map((connector) => [connector.id, connector.vaultItemId])).toEqual([
			["org-anthropic", "item-1"],
			["org-openai", "item-2"],
		]);
		expect(await organisationRoutes(fresh, reader)).toEqual([
			["anthropic", "org-anthropic", "claude-sonnet-5-5"],
			["default", "org-openai", "gpt-5"],
			["openai", "org-openai", "gpt-5"],
		]);
	});
});
