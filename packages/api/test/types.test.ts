// Each schema's static type and its type in @kantel/contracts have the same keys and are assignable both ways, so a
// field added to one and not the other fails `pnpm typecheck`. The `it` is only there so vitest counts the file.

import type * as Contracts from "@kantel/contracts";
import type {
	Actor as ContractActor,
	CreateProjectRequest as ContractCreateProjectRequest,
	ErrorCode as ContractErrorCode,
	Project as ContractProject,
} from "@kantel/contracts";
import { PROJECT_NAME_MAX_LENGTH } from "@kantel/contracts";
import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import type * as Envs from "../src/environments-schema.ts";
import type { DeepReadonly } from "../src/route.ts";
import type { Actor, CreateProjectBody, ErrorCode, Project } from "../src/schema.ts";

/** Read-only all the way down, as the contracts are; the router returns contract values as `DeepReadonly`. */
type Wire<S extends TSchema> = DeepReadonly<Static<S>>;
type Assignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** The same keys, optional ones included (mutual assignability alone lets an extra optional key through). */
type SameKeys<A, B> = Assignable<keyof A, keyof B>;
type Same<A, B> = Assignable<A, B> extends true ? SameKeys<A, B> : false;
const same = <A, B>(proof: Same<A, B>) => proof;

describe("schemas match the contracts", () => {
	it("compiles", () => {
		const proofs = [
			same<Wire<typeof Actor>, ContractActor>(true),
			same<Wire<typeof ErrorCode>, ContractErrorCode | "unauthenticated">(true),
			same<Wire<typeof Project>, ContractProject>(true),
			same<Wire<typeof CreateProjectBody>, ContractCreateProjectRequest>(true),
		];
		expect(proofs.every(Boolean)).toBe(true);
	});

	it("limits a project's name as identity does", async () => {
		const schema = await import("../src/schema.ts");
		const name = schema.CreateProjectBody.properties.name as { readonly maxLength?: number };
		expect(name.maxLength).toBe(PROJECT_NAME_MAX_LENGTH);
	});

	it("matches the environments contract", () => {
		const proofs = [
			same<Wire<typeof Envs.EnvironmentState>, Contracts.EnvironmentState>(true),
			same<Wire<typeof Envs.EnvironmentProviderKind>, Contracts.EnvironmentProviderKind>(true),
			same<Wire<typeof Envs.EnvironmentSize>, Contracts.EnvironmentSize>(true),
			same<Wire<typeof Envs.EnvironmentDefinition>, Contracts.EnvironmentDefinition>(true),
			same<Wire<typeof Envs.EnvironmentOwner>, Contracts.EnvironmentOwner>(true),
			same<Wire<typeof Envs.EnvironmentResumeStats>, Contracts.EnvironmentResumeStats>(true),
			same<Wire<typeof Envs.Environment>, Contracts.Environment>(true),
			same<Wire<typeof Envs.EnvironmentList>, { items: readonly Contracts.Environment[] }>(true),
			same<Wire<typeof Envs.EnvironmentGrant>, Contracts.EnvironmentGrant>(true),
			same<Wire<typeof Envs.EnvironmentLease>, Contracts.EnvironmentLease>(true),
			same<Wire<typeof Envs.EnvironmentEvent>, Contracts.EnvironmentEvent>(true),
			same<Wire<typeof Envs.EnvironmentDetail>, Contracts.EnvironmentDetail>(true),
			same<Wire<typeof Envs.CreateEnvironmentBody>, Contracts.CreateEnvironmentInput>(true),
			same<Wire<typeof Envs.UpdateEnvironmentBody>, Contracts.UpdateEnvironmentInput>(true),
			same<Wire<typeof Envs.GrantEnvironmentBody>, Contracts.GrantEnvironmentInput>(true),
			same<Wire<typeof Envs.ListEnvironmentsQuery>, Contracts.EnvironmentFilter>(true),
		];
		expect(proofs.every(Boolean)).toBe(true);
	});
});
