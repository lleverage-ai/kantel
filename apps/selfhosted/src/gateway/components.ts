// The M1 components the self-hosted gateway serves, in memory: what the in-process tests run on, and what the gateway
// runs without a database. The stack's gateway runs the real implementations instead (durable.ts). Either way they
// share one audit store and one project-access check, as a real deployment's do.

import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createMemoryAuditStore } from "@harbour/audit/memory";
import {
	type AuditStore,
	type CallContext,
	HarbourError,
	type IdentityDirectory,
	type OrganisationId,
	PLATFORM_ORGANISATION,
	type ProjectAccess,
	type ProjectId,
	type WorkspaceId,
} from "@harbour/contracts";
import { createMemoryIdentity } from "@harbour/identity/memory";
import { createMemoryRuntime, type MemoryRuntime } from "@harbour/runtime/memory";
import type { KeyedWorkspaces } from "@harbour/workspace";
import { createMemoryWorkspaces } from "@harbour/workspace/memory";

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
	readonly workspaces: KeyedWorkspaces;
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

export function createGatewayComponents(): GatewayComponents {
	const auditAccess = deferredAccess();
	const audit = createMemoryAuditStore({ access: auditAccess.access });
	const identity = createMemoryIdentity({ audit });
	const runtime = createMemoryRuntime({ audit, identity, models: createEchoModels() });
	// Given `identity`, the runtime always builds its check; the components share it.
	const access = runtime.access;
	if (access === undefined) throw new Error("the runtime built no project-access check");
	auditAccess.set(access);
	const workspaces = createMemoryWorkspaces({ audit, access });
	return {
		identity,
		audit,
		runtime,
		workspaces,
		bindings: { identity: "memory", audit: "memory", runtime: "memory (echo model)", workspaces: "memory" },
		close: () => runtime.close(),
	};
}

export interface Bootstrap {
	readonly organisationId: OrganisationId;
	readonly projectId: ProjectId;
	readonly workspaceId: WorkspaceId;
	/** An operator key on the project, for host apps and the end-to-end test. Its secret is shown only here. */
	readonly apiKey: string;
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
	names: { readonly organisation: string; readonly project: string },
	previous?: Bootstrap,
): Promise<Bootstrap> {
	const { identity, runtime, workspaces } = components;
	const deployment = (await previousDeployment(identity, previous)) ?? (await createDeployment(identity, names));
	const { organisationId, projectId } = deployment;
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
		tools: [],
		skills: [],
		sandbox: { tiers: [] },
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
	return { organisationId, projectId, workspaceId: workspace.id, apiKey: deployment.apiKey };
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
