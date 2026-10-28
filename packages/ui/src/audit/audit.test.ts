// The audit view's logic against the in-memory audit store: the filters as queries, the credential summary that
// answers the definition of done, JSONL export, and paging through 100k events with the store's cursors.

import type { AuditEvent } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { DAY, HOUR } from "../primitives/format.ts";
import {
	actorFromKey,
	actorKey,
	actorName,
	describeEvent,
	matchesCredential,
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
	yesterday,
} from "./fixtures.ts";
import { credentialUsage } from "./usage.ts";

describe("filters", () => {
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
		expect(toQuery({ range: "all", kind: "all", projectId: "" }, FIXTURE_NOW)).toEqual({ newestFirst: true });
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
		const event = { ...find("session.created"), type: "browser.session.opened", source: "browser" } as AuditEvent;
		expect(describeEvent(event).action).toBe("browser session opened");
	});

	it("match the credential filter on the event's item", () => {
		const use = find("vault.use.injected");
		expect(matchesCredential(use, use.data!.itemId as string)).toBe(true);
		expect(matchesCredential(use, "itm_other")).toBe(false);
		expect(matchesCredential(find("session.created"), undefined)).toBe(true);
		expect(matchesCredential(find("session.created"), "itm_linear")).toBe(false);
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

	it("is read from the organisation the timeline shows", async () => {
		const scenario = await createAuditScenario(4000);
		const sessionsIn = async (organisationId: string) => {
			const ids = new Set<string>();
			for await (const page of readAll(
				scenario.source,
				{ organisationId, type: "vault.use." },
				{ credential: "itm_github" },
			))
				for (const event of page) if (event.sessionId !== undefined) ids.add(event.sessionId);
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
