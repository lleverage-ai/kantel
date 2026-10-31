/**
 * Skills' write operations, ready for a transport to mount (M2-BE5): each parses its input from untrusted JSON,
 * refusing a malformed one as `invalid` before the store sees it, and runs it on any `Skills` as the caller, so the
 * store's own rules and authority apply. No routes here: an HTTP layer maps each to a route, passing path parameters
 * and body as one input object. Portable: no Node APIs.
 *
 * | Operation | Input | Output |
 * | --- | --- | --- |
 * | `skills.create` | `{ owner, name, description }` | `SkillPackage` |
 * | `skills.saveDraft` | `{ skillId, files, description? }` | `{ digest }` |
 * | `skills.validate` | `{ skillId }` | `{ digest?, problems }` (the open draft against the Agent Skills rules) |
 * | `skills.publish` | `{ skillId, expectedDigest, extensions? }` | `SkillRevision` |
 * | `skills.importRevision` | `{ owner, name, description, files, source, extensions? }` | `SkillRevision` |
 * | `skills.exportRevision` | `{ skillId, revision }` | `SkillExport` (a `SourcePublishingSkills` only) |
 */
import {
	type CallContext,
	isKantelError,
	type JsonValue,
	KantelError,
	type OwnerRef,
	type SkillFile,
	type SkillPackage,
	type SkillRevision,
	type Skills,
} from "@kantel/contracts";
import { type SkillPackageProblem, skillDigest, validateSkillPackage } from "./index.ts";
import type { SkillExport, SourcePublishingSkills } from "./publish.ts";

export interface SkillsWriteOperation<Input, Output> {
	/** Dotted, as access checks and audit name it. */
	readonly name: string;
	/** Whether an agent may call it at all. Agents save and check drafts; they never create, publish, import or export. */
	readonly agents: boolean;
	/** The input, checked: `invalid` unless it has exactly the documented shape. */
	parse(input: unknown): Input;
	run(skills: Skills, ctx: CallContext, input: Input): Promise<Output>;
}

/** What `skills.validate` reports: the open draft's digest, absent when there is no draft, and what is wrong with it. */
export interface SkillValidation {
	readonly digest?: string;
	readonly problems: readonly SkillPackageProblem[];
}

type Extensions = { readonly [namespace: string]: JsonValue };
type Shape = Record<string, unknown>;

function fail(message: string): never {
	throw new KantelError("invalid", message);
}

function object(value: unknown, what: string, keys: readonly string[], required: readonly string[] = keys): Shape {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${what} must be an object`);
	const shape = value as Shape;
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

function positive(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) fail(`${what} must be a positive integer`);
	return value;
}

function oneOf<T extends string>(value: unknown, what: string, allowed: readonly T[]): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${what} must be one of ${allowed.join(", ")}`);
	return value as T;
}

function extensions(value: unknown, what: string): Extensions | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${what} must be an object`);
	return value as Extensions;
}

/** An owner of any kind, the platform included (which only Kantel may use; the store says so). */
export function parseOwner(value: unknown): OwnerRef {
	// Each kind's own fields are checked strictly below.
	const shape = object(value, "owner", ["kind", "organisationId", "projectId", "userId"], ["kind"]);
	const kind = oneOf(shape.kind, "owner.kind", ["platform", "organisation", "project", "user"]);
	switch (kind) {
		case "platform":
			object(value, "owner", ["kind"]);
			return { kind };
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

/** A package's files: each a non-empty path and text content (which may be empty). Paths are the store's to check. */
export function parseSkillFiles(value: unknown, what = "files"): SkillFile[] {
	if (!Array.isArray(value)) fail(`${what} must be a list of files`);
	return value.map((item: unknown, index: number) => {
		const file = object(item, `${what}[${index}]`, ["path", "content"]);
		const content = file.content;
		if (typeof content !== "string") fail(`${what}[${index}].content must be text`);
		return { path: text(file.path, `${what}[${index}].path`), content };
	});
}

function parseSource(value: unknown): { readonly sourceId: string; readonly ref: string } {
	const source = object(value, "source", ["sourceId", "ref"]);
	return { sourceId: text(source.sourceId, "source.sourceId"), ref: text(source.ref, "source.ref") };
}

function isSourcePublishing(skills: Skills): skills is SourcePublishingSkills {
	return typeof (skills as Partial<SourcePublishingSkills>).exportRevision === "function";
}

export const createOperation: SkillsWriteOperation<
	{ readonly owner: OwnerRef; readonly name: string; readonly description: string },
	SkillPackage
> = {
	name: "skills.create",
	agents: false,
	parse(input) {
		const shape = object(input, "input", ["owner", "name", "description"]);
		return {
			owner: parseOwner(shape.owner),
			name: text(shape.name, "name"),
			description: text(shape.description, "description"),
		};
	},
	run: (skills, ctx, input) => skills.create(ctx, input),
};

export const saveDraftOperation: SkillsWriteOperation<
	{ readonly skillId: string; readonly files: readonly SkillFile[]; readonly description?: string },
	{ readonly digest: string }
> = {
	name: "skills.saveDraft",
	agents: true,
	parse(input) {
		const shape = object(input, "input", ["skillId", "files", "description"], ["skillId", "files"]);
		const description = optionalText(shape.description, "description");
		return {
			skillId: text(shape.skillId, "skillId"),
			files: parseSkillFiles(shape.files),
			...(description === undefined ? {} : { description }),
		};
	},
	run: (skills, ctx, input) =>
		skills.saveDraft(ctx, input.skillId, {
			files: input.files,
			...(input.description === undefined ? {} : { description: input.description }),
		}),
};

export const validateOperation: SkillsWriteOperation<{ readonly skillId: string }, SkillValidation> = {
	name: "skills.validate",
	agents: true,
	parse(input) {
		return { skillId: text(object(input, "input", ["skillId"]).skillId, "skillId") };
	},
	async run(skills, ctx, input) {
		const pkg = await skills.get(ctx, input.skillId);
		const files = await skills.readDraft(ctx, input.skillId).catch((error: unknown) => {
			// The package was found, so this is its draft missing.
			if (isKantelError(error, "not_found")) return undefined;
			throw error;
		});
		if (files === undefined) {
			return { problems: [{ path: "", reason: `Skill ${input.skillId} has no open draft` }] };
		}
		// The digest of the files checked, which is what `skills.publish` takes as `expectedDigest`.
		return { digest: await skillDigest(files), problems: validateSkillPackage(pkg.name, files) };
	},
};

export const publishOperation: SkillsWriteOperation<
	{ readonly skillId: string; readonly expectedDigest: string; readonly extensions?: Extensions },
	SkillRevision
> = {
	name: "skills.publish",
	agents: false,
	parse(input) {
		const shape = object(input, "input", ["skillId", "expectedDigest", "extensions"], ["skillId", "expectedDigest"]);
		const extra = extensions(shape.extensions, "extensions");
		return {
			skillId: text(shape.skillId, "skillId"),
			expectedDigest: text(shape.expectedDigest, "expectedDigest"),
			...(extra === undefined ? {} : { extensions: extra }),
		};
	},
	run: (skills, ctx, input) =>
		skills.publish(ctx, input.skillId, {
			expectedDigest: input.expectedDigest,
			...(input.extensions === undefined ? {} : { extensions: input.extensions }),
		}),
};

export const importRevisionOperation: SkillsWriteOperation<
	{
		readonly owner: OwnerRef;
		readonly name: string;
		readonly description: string;
		readonly files: readonly SkillFile[];
		readonly source: { readonly sourceId: string; readonly ref: string };
		readonly extensions?: Extensions;
	},
	SkillRevision
> = {
	name: "skills.importRevision",
	agents: false,
	parse(input) {
		const shape = object(
			input,
			"input",
			["owner", "name", "description", "files", "source", "extensions"],
			["owner", "name", "description", "files", "source"],
		);
		const extra = extensions(shape.extensions, "extensions");
		return {
			owner: parseOwner(shape.owner),
			name: text(shape.name, "name"),
			description: text(shape.description, "description"),
			files: parseSkillFiles(shape.files),
			source: parseSource(shape.source),
			...(extra === undefined ? {} : { extensions: extra }),
		};
	},
	run: (skills, ctx, input) => skills.importRevision(ctx, input),
};

export const exportRevisionOperation: SkillsWriteOperation<
	{ readonly skillId: string; readonly revision: number },
	SkillExport
> = {
	name: "skills.exportRevision",
	agents: false,
	parse(input) {
		const shape = object(input, "input", ["skillId", "revision"]);
		return { skillId: text(shape.skillId, "skillId"), revision: positive(shape.revision, "revision") };
	},
	run(skills, ctx, input) {
		if (!isSourcePublishing(skills)) {
			return Promise.reject(new KantelError("not_supported", "These skills write to no source"));
		}
		return skills.exportRevision(ctx, input.skillId, input.revision);
	},
};

/** Every write operation, by name. */
export const skillsWriteOperations = {
	"skills.create": createOperation,
	"skills.saveDraft": saveDraftOperation,
	"skills.validate": validateOperation,
	"skills.publish": publishOperation,
	"skills.importRevision": importRevisionOperation,
	"skills.exportRevision": exportRevisionOperation,
} as const;

/** What any write operation returns. */
export type SkillsWriteResult =
	| SkillPackage
	| SkillRevision
	| SkillValidation
	| SkillExport
	| { readonly digest: string };

/**
 * Runs the named write operation on untrusted input, as a transport does: parses it, then calls the store as `ctx`.
 * An unknown name is `not_found`.
 */
export async function runSkillsWrite(
	skills: Skills,
	ctx: CallContext,
	name: string,
	input: unknown,
): Promise<SkillsWriteResult> {
	const operation = Object.hasOwn(skillsWriteOperations, name)
		? (skillsWriteOperations[name as keyof typeof skillsWriteOperations] as SkillsWriteOperation<
				unknown,
				SkillsWriteResult
			>)
		: undefined;
	if (operation === undefined) throw new KantelError("not_found", `No skills write ${name}`);
	return operation.run(skills, ctx, operation.parse(input));
}
