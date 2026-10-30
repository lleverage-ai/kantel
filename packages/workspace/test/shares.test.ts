import {
	type CallContext,
	type FileShares,
	HarbourError,
	isHarbourError,
	type WorkspaceRecord,
} from "@harbour/contracts";
import { nodeSqliteDatabase, pgliteDatabase, type TestDatabase } from "@harbour/sql/testing";
import { actors, type ConformanceDeps, contextFor, createDeps } from "@harbour/testing/harness";
import { createMemoryWorkspaces } from "@harbour/workspace/memory";
import { createSqlFileShares, migrateFileShares } from "@harbour/workspace/shares";
import { createSharedLinkHandler, createSharesApi, type SharedFile } from "@harbour/workspace/shares-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORG = "org-1";
const PROJECT = "proj-1";
const operator = contextFor(actors.human("olive"), ORG, PROJECT);
const viewer = contextFor(actors.human("vera"), ORG, PROJECT);
const stranger = contextFor(actors.human("mallory"), "org-2");
const agent = contextFor(actors.agent("agent-1", "sess-1"), ORG, PROJECT);
const callers: { readonly [user: string]: CallContext } = { olive: operator, vera: viewer, mallory: stranger };

for (const kind of [nodeSqliteDatabase, pgliteDatabase]) {
	describe(`file shares on ${kind.name}`, { timeout: kind.testTimeoutMs }, () => {
		let database: TestDatabase;
		let deps: ConformanceDeps;
		let shares: FileShares;
		let workspace: WorkspaceRecord;
		let workspaces: ReturnType<typeof createMemoryWorkspaces>;

		beforeEach(async () => {
			database = await kind.open();
			await migrateFileShares(database.driver);
			await migrateFileShares(database.driver); // idempotent
			deps = createDeps();
			deps.tenancy.bind(operator.actor, ORG, "operator", PROJECT);
			deps.tenancy.bind(viewer.actor, ORG, "viewer", PROJECT);
			workspaces = createMemoryWorkspaces({ clock: deps.clock, audit: deps.audit, access: deps.access });
			workspace = await workspaces.create(operator, {
				owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
				seed: {
					name: "docs",
					sources: [
						{ kind: "files", files: { "documents/plan.md": "# Plan\n\n<script>x()</script>\n", "a.pdf": "%PDF" } },
					],
				},
			});
			shares = createSqlFileShares({
				driver: database.driver,
				workspaces,
				access: deps.access,
				audit: deps.audit,
				clock: deps.clock,
			});
		});
		afterEach(async () => {
			await database.close();
		});

		const codeOf = async (promise: Promise<unknown>) => {
			try {
				await promise;
				return "none";
			} catch (error) {
				return isHarbourError(error) ? error.code : String(error);
			}
		};

		it("shares a file once, restricted by default, and lists it with its invites", async () => {
			const share = await shares.share(operator, {
				workspaceId: workspace.id,
				path: "documents/plan.md",
				title: "Plan",
			});
			expect(share).toMatchObject({
				access: "restricted",
				path: "documents/plan.md",
				title: "Plan",
				createdBy: "olive",
			});
			expect(share.token.length).toBeGreaterThanOrEqual(40);
			// Sharing again is the same share.
			const again = await shares.share(operator, {
				workspaceId: workspace.id,
				path: "documents/plan.md",
				access: "link",
			});
			expect(again.id).toBe(share.id);
			expect(again.access).toBe("restricted");
			const invited = await shares.invite(operator, share.id, " Ann@Example.com ");
			await shares.invite(operator, share.id, "ann@example.com");
			expect(invited.invites.map((invite) => invite.email)).toEqual(["Ann@Example.com"]);
			expect((await shares.list(viewer, { workspaceId: workspace.id })).map((listed) => listed.id)).toEqual([share.id]);
			expect(await shares.list(viewer, { workspaceId: workspace.id, path: "a.pdf" })).toEqual([]);
			const removed = await shares.removeInvite(operator, share.id, "ANN@example.com");
			expect(removed.invites).toEqual([]);
			expect(deps.audit.events.filter((event) => event.type.startsWith("workspace.share.")).map((e) => e.type)).toEqual(
				["workspace.share.created", "workspace.share.invited", "workspace.share.uninvited"],
			);
			// The token never reaches the audit log.
			expect(JSON.stringify(deps.audit.events)).not.toContain(share.token);
		});

		it("opens a link only while its access is link and it isn't revoked", async () => {
			const share = await shares.share(operator, { workspaceId: workspace.id, path: "documents/plan.md" });
			const system = { actor: actors.system("test") };
			expect(await shares.open(system, share.token)).toBeUndefined();
			await shares.update(operator, share.id, { access: "link" });
			expect((await shares.open(system, share.token))?.id).toBe(share.id);
			await shares.update(operator, share.id, { access: "restricted" });
			expect(await shares.open(system, share.token)).toBeUndefined();
			await shares.update(operator, share.id, { access: "link" });
			const revoked = await shares.revoke(operator, share.id);
			expect(revoked.revokedAt).toBeDefined();
			expect(await shares.open(system, share.token)).toBeUndefined();
			expect(await codeOf(shares.update(operator, share.id, { access: "link" }))).toBe("conflict");
			// A new share of the same file is a new link.
			const next = await shares.share(operator, { workspaceId: workspace.id, path: "documents/plan.md" });
			expect(next.token).not.toBe(share.token);
			expect(await codeOf(shares.open(operator, share.token))).toBe("forbidden");
		});

		it("lets only a person with operator change a share, and only those who see the workspace read it", async () => {
			const input = { workspaceId: workspace.id, path: "documents/plan.md" };
			expect(await codeOf(shares.share(viewer, input))).toBe("forbidden");
			expect(await codeOf(shares.share(agent, input))).toBe("forbidden");
			expect(await codeOf(shares.share(stranger, input))).toBe("not_found");
			expect(await codeOf(shares.share(operator, { ...input, path: "missing.md" }))).toBe("not_found");
			expect(await codeOf(shares.share(operator, { ...input, path: "documents" }))).toBe("invalid");
			const share = await shares.share(operator, input);
			expect((await shares.get(viewer, share.id)).id).toBe(share.id);
			expect(await codeOf(shares.get(stranger, share.id))).toBe("not_found");
			expect(await codeOf(shares.update(viewer, share.id, { access: "link" }))).toBe("forbidden");
			expect(await codeOf(shares.revoke(agent, share.id))).toBe("forbidden");
			expect(await codeOf(shares.invite(operator, share.id, "not an email"))).toBe("invalid");
			expect(await codeOf(shares.update(operator, share.id, { access: "public" as never }))).toBe("invalid");
		});

		describe("the API and the link's page", () => {
			const BASE = "https://harbour.test";
			const api = () =>
				createSharesApi({
					shares,
					authenticate: async (request) => {
						const ctx = callers[request.headers.get("x-user") ?? ""];
						if (ctx === undefined) throw new HarbourError("forbidden", "who are you?");
						return ctx;
					},
				});
			const call = async (method: string, path: string, body?: unknown, user = "olive") => {
				const response = await api()(
					new Request(`${BASE}/v1${path}`, {
						method,
						headers: { "x-user": user, "content-type": "application/json" },
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
					}),
				);
				return { status: response?.status, body: (await response?.json()) as Record<string, unknown> };
			};
			const rendered: SharedFile[] = [];
			const link = () =>
				createSharedLinkHandler({
					shares,
					workspaces,
					renderPage: (file) => {
						rendered.push(file);
						return new Response("page");
					},
					renderMissing: () => new Response("missing", { status: 404 }),
				});

			it("shares, sets general access and serves the file to anyone with the link", async () => {
				const made = await call("POST", `/workspaces/${workspace.id}/shares`, {
					path: "documents/plan.md",
					title: "Plan",
				});
				expect(made.status).toBe(200);
				const id = made.body.id as string;
				const token = made.body.token as string;
				const listed = await call(
					"GET",
					`/workspaces/${workspace.id}/shares?path=documents%2Fplan.md`,
					undefined,
					"vera",
				);
				expect((listed.body.items as unknown[]).length).toBe(1);
				expect((await link()(new Request(`${BASE}/shared/${token}`)))?.status).toBe(404);
				expect((await call("PATCH", `/shares/${id}`, { access: "link" })).body.access).toBe("link");
				const page = await link()(new Request(`${BASE}/shared/${token}`));
				expect(page?.status).toBe(200);
				expect(rendered.at(-1)).toMatchObject({ name: "plan.md", contentType: "text/markdown; charset=utf-8" });
				expect(rendered.at(-1)?.share).toEqual({
					path: "documents/plan.md",
					title: "Plan",
					updatedAt: expect.any(Number),
				});
				const raw = await link()(new Request(`${BASE}/shared/${token}/raw`));
				expect(raw?.headers.get("content-security-policy")).toContain("sandbox");
				expect(await raw?.text()).toContain("# Plan");
				expect((await link()(new Request(`${BASE}/shared/${token}`, { method: "POST" })))?.status).toBe(405);
				expect(await link()(new Request(`${BASE}/v1/sessions`))).toBeUndefined();
				// The newest version: an edit after sharing is what the link shows.
				await workspaces.commit(operator, workspace.id, {
					baseVersion: (await workspaces.get(operator, workspace.id)).head,
					changes: [{ op: "put", path: "documents/plan.md", content: "# Plan v2\n" }],
				});
				expect(await (await link()(new Request(`${BASE}/shared/${token}/raw`)))?.text()).toBe("# Plan v2\n");
				expect((await call("POST", `/shares/${id}/invites`, { email: "ann@example.com" })).body.invites).toHaveLength(
					1,
				);
				expect((await call("POST", `/shares/${id}/invites/remove`, { email: "ann@example.com" })).body.invites).toEqual(
					[],
				);
				expect((await call("DELETE", `/shares/${id}`)).body.revokedAt).toEqual(expect.any(Number));
				expect((await link()(new Request(`${BASE}/shared/${token}`)))?.status).toBe(404);
				expect(await link()(new Request(`${BASE}/shared/not-a-token`))).toBeUndefined();
			});

			it("answers refusals with their status", async () => {
				expect((await call("POST", `/workspaces/${workspace.id}/shares`, { path: "a.pdf" }, "vera")).status).toBe(403);
				expect((await call("GET", "/shares/shr_missing")).status).toBe(404);
				expect((await call("POST", `/workspaces/${workspace.id}/shares`, {})).status).toBe(400);
			});
		});
	});
}
