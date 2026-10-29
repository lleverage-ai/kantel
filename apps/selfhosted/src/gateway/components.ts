// The M1 components the self-hosted gateway serves, in memory: what the in-process tests run on, and what the gateway
// runs without a database. The stack's gateway runs the real implementations instead (durable.ts). Either way they
// share one audit store and one project-access check, as a real deployment's do.

import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createMemoryAuditStore } from "@harbour/audit/memory";
import type { Sandboxes } from "@harbour/contracts";
import {
	type AuditStore,
	type CallContext,
	EMAIL_OTP_ISSUER,
	externalSubjectOf,
	HarbourError,
	type IdentityDirectory,
	normaliseEmail,
	type OrganisationId,
	PLATFORM_ORGANISATION,
	type ProjectAccess,
	type ProjectId,
	type WorkspaceId,
} from "@harbour/contracts";
import { createMemoryIdentity } from "@harbour/identity/memory";
import { createMemoryOtpStores, type OtpCodeStore, type SessionStore } from "@harbour/identity/otp";
import type { DurableHosts, SessionRuntimeOptions } from "@harbour/runtime/core";
import { createMemoryRuntime, type MemoryRuntime } from "@harbour/runtime/memory";
import { CODING_TOOLS } from "@harbour/sandbox/coding-tools";
import type { HarbourVault } from "@harbour/vault/engine";
import { createMemoryVault } from "@harbour/vault/memory";
import { createMemoryWorkspaceStore, createStoredWorkspaces, type StoredWorkspaces } from "@harbour/workspace/stored";
import { createGatewaySandboxes, SANDBOX_BINDING } from "./sandboxes.ts";

/**
 * Harbour sets itself up as this system actor: the identity contract lets only `system` create an organisation. Its
 * rows go under the platform organisation, since the deployment's own does not exist yet.
 */
const BOOTSTRAP: CallContext = {
	actor: { kind: "system", component: "selfhosted-bootstrap" },
	organisationId: PLATFORM_ORGANISATION,
};

export interface GatewayComponents {
	readonly identity: IdentityDirectory;
	readonly audit: AuditStore;
	readonly runtime: MemoryRuntime;
	readonly workspaces: StoredWorkspaces;
	/** The sandboxes sessions' `bash` runs in, leased on first use (`sandboxes.ts`). */
	readonly sandboxes: Sandboxes;
	/**
	 * Where the session API keeps host registrations so they outlive the process: the runtime's `hosts`, when its store
	 * is durable and it serves stored registrations over their signed callbacks. Absent in memory, where a registration
	 * lives as long as the gateway.
	 */
	readonly hosts?: DurableHosts;
	/** Email one-time PIN codes and the Harbour sessions they start (@harbour/identity/otp). */
	readonly otp: { readonly codes: OtpCodeStore; readonly sessions: SessionStore };
	/**
	 * The vault, behind the egress proxy's decisions and the vault page's approval API. Absent on durable stores without a
	 * cipher key (HARBOUR_VAULT_CIPHER_KEY): values sealed under a key that dies with the process would be lost.
	 */
	readonly vault?: HarbourVault;
	/** Which implementation backs each contract, served at `/v1/deployment` and recorded beside conformance runs. */
	readonly bindings: { readonly [contract: string]: string };
	close(): Promise<void>;
}

type TextContext = { readonly messages: readonly { readonly role: string; readonly content: unknown }[] };

function lastUserText(context: TextContext): string {
	const content = [...context.messages].reverse().find((message) => message.role === "user")?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text")
		.map((block) => block.text)
		.join("");
}

/**
 * A Pi model collection with one model, `echo`, that answers each prompt with its own text. The model gateway
 * (M1-BE9) replaces it; until then the session API runs end to end with no provider key on the host.
 */
export function createEchoModels() {
	const core = createFauxCore({ provider: "harbour-echo", models: [{ id: "echo" }] });
	const reply = (context: TextContext) => fauxAssistantMessage(fauxText(`Echo: ${lastUserText(context)}`));
	const provider = createProvider({
		id: core.provider,
		auth: { apiKey: { name: "Echo", resolve: async () => ({ auth: {} }) } },
		models: core.models,
		api: {
			stream: (model, context, options) => {
				core.appendResponses([reply]);
				return core.stream(model, context, options);
			},
			streamSimple: (model, context, options) => {
				core.appendResponses([reply]);
				return core.streamSimple(model, context, options);
			},
		},
	});
	const models = createModels();
	models.setProvider(provider);
	return models;
}

/**
 * A `ProjectAccess` whose check is supplied later. The audit store takes its check at construction, but the check
 * reads sessions from the runtime, and the runtime needs the audit store as its sink.
 */
export function deferredAccess(): { access: ProjectAccess; set(target: ProjectAccess): void } {
	let target: ProjectAccess | undefined;
	const need = (): ProjectAccess => {
		if (target === undefined) throw new HarbourError("unavailable", "Project access is not ready");
		return target;
	};
	return {
		access: {
			require: (ctx, check) => need().require(ctx, check),
			allows: (ctx, check) => need().allows(ctx, check),
		},
		set: (access) => {
			target = access;
		},
	};
}

/** The sessions' models: a test's scripted model, say. Default the echo model. */
export type GatewayModels = Pick<SessionRuntimeOptions, "models" | "resolveModel">;

export function createGatewayComponents(options: { readonly models?: GatewayModels } = {}): GatewayComponents {
	const auditAccess = deferredAccess();
	const audit = createMemoryAuditStore({ access: auditAccess.access });
	const identity = createMemoryIdentity({ audit });
	const gatewaySandboxes = createGatewaySandboxes();
	const runtime = createMemoryRuntime({
		audit,
		identity,
		...(options.models ?? { models: createEchoModels() }),
		...gatewaySandboxes.runtimeOptions,
	});
	// Given `identity`, the runtime always builds its check; the components share it.
	const access = runtime.access;
	if (access === undefined) throw new Error("the runtime built no project-access check");
	auditAccess.set(access);
	const workspaces = createStoredWorkspaces({ store: createMemoryWorkspaceStore(), audit, access });
	const sandboxes = gatewaySandboxes.attach({ workspaces, access, audit });
	return {
		identity,
		audit,
		runtime,
		workspaces,
		sandboxes,
		otp: createMemoryOtpStores(),
		vault: createMemoryVault({ audit, access }),
		bindings: {
			identity: "memory",
			audit: "memory",
			runtime: options.models === undefined ? "memory (echo model)" : "memory",
			workspaces: "memory",
			sandboxes: SANDBOX_BINDING,
			signIn: "memory",
			vault: "memory",
		},
		close: () => runtime.close(),
	};
}

export interface Bootstrap {
	readonly organisationId: OrganisationId;
	readonly projectId: ProjectId;
	readonly workspaceId: WorkspaceId;
	/** An operator key on the project, for host apps and the end-to-end test. Its secret is shown only here. */
	readonly apiKey: string;
	/**
	 * The email `inviteAdmin` finished inviting into this organisation, normalised. A later start leaves it alone, so an
	 * admin who has since changed or removed that person's role keeps the change.
	 */
	readonly invitedAdmin?: string;
	/**
	 * The fingerprint of the egress grants a start imported into this deployment's vault (egress.ts), so the next start
	 * imports only when the policy file's routes changed, and a policy an admin revoked stays revoked.
	 */
	readonly egressGrants?: string;
}

/**
 * The organisation and project a previous start set up, when its key still works on them: so a gateway on durable
 * stores keeps its deployment across restarts. Undefined when there was none, or it is gone (a fresh database, a
 * revoked key), and the bootstrap starts over.
 */
async function previousDeployment(
	identity: IdentityDirectory,
	previous: Bootstrap | undefined,
): Promise<{ organisationId: OrganisationId; projectId: ProjectId; apiKey: string } | undefined> {
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
		return { organisationId: previous.organisationId, projectId: previous.projectId, apiKey: previous.apiKey };
	} catch (error) {
		if (error instanceof HarbourError) return undefined;
		throw error;
	}
}

/**
 * Sets up the deployment, or picks up the one `previous` describes when it still exists: one organisation and project,
 * a service with an operator key on it, an `echo` agent profile and a workspace with a README, so every mounted API
 * has something to answer with. The profile and workspace are ensured every start, so they come back after a restart
 * on in-memory components too.
 */
export async function bootstrap(
	components: GatewayComponents,
	names: { readonly organisation: string; readonly project: string; readonly adminEmail?: string },
	previous?: Bootstrap,
): Promise<Bootstrap> {
	const { identity, runtime, workspaces } = components;
	const deployment = (await previousDeployment(identity, previous)) ?? (await createDeployment(identity, names));
	const { organisationId, projectId } = deployment;
	const reused = previous !== undefined && previous.organisationId === organisationId;
	const invitedAdmin = names.adminEmail === undefined ? undefined : normaliseEmail(names.adminEmail);
	if (invitedAdmin !== undefined && !(reused && previous.invitedAdmin === invitedAdmin)) {
		await inviteAdmin(identity, organisationId, invitedAdmin);
	}
	const inProject: CallContext = {
		actor: { kind: "system", component: "selfhosted-bootstrap" },
		organisationId,
		projectId,
	};
	await runtime.profiles.put(inProject, {
		id: "echo",
		organisationId,
		projectId,
		name: "Echo",
		model: { route: "echo" },
		promptLayers: [],
		// In a session on a workspace: the file tools on the workspace directly, and `bash` in an isolate leased on its
		// first command (`sandboxes.ts`).
		tools: [...CODING_TOOLS],
		skills: [],
		sandbox: { tiers: ["isolate"] },
		memoryScopes: [],
	});
	const workspace = await workspaces.ensure(inProject, `bootstrap_${projectId}`, {
		owner: { kind: "project", organisationId, projectId },
	});
	if (workspace.head === 0) {
		await workspaces.commit(inProject, workspace.id, {
			baseVersion: workspace.head,
			changes: [
				{
					op: "put",
					path: "README.md",
					content: "# Harbour self-hosted\n\nThe gateway's bootstrap seeded this workspace.\n",
				},
			],
			message: "bootstrap",
		});
	}
	return {
		organisationId,
		projectId,
		workspaceId: workspace.id,
		apiKey: deployment.apiKey,
		...(invitedAdmin === undefined ? {} : { invitedAdmin }),
	};
}

/**
 * Invites `email` as an organisation admin, so a person can sign in by email one-time PIN: Harbour is invite-only, and
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

async function createDeployment(
	identity: IdentityDirectory,
	names: { readonly organisation: string; readonly project: string },
): Promise<{ organisationId: OrganisationId; projectId: ProjectId; apiKey: string }> {
	const owner = await identity.createUser(BOOTSTRAP, { name: "Harbour admin" });
	const organisation = await identity.createOrganisation(BOOTSTRAP, {
		name: names.organisation,
		admin: { kind: "user", userId: owner.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: owner.id }, organisationId: organisation.id };
	const project = await identity.createProject(admin, { name: names.project });
	const service = await identity.createServiceIdentity(admin, { name: "self-hosted bootstrap" });
	const issued = await identity.issueApiKey(admin, {
		serviceId: service.id,
		projectIds: [project.id],
		role: "operator",
	});
	return { organisationId: organisation.id, projectId: project.id, apiKey: issued.secret };
}
