/**
 * Conformance suite for `Sharing` and `ProjectAccess.resource` (packages/contracts/src/sharing.ts, access.ts;
 * docs/design/sharing.md). Every target registers it with a provider that builds a fresh store on the suite's clock,
 * audit sink, project access and resolvers. The suite's `access` reads shares through the store the provider hands
 * back, as a deployed target wires them.
 */
import {
	type CallContext,
	createProjectAccess,
	type OwnerRef,
	type ProjectAccess,
	type ResourceCheck,
	type ResourceResolver,
	type Sharing,
	type SharingLookup,
} from "@harbour/contracts";
import {
	actors,
	assertAccessDenied,
	assertWorkerCallRefused,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceRunner,
	contextFor,
	createExpectAssertions,
	ManualClock,
	RecordingAuditSink,
	registerCases,
	TenancyFixture,
	WORKER,
} from "./harness.ts";

export type SharingSubjectStore = Sharing & SharingLookup;

export interface SharingSubject {
	readonly sharing: SharingSubjectStore;
}

export interface SharingDeps {
	readonly clock: ManualClock;
	readonly audit: RecordingAuditSink;
	readonly tenancy: TenancyFixture;
	/** The reference `ProjectAccess`, reading shares through the store under test. Wire it into the store. */
	readonly access: ProjectAccess;
	/** Owners of the suite's skills (`skills.skill`). Wire them into the store. */
	readonly resolvers: { readonly [kind: string]: ResourceResolver };
}

export type SharingConformanceProvider = (
	deps: SharingDeps,
	use: (subject: SharingSubject) => Promise<void>,
) => Promise<void>;

const ORG = "org-a";
const OTHER_ORG = "org-b";
const OWNER_PROJECT = "proj-owner";
const USER_PROJECT = "proj-user";
const THIRD_PROJECT = "proj-third";
const SKILL = "skills.skill";

/** Admin of the owning project. */
const ownerAdmin = contextFor(actors.human("owner-admin"), ORG, OWNER_PROJECT);
/** Operator on the owning project only. */
const ownerOperator = contextFor(actors.human("owner-operator"), ORG, OWNER_PROJECT);
/** Admin of the project the resource is shared into. */
const userAdmin = contextFor(actors.human("user-admin"), ORG, USER_PROJECT);
/** Operator on the project the resource is shared into. */
const userOperator = contextFor(actors.human("user-operator"), ORG, USER_PROJECT);
/** A person with no role anywhere: authority only through bindings. */
const reviewer = contextFor(actors.human("reviewer"), ORG);
const groupReviewer = contextFor(actors.human("group-reviewer"), ORG);
const orgAdmin = contextFor(actors.human("org-admin"), ORG);
const outsider = contextFor(actors.human("outsider"), OTHER_ORG);
/** The supervisor agent in the user project, its child, and an agent in the owning project. */
const supervisor = contextFor(actors.agent("agent-super", "sess-super"), ORG, USER_PROJECT);
const child = contextFor(actors.agent("agent-child", "sess-child"), ORG, USER_PROJECT);
const sibling = contextFor(actors.agent("agent-sibling", "sess-sibling"), ORG, USER_PROJECT);
const thirdAgent = contextFor(actors.agent("agent-third", "sess-third"), ORG, THIRD_PROJECT);

const owned = (projectId: string): OwnerRef => ({ kind: "project", organisationId: ORG, projectId });
/** The suite's skills and their owners. */
const SKILLS: { readonly [id: string]: OwnerRef } = {
	"sk-owner": owned(OWNER_PROJECT),
	"sk-org": { kind: "organisation", organisationId: ORG },
	"sk-user": owned(USER_PROJECT),
};
const skill = (id = "sk-owner", revision?: number) => ({
	kind: SKILL,
	id,
	...(revision === undefined ? {} : { revision }),
});

function seed(tenancy: TenancyFixture): void {
	tenancy.bind(ownerAdmin.actor, ORG, "admin", OWNER_PROJECT);
	tenancy.bind(ownerOperator.actor, ORG, "operator", OWNER_PROJECT);
	tenancy.bind(userAdmin.actor, ORG, "admin", USER_PROJECT);
	tenancy.bind(userOperator.actor, ORG, "operator", USER_PROJECT);
	tenancy.bind(orgAdmin.actor, ORG, "admin");
	tenancy.bind(outsider.actor, OTHER_ORG, "admin");
	tenancy.session({ id: "sess-super", organisationId: ORG, projectId: USER_PROJECT, agentId: "agent-super" });
	tenancy.session({
		id: "sess-child",
		organisationId: ORG,
		projectId: USER_PROJECT,
		agentId: "agent-child",
		parentSessionId: "sess-super",
	});
	tenancy.session({ id: "sess-sibling", organisationId: ORG, projectId: USER_PROJECT, agentId: "agent-sibling" });
	tenancy.session({ id: "sess-third", organisationId: ORG, projectId: THIRD_PROJECT, agentId: "agent-third" });
}

/** The check a session makes to use the suite's skill. */
const useCheck = (ctx: CallContext, extra: Partial<ResourceCheck> = {}): ResourceCheck => ({
	resource: skill(),
	owner: SKILLS["sk-owner"] as OwnerRef,
	permission: "use",
	operation: "skills.use",
	...(ctx.actor.kind === "agent" ? { sessionId: ctx.actor.sessionId } : {}),
	...extra,
});

export function registerSharingConformance(
	runner: ConformanceRunner,
	name: string,
	provider: SharingConformanceProvider,
): void {
	const a = createExpectAssertions(runner.expect);

	const withSubject = (
		run: (subject: SharingSubject, deps: SharingDeps, a: ConformanceAssertions) => Promise<void>,
	): (() => Promise<void>) => {
		return async () => {
			const clock = new ManualClock();
			const audit = new RecordingAuditSink();
			const tenancy = new TenancyFixture(clock);
			seed(tenancy);
			let store: SharingSubjectStore | undefined;
			const late = (): SharingSubjectStore => {
				if (store === undefined) throw new Error("the store is not ready");
				return store;
			};
			const lookup: SharingLookup = {
				sharesOf: (ctx, organisationId, resource) => late().sharesOf(ctx, organisationId, resource),
				bindingsOf: (ctx, organisationId, object) => late().bindingsOf(ctx, organisationId, object),
				groupsOf: (ctx, organisationId, subject) => late().groupsOf(ctx, organisationId, subject),
				policyOf: (ctx, organisationId, resource) => late().policyOf(ctx, organisationId, resource),
				recordUse: (ctx, use) => late().recordUse(ctx, use),
				sharedInto: (ctx, organisationId, grantees, kind) => late().sharedInto(ctx, organisationId, grantees, kind),
			};
			const access = createProjectAccess({
				identity: tenancy.identity,
				sessions: tenancy.sessions,
				audit,
				clock,
				sharing: lookup,
			});
			const resolvers = {
				[SKILL]: {
					async ownerOf(ctx, resource) {
						const owner = SKILLS[resource.id];
						return owner === undefined || ctx.organisationId !== ORG ? undefined : { owner, name: resource.id };
					},
				} satisfies ResourceResolver,
			};
			const deps: SharingDeps = { clock, audit, tenancy, access, resolvers };
			await provider(deps, async (subject) => {
				store = subject.sharing;
				await run(subject, deps, a);
			});
		};
	};

	const cases: ConformanceCase[] = [
		{
			name: "another project's skill is refused until shared, then used, and the use is recorded",
			run: withSubject(async ({ sharing }, deps, a) => {
				await assertAccessDenied(a, deps, deps.access.resource(supervisor, useCheck(supervisor)), {
					operation: "skills.use",
				});
				// The owner's own sessions and people pass without a share.
				a.partialDeepEqual(
					await deps.access.resource(ownerOperator, useCheck(ownerOperator, { projectId: OWNER_PROJECT })),
					{
						via: "owner",
					},
				);
				const share = await sharing.createShare(ownerAdmin, {
					resource: skill(),
					grantee: { kind: "project", projectId: USER_PROJECT },
					permission: "use",
					note: "for the support team",
				});
				a.partialDeepEqual(share, {
					organisationId: ORG,
					resource: { kind: SKILL, id: "sk-owner" },
					owner: SKILLS["sk-owner"],
					grantee: { kind: "project", projectId: USER_PROJECT },
					permission: "use",
					grantedBy: ownerAdmin.actor,
				});
				const passed = await deps.access.resource(supervisor, useCheck(supervisor, { resource: skill("sk-owner", 3) }));
				a.strictEqual(passed.via, "share");
				a.strictEqual(passed.share?.id, share.id);
				const uses = await sharing.listUses(userOperator, { sessionId: "sess-super" });
				a.deepEqual(
					uses.map((use) => ({ resource: use.resource, shareId: use.shareId })),
					[{ resource: { kind: SKILL, id: "sk-owner", revision: 3 }, shareId: share.id }],
				);
				// A third project still can't.
				await assertAccessDenied(a, deps, deps.access.resource(thirdAgent, useCheck(thirdAgent)), {
					operation: "skills.use",
				});
				a.strictEqual(deps.audit.ofType("sharing.share.created").length, 1);
			}),
		},
		{
			name: "organisation resources stay usable in every project without a share",
			run: withSubject(async (_subject, deps, a) => {
				const result = await deps.access.resource(thirdAgent, {
					resource: skill("sk-org"),
					owner: SKILLS["sk-org"] as OwnerRef,
					permission: "use",
					operation: "skills.use",
				});
				a.strictEqual(result.via, "owner");
			}),
		},
		{
			name: "a pinned share covers only its revision",
			run: withSubject(async ({ sharing }, deps, a) => {
				await sharing.createShare(ownerAdmin, {
					resource: skill("sk-owner", 2),
					grantee: { kind: "project", projectId: USER_PROJECT },
					permission: "use",
				});
				const unpinned = await deps.access.allowsResource(supervisor, useCheck(supervisor));
				a.strictEqual(unpinned?.share?.resource.revision, 2, "the share names the revision to use");
				a.ok(
					(await deps.access.allowsResource(supervisor, useCheck(supervisor, { resource: skill("sk-owner", 2) }))) !==
						undefined,
				);
				a.strictEqual(
					await deps.access.allowsResource(supervisor, useCheck(supervisor, { resource: skill("sk-owner", 3) })),
					undefined,
				);
			}),
		},
		{
			name: "only the owner's admins and approvers may share; never the grantee side",
			run: withSubject(async ({ sharing }, deps, a) => {
				const input = {
					resource: skill(),
					grantee: { kind: "project", projectId: THIRD_PROJECT },
					permission: "use",
				} as const;
				await assertAccessDenied(a, deps, sharing.createShare(ownerOperator, input), {
					operation: "sharing.createShare",
				});
				await assertAccessDenied(a, deps, sharing.createShare(userAdmin, input), { operation: "sharing.createShare" });
				await assertAccessDenied(a, deps, sharing.createShare(reviewer, input), { operation: "sharing.createShare" });
				// An approver binding, direct or through a group, is authority.
				await sharing.addBinding(ownerAdmin, {
					object: skill(),
					relation: "approver",
					subject: { kind: "user", userId: "reviewer" },
				});
				await sharing.createShare(reviewer, input);
				await sharing.addBinding(ownerAdmin, {
					object: skill(),
					relation: "approver",
					subject: { kind: "group", groupId: "reviewers" },
				});
				await assertAccessDenied(a, deps, sharing.createShare(groupReviewer, input), {
					operation: "sharing.createShare",
				});
				await sharing.addBinding(orgAdmin, {
					object: { kind: "group", id: "reviewers" },
					relation: "member",
					subject: { kind: "user", userId: "group-reviewer" },
				});
				await sharing.createShare(groupReviewer, input);
				// A share with approve never lets its holder share on.
				await sharing.createShare(ownerAdmin, {
					...input,
					grantee: { kind: "project", projectId: USER_PROJECT },
					permission: "approve",
				});
				await assertAccessDenied(a, deps, sharing.createShare(userAdmin, input), { operation: "sharing.createShare" });
				// A maintainer edits but doesn't share.
				await sharing.addBinding(ownerAdmin, {
					object: skill(),
					relation: "maintainer",
					subject: { kind: "user", userId: "user-operator" },
				});
				await assertAccessDenied(a, deps, sharing.createShare(userOperator, input), {
					operation: "sharing.createShare",
				});
				// Only an organisation admin manages a group.
				await assertAccessDenied(
					a,
					deps,
					sharing.addBinding(ownerAdmin, {
						object: { kind: "group", id: "reviewers" },
						relation: "member",
						subject: { kind: "user", userId: "owner-admin" },
					}),
					{ operation: "sharing.addBinding" },
				);
				await a.rejectsWithCode(
					sharing.addBinding(ownerAdmin, {
						object: skill(),
						relation: "member",
						subject: { kind: "user", userId: "x" },
					}),
					"invalid",
				);
				await a.rejectsWithCode(
					sharing.addBinding(orgAdmin, {
						object: { kind: "group", id: "reviewers" },
						relation: "member",
						subject: { kind: "group", groupId: "nested" },
					}),
					"invalid",
				);
				await a.rejectsWithCode(
					sharing.createShare(ownerAdmin, { ...input, grantee: { kind: "project", projectId: OWNER_PROJECT } }),
					"invalid",
				);
			}),
		},
		{
			name: "may use is separate from may change: shares, maintainers and approvers",
			run: withSubject(async ({ sharing }, deps, a) => {
				const change = (ctx: CallContext, permission: "propose" | "edit" | "approve") =>
					deps.access.allowsResource(ctx, {
						resource: skill(),
						owner: SKILLS["sk-owner"] as OwnerRef,
						permission,
						needed: "operator",
					});
				await sharing.createShare(ownerAdmin, {
					resource: skill(),
					grantee: { kind: "project", projectId: USER_PROJECT },
					permission: "use",
				});
				a.strictEqual(await change(userOperator, "propose"), undefined, "use alone changes nothing");
				await sharing.createShare(ownerAdmin, {
					resource: skill(),
					grantee: { kind: "project", projectId: USER_PROJECT },
					permission: "edit",
				});
				a.strictEqual((await change(userOperator, "edit"))?.via, "share");
				a.strictEqual(await change(userOperator, "approve"), undefined);
				a.strictEqual((await change(supervisor, "propose"))?.via, "share", "an agent drafts");
				a.strictEqual(await change(supervisor, "edit"), undefined, "an agent never edits");
				// The owner's operators change it through the owner rules; agents there still only propose.
				a.strictEqual((await change(ownerOperator, "approve"))?.via, "owner");
				await sharing.addBinding(ownerAdmin, {
					object: skill(),
					relation: "maintainer",
					subject: { kind: "user", userId: "reviewer" },
				});
				a.strictEqual((await change(reviewer, "edit"))?.via, "binding");
				a.strictEqual(await change(reviewer, "approve"), undefined);
				await sharing.addBinding(ownerAdmin, {
					object: skill(),
					relation: "approver",
					subject: { kind: "user", userId: "reviewer" },
				});
				a.strictEqual((await change(reviewer, "approve"))?.via, "binding");
			}),
		},
		{
			name: "a request goes to the owner's approvers, is granted once and records its decision",
			run: withSubject(async ({ sharing }, deps, a) => {
				const request = await sharing.requestAccess(supervisor, {
					resource: skill(),
					reason: "needs the review checklist",
				});
				a.partialDeepEqual(request, {
					grantee: { kind: "project", projectId: USER_PROJECT },
					permission: "use",
					status: "pending",
					requestedBy: supervisor.actor,
					sessionId: "sess-super",
					agentId: "agent-super",
					owner: SKILLS["sk-owner"],
				});
				// Asking again returns the same request.
				a.strictEqual((await sharing.requestAccess(supervisor, { resource: skill(), reason: "again" })).id, request.id);
				const ownerInbox = await sharing.listRequests(ownerAdmin, { decidable: true });
				a.deepEqual(
					ownerInbox.items.map((item) => item.id),
					[request.id],
				);
				const userInbox = await sharing.listRequests(userAdmin, { decidable: true });
				a.strictEqual(userInbox.items.length, 0, "the requesting project's admin doesn't decide");
				await assertAccessDenied(a, deps, sharing.decideRequest(userAdmin, request.id, { decision: "grant" }), {
					operation: "sharing.decideRequest",
				});
				await a.rejectsWithCode(sharing.decideRequest(supervisor, request.id, { decision: "grant" }), "forbidden");
				await a.rejectsWithCode(
					sharing.decideRequest(ownerAdmin, request.id, { decision: "grant", permission: "edit" }),
					"invalid",
					"a grant is never wider than the request",
				);
				const expiresAt = deps.clock.now() + 60_000;
				const decided = await sharing.decideRequest(ownerAdmin, request.id, {
					decision: "grant",
					note: "ok",
					expiresAt,
				});
				a.partialDeepEqual(decided.request, {
					status: "granted",
					decision: { decidedBy: ownerAdmin.actor, note: "ok", shareId: decided.share?.id },
				});
				a.partialDeepEqual(decided.share, {
					requestId: request.id,
					expiresAt,
					grantee: { kind: "project", projectId: USER_PROJECT },
				});
				await a.rejectsWithCode(sharing.decideRequest(ownerAdmin, request.id, { decision: "reject" }), "conflict");
				a.strictEqual((await sharing.getRequest(supervisor, request.id)).status, "granted");
				a.strictEqual((await deps.access.resource(supervisor, useCheck(supervisor))).via, "share");
				deps.clock.advance(60_001);
				a.strictEqual(
					await deps.access.allowsResource(supervisor, useCheck(supervisor)),
					undefined,
					"an expired share covers nothing",
				);
				const types = deps.audit.events.filter((event) => event.source === "sharing").map((event) => event.type);
				a.deepEqual(types, ["sharing.request.created", "sharing.request.granted", "sharing.share.created"]);
				const granted = deps.audit.ofType("sharing.request.granted")[0];
				a.partialDeepEqual(granted?.data, {
					resource: { kind: SKILL, id: "sk-owner" },
					grantee: `project:${USER_PROJECT}`,
					requestedBy: supervisor.actor,
					note: "ok",
				});
			}),
		},
		{
			name: "requests are rejected or withdrawn once, by the right people",
			run: withSubject(async ({ sharing }, _deps, a) => {
				const first = await sharing.requestAccess(userOperator, {
					resource: skill(),
					grantee: { kind: "project", projectId: USER_PROJECT },
					permission: "edit",
					reason: "fixing typos",
				});
				const rejected = await sharing.decideRequest(ownerAdmin, first.id, { decision: "reject", note: "not now" });
				a.partialDeepEqual(rejected.request, {
					status: "rejected",
					decision: { decidedBy: ownerAdmin.actor, note: "not now" },
				});
				a.strictEqual(rejected.share, undefined);
				const second = await sharing.requestAccess(supervisor, { resource: skill(), reason: "checklist" });
				await a.rejectsWithCode(
					sharing.withdrawRequest(sibling, second.id),
					"forbidden",
					"another agent can't withdraw it",
				);
				const withdrawn = await sharing.withdrawRequest(supervisor, second.id);
				a.strictEqual(withdrawn.status, "withdrawn");
				await a.rejectsWithCode(sharing.decideRequest(ownerAdmin, second.id, { decision: "grant" }), "conflict");
				await a.rejectsWithCode(sharing.requestAccess(supervisor, { resource: skill(), reason: " " }), "invalid");
				await a.rejectsWithCode(
					sharing.requestAccess(supervisor, {
						resource: skill(),
						grantee: { kind: "project", projectId: THIRD_PROJECT },
						reason: "elsewhere",
					}),
					"forbidden",
					"an agent requests only for its own project",
				);
			}),
		},
		{
			name: "agents never grant to their own session or project; a supervisor passes on only what it holds",
			run: withSubject(async ({ sharing }, deps, a) => {
				await a.rejectsWithCode(
					sharing.createShare(supervisor, {
						resource: skill(),
						grantee: { kind: "project", projectId: USER_PROJECT },
						permission: "use",
					}),
					"forbidden",
				);
				const held = await sharing.createShare(ownerAdmin, {
					resource: skill(),
					grantee: { kind: "session", sessionId: "sess-super" },
					permission: "propose",
				});
				await a.rejectsWithCode(
					sharing.createShare(supervisor, {
						resource: skill(),
						grantee: { kind: "session", sessionId: "sess-super" },
						permission: "use",
						parentShareId: held.id,
					}),
					"forbidden",
					"not to its own session",
				);
				await a.rejectsWithCode(
					sharing.createShare(supervisor, {
						resource: skill(),
						grantee: { kind: "project", projectId: USER_PROJECT },
						permission: "use",
						parentShareId: held.id,
					}),
					"forbidden",
					"not to its own project",
				);
				await a.rejectsWithCode(
					sharing.createShare(supervisor, {
						resource: skill(),
						grantee: { kind: "session", sessionId: "sess-sibling" },
						permission: "use",
						parentShareId: held.id,
					}),
					"forbidden",
					"not to a session it doesn't supervise",
				);
				await a.rejectsWithCode(
					sharing.createShare(supervisor, {
						resource: skill(),
						grantee: { kind: "session", sessionId: "sess-child" },
						permission: "edit",
						parentShareId: held.id,
					}),
					"forbidden",
					"no wider than held",
				);
				await a.rejectsWithCode(
					sharing.createShare(child, {
						resource: skill(),
						grantee: { kind: "session", sessionId: "sess-child" },
						permission: "use",
						parentShareId: held.id,
					}),
					"forbidden",
					"not a share it doesn't hold",
				);
				const passed = await sharing.createShare(supervisor, {
					resource: skill(),
					grantee: { kind: "session", sessionId: "sess-child" },
					permission: "use",
					parentShareId: held.id,
				});
				a.partialDeepEqual(passed, { parentShareId: held.id, grantedBy: supervisor.actor, permission: "use" });
				a.strictEqual((await deps.access.resource(child, useCheck(child))).share?.id, passed.id);
				a.strictEqual(await deps.access.allowsResource(sibling, useCheck(sibling)), undefined);
				// Revoking the held share ends the one passed on.
				await sharing.revokeShare(ownerAdmin, held.id, { reason: "done" });
				a.ok((await sharing.getShare(ownerAdmin, passed.id)).revokedAt !== undefined);
				a.strictEqual(await deps.access.allowsResource(child, useCheck(child)), undefined);
				const revoked = deps.audit.ofType("sharing.share.revoked");
				a.strictEqual(revoked.length, 2);
			}),
		},
		{
			name: "the grantee's admin may detach a share; its operators may not",
			run: withSubject(async ({ sharing }, deps, a) => {
				const share = await sharing.createShare(ownerAdmin, {
					resource: skill(),
					grantee: { kind: "project", projectId: USER_PROJECT },
					permission: "use",
				});
				await assertAccessDenied(a, deps, sharing.revokeShare(userOperator, share.id), {
					operation: "sharing.revokeShare",
				});
				const revoked = await sharing.revokeShare(userAdmin, share.id, { reason: "not needed here" });
				a.partialDeepEqual(revoked, { revokedBy: userAdmin.actor, revokeReason: "not needed here" });
				a.strictEqual(
					(await sharing.revokeShare(ownerAdmin, share.id)).revokedAt,
					revoked.revokedAt,
					"revoking again changes nothing",
				);
				const listed = await sharing.listShares(userAdmin, { grantee: { kind: "project", projectId: USER_PROJECT } });
				a.strictEqual(listed.items.length, 0);
				const all = await sharing.listShares(userAdmin, {
					grantee: { kind: "project", projectId: USER_PROJECT },
					includeInactive: true,
				});
				a.strictEqual(all.items.length, 1);
			}),
		},
		{
			name: "lists show each side what it may see",
			run: withSubject(async ({ sharing }, deps, a) => {
				await sharing.createShare(ownerAdmin, {
					resource: skill(),
					grantee: { kind: "project", projectId: USER_PROJECT },
					permission: "use",
				});
				a.strictEqual((await sharing.listShares(ownerOperator, { ownerProjectId: OWNER_PROJECT })).items.length, 1);
				a.strictEqual(
					(await sharing.listShares(userOperator, { grantee: { kind: "project", projectId: USER_PROJECT } })).items
						.length,
					1,
				);
				a.strictEqual((await sharing.listShares(ownerAdmin, { resource: skill() })).items.length, 1);
				await assertAccessDenied(a, deps, sharing.listShares(userOperator, { ownerProjectId: OWNER_PROJECT }), {
					operation: "sharing.listShares",
				});
				a.strictEqual(
					(await sharing.listShares(thirdAgent, { resource: skill() })).items.length,
					0,
					"a stranger sees none",
				);
				a.strictEqual(
					(await sharing.listShares(outsider, { resource: skill() })).items.length,
					0,
					"nor another organisation",
				);
			}),
		},
		{
			name: "a host registers its own kinds before sharing them; Harbour's are reserved",
			run: withSubject(async ({ sharing }, deps, a) => {
				const guideline = { kind: "acme.brand-guideline", id: "bg-1" };
				await a.rejectsWithCode(
					sharing.createShare(ownerAdmin, {
						resource: guideline,
						grantee: { kind: "project", projectId: USER_PROJECT },
						permission: "use",
					}),
					"not_found",
				);
				await a.rejectsWithCode(
					sharing.registerResource(ownerAdmin, { resource: { kind: SKILL, id: "x" }, owner: owned(OWNER_PROJECT) }),
					"invalid",
				);
				await a.rejectsWithCode(
					sharing.registerResource(ownerAdmin, {
						resource: { kind: "vault.secret", id: "x" },
						owner: owned(OWNER_PROJECT),
					}),
					"invalid",
				);
				await assertAccessDenied(
					a,
					deps,
					sharing.registerResource(userAdmin, { resource: guideline, owner: owned(OWNER_PROJECT) }),
					{ operation: "sharing.registerResource" },
				);
				const registered = await sharing.registerResource(ownerAdmin, {
					resource: guideline,
					owner: owned(OWNER_PROJECT),
					name: "Brand guideline",
				});
				a.partialDeepEqual(registered, { resource: guideline, owner: owned(OWNER_PROJECT), name: "Brand guideline" });
				a.partialDeepEqual(
					await sharing.registerResource(ownerAdmin, { resource: guideline, owner: owned(OWNER_PROJECT) }),
					{
						registeredAt: registered.registeredAt,
					},
				);
				await a.rejectsWithCode(
					sharing.registerResource(ownerAdmin, {
						resource: guideline,
						owner: { kind: "organisation", organisationId: ORG },
					}),
					"conflict",
				);
				await sharing.createShare(ownerAdmin, {
					resource: guideline,
					grantee: { kind: "project", projectId: USER_PROJECT },
					permission: "use",
				});
				const passed = await deps.access.resource(supervisor, {
					resource: guideline,
					owner: owned(OWNER_PROJECT),
					permission: "use",
					sessionId: "sess-super",
					operation: "acme.guideline.read",
				});
				a.strictEqual(passed.via, "share");
			}),
		},
		{
			name: "a resource's policy is set by its authority and travels with every check",
			run: withSubject(async ({ sharing }, deps, a) => {
				a.deepEqual(await sharing.getPolicy(ownerOperator, skill()), { twoPersonRule: false });
				await assertAccessDenied(a, deps, sharing.setPolicy(ownerOperator, skill(), { twoPersonRule: true }), {
					operation: "sharing.setPolicy",
				});
				await sharing.setPolicy(ownerAdmin, skill(), { twoPersonRule: true });
				a.deepEqual(await sharing.getPolicy(ownerOperator, skill()), { twoPersonRule: true });
				const result = await deps.access.resource(ownerOperator, useCheck(ownerOperator, { projectId: OWNER_PROJECT }));
				a.deepEqual(result.policy, { twoPersonRule: true });
				a.strictEqual(deps.audit.ofType("sharing.policy.set").length, 1);
			}),
		},
		{
			name: "bindings are listed by resource or subject",
			run: withSubject(async ({ sharing }, _deps, a) => {
				await sharing.addBinding(ownerAdmin, {
					object: skill(),
					relation: "maintainer",
					subject: { kind: "user", userId: "reviewer" },
				});
				await sharing.addBinding(ownerAdmin, {
					object: skill(),
					relation: "maintainer",
					subject: { kind: "user", userId: "reviewer" },
				});
				await sharing.addBinding(ownerAdmin, {
					object: skill(),
					relation: "approver",
					subject: { kind: "service", serviceId: "ci" },
				});
				const onSkill = await sharing.listBindings(ownerOperator, { object: skill() });
				a.strictEqual(onSkill.items.length, 2, "adding twice keeps one");
				const mine = await sharing.listBindings(reviewer, { subject: { kind: "user", userId: "reviewer" } });
				a.deepEqual(
					mine.items.map((binding) => binding.relation),
					["maintainer"],
				);
				await sharing.removeBinding(ownerAdmin, {
					object: skill(),
					relation: "maintainer",
					subject: { kind: "user", userId: "reviewer" },
				});
				await sharing.removeBinding(ownerAdmin, {
					object: skill(),
					relation: "maintainer",
					subject: { kind: "user", userId: "reviewer" },
				});
				a.strictEqual((await sharing.listBindings(ownerOperator, { object: skill() })).items.length, 1);
			}),
		},
		{
			name: "the lookup is a worker call",
			run: withSubject(async ({ sharing }, deps, a) => {
				await assertWorkerCallRefused(a, deps, "sharing.sharesOf", (ctx) => sharing.sharesOf(ctx, ORG, skill()), ORG);
				await assertWorkerCallRefused(
					a,
					deps,
					"sharing.recordUse",
					(ctx) =>
						sharing.recordUse(ctx, { organisationId: ORG, sessionId: "s", resource: skill(), shareId: "x", usedAt: 1 }),
					ORG,
				);
				a.deepEqual(await sharing.sharesOf(WORKER, ORG, skill()), []);
				const share = await sharing.createShare(ownerAdmin, {
					resource: skill(),
					grantee: { kind: "agent", agentId: "agent-third" },
					permission: "use",
				});
				const into = await sharing.sharedInto(WORKER, ORG, [{ kind: "agent", agentId: "agent-third" }], SKILL);
				a.deepEqual(
					into.map((item) => item.id),
					[share.id],
				);
				a.strictEqual(
					(await deps.access.resource(thirdAgent, useCheck(thirdAgent))).share?.id,
					share.id,
					"an agent grantee covers its sessions",
				);
			}),
		},
	];

	registerCases(runner, name, cases);
}
