// The M1 components the self-hosted gateway serves. Each is the in-memory implementation until its lane's real one
// merges (the runtime over a session store, Postgres audit, S3 workspaces, Postgres identity); swapping one in changes
// only this file. They share one audit store and one project-access check, as a real deployment's do.

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
function deferredAccess(): { access: ProjectAccess; set(target: ProjectAccess): void } {
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
 * Sets up a fresh in-memory deployment: one organisation and project, a service with an operator key on it, an
 * `echo` agent profile and a workspace with a README, so every mounted API has something to answer with.
 */
export async function bootstrap(
	components: GatewayComponents,
	names: { readonly organisation: string; readonly project: string },
): Promise<Bootstrap> {
	const { identity, runtime, workspaces } = components;
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
	const inProject: CallContext = { ...admin, projectId: project.id };
	await runtime.profiles.put(inProject, {
		id: "echo",
		organisationId: organisation.id,
		projectId: project.id,
		name: "Echo",
		model: { route: "echo" },
		promptLayers: [],
		tools: [],
		skills: [],
		sandbox: { tiers: [] },
		memoryScopes: [],
	});
	const workspace = await workspaces.create(inProject, {
		owner: { kind: "project", organisationId: organisation.id, projectId: project.id },
	});
	await workspaces.commit(inProject, workspace.id, {
		baseVersion: workspace.head,
		changes: [
			{
				op: "put",
				path: "README.md",
				content: "# Harbour self-hosted\n\nThe gateway's in-memory bootstrap seeded this workspace.\n",
			},
		],
		message: "bootstrap",
	});
	return {
		organisationId: organisation.id,
		projectId: project.id,
		workspaceId: workspace.id,
		apiKey: issued.secret,
	};
}
