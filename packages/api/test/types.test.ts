// Each schema's static type and its type in @harbour/contracts have the same keys and are assignable both ways, so a
// field added to one and not the other fails `pnpm typecheck`. The `it` is only there so vitest counts the file.
import type {
	Actor as ContractActor,
	CheckSettings as ContractCheckSettings,
	Concept as ContractConcept,
	ConceptScope as ContractConceptScope,
	ErrorCode as ContractErrorCode,
	SessionHistoryPage as ContractHistoryPage,
	MemorySearchHit as ContractMemorySearchHit,
	MemorySearchRequest as ContractMemorySearchRequest,
	MemorySnapshot as ContractMemorySnapshot,
	MemorySpace as ContractMemorySpace,
	Occurrence as ContractOccurrence,
	OwnerRef as ContractOwnerRef,
	Recall as ContractRecall,
	RecallRequest as ContractRecallRequest,
	Recurrence as ContractRecurrence,
	Schedule as ContractSchedule,
	ScheduleKind as ContractScheduleKind,
	SessionRecord as ContractSessionRecord,
	SessionStatus as ContractSessionStatus,
	SkillListing as ContractSkillListing,
	SkillPackage as ContractSkillPackage,
	SkillRevision as ContractSkillRevision,
	Skills as ContractSkills,
	Submission as ContractSubmission,
	CreateSessionInput,
	ModelThinking,
	Page,
	PromptInput,
	ScheduleInput,
	SessionHistoryRequest,
} from "@harbour/contracts";
import type * as Protocol from "@harbour/protocol";
import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import type * as Frames from "../src/protocol-schema.ts";
import type { DeepReadonly } from "../src/route.ts";
import type {
	Actor,
	CheckSettings,
	Concept,
	ConceptPage,
	ConceptScope,
	CreatedSession,
	CreateScheduleBody,
	CreateSessionBody,
	ErrorCode,
	FirstMessage,
	ImportSkillBody,
	MemorySearchBody,
	MemorySearchHit,
	MemorySnapshot,
	MemorySpace,
	MemorySpacePage,
	MessageBody,
	Occurrence,
	OwnerRef,
	Recall,
	RecallBody,
	Recurrence,
	Schedule,
	ScheduleKind,
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

/** Read-only all the way down, as the contracts are; the router returns contract values as `DeepReadonly`. */
type Wire<S extends TSchema> = DeepReadonly<Static<S>>;
type Assignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** The same keys, optional ones included (mutual assignability alone lets an extra optional key through). */
type SameKeys<A, B> = Assignable<keyof A, keyof B>;
type Same<A, B> = Assignable<A, B> extends true ? SameKeys<A, B> : false;
const same = <A, B>(proof: Same<A, B>) => proof;
/** The wire's JSON values (`payload`, `result`) are `unknown`: the rest must match exactly. */
type Opaque = "payload" | "result";
type Typed<T> = Omit<T, Opaque>;

/**
 * The wire's `extensions` are records of `unknown` (`JsonValue` in the contracts, which the read-only mapping can't
 * unfold): everything else must match exactly, and arrays of records are compared through their items.
 */
type Typed<T> = T extends readonly (infer E)[] ? readonly Typed<E>[] : T extends object ? TypedObject<T> : T;
type TypedObject<T> = { readonly [K in Exclude<keyof T, "extensions">]: Typed<T[K]> };

type ImportInput = Parameters<ContractSkills["importRevision"]>[1];

/** What the public API sends of a prompt; attachments come with workspace uploads. */
type Message = Omit<PromptInput, "requestId" | "attachments">;

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
			same<Omit<Wire<typeof CreatedSession>, "submission">, ContractSessionRecord>(true),
			same<Wire<typeof SessionPage>, Page<ContractSessionRecord>>(true),
			same<Wire<typeof ErrorCode>, ContractErrorCode | "unauthenticated">(true),
			same<Wire<typeof OwnerRef>, ContractOwnerRef>(true),
			same<Wire<typeof SkillPackage>, ContractSkillPackage>(true),
			same<Typed<Wire<typeof SkillRevision>>, Typed<ContractSkillRevision>>(true),
			same<Typed<Wire<typeof SkillRevisionPage>>, Typed<Page<ContractSkillRevision>>>(true),
			same<Wire<typeof SkillListingPage>, Page<ContractSkillListing>>(true),
			same<Typed<Wire<typeof ImportSkillBody>>, Typed<ImportInput>>(true),
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
			same<Typed<Wire<typeof UpdateScheduleBody>>, Typed<Partial<Omit<ScheduleInput, "owner" | "kind">>>>(true),
			same<Typed<Wire<typeof Occurrence>>, Typed<ContractOccurrence>>(true),
			same<Wire<typeof Frames.SessionHistoryPage>, ContractHistoryPage>(true),
			same<Wire<typeof Frames.HistoryQuery>, SessionHistoryRequest>(true),
		];
		expect(proofs.every(Boolean)).toBe(true);
	});

	it("matches @harbour/protocol's frames", () => {
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
