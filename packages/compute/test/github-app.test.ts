import { isKantelError } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import { createGithubApp } from "../src/github-app.ts";

/** A GitHub App's private key, as GitHub gives it (PEM). */
async function testPem(): Promise<string> {
	const pair = await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	);
	const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
	return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
}

const NOW = Date.parse("2026-11-16T18:30:00Z");

/**
 * GitHub's API for reconciling: `routes` answers a path (with its query), and every call is kept with its
 * `If-None-Match`. An answer carries an ETag from its body, and the rate limit `limit` says.
 */
function fakeApi(routes: (path: string) => unknown, limit = { remaining: 4000, limit: 5000 }) {
	const calls: { method: string; path: string; ifNoneMatch?: string }[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const path = `${url.pathname}${url.search}`;
		const headers = new Headers(init?.headers);
		const ifNoneMatch = headers.get("if-none-match") ?? undefined;
		calls.push({ method: init?.method ?? "GET", path, ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }) });
		if (path.endsWith("/access_tokens")) {
			return Response.json({ token: "ghs_test", expires_at: new Date(NOW + 3_600_000).toISOString() });
		}
		if (path.endsWith("/attempts")) return new Response(null, { status: 202 });
		const body = routes(path);
		const rate = {
			"x-ratelimit-remaining": String(limit.remaining),
			"x-ratelimit-limit": String(limit.limit),
			"x-ratelimit-reset": String(Math.floor(NOW / 1000) + 1800),
		};
		if (body === undefined) return new Response("{}", { status: 404, headers: rate });
		const etag = `"${JSON.stringify(body).length}-${path.length}"`;
		if (ifNoneMatch === etag) return new Response(null, { status: 304, headers: rate });
		return Response.json(body, { headers: { ...rate, etag } });
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

describe("a GitHub App's reconciling reads", () => {
	it("lists a repository's queued jobs from its queued and in-progress runs, and reads an unchanged list conditionally", async () => {
		const api = fakeApi((path) => {
			if (path.startsWith("/repos/octo-org/app/actions/runs?status=queued")) return { workflow_runs: [{ id: 1 }] };
			if (path.startsWith("/repos/octo-org/app/actions/runs?status=in_progress")) return { workflow_runs: [{ id: 2 }] };
			if (path.startsWith("/repos/octo-org/app/actions/runs/1/jobs")) {
				return {
					jobs: [
						{
							id: 10,
							run_id: 1,
							status: "queued",
							name: "build",
							labels: ["kantel-8vcpu"],
							created_at: "2026-11-16T18:24:00Z",
						},
					],
				};
			}
			if (path.startsWith("/repos/octo-org/app/actions/runs/2/jobs")) {
				return {
					jobs: [
						{ id: 20, run_id: 2, status: "completed", name: "lint", labels: ["kantel-8vcpu"] },
						{ id: 21, run_id: 2, status: "queued", name: "deploy", labels: ["kantel-warm"] },
						{ id: 22, run_id: 2, status: "waiting", name: "approve", labels: ["kantel-warm"] },
					],
				};
			}
			return undefined;
		});
		const app = createGithubApp({ appId: 1, privateKey: await testPem(), fetch: api.fetch, now: () => NOW });
		expect(await app.queuedJobs(42, "octo-org/app")).toEqual([
			{ id: 10, runId: 1, name: "build", labels: ["kantel-8vcpu"], createdAt: Date.parse("2026-11-16T18:24:00Z") },
			{ id: 21, runId: 2, name: "deploy", labels: ["kantel-warm"] },
		]);
		expect(api.calls.filter((call) => call.path.includes("/actions/runs/1/jobs"))).toEqual([
			{ method: "GET", path: "/repos/octo-org/app/actions/runs/1/jobs?filter=latest&per_page=100&page=1" },
		]);
		// Again: each read names the ETag it was answered with, and a 304 answers the same jobs.
		expect(await app.queuedJobs(42, "octo-org/app")).toHaveLength(2);
		const again = api.calls.filter((call) => !call.path.endsWith("/access_tokens")).slice(4);
		expect(again).toHaveLength(4);
		for (const call of again) expect(call.ifNoneMatch).toBeDefined();
	});

	it("lists an installation's repositories, every page, without archived ones", async () => {
		const page = (from: number, count: number) =>
			Array.from({ length: count }, (_, at) => ({
				full_name: `octo-org/repo-${from + at}`,
				archived: from + at === 3,
			}));
		const api = fakeApi((path) => {
			const number = /[?&]page=(\d+)/.exec(path)?.[1];
			return number === "1"
				? { repositories: page(0, 100) }
				: number === "2"
					? { repositories: page(100, 5) }
					: undefined;
		});
		const app = createGithubApp({ appId: 1, privateKey: await testPem(), fetch: api.fetch, now: () => NOW });
		const names = await app.listRepositories(42);
		expect(names).toHaveLength(104);
		expect(names).not.toContain("octo-org/repo-3");
		expect(api.calls.some((call) => /[?&]page=3/.test(call.path))).toBe(false);
	});

	it("stops reconciling when the installation's rate limit is low, until it resets", async () => {
		const limit = { remaining: 4000, limit: 5000 };
		const api = fakeApi(() => ({ workflow_runs: [] }), limit);
		const app = createGithubApp({ appId: 1, privateKey: await testPem(), fetch: api.fetch, now: () => NOW });
		await app.queuedJobs(42, "octo-org/app");
		limit.remaining = 1000;
		// The read that learns of it is answered; the next is refused before it is sent.
		await app.queuedJobs(42, "octo-org/app").catch(() => undefined);
		const sent = api.calls.length;
		const refused = await app.queuedJobs(42, "octo-org/app").catch((error: unknown) => error);
		expect(isKantelError(refused) && refused.code).toBe("exhausted");
		expect(api.calls).toHaveLength(sent);
		// Another installation's limit is its own.
		limit.remaining = 4000;
		await expect(app.queuedJobs(43, "octo-org/app")).resolves.toEqual([]);
	});

	it("answers the App's failed deliveries, the latest attempt of each, and redelivers one", async () => {
		const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
		const delivery = (id: number, guid: string, status_code: number, minutes: number, event = "workflow_job") => ({
			id,
			guid,
			status_code,
			delivered_at: at(minutes),
			event,
			action: "queued",
			installation_id: 42,
		});
		const api = fakeApi((path) =>
			path.startsWith("/app/hook/deliveries")
				? [
						// Newest first. g-1 failed twice; g-2 failed, then got through; g-3 failed three times; g-4 is too old.
						// Which to send again is the broker's to judge (once each, `redelivered`).
						delivery(9, "g-1", 503, 1),
						delivery(8, "g-2", 200, 2),
						delivery(7, "g-3", 503, 3),
						delivery(6, "g-1", 503, 4),
						delivery(5, "g-3", 503, 5),
						delivery(4, "g-2", 503, 6),
						delivery(3, "g-3", 0, 7),
						delivery(2, "g-4", 503, 120),
					]
				: undefined,
		);
		const app = createGithubApp({ appId: 1, privateKey: await testPem(), fetch: api.fetch, now: () => NOW });
		expect(await app.failedDeliveries(NOW - 60 * 60_000)).toEqual([
			{
				id: 9,
				guid: "g-1",
				event: "workflow_job",
				action: "queued",
				installationId: 42,
				deliveredAt: Date.parse(at(1)),
			},
			expect.objectContaining({ id: 7, guid: "g-3" }),
		]);
		await app.redeliver(9);
		expect(api.calls.at(-1)).toEqual({ method: "POST", path: "/app/hook/deliveries/9/attempts" });
	});

	it("reads every page of a repository's runs and of a run's jobs", async () => {
		const runs = Array.from({ length: 130 }, (_, at) => ({ id: at + 1 }));
		const jobs = Array.from({ length: 120 }, (_, at) => ({
			id: 1000 + at,
			run_id: 7,
			status: at === 110 ? "queued" : "completed",
			name: `job ${at}`,
			labels: ["kantel-8vcpu"],
		}));
		const api = fakeApi((path) => {
			const url = new URL(`https://api.github.test${path}`);
			const page = Number(url.searchParams.get("page") ?? "1");
			const slice = <T>(all: T[]) => all.slice((page - 1) * 100, page * 100);
			if (url.pathname === "/repos/octo-org/app/actions/runs") {
				return { workflow_runs: url.searchParams.get("status") === "queued" ? slice(runs) : [] };
			}
			if (url.pathname === "/repos/octo-org/app/actions/runs/7/jobs") return { jobs: slice(jobs) };
			return url.pathname.endsWith("/jobs") ? { jobs: [] } : undefined;
		});
		const app = createGithubApp({ appId: 1, privateKey: await testPem(), fetch: api.fetch, now: () => NOW });
		expect((await app.queuedJobs(42, "octo-org/app")).map((job) => job.id)).toEqual([1110]);
		expect(api.calls.filter((call) => call.path.includes("status=queued")).map((call) => call.path)).toEqual([
			"/repos/octo-org/app/actions/runs?status=queued&per_page=100&page=1",
			"/repos/octo-org/app/actions/runs?status=queued&per_page=100&page=2",
		]);
	});

	it("finds the App's installation on an owner, without case", async () => {
		const api = fakeApi((path) =>
			path.startsWith("/app/installations")
				? [
						{ id: 5, account: { login: "someone-else" } },
						{ id: 42, account: { login: "Octo-Org" } },
					]
				: undefined,
		);
		const app = createGithubApp({ appId: 1, privateKey: await testPem(), fetch: api.fetch, now: () => NOW });
		expect(await app.findInstallation("octo-org")).toBe(42);
		expect(await app.findInstallation("nobody")).toBeUndefined();
	});
});
