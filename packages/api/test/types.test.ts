// Each schema's static type and its type in @kantel/contracts have the same keys and are assignable both ways, so a
// field added to one and not the other fails `pnpm typecheck`. The `it` is only there so vitest counts the file.

import type * as Sharing from "@kantel/contracts";
import type {
	Actor as ContractActor,
	CheckSettings as ContractCheckSettings,
	Concept as ContractConcept,
	ConceptScope as ContractConceptScope,
	CreateProjectRequest as ContractCreateProjectRequest,
	ErrorCode as ContractErrorCode,
	SessionHistoryPage as ContractHistoryPage,
	MemorySearchHit as ContractMemorySearchHit,
	MemorySearchRequest as ContractMemorySearchRequest,
	MemorySnapshot as ContractMemorySnapshot,
	MemorySpace as ContractMemorySpace,
	ModelOption as ContractModelOption,
	ModelSelection as ContractModelSelection,
	Occurrence as ContractOccurrence,
	OwnerRef as ContractOwnerRef,
	Project as ContractProject,
	PromptAttachment as ContractPromptAttachment,
	Recall as ContractRecall,
	RecallRequest as ContractRecallRequest,
	Recurrence as ContractRecurrence,
	RunResult as ContractRunResult,
	Schedule as ContractSchedule,
	ScheduleKind as ContractScheduleKind,
	ScheduleUpdate as ContractScheduleUpdate,
	SessionModelState as ContractSessionModelState,
	SessionRecord as ContractSessionRecord,
	SessionStatus as ContractSessionStatus,
	SkillListing as ContractSkillListing,
	SkillPackage as ContractSkillPackage,
	SkillRevision as ContractSkillRevision,
	Skills as ContractSkills,
	Submission as ContractSubmission,
	CreateSessionInput,
	ForkSessionInput,
	ModelThinking,
	Page,
	PromptInput,
	ScheduleInput,
	Schedules,
	SessionFilter,
	SessionHistoryRequest,
	SessionModelsStart,
} from "@kantel/contracts";
import { PROJECT_NAME_MAX_LENGTH } from "@kantel/contracts";
import type * as Protocol from "@kantel/protocol";
import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import type * as Conn from "../src/connections-schema.ts";
import type * as Envs from "../src/environments-schema.ts";
import type * as Providers from "../src/model-providers-schema.ts";
import type * as Frames from "../src/protocol-schema.ts";
import type { DeepReadonly } from "../src/route.ts";
import type * as Runs from "../src/run-schema.ts";
import type * as Wires from "../src/schema.ts";
import type {
	Actor,
	CheckSettings,
	Concept,
	ConceptPage,
	ConceptScope,
	CreatedSession,
	CreateProjectBody,
	CreateScheduleBody,
	CreateSessionBody,
	ErrorCode,
	FirstMessage,
	ForkSessionBody,
	ImportSkillBody,
	ListSessionsQuery,
	MemorySearchBody,
	MemorySearchHit,
	MemorySnapshot,
	MemorySpace,
	MemorySpacePage,
	MessageBody,
	ModelOption,
	ModelSelection,
	NewSessionModelsQuery,
	Occurrence,
	OwnerRef,
	Project,
	PromptAttachment,
	Recall,
	RecallBody,
	Recurrence,
	Schedule,
	ScheduleKind,
	SessionModelState,
	SessionPage,
	SessionRecord,
	SessionStatus,
	SkillListingPage,
	SkillPackage,
	SkillRevision,
	SkillRevisionPage,
	Submission,
	ThinkingLevel,
	UpdateScheduleBody,
} from "../src/schema.ts";
import type * as Tools from "../src/tool-servers-schema.ts";

/** Read-only all the way down, as the contracts are; the router returns contract values as `DeepReadonly`. */
type Wire<S extends TSchema> = DeepReadonly<Static<S>>;
type Assignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** The same keys, optional ones included (mutual assignability alone lets an extra optional key through). */
type SameKeys<A, B> = Assignable<keyof A, keyof B>;
type Same<A, B> = Assignable<A, B> extends true ? SameKeys<A, B> : false;
const same = <A, B>(proof: Same<A, B>) => proof;
/**
 * The wire's JSON values (a schedule's `payload`, an occurrence's `result`, a record's `extensions`, a tool's
 * `inputSchema`) are `unknown`
 * (`JsonValue` in the contracts, which the read-only mapping can't unfold): everything else must match exactly, and
 * arrays of records are compared through their items.
 */
type Opaque = "payload" | "result" | "extensions" | "inputSchema";
type Typed<T> = T extends readonly (infer E)[] ? readonly Typed<E>[] : T extends object ? TypedObject<T> : T;
type TypedObject<T> = { readonly [K in keyof T as K extends Opaque ? never : K]: Typed<T[K]> };

type ImportInput = Parameters<ContractSkills["importRevision"]>[1];

/** What the public API sends of a prompt: everything but its `requestId`, which is the `Idempotency-Key` header. */
type Message = Omit<PromptInput, "requestId">;

describe("schemas match the contracts", () => {
	it("compiles", () => {
		const proofs = [
			same<Wire<typeof SessionStatus>, ContractSessionStatus>(true),
			same<Wire<typeof ThinkingLevel>, ModelThinking>(true),
			same<Wire<typeof Actor>, ContractActor>(true),
			same<Wire<typeof SessionRecord>, ContractSessionRecord>(true),
			same<Omit<Wire<typeof CreateSessionBody>, "message">, CreateSessionInput>(true),
			same<Wire<typeof FirstMessage>, Message>(true),
			same<Omit<Wire<typeof MessageBody>, "via">, Message>(true),
			same<Wire<typeof Submission>, ContractSubmission>(true),
			same<Wire<typeof PromptAttachment>, ContractPromptAttachment>(true),
			same<Typed<Wire<typeof Runs.RunResult>>, Typed<ContractRunResult>>(true),
			same<Wire<typeof ModelOption>, ContractModelOption>(true),
			same<Wire<typeof ModelSelection>, ContractModelSelection>(true),
			same<Wire<typeof SessionModelState>, ContractSessionModelState>(true),
			same<Wire<typeof NewSessionModelsQuery>, Pick<SessionModelsStart, "projectId" | "scope">>(true),
			same<Wire<typeof ForkSessionBody>, ForkSessionInput>(true),
			same<Omit<Wire<typeof ListSessionsQuery>, "label" | "limit" | "cursor">, Omit<SessionFilter, "labels">>(true),
			same<Omit<Wire<typeof CreatedSession>, "submission">, ContractSessionRecord>(true),
			same<Wire<typeof SessionPage>, Page<ContractSessionRecord>>(true),
			same<Wire<typeof ErrorCode>, ContractErrorCode | "unauthenticated">(true),
			same<Wire<typeof OwnerRef>, ContractOwnerRef>(true),
			same<Wire<typeof SkillPackage>, ContractSkillPackage>(true),
			same<Typed<Wire<typeof SkillRevision>>, Typed<ContractSkillRevision>>(true),
			same<Typed<Wire<typeof SkillRevisionPage>>, Typed<Page<ContractSkillRevision>>>(true),
			same<Wire<typeof SkillListingPage>, Page<ContractSkillListing>>(true),
			same<Typed<Wire<typeof ImportSkillBody>>, Typed<ImportInput>>(true),
			same<Wire<typeof Project>, ContractProject>(true),
			same<Wire<typeof CreateProjectBody>, ContractCreateProjectRequest>(true),
			same<Wire<typeof MemorySpace>, ContractMemorySpace>(true),
			same<Wire<typeof MemorySpacePage>, Page<ContractMemorySpace>>(true),
			same<Wire<typeof ConceptScope>, ContractConceptScope>(true),
			same<Typed<Wire<typeof Concept>>, Typed<ContractConcept>>(true),
			same<Typed<Wire<typeof ConceptPage>>, Typed<Page<ContractConcept>>>(true),
			same<Typed<Wire<typeof MemorySnapshot>>, Typed<ContractMemorySnapshot>>(true),
			same<Wire<typeof MemorySearchBody>, ContractMemorySearchRequest>(true),
			same<Typed<Wire<typeof MemorySearchHit>>, Typed<ContractMemorySearchHit>>(true),
			same<Wire<typeof RecallBody>, ContractRecallRequest>(true),
			same<Typed<Wire<typeof Recall>>, Typed<ContractRecall>>(true),
			same<Wire<typeof ScheduleKind>, ContractScheduleKind>(true),
			same<Wire<typeof Recurrence>, ContractRecurrence>(true),
			same<Wire<typeof CheckSettings>, ContractCheckSettings>(true),
			same<Typed<Wire<typeof Schedule>>, Typed<ContractSchedule>>(true),
			same<Typed<Wire<typeof CreateScheduleBody>>, Typed<ScheduleInput>>(true),
			same<Typed<Wire<typeof UpdateScheduleBody>>, Typed<ContractScheduleUpdate>>(true),
			same<ContractScheduleUpdate, Parameters<Schedules["update"]>[2]>(true),
			same<Typed<Wire<typeof Occurrence>>, Typed<ContractOccurrence>>(true),
			same<Wire<typeof Frames.SessionHistoryPage>, ContractHistoryPage>(true),
			same<Wire<typeof Frames.HistoryQuery>, SessionHistoryRequest>(true),
		];
		expect(proofs.every(Boolean)).toBe(true);
	});

	it("matches the sharing contracts", () => {
		const proofs = [
			same<Wire<typeof Wires.ResourceRef>, Sharing.ResourceRef>(true),
			same<Wire<typeof Wires.ResourceSelector>, Sharing.ResourceSelector>(true),
			same<Wire<typeof Wires.ShareGrantee>, Sharing.ShareGrantee>(true),
			same<Wire<typeof Wires.SharePermission>, Sharing.SharePermission>(true),
			same<Wire<typeof Wires.ResourceShare>, Sharing.ResourceShare>(true),
			same<Wire<typeof Wires.ResourceSharePage>, Page<Sharing.ResourceShare>>(true),
			same<Wire<typeof Wires.CreateResourceShareBody>, Sharing.CreateShareInput>(true),
			same<Wire<typeof Wires.AccessRequestStatus>, Sharing.AccessRequestStatus>(true),
			same<Wire<typeof Wires.AccessRequest>, Sharing.AccessRequest>(true),
			same<Wire<typeof Wires.AccessRequestPage>, Page<Sharing.AccessRequest>>(true),
			same<Wire<typeof Wires.RequestAccessBody>, Sharing.RequestAccessInput>(true),
			same<Wire<typeof Wires.DecideAccessRequestBody>, Sharing.DecideRequestInput>(true),
			same<Wire<typeof Wires.AccessRequestDecided>, Awaited<ReturnType<Sharing.Sharing["decideRequest"]>>>(true),
			same<Wire<typeof Wires.BindingRelation>, Sharing.BindingRelation>(true),
			same<Wire<typeof Wires.BindingSubject>, Sharing.BindingSubject>(true),
			same<Wire<typeof Wires.BindingObject>, Sharing.BindingObject>(true),
			same<Wire<typeof Wires.BindingBody>, Sharing.BindingInput>(true),
			same<Wire<typeof Wires.ResourceBinding>, Sharing.ResourceBinding>(true),
			same<Wire<typeof Wires.ResourcePolicy>, Sharing.ResourcePolicy>(true),
			same<Wire<typeof Wires.RegisterResourceBody>, Parameters<Sharing.Sharing["registerResource"]>[1]>(true),
			same<Wire<typeof Wires.RegisteredResource>, Sharing.RegisteredResource>(true),
			same<Wire<typeof Wires.ShareUse>, Sharing.ShareUse>(true),
		];
		expect(proofs.every(Boolean)).toBe(true);
	});

	it("lets a schedule change clear at, repeat, until and count with null, and nothing else", () => {
		const clears: Wire<typeof UpdateScheduleBody> = { at: null, repeat: null, until: null, count: null };
		const contract: Typed<ContractScheduleUpdate> = clears;
		// @ts-expect-error a title can't be cleared
		const title: Wire<typeof UpdateScheduleBody> = { title: null };
		// @ts-expect-error nor a time zone
		const timezone: ContractScheduleUpdate = { timezone: null };
		expect([contract, title, timezone]).toHaveLength(3);
	});

	it("matches the connections contract", () => {
		const proofs = [
			same<Wire<typeof Conn.ConnectionsSettings>, Sharing.ConnectionsSettings>(true),
			same<Wire<typeof Conn.ProviderTemplate>, Sharing.ProviderTemplate>(true),
			same<Wire<typeof Conn.CatalogueEntry>, Sharing.CatalogueEntry>(true),
			same<Wire<typeof Conn.CataloguePage>, Page<Sharing.CatalogueEntry>>(true),
			same<Wire<typeof Conn.CatalogueQuery>, Sharing.CatalogueQuery & { limit?: number; cursor?: string }>(true),
			same<Wire<typeof Conn.McpDiscovery>, Sharing.McpDiscovery>(true),
			same<Wire<typeof Conn.ConnectionOwner>, Sharing.ConnectionOwner>(true),
			same<Wire<typeof Conn.SessionAudience>, Sharing.SessionAudience>(true),
			same<Wire<typeof Conn.ConnectionUsage>, Sharing.ConnectionUsage>(true),
			same<Wire<typeof Conn.CredentialState>, Sharing.CredentialState>(true),
			same<Wire<typeof Conn.Connection>, Sharing.Connection>(true),
			same<Wire<typeof Conn.ConnectionPage>, Page<Sharing.Connection>>(true),
			same<Wire<typeof Conn.ConnectionRevocation>, Sharing.ConnectionRevocation>(true),
			same<Wire<typeof Conn.ConnectionRemoval>, Sharing.ConnectionRemoval>(true),
			same<Wire<typeof Conn.UpdateConnectionBody>, Sharing.UpdateConnectionInput>(true),
			same<Wire<typeof Conn.StartConnectBody>, Sharing.StartConnectInput>(true),
			same<Wire<typeof Conn.ConnectAttempt>, Sharing.ConnectAttempt>(true),
			same<Wire<typeof Conn.ConnectKeyBody>, Sharing.ConnectKeyInput>(true),
			same<Wire<typeof Conn.RotateKeyBody>, Sharing.RotateKeyInput>(true),
			same<Wire<typeof Conn.OAuthClient>, Sharing.OAuthClient>(true),
			same<Wire<typeof Conn.OAuthClientPage>, Page<Sharing.OAuthClient>>(true),
			same<Wire<typeof Conn.CreateOAuthClientBody>, Sharing.CreateOAuthClientInput>(true),
			same<Wire<typeof Conn.UpdateOAuthClientBody>, Sharing.UpdateOAuthClientInput>(true),
			same<Wire<typeof Conn.ConnectionUse>, Sharing.ConnectionUse>(true),
			same<Wire<typeof Conn.EgressRefusal>, Sharing.EgressRefusal>(true),
			same<Wire<typeof Conn.RedactedConnectionUse>, Sharing.RedactedConnectionUse>(true),
			same<Wire<typeof Conn.ConnectionUsePage>, Page<Sharing.ListedConnectionUse>>(true),
			same<Wire<typeof Conn.ConnectionShare>, Sharing.ConnectionShare>(true),
			same<Wire<typeof Conn.UsableConnection>, Sharing.UsableConnection>(true),
			same<Wire<typeof Conn.SessionConnectionEligibility>, Sharing.SessionConnectionEligibility>(true),
			same<Wire<typeof Conn.SetupTier>, Sharing.SetupTier>(true),
			same<Wire<typeof Conn.SetupGuide>, Sharing.SetupGuide>(true),
			same<Wire<typeof Conn.ResolvedClientInfo>, Sharing.ResolvedClientInfo>(true),
			same<Wire<typeof Conn.GitHubAppInfo>, Sharing.GitHubAppInfo>(true),
			same<Wire<typeof Conn.ConnectionReach>, Sharing.ConnectionReach>(true),
			same<Wire<typeof Conn.StartGitHubAppBody>, Sharing.StartGitHubAppInput>(true),
			same<Wire<typeof Conn.GitHubAppSetup>, Sharing.GitHubAppSetup>(true),
			same<Wire<typeof Conn.ConnectionRuleWho>, Sharing.ConnectionRuleWho>(true),
			same<Wire<typeof Conn.ConnectionRuleWhat>, Sharing.ConnectionRuleWhat>(true),
			same<Wire<typeof Conn.ConnectionRule>, Sharing.ConnectionRule>(true),
			same<Wire<typeof Conn.ConnectionRules>, Sharing.ConnectionRules>(true),
			same<Wire<typeof Conn.ConnectionRuleBody>, Sharing.ConnectionRuleInput>(true),
			same<Wire<typeof Conn.UpdateConnectionRuleBody>, Sharing.UpdateConnectionRuleInput>(true),
			same<Wire<typeof Conn.UpdateConnectionRulesBody>, Sharing.UpdateConnectionRulesInput>(true),
			same<Wire<typeof Conn.DryRunConnectionBody>, Sharing.DryRunConnectionRequest>(true),
			same<Wire<typeof Conn.ConnectionDecision>, Sharing.ConnectionDecision>(true),
			same<Wire<typeof Conn.ConnectionCeiling>, Sharing.ConnectionCeiling>(true),
		];
		expect(proofs.every(Boolean)).toBe(true);
	});

	it("limits a project's name as identity does", async () => {
		const schema = await import("../src/schema.ts");
		const name = schema.CreateProjectBody.properties.name as { readonly maxLength?: number };
		expect(name.maxLength).toBe(PROJECT_NAME_MAX_LENGTH);
	});

	it("matches the tool servers contract", () => {
		const proofs = [
			same<Wire<typeof Tools.ToolServerTransport>, Sharing.ToolServerTransport>(true),
			same<Wire<typeof Tools.ToolServerToolAnnotations>, Sharing.ToolServerToolAnnotations>(true),
			same<Typed<Wire<typeof Tools.ToolServerTool>>, Typed<Sharing.ToolServerTool>>(true),
			same<Typed<Wire<typeof Tools.ToolServerSnapshot>>, Typed<Sharing.ToolServerSnapshot>>(true),
			same<Wire<typeof Tools.ToolServerConnection>, Sharing.ToolServerConnection>(true),
			same<Typed<Wire<typeof Tools.ToolServer>>, Typed<Sharing.ToolServer>>(true),
			same<Typed<Wire<typeof Tools.ToolServerPage>>, Typed<Page<Sharing.ToolServer>>>(true),
			same<Wire<typeof Tools.ToolServerToken>, Sharing.ToolServerToken>(true),
			same<Wire<typeof Tools.ToolServerTokenList>, { items: readonly Sharing.ToolServerToken[] }>(true),
			same<Wire<typeof Tools.IssuedToolServerToken>, Sharing.IssuedToolServerToken>(true),
			same<Typed<Wire<typeof Tools.CreatedToolServer>>, Typed<Sharing.CreatedToolServer>>(true),
			same<Wire<typeof Tools.CreateToolServerBody>, Sharing.CreateToolServerInput>(true),
			same<Wire<typeof Tools.UpdateToolServerBody>, Sharing.ToolServerUpdate>(true),
			same<Wire<typeof Tools.ListToolServersQuery>, Sharing.ToolServerFilter & { limit?: number; cursor?: string }>(
				true,
			),
			same<Typed<Wire<typeof Tools.ToolServerToolView>>, Typed<Sharing.ToolServerToolView>>(true),
			same<Typed<Wire<typeof Tools.ToolServerTools>>, Typed<Sharing.ToolServerTools>>(true),
		];
		expect(proofs.every(Boolean)).toBe(true);
	});

	it("matches the environments contract", () => {
		const proofs = [
			same<Wire<typeof Envs.EnvironmentState>, Sharing.EnvironmentState>(true),
			same<Wire<typeof Envs.EnvironmentProviderKind>, Sharing.EnvironmentProviderKind>(true),
			same<Wire<typeof Envs.EnvironmentSize>, Sharing.EnvironmentSize>(true),
			same<Wire<typeof Envs.EnvironmentDefinition>, Sharing.EnvironmentDefinition>(true),
			same<Wire<typeof Envs.EnvironmentOwner>, Sharing.EnvironmentOwner>(true),
			same<Wire<typeof Envs.EnvironmentResumeStats>, Sharing.EnvironmentResumeStats>(true),
			same<Wire<typeof Envs.Environment>, Sharing.Environment>(true),
			same<Wire<typeof Envs.EnvironmentList>, { items: readonly Sharing.Environment[] }>(true),
			same<Wire<typeof Envs.EnvironmentGrant>, Sharing.EnvironmentGrant>(true),
			same<Wire<typeof Envs.EnvironmentLease>, Sharing.EnvironmentLease>(true),
			same<Wire<typeof Envs.EnvironmentEvent>, Sharing.EnvironmentEvent>(true),
			same<Wire<typeof Envs.EnvironmentDetail>, Sharing.EnvironmentDetail>(true),
			same<Wire<typeof Envs.CreateEnvironmentBody>, Sharing.CreateEnvironmentInput>(true),
			same<Wire<typeof Envs.UpdateEnvironmentBody>, Sharing.UpdateEnvironmentInput>(true),
			same<Wire<typeof Envs.GrantEnvironmentBody>, Sharing.GrantEnvironmentInput>(true),
			same<Wire<typeof Envs.ListEnvironmentsQuery>, Sharing.EnvironmentFilter>(true),
		];
		expect(proofs.every(Boolean)).toBe(true);
	});

	it("matches the model providers contract", () => {
		const proofs = [
			same<Wire<typeof Providers.ModelProvider>, Sharing.ModelProvider>(true),
			same<Wire<typeof Providers.ModelProviderInput>, Sharing.ModelProviderInput>(true),
			same<
				Wire<typeof Providers.TestModelProviderBody>,
				Sharing.ModelProviderInput & { readonly connectionId?: string }
			>(true),
			same<Wire<typeof Providers.ModelProviderConnection>, Sharing.ModelProviderConnection>(true),
			same<Wire<typeof Providers.ModelProviderModel>, Sharing.ModelProviderModel>(true),
			same<Wire<typeof Providers.ModelProviderModels>, Sharing.ModelProviderModels>(true),
			same<Wire<typeof Providers.ModelProviderDefault>, Sharing.ModelProviderDefault>(true),
			same<Wire<typeof Providers.ModelProvidersState>, Sharing.ModelProvidersState>(true),
		];
		expect(proofs.every(Boolean)).toBe(true);
	});

	it("matches @kantel/protocol's frames", () => {
		const proofs = [
			same<Wire<typeof Frames.TranscriptItem>, Protocol.TranscriptItem>(true),
			same<Wire<typeof Frames.Card>, Protocol.Card>(true),
			same<Wire<typeof Frames.SessionSnapshot>, Protocol.SessionSnapshot>(true),
			same<Wire<typeof Frames.DeltaOp>, Protocol.DeltaOp>(true),
			same<Wire<typeof Frames.SessionDelta>, Protocol.SessionDelta>(true),
			same<Wire<typeof Frames.HistoryPage>, Protocol.HistoryPage>(true),
			same<Wire<typeof Frames.ServerFrame>, Protocol.ServerFrame>(true),
		];
		expect(proofs.every(Boolean)).toBe(true);
	});
});
