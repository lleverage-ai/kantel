// The audit view's logic against the in-memory audit store: the filters as queries, the credential summary that
// answers the definition of done, JSONL export, and paging through 100k events with the store's cursors.

import { createMemoryAuditStore } from "@harbour/audit/memory";
import { type AuditEvent, systemContext } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { DAY, HOUR } from "../primitives/format.ts";
import {
	actorFromKey,
	actorKey,
	actorName,
	credentialChoices,
	describeEvent,
	eventItemId,
	rangeBounds,
	readAll,
	toJsonl,
	toQuery,
} from "./audit-model.ts";
import {
	createAuditScenario,
	directory,
	FIXTURE_NOW,
	generateEvents,
	links,
	ORGANISATION,
	SECOND_ORGANISATION,
	storeSource,
	yesterday,
} from "./fixtures.ts";
import { credentialUsage } from "./usage.ts";

describe("filters", () => {
	it("narrow to one browser session by the events' subject", () => {
		expect(toQuery({ range: "all", kind: "all", browserSession: "brs_1" }, FIXTURE_NOW)).toEqual({
			newestFirst: true,
			subject: { kind: "browser.session", id: "brs_1" },
		});
		expect(toQuery({ range: "all", kind: "all", browserSession: "" }, FIXTURE_NOW)).toEqual({ newestFirst: true });
	});

	it("turn into the store's query, newest first, with the kind as a type prefix", () => {
		expect(
			toQuery({ range: "hour", kind: "credential-use", projectId: "prj_billing", actor: "human:usr_tom" }, FIXTURE_NOW),
		).toEqual({
			newestFirst: true,
			type: "vault.use.",
			actor: { kind: "human", userId: "usr_tom" },
			projectId: "prj_billing",
			from: FIXTURE_NOW - HOUR,
		});
		expect(toQuery({ range: "all", kind: "all", projectId: "", credential: "" }, FIXTURE_NOW)).toEqual({
			newestFirst: true,
		});
		expect(toQuery({ range: "all", kind: "approval", credential: "itm_linear" }, FIXTURE_NOW)).toEqual({
			newestFirst: true,
			type: "vault.decision.",
			itemId: "itm_linear",
		});
	});

	it("read policy changes as vault policies and capability grants, in one query", async () => {
		const query = toQuery({ range: "all", kind: "policy" }, FIXTURE_NOW);
		expect(query).toEqual({ newestFirst: true, types: ["vault.policy.", "capability.grant."] });
		const store = createMemoryAuditStore({ clock: { now: () => FIXTURE_NOW } });
		const event = (id: string, type: string, source: "vault" | "capability", at: number) => ({
			id,
			at,
			source,
			type,
			actor: { kind: "human" as const, userId: "usr_tom" },
			organisationId: ORGANISATION,
		});
		await store.append(systemContext("fixture"), [
			event("policy", "vault.policy.created", "vault", 1),
			event("grant", "capability.grant.created", "capability", 2),
			event("call", "capability.call.started", "capability", 3),
			event("use", "vault.use.injected", "vault", 4),
			event("revoked", "capability.grant.revoked", "capability", 5),
		]);
		const source = storeSource(store, { actor: { kind: "human", userId: "usr_tom" }, organisationId: ORGANISATION });
		const page = await source.query(query);
		expect(page.items.map((row) => row.id)).toEqual(["revoked", "grant", "policy"]);
		const grant = { ...page.items[1]!, data: { capabilities: ["linear.issues.read", "linear.issues.write"] } };
		expect(describeEvent(grant).action).toBe("granted linear.issues.read, linear.issues.write");
		expect(describeEvent({ ...grant, data: {} }).action).toBe("granted capabilities");
		expect(describeEvent({ ...page.items[0]!, data: {} }).action).toBe("revoked a capability grant");
		expect(describeEvent({ ...page.items[0]!, data: { reason: "session ended" } }).action).toBe(
			"revoked a capability grant: session ended",
		);
	});

	it("leave the credential to the store, so its first page is the credential's however far back it was used", async () => {
		// The Linear key's events are all older than 6,000 others: more than the 25 pages the view used to read for it.
		const events = generateEvents(8000).sort((a, b) => a.at - b.at);
		const isLinear = (event: (typeof events)[number]) =>
			eventItemId({ ...event, seq: 0, recordedAt: event.at }) === "itm_linear";
		const recent = events.slice(-6000).filter((event) => !isLinear(event));
		const older = events.slice(0, -6000);
		const store = createMemoryAuditStore({ clock: { now: () => FIXTURE_NOW } });
		await store.append(systemContext("fixture"), [...older, ...recent]);
		const source = storeSource(store, { actor: { kind: "human", userId: "usr_tom" }, organisationId: ORGANISATION });
		const page = await source.query(toQuery({ range: "all", kind: "all", credential: "itm_linear" }, FIXTURE_NOW), {
			limit: 200,
		});
		const expected = older.filter((event) => event.organisationId === ORGANISATION && isLinear(event));
		expect(expected.length).toBeGreaterThan(0);
		expect(page.items.length).toBe(Math.min(200, expected.length));
		expect(page.items.every((event) => eventItemId(event) === "itm_linear")).toBe(true);
	});

	it("carry the organisation for the host to bind, and read only that organisation's rows", async () => {
		const query = toQuery({ range: "all", kind: "all", organisationId: SECOND_ORGANISATION }, FIXTURE_NOW);
		expect(query).toEqual({ newestFirst: true, organisationId: SECOND_ORGANISATION });
		const { source } = await createAuditScenario(500);
		const labs = await source.query(query, { limit: 500 });
		const home = await source.query(toQuery({ range: "all", kind: "all" }, FIXTURE_NOW), { limit: 500 });
		expect(labs.items.length).toBeGreaterThan(0);
		expect(labs.items.every((event) => event.organisationId === SECOND_ORGANISATION)).toBe(true);
		expect(home.items.every((event) => event.organisationId === ORGANISATION)).toBe(true);
	});

	it("offer the credentials the log names, for a host with no vault to list them from", async () => {
		const { source } = await createAuditScenario(500);
		const credentials = await credentialChoices(source);
		expect(credentials).toContainEqual({ value: "itm_linear", label: "Linear API key" });
		expect(new Set(credentials.map((choice) => choice.value)).size).toBe(credentials.length);
		expect(credentials.map((choice) => choice.label)).toEqual(
			[...credentials.map((choice) => choice.label)].sort((a, b) => a.localeCompare(b, "en-GB")),
		);
		expect(await credentialChoices(source, { organisationId: "org_nobody" })).toEqual([]);
	});

	it("make yesterday the calendar day before today, in local time", () => {
		const { from, to } = rangeBounds("yesterday", FIXTURE_NOW);
		expect(to! - from!).toBeGreaterThanOrEqual(23 * HOUR);
		expect(to! - from!).toBeLessThanOrEqual(25 * HOUR);
		expect(new Date(to!).getHours()).toBe(0);
		expect(FIXTURE_NOW - to!).toBeLessThan(DAY);
	});

	it("round-trip actors through their keys", () => {
		for (const actor of [
			{ kind: "human", userId: "usr_tom" },
			{ kind: "agent", agentId: "agt_ops", sessionId: "ses_1" },
			{ kind: "service", serviceId: "svc_ci" },
			{ kind: "system", component: "vault" },
		] as const) {
			expect(actorFromKey(actorKey(actor))).toEqual(actor);
		}
		expect(actorFromKey("agent:agt_ops")).toBeUndefined();
		expect(actorFromKey("nobody:x")).toBeUndefined();
	});
});

describe("rows", () => {
	const events = generateEvents(4000);
	const find = (type: string) => events.find((event) => event.type === type) as AuditEvent;

	it("read as a sentence with the credential's name, and link to the vault request or the session turn", () => {
		const approved = find("vault.decision.approved");
		const line = describeEvent(approved, directory, links);
		expect(actorName(approved.actor, directory)).toMatch(/Tom Davies|Alex Rivera/);
		expect(line.action).toMatch(
			/^approved (Linear API key|GitHub token|Sentry auth token|Staging admin key|Stripe test key|Slack bot token) for /,
		);
		expect(line.link?.href).toBe(`https://vault.harbour.dev/proposals/${approved.subject!.id}`);

		const prompt = find("session.prompted");
		expect(describeEvent(prompt, directory, links).link?.href).toBe(
			`#/sessions/${prompt.sessionId}?turn=${prompt.subject!.id}`,
		);

		const use = find("vault.use.injected");
		expect(describeEvent(use, directory, links)).toMatchObject({
			tone: "working",
			link: { href: `#/sessions/${use.sessionId}` },
		});
	});

	it("read unknown types from the type itself", () => {
		const event = { ...find("session.created"), type: "browser.context.created", source: "browser" } as AuditEvent;
		expect(describeEvent(event).action).toBe("browser context created");
	});

	it("read a browser's events plainly and link them to the session at that browser", () => {
		const base = find("session.created");
		const browser = (type: string, data: AuditEvent["data"]) =>
			({
				...base,
				type,
				source: "browser",
				subject: { kind: "browser.session", id: "brs_1" },
				data,
			}) as AuditEvent;
		const seen: unknown[] = [];
		const withBrowser = {
			...links,
			browser: (...args: [string, string, string?]) => {
				seen.push(args);
				return `#/sessions/${args[0]}#browser=${args[1]}`;
			},
		};
		const step = describeEvent(
			browser("browser.session.step", { step: "goto", host: "github.com", succeeded: true }),
			directory,
			withBrowser,
		);
		expect(step).toMatchObject({
			action: "took a browser step: goto on github.com",
			link: { href: `#/sessions/${base.sessionId}#browser=brs_1`, label: "Browser" },
		});
		expect(seen).toEqual([[base.sessionId, "brs_1", base.projectId]]);
		expect(describeEvent(browser("browser.session.step", { step: "click", host: "", succeeded: false }))).toMatchObject(
			{ action: "tried a browser step: click", tone: "error" },
		);
		expect(describeEvent(browser("browser.session.embedded", { mode: "replay", minutes: 15 })).action).toBe(
			"made an embed link to the browser's replay for 15 minutes",
		);
		expect(describeEvent(browser("browser.session.shared", { minutes: 15, watch: true })).action).toBe(
			"opened a watch-only view of the browser for 15 minutes",
		);
		expect(describeEvent(browser("browser.session.shared", { minutes: 60 })).action).toBe(
			"opened the browser with control for 60 minutes",
		);
		expect(
			describeEvent(browser("browser.recording.stored", { frames: 40, pages: 1, durationMs: 9_400, expiresAt: 1 }))
				.action,
		).toBe("stored the browser's recording (40 frames, 1 page, 9s)");
		expect(describeEvent(browser("browser.session.closed", { endReason: "timeout" })).action).toBe(
			"closed the browser (timeout)",
		);
		// Without a browser link, the session's link stands.
		expect(describeEvent(browser("browser.session.opened", {}), directory, links).link?.href).toBe(
			`#/sessions/${base.sessionId}`,
		);
	});

	it("name the item an event is about as the store's itemId filter does", () => {
		const use = find("vault.use.injected");
		expect(eventItemId(use)).toBe(use.data!.itemId);
		expect(eventItemId(find("session.created"))).toBeUndefined();
		expect(eventItemId({ ...use, subject: { kind: "vault.item", id: "itm_new" } })).toBe("itm_new");
	});

	it("link sessions with the event's project, for hosts whose session pages sit under one", () => {
		const prompt = find("session.prompted");
		const seen: unknown[] = [];
		describeEvent(prompt, directory, {
			session: (...args) => {
				seen.push(args);
				return "#";
			},
		});
		expect(seen).toEqual([[prompt.sessionId, prompt.subject!.id, prompt.projectId]]);
	});
});

describe("which sessions used the Linear key yesterday, and who approved it", () => {
	it("is answered from the log: three sessions, approved by Tom and Alex", async () => {
		const scenario = await createAuditScenario(4000);
		const { from, to } = rangeBounds("yesterday", FIXTURE_NOW);
		const usage = await credentialUsage(scenario.source, { itemId: yesterday.itemId, from: from!, to: to! });
		const ids = usage.sessions.map((session) => session.sessionId);
		for (const sessionId of yesterday.sessions) expect(ids).toContain(sessionId);
		const story = usage.sessions.filter((session) =>
			(yesterday.sessions as readonly string[]).includes(session.sessionId),
		);
		expect(story.map((session) => session.injected)).toEqual([9, 4, 2]);
		const approvers = story.map((session) =>
			session.via.map((grantId) => {
				const approval = usage.approvals.get(grantId);
				return approval === undefined ? "none" : actorName(approval.approvedBy, directory);
			}),
		);
		expect(approvers).toEqual([["Tom Davies"], ["Alex Rivera"], ["Tom Davies"]]);
		// Every grant used has its approval, so no row says "Approval not in this log".
		for (const session of usage.sessions) for (const via of session.via) expect(usage.approvals.has(via)).toBe(true);
	});

	it("reads only the credential's uses and one approval per grant, filtered by the store", async () => {
		const scenario = await createAuditScenario(4000);
		const queries: string[] = [];
		let rows = 0;
		const counted: typeof scenario.source = {
			async query(query, page) {
				queries.push(query.grantId === undefined ? `uses of ${query.itemId}` : `approval of ${query.grantId}`);
				const result = await scenario.source.query(query, page);
				rows += result.items.length;
				return result;
			},
		};
		const { from, to } = rangeBounds("yesterday", FIXTURE_NOW);
		const usage = await credentialUsage(counted, { itemId: yesterday.itemId, from: from!, to: to! });
		const uses = usage.sessions.reduce((sum, session) => sum + session.injected + session.refused, 0);
		expect(queries[0]).toBe(`uses of ${yesterday.itemId}`);
		expect(queries.slice(1).sort()).toEqual(
			[...usage.approvals.keys()].map((grantId) => `approval of ${grantId}`).sort(),
		);
		expect(rows).toBe(uses + usage.unattributed + usage.approvals.size);
	});

	it("is read from the organisation the timeline shows", async () => {
		const scenario = await createAuditScenario(4000);
		const sessionsIn = async (organisationId: string) => {
			const ids = new Set<string>();
			for await (const page of readAll(scenario.source, { organisationId, type: "vault.use." }))
				for (const event of page)
					if (event.sessionId !== undefined && event.data?.itemId === "itm_github") ids.add(event.sessionId);
			return ids;
		};
		const found: Set<string>[] = [];
		for (const organisationId of [ORGANISATION, SECOND_ORGANISATION]) {
			const expected = await sessionsIn(organisationId);
			const usage = await credentialUsage(scenario.source, { itemId: "itm_github", organisationId });
			expect(expected.size).toBeGreaterThan(0);
			expect(new Set(usage.sessions.map((session) => session.sessionId))).toEqual(expected);
			found.push(expected);
		}
		expect(found[0]).not.toEqual(found[1]);
	});
});

describe("export", () => {
	it("writes one stored event per line, which parses back to the same events", async () => {
		const scenario = await createAuditScenario(2000);
		const events: AuditEvent[] = [];
		for await (const page of readAll(scenario.source, { type: "vault." })) events.push(...page);
		const jsonl = toJsonl(events);
		const lines = jsonl.trimEnd().split("\n");
		expect(lines).toHaveLength(events.length);
		expect(lines.map((line) => JSON.parse(line))).toEqual(events);
		expect(jsonl.endsWith("\n")).toBe(true);
		// Oldest first, as read: seq only increases.
		expect(events.every((event, index) => index === 0 || event.seq > events[index - 1]!.seq)).toBe(true);
	});

	it("yields nothing more once cancelled, even from a page already in flight", async () => {
		const scenario = await createAuditScenario(500);
		const controller = new AbortController();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow: typeof scenario.source = {
			async query(query, page) {
				await gate;
				return scenario.source.query(query, page);
			},
		};
		const pages = readAll(slow, {}, { signal: controller.signal });
		const first = pages.next();
		controller.abort();
		release();
		expect(await first).toEqual({ done: true, value: undefined });
	});
});

describe("100k events", () => {
	it("pages newest first through every event with the store's cursors, each page quickly", async () => {
		const scenario = await createAuditScenario(100_000);
		expect(scenario.count).toBeGreaterThan(99_000);
		const timings: number[] = [];
		let total = 0;
		let previous = Number.POSITIVE_INFINITY;
		let cursor: string | undefined;
		do {
			const started = performance.now();
			const page = await scenario.source.query(
				{ newestFirst: true },
				{ limit: 200, ...(cursor === undefined ? {} : { cursor }) },
			);
			timings.push(performance.now() - started);
			for (const event of page.items) {
				expect(event.seq).toBeLessThan(previous);
				previous = event.seq;
			}
			total += page.items.length;
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		expect(total).toBe(scenario.count);
		timings.sort((a, b) => a - b);
		const median = timings[Math.floor(timings.length / 2)]!;
		const p95 = timings[Math.floor(timings.length * 0.95)]!;
		console.info(`100k: ${timings.length} pages of 200, median ${median.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms`);
		// The in-memory store filters every row per page; lane 6's indexed store should do far better. A loose bound
		// that still catches a quadratic regression.
		expect(median).toBeLessThan(100);
	}, 120_000);
});
