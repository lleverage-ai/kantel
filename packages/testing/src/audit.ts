/**
 * Conformance suite for `AuditStore` and `AuditOutbox` (packages/contracts/src/audit.ts). Every target registers it
 * with a provider that builds a fresh store on the suite's clock, a fresh outbox and a flaky sink in front of the store.
 */
import {
	type Actor,
	type AuditEvent,
	type AuditEventInput,
	type AuditOutbox,
	type AuditQuery,
	type AuditSink,
	type AuditStore,
	type CallContext,
	type JsonValue,
	type Page,
	PLATFORM_ORGANISATION,
	type SystemContext,
} from "@harbour/contracts";
import {
	actors,
	assertAccessDenied,
	CANARY_SECRET,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceOptions,
	type ConformanceRunner,
	containsCanary,
	contextFor,
	createDeps,
	createExpectAssertions,
	nonSystemCallers,
	registerCases,
	WORKER,
} from "./harness.ts";

export interface AuditSubject {
	readonly store: AuditStore;
	readonly outbox: AuditOutbox;
	/** A sink that throws for its first `failTimes` appends, then forwards to `store`. */
	flakySink(store: AuditStore, failTimes: number): AuditSink;
}

export type AuditConformanceProvider = (
	deps: ConformanceDeps,
	use: (subject: AuditSubject) => Promise<void>,
) => Promise<void>;

/** A sink that throws for its first `failTimes` appends, then forwards to `target`. Providers may use it as `flakySink`. */
export function flakyAuditSink(target: AuditSink, failTimes: number): AuditSink {
	let failuresLeft = failTimes;
	return {
		async append(ctx, events) {
			if (failuresLeft > 0) {
				failuresLeft -= 1;
				throw new Error("flaky audit sink: refusing this append");
			}
			await target.append(ctx, events);
		},
	};
}

function jsonHasNeedle(value: JsonValue | undefined, needles: readonly string[]): boolean {
	if (typeof value === "string") return needles.some((needle) => value.includes(needle));
	if (typeof value !== "object" || value === null) return false;
	if (Array.isArray(value)) return value.some((entry: JsonValue) => jsonHasNeedle(entry, needles));
	const record = value as { readonly [key: string]: JsonValue };
	return Object.keys(record).some((key) => jsonHasNeedle(key, needles) || jsonHasNeedle(record[key], needles));
}

/**
 * Whether any string anywhere in the event's `data`, keys included, contains one of `needles`. Other suites use it to
 * check that no audit event carries a secret value; IDs and other fields outside `data` are not searched.
 */
export function findSecret(event: AuditEventInput, needles: readonly string[] = [CANARY_SECRET]): boolean {
	const nonEmpty = needles.filter((needle) => needle.length > 0);
	return nonEmpty.length > 0 && event.data !== undefined && jsonHasNeedle(event.data, nonEmpty);
}

const ORG = "org-a";
const OTHER_ORG = "org-b";
const DAY = 24 * 60 * 60 * 1000;

const admin = contextFor(actors.human("admin-1"), ORG);
const service = contextFor(actors.service("svc-1", "key-1"), ORG);
const system = contextFor(actors.system("audit-retention"), ORG);
const agent = contextFor(actors.agent("agent-1", "session-1"), ORG);
const outsider = contextFor(actors.human("outsider-1"), OTHER_ORG);

const PROJECT = "proj-1";
const OTHER_PROJECT = "proj-2";
/** An operator on another project of the same organisation. */
const stranger = contextFor(actors.human("stranger-1"), ORG, OTHER_PROJECT);
/** A viewer on the project. */
const projectViewer = contextFor(actors.human("viewer-1"), ORG, PROJECT);
/** An admin on the project only, not across the organisation. */
const projectAdmin = contextFor(actors.human("project-admin-1"), ORG, PROJECT);
/** A viewer across the organisation. */
const auditor = contextFor(actors.human("auditor-1"), ORG);
/** An agent whose session belongs to another project. */
const strayAgent = contextFor(actors.agent("agent-2", "session-2"), ORG, OTHER_PROJECT);

/** Records the roles and sessions the cases use, so every call passes `deps.access` where it should. */
function seedTenancy(deps: ConformanceDeps): void {
	deps.tenancy.bind(admin.actor, ORG, "admin");
	deps.tenancy.bind(service.actor, ORG, "admin");
	deps.tenancy.bind(outsider.actor, OTHER_ORG, "admin");
	deps.tenancy.bind(stranger.actor, ORG, "operator", OTHER_PROJECT);
	deps.tenancy.bind(projectViewer.actor, ORG, "viewer", PROJECT);
	deps.tenancy.bind(projectAdmin.actor, ORG, "admin", PROJECT);
	deps.tenancy.bind(auditor.actor, ORG, "viewer");
	deps.tenancy.session({ id: "session-1", organisationId: ORG, projectId: PROJECT, agentId: "agent-1" });
	deps.tenancy.session({ id: "session-2", organisationId: ORG, projectId: OTHER_PROJECT, agentId: "agent-2" });
}

type EventFields = Omit<Partial<AuditEventInput>, "id">;

function auditEvent(id: string, at: number, fields: EventFields = {}): AuditEventInput {
	return {
		id,
		at,
		source: "session",
		type: "session.created",
		actor: actors.human("user-1"),
		organisationId: ORG,
		...fields,
	};
}

/** Rows of two projects and of the organisation, interleaved in `seq` order. */
const projectRows: readonly AuditEventInput[] = [
	auditEvent("p1-a", 1, { projectId: PROJECT, sessionId: "session-1" }),
	auditEvent("p2-a", 2, { projectId: OTHER_PROJECT }),
	auditEvent("org-a", 3),
	auditEvent("p1-b", 4, { projectId: PROJECT }),
	auditEvent("p2-b", 5, { projectId: OTHER_PROJECT }),
	auditEvent("org-b", 6),
	auditEvent("p1-c", 7, { projectId: PROJECT }),
];
const PROJECT_ROW_IDS = projectRows.map((row) => row.id);

function ids(page: Page<AuditEvent>): string[] {
	return page.items.map((event) => event.id);
}

async function queryIds(store: AuditStore, query: AuditQuery, ctx: CallContext = admin): Promise<string[]> {
	return ids(await store.query(ctx, query, { limit: 500 }));
}

/** Every page of a query, following `nextCursor`; `between` runs after each page that has a next one. */
async function allPages(
	store: AuditStore,
	query: AuditQuery,
	limit: number,
	between: (pageIndex: number) => Promise<void> = async () => {},
	ctx: CallContext = admin,
): Promise<{ readonly events: AuditEvent[]; readonly pageSizes: number[] }> {
	const events: AuditEvent[] = [];
	const pageSizes: number[] = [];
	let cursor: string | undefined;
	for (let index = 0; index < 100; index += 1) {
		const page = await store.query(ctx, query, cursor === undefined ? { limit } : { limit, cursor });
		events.push(...page.items);
		pageSizes.push(page.items.length);
		if (page.nextCursor === undefined) return { events, pageSizes };
		cursor = page.nextCursor;
		await between(index);
	}
	throw new Error("paging did not end after 100 pages");
}

function numbered(prefix: string, count: number, at: number, fields: EventFields = {}): AuditEventInput[] {
	return Array.from({ length: count }, (_, index) => auditEvent(`${prefix}-${index}`, at + index, fields));
}

function withoutField(event: AuditEventInput, field: keyof AuditEventInput): AuditEventInput {
	const copy: { [key: string]: unknown } = { ...event };
	delete copy[field];
	return copy as unknown as AuditEventInput;
}

export function createAuditConformance(options: {
	assertions: ConformanceAssertions;
	provider: AuditConformanceProvider;
	projectAccess?: boolean;
}): readonly ConformanceCase[] {
	const assert = options.assertions;
	const test = (
		name: string,
		body: (subject: AuditSubject, deps: ConformanceDeps) => Promise<void>,
	): ConformanceCase => ({
		name,
		run: async () => {
			const deps = createDeps();
			seedTenancy(deps);
			await options.provider(deps, (subject) => body(subject, deps));
		},
	});

	const cases: ConformanceCase[] = [
		test("keeps one row with its first data and seq when the same event id is appended twice", async ({
			store,
		}, deps) => {
			const now = deps.clock.now();
			await store.append(WORKER, [auditEvent("evt-1", now, { data: { attempt: 1 } })]);
			const first = await store.get(admin, "evt-1");
			assert.strictEqual(first.recordedAt, now, "recordedAt comes from the store's clock");
			deps.clock.advance(1000);
			await store.append(WORKER, [auditEvent("evt-1", now, { data: { attempt: 2 } }), auditEvent("evt-2", now)]);
			await store.append(WORKER, [auditEvent("evt-3", now), auditEvent("evt-3", now, { data: { attempt: 2 } })]);
			const again = await store.get(admin, "evt-1");
			assert.deepEqual(again, first, "the retry changes nothing about the first row");
			assert.deepEqual(await queryIds(store, {}), ["evt-1", "evt-2", "evt-3"], "one row per id");
			const rows = (await store.query(admin, {})).items;
			assert.greaterThan(rows[1]!.seq, rows[0]!.seq);
			assert.greaterThan(rows[2]!.seq, rows[1]!.seq);
			assert.strictEqual(rows[2]!.data, undefined, "a duplicate id inside one batch keeps the first event");
			assert.strictEqual(rows[1]!.recordedAt, now + 1000, "each new row is stamped when it is stored");
		}),

		test("delivers every event exactly once and in order when a failed drain is retried", async (subject) => {
			const { store, outbox } = subject;
			const events = numbered("evt", 250, 1_000);
			await outbox.append(WORKER, events);
			assert.strictEqual(await outbox.pending(WORKER), 250);
			const flaky = subject.flakySink(store, 1);
			const batchSizes: number[] = [];
			const recording: AuditSink = {
				async append(ctx, batch) {
					batchSizes.push(batch.length);
					await flaky.append(ctx, batch);
				},
			};
			let rejected = false;
			await outbox.drain(WORKER, recording).catch(() => {
				rejected = true;
			});
			assert.ok(rejected, "drain rejects when the sink throws");
			assert.strictEqual(await outbox.pending(WORKER), 250, "events stay queued after a failed append");
			assert.strictEqual((await store.query(admin, {})).items.length, 0, "nothing reached the store");
			assert.strictEqual(await outbox.drain(WORKER, recording), 250, "the retry sends every event");
			assert.strictEqual(await outbox.pending(WORKER), 0);
			assert.ok(
				batchSizes.every((size) => size > 0 && size <= 100),
				`batches hold at most 100 events: ${batchSizes.join(", ")}`,
			);
			const stored = (await allPages(store, {}, 100)).events;
			assert.deepEqual(
				stored.map((event) => event.id),
				events.map((event) => event.id),
				"every event once, in the order it was queued",
			);
		}),

		test("keeps the failed batch and everything after it queued when a sink fails part way through", async ({
			store,
			outbox,
		}) => {
			const events = numbered("evt", 150, 1_000);
			await outbox.append(WORKER, events);
			let calls = 0;
			const failsSecond: AuditSink = {
				async append(ctx, batch) {
					calls += 1;
					if (calls === 2) throw new Error("sink down");
					await store.append(ctx, batch);
				},
			};
			const rejected = await outbox.drain(WORKER, failsSecond).then(
				() => false,
				() => true,
			);
			assert.ok(rejected, "drain rejects");
			assert.strictEqual(await outbox.pending(WORKER), 50, "only the delivered batch left the queue");
			assert.strictEqual((await store.query(admin, {}, { limit: 500 })).items.length, 100);
			assert.strictEqual(await outbox.drain(WORKER, store), 50);
			assert.deepEqual(
				await queryIds(store, {}),
				events.map((event) => event.id),
				"every event once, in order",
			);
		}),

		test("sends each queued event once when two drains run at once", async ({ outbox }) => {
			await outbox.append(WORKER, numbered("evt", 120, 1_000));
			const delivered: string[] = [];
			const slow: AuditSink = {
				async append(_ctx, batch) {
					await new Promise((resolve) => setTimeout(resolve, 5));
					delivered.push(...batch.map((event) => event.id));
				},
			};
			const [first, second] = await Promise.all([outbox.drain(WORKER, slow), outbox.drain(WORKER, slow)]);
			assert.strictEqual(first + second, 120, "the two drains together send each event once");
			assert.strictEqual(delivered.length, 120, "the sink saw each event once");
			assert.strictEqual(new Set(delivered).size, 120);
			assert.strictEqual(await outbox.pending(WORKER), 0);
		}),

		test("queues an event id once and counts pending events", async ({ outbox }) => {
			await outbox.append(WORKER, [auditEvent("evt-1", 1), auditEvent("evt-2", 2)]);
			await outbox.append(WORKER, [auditEvent("evt-1", 1)]);
			assert.strictEqual(await outbox.pending(WORKER), 2);
			await assert.rejectsWithCode(
				outbox.append(WORKER, [withoutField(auditEvent("evt-3", 3), "actor")]),
				"invalid",
				"the outbox refuses an event the store would refuse",
			);
			assert.strictEqual(await outbox.pending(WORKER), 2);
		}),

		test("queues the same id once per organisation", async ({ store, outbox }) => {
			await outbox.append(WORKER, [auditEvent("shared-id", 1)]);
			await outbox.append(WORKER, [auditEvent("shared-id", 2, { organisationId: OTHER_ORG })]);
			assert.strictEqual(await outbox.pending(WORKER), 2, "each organisation's event is queued");
			await outbox.drain(WORKER, store);
			assert.strictEqual(await outbox.pending(WORKER), 0);
			assert.deepEqual(await queryIds(store, {}), ["shared-id"]);
			assert.deepEqual(await queryIds(store, {}, outsider), ["shared-id"]);
		}),

		test("returns rows in seq order and narrows by project, session, agent, actor, source, type prefix, subject and time", async ({
			store,
		}) => {
			const t = 1_000_000;
			const proposal = { kind: "vault.proposal", id: "proposal-1" };
			await store.append(WORKER, [
				auditEvent("e3", t + 2000, {
					source: "vault",
					type: "vault.proposal.created",
					actor: actors.agent("agent-1", "session-1"),
					projectId: "proj-1",
					sessionId: "session-1",
					agentId: "agent-1",
					subject: proposal,
				}),
				auditEvent("e1", t, { projectId: "proj-1", sessionId: "session-1" }),
				auditEvent("e2", t + 1000, {
					type: "session.tool.started",
					actor: actors.agent("agent-1", "session-1"),
					projectId: "proj-1",
					sessionId: "session-1",
					agentId: "agent-1",
				}),
				auditEvent("e4", t + 3000, {
					source: "vault",
					type: "vault.decision.approved",
					actor: actors.human("approver-1"),
					projectId: "proj-1",
					subject: proposal,
				}),
				auditEvent("e5", t + 4000, {
					source: "identity",
					type: "identity.key.issued",
					actor: actors.service("svc-1", "key-1"),
					projectId: "proj-2",
				}),
				auditEvent("e6", t + 5000, {
					source: "identity",
					type: "identity.key.revoked",
					actor: actors.service("svc-1", "key-2"),
				}),
				auditEvent("e7", t + 6000, {
					source: "schedules",
					type: "schedules.schedule.created",
					actor: actors.system("scheduler"),
					projectId: "proj-2",
					sessionId: "session-2",
					agentId: "agent-2",
				}),
				auditEvent("e8", t + 7000, { source: "control", type: "vaults.custom.noted", actor: actors.human("user-1") }),
				auditEvent("e9", t + 2000, {
					organisationId: OTHER_ORG,
					source: "vault",
					type: "vault.proposal.created",
					actor: actors.agent("agent-1", "session-1"),
					projectId: "proj-1",
					sessionId: "session-1",
					agentId: "agent-1",
					subject: proposal,
				}),
			]);
			const all = (await store.query(admin, {})).items;
			assert.deepEqual(
				all.map((event) => event.id),
				["e3", "e1", "e2", "e4", "e5", "e6", "e7", "e8"],
				"seq order, not time order",
			);
			for (let index = 1; index < all.length; index += 1) assert.greaterThan(all[index]!.seq, all[index - 1]!.seq);
			assert.deepEqual(
				await queryIds(store, { newestFirst: true }),
				["e8", "e7", "e6", "e5", "e4", "e2", "e1", "e3"],
				"newestFirst reverses seq order",
			);
			assert.deepEqual(await queryIds(store, { projectId: "proj-1" }), ["e3", "e1", "e2", "e4"], "project");
			assert.deepEqual(await queryIds(store, { sessionId: "session-1" }), ["e3", "e1", "e2"], "session");
			assert.deepEqual(await queryIds(store, { agentId: "agent-1" }), ["e3", "e2"], "agent");
			assert.deepEqual(
				await queryIds(store, { actor: actors.agent("agent-1", "session-1") }),
				["e3", "e2"],
				"agent actor",
			);
			assert.deepEqual(
				await queryIds(store, { actor: actors.agent("agent-1", "session-9") }),
				[],
				"agent by session too",
			);
			assert.deepEqual(await queryIds(store, { actor: actors.human("user-1") }), ["e1", "e8"], "human actor");
			assert.deepEqual(await queryIds(store, { actor: actors.service("svc-1") }), ["e5", "e6"], "service, any key");
			assert.deepEqual(await queryIds(store, { actor: actors.service("svc-1", "key-2") }), ["e6"], "service and key");
			assert.deepEqual(await queryIds(store, { actor: actors.system("scheduler") }), ["e7"], "system actor");
			assert.deepEqual(await queryIds(store, { actor: actors.system("other") }), [], "system by component");
			assert.deepEqual(await queryIds(store, { source: "vault" }), ["e3", "e4"], "source");
			assert.deepEqual(await queryIds(store, { type: "vault." }), ["e3", "e4"], "type prefix ends in a dot");
			assert.deepEqual(await queryIds(store, { type: "vault" }), [], "without a dot the type is exact");
			assert.deepEqual(await queryIds(store, { type: "session.tool.started" }), ["e2"], "exact type");
			assert.deepEqual(await queryIds(store, { type: "session.tool" }), [], "an exact type is not a prefix");
			assert.deepEqual(await queryIds(store, { subject: proposal }), ["e3", "e4"], "subject");
			assert.deepEqual(
				await queryIds(store, { subject: { kind: "vault.grant", id: "proposal-1" } }),
				[],
				"subject by kind and id",
			);
			assert.deepEqual(
				await queryIds(store, { from: t + 1000, to: t + 4000 }),
				["e3", "e2", "e4"],
				"from is inclusive and to exclusive",
			);
			assert.deepEqual(
				await queryIds(store, { projectId: "proj-1", source: "vault", newestFirst: true }),
				["e4", "e3"],
				"fields combine",
			);
		}),

		test("narrows by vault item and grant, by the record's subject or a string in data, and pages by them", async ({
			store,
		}) => {
			const t = 2_000_000;
			const tom = actors.human("tom");
			const agent = actors.agent("agent-1", "session-1");
			const vault = (id: string, at: number, fields: EventFields) =>
				auditEvent(id, at, { source: "vault", projectId: PROJECT, ...fields });
			await store.append(WORKER, [
				vault("created", t, {
					type: "vault.item.created",
					actor: tom,
					subject: { kind: "vault.item", id: "item-linear" },
					data: { name: "Linear API key" },
				}),
				vault("asked", t + 1, {
					type: "vault.proposal.created",
					actor: agent,
					sessionId: "session-1",
					subject: { kind: "vault.proposal", id: "proposal-1" },
					data: { itemId: "item-linear" },
				}),
				vault("approved", t + 2, {
					type: "vault.decision.approved",
					actor: tom,
					subject: { kind: "vault.proposal", id: "proposal-1" },
					data: { itemId: "item-linear", grantId: "grant-1" },
				}),
				vault("used", t + 3, {
					type: "vault.use.injected",
					actor: agent,
					sessionId: "session-1",
					subject: { kind: "vault.use", id: "use-1" },
					data: { itemId: "item-linear", grantId: "grant-1", host: "api.linear.app" },
				}),
				vault("other-item", t + 4, {
					type: "vault.use.injected",
					actor: agent,
					sessionId: "session-1",
					data: { itemId: "item-github", grantId: "grant-2" },
				}),
				vault("stopped", t + 5, {
					type: "vault.grant.revoked",
					actor: tom,
					subject: { kind: "vault.grant", id: "grant-1" },
					data: { reason: "done" },
				}),
				// Only a string names a record: an ID that is a number, a list or nested deeper is not one.
				vault("not-a-string", t + 6, { type: "vault.custom.noted", data: { itemId: 42, grantId: ["grant-1"] } }),
				vault("nested", t + 7, { type: "vault.custom.noted", data: { route: { itemId: "item-linear" } } }),
				// The subject wins over data: this event is about item-github, whatever its data says.
				vault("subject-wins", t + 8, {
					type: "vault.item.created",
					subject: { kind: "vault.item", id: "item-github" },
					data: { itemId: "item-linear" },
				}),
				// Another kind of subject with the same ID is not the record.
				vault("same-id-other-kind", t + 9, {
					type: "vault.policy.revoked",
					subject: { kind: "vault.policy", id: "item-linear" },
				}),
				auditEvent("other-org", t + 10, {
					organisationId: OTHER_ORG,
					source: "vault",
					type: "vault.use.injected",
					data: { itemId: "item-linear", grantId: "grant-1" },
				}),
				vault("elsewhere", t + 11, {
					type: "vault.use.injected",
					projectId: OTHER_PROJECT,
					data: { itemId: "item-linear", grantId: "grant-1" },
				}),
				auditEvent("org-wide", t + 12, {
					source: "vault",
					type: "vault.use.injected",
					actor: actors.system("egress"),
					data: { itemId: "item-linear" },
				}),
			]);

			assert.deepEqual(
				await queryIds(store, { itemId: "item-linear" }),
				["created", "asked", "approved", "used", "elsewhere", "org-wide"],
				"item: its subject, or data.itemId as a string",
			);
			assert.deepEqual(
				await queryIds(store, { itemId: "item-github" }),
				["other-item", "subject-wins"],
				"an item's subject wins over its data",
			);
			assert.deepEqual(
				await queryIds(store, { grantId: "grant-1" }),
				["approved", "used", "stopped", "elsewhere"],
				"grant: its subject, or data.grantId as a string",
			);
			assert.deepEqual(await queryIds(store, { itemId: "42" }), [], "a number is not an ID");
			assert.deepEqual(await queryIds(store, { itemId: "grant-1" }), [], "a grant is not an item");
			assert.deepEqual(await queryIds(store, { grantId: "item-linear" }), [], "an item is not a grant");
			assert.deepEqual(await queryIds(store, { itemId: "item-linear" }, outsider), ["other-org"], "organisation");
			assert.deepEqual(
				await queryIds(store, { itemId: "item-linear", grantId: "grant-1", type: "vault.use.", newestFirst: true }),
				["elsewhere", "used"],
				"they combine with the other fields",
			);
			assert.deepEqual(
				await queryIds(store, { grantId: "grant-1", type: "vault.decision.approved", to: t + 3 }),
				["approved"],
				"who approved a grant, in one read",
			);
			assert.deepEqual(
				await queryIds(store, { itemId: "item-linear", sessionId: "session-1" }),
				["asked", "used"],
				"and with a session",
			);
			assert.deepEqual(
				(await allPages(store, { itemId: "item-linear", newestFirst: true }, 2)).events.map((event) => event.id),
				["org-wide", "elsewhere", "used", "approved", "asked", "created"],
				"pages by cursor",
			);
			if (options.projectAccess === true) {
				assert.deepEqual(
					await queryIds(store, { itemId: "item-linear" }, projectViewer),
					["created", "asked", "approved", "used"],
					"a project viewer sees only the project's rows",
				);
				assert.deepEqual(
					await queryIds(store, { grantId: "grant-1" }, stranger),
					["elsewhere"],
					"and an operator on another project only its",
				);
			}
		}),

		test("pages through 250 rows 100 at a time, each row once, while rows are appended between pages", async ({
			store,
		}) => {
			const originals = numbered("evt", 250, 1_000);
			await store.append(WORKER, originals);
			let extra = 0;
			const appendBetween = async () => {
				await store.append(WORKER, numbered(`late-${extra}`, 7, 9_000));
				extra += 1;
			};
			const forward = await allPages(store, {}, 100, appendBetween);
			assert.strictEqual(forward.pageSizes[0], 100, "a page holds the limit");
			const forwardIds = forward.events.map((event) => event.id);
			assert.strictEqual(new Set(forwardIds).size, forwardIds.length, "no row appears twice");
			for (const event of originals) assert.ok(forwardIds.includes(event.id), `${event.id} is returned`);
			for (let index = 1; index < forward.events.length; index += 1) {
				assert.greaterThan(forward.events[index]!.seq, forward.events[index - 1]!.seq);
			}

			const before = (await allPages(store, {}, 500)).events.map((event) => event.id);
			const backward = await allPages(store, { newestFirst: true }, 100, appendBetween);
			const backwardIds = backward.events.map((event) => event.id);
			assert.strictEqual(new Set(backwardIds).size, backwardIds.length, "no row appears twice, newest first");
			assert.deepEqual([...backwardIds].sort(), [...before].sort(), "every row present when paging began, once");
			for (let index = 1; index < backward.events.length; index += 1) {
				assert.greaterThan(backward.events[index - 1]!.seq, backward.events[index]!.seq);
			}
			await assert.rejectsWithCode(store.query(admin, {}, { cursor: "not-a-cursor" }), "invalid");
		}),

		test("never returns another organisation's rows, and get is not_found for them", async ({ store }) => {
			await store.append(WORKER, [
				auditEvent("ours", 1, { projectId: "proj-1" }),
				auditEvent("theirs", 2, { organisationId: OTHER_ORG, projectId: "proj-1" }),
			]);
			assert.deepEqual(await queryIds(store, {}), ["ours"]);
			assert.deepEqual(await queryIds(store, { projectId: "proj-1" }), ["ours"]);
			assert.deepEqual(await queryIds(store, {}, outsider), ["theirs"]);
			await assert.rejectsWithCode(store.get(admin, "theirs"), "not_found");
			await assert.rejectsWithCode(store.get(outsider, "ours"), "not_found");
			await assert.rejectsWithCode(store.get(admin, "missing"), "not_found");
			assert.strictEqual((await store.get(outsider, "theirs")).organisationId, OTHER_ORG);
		}),

		test("keeps an event per organisation when two organisations reuse an id", async ({ store }) => {
			await store.append(WORKER, [auditEvent("shared-id", 1, { data: { org: "a" } })]);
			await store.append(WORKER, [auditEvent("shared-id", 2, { organisationId: OTHER_ORG, data: { org: "b" } })]);
			assert.partialDeepEqual(await store.get(admin, "shared-id"), { organisationId: ORG, data: { org: "a" } });
			assert.partialDeepEqual(await store.get(outsider, "shared-id"), {
				organisationId: OTHER_ORG,
				data: { org: "b" },
			});
			assert.deepEqual(await queryIds(store, {}, outsider), ["shared-id"]);
		}),

		test("refuses an agent querying, reading or setting retention", async ({ store }) => {
			await store.append(WORKER, [auditEvent("evt-1", 1, { actor: agent.actor, sessionId: "session-1" })]);
			await assert.rejectsWithCode(store.query(agent, {}), "forbidden", "an agent cannot query");
			await assert.rejectsWithCode(store.query(agent, { sessionId: "session-1" }), "forbidden", "not even its own");
			await assert.rejectsWithCode(store.get(agent, "evt-1"), "forbidden", "an agent cannot read a row");
			await assert.rejectsWithCode(store.setRetention(agent, DAY), "forbidden", "an agent cannot set retention");
		}),

		test("refuses an event without an actor, so every stored row has an actor", async ({ store }) => {
			await assert.rejectsWithCode(store.append(WORKER, [withoutField(auditEvent("evt-1", 1), "actor")]), "invalid");
			await assert.rejectsWithCode(
				store.append(WORKER, [auditEvent("evt-2", 1, { actor: { kind: "human" } as unknown as Actor })]),
				"invalid",
				"an actor without its ID is no actor",
			);
			await assert.rejectsWithCode(
				store.append(WORKER, [auditEvent("evt-3", 1), withoutField(auditEvent("evt-4", 1), "actor")]),
				"invalid",
				"one bad event refuses the batch",
			);
			await store.append(WORKER, [auditEvent("evt-5", 1)]);
			const rows = (await store.query(admin, {})).items;
			assert.deepEqual(
				rows.map((row) => row.id),
				["evt-5"],
				"nothing from a refused batch was stored",
			);
			assert.ok(
				rows.every((row) => row.actor !== undefined),
				"every row has an actor",
			);
		}),

		test("refuses an event without an id, a time, an organisation, a type or a known source", async ({ store }) => {
			const base = auditEvent("evt-1", 1);
			for (const field of ["id", "at", "organisationId", "type", "source"] as const) {
				await assert.rejectsWithCode(store.append(WORKER, [withoutField(base, field)]), "invalid", `missing ${field}`);
			}
			await assert.rejectsWithCode(
				store.append(WORKER, [auditEvent("evt-2", 1, { source: "nowhere" as unknown as AuditEventInput["source"] })]),
				"invalid",
				"unknown source",
			);
			await assert.rejectsWithCode(store.append(WORKER, [auditEvent("evt-3", 1, { organisationId: "" })]), "invalid");
			assert.strictEqual((await store.query(admin, {})).items.length, 0);
		}),

		test("removes on retention only rows older than the organisation's retention, leaving other organisations alone", async ({
			store,
		}, deps) => {
			const now = deps.clock.now();
			await store.append(WORKER, [
				auditEvent("old", now - 3 * DAY),
				auditEvent("just-past", now - DAY - 1),
				auditEvent("boundary", now - DAY),
				auditEvent("fresh", now),
				auditEvent("theirs-old", now - 30 * DAY, { organisationId: OTHER_ORG }),
			]);
			await assert.rejectsWithCode(store.setRetention(admin, 0), "invalid", "retention must be positive");
			await assert.rejectsWithCode(store.setRetention(admin, Number.NaN), "invalid");
			await store.setRetention(service, 7 * DAY);
			await store.setRetention(system, 2 * DAY);
			await store.setRetention(admin, DAY);
			assert.strictEqual(await store.applyRetention(WORKER), 2, "two rows are past a day");
			assert.deepEqual(await queryIds(store, {}), ["boundary", "fresh"], "rows at or inside the window stay");
			assert.deepEqual(await queryIds(store, {}, outsider), ["theirs-old"], "another organisation is untouched");
			await assert.rejectsWithCode(store.get(admin, "old"), "not_found");
			assert.strictEqual(await store.applyRetention(WORKER), 0, "retention is idempotent");
			deps.clock.advance(1);
			assert.strictEqual(await store.applyRetention(WORKER), 1, "the boundary row goes once the clock passes it");
			assert.deepEqual(await queryIds(store, {}), ["fresh"]);
		}),

		test("keeps a session's rows however much later they are queried, until retention, with no API to delete them", async ({
			store,
		}, deps) => {
			const now = deps.clock.now();
			await store.append(WORKER, [
				auditEvent("created", now, { sessionId: "session-1" }),
				auditEvent("settled", now + 1, { type: "session.settled", sessionId: "session-1" }),
			]);
			deps.clock.advance(10 * 365 * DAY);
			assert.strictEqual(await store.applyRetention(WORKER), 0, "without retention nothing is removed");
			assert.deepEqual(await queryIds(store, { sessionId: "session-1" }), ["created", "settled"], "ten years on");
			const methods = store as unknown as { readonly [name: string]: unknown };
			for (const name of ["delete", "deleteEvent", "deleteSession", "remove", "purge", "clear", "truncate", "update"]) {
				assert.strictEqual(typeof methods[name], "undefined", `the store has no ${name} method`);
			}
			await store.setRetention(admin, 365 * DAY);
			assert.strictEqual(await store.applyRetention(WORKER), 2, "retention is what removes them");
			assert.deepEqual(await queryIds(store, { sessionId: "session-1" }), []);
		}),

		test("shows a vault event and a human decision drained through the outbox once each, even when drained twice", async ({
			store,
			outbox,
		}, deps) => {
			const now = deps.clock.now();
			const vaultEvent = auditEvent("vault:decision:decision-1", now, {
				source: "vault",
				type: "vault.decision.approved",
				actor: actors.human("approver-1"),
				subject: { kind: "vault.proposal", id: "proposal-1" },
				data: { outcome: "approve" },
			});
			const humanDecision = auditEvent("control:decision:decision-2", now + 1, {
				source: "control",
				type: "control.decision.recorded",
				actor: actors.human("approver-1"),
				sessionId: "session-1",
				data: { choice: "continue" },
			});
			await outbox.append(WORKER, [vaultEvent, humanDecision]);
			assert.strictEqual(await outbox.drain(WORKER, store), 2);
			await outbox.append(WORKER, [vaultEvent, humanDecision]);
			await outbox.drain(WORKER, store);
			assert.strictEqual(await outbox.drain(WORKER, store), 0, "an empty outbox sends nothing");
			assert.deepEqual(await queryIds(store, {}), [vaultEvent.id, humanDecision.id], "once each");
			assert.partialDeepEqual(await store.get(admin, vaultEvent.id), { type: "vault.decision.approved" });
			assert.partialDeepEqual(await store.get(admin, humanDecision.id), { data: { choice: "continue" } });
		}),

		test("findSecret ignores a canary in record IDs but finds one anywhere in data", async ({ store }) => {
			const planted = auditEvent(`evt-${CANARY_SECRET}`, 1, {
				sessionId: `session-${CANARY_SECRET}`,
				subject: { kind: "vault.item", id: CANARY_SECRET },
				data: { host: "api.github.com", uses: 3 },
			});
			assert.strictEqual(findSecret(planted), false, "IDs outside data are not secrets");
			assert.strictEqual(findSecret(auditEvent("evt-0", 1)), false, "an event without data has no secret");
			const nested = auditEvent("evt-1", 1, {
				data: { request: { headers: [{ name: "Authorization", value: `Bearer ${CANARY_SECRET}` }] } },
			});
			const asKey = auditEvent("evt-2", 1, { data: { [CANARY_SECRET]: true } });
			assert.strictEqual(findSecret(nested), true, "a secret nested in arrays and objects is found");
			assert.strictEqual(findSecret(asKey), true, "a secret used as a key is found");
			assert.strictEqual(findSecret(nested, ["other-needle"]), false, "only the needles given are searched");
			assert.strictEqual(findSecret(nested, ["", "Bearer"]), true, "any needle matches; empty ones are ignored");
			assert.strictEqual(findSecret(nested, [""]), false);
			await store.append(WORKER, [planted, nested]);
			assert.strictEqual(findSecret(await store.get(admin, planted.id)), false);
			assert.strictEqual(findSecret(await store.get(admin, nested.id)), true, "the store keeps data as given");
		}),
	];
	if (options.projectAccess !== true) return cases;

	return [
		...cases,
		test("project access: refuses an operator outside the project its rows, and non-admins retention, changing nothing", async ({
			store,
		}, deps) => {
			await store.append(WORKER, projectRows);
			const denied = (call: Promise<unknown>, operation: string, message: string) =>
				assertAccessDenied(assert, deps, call, { operation, message });
			await denied(store.query(stranger, { projectId: PROJECT }), "audit.query", "querying the project");
			await denied(store.query(stranger, { sessionId: "session-1" }), "audit.query", "querying its session");
			await denied(
				store.query(stranger, { projectId: OTHER_PROJECT, sessionId: "session-1" }),
				"audit.query",
				"naming its session under the caller's own project",
			);
			await denied(store.get(stranger, "p1-a"), "audit.get", "reading a project row");
			await denied(store.get(stranger, "org-a"), "audit.get", "reading an organisation row");
			await denied(store.setRetention(stranger, DAY), "audit.setRetention", "retention by a project operator");
			await denied(store.setRetention(projectAdmin, DAY), "audit.setRetention", "retention by a project admin");
			await denied(store.setRetention(auditor, DAY), "audit.setRetention", "retention by an organisation viewer");
			deps.clock.advance(30 * DAY);
			assert.strictEqual(await store.applyRetention(WORKER), 0, "no refused retention took effect");
			assert.deepEqual(await queryIds(store, {}), PROJECT_ROW_IDS, "every row is still there");
		}),

		test("project access: refuses an agent before any project check, whichever project its session is in", async ({
			store,
		}, deps) => {
			await store.append(WORKER, projectRows);
			await assert.rejectsWithCode(store.query(strayAgent, { projectId: PROJECT }), "forbidden");
			await assert.rejectsWithCode(store.query(strayAgent, { sessionId: "session-2" }), "forbidden", "its own");
			await assert.rejectsWithCode(store.get(strayAgent, "p1-a"), "forbidden");
			await assert.rejectsWithCode(store.query(agent, { projectId: PROJECT }), "forbidden", "in its own project");
			assert.strictEqual(deps.audit.ofType("access.denied").length, 0, "the agent rule refuses first");
			assert.deepEqual(await queryIds(store, {}), PROJECT_ROW_IDS);
		}),

		test("project access: a query without a project or session returns only rows the caller may see, paging stably", async ({
			store,
		}, deps) => {
			await store.append(WORKER, projectRows);
			assert.deepEqual(await queryIds(store, {}, stranger), ["p2-a", "p2-b"], "an operator outside sees its own");
			assert.deepEqual(await queryIds(store, {}, projectViewer), ["p1-a", "p1-b", "p1-c"], "no organisation rows");
			assert.deepEqual(await queryIds(store, {}, auditor), PROJECT_ROW_IDS, "an organisation viewer sees all");
			assert.deepEqual(
				await queryIds(store, { type: "session.created", newestFirst: true }, projectViewer),
				["p1-c", "p1-b", "p1-a"],
				"other fields still narrow and order",
			);
			const forward = await allPages(store, {}, 2, async () => {}, projectViewer);
			assert.deepEqual(forward.pageSizes, [2, 1], "pages are cut from visible rows only");
			assert.deepEqual(
				forward.events.map((event) => event.id),
				["p1-a", "p1-b", "p1-c"],
			);
			const backward = await allPages(store, { newestFirst: true }, 2, async () => {}, projectViewer);
			assert.deepEqual(backward.pageSizes, [2, 1]);
			assert.deepEqual(
				backward.events.map((event) => event.id),
				["p1-c", "p1-b", "p1-a"],
			);
			assert.strictEqual(deps.audit.ofType("access.denied").length, 0, "filtering a list audits no refusal");
		}),

		test("project access: lets a viewer on the project query and read its rows, and an organisation viewer the rest", async ({
			store,
		}, deps) => {
			await store.append(WORKER, [
				...projectRows,
				auditEvent("stray", 9, { projectId: OTHER_PROJECT, sessionId: "session-1" }),
			]);
			assert.deepEqual(await queryIds(store, { projectId: PROJECT }, projectViewer), ["p1-a", "p1-b", "p1-c"]);
			assert.deepEqual(
				await queryIds(store, { sessionId: "session-1" }, projectViewer),
				["p1-a"],
				"a row naming the session but another project is left out",
			);
			assert.strictEqual((await store.get(projectViewer, "p1-b")).projectId, PROJECT);
			await assertAccessDenied(assert, deps, store.get(projectViewer, "org-a"), {
				operation: "audit.get",
				message: "a row without a project needs an organisation-wide role",
			});
			assert.strictEqual((await store.get(auditor, "org-a")).id, "org-a");
			assert.deepEqual(await queryIds(store, { projectId: OTHER_PROJECT }, auditor), ["p2-a", "p2-b", "stray"]);
		}),

		test("worker calls: append, retention, drain and pending refuse every caller but system, and change nothing", async ({
			store,
			outbox,
		}, deps) => {
			await store.append(WORKER, projectRows);
			const forged = auditEvent("forged", 8, { data: { token: CANARY_SECRET } });
			const callers = nonSystemCallers(ORG, { agentId: "agent-1", sessionId: "session-1" });
			const storeCalls = [
				["audit.append", (ctx: SystemContext) => store.append(ctx, [forged])],
				["audit.applyRetention", (ctx: SystemContext) => store.applyRetention(ctx)],
			] as const;
			const outboxCalls = [
				["audit.append", (ctx: SystemContext) => outbox.append(ctx, [forged])],
				["audit.drain", (ctx: SystemContext) => outbox.drain(ctx, store)],
				["audit.pending", (ctx: SystemContext) => outbox.pending(ctx)],
			] as const;
			await store.setRetention(admin, DAY);
			deps.clock.advance(30 * DAY);
			for (const { label, ctx } of callers) {
				for (const [operation, call] of [...storeCalls, ...outboxCalls]) {
					await assert.rejectsWithCode(call(ctx), "forbidden", `${operation} refuses ${label}`);
				}
			}
			assert.deepEqual(await queryIds(store, { type: "session." }), PROJECT_ROW_IDS, "no row was forged or erased");
			// Each refusal is audited where the call was made: the store's own rows, and the outbox's queue.
			const refusals = async (organisationId: string) =>
				(await store.query(contextFor(actors.system("audit-reader"), organisationId), { type: "access.denied" })).items;
			const named = await refusals(ORG);
			const unnamed = await refusals(PLATFORM_ORGANISATION);
			assert.strictEqual(named.length, 6, "the store audits each refusal of a caller in the organisation once");
			assert.deepEqual(
				named.map((row) => `${row.data?.operation}:${row.data?.caller}`),
				["human", "service", "agent"].flatMap((kind) => [`audit.append:${kind}`, `audit.applyRetention:${kind}`]),
				"one row per refused store call, naming the operation and the caller's kind",
			);
			assert.strictEqual(unnamed.length, 2, "and each refusal of no caller under the platform");
			assert.deepEqual(
				unnamed.map((row) => [row.data?.operation, row.data?.caller]),
				[
					["audit.append", "missing"],
					["audit.applyRetention", "missing"],
				],
			);
			assert.ok(!containsCanary([...named, ...unnamed]), "no refusal holds the forged event's secret");
			assert.strictEqual(await outbox.pending(WORKER), 12, "the outbox queued its own refusals and nothing forged");
			await outbox.drain(WORKER, store);
			assert.strictEqual((await refusals(ORG)).length + (await refusals(PLATFORM_ORGANISATION)).length, 20);
			await assert.rejectsWithCode(store.get(admin, "forged"), "not_found", "the forged event never reached the store");
			assert.strictEqual(await store.applyRetention(WORKER), PROJECT_ROW_IDS.length, "Harbour's own retention runs");
		}),
	];
}

export function registerAuditConformance(
	runner: ConformanceRunner,
	name: string,
	provider: AuditConformanceProvider,
	options?: ConformanceOptions,
): void {
	registerCases(
		runner,
		name,
		createAuditConformance({
			assertions: createExpectAssertions(runner.expect),
			provider,
			projectAccess: options?.projectAccess === true,
		}),
	);
}
