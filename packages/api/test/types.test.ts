// Each schema's static type and its type in @harbour/contracts are assignable both ways, so a field added to one and
// not the other fails `pnpm typecheck`. The `it` is only there so vitest counts the file.
import type {
	Actor as ContractActor,
	ErrorCode as ContractErrorCode,
	SessionRecord as ContractSessionRecord,
	SessionStatus as ContractSessionStatus,
	CreateSessionInput,
	Page,
} from "@harbour/contracts";
import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import type { DeepReadonly } from "../src/route.ts";
import type { Actor, CreateSessionBody, ErrorCode, SessionPage, SessionRecord, SessionStatus } from "../src/schema.ts";

/** Read-only all the way down, as the contracts are; the router returns contract values as `DeepReadonly`. */
type Wire<S extends TSchema> = DeepReadonly<Static<S>>;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <A, B>(proof: Same<A, B>) => proof;

describe("schemas match the contracts", () => {
	it("compiles", () => {
		const proofs = [
			same<Wire<typeof SessionStatus>, ContractSessionStatus>(true),
			same<Wire<typeof Actor>, ContractActor>(true),
			same<Wire<typeof SessionRecord>, ContractSessionRecord>(true),
			same<Wire<typeof CreateSessionBody>, CreateSessionInput>(true),
			same<Wire<typeof SessionPage>, Page<ContractSessionRecord>>(true),
			same<Wire<typeof ErrorCode>, ContractErrorCode | "unauthenticated">(true),
		];
		expect(proofs.every(Boolean)).toBe(true);
	});
});
