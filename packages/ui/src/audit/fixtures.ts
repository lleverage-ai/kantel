// The audit view's fixtures: an in-memory audit store (from @kantel/audit) filled with a generated, repeatable log of
// sessions, tool calls, vault requests, decisions, credential uses, policy changes, sandbox escalations and refused
// access, spread over the 30 days before FIXTURE_NOW. It holds one known story to look up: yesterday,
// three sessions used the Linear API key under grants Tom and Alex approved. Not exported from the library.

import { createMemoryAuditStore } from "@kantel/audit/memory";
import {
	type Actor,
	type AuditEventInput,
	type AuditStore,
	type CallContext,
	currentAuditType,
	type JsonValue,
	systemContext,
} from "@kantel/contracts";
import { DAY } from "../primitives/format.ts";
import { FIXTURE_NOW } from "../session/fixtures.ts";
import type { AuditDirectory, AuditLinks, AuditSource } from "./audit-model.ts";

export { FIXTURE_NOW };

/** How long before the log's end the store's audit types took their Connections names (#324). */
export const RENAMED_DAYS_AGO = 7;

export const ORGANISATION = "org_kantel";
/** A second organisation Tom belongs to, with a smaller log of its own, for the organisation filter. */
export const SECOND_ORGANISATION = "org_kantel_labs";

const people: Record<string, string> = {
	usr_tom: "Tom Davies",
	usr_alex: "Alex Rivera",
	usr_dean: "Dean Okafor",
	usr_priya: "Priya Natarajan",
};
const projects: Record<string, string> = {
	prj_billing: "Billing",
	prj_platform: "Platform",
	prj_web: "Website",
	prj_data: "Data",
};
const agents: Record<string, { name: string; projectId: string }> = {
	agt_billing: { name: "Billing agent", projectId: "prj_billing" },
	agt_release: { name: "Release agent", projectId: "prj_platform" },
	agt_ops: { name: "Ops worker", projectId: "prj_platform" },
	agt_web: { name: "Website editor", projectId: "prj_web" },
	agt_etl: { name: "ETL runner", projectId: "prj_data" },
};
const items: Record<string, { name: string; host: string; paths: string[] }> = {
	itm_linear: { name: "Linear API key", host: "api.linear.app", paths: ["/graphql"] },
	itm_github: {
		name: "GitHub token",
		host: "api.github.com",
		paths: ["/repos/kantel-dev/kantel/pulls", "/repos/kantel-dev/kantel/issues"],
	},
	itm_sentry: { name: "Sentry auth token", host: "sentry.io", paths: ["/api/0/projects/kantel/billing/issues/"] },
	itm_staging: { name: "Staging admin key", host: "admin.staging.kantel.dev", paths: ["/jobs", "/jobs/retry"] },
	itm_stripe: { name: "Stripe test key", host: "api.stripe.com", paths: ["/v1/invoices", "/v1/customers"] },
	itm_slack: { name: "Slack bot token", host: "slack.com", paths: ["/api/chat.postMessage"] },
};

const sessionTitles = [
	"Overnight sweep: file the failed invoice bugs",
	"Release notes for 0.4",
	"Retry the stuck staging jobs",
	"Fix the pricing page typo",
	"Backfill last week's events table",
	"Triage the Sentry spike",
	"Draft the incident write-up",
	"Rotate the staging admin key",
	"Weekly dependency bumps",
	"Reconcile Stripe test invoices",
];

/** Session IDs to names, filled as the generator makes sessions. */
const sessions = new Map<string, string>();

/** The three sessions in yesterday's known story, and the grants their uses went through. */
export const yesterday = {
	sessions: ["ses_sweep_y", "ses_release_y", "ses_triage_y"],
	itemId: "itm_linear",
} as const;

/** A small, fast, seeded generator, so every run makes the same log. */
function random(seed: number) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		int: (below: number) => Math.floor(next() * below),
		pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!,
	};
}

const human = (userId: string): Actor => ({ kind: "human", userId });

/**
 * Generates `count` events, oldest first, ending just before `end`. Sessions are the unit: each is created, prompted,
 * runs tools, and some ask the vault for a credential, get it approved or denied, and use it. The known story for
 * yesterday is written in among them.
 */
export function generateEvents(count: number, end = FIXTURE_NOW, seed = 7): AuditEventInput[] {
	const rand = random(seed);
	const events: AuditEventInput[] = [];
	let serial = 0;
	const id = (kind: string) => {
		serial += 1;
		return `fx:${kind}:${serial}`;
	};
	const span = 30 * DAY;
	const start = end - span;
	// Each event's time follows its place in the log, with some jitter, so `count` events fill the span evenly and
	// the time only moves forward. `scale` shortens the jitter for events that follow closely on the last.
	const gap = span / count;
	let at = start;
	const tick = (scale = 1) => {
		at = Math.max(at + 1 + Math.round(gap * scale * rand.next() * 0.5), start + Math.round(gap * events.length));
		return at;
	};
	const base = (agentId: string, sessionId: string) => ({
		organisationId: ORGANISATION,
		projectId: agents[agentId]!.projectId,
		agentId,
		sessionId,
	});
	const agentActor = (agentId: string, sessionId: string): Actor => ({ kind: "agent", agentId, sessionId });
	const routeOf = (itemId: string, methods: string[]): JsonValue => ({
		host: items[itemId]!.host,
		methods,
		pathPrefix: items[itemId]!.paths[0]!,
	});

	/** One session's events, from creation to settling. */
	const session = (
		sessionId: string,
		agentId: string,
		person: string,
		uses: { itemId: string; approver: string; count: number } | undefined,
		title = rand.pick(sessionTitles),
	) => {
		sessions.set(sessionId, title);
		const ctx = base(agentId, sessionId);
		const agent = agentActor(agentId, sessionId);
		events.push({
			id: id("session"),
			at: tick(),
			source: "session",
			type: "session.created",
			actor: human(person),
			...ctx,
			subject: { kind: "session", id: sessionId },
		});
		const submission = `sub_${serial}`;
		events.push({
			id: id("prompt"),
			at: tick(0.3),
			source: "session",
			type: "session.prompted",
			actor: human(person),
			...ctx,
			subject: { kind: "session.submission", id: submission },
			data: { via: "prompt" },
		});
		const tools = 1 + rand.int(4);
		for (let index = 0; index < tools; index += 1) {
			const call = `call_${serial}`;
			const tool = rand.pick(["read", "edit", "bash", "grep", "write"]);
			events.push({
				id: id("tool"),
				at: tick(0.2),
				source: "session",
				type: "session.tool.started",
				actor: agent,
				...ctx,
				subject: { kind: "session.tool", id: call },
				data: { hostId: "host_1", tool },
			});
			events.push({
				id: id("tool"),
				at: tick(0.2),
				source: "session",
				type: "session.tool.finished",
				actor: agent,
				...ctx,
				subject: { kind: "session.tool", id: call },
				data: { hostId: "host_1", tool, outcome: rand.next() < 0.08 ? "error" : "ok" },
			});
		}
		if (uses !== undefined) {
			const proposalId = `proposal_${serial}`;
			const grantId = `grant_${serial}`;
			const methods = rand.next() < 0.5 ? ["POST"] : ["GET"];
			events.push({
				id: id("proposal"),
				at: tick(0.3),
				source: "vault",
				type: "vault.proposal.created",
				actor: agent,
				...ctx,
				subject: { kind: "vault.proposal", id: proposalId },
				data: {
					kind: methods[0] === "GET" ? "read" : "write",
					itemId: uses.itemId,
					route: routeOf(uses.itemId, methods),
				},
			});
			if (uses.count === 0) {
				events.push({
					id: id("decision"),
					at: tick(0.5),
					source: "vault",
					type: "vault.decision.denied",
					actor: human(uses.approver),
					...ctx,
					subject: { kind: "vault.proposal", id: proposalId },
				});
			} else {
				if (rand.next() < 0.05)
					events.push({
						id: id("mismatch"),
						at: tick(0.3),
						source: "vault",
						type: "vault.binding_code.mismatch",
						actor: human(uses.approver),
						...ctx,
						subject: { kind: "vault.proposal", id: proposalId },
						data: { kind: "write", pickedCode: "K3T-9QX" },
					});
				events.push({
					id: id("decision"),
					at: tick(0.5),
					source: "vault",
					type: "vault.decision.approved",
					actor: human(uses.approver),
					...ctx,
					subject: { kind: "vault.proposal", id: proposalId },
					data: { kind: "write", itemId: uses.itemId, grantId, route: routeOf(uses.itemId, methods) },
				});
				for (let use = 0; use < uses.count; use += 1) {
					const path = rand.pick(items[uses.itemId]!.paths);
					events.push({
						id: id("use"),
						at: tick(0.15),
						source: "vault",
						type: "vault.use.injected",
						actor: agent,
						...ctx,
						subject: { kind: "vault.use", id: `use_${serial}` },
						data: { method: methods[0]!, host: items[uses.itemId]!.host, path, itemId: uses.itemId, grantId },
					});
				}
				if (rand.next() < 0.1) {
					events.push({
						id: id("use"),
						at: tick(0.15),
						source: "vault",
						type: "vault.use.denied",
						actor: agent,
						...ctx,
						subject: { kind: "vault.use", id: `use_${serial}` },
						data: {
							method: "DELETE",
							host: items[uses.itemId]!.host,
							path: items[uses.itemId]!.paths[0]!,
							itemId: uses.itemId,
							grantId,
							reason: "Method not in the grant",
						},
					});
				}
			}
		}
		if (rand.next() < 0.03)
			events.push({
				id: id("sandbox"),
				at: tick(0.3),
				source: "sandbox",
				type: "sandbox.escalated",
				actor: agent,
				...ctx,
				subject: { kind: "sandbox.lease", id: `lease_${serial}` },
				data: { reason: "Needs network access to the package registry" },
			});
		events.push({
			id: id("settled"),
			at: tick(0.3),
			source: "session",
			type: rand.next() < 0.04 ? "session.aborted" : "session.settled",
			actor: { kind: "system", component: "runtime" },
			...ctx,
			subject: { kind: "session", id: sessionId },
		});
	};

	const agentIds = Object.keys(agents);
	const itemIds = Object.keys(items);
	const userIds = Object.keys(people);
	// Yesterday's known story goes in when the clock first passes 08:00 UTC the day before `end`.
	const storyAt = Date.UTC(
		new Date(end).getUTCFullYear(),
		new Date(end).getUTCMonth(),
		new Date(end).getUTCDate() - 1,
		8,
	);
	let told = false;
	let sessionSerial = 0;

	// Items and a policy at the start, as an admin would set them up.
	for (const itemId of itemIds)
		events.push({
			id: id("item"),
			at: tick(0.1),
			source: "vault",
			type: "vault.item.created",
			actor: human("usr_tom"),
			organisationId: ORGANISATION,
			subject: { kind: "vault.item", id: itemId },
			// As the vault writes it: the item's name and hosts, never its value.
			data: { name: items[itemId]?.name ?? itemId, hosts: [items[itemId]?.host ?? ""], hasValue: true },
		});
	events.push({
		id: id("policy"),
		at: tick(0.1),
		source: "vault",
		type: "vault.policy.created",
		actor: human("usr_tom"),
		organisationId: ORGANISATION,
		projectId: "prj_data",
		subject: { kind: "vault.policy", id: "policy_etl_read" },
		data: { itemId: "itm_stripe" },
	});

	while (events.length < count) {
		if (!told && at >= storyAt) {
			told = true;
			// Three sessions on the Linear key: two approved by Tom, one by Alex.
			session(
				"ses_sweep_y",
				"agt_billing",
				"usr_tom",
				{ itemId: "itm_linear", approver: "usr_tom", count: 9 },
				"Overnight sweep: file the failed invoice bugs",
			);
			session(
				"ses_release_y",
				"agt_release",
				"usr_alex",
				{ itemId: "itm_linear", approver: "usr_alex", count: 4 },
				"Release notes for 0.4",
			);
			session(
				"ses_triage_y",
				"agt_ops",
				"usr_priya",
				{ itemId: "itm_linear", approver: "usr_tom", count: 2 },
				"Triage the Sentry spike",
			);
			continue;
		}
		const roll = rand.next();
		if (roll < 0.015) {
			const person = rand.pick(userIds);
			events.push({
				id: id("access"),
				at: tick(),
				source: "access",
				type: "access.denied",
				actor: human(person),
				organisationId: ORGANISATION,
				projectId: rand.pick(Object.keys(projects)),
				data: { operation: rand.pick(["vault.decide", "audit.query", "session.prompt"]) },
			});
			continue;
		}
		if (roll < 0.02) {
			const userId = rand.pick(userIds);
			events.push({
				id: id("role"),
				at: tick(),
				source: "identity",
				type: rand.next() < 0.7 ? "identity.role.granted" : "identity.role.revoked",
				actor: human("usr_tom"),
				organisationId: ORGANISATION,
				subject: { kind: "identity.user", id: userId },
				data: { role: rand.pick(["viewer", "operator"]) },
			});
			continue;
		}
		if (roll < 0.022) {
			events.push({
				id: id("grant"),
				at: tick(),
				source: "vault",
				type: "vault.grant.revoked",
				actor: { kind: "system", component: "vault" },
				organisationId: ORGANISATION,
				subject: { kind: "vault.grant", id: `grant_${serial - 50}` },
				data: { reason: "expired" },
			});
			continue;
		}
		const agentId = rand.pick(agentIds);
		const usesCredential = rand.next() < 0.3;
		// Outside yesterday's story, the Linear key is used rarely, so the story stands out but isn't alone.
		const itemId = rand.pick(itemIds.filter((item) => item !== "itm_linear" || rand.next() < 0.15));
		sessionSerial += 1;
		session(
			`ses_${sessionSerial.toString(36)}`,
			agentId,
			rand.pick(userIds),
			usesCredential
				? {
						itemId,
						approver: rand.pick(["usr_tom", "usr_alex", "usr_tom"]),
						count: rand.next() < 0.1 ? 0 : 1 + rand.int(6),
					}
				: undefined,
		);
	}
	// Keep the log inside the span: anything the generator pushed past `end` goes. The store's events were renamed
	// from `vault.*` to `connections.*` (#324) a week before `end`: older rows keep the type they were stored with, as
	// a real log does, so the view shows both together.
	const renamedAt = end - RENAMED_DAYS_AGO * DAY;
	return events
		.filter((event) => event.at < end)
		.slice(0, count)
		.map((event) => (event.at < renamedAt ? event : { ...event, type: currentAuditType(event.type) }));
}

export const directory: AuditDirectory = {
	person: (userId) => people[userId],
	agent: (agentId) => agents[agentId]?.name,
	session: (sessionId) => sessions.get(sessionId),
	project: (projectId) => projects[projectId],
	item: (itemId) => items[itemId]?.name,
};

export const links: AuditLinks = {
	session: (sessionId, turn) => `#/sessions/${sessionId}${turn === undefined ? "" : `?turn=${turn}`}`,
	proposal: (proposalId) => `https://vault.kantel.dev/proposals/${proposalId}`,
};

/** The view's choices for each filter, from the fixture's tables. */
export const choices = {
	organisations: [
		{ value: ORGANISATION, label: "Kantel" },
		{ value: SECOND_ORGANISATION, label: "Kantel Labs" },
	],
	actors: [
		...Object.entries(people).map(([userId, name]) => ({ value: `human:${userId}`, label: name })),
		{ value: "system:runtime", label: "Kantel runtime" },
		{ value: "system:vault", label: "Kantel vault" },
	],
	projects: Object.entries(projects).map(([value, label]) => ({ value, label })),
	agents: Object.entries(agents).map(([value, agent]) => ({ value, label: agent.name })),
	credentials: Object.entries(items).map(([value, item]) => ({ value, label: item.name })),
};

export interface AuditScenario {
	readonly store: AuditStore;
	readonly ctx: CallContext;
	readonly source: AuditSource;
	readonly count: number;
}

const viewer: CallContext = { actor: { kind: "human", userId: "usr_tom" }, organisationId: ORGANISATION };

/** The fixture's credentials by name, for a host stand-in that maps them onto a real vault's items. */
export const itemNames: Readonly<Record<string, string>> = Object.fromEntries(
	Object.entries(items).map(([itemId, item]) => [itemId, item.name]),
);

/** The event with its vault item ID replaced through `itemIds`, wherever the event names one. */
function remapItem(event: AuditEventInput, itemIds: Readonly<Record<string, string>>): AuditEventInput {
	const itemId = event.data?.itemId;
	const mappedData = typeof itemId === "string" && itemIds[itemId] !== undefined;
	const mappedSubject = event.subject?.kind === "vault.item" && itemIds[event.subject.id] !== undefined;
	if (!mappedData && !mappedSubject) return event;
	return {
		...event,
		...(mappedData ? { data: { ...event.data, itemId: itemIds[itemId as string]! } } : {}),
		...(mappedSubject ? { subject: { kind: "vault.item", id: itemIds[event.subject!.id]! } } : {}),
	};
}

/**
 * Appends `count` generated events ending at `end` to `store`, then the second organisation's smaller log. A host
 * stand-in can fill a store with this history before its own components start writing to it; `itemIds` maps the
 * fixture's item IDs onto that host's, so a credential filter finds both.
 */
export async function appendHistory(
	store: AuditStore,
	count: number,
	end = FIXTURE_NOW,
	itemIds: Readonly<Record<string, string>> = {},
): Promise<number> {
	const events = generateEvents(count, end).map((event) => remapItem(event, itemIds));
	for (let index = 0; index < events.length; index += 5000) {
		await store.append(systemContext("fixture"), events.slice(index, index + 5000));
	}
	// The second organisation's log: a tenth the size, from another seed, so its rows differ from the first's. Its
	// items are remapped too, as the view's credential choices are shared between the two.
	const labs = generateEvents(Math.max(50, Math.round(count / 10)), end, 11).map((event) => ({
		...remapItem(event, itemIds),
		organisationId: SECOND_ORGANISATION,
	}));
	await store.append(systemContext("fixture"), labs);
	return events.length;
}

/** A source reading `store` as `viewer`, bound to the organisation each query names, as a host's would be. */
export function storeSource(store: AuditStore, viewer: CallContext): AuditSource {
	return {
		query(query, page) {
			// The store takes the organisation from the context, never the query.
			const { organisationId, ...rest } = query;
			return store.query(organisationId === undefined ? viewer : { ...viewer, organisationId }, rest, page);
		},
	};
}

/** A store holding `count` generated events, and a source reading it as Tom. */
export async function createAuditScenario(
	count = 4000,
	options: { latencyMs?: number; failAfter?: number } = {},
): Promise<AuditScenario> {
	const store = createMemoryAuditStore({ clock: { now: () => FIXTURE_NOW } });
	const appended = await appendHistory(store, count);
	const read = storeSource(store, viewer);
	let calls = 0;
	const source: AuditSource = {
		async query(query, page) {
			calls += 1;
			if (options.failAfter !== undefined && calls > options.failAfter)
				throw new Error("The audit store is unreachable");
			if (options.latencyMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
			return read.query(query, page);
		},
	};
	return { store, ctx: viewer, source, count: appended };
}

/** A source that never answers, for the loading state. */
export const pendingSource: AuditSource = { query: () => new Promise(() => {}) };
/** A source that always fails, for the error state. */
export const failingSource: AuditSource = { query: async () => Promise.reject(new Error("unreachable")) };
/** A source with no events, for the empty state. */
export const emptySource: AuditSource = { query: async () => ({ items: [] }) };
