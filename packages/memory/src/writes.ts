/**
 * Memory's write operations, ready for a transport to mount: each parses its input from untrusted JSON,
 * refusing a malformed one as `invalid` before the memory sees it, and runs it on any `Memory` as the caller, so the
 * memory's own rules and authority apply. No routes here: an HTTP layer (`./http.ts`, later) maps each to a route,
 * passing path parameters and body as one input object. Portable: no Node APIs.
 *
 * | Operation | Input | Output |
 * | --- | --- | --- |
 * | `memory.createSpace` | `{ owner, name }` | `MemorySpace` |
 * | `memory.propose` | `{ spaceId, write }` | `MemoryProposal` |
 * | `memory.decide` | `{ proposalId, outcome, note? }` | `MemoryProposal` |
 * | `memory.importSnapshot` | `{ spaceId, snapshot }` | `MemorySpace` |
 * | `memory.publishBundle` | `{ spaceId }` | `BundlePublication` (a `PublishingMemory` only) |
 */
import {
	type CallContext,
	type ConceptInput,
	type ConceptScope,
	type JsonValue,
	KantelError,
	type Memory,
	type MemoryProposal,
	type MemorySnapshot,
	type MemorySpace,
	type MemoryWrite,
	type OwnerRef,
	type SnapshotConcept,
} from "@kantel/contracts";
import type { BundlePublication, PublishingMemory } from "./publish.ts";

export interface MemoryWriteOperation<Input, Output> {
	/** Dotted, as access checks and audit name it. */
	readonly name: string;
	/** Whether an agent may call it at all. Agents propose; they never create, decide, import or publish. */
	readonly agents: boolean;
	/** The input, checked: `invalid` unless it has exactly the documented shape. */
	parse(input: unknown): Input;
	run(memory: Memory, ctx: CallContext, input: Input): Promise<Output>;
}

type Shape = Record<string, unknown>;

function fail(message: string): never {
	throw new KantelError("invalid", message);
}

/** `value` as an object, any fields: to read the field that says which shape it has. */
function record(value: unknown, what: string): Shape {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${what} must be an object`);
	return value as Shape;
}

/** `value` as an object with only `keys` and at least `required`. */
function object(value: unknown, what: string, keys: readonly string[], required: readonly string[] = keys): Shape {
	const shape = record(value, what);
	for (const key of Object.keys(shape)) if (!keys.includes(key)) fail(`${what} has an unknown field ${key}`);
	for (const key of required) if (shape[key] === undefined) fail(`${what} needs ${key}`);
	return shape;
}

function text(value: unknown, what: string): string {
	if (typeof value !== "string" || value.trim() === "") fail(`${what} must be non-empty text`);
	return value;
}

function optionalText(value: unknown, what: string): string | undefined {
	return value === undefined ? undefined : text(value, what);
}

function texts(value: unknown, what: string): string[] {
	if (!Array.isArray(value)) fail(`${what} must be a list of text`);
	return value.map((item, index) => text(item, `${what}[${index}]`));
}

function time(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail(`${what} must be a timestamp in milliseconds`);
	return value;
}

function positive(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) fail(`${what} must be a positive integer`);
	return value;
}

function oneOf<T extends string>(value: unknown, what: string, allowed: readonly T[]): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${what} must be one of ${allowed.join(", ")}`);
	return value as T;
}

function extensions(value: unknown, what: string): { readonly [namespace: string]: JsonValue } | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${what} must be an object`);
	return value as { readonly [namespace: string]: JsonValue };
}

export function parseOwner(value: unknown): OwnerRef {
	const kind = oneOf(record(value, "owner").kind, "owner.kind", ["organisation", "project", "user"]);
	switch (kind) {
		case "organisation": {
			const owner = object(value, "owner", ["kind", "organisationId"]);
			return { kind, organisationId: text(owner.organisationId, "owner.organisationId") };
		}
		case "project": {
			const owner = object(value, "owner", ["kind", "organisationId", "projectId"]);
			return {
				kind,
				organisationId: text(owner.organisationId, "owner.organisationId"),
				projectId: text(owner.projectId, "owner.projectId"),
			};
		}
		case "user": {
			const owner = object(value, "owner", ["kind", "organisationId", "userId"]);
			return {
				kind,
				organisationId: text(owner.organisationId, "owner.organisationId"),
				userId: text(owner.userId, "owner.userId"),
			};
		}
	}
}

function parseScope(value: unknown, what: string): ConceptScope {
	const kind = oneOf(record(value, what).kind, `${what}.kind`, ["global", "project", "job"]);
	switch (kind) {
		case "global":
			object(value, what, ["kind"]);
			return { kind };
		case "project":
			return { kind, project: text(object(value, what, ["kind", "project"]).project, `${what}.project`) };
		case "job":
			return { kind, job: text(object(value, what, ["kind", "job"]).job, `${what}.job`) };
	}
}

const CONCEPT_KEYS = [
	"id",
	"title",
	"description",
	"statement",
	"tags",
	"scope",
	"sources",
	"staleAfter",
	"overrides",
	"extensions",
] as const;

function conceptFields(shape: Shape, what: string): ConceptInput {
	// A description may be empty, as the store allows.
	if (shape.description !== undefined && typeof shape.description !== "string")
		fail(`${what}.description must be text`);
	const description = shape.description as string | undefined;
	const tags = shape.tags === undefined ? undefined : texts(shape.tags, `${what}.tags`);
	const staleAfter = shape.staleAfter === undefined ? undefined : time(shape.staleAfter, `${what}.staleAfter`);
	const overrides = optionalText(shape.overrides, `${what}.overrides`);
	const extra = extensions(shape.extensions, `${what}.extensions`);
	return {
		id: text(shape.id, `${what}.id`),
		title: text(shape.title, `${what}.title`),
		...(description === undefined ? {} : { description }),
		statement: text(shape.statement, `${what}.statement`),
		...(tags === undefined ? {} : { tags }),
		scope: parseScope(shape.scope, `${what}.scope`),
		sources: texts(shape.sources, `${what}.sources`),
		...(staleAfter === undefined ? {} : { staleAfter }),
		...(overrides === undefined ? {} : { overrides }),
		...(extra === undefined ? {} : { extensions: extra }),
	};
}

export function parseConceptInput(value: unknown, what = "concept"): ConceptInput {
	return conceptFields(object(value, what, CONCEPT_KEYS, ["id", "title", "statement", "scope", "sources"]), what);
}

export function parseMemoryWrite(value: unknown): MemoryWrite {
	const op = oneOf(record(value, "write").op, "write.op", ["remember", "correct", "supersede", "forget"]);
	switch (op) {
		case "remember":
			return { op, concept: parseConceptInput(object(value, "write", ["op", "concept"]).concept) };
		case "correct": {
			const write = object(value, "write", ["op", "concept", "expectedVersion"]);
			return {
				op,
				concept: parseConceptInput(write.concept),
				expectedVersion: positive(write.expectedVersion, "write.expectedVersion"),
			};
		}
		case "supersede": {
			const write = object(value, "write", ["op", "conceptId", "expectedVersion", "replacement"]);
			return {
				op,
				conceptId: text(write.conceptId, "write.conceptId"),
				expectedVersion: positive(write.expectedVersion, "write.expectedVersion"),
				replacement: parseConceptInput(write.replacement, "write.replacement"),
			};
		}
		case "forget": {
			const write = object(value, "write", ["op", "conceptId", "expectedVersion", "reason"]);
			return {
				op,
				conceptId: text(write.conceptId, "write.conceptId"),
				expectedVersion: positive(write.expectedVersion, "write.expectedVersion"),
				reason: text(write.reason, "write.reason"),
			};
		}
	}
}

export function parseSnapshot(value: unknown): MemorySnapshot {
	const snapshot = object(value, "snapshot", ["sourceId", "ref", "concepts"]);
	if (!Array.isArray(snapshot.concepts)) fail("snapshot.concepts must be a list");
	const concepts = snapshot.concepts.map((item: unknown, index: number): SnapshotConcept => {
		const what = `snapshot.concepts[${index}]`;
		const shape = object(
			item,
			what,
			[...CONCEPT_KEYS, "setBy", "status", "supersededBy", "updatedAt"],
			["id", "title", "statement", "scope", "sources", "setBy", "status", "updatedAt"],
		);
		const supersededBy = optionalText(shape.supersededBy, `${what}.supersededBy`);
		return {
			...conceptFields(shape, what),
			setBy: oneOf(shape.setBy, `${what}.setBy`, ["owner", "learned"]),
			status: oneOf(shape.status, `${what}.status`, ["active", "superseded", "forgotten"]),
			...(supersededBy === undefined ? {} : { supersededBy }),
			updatedAt: time(shape.updatedAt, `${what}.updatedAt`),
		};
	});
	return { sourceId: text(snapshot.sourceId, "snapshot.sourceId"), ref: text(snapshot.ref, "snapshot.ref"), concepts };
}

function isPublishing(memory: Memory): memory is PublishingMemory {
	return typeof (memory as Partial<PublishingMemory>).publishBundle === "function";
}

export const createSpaceOperation: MemoryWriteOperation<
	{ readonly owner: OwnerRef; readonly name: string },
	MemorySpace
> = {
	name: "memory.createSpace",
	agents: false,
	parse(input) {
		const shape = object(input, "input", ["owner", "name"]);
		return { owner: parseOwner(shape.owner), name: text(shape.name, "name") };
	},
	run: (memory, ctx, input) => memory.createSpace(ctx, input),
};

export const proposeOperation: MemoryWriteOperation<
	{ readonly spaceId: string; readonly write: MemoryWrite },
	MemoryProposal
> = {
	name: "memory.propose",
	agents: true,
	parse(input) {
		const shape = object(input, "input", ["spaceId", "write"]);
		return { spaceId: text(shape.spaceId, "spaceId"), write: parseMemoryWrite(shape.write) };
	},
	run: (memory, ctx, input) => memory.propose(ctx, input.spaceId, input.write),
};

export const decideOperation: MemoryWriteOperation<
	{ readonly proposalId: string; readonly outcome: "apply" | "reject"; readonly note?: string },
	MemoryProposal
> = {
	name: "memory.decide",
	agents: false,
	parse(input) {
		const shape = object(input, "input", ["proposalId", "outcome", "note"], ["proposalId", "outcome"]);
		const note = optionalText(shape.note, "note");
		return {
			proposalId: text(shape.proposalId, "proposalId"),
			outcome: oneOf(shape.outcome, "outcome", ["apply", "reject"]),
			...(note === undefined ? {} : { note }),
		};
	},
	run: (memory, ctx, input) =>
		memory.decide(ctx, input.proposalId, {
			outcome: input.outcome,
			...(input.note === undefined ? {} : { note: input.note }),
		}),
};

export const importSnapshotOperation: MemoryWriteOperation<
	{ readonly spaceId: string; readonly snapshot: MemorySnapshot },
	MemorySpace
> = {
	name: "memory.importSnapshot",
	agents: false,
	parse(input) {
		const shape = object(input, "input", ["spaceId", "snapshot"]);
		return { spaceId: text(shape.spaceId, "spaceId"), snapshot: parseSnapshot(shape.snapshot) };
	},
	run: (memory, ctx, input) => memory.importSnapshot(ctx, input.spaceId, input.snapshot),
};

export const publishBundleOperation: MemoryWriteOperation<{ readonly spaceId: string }, BundlePublication> = {
	name: "memory.publishBundle",
	agents: false,
	parse(input) {
		return { spaceId: text(object(input, "input", ["spaceId"]).spaceId, "spaceId") };
	},
	run(memory, ctx, input) {
		if (!isPublishing(memory)) {
			return Promise.reject(new KantelError("not_supported", "This memory publishes to no source"));
		}
		return memory.publishBundle(ctx, input.spaceId);
	},
};

/** Every write operation, by name. */
export const memoryWriteOperations = {
	"memory.createSpace": createSpaceOperation,
	"memory.propose": proposeOperation,
	"memory.decide": decideOperation,
	"memory.importSnapshot": importSnapshotOperation,
	"memory.publishBundle": publishBundleOperation,
} as const;

/**
 * Runs the named write operation on untrusted input, as a transport does: parses it, then calls the memory as `ctx`.
 * An unknown name is `not_found`.
 */
export async function runMemoryWrite(
	memory: Memory,
	ctx: CallContext,
	name: string,
	input: unknown,
): Promise<MemorySpace | MemoryProposal | BundlePublication> {
	const operation = Object.hasOwn(memoryWriteOperations, name)
		? (memoryWriteOperations[name as keyof typeof memoryWriteOperations] as MemoryWriteOperation<
				unknown,
				MemorySpace | MemoryProposal | BundlePublication
			>)
		: undefined;
	if (operation === undefined) throw new KantelError("not_found", `No memory write ${name}`);
	return operation.run(memory, ctx, operation.parse(input));
}
