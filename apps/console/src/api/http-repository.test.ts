// A session on a repository: the console lists the repository's branches, then seeds a workspace from the chosen
// branch and starts the session on it. The gateway is a recording stand-in; what's checked is what the console asks.

import { describe, expect, it } from "vitest";
import { createApiClient } from "./http.ts";

const BASE = "https://kantel.test/v1";

interface Recorded {
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
}

function gateway(answer: (request: Request) => Response) {
	const requests: Recorded[] = [];
	const client = createApiClient({
		baseUrl: BASE,
		openSocket: false,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			const text = await request.clone().text();
			requests.push({
				method: request.method,
				path: `${url.pathname}${url.search}`,
				body: text === "" ? undefined : JSON.parse(text),
			});
			return answer(request);
		},
	});
	return { client, requests };
}

const session = {
	id: "ses-1",
	organisationId: "org-1",
	projectId: "proj-1",
	agentId: "worker",
	createdAt: 0,
	updatedAt: 0,
	status: "idle",
};

describe("a session on a repository", () => {
	it("lists the repository's branches for the project", async () => {
		const { client, requests } = gateway(() =>
			Response.json({
				repo: "tvdavies/site",
				defaultBranch: "main",
				branches: [{ name: "main", commit: "a".repeat(40) }],
			}),
		);
		const branches = await client.branches!("proj-1", "tvdavies/site");
		expect(branches.defaultBranch).toBe("main");
		expect(requests).toEqual([
			{ method: "GET", path: "/v1/git/branches?projectId=proj-1&repo=tvdavies%2Fsite", body: undefined },
		]);
	});

	it("seeds a workspace from the branch, then starts the session on it with the repository as labels", async () => {
		const { client, requests } = gateway((request) =>
			new URL(request.url).pathname === "/v1/workspaces"
				? Response.json({ id: "ws-1" }, { status: 201 })
				: Response.json(session, { status: 201 }),
		);
		const id = await client.create({
			projectId: "proj-1",
			agentId: "worker",
			title: "Fix the build",
			repository: { repo: "tvdavies/site", branch: "feature/x" },
		});
		expect(id).toBe("ses-1");
		expect(requests).toEqual([
			{
				method: "POST",
				path: "/v1/workspaces",
				body: {
					projectId: "proj-1",
					seed: { name: "tvdavies/site", sources: [{ kind: "git", repo: "tvdavies/site", ref: "feature/x" }] },
				},
			},
			{
				method: "POST",
				path: "/v1/sessions",
				body: {
					projectId: "proj-1",
					agentId: "worker",
					title: "Fix the build",
					workspaceId: "ws-1",
					labels: { repo: "tvdavies/site", branch: "feature/x" },
				},
			},
		]);
	});

	it("starts no session when the workspace can't be seeded", async () => {
		const { client, requests } = gateway(() =>
			Response.json({ error: { code: "not_found", message: "no repository tvdavies/gone" } }, { status: 404 }),
		);
		await expect(
			client.create({
				projectId: "proj-1",
				agentId: "worker",
				repository: { repo: "tvdavies/gone", branch: "main" },
			}),
		).rejects.toThrow(/tvdavies\/gone/);
		expect(requests.map((request) => request.path)).toEqual(["/v1/workspaces"]);
	});

	it("starts a session without a workspace when no repository is chosen", async () => {
		const { client, requests } = gateway(() => Response.json(session, { status: 201 }));
		await client.create({ projectId: "proj-1", agentId: "worker" });
		expect(requests).toEqual([
			{ method: "POST", path: "/v1/sessions", body: { projectId: "proj-1", agentId: "worker" } },
		]);
	});
});
