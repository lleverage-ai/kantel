import {
	type CallContext,
	callContextFor,
	externalSubjectOf,
	type IdentityDirectory,
	isHarbourError,
	type Project,
	systemContext,
} from "@harbour/contracts";
import { createAuthenticator } from "@harbour/identity/authenticator";
import { createSqlIdentity, migrateIdentity } from "@harbour/identity/sql";
import { createMemoryRuntime } from "@harbour/runtime/memory";
import { createScriptedModel } from "@harbour/runtime/testing";
import type { SqlDriver } from "@harbour/sql";
import { type TestDatabaseKind, testDatabaseKinds } from "@harbour/sql/testing";
import { ManualClock, RecordingAuditSink } from "@harbour/testing/harness";
import { describe, expect, it } from "vitest";

const WORKER = systemContext("identity.test");
const bootstrap: CallContext = { actor: { kind: "system", component: "bootstrap" }, organisationId: "bootstrap" };
const issuer = "https://idp.example.test";

/** An organisation with a founder, two projects and a host app's service, made through `identity`. */
async function tenant(identity: IdentityDirectory) {
	const founder = await identity.createUser(bootstrap, { name: "Founder", email: "founder@example.test" });
	const organisation = await identity.createOrganisation(bootstrap, {
		name: "Org",
		admin: { kind: "user", userId: founder.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: founder.id }, organisationId: organisation.id };
	const alpha = await identity.createProject(admin, { name: "alpha" });
	const beta = await identity.createProject(admin, { name: "beta" });
	const service = await identity.createServiceIdentity(admin, { name: "Sal's supervisor" });
	return { founder, organisation, admin, alpha, beta, service };
}

async function withDatabase(kind: TestDatabaseKind, run: (driver: SqlDriver) => Promise<void>): Promise<void> {
	const database = await kind.open();
	try {
		await migrateIdentity(database.driver);
		await run(database.driver);
	} finally {
		await database.close();
	}
}

const request = (headers: Record<string, string>) => new Request("https://harbour.test/v1/sessions", { headers });

for (const kind of testDatabaseKinds()) {
	describe(`SQL identity on ${kind.name}`, () => {
		it("keeps organisations, users, bindings and keys across directory instances, and a revocation holds on both", async () => {
			await withDatabase(kind, async (driver) => {
				await migrateIdentity(driver);
				const clock = new ManualClock();
				const first = createSqlIdentity({ driver, clock });
				const { founder, organisation, admin, alpha, beta, service } = await tenant(first);
				const member = await first.createUser(admin, { name: "Member" });
				const principal = { kind: "user", userId: member.id } as const;
				await first.grantRole(admin, { principal, role: "operator", projectId: alpha.id });
				const kept = await first.issueApiKey(admin, { serviceId: service.id, projectIds: [alpha.id], role: "viewer" });
				const doomed = await first.issueApiKey(admin, {
					serviceId: service.id,
					projectIds: [alpha.id, beta.id],
					role: "operator",
				});

				const second = createSqlIdentity({ driver, clock });
				expect(await second.getOrganisation(admin, organisation.id)).toEqual(organisation);
				expect(await second.getUser(admin, founder.id)).toEqual(founder);
				expect(await second.getProject(admin, alpha.id)).toEqual(alpha);
				expect((await second.listProjects(admin)).items).toEqual([alpha, beta]);
				expect(await second.roleOf(WORKER, admin.actor, organisation.id)).toBe("admin");
				expect(await second.roleOf(WORKER, { kind: "human", userId: member.id }, organisation.id, alpha.id)).toBe(
					"operator",
				);
				expect(await second.listRoleBindings(admin, { projectId: alpha.id })).toEqual([
					{
						organisationId: organisation.id,
						projectId: alpha.id,
						principal,
						role: "operator",
						grantedAt: clock.now(),
						grantedBy: admin.actor,
					},
				]);
				expect(await second.listApiKeys(admin)).toEqual([kept.key, doomed.key]);

				expect(await second.authenticateApiKey(WORKER, kept.secret)).toEqual({
					actor: { kind: "service", serviceId: service.id, keyId: kept.key.id },
					organisationId: organisation.id,
					projectIds: [alpha.id],
					role: "viewer",
				});
				const doomedActor = (await second.authenticateApiKey(WORKER, doomed.secret)).actor;
				await second.authorize({ actor: doomedActor, organisationId: organisation.id, projectId: beta.id }, "operator");

				await first.revokeApiKey(admin, doomed.key.id);
				await expect(second.authenticateApiKey(WORKER, doomed.secret)).rejects.toMatchObject({ code: "forbidden" });
				await expect(
					second.authorize({ actor: doomedActor, organisationId: organisation.id, projectId: beta.id }, "viewer"),
				).rejects.toMatchObject({ code: "forbidden" });
				expect((await second.listApiKeys(admin)).find((key) => key.id === doomed.key.id)?.revokedAt).toBe(clock.now());
				await second.revokeApiKey(admin, doomed.key.id);

				await second.revokeApiKey(admin, kept.key.id);
				await expect(first.authenticateApiKey(WORKER, kept.secret)).rejects.toMatchObject({ code: "forbidden" });

				// A grant on one instance replaces the binding the other made, and both see one binding.
				await second.grantRole(admin, { principal, role: "viewer", projectId: alpha.id });
				expect(await first.roleOf(WORKER, { kind: "human", userId: member.id }, organisation.id, alpha.id)).toBe(
					"viewer",
				);
				const forMember = (await first.listRoleBindings(admin, { projectId: alpha.id })).filter(
					(binding) => binding.principal.kind === "user" && binding.principal.userId === member.id,
				);
				expect(forMember).toHaveLength(1);
				await first.revokeRole(admin, { principal, projectId: alpha.id });
				expect(
					await second.roleOf(WORKER, { kind: "human", userId: member.id }, organisation.id, alpha.id),
				).toBeUndefined();
			});
		});

		it("pages listProjects in creation order, each project once", async () => {
			await withDatabase(kind, async (driver) => {
				const identity = createSqlIdentity({ driver, clock: new ManualClock() });
				const { admin, alpha, beta } = await tenant(identity);
				const more: Project[] = [];
				for (let index = 0; index < 5; index += 1) {
					more.push(await identity.createProject(admin, { name: `project ${index}` }));
				}
				const expected = [alpha, beta, ...more].map((project) => project.id);
				const seen: string[] = [];
				let cursor: string | undefined;
				do {
					const page = await identity.listProjects(admin, { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
					seen.push(...page.items.map((project) => project.id));
					cursor = page.nextCursor;
				} while (cursor !== undefined);
				expect(seen).toEqual(expected);
				await expect(identity.listProjects(admin, { cursor: "prj_unknown" })).rejects.toMatchObject({
					code: "invalid",
				});
			});
		});

		it("M1-BE7 definition of done: a host key scoped to alpha cannot reach beta's sessions, though its service could", async () => {
			await withDatabase(kind, async (driver) => {
				const identity = createSqlIdentity({ driver, clock: new ManualClock() });
				const { organisation, admin, alpha, beta, service } = await tenant(identity);
				const { models } = createScriptedModel();
				// A second directory instance on the same database serves the runtime, as another worker would.
				const memory = createMemoryRuntime({
					models,
					identity: createSqlIdentity({ driver, clock: new ManualClock() }),
				});
				try {
					// The service holds operator across the whole organisation; its key is still limited to alpha.
					await identity.grantRole(admin, { principal: { kind: "service", serviceId: service.id }, role: "operator" });
					const issued = await identity.issueApiKey(admin, {
						serviceId: service.id,
						projectIds: [alpha.id],
						role: "operator",
					});
					const system = { ...systemContext("test"), organisationId: organisation.id };
					await memory.profiles.put(system, {
						id: "worker",
						organisationId: organisation.id,
						name: "Worker",
						model: { route: "default" },
						promptLayers: [],
						tools: [],
						skills: [],
						sandbox: { tiers: ["isolate"] },
						memoryScopes: [],
					});
					const inAlpha = await memory.runtime.create(system, { projectId: alpha.id, agentId: "worker" });
					const inBeta = await memory.runtime.create(system, { projectId: beta.id, agentId: "worker" });

					const caller = await createAuthenticator({ identity }).authenticate(
						request({ authorization: `Bearer ${issued.secret}` }),
					);
					const ctx = callContextFor(caller);

					expect((await memory.directory.get(callContextFor(caller, { projectId: alpha.id }), inAlpha.id)).id).toBe(
						inAlpha.id,
					);
					let refused: unknown;
					try {
						await memory.directory.get(callContextFor(caller, { projectId: beta.id }), inBeta.id);
					} catch (error) {
						refused = error;
					}
					expect(isHarbourError(refused, "forbidden")).toBe(true);
					const listed = await memory.directory.list(ctx);
					expect(listed.items.map((session) => session.id)).toEqual([inAlpha.id]);
					await expect(memory.runtime.create(ctx, { projectId: beta.id, agentId: "worker" })).rejects.toMatchObject({
						code: "forbidden",
					});
				} finally {
					await memory.close();
				}
			});
		});

		it("signIn links by verified email on one instance, then finds the user by subject on another", async () => {
			await withDatabase(kind, async (driver) => {
				const clock = new ManualClock();
				const audit = new RecordingAuditSink();
				const first = createSqlIdentity({ driver, clock, audit });
				const { organisation, admin } = await tenant(first);
				const invited = await first.createUser(admin, { name: "Ada", email: " Ada@Example.test " });

				const second = createSqlIdentity({ driver, clock, audit });
				const linked = await second.signIn(WORKER, {
					issuer,
					subject: "ada-sub",
					email: "ada@EXAMPLE.test",
					emailVerified: true,
				});
				expect(linked.user.id).toBe(invited.id);
				expect(linked.user.externalSubject).toBe(externalSubjectOf(issuer, "ada-sub"));
				expect(linked.organisationIds).toEqual([organisation.id]);
				expect(audit.ofType("identity.user.linked")).toHaveLength(1);

				const third = createSqlIdentity({ driver, clock, audit });
				const again = await third.signIn(WORKER, { issuer, subject: "ada-sub" });
				expect(again.user).toEqual(linked.user);
				expect((await first.getUser(admin, invited.id)).externalSubject).toBe(externalSubjectOf(issuer, "ada-sub"));
				await expect(
					first.signIn(WORKER, { issuer, subject: "ada-other", email: "ada@example.test", emailVerified: true }),
				).rejects.toMatchObject({ code: "forbidden" });
				expect(audit.ofType("identity.user.linked")).toHaveLength(1);

				await expect(
					third.createUser(admin, { name: "Copy", externalSubject: externalSubjectOf(issuer, "ada-sub") }),
				).rejects.toMatchObject({ code: "conflict" });
			});
		});

		it("two instances racing to give users the same subject: one wins, the other is a conflict", async () => {
			await withDatabase(kind, async (driver) => {
				const clock = new ManualClock();
				const first = createSqlIdentity({ driver, clock });
				const second = createSqlIdentity({ driver, clock });
				const { admin } = await tenant(first);
				const externalSubject = externalSubjectOf(issuer, "contested");
				const results = await Promise.allSettled([
					first.createUser(admin, { name: "One", externalSubject }),
					second.createUser(admin, { name: "Two", externalSubject }),
				]);
				expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
				const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
				expect(rejected).toHaveLength(1);
				expect(isHarbourError(rejected[0]?.reason, "conflict")).toBe(true);
				const winner = await first.signIn(WORKER, { issuer, subject: "contested" });
				expect(["One", "Two"]).toContain(winner.user.name);
			});
		});
	});
}
