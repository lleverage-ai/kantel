/**
 * Conformance suite for `IdentityDirectory`. Every target registers it with a provider that builds a fresh directory
 * wired to the case's clock and audit sink.
 */
import {
	type Actor,
	API_KEY_LAST_USED_PRECISION_MS,
	API_KEY_NAME_MAX_LENGTH,
	type CallContext,
	EMAIL_OTP_ISSUER,
	externalSubjectOf,
	type IdentityDirectory,
	type Organisation,
	type ProjectId,
	type Role,
	type ServiceIdentity,
	type SystemContext,
	type User,
} from "@harbour/contracts";
import {
	actors,
	assertAccessDenied,
	assertWorkerCallRefused,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceRunner,
	contextFor,
	createDeps,
	createExpectAssertions,
	registerCases,
	WORKER,
} from "./harness.ts";

export interface IdentitySubject {
	readonly identity: IdentityDirectory;
}

export type IdentityConformanceProvider = (
	deps: ConformanceDeps,
	use: (subject: IdentitySubject) => Promise<void>,
) => Promise<void>;

interface Tenant {
	readonly organisation: Organisation;
	readonly founder: User;
	/** The founder, acting organisation-wide. */
	readonly admin: CallContext;
}

/** Bootstraps an organisation the only way the contract allows: a system actor creates its founder, then the org. */
async function createTenant(identity: IdentityDirectory, name: string): Promise<Tenant> {
	const bootstrap = contextFor(actors.system("bootstrap"), "bootstrap");
	const founder = await identity.createUser(bootstrap, { name: `${name} founder` });
	const organisation = await identity.createOrganisation(bootstrap, {
		name,
		admin: { kind: "user", userId: founder.id },
	});
	return { organisation, founder, admin: contextFor(actors.human(founder.id), organisation.id) };
}

/** A new user holding `role` on `projectId` (or organisation-wide when absent). */
async function createMember(
	identity: IdentityDirectory,
	tenant: Tenant,
	role: Role,
	projectId?: ProjectId,
): Promise<Actor> {
	const user = await identity.createUser(tenant.admin, { name: `${role} user` });
	await identity.grantRole(tenant.admin, {
		principal: { kind: "user", userId: user.id },
		role,
		...(projectId === undefined ? {} : { projectId }),
	});
	return actors.human(user.id);
}

async function createService(identity: IdentityDirectory, tenant: Tenant): Promise<ServiceIdentity> {
	return identity.createServiceIdentity(tenant.admin, { name: "host app" });
}

export function createIdentityConformance(options: {
	assertions: ConformanceAssertions;
	provider: IdentityConformanceProvider;
}): readonly ConformanceCase[] {
	const a = options.assertions;
	const withSubject =
		(run: (subject: IdentitySubject, deps: ConformanceDeps) => Promise<void>): (() => Promise<void>) =>
		async () => {
			const deps = createDeps();
			await options.provider(deps, (subject) => run(subject, deps));
		};

	return [
		{
			name: "only a system actor creates an organisation, and its named admin can then create projects",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const founderPrincipal = { kind: "user", userId: tenant.founder.id } as const;
				await a.rejectsWithCode(
					identity.createOrganisation(tenant.admin, { name: "Rogue", admin: founderPrincipal }),
					"forbidden",
					"a human admin cannot create an organisation",
				);
				const service = await createService(identity, tenant);
				await a.rejectsWithCode(
					identity.createOrganisation(contextFor(actors.service(service.id), tenant.organisation.id), {
						name: "Rogue",
						admin: founderPrincipal,
					}),
					"forbidden",
					"a service cannot create an organisation",
				);
				a.strictEqual(await identity.roleOf(WORKER, actors.human(tenant.founder.id), tenant.organisation.id), "admin");
				const project = await identity.createProject(tenant.admin, { name: "Harbour" });
				a.strictEqual(project.organisationId, tenant.organisation.id);
				a.deepEqual(await identity.getProject(tenant.admin, project.id), project);
				a.deepEqual(await identity.getOrganisation(tenant.admin, tenant.organisation.id), tenant.organisation);
			}),
		},
		{
			name: "orders roles viewer < operator < admin: an operator passes a viewer check and fails an admin check",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const project = await identity.createProject(tenant.admin, { name: "P" });
				const operator = await createMember(identity, tenant, "operator", project.id);
				const ctx = contextFor(operator, tenant.organisation.id, project.id);
				await identity.authorize(ctx, "viewer");
				await identity.authorize(ctx, "operator");
				await a.rejectsWithCode(identity.authorize(ctx, "admin"), "forbidden");
				const viewer = await createMember(identity, tenant, "viewer", project.id);
				const viewerCtx = contextFor(viewer, tenant.organisation.id, project.id);
				await identity.authorize(viewerCtx, "viewer");
				await a.rejectsWithCode(identity.authorize(viewerCtx, "operator"), "forbidden");
			}),
		},
		{
			name: "an organisation-wide binding applies to every project of the organisation, including later ones",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const first = await identity.createProject(tenant.admin, { name: "First" });
				const operator = await createMember(identity, tenant, "operator");
				const second = await identity.createProject(tenant.admin, { name: "Second" });
				for (const project of [first, second]) {
					a.strictEqual(await identity.roleOf(WORKER, operator, tenant.organisation.id, project.id), "operator");
					await identity.authorize(contextFor(operator, tenant.organisation.id, project.id), "operator");
				}
				await identity.authorize(contextFor(operator, tenant.organisation.id), "operator");
			}),
		},
		{
			name: "a human's role on a project is the strongest of its project and organisation-wide bindings",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const first = await identity.createProject(tenant.admin, { name: "First" });
				const second = await identity.createProject(tenant.admin, { name: "Second" });
				const member = await createMember(identity, tenant, "viewer");
				if (member.kind !== "human") throw new Error("expected a human member");
				await identity.grantRole(tenant.admin, {
					principal: { kind: "user", userId: member.userId },
					role: "admin",
					projectId: first.id,
				});
				a.strictEqual(await identity.roleOf(WORKER, member, tenant.organisation.id, first.id), "admin");
				a.strictEqual(await identity.roleOf(WORKER, member, tenant.organisation.id, second.id), "viewer");
				a.strictEqual(await identity.roleOf(WORKER, member, tenant.organisation.id), "viewer");
			}),
		},
		{
			name: "granting a role replaces the existing binding for the same principal and scope",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const project = await identity.createProject(tenant.admin, { name: "P" });
				const member = await createMember(identity, tenant, "admin", project.id);
				if (member.kind !== "human") throw new Error("expected a human member");
				const principal = { kind: "user", userId: member.userId } as const;
				await identity.grantRole(tenant.admin, { principal, role: "viewer", projectId: project.id });
				a.strictEqual(await identity.roleOf(WORKER, member, tenant.organisation.id, project.id), "viewer");
				const bindings = await identity.listRoleBindings(tenant.admin, { projectId: project.id });
				const forMember = bindings.filter(
					(binding) => binding.principal.kind === "user" && binding.principal.userId === member.userId,
				);
				a.strictEqual(forMember.length, 1);
				a.partialDeepEqual(forMember[0], {
					role: "viewer",
					projectId: project.id,
					organisationId: tenant.organisation.id,
				});
			}),
		},
		{
			name: "revoking a role removes the access it gave",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const project = await identity.createProject(tenant.admin, { name: "P" });
				const member = await createMember(identity, tenant, "operator", project.id);
				if (member.kind !== "human") throw new Error("expected a human member");
				const ctx = contextFor(member, tenant.organisation.id, project.id);
				await identity.authorize(ctx, "operator");
				await identity.revokeRole(tenant.admin, {
					principal: { kind: "user", userId: member.userId },
					projectId: project.id,
				});
				await a.rejectsWithCode(identity.authorize(ctx, "viewer"), "forbidden");
				a.strictEqual(await identity.roleOf(WORKER, member, tenant.organisation.id, project.id), undefined);
			}),
		},
		{
			name: "a host key scoped to one project cannot act in another project of the same organisation",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const scoped = await identity.createProject(tenant.admin, { name: "Scoped" });
				const other = await identity.createProject(tenant.admin, { name: "Other" });
				const service = await createService(identity, tenant);
				// The service's own organisation-wide binding must not widen what its key may do.
				await identity.grantRole(tenant.admin, {
					principal: { kind: "service", serviceId: service.id },
					role: "admin",
				});
				const issued = await identity.issueApiKey(tenant.admin, {
					serviceId: service.id,
					projectIds: [scoped.id],
					role: "operator",
				});
				const auth = await identity.authenticateApiKey(WORKER, issued.secret);
				a.deepEqual(auth.actor, { kind: "service", serviceId: service.id, keyId: issued.key.id });
				a.strictEqual(auth.organisationId, tenant.organisation.id);
				a.deepEqual(auth.projectIds, [scoped.id]);
				a.strictEqual(auth.role, "operator");
				const org = tenant.organisation.id;
				await identity.authorize(contextFor(auth.actor, org, scoped.id), "operator");
				await a.rejectsWithCode(
					identity.authorize(contextFor(auth.actor, org, scoped.id), "admin"),
					"forbidden",
					"the key's role bounds it",
				);
				await a.rejectsWithCode(
					identity.authorize(contextFor(auth.actor, org, other.id), "viewer"),
					"forbidden",
					"the key cannot act in a project it is not scoped to",
				);
				await a.rejectsWithCode(
					identity.authorize(contextFor(auth.actor, org), "viewer"),
					"forbidden",
					"a project-scoped key has no organisation-wide role",
				);
				a.strictEqual(await identity.roleOf(WORKER, auth.actor, org, other.id), undefined);
				await a.rejectsWithCode(identity.createProject(contextFor(auth.actor, org), { name: "Sneaky" }), "forbidden");
			}),
		},
		{
			name: "a key's import permission: an organisation admin issues it, it is kept, and it widens no role",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const globex = await createTenant(identity, "Globex");
				const org = tenant.organisation.id;
				const project = await identity.createProject(tenant.admin, { name: "Imports" });
				const service = await createService(identity, tenant);
				const issued = await identity.issueApiKey(tenant.admin, {
					serviceId: service.id,
					projectIds: [project.id],
					role: "operator",
					permissions: ["import", "import"],
				});
				a.deepEqual(issued.key.permissions, ["import"], "each permission once");
				const listed = await identity.listApiKeys(tenant.admin);
				a.deepEqual(listed.find((key) => key.id === issued.key.id)?.permissions, ["import"], "the list keeps it");
				const { actor } = await identity.authenticateApiKey(WORKER, issued.secret);
				a.strictEqual(await identity.keyPermits(WORKER, actor, org, "import"), true);
				a.strictEqual(
					await identity.keyPermits(WORKER, actor, globex.organisation.id, "import"),
					false,
					"only in the key's own organisation",
				);
				// The permission is not a role: the key is still its role on its projects and nothing organisation-wide.
				a.strictEqual(await identity.roleOf(WORKER, actor, org), undefined);
				a.strictEqual(await identity.roleOf(WORKER, actor, org, project.id), "operator");
				await a.rejectsWithCode(identity.authorize(contextFor(actor, org), "viewer"), "forbidden");
				await a.rejectsWithCode(identity.createProject(contextFor(actor, org), { name: "Sneaky" }), "forbidden");

				// A key without it, the service's own sign-in and a person never permit an import.
				const plain = await identity.issueApiKey(tenant.admin, {
					serviceId: service.id,
					projectIds: [project.id],
					role: "admin",
				});
				a.strictEqual(plain.key.permissions, undefined);
				const plainActor = (await identity.authenticateApiKey(WORKER, plain.secret)).actor;
				a.strictEqual(await identity.keyPermits(WORKER, plainActor, org, "import"), false);
				a.strictEqual(await identity.keyPermits(WORKER, actors.service(service.id), org, "import"), false);
				a.strictEqual(await identity.keyPermits(WORKER, actors.human(tenant.founder.id), org, "import"), false);

				// Revoked, it permits nothing.
				await identity.revokeApiKey(tenant.admin, issued.key.id);
				a.strictEqual(await identity.keyPermits(WORKER, actor, org, "import"), false);

				// Only an organisation admin hands one out, and only a permission the contract names.
				const projectAdmin = await createMember(identity, tenant, "admin", project.id);
				const asProjectAdmin = contextFor(projectAdmin, org);
				await identity.issueApiKey(asProjectAdmin, {
					serviceId: service.id,
					projectIds: [project.id],
					role: "operator",
				});
				await a.rejectsWithCode(
					identity.issueApiKey(asProjectAdmin, {
						serviceId: service.id,
						projectIds: [project.id],
						role: "operator",
						permissions: ["import"],
					}),
					"forbidden",
					"a project admin cannot issue a key that imports into the organisation",
				);
				await a.rejectsWithCode(
					identity.issueApiKey(tenant.admin, {
						serviceId: service.id,
						projectIds: [project.id],
						role: "operator",
						permissions: ["admin"] as unknown as ["import"],
					}),
					"invalid",
				);
			}),
		},
		{
			name: "an organisation key holds its role on the organisation and every project in it, including later ones",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const org = tenant.organisation.id;
				const first = await identity.createProject(tenant.admin, { name: "First" });
				const service = await createService(identity, tenant);
				const issued = await identity.issueApiKey(tenant.admin, {
					serviceId: service.id,
					scope: "organisation",
					role: "operator",
					name: "Host app",
				});
				a.strictEqual(issued.key.scope, "organisation");
				a.deepEqual(issued.key.projectIds, [], "an organisation key names no project");
				const auth = await identity.authenticateApiKey(WORKER, issued.secret);
				a.strictEqual(auth.scope, "organisation");
				a.deepEqual(auth.projectIds, []);
				a.strictEqual(auth.role, "operator");
				const { actor } = auth;
				await identity.authorize(contextFor(actor, org), "operator");
				await identity.authorize(contextFor(actor, org, first.id), "operator");
				const later = await identity.createProject(tenant.admin, { name: "Later" });
				await identity.authorize(contextFor(actor, org, later.id), "operator");
				a.strictEqual(await identity.roleOf(WORKER, actor, org), "operator");
				a.strictEqual(await identity.roleOf(WORKER, actor, org, later.id), "operator");
				await a.rejectsWithCode(
					identity.authorize(contextFor(actor, org), "admin"),
					"forbidden",
					"the key's role bounds it",
				);
				const visible = await identity.listProjects(contextFor(actor, org));
				a.deepEqual(
					visible.items.map((project) => project.id).sort(),
					[first.id, later.id].sort(),
					"it sees every project of its organisation",
				);
				a.deepEqual(
					(await identity.listApiKeys(tenant.admin)).find((key) => key.id === issued.key.id)?.scope,
					"organisation",
					"the list keeps its scope",
				);
				// Without `create_projects` it makes no project, and it never manages roles or keys.
				await a.rejectsWithCode(identity.createProject(contextFor(actor, org), { name: "Sneaky" }), "forbidden");
				await a.rejectsWithCode(
					identity.grantRole(contextFor(actor, org), {
						principal: { kind: "service", serviceId: service.id },
						role: "admin",
					}),
					"forbidden",
				);
				await a.rejectsWithCode(
					identity.issueApiKey(contextFor(actor, org), {
						serviceId: service.id,
						projectIds: [first.id],
						role: "viewer",
					}),
					"forbidden",
				);
				// Revoked, it is nothing.
				await identity.revokeApiKey(tenant.admin, issued.key.id);
				a.strictEqual(await identity.roleOf(WORKER, actor, org), undefined);
				await a.rejectsWithCode(identity.authenticateApiKey(WORKER, issued.secret), "forbidden");
			}),
		},
		{
			name: "an organisation key is capped at operator, names no project, and only an organisation admin issues it",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const org = tenant.organisation.id;
				const project = await identity.createProject(tenant.admin, { name: "P" });
				const service = await createService(identity, tenant);
				const base = { serviceId: service.id, scope: "organisation" as const, role: "operator" as const };
				await a.rejectsWithCode(
					identity.issueApiKey(tenant.admin, { ...base, role: "admin" }),
					"invalid",
					"an organisation key's role is at most operator",
				);
				await a.rejectsWithCode(
					identity.issueApiKey(tenant.admin, { ...base, projectIds: [project.id] }),
					"invalid",
					"an organisation key names no project",
				);
				await a.rejectsWithCode(
					identity.issueApiKey(tenant.admin, { ...base, scope: "everywhere" as "organisation" }),
					"invalid",
				);
				await a.rejectsWithCode(
					identity.issueApiKey(tenant.admin, {
						serviceId: service.id,
						projectIds: [project.id],
						role: "operator",
						permissions: ["create_projects"],
					}),
					"invalid",
					"only an organisation key creates projects",
				);
				const viewerKey = await identity.issueApiKey(tenant.admin, { ...base, role: "viewer" });
				a.strictEqual(viewerKey.key.role, "viewer");

				// A project admin, an organisation operator and any key are refused one.
				const projectAdmin = contextFor(await createMember(identity, tenant, "admin", project.id), org);
				await a.rejectsWithCode(identity.issueApiKey(projectAdmin, base), "forbidden");
				const operator = contextFor(await createMember(identity, tenant, "operator"), org);
				await a.rejectsWithCode(identity.issueApiKey(operator, base), "forbidden");
				const projectKey = await identity.issueApiKey(tenant.admin, {
					serviceId: service.id,
					projectIds: [project.id],
					role: "admin",
				});
				const asProjectKey = (await identity.authenticateApiKey(WORKER, projectKey.secret)).actor;
				await a.rejectsWithCode(
					identity.issueApiKey(contextFor(asProjectKey, org), base),
					"forbidden",
					"a key cannot mint an organisation key",
				);

				// A project admin neither sees nor revokes one.
				a.strictEqual(
					(await identity.listApiKeys(projectAdmin)).some((key) => key.id === viewerKey.key.id),
					false,
				);
				await a.rejectsWithCode(identity.revokeApiKey(projectAdmin, viewerKey.key.id), "forbidden");
				await identity.revokeApiKey(tenant.admin, viewerKey.key.id);
			}),
		},
		{
			name: "an organisation key with create_projects creates projects in its own organisation only, and audited as itself",
			run: withSubject(async ({ identity }, { audit }) => {
				const acme = await createTenant(identity, "Acme");
				const globex = await createTenant(identity, "Globex");
				const org = acme.organisation.id;
				const service = await createService(identity, acme);
				const issued = await identity.issueApiKey(acme.admin, {
					serviceId: service.id,
					scope: "organisation",
					role: "operator",
					permissions: ["create_projects"],
				});
				const { actor } = await identity.authenticateApiKey(WORKER, issued.secret);
				const made = await identity.createProject(contextFor(actor, org), { name: "Customer 42" });
				a.strictEqual(made.organisationId, org);
				await identity.authorize(contextFor(actor, org, made.id), "operator");
				const created = audit.ofType("identity.project.created").at(-1);
				a.deepEqual(created?.actor, actor, "audited as the key");
				a.strictEqual(created?.organisationId, org);
				a.strictEqual(audit.ofType("identity.key.issued").at(-1)?.data?.scope, "organisation");

				// Not in another organisation, and not as a project admin either.
				await a.rejectsWithCode(
					identity.createProject(contextFor(actor, globex.organisation.id), { name: "Elsewhere" }),
					"forbidden",
				);
				await a.rejectsWithCode(identity.authorize(contextFor(actor, globex.organisation.id), "viewer"), "forbidden");
				await a.rejectsWithCode(identity.authorize(contextFor(actor, org, made.id), "admin"), "forbidden");
				a.strictEqual(await identity.keyPermits(WORKER, actor, org, "create_projects"), true);
				a.strictEqual(await identity.keyPermits(WORKER, actor, globex.organisation.id, "create_projects"), false);

				// Revoked, it creates nothing.
				await identity.revokeApiKey(acme.admin, issued.key.id);
				await a.rejectsWithCode(identity.createProject(contextFor(actor, org), { name: "Late" }), "forbidden");
			}),
		},
		{
			name: "a service actor without a key acts with its own role bindings",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const bound = await identity.createProject(tenant.admin, { name: "Bound" });
				const other = await identity.createProject(tenant.admin, { name: "Other" });
				const service = await createService(identity, tenant);
				await identity.grantRole(tenant.admin, {
					principal: { kind: "service", serviceId: service.id },
					role: "operator",
					projectId: bound.id,
				});
				const actor = actors.service(service.id);
				await identity.authorize(contextFor(actor, tenant.organisation.id, bound.id), "operator");
				await a.rejectsWithCode(
					identity.authorize(contextFor(actor, tenant.organisation.id, other.id), "viewer"),
					"forbidden",
				);
			}),
		},
		{
			name: "a key cannot act in another organisation",
			run: withSubject(async ({ identity }) => {
				const acme = await createTenant(identity, "Acme");
				const globex = await createTenant(identity, "Globex");
				const acmeProject = await identity.createProject(acme.admin, { name: "Acme project" });
				const globexProject = await identity.createProject(globex.admin, { name: "Globex project" });
				const service = await createService(identity, acme);
				const issued = await identity.issueApiKey(acme.admin, {
					serviceId: service.id,
					projectIds: [acmeProject.id],
					role: "admin",
				});
				const { actor } = await identity.authenticateApiKey(WORKER, issued.secret);
				await a.rejectsWithCode(
					identity.authorize(contextFor(actor, globex.organisation.id, globexProject.id), "viewer"),
					"forbidden",
				);
				await a.rejectsWithCode(
					identity.authorize(contextFor(actor, globex.organisation.id, acmeProject.id), "viewer"),
					"forbidden",
					"naming the key's own project under another organisation does not help",
				);
				await a.rejectsWithCode(
					identity.authorize(contextFor(actor, acme.organisation.id, globexProject.id), "viewer"),
					"forbidden",
					"naming another organisation's project under the key's organisation does not help",
				);
				a.strictEqual(await identity.roleOf(WORKER, actor, globex.organisation.id, globexProject.id), undefined);
				await a.rejectsWithCode(
					identity.issueApiKey(acme.admin, { serviceId: service.id, projectIds: [globexProject.id], role: "viewer" }),
					"not_found",
					"a key cannot be scoped to another organisation's project",
				);
			}),
		},
		{
			name: "a record from another organisation is not_found, and authorize across organisations is forbidden",
			run: withSubject(async ({ identity }) => {
				const acme = await createTenant(identity, "Acme");
				const globex = await createTenant(identity, "Globex");
				const globexProject = await identity.createProject(globex.admin, { name: "Globex project" });
				const globexService = await createService(identity, globex);
				const globexKey = await identity.issueApiKey(globex.admin, {
					serviceId: globexService.id,
					projectIds: [globexProject.id],
					role: "viewer",
				});
				await a.rejectsWithCode(identity.getOrganisation(acme.admin, globex.organisation.id), "not_found");
				await a.rejectsWithCode(identity.getProject(acme.admin, globexProject.id), "not_found");
				await a.rejectsWithCode(identity.revokeApiKey(acme.admin, globexKey.key.id), "not_found");
				await a.rejectsWithCode(
					identity.grantRole(acme.admin, {
						principal: { kind: "user", userId: acme.founder.id },
						role: "admin",
						projectId: globexProject.id,
					}),
					"not_found",
				);
				const acmeProject = await identity.createProject(acme.admin, { name: "Acme project" });
				await a.rejectsWithCode(
					identity.issueApiKey(acme.admin, {
						serviceId: globexService.id,
						projectIds: [acmeProject.id],
						role: "viewer",
					}),
					"not_found",
					"a key cannot be issued to another organisation's service",
				);
				a.strictEqual((await identity.listApiKeys(acme.admin)).length, 0);
				const acmeFounder = acme.admin.actor;
				await a.rejectsWithCode(
					identity.authorize(contextFor(acmeFounder, globex.organisation.id), "viewer"),
					"forbidden",
				);
				await a.rejectsWithCode(
					identity.authorize(contextFor(acmeFounder, acme.organisation.id, globexProject.id), "viewer"),
					"forbidden",
				);
				await identity.authenticateApiKey(WORKER, globexKey.secret);
			}),
		},
		{
			name: "returns a key's secret once and never lists or stores it in plain text",
			run: withSubject(async ({ identity }, deps) => {
				const tenant = await createTenant(identity, "Acme");
				const project = await identity.createProject(tenant.admin, { name: "P" });
				const service = await createService(identity, tenant);
				const issued = await identity.issueApiKey(tenant.admin, {
					serviceId: service.id,
					projectIds: [project.id],
					role: "operator",
				});
				a.ok(issued.secret.length > 0, "a secret is returned on issue");
				a.ok(!JSON.stringify(issued.key).includes(issued.secret), "the key record does not hold the secret");
				a.ok(issued.secret.startsWith(issued.key.prefix), "the prefix is the start of the secret");
				a.greaterThan(issued.secret.length, issued.key.prefix.length, "the prefix is shorter than the secret");
				const listed = await identity.listApiKeys(tenant.admin);
				a.strictEqual(listed.length, 1);
				a.deepEqual(listed[0], issued.key);
				a.ok(!JSON.stringify(listed).includes(issued.secret), "no listed record contains the secret");
				a.ok(
					!JSON.stringify(await identity.listApiKeys(tenant.admin, { serviceId: service.id })).includes(issued.secret),
				);
				a.ok(!JSON.stringify(deps.audit.events).includes(issued.secret), "no audit event contains the secret");
				const second = await identity.issueApiKey(tenant.admin, {
					serviceId: service.id,
					projectIds: [project.id],
					role: "operator",
				});
				a.ok(second.secret !== issued.secret, "each key gets its own secret");
			}),
		},
		{
			name: "revoked and expired keys fail with forbidden",
			run: withSubject(async ({ identity }, deps) => {
				const tenant = await createTenant(identity, "Acme");
				const project = await identity.createProject(tenant.admin, { name: "P" });
				const service = await createService(identity, tenant);
				const revoked = await identity.issueApiKey(tenant.admin, {
					serviceId: service.id,
					projectIds: [project.id],
					role: "operator",
				});
				const revokedActor = (await identity.authenticateApiKey(WORKER, revoked.secret)).actor;
				await identity.revokeApiKey(tenant.admin, revoked.key.id);
				await a.rejectsWithCode(identity.authenticateApiKey(WORKER, revoked.secret), "forbidden");
				await a.rejectsWithCode(
					identity.authorize(contextFor(revokedActor, tenant.organisation.id, project.id), "viewer"),
					"forbidden",
					"an actor resolved before revocation loses its access",
				);
				const listedRevoked = (await identity.listApiKeys(tenant.admin)).find((key) => key.id === revoked.key.id);
				a.ok(listedRevoked?.revokedAt !== undefined, "a revoked key is listed with its revocation time");

				const expiring = await identity.issueApiKey(tenant.admin, {
					serviceId: service.id,
					projectIds: [project.id],
					role: "operator",
					expiresAt: deps.clock.now() + 60_000,
				});
				const expiringActor = (await identity.authenticateApiKey(WORKER, expiring.secret)).actor;
				await identity.authorize(contextFor(expiringActor, tenant.organisation.id, project.id), "operator");
				deps.clock.advance(60_000);
				await a.rejectsWithCode(identity.authenticateApiKey(WORKER, expiring.secret), "forbidden");
				await a.rejectsWithCode(
					identity.authorize(contextFor(expiringActor, tenant.organisation.id, project.id), "viewer"),
					"forbidden",
				);
			}),
		},
		{
			name: "a key keeps the name it was issued with, trimmed, and an empty or overlong name is invalid",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const project = await identity.createProject(tenant.admin, { name: "P" });
				const service = await createService(identity, tenant);
				const base = { serviceId: service.id, projectIds: [project.id], role: "operator" } as const;
				const named = await identity.issueApiKey(tenant.admin, { ...base, name: "  Sal's supervisor " });
				a.strictEqual(named.key.name, "Sal's supervisor");
				const unnamed = await identity.issueApiKey(tenant.admin, base);
				a.strictEqual(unnamed.key.name, undefined, "a key issued without a name has none");
				const listed = await identity.listApiKeys(tenant.admin);
				a.strictEqual(listed.find((key) => key.id === named.key.id)?.name, "Sal's supervisor");
				a.ok(!("name" in (listed.find((key) => key.id === unnamed.key.id) ?? {})), "no name is listed as absent");
				await a.rejectsWithCode(identity.issueApiKey(tenant.admin, { ...base, name: "   " }), "invalid");
				await a.rejectsWithCode(
					identity.issueApiKey(tenant.admin, { ...base, name: "x".repeat(API_KEY_NAME_MAX_LENGTH + 1) }),
					"invalid",
				);
				a.strictEqual((await identity.listApiKeys(tenant.admin)).length, 2, "a refused name issues no key");
			}),
		},
		{
			name: "a key's last use is recorded when it authenticates, to within the precision",
			run: withSubject(async ({ identity }, deps) => {
				const tenant = await createTenant(identity, "Acme");
				const project = await identity.createProject(tenant.admin, { name: "P" });
				const service = await createService(identity, tenant);
				const issued = await identity.issueApiKey(tenant.admin, {
					serviceId: service.id,
					projectIds: [project.id],
					role: "operator",
				});
				const lastUsed = async () =>
					(await identity.listApiKeys(tenant.admin)).find((key) => key.id === issued.key.id)?.lastUsedAt;
				a.strictEqual(await lastUsed(), undefined, "a key never used has no last use");
				const first = deps.clock.now();
				await identity.authenticateApiKey(WORKER, issued.secret);
				a.strictEqual(await lastUsed(), first);
				deps.clock.advance(API_KEY_LAST_USED_PRECISION_MS / 2);
				await identity.authenticateApiKey(WORKER, issued.secret);
				a.strictEqual(await lastUsed(), first, "a use within the precision keeps the recorded time");
				const later = deps.clock.advance(API_KEY_LAST_USED_PRECISION_MS);
				await identity.authenticateApiKey(WORKER, issued.secret);
				a.strictEqual(await lastUsed(), later);
				await identity.revokeApiKey(tenant.admin, issued.key.id);
				deps.clock.advance(API_KEY_LAST_USED_PRECISION_MS * 2);
				await a.rejectsWithCode(identity.authenticateApiKey(WORKER, issued.secret), "forbidden");
				a.strictEqual(await lastUsed(), later, "a refused use is not recorded");
				a.ok(
					!deps.audit.events.some((event) => JSON.stringify(event).includes(issued.secret)),
					"no audit event holds the secret",
				);
			}),
		},
		{
			name: "an unknown key fails with forbidden, not not_found",
			run: withSubject(async ({ identity }) => {
				await createTenant(identity, "Acme");
				await a.rejectsWithCode(identity.authenticateApiKey(WORKER, "hbr_this-key-was-never-issued"), "forbidden");
				await a.rejectsWithCode(identity.authenticateApiKey(WORKER, ""), "forbidden");
			}),
		},
		{
			name: "a viewer cannot grant roles or issue keys",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const project = await identity.createProject(tenant.admin, { name: "P" });
				const service = await createService(identity, tenant);
				const issued = await identity.issueApiKey(tenant.admin, {
					serviceId: service.id,
					projectIds: [project.id],
					role: "viewer",
				});
				const viewer = contextFor(await createMember(identity, tenant, "viewer"), tenant.organisation.id);
				const principal = { kind: "user", userId: tenant.founder.id } as const;
				await a.rejectsWithCode(identity.grantRole(viewer, { principal, role: "viewer" }), "forbidden");
				await a.rejectsWithCode(
					identity.grantRole(viewer, { principal, role: "viewer", projectId: project.id }),
					"forbidden",
				);
				await a.rejectsWithCode(identity.revokeRole(viewer, { principal }), "forbidden");
				await a.rejectsWithCode(
					identity.issueApiKey(viewer, { serviceId: service.id, projectIds: [project.id], role: "viewer" }),
					"forbidden",
				);
				await a.rejectsWithCode(identity.revokeApiKey(viewer, issued.key.id), "forbidden");
				await a.rejectsWithCode(identity.createProject(viewer, { name: "Q" }), "forbidden");
				await a.rejectsWithCode(identity.createUser(viewer, { name: "Q" }), "forbidden");
				await a.rejectsWithCode(identity.createServiceIdentity(viewer, { name: "Q" }), "forbidden");
			}),
		},
		{
			name: "a project admin manages only its project: no keys over other projects, no organisation-wide grants",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const own = await identity.createProject(tenant.admin, { name: "Own" });
				const other = await identity.createProject(tenant.admin, { name: "Other" });
				const service = await createService(identity, tenant);
				const projectAdmin = contextFor(
					await createMember(identity, tenant, "admin", own.id),
					tenant.organisation.id,
					own.id,
				);
				const principal = { kind: "service", serviceId: service.id } as const;
				await identity.grantRole(projectAdmin, { principal, role: "operator", projectId: own.id });
				await identity.issueApiKey(projectAdmin, { serviceId: service.id, projectIds: [own.id], role: "operator" });
				await a.rejectsWithCode(
					identity.issueApiKey(projectAdmin, { serviceId: service.id, projectIds: [own.id, other.id], role: "viewer" }),
					"forbidden",
				);
				await a.rejectsWithCode(identity.grantRole(projectAdmin, { principal, role: "viewer" }), "forbidden");
				await a.rejectsWithCode(
					identity.grantRole(projectAdmin, { principal, role: "viewer", projectId: other.id }),
					"forbidden",
				);
				await a.rejectsWithCode(identity.createProject(projectAdmin, { name: "New" }), "forbidden");
			}),
		},
		{
			name: "an agent actor is never authorised by identity",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const project = await identity.createProject(tenant.admin, { name: "P" });
				const agent = actors.agent("agent-1", "session-1");
				for (const needed of ["viewer", "operator", "admin"] as const) {
					await a.rejectsWithCode(
						identity.authorize(contextFor(agent, tenant.organisation.id, project.id), needed),
						"forbidden",
					);
					await a.rejectsWithCode(identity.authorize(contextFor(agent, tenant.organisation.id), needed), "forbidden");
				}
				a.strictEqual(await identity.roleOf(WORKER, agent, tenant.organisation.id, project.id), undefined);
				await a.rejectsWithCode(
					identity.createProject(contextFor(agent, tenant.organisation.id), { name: "Q" }),
					"forbidden",
				);
				await identity.authorize(contextFor(actors.system(), tenant.organisation.id, project.id), "admin");
			}),
		},
		{
			name: "every mutation is audited with its actor, and no audit event contains a secret",
			run: withSubject(async ({ identity }, deps) => {
				const tenant = await createTenant(identity, "Acme");
				const audited = async <T>(label: string, mutation: () => Promise<T>): Promise<T> => {
					const before = deps.audit.events.length;
					const result = await mutation();
					a.greaterThan(deps.audit.events.length, before, `${label} is audited`);
					return result;
				};
				a.ok(deps.audit.events.length >= 2, "creating the founder and the organisation is audited");
				const project = await audited("createProject", () => identity.createProject(tenant.admin, { name: "P" }));
				const user = await audited("createUser", () => identity.createUser(tenant.admin, { name: "U" }));
				const service = await audited("createServiceIdentity", () => createService(identity, tenant));
				const principal = { kind: "user", userId: user.id } as const;
				await audited("grantRole", () =>
					identity.grantRole(tenant.admin, { principal, role: "operator", projectId: project.id }),
				);
				await audited("revokeRole", () => identity.revokeRole(tenant.admin, { principal, projectId: project.id }));
				const issued = await audited("issueApiKey", () =>
					identity.issueApiKey(tenant.admin, { serviceId: service.id, projectIds: [project.id], role: "viewer" }),
				);
				await audited("revokeApiKey", () => identity.revokeApiKey(tenant.admin, issued.key.id));

				const founderActor = tenant.admin.actor;
				for (const type of [
					"identity.role.granted",
					"identity.role.revoked",
					"identity.key.issued",
					"identity.key.revoked",
				]) {
					const events = deps.audit.ofType(type).filter((event) => event.organisationId === tenant.organisation.id);
					a.ok(events.length > 0, `${type} is emitted`);
					a.deepEqual(events.at(-1)?.actor, founderActor, `${type} names the acting admin`);
					a.strictEqual(events.at(-1)?.source, "identity");
				}
				for (const event of deps.audit.events) {
					a.ok(event.actor !== undefined && typeof event.actor.kind === "string", `${event.type} has an actor`);
				}
				a.ok(!JSON.stringify(deps.audit.events).includes(issued.secret), "no audit event contains a secret");
			}),
		},
		{
			name: "listProjects shows only projects the actor holds a role on",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const org = tenant.organisation.id;
				const first = await identity.createProject(tenant.admin, { name: "First" });
				const second = await identity.createProject(tenant.admin, { name: "Second" });
				const third = await identity.createProject(tenant.admin, { name: "Third" });
				const other = await createTenant(identity, "Globex");
				await identity.createProject(other.admin, { name: "Elsewhere" });
				const ids = async (actor: Actor): Promise<string[]> =>
					(await identity.listProjects(contextFor(actor, org))).items.map((project) => project.id).sort();

				a.deepEqual(await ids(tenant.admin.actor), [first.id, second.id, third.id].sort());
				a.deepEqual(await ids(await createMember(identity, tenant, "viewer", second.id)), [second.id]);
				const stranger = await identity.createUser(tenant.admin, { name: "Stranger" });
				a.deepEqual(await ids(actors.human(stranger.id)), []);
				a.deepEqual(await ids(other.admin.actor), [], "another organisation's admin sees none of these");

				const service = await createService(identity, tenant);
				const issued = await identity.issueApiKey(tenant.admin, {
					serviceId: service.id,
					projectIds: [third.id],
					role: "viewer",
				});
				a.deepEqual(await ids((await identity.authenticateApiKey(WORKER, issued.secret)).actor), [third.id]);
			}),
		},
		{
			name: "signIn finds a user by issuer and subject, links an invited user by verified email once, and refuses anyone else",
			run: withSubject(async ({ identity }, deps) => {
				const tenant = await createTenant(identity, "Acme");
				const issuer = "https://idp.example.test";
				const invited = await identity.createUser(tenant.admin, { name: "Ada", email: "Ada@Example.test" });
				const linked = await identity.createUser(tenant.admin, {
					name: "Grace",
					externalSubject: externalSubjectOf(issuer, "grace-sub"),
				});

				const found = await identity.signIn(WORKER, { issuer, subject: "grace-sub" });
				a.strictEqual(found.user.id, linked.id, "a linked user is found by issuer and subject");

				await a.rejectsWithCode(
					identity.signIn(WORKER, { issuer, subject: "ada-sub", email: "ada@example.test" }),
					"forbidden",
					"an unverified email links nobody",
				);
				await a.rejectsWithCode(
					identity.signIn(WORKER, { issuer: "https://other.example.test", subject: "grace-sub" }),
					"forbidden",
					"the same subject at another issuer is someone else",
				);
				await a.rejectsWithCode(
					identity.signIn(WORKER, { issuer, subject: "stranger", email: "nobody@example.test", emailVerified: true }),
					"forbidden",
					"sign-in never creates a user",
				);

				const before = deps.audit.ofType("identity.user.linked").length;
				const first = await identity.signIn(WORKER, {
					issuer,
					subject: "ada-sub",
					email: " ada@EXAMPLE.test",
					emailVerified: true,
				});
				a.strictEqual(first.user.id, invited.id, "a verified email links the invited user");
				a.strictEqual(first.user.externalSubject, externalSubjectOf(issuer, "ada-sub"));
				a.deepEqual((await identity.getUser(tenant.admin, invited.id)).externalSubject, first.user.externalSubject);
				const linkedEvents = deps.audit.ofType("identity.user.linked").slice(before);
				a.strictEqual(linkedEvents.length, 1, "linking is audited once");
				a.partialDeepEqual(linkedEvents[0], {
					actor: { kind: "human", userId: invited.id },
					organisationId: tenant.organisation.id,
					subject: { kind: "identity.user", id: invited.id },
				});

				const again = await identity.signIn(WORKER, { issuer, subject: "ada-sub" });
				a.strictEqual(again.user.id, invited.id, "the link holds without the email");
				await a.rejectsWithCode(
					identity.signIn(WORKER, {
						issuer,
						subject: "ada-other-device",
						email: "ada@example.test",
						emailVerified: true,
					}),
					"forbidden",
					"a linked user's email links no second subject",
				);
				a.strictEqual(deps.audit.ofType("identity.user.linked").length, before + 1, "nothing else was linked");

				const twinOne = await identity.createUser(tenant.admin, { name: "Twin one", email: "Twin@Example.test" });
				const twinTwo = await identity.createUser(tenant.admin, { name: "Twin two", email: " twin@example.TEST " });
				await a.rejectsWithCode(
					identity.signIn(WORKER, { issuer, subject: "twin", email: "twin@example.test", emailVerified: true }),
					"forbidden",
					"an email two unlinked users share once normalised links neither",
				);
				a.strictEqual((await identity.getUser(tenant.admin, twinOne.id)).externalSubject, undefined);
				a.strictEqual((await identity.getUser(tenant.admin, twinTwo.id)).externalSubject, undefined);
				await a.rejectsWithCode(identity.signIn(WORKER, { issuer: "", subject: "x" }), "invalid");
			}),
		},
		{
			name: "signIn compares issuer and subject exactly, and no two users share a subject",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const issuer = "https://idp.example.test/Realm";
				await identity.createUser(tenant.admin, {
					name: "Person",
					externalSubject: externalSubjectOf(issuer, "Person"),
				});
				await a.rejectsWithCode(
					identity.signIn(WORKER, { issuer, subject: "person" }),
					"forbidden",
					"a subject differing only in case is someone else",
				);
				await a.rejectsWithCode(
					identity.signIn(WORKER, { issuer: "https://idp.example.test/realm", subject: "Person" }),
					"forbidden",
					"an issuer differing only in case is another issuer",
				);
				await a.rejectsWithCode(
					identity.createUser(tenant.admin, { name: "Copy", externalSubject: externalSubjectOf(issuer, "Person") }),
					"conflict",
					"a second user cannot take the same subject",
				);
				a.strictEqual((await identity.signIn(WORKER, { issuer, subject: "Person" })).user.name, "Person");
			}),
		},
		{
			name: "signIn lists the organisations the user was created in or holds a role in",
			run: withSubject(async ({ identity }) => {
				const home = await createTenant(identity, "Home");
				const away = await createTenant(identity, "Away");
				const elsewhere = await createTenant(identity, "Elsewhere");
				const issuer = "https://idp.example.test";
				const user = await identity.createUser(home.admin, {
					name: "Member",
					externalSubject: externalSubjectOf(issuer, "member"),
				});
				const awayProject = await identity.createProject(away.admin, { name: "P" });
				await identity.grantRole(away.admin, {
					principal: { kind: "user", userId: user.id },
					role: "viewer",
					projectId: awayProject.id,
				});
				const { organisationIds } = await identity.signIn(WORKER, { issuer, subject: "member" });
				a.deepEqual(
					[...organisationIds].sort(),
					[home.organisation.id, away.organisation.id].sort(),
					"home and the organisation with a role, not a third",
				);
				a.ok(!organisationIds.includes(elsewhere.organisation.id));
			}),
		},
		{
			name: "canSignIn answers what signIn would, without linking or auditing anyone",
			run: withSubject(async ({ identity }, deps) => {
				const tenant = await createTenant(identity, "Acme");
				const issuer = EMAIL_OTP_ISSUER;
				const otp = (email: string) => ({ issuer, subject: email, email, emailVerified: true });
				const invited = await identity.createUser(tenant.admin, { name: "Ada", email: "Ada@Example.test" });
				await identity.createUser(tenant.admin, {
					name: "Grace",
					email: "grace@example.test",
					externalSubject: externalSubjectOf(issuer, "grace@example.test"),
				});
				await identity.createUser(tenant.admin, {
					name: "Linked elsewhere",
					email: "linked@example.test",
					externalSubject: externalSubjectOf("https://idp.example.test", "linked"),
				});
				await identity.createUser(tenant.admin, { name: "Twin one", email: "twin@example.test" });
				await identity.createUser(tenant.admin, { name: "Twin two", email: "TWIN@example.test" });
				// Three unlinked users share the email a fourth is linked by.
				for (const name of ["Shared one", "Shared two", "Shared three"]) {
					await identity.createUser(tenant.admin, { name, email: "Shared@example.test" });
				}
				const sharedLinked = await identity.createUser(tenant.admin, {
					name: "Shared, linked",
					email: "shared@example.test",
					externalSubject: externalSubjectOf(issuer, "shared@example.test"),
				});
				const auditedBefore = deps.audit.events.length;

				a.strictEqual(await identity.canSignIn(WORKER, otp("ada@example.test")), true, "an invited email");
				a.strictEqual(await identity.canSignIn(WORKER, otp("grace@example.test")), true, "a linked subject");
				a.strictEqual(await identity.canSignIn(WORKER, otp("nobody@example.test")), false, "a stranger");
				a.strictEqual(
					await identity.canSignIn(WORKER, otp("linked@example.test")),
					false,
					"a user linked to another subject",
				);
				a.strictEqual(await identity.canSignIn(WORKER, otp("twin@example.test")), false, "an email two users share");
				a.strictEqual(
					await identity.canSignIn(WORKER, otp("shared@example.test")),
					true,
					"a linked subject wins however many unlinked users share its email",
				);
				a.strictEqual(
					await identity.canSignIn(WORKER, { issuer, subject: "ada@example.test", email: "ada@example.test" }),
					false,
					"an unverified email",
				);
				a.strictEqual(await identity.canSignIn(WORKER, { issuer: "", subject: "x" }), false, "a malformed identity");
				a.strictEqual(deps.audit.events.length, auditedBefore, "nothing was audited");
				a.strictEqual(
					(await identity.getUser(tenant.admin, invited.id)).externalSubject,
					undefined,
					"nobody was linked",
				);
				a.strictEqual(
					(await identity.signIn(WORKER, otp("shared@example.test"))).user.id,
					sharedLinked.id,
					"signIn agrees",
				);

				await assertWorkerCallRefused(
					a,
					deps,
					"identity.canSignIn",
					(ctx) => identity.canSignIn(ctx, otp("ada@example.test")),
					tenant.organisation.id,
				);
			}),
		},
		{
			name: "worker calls: signIn refuses every caller but system",
			run: withSubject(async ({ identity }, deps) => {
				const tenant = await createTenant(identity, "Acme");
				const issuer = "https://idp.example.test";
				await identity.createUser(tenant.admin, { name: "U", externalSubject: externalSubjectOf(issuer, "u") });
				await assertWorkerCallRefused(
					a,
					deps,
					"identity.signIn",
					(ctx) => identity.signIn(ctx, { issuer, subject: "u" }),
					tenant.organisation.id,
				);
				a.ok((await identity.signIn(WORKER, { issuer, subject: "u" })).user !== undefined);
			}),
		},
		{
			name: "worker calls: roleOf, keyPermits and authenticateApiKey refuse every caller but system",
			run: withSubject(async ({ identity }, deps) => {
				const tenant = await createTenant(identity, "Acme");
				const org = tenant.organisation.id;
				const project = await identity.createProject(tenant.admin, { name: "Harbour" });
				const service = await createService(identity, tenant);
				const issued = await identity.issueApiKey(tenant.admin, {
					serviceId: service.id,
					projectIds: [project.id],
					role: "operator",
				});
				const founder = actors.human(tenant.founder.id);
				// The founder may do anything in the organisation, and still may not make a worker call.
				const callers = [
					{ label: "no caller", ctx: undefined as unknown as SystemContext },
					{ label: "the organisation's admin", ctx: tenant.admin },
					{ label: "a service", ctx: contextFor(actors.service(service.id), org, project.id) },
					{ label: "an agent", ctx: contextFor(actors.agent("agent-1", "session-1"), org, project.id) },
				];
				for (const { label, ctx } of callers) {
					for (const [operation, call] of [
						["identity.roleOf", () => identity.roleOf(ctx, founder, org)],
						["identity.authenticateApiKey", () => identity.authenticateApiKey(ctx, issued.secret)],
						["identity.keyPermits", () => identity.keyPermits(ctx, founder, org, "import")],
					] as const) {
						// Started after the audit is counted: the refusal may be audited before the call first awaits.
						const deferred = Promise.resolve().then((): Promise<unknown> => call());
						await assertAccessDenied(a, deps, deferred, { operation, message: `${operation} refuses ${label}` });
					}
				}
				a.ok(!JSON.stringify(deps.audit.events).includes(issued.secret), "no refusal audits the key's secret");
				a.strictEqual(await identity.roleOf(WORKER, founder, org), "admin");
				a.strictEqual((await identity.authenticateApiKey(WORKER, issued.secret)).role, "operator");
			}),
		},
		{
			name: "keeps a person's own settings: a change keeps what it leaves out, null clears, they follow the person",
			run: withSubject(async ({ identity }) => {
				const tenant = await createTenant(identity, "Acme");
				const viewer = await createMember(identity, tenant, "viewer");
				const ctx = contextFor(viewer, tenant.organisation.id);
				a.deepEqual(await identity.userPreferences(ctx), {}, "nobody has settings at first");
				a.deepEqual(await identity.setUserPreferences(ctx, { theme: "catppuccin-latte" }), {
					theme: "catppuccin-latte",
				});
				a.deepEqual(await identity.setUserPreferences(ctx, {}), { theme: "catppuccin-latte" }, "{} changes nothing");
				a.deepEqual(await identity.userPreferences(ctx), { theme: "catppuccin-latte" });
				a.deepEqual(await identity.userPreferences(tenant.admin), {}, "another person's are their own");

				// They are the person's, not the organisation's: the same person in another organisation has them too.
				const other = await createTenant(identity, "Other");
				const userId = viewer.kind === "human" ? viewer.userId : "";
				await identity.grantRole(other.admin, { principal: { kind: "user", userId }, role: "viewer" });
				a.deepEqual(await identity.userPreferences(contextFor(viewer, other.organisation.id)), {
					theme: "catppuccin-latte",
				});

				a.deepEqual(await identity.setUserPreferences(ctx, { theme: "system" }), { theme: "system" });
				a.deepEqual(await identity.setUserPreferences(ctx, { theme: null }), {}, "null clears the theme");
				for (const bad of [{ theme: "Not a theme" }, { theme: 3 }, { colour: "red" }, [] as unknown, null]) {
					await a.rejectsWithCode(
						identity.setUserPreferences(ctx, bad as never),
						"invalid",
						`refuses ${JSON.stringify(bad)}`,
					);
				}

				const service = await createService(identity, tenant);
				const serviceCtx = contextFor(actors.service(service.id), tenant.organisation.id);
				await a.rejectsWithCode(identity.userPreferences(serviceCtx), "forbidden", "a service has no settings");
				await a.rejectsWithCode(identity.setUserPreferences(serviceCtx, { theme: "nord" }), "forbidden");
				const stranger = await identity.createUser(tenant.admin, { name: "no role" });
				await a.rejectsWithCode(
					identity.userPreferences(contextFor(actors.human(stranger.id), tenant.organisation.id)),
					"forbidden",
					"a person with no role in the organisation is refused",
				);
			}),
		},
	];
}

export function registerIdentityConformance(
	runner: ConformanceRunner,
	name: string,
	provider: IdentityConformanceProvider,
): void {
	registerCases(
		runner,
		name,
		createIdentityConformance({ assertions: createExpectAssertions(runner.expect), provider }),
	);
}
