/**
 * Workspace conformance: versioned trees, atomic commits, paged listing, history, export and read-only pinned mounts.
 * The subject wires a `project-files` mount source (with `write`) into the workspaces under test.
 */
import type {
	CallContext,
	MountSource,
	OwnerRef,
	WorkspaceChange,
	WorkspaceRecord,
	Workspaces,
} from "@kantel/contracts";
import {
	actors,
	assertAccessDenied,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceOptions,
	type ConformanceRunner,
	contextFor,
	createDeps,
	createExpectAssertions,
	registerCases,
} from "./harness.ts";
import { createSeedingFixture, type SeedingFixture, seedingCases } from "./workspace-seeding.ts";

export { createSeedingFixture, SEED_FIXTURE, type SeedingFixture } from "./workspace-seeding.ts";

export interface WorkspaceSubject {
	readonly workspaces: Workspaces;
	/** A `project-files` source registered with `workspaces`; it must implement `write`. */
	readonly projectFiles: MountSource;
	/** An `org-files` source registered with `workspaces`, with `write`. Needed for the `orgFiles` cases. */
	readonly orgFiles?: MountSource;
}

/** Workspaces that also create under a caller-chosen ID, as `@kantel/workspace`'s `KeyedWorkspaces` do. */
export interface KeyedWorkspacesLike extends Workspaces {
	ensure(ctx: CallContext, id: string, input: Parameters<Workspaces["create"]>[1]): Promise<WorkspaceRecord>;
}

export interface WorkspaceConformanceOptions extends ConformanceOptions {
	/** Runs the keyed cases: `subject.workspaces` must implement `ensure`. */
	readonly keyed?: boolean;
	/**
	 * Runs the cancellation case: a commit whose `ctx.signal` fired commits nothing. Defaults to `keyed`, since
	 * `@kantel/workspace`'s implementations do both and older ones (apps/selfhosted, the Cloudflare spike) neither.
	 */
	readonly cancellation?: boolean;
	/**
	 * Runs the seeding cases (seed spec v1): the provider must wire `deps.seeders` as its workspaces' `seeders`
	 * and `deps.onSeedStatus` as their `onSeedStatus`.
	 */
	readonly seeding?: boolean;
	/** Runs the fork cases: `subject.workspaces` must implement `fork` (packages/workspace/CONTRACT.md). */
	readonly fork?: boolean;
	/**
	 * Runs the organisation files cases (`/org`): the subject must give `orgFiles`. Needs `projectAccess`.
	 */
	readonly orgFiles?: boolean;
}

/** The suite's dependencies, with the seeding fixture's seeders and status sink for the provider to wire. */
export interface WorkspaceConformanceDeps extends ConformanceDeps {
	readonly seeders: SeedingFixture["seeders"];
	readonly onSeedStatus: SeedingFixture["onSeedStatus"];
}

export type WorkspaceConformanceProvider = (
	deps: WorkspaceConformanceDeps,
	use: (subject: WorkspaceSubject) => Promise<void>,
) => Promise<void>;

/** Fresh dependencies for one case, with a fresh seeding fixture. */
function workspaceDeps(): { deps: WorkspaceConformanceDeps; fixture: SeedingFixture } {
	const fixture = createSeedingFixture();
	return { deps: { ...createDeps(), seeders: fixture.seeders, onSeedStatus: fixture.onSeedStatus }, fixture };
}

export const WORKSPACE_FIXTURE = {
	organisationId: "org-harbour",
	otherOrganisationId: "org-elsewhere",
	projectId: "proj-harbour",
	otherProjectId: "proj-elsewhere",
	/** The agent session the cases use, in `projectId`. */
	sessionId: "sess-1",
	agentId: "agent-1",
} as const;

const ctx: CallContext = contextFor(
	actors.human("user-alice"),
	WORKSPACE_FIXTURE.organisationId,
	WORKSPACE_FIXTURE.projectId,
);
const otherCtx: CallContext = contextFor(actors.human("user-mallory"), WORKSPACE_FIXTURE.otherOrganisationId);
/** An operator in the same organisation, on another project only. */
const outsiderCtx: CallContext = contextFor(
	actors.human("user-oscar"),
	WORKSPACE_FIXTURE.organisationId,
	WORKSPACE_FIXTURE.otherProjectId,
);
/** A viewer on the project. */
const viewerCtx: CallContext = contextFor(
	actors.human("user-victor"),
	WORKSPACE_FIXTURE.organisationId,
	WORKSPACE_FIXTURE.projectId,
);
const agentCtx: CallContext = contextFor(
	actors.agent(WORKSPACE_FIXTURE.agentId, WORKSPACE_FIXTURE.sessionId),
	WORKSPACE_FIXTURE.organisationId,
);
/** An agent whose session belongs to another project. */
const strayAgentCtx: CallContext = contextFor(
	actors.agent("agent-2", "sess-elsewhere"),
	WORKSPACE_FIXTURE.organisationId,
);
/** An agent in another session of the project: it may act on the project, but not on `sessionId`'s records. */
const siblingAgentCtx: CallContext = contextFor(
	actors.agent("agent-4", "sess-sibling"),
	WORKSPACE_FIXTURE.organisationId,
);
/** An agent in the project whose session the case closes. */
const closingAgentCtx: CallContext = contextFor(
	actors.agent("agent-3", "sess-closing"),
	WORKSPACE_FIXTURE.organisationId,
);
const owner: OwnerRef = {
	kind: "project",
	organisationId: WORKSPACE_FIXTURE.organisationId,
	projectId: WORKSPACE_FIXTURE.projectId,
};

/** A third project of the organisation, whose files a case mounts into a workspace of `projectId`. */
const SOURCE_PROJECT = "proj-source";

const decoder = new TextDecoder();
const text = (bytes: Uint8Array): string => decoder.decode(bytes);

/**
 * A record without its hydration progress. A lazily seeded workspace's background pass sets `hydrated` and
 * `hydratedAt` whenever it finishes (packages/workspace/CONTRACT.md), so two reads of one workspace a moment
 * apart may differ there and nowhere else.
 */
function withoutHydrationProgress(record: WorkspaceRecord): unknown {
	if (record.hydration === undefined) return record;
	const { hydrated: _hydrated, hydratedAt: _hydratedAt, ...hydration } = record.hydration;
	return { ...record, hydration };
}

/** Records the roles and agent sessions the cases use, whether or not the project-access cases run. */
function seedTenancy(deps: ConformanceDeps): void {
	const { organisationId, projectId, otherProjectId } = WORKSPACE_FIXTURE;
	deps.tenancy.bind(ctx.actor, organisationId, "operator", projectId);
	deps.tenancy.bind(outsiderCtx.actor, organisationId, "operator", otherProjectId);
	deps.tenancy.bind(viewerCtx.actor, organisationId, "viewer", projectId);
	deps.tenancy.session({
		id: WORKSPACE_FIXTURE.sessionId,
		organisationId,
		projectId,
		agentId: WORKSPACE_FIXTURE.agentId,
	});
	deps.tenancy.session({ id: "sess-elsewhere", organisationId, projectId: otherProjectId, agentId: "agent-2" });
	deps.tenancy.session({ id: "sess-closing", organisationId, projectId, agentId: "agent-3" });
	deps.tenancy.session({ id: "sess-sibling", organisationId, projectId, agentId: "agent-4" });
}

/** Writes project files through the source's own tool, as a tool call does. */
export async function writeProjectFiles(
	projectFiles: MountSource,
	callContext: CallContext,
	ref: string,
	changes: readonly WorkspaceChange[],
): Promise<string> {
	if (projectFiles.write === undefined) throw new Error("the project files source must implement write");
	return (await projectFiles.write(callContext, ref, changes)).version;
}

export function createWorkspaceConformance(options: {
	assertions: ConformanceAssertions;
	provider: WorkspaceConformanceProvider;
	projectAccess?: boolean;
	keyed?: boolean;
	cancellation?: boolean;
	seeding?: boolean;
	fork?: boolean;
	orgFiles?: boolean;
}): readonly ConformanceCase[] {
	return [
		...baseCases(options),
		...(options.orgFiles === true ? orgFilesCases(options) : []),
		...(options.seeding === true
			? seedingCases({
					assertions: options.assertions,
					ctx,
					otherCtx,
					owner,
					withSeeding: (run) => async () => {
						const { deps, fixture } = workspaceDeps();
						seedTenancy(deps);
						await options.provider(deps, ({ workspaces }) => run(workspaces, fixture, deps));
					},
				})
			: []),
		...(options.keyed === true ? keyedCases(options) : []),
		...((options.cancellation ?? options.keyed) === true ? cancellationCases(options) : []),
		...(options.fork === true ? forkCases(options) : []),
	];
}

/** `fork`: a new workspace at the source's tree, sharing its bodies, independent after, under the same checks. */
function forkCases(options: {
	assertions: ConformanceAssertions;
	provider: WorkspaceConformanceProvider;
	projectAccess?: boolean;
}): ConformanceCase[] {
	const a = options.assertions;
	const withFork =
		(run: (workspaces: Workspaces & Required<Pick<Workspaces, "fork">>, deps: ConformanceDeps) => Promise<void>) =>
		async () => {
			const { deps } = workspaceDeps();
			seedTenancy(deps);
			await options.provider(deps, async ({ workspaces }) => {
				a.strictEqual(typeof workspaces.fork, "function", "the workspaces implement fork");
				await run(workspaces as Workspaces & Required<Pick<Workspaces, "fork">>, deps);
			});
		};
	const files = { "a.md": "a", "dir/b.md": "b" };
	const cases: ConformanceCase[] = [
		{
			name: "fork: starts at the source's tree as its version 1, records where it came from, and is independent after",
			run: withFork(async (workspaces) => {
				const source = await workspaces.create(ctx, {
					owner,
					seed: { name: "s", sources: [{ kind: "files", files }] },
				});
				await workspaces.commit(ctx, source.id, {
					baseVersion: source.head,
					changes: [{ op: "put", path: "a.md", content: "a2" }],
				});
				const fork = await workspaces.fork(ctx, source.id, { owner });
				a.ok(fork.id !== source.id, "a fork has its own ID");
				a.strictEqual(fork.head, 1);
				a.deepEqual(fork.forkedFrom, { workspaceId: source.id, version: 2 });
				a.strictEqual(text((await workspaces.read(ctx, fork.id, "a.md")).content), "a2");
				a.strictEqual(text((await workspaces.read(ctx, fork.id, "dir/b.md")).content), "b");
				a.strictEqual((await workspaces.stat(ctx, fork.id, "a.md")).version, 1);
				const older = await workspaces.fork(ctx, source.id, { owner, version: 1 });
				a.strictEqual(text((await workspaces.read(ctx, older.id, "a.md")).content), "a");

				await workspaces.commit(ctx, fork.id, {
					baseVersion: 1,
					changes: [{ op: "delete", path: "a.md" }],
				});
				a.strictEqual(text((await workspaces.read(ctx, source.id, "a.md")).content), "a2");
				a.strictEqual((await workspaces.get(ctx, source.id)).head, 2);
				await a.rejectsWithCode(workspaces.fork(ctx, source.id, { owner, version: 7 }), "not_found");
				await a.rejectsWithCode(
					workspaces.fork(otherCtx, source.id, {
						owner: { kind: "organisation", organisationId: WORKSPACE_FIXTURE.otherOrganisationId },
					}),
					"not_found",
				);
			}),
		},
	];
	if (options.projectAccess === true) {
		cases.push({
			name: "fork (project access): needs viewer on the source and operator where the fork goes",
			run: withFork(async (workspaces, deps) => {
				const source = await workspaces.create(ctx, {
					owner,
					seed: { name: "s", sources: [{ kind: "files", files }] },
				});
				const outsiderOwner: OwnerRef = {
					kind: "project",
					organisationId: WORKSPACE_FIXTURE.organisationId,
					projectId: WORKSPACE_FIXTURE.otherProjectId,
				};
				// An operator elsewhere cannot read the source, so cannot fork it into its own project.
				await assertAccessDenied(a, deps, workspaces.fork(outsiderCtx, source.id, { owner: outsiderOwner }), {
					operation: "workspace.fork",
				});
				// A viewer may read the source but not create a workspace in the project.
				await assertAccessDenied(a, deps, workspaces.fork(viewerCtx, source.id, { owner }), {
					operation: "workspace.create",
				});
				const fork = await workspaces.fork(ctx, source.id, { owner });
				a.strictEqual(text((await workspaces.read(viewerCtx, fork.id, "a.md")).content), "a");
				await a.rejectsWithCode(workspaces.read(outsiderCtx, fork.id, "a.md"), "forbidden");
			}),
		});
	}
	return cases;
}

/** A person with an organisation-wide operator role: the one kind of caller who writes organisation files. */
const orgOperatorCtx: CallContext = contextFor(actors.human("user-olga"), WORKSPACE_FIXTURE.organisationId);
/** The agent of an organisation session (no project). */
const orgAgentCtx: CallContext = contextFor(actors.agent("agent-org", "sess-org"), WORKSPACE_FIXTURE.organisationId);

/**
 * Organisation files (`/org`): one tree per organisation, read by its members from any session's workspace and written
 * only by people and services with an organisation-wide operator role, never by an agent.
 */
function orgFilesCases(options: {
	assertions: ConformanceAssertions;
	provider: WorkspaceConformanceProvider;
}): ConformanceCase[] {
	const a = options.assertions;
	const { organisationId, otherOrganisationId, projectId } = WORKSPACE_FIXTURE;
	const withOrgFiles =
		(run: (subject: WorkspaceSubject & { orgFiles: MountSource }, deps: ConformanceDeps) => Promise<void>) =>
		async () => {
			const { deps } = workspaceDeps();
			seedTenancy(deps);
			deps.tenancy.bind(orgOperatorCtx.actor, organisationId, "operator");
			deps.tenancy.session({ id: "sess-org", organisationId, agentId: "agent-org" });
			await options.provider(deps, async (subject) => {
				const { orgFiles } = subject;
				a.ok(orgFiles !== undefined, "the subject gives an org-files source");
				await run({ ...subject, orgFiles: orgFiles as MountSource }, deps);
			});
		};
	const orgMount = (subject: { orgFiles: MountSource }, ref: string = organisationId) => ({
		path: "/org",
		source: subject.orgFiles.kind,
		ref,
	});
	const write = (source: MountSource, callContext: CallContext, content: string, ref: string = organisationId) =>
		writeProjectFiles(source, callContext, ref, [{ op: "put", path: "handbook.md", content }]);

	return [
		{
			name: "organisation files: an organisation-wide operator writes them, and a project's workspace reads them at /org, pinned",
			run: withOrgFiles(async (subject) => {
				const pinned = await write(subject.orgFiles, orgOperatorCtx, "handbook v1");
				const record = await subject.workspaces.create(ctx, {
					owner,
					sessionId: WORKSPACE_FIXTURE.sessionId,
					mounts: [orgMount(subject)],
				});
				a.deepEqual(record.mounts, [{ ...orgMount(subject), version: pinned, readOnly: true }]);
				for (const reader of [ctx, viewerCtx, agentCtx]) {
					a.strictEqual(
						text((await subject.workspaces.read(reader, record.id, "/org/handbook.md")).content),
						"handbook v1",
					);
				}
				a.deepEqual(
					(await subject.workspaces.list(agentCtx, record.id, { path: "/org" })).items.map((item) => item.path),
					["/org/handbook.md"],
				);
				const next = await write(subject.orgFiles, orgOperatorCtx, "handbook v2");
				a.strictEqual(
					text((await subject.workspaces.read(ctx, record.id, "/org/handbook.md")).content),
					"handbook v1",
					"the mount stays pinned",
				);
				const remounted = await subject.workspaces.remount(ctx, record.id, orgMount(subject));
				a.partialDeepEqual(remounted.mounts[0], { path: "/org", version: next, readOnly: true });
				a.strictEqual(text((await subject.workspaces.read(ctx, record.id, "/org/handbook.md")).content), "handbook v2");
			}),
		},
		{
			name: "organisation files: refuses writes from agents of either scope and from project-only roles, audited, changing nothing",
			run: withOrgFiles(async (subject, deps) => {
				const before = await write(subject.orgFiles, orgOperatorCtx, "handbook v1");
				for (const writer of [orgAgentCtx, agentCtx, ctx, viewerCtx]) {
					await assertAccessDenied(a, deps, write(subject.orgFiles, writer, "overwritten"), {
						operation: "workspace.org-files.write",
					});
				}
				a.strictEqual(await subject.orgFiles.latestVersion(orgOperatorCtx, organisationId), before);
				// And not through a mount either: a commit under /org is refused like any mount's.
				const record = await subject.workspaces.create(orgOperatorCtx, {
					owner: { kind: "organisation", organisationId },
					sessionId: "sess-org",
					mounts: [orgMount(subject)],
				});
				await a.rejectsWithCode(
					subject.workspaces.commit(orgAgentCtx, record.id, {
						baseVersion: record.head,
						changes: [{ op: "put", path: "/org/handbook.md", content: "overwritten" }],
					}),
					"refused",
				);
				a.strictEqual(
					text((await subject.workspaces.read(orgAgentCtx, record.id, "/org/handbook.md")).content),
					"handbook v1",
				);
			}),
		},
		{
			name: "organisation files: another organisation's files are not_found, to mount and to write",
			run: withOrgFiles(async (subject) => {
				await a.rejectsWithCode(
					subject.workspaces.create(ctx, { owner, mounts: [orgMount(subject, otherOrganisationId)] }),
					"not_found",
				);
				const record = await subject.workspaces.create(ctx, { owner });
				await a.rejectsWithCode(
					subject.workspaces.remount(ctx, record.id, orgMount(subject, otherOrganisationId)),
					"not_found",
				);
				await a.rejectsWithCode(write(subject.orgFiles, orgOperatorCtx, "x", otherOrganisationId), "not_found");
				await a.rejectsWithCode(subject.orgFiles.latestVersion(ctx, otherOrganisationId), "not_found");
				a.deepEqual((await subject.workspaces.get(ctx, record.id)).mounts, []);
			}),
		},
		{
			name: "organisation scope: an organisation session's agent reads /org in its workspace, and /project is forbidden on every read",
			run: withOrgFiles(async (subject, deps) => {
				await write(subject.orgFiles, orgOperatorCtx, "handbook v1");
				await writeProjectFiles(subject.projectFiles, ctx, projectId, [
					{ op: "put", path: "README.md", content: "project readme" },
				]);
				// An organisation-wide operator may mount a project's files into an organisation session's workspace; the
				// agent still reads only what its scope reaches.
				const record = await subject.workspaces.create(orgOperatorCtx, {
					owner: { kind: "organisation", organisationId },
					sessionId: "sess-org",
					mounts: [orgMount(subject), { path: "/project", source: subject.projectFiles.kind, ref: projectId }],
				});
				a.strictEqual(
					text((await subject.workspaces.read(orgAgentCtx, record.id, "/org/handbook.md")).content),
					"handbook v1",
				);
				const denied = (call: Promise<unknown>) =>
					assertAccessDenied(a, deps, call, { operation: "workspace.mount.read" });
				await denied(subject.workspaces.read(orgAgentCtx, record.id, "/project/README.md"));
				await denied(subject.workspaces.stat(orgAgentCtx, record.id, "/project/README.md"));
				await denied(subject.workspaces.list(orgAgentCtx, record.id, { path: "/project" }));
				// A project agent can't reach the organisation session's workspace at all.
				await assertAccessDenied(a, deps, subject.workspaces.read(agentCtx, record.id, "/org/handbook.md"), {
					operation: "workspace.read",
				});
			}),
		},
	];
}

/** A cancelled commit (a caller gone, a sandbox lease ended) leaves the head where it was. */
function cancellationCases(options: {
	assertions: ConformanceAssertions;
	provider: WorkspaceConformanceProvider;
}): ConformanceCase[] {
	const a = options.assertions;
	return [
		{
			name: "cancellation: a commit whose signal fired rejects with aborted and commits nothing",
			run: async () => {
				const { deps } = workspaceDeps();
				seedTenancy(deps);
				await options.provider(deps, async ({ workspaces }) => {
					const record = await workspaces.create(ctx, { owner });
					const controller = new AbortController();
					controller.abort();
					await a.rejectsWithCode(
						workspaces.commit({ ...ctx, signal: controller.signal }, record.id, {
							baseVersion: record.head,
							changes: [{ op: "put", path: "late.txt", content: "late" }],
						}),
						"aborted",
					);
					a.strictEqual((await workspaces.get(ctx, record.id)).head, record.head);
					await a.rejectsWithCode(workspaces.read(ctx, record.id, "late.txt"), "not_found");
				});
			},
		},
	];
}

/** `ensure`: one workspace per ID, the first creation wins, and the loser is checked against the winner. */
function keyedCases(options: {
	assertions: ConformanceAssertions;
	provider: WorkspaceConformanceProvider;
	projectAccess?: boolean;
}): ConformanceCase[] {
	const a = options.assertions;
	const withKeyed = (run: (workspaces: KeyedWorkspacesLike, deps: ConformanceDeps) => Promise<void>) => async () => {
		const { deps } = workspaceDeps();
		seedTenancy(deps);
		await options.provider(deps, async ({ workspaces }) => {
			const keyed = workspaces as Partial<KeyedWorkspacesLike>;
			a.strictEqual(typeof keyed.ensure, "function", "keyed workspaces implement ensure");
			await run(workspaces as KeyedWorkspacesLike, deps);
		});
	};
	const seed = (who: string) => ({ name: who, sources: [{ kind: "files" as const, files: { "who.md": who } }] });
	const cases: ConformanceCase[] = [
		{
			name: "keyed: ensure creates once under the given ID and returns the same record after",
			run: withKeyed(async (workspaces) => {
				const first = await workspaces.ensure(ctx, "pf_conformance", { owner, seed: seed("first") });
				a.strictEqual(first.id, "pf_conformance");
				a.strictEqual(first.head, 1);
				const again = await workspaces.ensure(ctx, "pf_conformance", { owner, seed: seed("second") });
				a.deepEqual(withoutHydrationProgress(again), withoutHydrationProgress(first));
				a.strictEqual(text((await workspaces.read(ctx, first.id, "who.md")).content), "first");
			}),
		},
		{
			name: "keyed: concurrent ensures of one ID create one workspace and all return it",
			run: withKeyed(async (workspaces) => {
				const records = await Promise.all(
					["a", "b", "c", "d"].map((who) => workspaces.ensure(ctx, "pf_race", { owner, seed: seed(who) })),
				);
				// The winner returns its record as created; a loser reads it back, perhaps after its hydration finished.
				for (const record of records) {
					a.deepEqual(withoutHydrationProgress(record), withoutHydrationProgress(records[0]!));
				}
				const winner = text((await workspaces.read(ctx, "pf_race", "who.md")).content);
				a.ok(["a", "b", "c", "d"].includes(winner), "one seed won");
				a.strictEqual((await workspaces.history(ctx, "pf_race")).items.length, 2);
			}),
		},
		{
			name: "keyed: refuses an ID another organisation holds as conflict, and a malformed ID as invalid",
			run: withKeyed(async (workspaces) => {
				const system = (organisationId: string): CallContext => ({ actor: actors.system(), organisationId });
				const ownerIn = (organisationId: string): OwnerRef => ({ kind: "organisation", organisationId });
				const { organisationId, otherOrganisationId } = WORKSPACE_FIXTURE;
				await workspaces.ensure(system(organisationId), "pf_shared", { owner: ownerIn(organisationId) });
				await a.rejectsWithCode(
					workspaces.ensure(system(otherOrganisationId), "pf_shared", { owner: ownerIn(otherOrganisationId) }),
					"conflict",
				);
				await a.rejectsWithCode(
					workspaces.ensure(system(organisationId), "../escape", { owner: ownerIn(organisationId) }),
					"invalid",
				);
			}),
		},
	];
	if (options.projectAccess !== true) return cases;
	const elsewhere: OwnerRef = {
		kind: "project",
		organisationId: WORKSPACE_FIXTURE.organisationId,
		projectId: WORKSPACE_FIXTURE.otherProjectId,
	};
	cases.push(
		{
			name: "keyed project access: an existing ID is returned only to a caller who may see it",
			run: withKeyed(async (workspaces) => {
				await workspaces.ensure(ctx, "pf_owned", { owner });
				await a.rejectsWithCode(workspaces.ensure(outsiderCtx, "pf_owned", { owner: elsewhere }), "forbidden");
				a.strictEqual((await workspaces.ensure(viewerCtx, "pf_owned", { owner })).id, "pf_owned");
			}),
		},
		{
			name: "keyed project access: the loser of an ensure race is checked against the record that won",
			run: withKeyed(async (workspaces) => {
				const results = await Promise.allSettled([
					workspaces.ensure(ctx, "pf_contested", { owner, seed: seed("alice") }),
					// Oscar operates only the other project, so he may not see the project's workspace if Alice's wins.
					workspaces.ensure(outsiderCtx, "pf_contested", { owner: elsewhere, seed: seed("oscar") }),
				]);
				const won = results.filter((result) => result.status === "fulfilled");
				const lost = results.filter((result) => result.status === "rejected");
				a.strictEqual(won.length, 1, "one ensure wins");
				a.strictEqual(lost.length, 1, "the other is refused");
				await a.rejectsWithCode(Promise.reject((lost[0] as PromiseRejectedResult).reason), "forbidden");
			}),
		},
	);
	return cases;
}

function baseCases(options: {
	assertions: ConformanceAssertions;
	provider: WorkspaceConformanceProvider;
	projectAccess?: boolean;
}): ConformanceCase[] {
	const a = options.assertions;
	const withSubject = (run: (subject: WorkspaceSubject, deps: ConformanceDeps) => Promise<void>) => async () => {
		const { deps } = workspaceDeps();
		seedTenancy(deps);
		await options.provider(deps, (subject) => run(subject, deps));
	};
	const project = WORKSPACE_FIXTURE.projectId;

	async function withProjectMount(subject: WorkspaceSubject): Promise<{ record: WorkspaceRecord; pinned: string }> {
		const pinned = await writeProjectFiles(subject.projectFiles, ctx, project, [
			{ op: "put", path: "README.md", content: "project readme v1" },
			{ op: "put", path: "src/app.ts", content: "export const app = 1;" },
		]);
		const record = await subject.workspaces.create(ctx, {
			owner,
			mounts: [{ path: "/project", source: subject.projectFiles.kind, ref: project }],
		});
		return { record, pinned };
	}

	const cases: ConformanceCase[] = [
		{
			name: "creates a workspace at version 0 with no files",
			run: withSubject(async ({ workspaces }) => {
				const record = await workspaces.create(ctx, { owner, sessionId: WORKSPACE_FIXTURE.sessionId });
				a.strictEqual(record.head, 0);
				a.partialDeepEqual(record, { owner, sessionId: WORKSPACE_FIXTURE.sessionId, mounts: [] });
				a.deepEqual(await workspaces.get(ctx, record.id), record);
				a.deepEqual((await workspaces.list(ctx, record.id)).items, []);
			}),
		},
		{
			name: "applies seed files as version 1",
			run: withSubject(async ({ workspaces }) => {
				const record = await workspaces.create(ctx, {
					owner,
					seed: { name: "notes", sources: [{ kind: "files", files: { "notes/a.md": "alpha", "b.txt": "beta" } }] },
				});
				a.strictEqual(record.head, 1);
				const file = await workspaces.read(ctx, record.id, "notes/a.md");
				a.strictEqual(text(file.content), "alpha");
				a.strictEqual(file.version, 1);
				a.strictEqual((await workspaces.read(ctx, record.id, "b.txt", { version: 1 })).digest.length, 64);
				await a.rejectsWithCode(workspaces.read(ctx, record.id, "b.txt", { version: 0 }), "not_found");
			}),
		},
		{
			name: "commits puts and deletes atomically as one new version",
			run: withSubject(async ({ workspaces }) => {
				const record = await workspaces.create(ctx, {
					owner,
					seed: { name: "s", sources: [{ kind: "files", files: { "old.txt": "old", "keep.txt": "keep" } }] },
				});
				const result = await workspaces.commit(ctx, record.id, {
					baseVersion: 1,
					changes: [
						{ op: "put", path: "notes/new.md", content: new TextEncoder().encode("new") },
						{ op: "put", path: "keep.txt", content: "kept" },
						{ op: "delete", path: "old.txt" },
					],
				});
				a.deepEqual(result, { version: 2, changed: ["keep.txt", "notes/new.md", "old.txt"] });
				a.strictEqual((await workspaces.get(ctx, record.id)).head, 2);
				a.strictEqual(text((await workspaces.read(ctx, record.id, "notes/new.md")).content), "new");
				a.strictEqual(text((await workspaces.read(ctx, record.id, "keep.txt")).content), "kept");
				await a.rejectsWithCode(workspaces.read(ctx, record.id, "old.txt"), "not_found");

				// A commit that fails on one change applies none of them.
				await a.rejectsWithCode(
					workspaces.commit(ctx, record.id, {
						baseVersion: 2,
						changes: [
							{ op: "put", path: "keep.txt", content: "lost" },
							{ op: "put", path: "../outside.txt", content: "lost" },
						],
					}),
					"invalid",
				);
				a.strictEqual((await workspaces.get(ctx, record.id)).head, 2);
				a.strictEqual(text((await workspaces.read(ctx, record.id, "keep.txt")).content), "kept");
			}),
		},
		{
			name: "rejects a commit on a stale base version with conflict",
			run: withSubject(async ({ workspaces }) => {
				const record = await workspaces.create(ctx, { owner });
				await workspaces.commit(ctx, record.id, { baseVersion: 0, changes: [{ op: "put", path: "a", content: "1" }] });
				await a.rejectsWithCode(
					workspaces.commit(ctx, record.id, { baseVersion: 0, changes: [{ op: "put", path: "a", content: "2" }] }),
					"conflict",
				);
				a.strictEqual((await workspaces.get(ctx, record.id)).head, 1);
				a.strictEqual(text((await workspaces.read(ctx, record.id, "a")).content), "1");
			}),
		},
		{
			name: "reads older content at an older version",
			run: withSubject(async ({ workspaces }) => {
				const record = await workspaces.create(ctx, { owner });
				await workspaces.commit(ctx, record.id, {
					baseVersion: 0,
					changes: [{ op: "put", path: "a", content: "one" }],
				});
				await workspaces.commit(ctx, record.id, {
					baseVersion: 1,
					changes: [{ op: "put", path: "a", content: "two" }],
				});
				a.strictEqual(text((await workspaces.read(ctx, record.id, "a", { version: 1 })).content), "one");
				a.strictEqual(text((await workspaces.read(ctx, record.id, "a")).content), "two");
				a.strictEqual((await workspaces.stat(ctx, record.id, "a", { version: 1 })).version, 1);
				a.strictEqual((await workspaces.stat(ctx, record.id, "a")).version, 2);
			}),
		},
		{
			name: "rejects paths that are not normalised relative paths as invalid",
			run: withSubject(async ({ workspaces }) => {
				const record = await workspaces.create(ctx, { owner });
				for (const path of ["", "../escape", "a/../b", "./a", "a//b", "a\\b", "dir/", "/elsewhere/a"]) {
					await a.rejectsWithCode(
						workspaces.commit(ctx, record.id, {
							baseVersion: 0,
							changes: [
								{ op: "put", path: "fine.txt", content: "x" },
								{ op: "put", path, content: "x" },
							],
						}),
						"invalid",
						`commit of ${JSON.stringify(path)}`,
					);
					await a.rejectsWithCode(workspaces.read(ctx, record.id, path), "invalid", `read of ${JSON.stringify(path)}`);
				}
				a.strictEqual((await workspaces.get(ctx, record.id)).head, 0);
			}),
		},
		{
			name: "lists 250 files in three pages, sorted and without bodies",
			run: withSubject(async ({ workspaces }) => {
				const record = await workspaces.create(ctx, { owner });
				const changes: WorkspaceChange[] = [];
				for (let index = 0; index < 250; index++) {
					changes.push({ op: "put", path: `file-${String(index).padStart(3, "0")}.txt`, content: `body ${index}` });
				}
				await workspaces.commit(ctx, record.id, { baseVersion: 0, changes });
				const pages: string[][] = [];
				let cursor: string | undefined;
				do {
					const page = await workspaces.list(ctx, record.id, cursor === undefined ? {} : { cursor });
					for (const item of page.items) a.strictEqual("content" in item, false, "list must not return bodies");
					pages.push(page.items.map((item) => item.path));
					cursor = page.nextCursor;
				} while (cursor !== undefined && pages.length < 5);
				a.deepEqual(
					pages.map((page) => page.length),
					[100, 100, 50],
				);
				const all = pages.flat();
				a.deepEqual(all, [...all].sort());
				a.strictEqual(new Set(all).size, 250);
				a.partialDeepEqual((await workspaces.list(ctx, record.id, { limit: 10 })).items[0], {
					path: "file-000.txt",
					kind: "file",
					size: 6,
					version: 1,
				});
			}),
		},
		{
			name: "lists nested files only when recursive",
			run: withSubject(async ({ workspaces }) => {
				const record = await workspaces.create(ctx, {
					owner,
					seed: {
						name: "s",
						sources: [{ kind: "files", files: { "top.txt": "t", "docs/a.md": "a", "docs/deep/b.md": "b" } }],
					},
				});
				const shallow = await workspaces.list(ctx, record.id);
				a.deepEqual(
					shallow.items.map((item) => [item.path, item.kind]),
					[
						["docs", "directory"],
						["top.txt", "file"],
					],
				);
				const docs = await workspaces.list(ctx, record.id, { path: "docs" });
				a.deepEqual(
					docs.items.map((item) => item.path),
					["docs/a.md", "docs/deep"],
				);
				const deep = await workspaces.list(ctx, record.id, { recursive: true });
				a.deepEqual(
					deep.items.map((item) => item.path),
					["docs", "docs/a.md", "docs/deep", "docs/deep/b.md", "top.txt"],
				);
				a.strictEqual((await workspaces.stat(ctx, record.id, "docs/deep")).kind, "directory");
				await a.rejectsWithCode(workspaces.list(ctx, record.id, { path: "missing" }), "not_found");
			}),
		},
		{
			name: "returns history newest first with the committing actor",
			run: withSubject(async ({ workspaces }) => {
				const record = await workspaces.create(ctx, { owner });
				const bot = agentCtx;
				await workspaces.commit(ctx, record.id, { baseVersion: 0, changes: [{ op: "put", path: "a", content: "1" }] });
				await workspaces.commit(bot, record.id, {
					baseVersion: 1,
					changes: [{ op: "put", path: "b", content: "2" }],
					message: "agent edit",
				});
				const history = await workspaces.history(ctx, record.id);
				a.partialDeepEqual(history.items[0], { version: 2, actor: bot.actor, changed: ["b"], message: "agent edit" });
				a.partialDeepEqual(history.items[1], { version: 1, actor: ctx.actor, changed: ["a"] });
				const firstPage = await workspaces.history(ctx, record.id, { limit: 1 });
				a.strictEqual(firstPage.items[0]?.version, 2);
				a.ok(firstPage.nextCursor, "a short page has a cursor");
				const next = await workspaces.history(ctx, record.id, { limit: 1, cursor: firstPage.nextCursor! });
				a.strictEqual(next.items[0]?.version, 1);
			}),
		},
		{
			name: "exports only the files under the requested prefixes at head",
			run: withSubject(async ({ workspaces }) => {
				const record = await workspaces.create(ctx, {
					owner,
					seed: {
						name: "s",
						sources: [{ kind: "files", files: { "notes/a.md": "a", "notes/sub/b.md": "b", "src/c.ts": "c" } }],
					},
				});
				await workspaces.commit(ctx, record.id, {
					baseVersion: 1,
					changes: [{ op: "put", path: "notes/a.md", content: "a2" }],
				});
				const exported = await workspaces.export(ctx, record.id, ["notes/"]);
				a.deepEqual(
					exported.map((file) => [file.path, text(file.content)]),
					[
						["notes/a.md", "a2"],
						["notes/sub/b.md", "b"],
					],
				);
			}),
		},
		{
			name: "refuses a commit under /project, audits it and leaves the head unchanged",
			run: withSubject(async (subject, deps) => {
				const { record } = await withProjectMount(subject);
				await a.rejectsWithCode(
					subject.workspaces.commit(ctx, record.id, {
						baseVersion: record.head,
						changes: [
							{ op: "put", path: "notes/ok.md", content: "fine" },
							{ op: "put", path: "/project/README.md", content: "overwritten" },
						],
					}),
					"refused",
				);
				const refused = deps.audit.ofType("workspace.write.refused");
				a.strictEqual(refused.length, 1);
				a.partialDeepEqual(refused[0], {
					source: "workspace",
					organisationId: WORKSPACE_FIXTURE.organisationId,
					actor: ctx.actor,
					subject: { kind: "workspace", id: record.id },
				});
				a.strictEqual((await subject.workspaces.get(ctx, record.id)).head, record.head);
				await a.rejectsWithCode(subject.workspaces.read(ctx, record.id, "notes/ok.md"), "not_found");
				a.strictEqual(
					text((await subject.workspaces.read(ctx, record.id, "/project/README.md")).content),
					"project readme v1",
				);
				a.strictEqual(deps.audit.ofType("workspace.committed").length, 0);
			}),
		},
		{
			name: "keeps a mount read-only and pinned until remount",
			run: withSubject(async (subject) => {
				const { record, pinned } = await withProjectMount(subject);
				a.deepEqual(record.mounts, [
					{ path: "/project", source: subject.projectFiles.kind, ref: project, version: pinned, readOnly: true },
				]);
				const next = await writeProjectFiles(subject.projectFiles, ctx, project, [
					{ op: "put", path: "README.md", content: "project readme v2" },
				]);
				a.ok(next !== pinned, "a write creates a new source version");
				a.strictEqual(await subject.projectFiles.latestVersion(ctx, project), next);
				const stillPinned = await subject.workspaces.read(ctx, record.id, "/project/README.md");
				a.strictEqual(text(stillPinned.content), "project readme v1");
				a.strictEqual(stillPinned.version, pinned);

				const remounted = await subject.workspaces.remount(ctx, record.id, {
					path: "/project",
					source: subject.projectFiles.kind,
					ref: project,
				});
				a.partialDeepEqual(remounted.mounts[0], { path: "/project", version: next, readOnly: true });
				a.strictEqual(
					text((await subject.workspaces.read(ctx, record.id, "/project/README.md")).content),
					"project readme v2",
				);
				// Pinning an explicit version still reads that version.
				const older = await subject.workspaces.create(ctx, {
					owner,
					mounts: [{ path: "/project", source: subject.projectFiles.kind, ref: project, version: pinned }],
				});
				a.strictEqual(
					text((await subject.workspaces.read(ctx, older.id, "/project/README.md")).content),
					"project readme v1",
				);
			}),
		},
		{
			name: "lists and reads /project through the mount",
			run: withSubject(async (subject) => {
				const { record } = await withProjectMount(subject);
				const listed = await subject.workspaces.list(ctx, record.id, { path: "/project" });
				a.deepEqual(
					listed.items.map((item) => [item.path, item.kind]),
					[
						["/project/README.md", "file"],
						["/project/src", "directory"],
					],
				);
				const deep = await subject.workspaces.list(ctx, record.id, { path: "/project", recursive: true });
				a.deepEqual(
					deep.items.map((item) => item.path),
					["/project/README.md", "/project/src", "/project/src/app.ts"],
				);
				const file = await subject.workspaces.read(ctx, record.id, "/project/src/app.ts");
				a.strictEqual(text(file.content), "export const app = 1;");
				a.partialDeepEqual(await subject.workspaces.stat(ctx, record.id, "/project/src/app.ts"), {
					path: "/project/src/app.ts",
					kind: "file",
				});
				await a.rejectsWithCode(subject.workspaces.read(ctx, record.id, "/project/missing.md"), "not_found");
				a.deepEqual((await subject.workspaces.list(ctx, record.id)).items, []);
			}),
		},
		{
			name: "audits each commit as workspace.committed",
			run: withSubject(async ({ workspaces }, deps) => {
				const record = await workspaces.create(ctx, { owner });
				await workspaces.commit(ctx, record.id, {
					baseVersion: 0,
					changes: [{ op: "put", path: "a", content: "1" }],
					writer: { sessionId: WORKSPACE_FIXTURE.sessionId, leaseId: "lease-1" },
				});
				const committed = deps.audit.ofType("workspace.committed");
				a.strictEqual(committed.length, 1);
				a.partialDeepEqual(committed[0], {
					source: "workspace",
					actor: ctx.actor,
					organisationId: WORKSPACE_FIXTURE.organisationId,
					sessionId: WORKSPACE_FIXTURE.sessionId,
					subject: { kind: "workspace", id: record.id },
				});
			}),
		},
		{
			name: "hides another organisation's workspace as not_found",
			run: withSubject(async (subject) => {
				const { record } = await withProjectMount(subject);
				const { workspaces } = subject;
				await a.rejectsWithCode(workspaces.get(otherCtx, record.id), "not_found");
				await a.rejectsWithCode(workspaces.list(otherCtx, record.id), "not_found");
				await a.rejectsWithCode(workspaces.read(otherCtx, record.id, "/project/README.md"), "not_found");
				await a.rejectsWithCode(workspaces.stat(otherCtx, record.id, "/project"), "not_found");
				await a.rejectsWithCode(
					workspaces.commit(otherCtx, record.id, { baseVersion: 0, changes: [{ op: "put", path: "a", content: "x" }] }),
					"not_found",
				);
				await a.rejectsWithCode(workspaces.history(otherCtx, record.id), "not_found");
				await a.rejectsWithCode(workspaces.export(otherCtx, record.id, [""]), "not_found");
				await a.rejectsWithCode(
					workspaces.remount(otherCtx, record.id, {
						path: "/project",
						source: subject.projectFiles.kind,
						ref: project,
					}),
					"not_found",
				);
				a.strictEqual((await workspaces.get(ctx, record.id)).head, 0);
			}),
		},
	];
	if (options.projectAccess !== true) return cases;

	/** What the denial cases check stayed the same: the head, the mounts and the project files' latest version. */
	async function snapshot(subject: WorkspaceSubject, id: string) {
		const record = await subject.workspaces.get(ctx, id);
		return {
			head: record.head,
			mounts: record.mounts,
			files: await subject.projectFiles.latestVersion(ctx, project),
		};
	}
	const projectMount = (subject: WorkspaceSubject, ref: string = project) => ({
		path: "/project",
		source: subject.projectFiles.kind,
		ref,
	});
	const change = [{ op: "put", path: "a", content: "x" }] as const;

	/**
	 * A workspace of the project with another project's files mounted at `/source`. Alice, its operator, gets viewer on
	 * the source project to mount it (and operator to write its files first); nobody else gets a role there.
	 */
	async function withSourceMount(subject: WorkspaceSubject, deps: ConformanceDeps): Promise<WorkspaceRecord> {
		deps.tenancy.bind(ctx.actor, WORKSPACE_FIXTURE.organisationId, "operator", SOURCE_PROJECT);
		await writeProjectFiles(subject.projectFiles, ctx, SOURCE_PROJECT, [
			{ op: "put", path: "README.md", content: "source readme" },
		]);
		return subject.workspaces.create(ctx, {
			owner,
			sessionId: WORKSPACE_FIXTURE.sessionId,
			mounts: [{ path: "/source", source: subject.projectFiles.kind, ref: SOURCE_PROJECT }],
		});
	}

	cases.push(
		{
			name: "project access: refuses an operator outside the project on every call, and changes nothing",
			run: withSubject(async (subject, deps) => {
				const { workspaces, projectFiles } = subject;
				const { record } = await withProjectMount(subject);
				const before = await snapshot(subject, record.id);
				const denied = (call: Promise<unknown>, operation: string) => assertAccessDenied(a, deps, call, { operation });
				await denied(workspaces.create(outsiderCtx, { owner }), "workspace.create");
				await denied(
					workspaces.create(outsiderCtx, {
						owner: { kind: "organisation", organisationId: WORKSPACE_FIXTURE.organisationId },
						mounts: [projectMount(subject)],
					}),
					"workspace.mount",
				);
				await denied(workspaces.get(outsiderCtx, record.id), "workspace.get");
				await denied(workspaces.list(outsiderCtx, record.id), "workspace.list");
				await denied(workspaces.stat(outsiderCtx, record.id, "/project/README.md"), "workspace.stat");
				await denied(workspaces.read(outsiderCtx, record.id, "/project/README.md"), "workspace.read");
				await denied(
					workspaces.commit(outsiderCtx, record.id, { baseVersion: record.head, changes: change }),
					"workspace.commit",
				);
				await denied(workspaces.history(outsiderCtx, record.id), "workspace.history");
				await denied(workspaces.export(outsiderCtx, record.id, [""]), "workspace.export");
				await denied(workspaces.remount(outsiderCtx, record.id, projectMount(subject)), "workspace.remount");
				await denied(
					writeProjectFiles(projectFiles, outsiderCtx, project, [{ op: "put", path: "README.md", content: "x" }]),
					"workspace.files.write",
				);
				a.deepEqual(await snapshot(subject, record.id), before);
				a.strictEqual(deps.audit.ofType("workspace.committed").length, 0);
			}),
		},
		{
			name: "project access: refuses a viewer a change but lets it read",
			run: withSubject(async (subject, deps) => {
				const { workspaces, projectFiles } = subject;
				const { record } = await withProjectMount(subject);
				const before = await snapshot(subject, record.id);
				a.strictEqual(
					text((await workspaces.read(viewerCtx, record.id, "/project/README.md")).content),
					"project readme v1",
				);
				a.strictEqual((await workspaces.history(viewerCtx, record.id)).items[0]?.version, record.head);
				await assertAccessDenied(
					a,
					deps,
					workspaces.commit(viewerCtx, record.id, { baseVersion: record.head, changes: change }),
					{ operation: "workspace.commit" },
				);
				await assertAccessDenied(a, deps, workspaces.create(viewerCtx, { owner }), { operation: "workspace.create" });
				await assertAccessDenied(a, deps, workspaces.remount(viewerCtx, record.id, projectMount(subject)), {
					operation: "workspace.remount",
				});
				await assertAccessDenied(
					a,
					deps,
					writeProjectFiles(projectFiles, viewerCtx, project, [{ op: "put", path: "README.md", content: "x" }]),
					{ operation: "workspace.files.write" },
				);
				a.deepEqual(await snapshot(subject, record.id), before);
			}),
		},
		{
			name: "project access: refuses mounting another project's files, and changes nothing",
			run: withSubject(async (subject, deps) => {
				const { workspaces } = subject;
				const { record } = await withProjectMount(subject);
				const before = await snapshot(subject, record.id);
				const elsewhere = WORKSPACE_FIXTURE.otherProjectId;
				await assertAccessDenied(
					a,
					deps,
					workspaces.create(ctx, { owner, mounts: [projectMount(subject, elsewhere)] }),
					{ operation: "workspace.mount" },
				);
				await assertAccessDenied(
					a,
					deps,
					workspaces.create(ctx, {
						owner,
						seed: { name: "s", sources: [], mounts: [projectMount(subject, elsewhere)] },
					}),
					{ operation: "workspace.mount", message: "a seed mount is checked too" },
				);
				await assertAccessDenied(a, deps, workspaces.remount(ctx, record.id, projectMount(subject, elsewhere)), {
					operation: "workspace.mount",
				});
				a.deepEqual(await snapshot(subject, record.id), before);
			}),
		},
		{
			name: "project access: refuses an agent whose session belongs to another project, and changes nothing",
			run: withSubject(async (subject, deps) => {
				const { workspaces } = subject;
				const { record } = await withProjectMount(subject);
				const tied = await workspaces.create(ctx, { owner, sessionId: WORKSPACE_FIXTURE.sessionId });
				const before = await snapshot(subject, record.id);
				const denied = (call: Promise<unknown>, operation: string, message: string) =>
					assertAccessDenied(a, deps, call, { operation, message });
				await denied(
					workspaces.commit(strayAgentCtx, record.id, { baseVersion: record.head, changes: change }),
					"workspace.commit",
					"a commit to this project's workspace",
				);
				await denied(
					workspaces.read(strayAgentCtx, record.id, "/project/README.md"),
					"workspace.read",
					"a read of this project's workspace",
				);
				await denied(
					workspaces.get(strayAgentCtx, tied.id),
					"workspace.get",
					"a read of this project's session workspace",
				);
				await denied(
					workspaces.create(strayAgentCtx, { owner, sessionId: WORKSPACE_FIXTURE.sessionId }),
					"workspace.create",
					"a workspace for this project's session",
				);
				await denied(
					workspaces.create(strayAgentCtx, {
						owner: { kind: "organisation", organisationId: WORKSPACE_FIXTURE.organisationId },
						sessionId: WORKSPACE_FIXTURE.sessionId,
					}),
					"workspace.create",
					"a workspace naming only this project's session",
				);
				a.deepEqual(await snapshot(subject, record.id), before);
				a.strictEqual((await workspaces.get(ctx, tied.id)).head, 0);
			}),
		},
		{
			name: "project access: refuses an agent acting on another session's workspace in its own project",
			run: withSubject(async (subject, deps) => {
				const { workspaces } = subject;
				const tied = await workspaces.create(ctx, {
					owner: { kind: "organisation", organisationId: WORKSPACE_FIXTURE.organisationId },
					sessionId: WORKSPACE_FIXTURE.sessionId,
				});
				await assertAccessDenied(a, deps, workspaces.get(siblingAgentCtx, tied.id), { operation: "workspace.get" });
				await assertAccessDenied(
					a,
					deps,
					workspaces.commit(siblingAgentCtx, tied.id, { baseVersion: 0, changes: change }),
					{ operation: "workspace.commit" },
				);
				await assertAccessDenied(
					a,
					deps,
					workspaces.create(siblingAgentCtx, { owner, sessionId: WORKSPACE_FIXTURE.sessionId }),
					{ operation: "workspace.create" },
				);
				a.strictEqual((await workspaces.get(agentCtx, tied.id)).head, 0);
			}),
		},
		{
			name: "project access: refuses an agent whose session was closed",
			run: withSubject(async (subject, deps) => {
				const { workspaces } = subject;
				const { record } = await withProjectMount(subject);
				const first = await workspaces.commit(closingAgentCtx, record.id, {
					baseVersion: record.head,
					changes: change,
				});
				deps.tenancy.close("sess-closing");
				await assertAccessDenied(
					a,
					deps,
					workspaces.commit(closingAgentCtx, record.id, {
						baseVersion: first.version,
						changes: [{ op: "put", path: "b", content: "y" }],
					}),
					{ operation: "workspace.commit" },
				);
				await assertAccessDenied(a, deps, workspaces.read(closingAgentCtx, record.id, "a"), {
					operation: "workspace.read",
				});
				await assertAccessDenied(a, deps, workspaces.create(closingAgentCtx, { owner }), {
					operation: "workspace.create",
				});
				a.strictEqual((await workspaces.get(ctx, record.id)).head, first.version);
			}),
		},
		{
			name: "project access: lets an operator on the project and an agent in its own session work",
			run: withSubject(async (subject) => {
				const { workspaces } = subject;
				const { record } = await withProjectMount(subject);
				await workspaces.commit(ctx, record.id, { baseVersion: record.head, changes: change });
				const own = await workspaces.create(agentCtx, {
					owner,
					sessionId: WORKSPACE_FIXTURE.sessionId,
					mounts: [projectMount(subject)],
				});
				const committed = await workspaces.commit(agentCtx, own.id, { baseVersion: 0, changes: change });
				a.strictEqual(committed.version, 1);
				a.strictEqual(
					text((await workspaces.read(agentCtx, own.id, "/project/README.md")).content),
					"project readme v1",
				);
				a.strictEqual((await workspaces.list(agentCtx, own.id)).items.length, 1);
				a.strictEqual((await workspaces.export(agentCtx, own.id, [""])).length, 1);
				const next = await writeProjectFiles(subject.projectFiles, agentCtx, project, [
					{ op: "put", path: "README.md", content: "project readme v2" },
				]);
				a.partialDeepEqual((await workspaces.remount(agentCtx, own.id, projectMount(subject))).mounts[0], {
					version: next,
				});
				// An operator on the project reads the agent's session workspace.
				a.strictEqual((await workspaces.get(ctx, own.id)).head, 1);
			}),
		},
		{
			name: "mount reads: a read through a mount passes when the caller may read the project the files come from",
			run: withSubject(async (subject, deps) => {
				const { workspaces } = subject;
				const record = await withSourceMount(subject, deps);
				a.strictEqual(text((await workspaces.read(ctx, record.id, "/source/README.md")).content), "source readme");
				a.deepEqual(
					(await workspaces.list(ctx, record.id, { path: "/source" })).items.map((entry) => entry.path),
					["/source/README.md"],
				);
				a.strictEqual((await workspaces.stat(ctx, record.id, "/source/README.md")).kind, "file");
				a.strictEqual(deps.audit.ofType("access.denied").length, 0, "nothing was refused");
			}),
		},
		{
			name: "mount reads: refuses a caller the source project, though it may read the workspace's own project",
			run: withSubject(async (subject, deps) => {
				const { workspaces } = subject;
				const record = await withSourceMount(subject, deps);
				await workspaces.commit(ctx, record.id, { baseVersion: record.head, changes: change });
				// The viewer and the project's agent may read the workspace, but not the project mounted into it.
				for (const [caller, label] of [
					[viewerCtx, "a viewer on the workspace's project"],
					[agentCtx, "an agent in the workspace's project"],
				] as const) {
					a.strictEqual(text((await workspaces.read(caller, record.id, "a")).content), "x", `${label} reads its files`);
					for (const [call, what] of [
						[() => workspaces.read(caller, record.id, "/source/README.md"), "read"],
						[() => workspaces.list(caller, record.id, { path: "/source" }), "list"],
						[() => workspaces.stat(caller, record.id, "/source/README.md"), "stat"],
					] as const) {
						// Started after the audit is counted: the refusal may be audited before the call first awaits.
						const deferred = Promise.resolve().then((): Promise<unknown> => call());
						await assertAccessDenied(a, deps, deferred, {
							operation: "workspace.mount.read",
							message: `${label} may not ${what} the source project through the mount`,
						});
					}
				}
				const [refusal] = deps.audit.ofType("access.denied");
				a.strictEqual(refusal?.projectId, SOURCE_PROJECT, "the refusal names the source project");
			}),
		},
		{
			name: "mount reads: checks the source project again on every read, so access revoked between reads refuses the next",
			run: withSubject(async (subject, deps) => {
				const { workspaces } = subject;
				const record = await withSourceMount(subject, deps);
				await workspaces.commit(ctx, record.id, { baseVersion: record.head, changes: change });
				a.strictEqual(text((await workspaces.read(ctx, record.id, "/source/README.md")).content), "source readme");
				deps.tenancy.unbind(ctx.actor, WORKSPACE_FIXTURE.organisationId, SOURCE_PROJECT);
				for (const [call, what] of [
					[() => workspaces.read(ctx, record.id, "/source/README.md"), "read"],
					[() => workspaces.list(ctx, record.id, { path: "/source" }), "list"],
					[() => workspaces.stat(ctx, record.id, "/source/README.md"), "stat"],
				] as const) {
					const deferred = Promise.resolve().then((): Promise<unknown> => call());
					await assertAccessDenied(a, deps, deferred, {
						operation: "workspace.mount.read",
						message: `a ${what} after the source role was revoked`,
					});
				}
				// The workspace's own files stay readable: only the mounted project's role went.
				a.strictEqual(text((await workspaces.read(ctx, record.id, "a")).content), "x");
			}),
		},
		{
			name: "existence: in the organisation, an ID the caller may not see is forbidden and a missing one not_found; across organisations both are not_found",
			run: withSubject(async (subject) => {
				const { workspaces } = subject;
				const { record } = await withProjectMount(subject);
				await a.rejectsWithCode(workspaces.get(outsiderCtx, record.id), "forbidden", "an existing ID it may not see");
				await a.rejectsWithCode(workspaces.get(outsiderCtx, "ws-missing"), "not_found", "a missing ID");
				await a.rejectsWithCode(workspaces.get(otherCtx, record.id), "not_found", "another organisation's ID");
				await a.rejectsWithCode(workspaces.get(otherCtx, "ws-missing"), "not_found", "a missing ID elsewhere");
			}),
		},
	);
	return cases;
}

export function registerWorkspaceConformance(
	runner: ConformanceRunner,
	name: string,
	provider: WorkspaceConformanceProvider,
	options?: WorkspaceConformanceOptions,
): void {
	registerCases(
		runner,
		name,
		createWorkspaceConformance({
			assertions: createExpectAssertions(runner.expect),
			provider,
			...(options?.projectAccess === undefined ? {} : { projectAccess: options.projectAccess }),
			...(options?.keyed === undefined ? {} : { keyed: options.keyed }),
			...(options?.cancellation === undefined ? {} : { cancellation: options.cancellation }),
			...(options?.seeding === undefined ? {} : { seeding: options.seeding }),
			...(options?.fork === undefined ? {} : { fork: options.fork }),
			...(options?.orgFiles === undefined ? {} : { orgFiles: options.orgFiles }),
		}),
	);
}
