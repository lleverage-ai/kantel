// Each schema's static type and its type in @harbour/contracts have the same keys and are assignable both ways, so a
// field added to one and not the other fails `pnpm typecheck`. The `it` is only there so vitest counts the file.
import type {
	Actor as ContractActor,
	ErrorCode as ContractErrorCode,
	SessionHistoryPage as ContractHistoryPage,
	SessionRecord as ContractSessionRecord,
	SessionStatus as ContractSessionStatus,
	Submission as ContractSubmission,
	CreateSessionInput,
	ModelThinking,
	Page,
	PromptInput,
	SessionHistoryRequest,
} from "@harbour/contracts";
import type * as Protocol from "@harbour/protocol";
import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import type * as Frames from "../src/protocol-schema.ts";
import type { DeepReadonly } from "../src/route.ts";
import type {
	Actor,
	CreatedSession,
	CreateSessionBody,
	ErrorCode,
	FirstMessage,
	MessageBody,
	SessionPage,
	SessionRecord,
	SessionStatus,
	Submission,
	ThinkingLevel,
} from "../src/schema.ts";

/** Read-only all the way down, as the contracts are; the router returns contract values as `DeepReadonly`. */
type Wire<S extends TSchema> = DeepReadonly<Static<S>>;
type Assignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** The same keys, optional ones included (mutual assignability alone lets an extra optional key through). */
type SameKeys<A, B> = Assignable<keyof A, keyof B>;
type Same<A, B> = Assignable<A, B> extends true ? SameKeys<A, B> : false;
const same = <A, B>(proof: Same<A, B>) => proof;

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
