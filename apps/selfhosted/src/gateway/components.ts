// The components the self-hosted gateway serves, in memory: what the in-process tests run on, and what the gateway
// runs without a database. The stack's gateway runs the real implementations instead (durable.ts). Either way they
// share one audit store and one access check, as a real deployment's do.
//
// The gateway serves the compute plane (compute.ts) behind Kantel's identity: who is signed in, their organisation,
// projects and keys, email one-time PIN sign-in and the audit log. The agent plane (sessions, models, connections,
// rules and approvals, the vault, skills, memory, browsers) was removed; its tables, on a database an older version
// used, are left as they are and never read.
import { createMemoryAuditStore } from "@kantel/audit/memory";
import type { ComputeStore } from "@kantel/compute";
import {
	type AuditStore,
	type Authentication,
	type CallContext,
	createProjectAccess,
	EMAIL_OTP_ISSUER,
	externalSubjectOf,
	type IdentityDirectory,
	KantelError,
	normaliseEmail,
	type OrganisationId,
	PLATFORM_ORGANISATION,
	type Project,
	type ProjectAccess,
	type ProjectId,
} from "@kantel/contracts";
import type { HostsService } from "@kantel/hosts/service";
import { createMemoryHostStore } from "@kantel/hosts/store";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { createMemoryOtpStores, type OtpCodeStore, type SessionStore } from "@kantel/identity/otp";
import { type ComputeHostsConfig, gatewayHosts } from "./compute.ts";

const BOOTSTRAP: CallContext = {
	actor: { kind: "system", component: "selfhosted-bootstrap" },
	organisationId: PLATFORM_ORGANISATION,
};

export interface GatewayComponents {
	readonly identity: IdentityDirectory;
	readonly audit: AuditStore;
	/** Email one-time PIN codes and the Kantel sessions they start (@kantel/identity/otp). */
	readonly otp: { readonly codes: OtpCodeStore; readonly sessions: SessionStore };
	/**
	 * The compute plane's hosts (`compute.ts`, @kantel/hosts): machines running `kantel-host` and the sandboxes placed
	 * on them. Absent on the stub backend (`KANTEL_COMPUTE_BACKEND=stub`, or no address hosts can reach).
	 */
	readonly computeHosts?: HostsService;
	/**
	 * Where the compute API keeps its records (`compute.ts`): Postgres with a database, so they outlast a restart and
	 * gateways over one database share them. Absent in memory, where the API makes its own.
	 */
	readonly computeStore?: ComputeStore;
	/** Which implementation backs each contract, served at `/v1/deployment` and recorded beside conformance runs. */
	readonly bindings: { readonly [contract: string]: string };
	close(): Promise<void>;
}

/**
 * A `ProjectAccess` whose check is supplied later. The audit store takes its check at construction, but the check
 * reads role bindings from identity, and identity needs the audit store as its sink.
 */
export function deferredAccess(): { access: ProjectAccess; set(target: ProjectAccess): void } {
	let target: ProjectAccess | undefined;
	const need = (): ProjectAccess => {
		if (target === undefined) throw new KantelError("unavailable", "Project access is not ready");
		return target;
	};
	return {
		access: {
			require: (ctx, check) => need().require(ctx, check),
			allows: (ctx, check) => need().allows(ctx, check),
			resource: (ctx, check) => need().resource(ctx, check),
			allowsResource: (ctx, check) => need().allowsResource(ctx, check),
		},
		set: (access) => {
			target = access;
		},
	};
}

/**
 * The deployment's access check: identity's role bindings and keys. There are no sessions any more, so a check that
 * names one finds none.
 */
export function identityAccess(identity: IdentityDirectory, audit: AuditStore): ProjectAccess {
	return createProjectAccess({
		identity,
		sessions: {
			get: async () => {
				throw new KantelError("not_found", "This deployment has no sessions");
			},
		},
		audit,
	});
}

export function createGatewayComponents(
	options: {
		/** The compute plane's hosts (`compute.ts`), their registry in memory. Without it, there are none. */
		readonly computeHosts?: ComputeHostsConfig;
	} = {},
): GatewayComponents {
	const auditAccess = deferredAccess();
	const audit = createMemoryAuditStore({ access: auditAccess.access });
	const identity = createMemoryIdentity({ audit });
	auditAccess.set(identityAccess(identity, audit));
	const computeHosts =
		options.computeHosts === undefined ? undefined : gatewayHosts(options.computeHosts, createMemoryHostStore());
	return {
		identity,
		audit,
		otp: createMemoryOtpStores(),
		...(computeHosts === undefined ? {} : { computeHosts }),
		bindings: {
			identity: "memory",
			audit: "memory",
			signIn: "memory",
			...(computeHosts === undefined ? {} : { computeHosts: "memory" }),
		},
		close: async () => {
			computeHosts?.close();
		},
	};
}

export interface Bootstrap {
	readonly organisationId: OrganisationId;
	readonly projectId: ProjectId;
	/** An operator key on the project, for host apps and the end-to-end test. Its secret is shown only here. */
	readonly apiKey: string;
	/**
	 * The email `inviteAdmin` finished inviting into this organisation, normalised. A later start leaves it alone, so an
	 * admin who has since changed or removed that person's role keeps the change.
	 */
	readonly invitedAdmin?: string;
	/**
	 * The deployment's named projects (`BootstrapNames.projects`, KANTEL_PROJECTS), by name: each made once and found
	 * again on later starts, and every one on the operator key. `GET /v1/projects` lists them with the key.
	 */
	readonly projects?: { readonly [name: string]: ProjectId };
	/**
	 * The compute plane's super-admin key (`ksk_…`, every scope): made on the first start, and made again from here on
	 * each start after, as without a database the compute plane keeps its records in memory.
	 */
	readonly computeKey?: string;
	/**
	 * What an older version, with the agent plane, wrote beside these: its workspace, vault items and egress grants. No
	 * longer used, and kept as they were while the deployment is the same, so going back to that version finds its
	 * deployment again rather than starting a new one.
	 */
	readonly workspaceId?: string;
	readonly egressGrants?: string;
	readonly cpaItem?: unknown;
	readonly modelItems?: unknown;
}

/** The fields of `Bootstrap` an older version wrote and this one keeps but never reads. */
const LEGACY_FIELDS = ["workspaceId", "egressGrants", "cpaItem", "modelItems"] as const;

/** What the bootstrap names: the organisation, its first project, the admin it invites and the other projects. */
export interface BootstrapNames {
	readonly organisation: string;
	readonly project: string;
	readonly adminEmail?: string;
	/**
	 * Projects the deployment has beside its first, by name, such as the task tracker's workspaces of a host app next to
	 * it: made on the start that first names them, and found by name after that. The operator key covers all of
	 * them; a start that adds one issues a new key over them all and revokes the old one.
	 */
	readonly projects?: readonly string[];
}

/** A deployment's organisation, first project and operator key, with what the key may do. */
interface Deployment {
	readonly organisationId: OrganisationId;
	readonly projectId: ProjectId;
	readonly apiKey: string;
	readonly key: Authentication;
}

/**
 * The organisation and project a previous start set up, when its key still works on them: so a gateway on durable
 * stores keeps its deployment across restarts. Undefined when there was none, or it is gone (a fresh database, a
 * revoked key), and the bootstrap starts over.
 */
async function previousDeployment(
	identity: IdentityDirectory,
	previous: Bootstrap | undefined,
): Promise<Deployment | undefined> {
	if (previous === undefined) return undefined;
	try {
		const found = await identity.authenticateApiKey(BOOTSTRAP, previous.apiKey);
		if (found.organisationId !== previous.organisationId) return undefined;
		if (found.role !== "operator" || !(found.projectIds ?? []).includes(previous.projectId)) return undefined;
		// A key names its projects but does not keep them alive: check the project is still there, as the key sees it.
		const asKey: CallContext = {
			actor: found.actor,
			organisationId: previous.organisationId,
			projectId: previous.projectId,
		};
		await identity.getProject(asKey, previous.projectId);
		return {
			organisationId: previous.organisationId,
			projectId: previous.projectId,
			apiKey: previous.apiKey,
			key: found,
		};
	} catch (error) {
		if (error instanceof KantelError) return undefined;
		throw error;
	}
}

/** Every project of the organisation, as Kantel sees them. */
async function allProjects(identity: IdentityDirectory, organisationId: OrganisationId): Promise<Project[]> {
	const inOrganisation: CallContext = { actor: BOOTSTRAP.actor, organisationId };
	const projects: Project[] = [];
	let cursor: string | undefined;
	do {
		const page = await identity.listProjects(inOrganisation, {
			limit: 100,
			...(cursor === undefined ? {} : { cursor }),
		});
		projects.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return projects;
}

/** The names a bootstrap's `projects` setting gives, trimmed, each once, without the first project's. */
export function projectNames(names: BootstrapNames): string[] {
	const wanted = (names.projects ?? []).map((name) => name.trim()).filter((name) => name !== "");
	return [...new Set(wanted)];
}

/**
 * The deployment's named projects, by name: the one `known` (an earlier start's record) names while it still exists,
 * the first project when the name is its own, else the oldest project of that name, else a new one.
 */
async function ensureProjects(
	identity: IdentityDirectory,
	organisationId: OrganisationId,
	first: ProjectId,
	wanted: readonly string[],
	known: { readonly [name: string]: ProjectId } = {},
): Promise<{ [name: string]: ProjectId }> {
	if (wanted.length === 0) return {};
	const existing = await allProjects(identity, organisationId);
	const byId = new Map(existing.map((project) => [project.id, project]));
	const inOrganisation: CallContext = { actor: BOOTSTRAP.actor, organisationId };
	const projects: { [name: string]: ProjectId } = {};
	for (const name of wanted) {
		const remembered = known[name];
		const found =
			(remembered !== undefined && byId.get(remembered)?.name === name ? remembered : undefined) ??
			(byId.get(first)?.name === name ? first : undefined) ??
			existing.find((project) => project.name === name)?.id ??
			(await identity.createProject(inOrganisation, { name })).id;
		projects[name] = found;
	}
	return projects;
}

/**
 * The operator key over the first project and `projects`: the deployment's own while it covers them all, else a new
 * one for the same service, the old one revoked.
 */
async function keyCovering(
	identity: IdentityDirectory,
	deployment: Deployment,
	projects: { readonly [name: string]: ProjectId },
): Promise<string> {
	const needed = [...new Set([deployment.projectId, ...Object.values(projects)])];
	const held = new Set(deployment.key.projectIds ?? []);
	if (needed.every((projectId) => held.has(projectId))) return deployment.apiKey;
	const actor = deployment.key.actor;
	if (actor.kind !== "service") throw new Error("the bootstrap's key is not a service's");
	const inOrganisation: CallContext = { actor: BOOTSTRAP.actor, organisationId: deployment.organisationId };
	const issued = await identity.issueApiKey(inOrganisation, {
		serviceId: actor.serviceId,
		projectIds: needed,
		role: "operator",
	});
	if (actor.keyId !== undefined) await identity.revokeApiKey(inOrganisation, actor.keyId);
	return issued.secret;
}

/**
 * Sets up the deployment, or picks up the one `previous` describes when it still exists: one organisation and project,
 * the projects `names.projects` names (made once, found by name after that), a service with an operator key on all of
 * them, and the admin `names.adminEmail` invites. A bootstrap file an older version wrote (with a workspace, model and
 * vault items) is read the same way; what it says beyond these is no longer used.
 */
export async function bootstrap(
	components: Pick<GatewayComponents, "identity">,
	names: BootstrapNames,
	previous?: Bootstrap,
): Promise<Bootstrap> {
	const { identity } = components;
	const deployment = (await previousDeployment(identity, previous)) ?? (await createDeployment(identity, names));
	const { organisationId, projectId } = deployment;
	const reused = previous !== undefined && previous.organisationId === organisationId;
	const projects = await ensureProjects(
		identity,
		organisationId,
		projectId,
		projectNames(names),
		reused ? previous.projects : undefined,
	);
	const apiKey = await keyCovering(identity, deployment, projects);
	const invitedAdmin = names.adminEmail === undefined ? undefined : normaliseEmail(names.adminEmail);
	if (invitedAdmin !== undefined && !(reused && previous.invitedAdmin === invitedAdmin)) {
		await inviteAdmin(identity, organisationId, invitedAdmin);
	}
	const legacy = reused
		? Object.fromEntries(
				LEGACY_FIELDS.filter((field) => previous[field] !== undefined).map((field) => [field, previous[field]]),
			)
		: {};
	return {
		...legacy,
		organisationId,
		projectId,
		apiKey,
		...(invitedAdmin === undefined ? {} : { invitedAdmin }),
		...(Object.keys(projects).length === 0 ? {} : { projects }),
	};
}

/**
 * Invites `email` as an organisation admin, so a person can sign in by email one-time PIN: Kantel is invite-only, and
 * sign-in never creates a user. It finishes whatever a previous attempt left undone, and does nothing more:
 * - the user is the one who can already sign in with that email, or a new one linked to the email's one-time PIN
 *   subject at creation, so a retry finds it rather than adding a second user;
 * - the admin role is granted only when that user has no organisation-wide role here, so a user created by an attempt
 *   that stopped before its grant gets it on the next try, and one who already has a role keeps it.
 * The bootstrap records a finished invite (`Bootstrap.invitedAdmin`) and does not repeat it, so a role an admin later
 * removes stays removed.
 */
export async function inviteAdmin(
	identity: IdentityDirectory,
	organisationId: OrganisationId,
	email: string,
): Promise<void> {
	const normalised = normaliseEmail(email);
	const asOtp = { issuer: EMAIL_OTP_ISSUER, subject: normalised, email: normalised, emailVerified: true } as const;
	const inOrganisation: CallContext = { actor: BOOTSTRAP.actor, organisationId };
	const userId = (await identity.canSignIn(BOOTSTRAP, asOtp))
		? (await identity.signIn(BOOTSTRAP, asOtp)).user.id
		: (
				await identity.createUser(inOrganisation, {
					name: normalised,
					email: normalised,
					externalSubject: externalSubjectOf(EMAIL_OTP_ISSUER, normalised),
				})
			).id;
	const bindings = await identity.listRoleBindings(inOrganisation);
	const held = bindings.some(
		(binding) =>
			binding.principal.kind === "user" && binding.principal.userId === userId && binding.projectId === undefined,
	);
	if (!held) await identity.grantRole(inOrganisation, { principal: { kind: "user", userId }, role: "admin" });
}

/** A new organisation with its first project and named projects, and a service with an operator key over them all. */
async function createDeployment(identity: IdentityDirectory, names: BootstrapNames): Promise<Deployment> {
	const owner = await identity.createUser(BOOTSTRAP, { name: "Kantel admin" });
	const organisation = await identity.createOrganisation(BOOTSTRAP, {
		name: names.organisation,
		admin: { kind: "user", userId: owner.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: owner.id }, organisationId: organisation.id };
	const project = await identity.createProject(admin, { name: names.project });
	const named = await ensureProjects(identity, organisation.id, project.id, projectNames(names));
	const service = await identity.createServiceIdentity(admin, { name: "self-hosted bootstrap" });
	const issued = await identity.issueApiKey(admin, {
		serviceId: service.id,
		projectIds: [...new Set([project.id, ...Object.values(named)])],
		role: "operator",
	});
	const key = await identity.authenticateApiKey(BOOTSTRAP, issued.secret);
	return { organisationId: organisation.id, projectId: project.id, apiKey: issued.secret, key };
}
