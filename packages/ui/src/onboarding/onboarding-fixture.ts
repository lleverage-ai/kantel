// The onboarding page's calls on fixtures, for stories, screenshots and tests: the real onboarding service
// (@harbour/onboarding) and the real model providers (@harbour/models/providers) over an in-memory model directory, a
// fake vault and a fake CLIProxyAPI, and a small connections catalogue. Nothing leaves the page.

import {
	type CallContext,
	type CatalogueEntry,
	type ConnectAttempt,
	type Connection,
	HarbourError,
	type ModelConnectors,
} from "@harbour/contracts";
import type { CpaManagement } from "@harbour/models/cpa-management";
import { createMemoryModelConnectors } from "@harbour/models/directory";
import { createModelProviders } from "@harbour/models/providers";
import { createMemoryOnboarding } from "@harbour/onboarding/memory";
import type { OnboardingApi, OnboardingConnectionsApi } from "./onboarding-api.ts";

const ORGANISATION = "org_fixture";
const ADMIN: CallContext = {
	actor: { kind: "human", userId: "usr_admin" },
	organisationId: ORGANISATION,
};
const OPERATOR: CallContext = {
	actor: { kind: "system", component: "fixture" },
	organisationId: ORGANISATION,
};

const svg = (letter: string, colour: string) =>
	`data:image/svg+xml,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="${colour}"/><text x="12" y="16.5" font-family="sans-serif" font-size="12" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text></svg>`,
	)}`;

const entry = (
	id: string,
	name: string,
	description: string,
	colour: string,
	extra: Partial<CatalogueEntry> = {},
): CatalogueEntry => ({
	id,
	version: 1,
	name,
	description,
	icon: svg(name.slice(0, 1), colour),
	docsUrl: `https://docs.example.com/${id}`,
	category: "developer",
	kind: "mcp",
	authTypes: ["oauth2"],
	source: "shipped",
	setup: "ready",
	...extra,
});

export const FIXTURE_CATALOGUE: readonly CatalogueEntry[] = [
	entry("github", "GitHub", "Repositories, issues and pull requests.", "#24292f"),
	entry("linear", "Linear", "Issues, projects and cycles.", "#5e6ad2", { category: "project_management" }),
	entry("notion", "Notion", "Pages and databases in your workspace.", "#191919", { category: "knowledge" }),
	entry("slack", "Slack", "Read and post in the channels you choose.", "#4a154b", { category: "communication" }),
	entry("google-drive", "Google Drive", "Docs, Sheets and files in your Drive.", "#1a73e8", {
		category: "productivity",
	}),
	entry("sentry", "Sentry", "Errors and performance issues.", "#362d59", {
		authTypes: ["bearer"],
		kind: "http",
	}),
	entry("stripe", "Stripe", "Payments, customers and invoices.", "#635bff", {
		category: "payments",
		authTypes: ["bearer"],
		kind: "http",
	}),
	entry("salesforce", "Salesforce", "Accounts, contacts and opportunities.", "#00a1e0", {
		category: "crm",
		setup: "needs_client",
		clientTiers: ["organisation"],
	}),
];

export interface FixtureOptions {
	/** The deployment's own `default` route, as a self-hosted gateway on CLIProxyAPI seeds it. Default none. */
	readonly platformDefault?: boolean;
	/** Whether the deployment can sign in to subscriptions. Default true. */
	readonly subscriptions?: boolean;
	/** Accounts already signed in, by CPA provider. */
	readonly signedIn?: { readonly anthropic?: string; readonly codex?: string };
	/** Whether the Connections API answers. Default true. */
	readonly connections?: boolean;
	/** How long a fake sign-in takes to complete, in polls. Default 2. */
	readonly signInPolls?: number;
}

/** A fake CLIProxyAPI: a sign-in completes after a few polls and adds an account. */
function fakeCpa(options: FixtureOptions): CpaManagement {
	const accounts = new Map<string, string>(
		Object.entries(options.signedIn ?? {}).filter((pair): pair is [string, string] => pair[1] !== undefined),
	);
	const pending = new Map<string, { provider: "anthropic" | "codex"; polls: number }>();
	return {
		async authUrl(provider) {
			const state = `${provider}-${crypto.randomUUID().slice(0, 8)}`;
			pending.set(state, { provider, polls: 0 });
			return { status: "ok", url: `https://example.com/oauth/${provider}?state=${state}`, state };
		},
		async authStatus(state) {
			const found = pending.get(state);
			if (found === undefined) return { status: "error", error: "Unknown sign-in" };
			found.polls += 1;
			if (found.polls < (options.signInPolls ?? 2)) return { status: "wait" };
			accounts.set(found.provider, "you@example.com");
			pending.delete(state);
			return { status: "ok" };
		},
		async submitCallback(_provider, state) {
			const found = pending.get(state);
			if (found !== undefined) found.polls = Number.POSITIVE_INFINITY;
			return { status: "ok" };
		},
		async authFiles() {
			return {
				files: [...accounts.entries()].map(([provider, email]) => ({
					provider: provider === "anthropic" ? "claude" : provider,
					email,
				})),
			};
		},
	};
}

function fakeConnections(): OnboardingConnectionsApi {
	const connections: Connection[] = [];
	const attempts = new Map<string, { attempt: ConnectAttempt; polls: number }>();
	const now = () => Date.now();
	const made = (templateId: string, auth: Connection["auth"]): Connection => ({
		id: `conn-${templateId}`,
		organisationId: ORGANISATION,
		owner: { kind: "user", organisationId: ORGANISATION, userId: "usr_admin" },
		name: templateId,
		templateId,
		templateVersion: 1,
		kind: "mcp",
		auth,
		hosts: [`${templateId}.example.com`],
		scopes: { requested: [], granted: [] },
		usage: { unattended: false, visibility: "private" },
		status: "active",
		credential: { set: true, refreshable: auth === "oauth2" },
		createdBy: ADMIN.actor,
		createdAt: now(),
		updatedAt: now(),
	});
	return {
		async catalogue() {
			return FIXTURE_CATALOGUE;
		},
		async connections() {
			return [...connections];
		},
		async connect(templateId) {
			const attempt: ConnectAttempt = {
				id: `attempt-${templateId}`,
				organisationId: ORGANISATION,
				status: "pending",
				connectUrl: `https://example.com/connect/${templateId}`,
				owner: { kind: "user", organisationId: ORGANISATION, userId: "usr_admin" },
				templateId,
				createdBy: ADMIN.actor,
				createdAt: now(),
				expiresAt: now() + 15 * 60_000,
			};
			attempts.set(attempt.id, { attempt, polls: 0 });
			return attempt;
		},
		async attempt(attemptId) {
			const found = attempts.get(attemptId);
			if (found === undefined) throw new HarbourError("not_found", "No such attempt");
			found.polls += 1;
			if (found.polls < 2) return found.attempt;
			const templateId = found.attempt.templateId ?? "unknown";
			if (!connections.some((connection) => connection.templateId === templateId)) {
				connections.push(made(templateId, "oauth2"));
			}
			return { ...found.attempt, status: "completed", connectionId: `conn-${templateId}` };
		},
		async connectKey(templateId, value) {
			if (value.length < 8) throw new HarbourError("invalid", "That doesn't look like a key");
			const connection = made(templateId, "key");
			connections.push(connection);
			return connection;
		},
	};
}

/** The deployment's CPA connector and `default` route. */
async function seedPlatform(connectors: ModelConnectors) {
	await connectors.putConnector(OPERATOR, {
		id: "cliproxyapi",
		owner: { kind: "platform" },
		preset: "cliproxyapi",
		baseUrl: "http://cpa.internal:8317/v1",
		vaultItemId: "item-cpa",
		catalogue: { refresh: "gateway" },
	});
	await connectors.putRoute(OPERATOR, {
		name: "default",
		owner: { kind: "platform" },
		connectorId: "cliproxyapi",
		modelId: "claude-sonnet-5-5",
	});
}

/** The page's calls over the real onboarding and model provider services, as an organisation admin. */
export function createFixtureOnboardingApi(options: FixtureOptions = {}): OnboardingApi {
	const onboarding = createMemoryOnboarding();
	const connectors = createMemoryModelConnectors();
	const seeded = options.platformDefault === true ? seedPlatform(connectors) : Promise.resolve();
	let items = 0;
	const providers = createModelProviders({
		connectors,
		vault: {
			putItem: async (_ctx, input) => ({
				id: `item-${++items}`,
				owner: input.owner,
				name: input.name,
				hosts: input.hosts,
				injection: input.injection,
				placeholder: `harbour://${input.name}`,
				hasValue: input.value !== undefined,
				valueVersion: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		},
		connectorId: (organisationId, providerId) => `org-${organisationId}-${providerId}`,
		...(options.subscriptions === false ? {} : { subscriptions: fakeCpa(options) }),
	});
	const connections = options.connections === false ? undefined : fakeConnections();
	return {
		get: () => onboarding.get(ADMIN),
		setStep: (step, status) => onboarding.setStep(ADMIN, step, status),
		goTo: (step) => onboarding.goTo(ADMIN, step),
		dismiss: () => onboarding.dismiss(ADMIN),
		modelProviders: async () => {
			await seeded;
			return providers.list(ADMIN);
		},
		connectModelKey: (providerId, input) => providers.connectKey(ADMIN, providerId, input),
		startSignIn: (providerId) => providers.startSignIn(ADMIN, providerId),
		signInStatus: (providerId, signInId) => providers.signInStatus(ADMIN, providerId, signInId),
		finishSignIn: (providerId, signInId, redirectUrl) =>
			providers.finishSignIn(ADMIN, providerId, signInId, redirectUrl),
		disconnectModel: (providerId) => providers.disconnect(ADMIN, providerId),
		...(connections === undefined ? {} : { connections }),
		startSession: async () => ({ sessionId: `ses_${crypto.randomUUID().slice(0, 8)}` }),
	};
}

/** Moves the fixture's onboarding to `step`, as a person who came back to it would find it. */
export async function fixtureAt(api: OnboardingApi, settled: readonly ("models" | "connectors")[]): Promise<void> {
	for (const step of settled) await api.setStep(step, "done");
}
