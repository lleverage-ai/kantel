// The components the self-hosted gateway serves, in memory: what the in-process tests run on, and what the gateway
// runs without a database. The stack's gateway runs the real implementations instead (durable.ts). Either way they
// share one audit store and one project-access check, as a real deployment's do.

import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createMemoryAuditStore } from "@kantel/audit/memory";
import { BROWSER_TOOL_NAMES, type SessionBrowser } from "@kantel/browser/session";
import type { ConnectionsService, Fetch } from "@kantel/connections";
import { connectionEgress } from "@kantel/connections/egress";
import { createMemoryConnectionsRepository } from "@kantel/connections/repository";
import { CONNECTION_TOOL_NAMES } from "@kantel/connections/tools";
import type { Sandboxes, UsageWriter } from "@kantel/contracts";
import {
	type AgentProfile,
	type AuditSink,
	type AuditStore,
	type Authentication,
	type BrowserProvider,
	type CallContext,
	EMAIL_OTP_ISSUER,
	externalSubjectOf,
	type IdentityDirectory,
	KantelError,
	type Memory,
	normaliseEmail,
	type OrganisationId,
	PLATFORM_ORGANISATION,
	type Project,
	type ProjectAccess,
	type ProjectId,
	type PromptRules,
	type Skills,
	type WorkspaceId,
} from "@kantel/contracts";
import { createMemoryEnvironmentStore } from "@kantel/environments/store";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { createMemoryOtpStores, type OtpCodeStore, type SessionStore } from "@kantel/identity/otp";
import { createMemoryPasskeyStores, createPasskeys, type Passkeys } from "@kantel/identity/passkey";
import { createMemoryMemory } from "@kantel/memory/memory";
import type { ProgramsService } from "@kantel/programs/service";
import { createMemoryProgramStore } from "@kantel/programs/store";
import { createMemoryPromptRules } from "@kantel/rules/memory";
import type { DurableHosts, SessionRuntimeOptions } from "@kantel/runtime/core";
import { createMemoryRuntime, type MemoryRuntime } from "@kantel/runtime/memory";
import { CODING_TOOLS } from "@kantel/sandbox/coding-tools";
import type { SharingStore } from "@kantel/sharing";
import { createMemorySharing } from "@kantel/sharing/memory";
import { componentResolvers } from "@kantel/sharing/resolvers";
import { createMemorySkills } from "@kantel/skills/memory";
import { SUBAGENT_TOOL } from "@kantel/subagents";
import { createMemoryToolServerRepository } from "@kantel/tools/repository";
import type { KantelVault } from "@kantel/vault/engine";
import { createMemoryVault } from "@kantel/vault/memory";
import { createMemoryWorkspaceStore, createStoredWorkspaces, type StoredWorkspaces } from "@kantel/workspace/stored";
import { gatewaySessionBrowser, withBrowserTools } from "./browser.ts";
import { type GatewayConnectionsConfig, gatewayConnections } from "./connections.ts";
import { type GatewayEnvironments, type GatewayEnvironmentsConfig, gatewayEnvironments } from "./environments.ts";
import {
	createMemoryModelProviderStore,
	createModelProviders,
	type ModelProviders,
	type ModelProvidersGateway,
} from "./model-providers.ts";
import { createGatewaySandboxes, type GatewayContainers } from "./sandboxes.ts";
import { ALL_SESSION_TOOLS, gatewaySessionTools, type SessionToolsConfig } from "./session-tools.ts";
import { sessionContextOptions, skillsMountSource, withOwnWorkspaces } from "./skills-memory.ts";
import { lateRuntime, subagentsBinding, withGatewaySubagents } from "./subagents.ts";
import { type GatewayToolServers, gatewayToolServers } from "./tool-servers.ts";

/**
 * Kantel sets itself up as this system actor: the identity contract lets only `system` create an organisation. Its
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
	/** Agent Skills packages and their revisions (#12): listed to sessions and mounted at `/skills` (skills-memory.ts). */
	readonly skills: Skills;
	/** Memory spaces and their concepts (#12): recalled for sessions with memory scopes, and their memory tools. */
	readonly memory: Memory;
	/** Sharing resources across projects, read by the runtime's access for every resource check. */
	readonly sharing: SharingStore;
	/** Prompt rules, layered around a session's profile when it starts. */
	readonly rules: PromptRules;
	/** The sandboxes sessions' `bash` runs in, leased on first use (`sandboxes.ts`). */
	readonly sandboxes: Sandboxes;
	/**
	 * Where the session API keeps host registrations so they outlive the process: the runtime's `hosts`, when its store
	 * is durable and it serves stored registrations over their signed callbacks. Absent in memory, where a registration
	 * lives as long as the gateway.
	 */
	readonly hosts?: DurableHosts;
	/** Email one-time PIN codes and the Kantel sessions they start (@kantel/identity/otp). */
	readonly otp: { readonly codes: OtpCodeStore; readonly sessions: SessionStore };
	/**
	 * People's passkeys (#132), kept with identity: the vault page asks for one before an approval once the person has
	 * registered one, as on Cloudflare.
	 */
	readonly passkeys: Passkeys;
	/**
	 * The vault, behind the egress proxy's decisions and the vault page's approval API. Absent on durable stores without a
	 * cipher key (KANTEL_VAULT_CIPHER_KEY): values sealed under a key that dies with the process would be lost.
	 */
	readonly vault?: KantelVault;
	/**
	 * The route the bootstrap's `assistant` profile names, when sessions are on the model gateway (`models.ts`). Absent
	 * on the echo model, where the bootstrap makes only the `echo` profile.
	 */
	readonly assistantRoute?: string;
	/**
	 * Model providers (`model-providers.ts`): organisations' own inference, connected at run time as the console's
	 * onboarding does. Present with the model gateway.
	 */
	readonly modelProviders?: ModelProviders;
	/**
	 * The sessions' browser (`browser.ts`): its tools in every session, a person's decisions and the console's links.
	 * Absent without a browser provider.
	 */
	readonly browser?: SessionBrowser;
	/**
	 * Connections (epic #322, `connections.ts`): outside services and remote MCP servers people connect, their secrets in
	 * the vault. Absent without `KANTEL_PUBLIC_URL` or a vault.
	 */
	readonly connections?: ConnectionsService;
	/**
	 * Tool servers (docs/site/src/content/docs/api/tool-servers.md, `tool-servers.ts`): the registry and the tunnels
	 * this process holds. Absent unless `KANTEL_TOOL_SERVERS=experimental`.
	 */
	readonly toolServers?: GatewayToolServers;
	/**
	 * Environments (sandbox tier 3, `environments.ts`): long-lived machines sessions reach through `bash`'s `env`.
	 * Absent unless `KANTEL_ENVIRONMENTS=experimental`.
	 */
	readonly environments?: GatewayEnvironments;
	/**
	 * Saved programs (`session-tools.ts`, @kantel/programs): served at `/v1/programs`, and `save_program` in sessions.
	 * Absent with `KANTEL_PROGRAMS=off` or `KANTEL_CODEMODE=off`.
	 */
	readonly programs?: ProgramsService;
	/**
	 * The tools the bootstrap's profiles list beside the coding, browser and connection tools (`session-tools.ts`):
	 * `present_files`, `create_document`, `codemode` and `save_program`, those that are on.
	 */
	readonly sessionTools: readonly string[];
	/**
	 * Subagents (`subagents.ts`, `@kantel/subagents`): sessions get the `subagent` tool, and the bootstrap's profiles name
	 * it. Absent unless the components were built with them (the gateway's KANTEL_SUBAGENTS, on by default).
	 */
	readonly subagents?: true;
	/** Which implementation backs each contract, served at `/v1/deployment` and recorded beside conformance runs. */
	readonly bindings: { readonly [contract: string]: string };
	close(): Promise<void>;
}

/**
 * Sessions on the model gateway (`models.ts`), built once the components have made their vault and audit store: the
 * gateway reads CPA's key through the vault and records each call in the audit.
 */
export interface ModelGatewaySource {
	/** The route the bootstrap's `assistant` profile names. */
	readonly route: string;
	/** Organisations' own connectors on the gateway (`model-providers.ts`); absent on a gateway that takes none. */
	readonly providers?: ModelProvidersGateway;
	build(deps: {
		readonly vault: () => KantelVault | undefined;
		readonly audit: AuditSink;
		/** Where each model call's usage row goes: the Postgres usage ledger, on durable components. */
		readonly usage?: UsageWriter;
	}): GatewayModels;
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
 * replaces it; until then the session API runs end to end with no provider key on the host.
 */
export function createEchoModels() {
	const models = createModels();
	models.setProvider(echoProvider());
	return models;
}

/** The route, and the model, of the echo provider (`echoProvider`). */
export const ECHO_ROUTE = "echo";
/** The bootstrap's profile on the model gateway, when sessions are on it: Cloudflare's default profile's ID. */
export const ASSISTANT_PROFILE = "assistant";

/** The echo model's pi-ai provider, `harbour-echo`, with its one model, `echo`. */
export function echoProvider() {
	const core = createFauxCore({ provider: "harbour-echo", models: [{ id: ECHO_ROUTE }] });
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
	return provider;
}

/**
 * A `ProjectAccess` whose check is supplied later. The audit store takes its check at construction, but the check
 * reads sessions from the runtime, and the runtime needs the audit store as its sink.
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

/** The model gateway sessions are on: none when they're given models of their own (a test's scripted model). */
export const modelGatewayOf = (options: {
	readonly models?: GatewayModels;
	readonly modelGateway?: ModelGatewaySource;
}): ModelGatewaySource | undefined => (options.models === undefined ? options.modelGateway : undefined);

/**
 * The sessions' models: a test's scripted model, say. Default the echo model. With `images`, a profile whose
 * `imageModel` names a model that makes images gets `generate_image`.
 */
export type GatewayModels = Pick<SessionRuntimeOptions, "models" | "resolveModel" | "images">;

export function createGatewayComponents(
	options: {
		readonly models?: GatewayModels;
		readonly modelGateway?: ModelGatewaySource;
		/** The sessions' browser provider (`browser.ts`). Without it, sessions have no browser. */
		readonly browserProvider?: BrowserProvider;
		/** What `/v1/deployment` says backs the browser. */
		readonly browserBinding?: string;
		/** Connections (`connections.ts`). Without it, there are none. */
		readonly connections?: GatewayConnectionsConfig;
		/** How connections reach providers. Default `publicFetch()`; a test's fake upstream, say. */
		readonly connectionsFetch?: Fetch;
		/** Tool servers (`tool-servers.ts`), in memory. Without it, there are none. */
		readonly toolServers?: boolean;
		/** Environments (`environments.ts`), in memory. Without it, there are none. */
		readonly environments?: GatewayEnvironmentsConfig;
		/** How environments reach boat.dev; a test's fake API. */
		readonly boatFetch?: typeof fetch;
		/** Code mode, programs and presented files (`session-tools.ts`). Default all on, as a local install has them. */
		readonly sessionTools?: SessionToolsConfig;
		/** The container tier (`sandboxes.ts`). Without it, a command routed to a container is refused. */
		readonly containers?: GatewayContainers;
		/** Subagents (`subagents.ts`): the `subagent` tool in every session. Without it, there are none. */
		readonly subagents?: boolean;
	} = {},
): GatewayComponents {
	const subagentsOn = options.subagents === true;
	const sessions = lateRuntime();
	const auditAccess = deferredAccess();
	const audit = createMemoryAuditStore({ access: auditAccess.access });
	// Built before the runtime, so a session it resumes has the browser's tools; it reaches the access check per call.
	const browser =
		options.browserProvider === undefined
			? undefined
			: gatewaySessionBrowser({ provider: options.browserProvider, audit, access: auditAccess.access });
	const identity = createMemoryIdentity({ audit });
	const gatewaySandboxes = createGatewaySandboxes(
		options.containers === undefined ? {} : { containers: options.containers },
	);
	// The vault needs the runtime's access check; the model gateway reads it only at its first call.
	let vault: KantelVault | undefined;
	const models = options.models ??
		options.modelGateway?.build({ vault: () => vault, audit }) ?? { models: createEchoModels() };
	// Built before the runtime too: it gives sessions their tools, and program sessions the program runner as their model.
	const sessionTools = gatewaySessionTools(options.sessionTools ?? ALL_SESSION_TOOLS, {
		connectionCalls: (id) => linked?.takeScriptCalls(id) ?? [],
	});
	// Skills and memory check project access with the runtime's check, which they reach only when called.
	const skills = createMemorySkills({ audit, access: auditAccess.access });
	const memory = createMemoryMemory({ audit, access: auditAccess.access });
	const rules = createMemoryPromptRules({ audit, access: auditAccess.access });
	let workspaces: StoredWorkspaces | undefined;
	const sharing = createMemorySharing({
		audit,
		access: auditAccess.access,
		resolvers: componentResolvers(() => ({
			skills,
			memory,
			...(vault === undefined ? {} : { vault }),
			...(workspaces === undefined ? {} : { workspaces }),
		})),
	});
	const lateWorkspaces = () => {
		if (workspaces === undefined) throw new KantelError("unavailable", "The gateway's workspaces are not ready");
		return workspaces;
	};
	const linked =
		options.connections === undefined
			? undefined
			: gatewayConnections({
					config: options.connections,
					repository: createMemoryConnectionsRepository(),
					audit,
					access: () => auditAccess.access,
					...(options.connectionsFetch === undefined ? {} : { fetch: options.connectionsFetch }),
				});
	const toolServers =
		options.toolServers === true
			? gatewayToolServers({
					repository: createMemoryToolServerRepository(),
					audit,
					access: () => auditAccess.access,
				})
			: undefined;
	const environments =
		options.environments === undefined
			? undefined
			: gatewayEnvironments({
					config: options.environments,
					store: createMemoryEnvironmentStore(),
					storeName: "memory",
					audit,
					access: () => auditAccess.access,
					...(options.boatFetch === undefined ? {} : { boatFetch: options.boatFetch }),
				});
	const ownTools =
		environments === undefined
			? gatewaySandboxes.runtimeOptions.tools
			: environments.withTools(gatewaySandboxes.runtimeOptions.tools);
	const browserTools = withBrowserTools(ownTools, browser);
	const runtime = withOwnWorkspaces(
		createMemoryRuntime({
			...(toolServers === undefined ? {} : { toolServers: toolServers.runtimeOption }),
			audit,
			identity,
			sharing,
			...sessionTools.models(models),
			...gatewaySandboxes.runtimeOptions,
			// `subagent` after code mode's tools, as on Cloudflare: a script doesn't start subagents.
			tools: withGatewaySubagents(
				sessionTools.withTools(linked === undefined ? browserTools : linked.withTools(browserTools)),
				subagentsOn,
				sessions.get,
			),
			...sessionContextOptions({ skills, memory, workspaces: lateWorkspaces }),
			rules,
		}),
		lateWorkspaces,
	);
	// A subagent's session is made through the same runtime a person's is, its own workspace included.
	sessions.set(runtime.runtime);
	// A session's end closes its browsers and ends its grants.
	if (browser !== undefined) runtime.sessionEnd.register("browser", browser.teardown);
	if (environments !== undefined) runtime.sessionEnd.register("environments", environments.teardown);
	// Given `identity`, the runtime always builds its check; the components share it.
	const access = runtime.access;
	if (access === undefined) throw new Error("the runtime built no project-access check");
	auditAccess.set(access);
	workspaces = createStoredWorkspaces({
		store: createMemoryWorkspaceStore(),
		audit,
		access,
		sources: [
			skillsMountSource(
				skills,
				() => runtime.directory,
				() => runtime.profiles,
			),
		],
	});
	vault = createMemoryVault({ audit, access });
	const memoryVault = vault;
	const connections = linked?.attach(vault, runtime.directory);
	const providersGateway = modelGatewayOf(options)?.providers;
	const modelProviders =
		providersGateway === undefined
			? undefined
			: createModelProviders({
					store: createMemoryModelProviderStore(),
					access: () => access,
					vault: () => memoryVault,
					gateway: providersGateway,
				});
	// Placeholder-gated injection (#331): the isolate's curl reaches a connection's API with its placeholder.
	const sandboxes = gatewaySandboxes.attach({
		workspaces,
		access,
		audit,
		...(connections === undefined ? {} : { egress: connectionEgress({ connections }) }),
	});
	const heldToolServers = toolServers?.attach(runtime);
	const heldEnvironments = environments?.attach();
	const programs = sessionTools.attach({
		store: createMemoryProgramStore(),
		runtime: runtime.runtime,
		profiles: runtime.profiles,
		access,
		audit,
	});
	const modelGateway = options.models === undefined ? options.modelGateway : undefined;
	return {
		identity,
		audit,
		runtime,
		workspaces,
		skills,
		memory,
		sharing,
		rules,
		sandboxes,
		otp: createMemoryOtpStores(),
		passkeys: createPasskeys({ ...createMemoryPasskeyStores(), identity, audit }),
		vault,
		...(modelGateway === undefined ? {} : { assistantRoute: modelGateway.route }),
		...(modelProviders === undefined ? {} : { modelProviders }),
		...(browser === undefined ? {} : { browser }),
		...(connections === undefined ? {} : { connections }),
		...(heldToolServers === undefined ? {} : { toolServers: heldToolServers }),
		...(heldEnvironments === undefined ? {} : { environments: heldEnvironments }),
		...(programs === undefined ? {} : { programs }),
		sessionTools: sessionTools.toolNames,
		...(subagentsOn ? { subagents: true as const } : {}),
		bindings: {
			...sessionTools.bindings,
			browser: options.browserBinding ?? (browser === undefined ? "none" : "given"),
			subagents: subagentsBinding(subagentsOn),
			connections: connections === undefined ? "off" : "memory",
			...(heldToolServers === undefined ? {} : { toolServers: "memory (experimental)" }),
			...(heldEnvironments === undefined ? {} : { environments: heldEnvironments.binding }),
			identity: "memory",
			audit: "memory",
			runtime:
				options.models !== undefined
					? "memory"
					: modelGateway !== undefined
						? "memory (model gateway)"
						: "memory (echo model)",
			workspaces: "memory",
			skills: "memory",
			memory: "memory",
			sandboxes: gatewaySandboxes.binding,
			signIn: "memory",
			vault: "memory",
		},
		close: async () => {
			await linked?.close();
			await heldEnvironments?.close();
			await runtime.close();
			await gatewaySandboxes.close();
		},
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
	 * The fingerprint of the egress grants the first start imported into this deployment's vault (egress.ts). Later starts
	 * import nothing, so a policy an admin revoked or changed on the vault page stays as they left it.
	 */
	readonly egressGrants?: string;
	/**
	 * The platform vault item holding CPA's key (models.ts), made for the key named by its hash: the next start reuses it
	 * while the key is the same, as the vault lists no platform items.
	 */
	readonly cpaItem?: { readonly name: string; readonly id: string };
	/**
	 * The platform vault items holding each model connector's key (models.ts), by connector ID, made for the key named by
	 * its hash, as `cpaItem` is for CPA. Written for every connector, CPA's included; `cpaItem` is kept beside it so an
	 * older gateway started on the same file finds CPA's item.
	 */
	readonly modelItems?: { readonly [connectorId: string]: { readonly name: string; readonly id: string } };
	/**
	 * The deployment's named projects (`BootstrapNames.projects`, KANTEL_PROJECTS), by name: each made once and found
	 * again on later starts, and every one on the operator key. `GET /v1/projects` lists them with the key.
	 */
	readonly projects?: { readonly [name: string]: ProjectId };
	/**
	 * The compute plane's super-admin key (`ksk_…`, every scope), when KANTEL_COMPUTE=experimental: made on the first
	 * start with it on, and made again from here on each start after, as the compute plane keeps its records in memory.
	 */
	readonly computeKey?: string;
}

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
 * them, an `echo` agent profile and a workspace with a README, so every mounted API has something to answer with. The profile and workspace are ensured every start, so they come back after a restart
 * on in-memory components too.
 */
/**
 * A bootstrap profile's tools, as Cloudflare's default profile's (apps/cloudflare/src/stack.ts): in a session on a
 * workspace (every session has one, `withOwnWorkspaces`), the file tools on the workspace directly, and `bash` in an
 * isolate leased on its first command (`sandboxes.ts`); `present_files`, `create_document`, `codemode` and
 * `save_program` (`session-tools.ts`). With a browser, its tools too (`browser.ts`): `browser_request` asks a person
 * for sites first. With subagents, `subagent` (`subagents.ts`). With connections, theirs. The skills, memory scopes
 * and image model are the user's, kept across starts from `stored`: none until they set some.
 */
function codingProfile(
	components: Pick<GatewayComponents, "browser" | "connections" | "sessionTools" | "subagents">,
	stored?: Pick<AgentProfile, "skills" | "memoryScopes" | "imageModel">,
) {
	return {
		tools: [
			...CODING_TOOLS,
			...components.sessionTools,
			...(components.browser === undefined ? [] : BROWSER_TOOL_NAMES),
			...(components.subagents === true ? [SUBAGENT_TOOL] : []),
			...(components.connections === undefined ? [] : CONNECTION_TOOL_NAMES),
		],
		skills: stored?.skills ?? [],
		sandbox: { tiers: ["isolate" as const] },
		memoryScopes: stored?.memoryScopes ?? [],
		...(stored?.imageModel === undefined ? {} : { imageModel: stored.imageModel }),
	};
}

/** The profile `id` as stored in the project, or undefined when there is none yet. */
async function storedProfile(
	components: GatewayComponents,
	inProject: CallContext,
	id: string,
): Promise<AgentProfile | undefined> {
	return components.runtime.profiles.get(inProject, id).catch((error: unknown) => {
		if (error instanceof KantelError && error.code === "not_found") return undefined;
		throw error;
	});
}

/**
 * The bootstrap project's `assistant` profile, on the model gateway's `default` route, as Cloudflare's default profile.
 * Its prompt is the user's alone: one they set is kept. The start makes it, and so does the organisation's first
 * default model (`ModelProviders.onDefault`).
 */
export async function putAssistantProfile(
	components: GatewayComponents,
	organisationId: OrganisationId,
	projectId: ProjectId,
): Promise<void> {
	if (components.assistantRoute === undefined) return;
	const inProject: CallContext = {
		actor: { kind: "system", component: "selfhosted-bootstrap" },
		organisationId,
		projectId,
	};
	const { runtime } = components;
	const stored = await storedProfile(components, inProject, ASSISTANT_PROFILE);
	await runtime.profiles.put(inProject, {
		id: ASSISTANT_PROFILE,
		organisationId,
		projectId,
		name: "Assistant",
		model: { route: components.assistantRoute },
		promptLayers: stored?.promptLayers ?? [],
		...codingProfile(components, stored),
	});
}

export async function bootstrap(
	components: GatewayComponents,
	names: BootstrapNames,
	previous?: Bootstrap,
): Promise<Bootstrap> {
	const { identity, runtime, workspaces } = components;
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
	const inProject: CallContext = {
		actor: { kind: "system", component: "selfhosted-bootstrap" },
		organisationId,
		projectId,
	};
	const echo = await storedProfile(components, inProject, "echo");
	await runtime.profiles.put(inProject, {
		id: "echo",
		organisationId,
		projectId,
		name: "Echo",
		model: { route: ECHO_ROUTE },
		promptLayers: echo?.promptLayers ?? [],
		...codingProfile(components, echo),
	});
	// Only once sessions have a model to call: before an organisation connects a provider (`model-providers.ts`), the
	// `echo` profile is the one New session picks.
	if (
		components.assistantRoute !== undefined &&
		(components.modelProviders === undefined || (await components.modelProviders.configured(organisationId)))
	) {
		await putAssistantProfile(components, organisationId, projectId);
	}
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
					content: "# Kantel self-hosted\n\nThe gateway's bootstrap seeded this workspace.\n",
				},
			],
			message: "bootstrap",
		});
	}
	return {
		organisationId,
		projectId,
		workspaceId: workspace.id,
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
