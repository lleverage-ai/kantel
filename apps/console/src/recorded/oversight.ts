// The vault page's and the audit view's stand-in host, in the page: the @kantel/ui fixtures' in-memory vault, with
// a proposal in every state, writing its audit trail into a store that already holds a month of generated history.
// Swapped for lane 5's decision API and lane 6's audit query API when they land; nothing in src/app changes.

import { createMemoryAuditStore } from "@kantel/audit/memory";
import type { AuditEventInput, AuditStore, CallContext, SystemContext } from "@kantel/contracts";
import type { AuditDirectory, PasskeyCheck } from "@kantel/ui";
import {
	appendHistory,
	choices as historyChoices,
	directory as historyDirectory,
	itemNames,
	storeSource,
} from "@kantel/ui/audit/fixtures";
import { createVaultScenario, people, sessionTitle, VAULT_HOST } from "@kantel/ui/vault/fixtures";
import type { ConsoleAudit, ConsoleVault } from "../api/oversight.ts";
import { connectionRequestPath } from "../app/router.ts";

const DAY = 24 * 60 * 60 * 1000;

export interface RecordedOversight {
	readonly vault: ConsoleVault;
	readonly audit: ConsoleAudit;
	/** The fixture's proposal in each lifecycle state, by state, for tests and screenshots. */
	readonly proposals: Readonly<Record<string, string>>;
}

/**
 * An audit store whose appends wait in a queue until `open`, then go straight through. The vault fixture writes its
 * trail while it is built, but the store orders rows by arrival (`seq`), so the older generated history has to go in
 * first, and it needs the vault's item IDs, which exist only once the fixture is built.
 */
function deferredStore(store: AuditStore) {
	let queue: { ctx: SystemContext; events: readonly AuditEventInput[] }[] | undefined = [];
	const deferred: AuditStore = {
		append: async (ctx, events) => {
			if (queue === undefined) return store.append(ctx, events);
			queue.push({ ctx, events });
		},
		query: (ctx, query, page) => store.query(ctx, query, page),
		get: (ctx, eventId) => store.get(ctx, eventId),
		setRetention: (ctx, retentionMs) => store.setRetention(ctx, retentionMs),
		applyRetention: (ctx) => store.applyRetention(ctx),
	};
	const open = async () => {
		const waiting = queue ?? [];
		queue = undefined;
		for (const { ctx, events } of waiting) await store.append(ctx, events);
	};
	return { deferred, open };
}

/**
 * The stand-in, as of `now`. A passkey is a short pause and a yes: there is no relying party in the page. Sessions in
 * the vault fixture aren't in the console's catalogue, so they show as text, not links.
 */
export async function createRecordedOversight(
	now = Date.now(),
	options: { historyCount?: number; passkey?: PasskeyCheck } = {},
): Promise<RecordedOversight> {
	const store = createMemoryAuditStore();
	const { deferred, open } = deferredStore(store);
	const scenario = await createVaultScenario({ base: now, live: true, audit: deferred, sessionHref: () => undefined });
	const viewer = people.tom;
	const ctx: CallContext = scenario.ctxFor(viewer);

	// The vault's items by name, so the history's uses of the "Linear API key" are uses of the vault's.
	const items = (await scenario.vault.listItems(ctx)).items;
	const byName = new Map(items.map((item) => [item.name, item.id]));
	const itemIds = Object.fromEntries(
		Object.entries(itemNames).flatMap(([fixtureId, name]) => {
			const id = byName.get(name);
			return id === undefined ? [] : [[fixtureId, id]];
		}),
	);
	// The history ends where the vault fixture's two days begin, so the log reads in time order.
	await appendHistory(store, options.historyCount ?? 4000, now - 2 * DAY - 60_000, itemIds);
	await open();

	const proposals = new Set(Object.values(scenario.proposals));
	const itemName = new Map(items.map((item) => [item.id, item.name]));
	const directory: AuditDirectory = {
		...historyDirectory,
		item: (itemId) => itemName.get(itemId) ?? historyDirectory.item?.(itemId),
		session: (sessionId) => sessionTitle(sessionId) ?? historyDirectory.session?.(sessionId),
	};
	const credentials = [
		...items.map((item) => ({ value: item.id, label: item.name })),
		...historyChoices.credentials.filter((choice) => !byName.has(choice.label)),
	];

	const passkey: PasskeyCheck =
		options.passkey ?? (() => new Promise((resolve) => setTimeout(() => resolve("confirmed"), 400)));

	return {
		proposals: scenario.proposals,
		vault: {
			host: VAULT_HOST,
			viewer,
			request: (proposalId) => scenario.load(proposalId, viewer),
			grants: () => scenario.grants(viewer),
			decide: async (input) => {
				const decision = await scenario.vault.decide(ctx, input);
				scenario.decisions.set(decision.id, decision);
				return decision;
			},
			stop: (grantId) =>
				scenario.vault.revokeGrant(ctx, grantId, "Stopped on the connection request page").then(() => undefined),
			passkey,
		},
		audit: {
			source: storeSource(store, ctx),
			directory,
			links: {
				// Only the vault fixture's requests open; the generated history's are made up.
				proposal: (proposalId) => (proposals.has(proposalId) ? connectionRequestPath(proposalId) : undefined),
			},
			choices: { ...historyChoices, credentials },
			pollMs: 10_000,
		},
	};
}
