// Each schema's static type and its type in @harbour/contracts are assignable both ways, so a field added to one and
// not the other fails `pnpm typecheck`. The `it` is only there so vitest counts the file.
import type {
	Actor as ContractActor,
	Concept as ContractConcept,
	ConceptScope as ContractConceptScope,
	ErrorCode as ContractErrorCode,
	MemorySearchHit as ContractMemorySearchHit,
	MemorySearchRequest as ContractMemorySearchRequest,
	MemorySnapshot as ContractMemorySnapshot,
	MemorySpace as ContractMemorySpace,
	OwnerRef as ContractOwnerRef,
	Recall as ContractRecall,
	RecallRequest as ContractRecallRequest,
	SessionRecord as ContractSessionRecord,
	SessionStatus as ContractSessionStatus,
	SkillListing as ContractSkillListing,
	SkillPackage as ContractSkillPackage,
	SkillRevision as ContractSkillRevision,
	Skills as ContractSkills,
	CreateSessionInput,
	Page,
} from "@harbour/contracts";
import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import type { DeepReadonly } from "../src/route.ts";
import type {
	Actor,
	Concept,
	ConceptPage,
	ConceptScope,
	CreateSessionBody,
	ErrorCode,
	ImportSkillBody,
	MemorySearchBody,
	MemorySearchHit,
	MemorySnapshot,
	MemorySpace,
	MemorySpacePage,
	OwnerRef,
	Recall,
	RecallBody,
	SessionPage,
	SessionRecord,
	SessionStatus,
	SkillListingPage,
	SkillPackage,
	SkillRevision,
	SkillRevisionPage,
} from "../src/schema.ts";

/** Read-only all the way down, as the contracts are; the router returns contract values as `DeepReadonly`. */
type Wire<S extends TSchema> = DeepReadonly<Static<S>>;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <A, B>(proof: Same<A, B>) => proof;

/**
 * The wire's `extensions` are records of `unknown` (`JsonValue` in the contracts, which the read-only mapping can't
 * unfold): everything else must match exactly, and arrays of records are compared through their items.
 */
type Typed<T> = T extends readonly (infer E)[] ? readonly Typed<E>[] : T extends object ? TypedObject<T> : T;
type TypedObject<T> = { readonly [K in Exclude<keyof T, "extensions">]: Typed<T[K]> };

type ImportInput = Parameters<ContractSkills["importRevision"]>[1];

describe("schemas match the contracts", () => {
	it("compiles", () => {
		const proofs = [
			same<Wire<typeof SessionStatus>, ContractSessionStatus>(true),
			same<Wire<typeof Actor>, ContractActor>(true),
			same<Wire<typeof SessionRecord>, ContractSessionRecord>(true),
			same<Wire<typeof CreateSessionBody>, CreateSessionInput>(true),
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
		];
		expect(proofs.every(Boolean)).toBe(true);
	});
});
