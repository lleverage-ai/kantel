// The vault page's fixtures: an in-memory vault (from @harbour/vault) holding one proposal in each lifecycle state,
// with people on different roles, so stories and tests drive the page through the real contract. Not exported from the
// library. Every record is made through the vault's own calls on a fixed clock, so the binding codes, refusals and
// audit rows are the vault's, not the fixture's.

import { createMemoryAuditStore } from "@harbour/audit/memory";
import {
	type AccessCheck,
	type AgentId,
	type AuditStore,
	type CallContext,
	type Decision,
	HarbourError,
	type HttpMethod,
	type ProjectAccess,
	type ProjectId,
	type Proposal,
	type ProposalTerms,
	type Role,
	roleSatisfies,
	type SessionId,
	systemContext,
	type UserId,
	type Vault,
} from "@harbour/contracts";
import { createMemoryVault } from "@harbour/vault/memory";
import { DAY, HOUR, MINUTE } from "../primitives/format.ts";
import { FIXTURE_NOW } from "../session/fixtures.ts";
import { type DescribeRequester, type GrantSummary, loadActiveGrants, loadVaultRequest } from "./load.ts";
import type { RequesterLabels, VaultRequest, Viewer } from "./vault-page-model.ts";

export { FIXTURE_NOW };

export const ORGANISATION = "org_harbour";
export const VAULT_HOST = "harbour.dev";

/** The lifecycle states the fixture holds one proposal for. */
export type FixtureState =
	| "proposed"
	| "pending"
	| "read"
	| "approved"
	| "narrowed"
	| "route"
	| "secret"
	| "denied"
	| "expired"
	| "revoked"
	| "withdrawn"
	/** Open, for Tom's own (personal) item: only Tom decides it. */
	| "personal";

export const people = {
	/** Admin across the organisation; the person behind the billing and ops sessions. */
	tom: { userId: "usr_tom", name: "Tom Davies" },
	/** Operator on both projects: can approve a forwarded link, as themselves. */
	alex: { userId: "usr_alex", name: "Alex Rivera" },
	/** Viewer on Billing only: can see a forwarded request but not decide it. */
	dean: { userId: "usr_dean", name: "Dean Okafor" },
	/** No role on any project: can't open the request at all. */
	bethan: { userId: "usr_bethan", name: "Bethan Price" },
} as const satisfies Record<string, Viewer>;

type Person = keyof typeof people;

const projects: Record<ProjectId, string> = { prj_billing: "Billing", prj_platform: "Platform" };

/** Role bindings: per project, or `*` for the whole organisation. */
const roles: Record<UserId, Record<string, Role>> = {
	usr_tom: { "*": "admin" },
	usr_alex: { prj_billing: "operator", prj_platform: "operator" },
	usr_dean: { prj_billing: "viewer" },
	usr_bethan: {},
};

interface FixtureSession {
	readonly title: string;
	readonly projectId: ProjectId;
	readonly agentId: AgentId;
	readonly agent: string;
	readonly person: Person;
}

const sessions: Record<SessionId, FixtureSession> = {
	ses_billing: {
		title: "Overnight sweep: file the failed invoice bugs",
		projectId: "prj_billing",
		agentId: "agt_billing",
		agent: "Billing agent",
		person: "tom",
	},
	ses_release: {
		title: "Release notes for 0.4",
		projectId: "prj_platform",
		agentId: "agt_release",
		agent: "Release agent",
		person: "alex",
	},
	ses_ops: {
		title: "Retry the stuck staging jobs",
		projectId: "prj_platform",
		agentId: "agt_ops",
		agent: "Ops worker",
		person: "tom",
	},
};

/**
 * Project access for the fixture: the contract's `ProjectAccess` over the role table above and the sessions, as
 * identity and the session directory would answer it. Organisation-wide checks need a `*` role.
 */
function fixtureAccess(): ProjectAccess {
	const passes = (
		ctx: CallContext,
		check: Omit<AccessCheck, "operation" | "subject">,
	): ProjectId | undefined | false => {
		const actor = ctx.actor;
		// A user's own record: that user, or an agent whose own session works for them (docs/design/org-scope.md).
		if (check.userId !== undefined) {
			if (actor.kind === "human" && actor.userId !== check.userId) return false;
			if (actor.kind === "agent") {
				const own = sessions[actor.sessionId];
				if (own === undefined || own.agentId !== actor.agentId) return false;
				if (people[own.person].userId !== check.userId) return false;
				if (check.projectId === undefined && check.sessionId === undefined) {
					return roleSatisfies("operator", check.needed) ? undefined : false;
				}
			}
			if (actor.kind === "human" && check.projectId === undefined && check.sessionId === undefined) return undefined;
		}
		const session = check.sessionId === undefined ? undefined : sessions[check.sessionId];
		if (check.sessionId !== undefined && session === undefined) return false;
		if (session !== undefined && check.projectId !== undefined && session.projectId !== check.projectId) return false;
		const projectId = check.projectId ?? session?.projectId;
		if (actor.kind === "system") return projectId;
		if (actor.kind === "agent") {
			if (session === undefined) {
				const own = sessions[actor.sessionId];
				return own !== undefined &&
					own.agentId === actor.agentId &&
					(projectId === undefined || own.projectId === projectId)
					? (projectId ?? own.projectId)
					: false;
			}
			const ownSession = actor.sessionId === check.sessionId && session.agentId === actor.agentId;
			return ownSession && roleSatisfies("operator", check.needed) ? projectId : false;
		}
		if (actor.kind !== "human") return false;
		const held = roles[actor.userId] ?? {};
		const role = held["*"] ?? (projectId === undefined ? undefined : held[projectId]);
		return role !== undefined && roleSatisfies(role, check.needed) ? projectId : false;
	};
	return {
		async require(ctx, check) {
			const result = passes(ctx, check);
			if (result === false) throw new HarbourError("forbidden", "The caller may not do this in this project");
			return result === undefined
				? { scope: { kind: "organisation" } }
				: { projectId: result, scope: { kind: "project", projectId: result } };
		},
		async allows(ctx, check) {
			return passes(ctx, check) !== false;
		},
		// The vault page's fixtures share nothing across projects.
		async resource() {
			throw new HarbourError("forbidden", "The caller may not do this with this resource");
		},
		async allowsResource() {
			return undefined;
		},
	};
}

/** Names for a fixture proposal's requester. `sessionHref` links the session; none leaves it as text. */
export const requesterDescriber =
	(sessionHref?: (sessionId: SessionId) => string | undefined): DescribeRequester =>
	(proposal) => {
		const sessionId = proposal.requester.sessionId;
		const session = sessionId === undefined ? undefined : sessions[sessionId];
		const href = sessionId === undefined ? undefined : sessionHref?.(sessionId);
		const labels: RequesterLabels = {
			organisation: "Harbour",
			...(proposal.projectId === undefined ? {} : { project: projects[proposal.projectId] ?? proposal.projectId }),
			...(session === undefined
				? {}
				: {
						agent: session.agent,
						session: session.title,
						...(href === undefined ? {} : { sessionHref: href }),
						person: people[session.person].name,
						personId: people[session.person].userId,
					}),
		};
		return labels;
	};

/** A fixture session's title, for a host's session directory. */
export const sessionTitle = (sessionId: string): string | undefined => sessions[sessionId]?.title;

export const describeRequester: DescribeRequester = requesterDescriber((sessionId) => `#/sessions/${sessionId}`);

const nameOf = (userId: UserId): string | undefined =>
	Object.values(people).find((person) => person.userId === userId)?.name;

export interface ScenarioOptions {
	/** The time the scenario ends at; every record is made relative to it. Default FIXTURE_NOW. */
	readonly base?: number;
	/** Let the vault's clock run on in real time from `base`. */
	readonly live?: boolean;
	/** The store the vault writes its audit trail to, such as one already holding older history; a new one when absent. */
	readonly audit?: AuditStore;
	/** Where a requester's session links; the workbench's `#/sessions/:id` when absent, and no link when it returns none. */
	readonly sessionHref?: (sessionId: SessionId) => string | undefined;
}

export interface VaultScenario {
	readonly vault: Vault;
	readonly audit: AuditStore;
	/** The fixture's clock; stories leave it at FIXTURE_NOW, tests may move it. */
	readonly clock: { now(): number; set(at: number): void };
	readonly proposals: Readonly<Record<FixtureState, string>>;
	readonly decisions: Map<string, Decision>;
	ctxFor(person: Viewer): CallContext;
	/** Makes a proposal as the agent in one of the fixture's sessions, at the clock's time. */
	propose(sessionId: "ses_billing" | "ses_release" | "ses_ops", terms: ProposalTerms): Promise<Proposal>;
	load(proposalId: string, viewer?: Viewer): Promise<VaultRequest>;
	grants(viewer?: Viewer): Promise<GrantSummary[]>;
}

const human = (person: Viewer): CallContext => ({
	actor: { kind: "human", userId: person.userId },
	organisationId: ORGANISATION,
});
const agentIn = (sessionId: SessionId): CallContext => ({
	actor: { kind: "agent", agentId: sessions[sessionId]!.agentId, sessionId },
	organisationId: ORGANISATION,
});

const route = (host: string, methods: HttpMethod[], pathPrefix: string) => ({ host, methods, pathPrefix });

/**
 * Builds the fixture: four items, then one proposal per lifecycle state, each made and decided through the vault at
 * the time it would have happened, ending with the clock at FIXTURE_NOW. A few egress requests run under the active
 * grants so their use counts are real.
 */
export async function createVaultScenario(options: ScenarioOptions = {}): Promise<VaultScenario> {
	const base = options.base ?? FIXTURE_NOW;
	let current = base - 2 * DAY;
	let follow: number | undefined;
	const clock = {
		now: () => (follow === undefined ? current : Date.now() + follow),
		set: (at: number) => {
			current = at;
			follow = undefined;
		},
	};
	const audit = options.audit ?? createMemoryAuditStore({ clock });
	const describe = options.sessionHref === undefined ? describeRequester : requesterDescriber(options.sessionHref);
	const vault = createMemoryVault({
		clock,
		audit,
		access: fixtureAccess(),
		linkBase: `https://${VAULT_HOST}/connections`,
		expiryPollMs: 60_000,
	});
	const admin = human(people.tom);
	const decisions = new Map<string, Decision>();
	const owner = { kind: "organisation", organisationId: ORGANISATION } as const;

	const linear = await vault.putItem(admin, {
		owner,
		name: "Linear API key",
		description: "The Platform team's Linear workspace key.",
		hosts: ["api.linear.app"],
		injection: { header: "Authorization", template: "Bearer {key}" },
		value: "lin_api_canary_7f3a",
	});
	const github = await vault.putItem(admin, {
		owner,
		name: "GitHub token",
		hosts: ["api.github.com"],
		injection: { header: "Authorization", template: "token {key}" },
		value: "ghp_canary_19be",
	});
	const staging = await vault.putItem(admin, {
		owner,
		name: "Staging admin key",
		hosts: ["admin.staging.harbour.dev"],
		injection: { header: "X-Admin-Key", template: "{key}" },
		value: "stg_canary_44d0",
	});
	// Tom's own: only Tom, and sessions working for him, see or use it.
	const calendar = await vault.putItem(admin, {
		owner: { kind: "user", organisationId: ORGANISATION, userId: people.tom.userId },
		name: "Google Calendar token",
		description: "Tom's own calendar.",
		hosts: ["www.googleapis.com"],
		injection: { header: "Authorization", template: "Bearer {key}" },
		value: "ya29_canary_c41e",
	});

	const at = (offset: number) => clock.set(base + offset);
	const propose = async (sessionId: SessionId, offset: number, terms: ProposalTerms) => {
		at(offset);
		return vault.propose(agentIn(sessionId), terms);
	};
	const approve = async (
		proposalId: string,
		offset: number,
		narrowing?: Parameters<Vault["decide"]>[1]["narrowing"],
	) => {
		at(offset);
		const view = await vault.approvalView(admin, proposalId);
		const decision = await vault.decide(admin, {
			proposalId,
			outcome: "approve",
			termsHash: view.proposal.termsHash,
			pickedCode: view.proposal.bindingCode,
			...(narrowing === undefined ? {} : { narrowing }),
		});
		decisions.set(decision.id, decision);
		return decision;
	};
	const egress = async (sessionId: SessionId, method: HttpMethod, url: string, offset: number) => {
		at(offset);
		const session = sessions[sessionId]!;
		await vault.decideEgress(systemContext("egress"), {
			organisationId: ORGANISATION,
			projectId: session.projectId,
			agentId: session.agentId,
			sessionId,
			method,
			url,
		});
	};

	// Each step runs at its own time, in time order, so the vault's audit trail reads in order too.

	// Approved and narrowed: the agent asked for any write anywhere on Linear for 7 days, as often as needed; Tom
	// narrowed it to POST under /graphql for a day, 20 uses. Used three times since.
	const narrowed = await propose("ses_billing", -5 * HOUR, {
		itemId: linear.id,
		route: route("api.linear.app", ["GET", "POST", "PUT", "DELETE"], "/"),
		lifetime: { ttlMs: 7 * DAY },
		reason: "To file the overnight sweep's failed invoice runs as Linear issues and link them to the incident.",
	});
	await approve(narrowed.id, -5 * HOUR + 3 * MINUTE, {
		methods: ["POST"],
		pathPrefix: "/graphql",
		ttlMs: DAY,
		maxUses: 20,
	});
	await egress("ses_billing", "POST", "https://api.linear.app/graphql", -4 * HOUR);
	await egress("ses_billing", "POST", "https://api.linear.app/graphql", -3 * HOUR);

	// Approved as asked: one write to GitHub.
	const approved = await propose("ses_release", -3 * HOUR, {
		itemId: github.id,
		route: route("api.github.com", ["POST"], "/repos/harbour-dev/harbour/releases"),
		lifetime: { ttlMs: 8 * HOUR, maxUses: 1 },
		reason: "To publish the 0.4 release notes as a draft GitHub release.",
	});
	await approve(approved.id, -3 * HOUR + 4 * MINUTE);

	// Approved, then stopped.
	const revoked = await propose("ses_ops", -2 * HOUR, {
		itemId: staging.id,
		route: route("admin.staging.harbour.dev", ["GET", "POST"], "/jobs"),
		lifetime: { ttlMs: DAY },
		reason: "To list the stuck invoice jobs and retry the three that failed overnight.",
	});
	const revokedDecision = await approve(revoked.id, -2 * HOUR + MINUTE);
	await egress("ses_ops", "GET", "https://admin.staging.harbour.dev/jobs?state=stuck", -2 * HOUR + 2 * MINUTE);
	at(-90 * MINUTE);
	await vault.revokeGrant(admin, revokedDecision.grantId!, "Retries done");

	// Denied.
	const denied = await propose("ses_release", -70 * MINUTE, {
		itemId: github.id,
		route: route("api.github.com", ["DELETE"], "/repos/harbour-dev/harbour/git/refs/tags"),
		lifetime: { ttlMs: HOUR, maxUses: 1 },
		reason: "To delete the mistaken v0.4.0-rc tag before tagging the release.",
	});
	at(-68 * MINUTE);
	const denial = await vault.decide(admin, { proposalId: denied.id, outcome: "deny", note: "I'll do it by hand." });
	decisions.set(denial.id, denial);

	// Expired: nobody decided in the fifteen minutes.
	const expired = await propose("ses_ops", -40 * MINUTE, {
		itemId: staging.id,
		route: route("admin.staging.harbour.dev", ["POST"], "/jobs/retry"),
		lifetime: { maxUses: 1 },
		reason: "To retry the last stuck job after the deploy.",
	});
	await egress("ses_billing", "POST", "https://api.linear.app/graphql", -40 * MINUTE);

	// Withdrawn by the agent.
	const withdrawn = await propose("ses_release", -30 * MINUTE, {
		itemId: github.id,
		route: route("api.github.com", ["GET"], "/repos/harbour-dev/harbour/pulls"),
		lifetime: { maxUses: 1 },
		reason: "To list last week's merged pull requests.",
	});
	at(-28 * MINUTE);
	await vault.withdraw(agentIn("ses_release"), withdrawn.id);

	// Open: a pending write running out of time, a route grant, a secret paste, a read and a fresh write.
	const pending = await propose("ses_billing", -13 * MINUTE - 30_000, {
		itemId: linear.id,
		route: route("api.linear.app", ["POST", "PUT"], "/graphql"),
		lifetime: { ttlMs: 7 * DAY, maxUses: 1 },
		reason: "To close the duplicate invoice bug the sweep filed twice.",
	});
	const routeGrant = await propose("ses_ops", -6 * MINUTE, {
		itemId: staging.id,
		route: route("admin.staging.harbour.dev", ["GET", "POST"], "/jobs"),
		lifetime: { ttlMs: 7 * DAY },
		reason: "To keep the staging job queue moving this week: list stuck jobs and retry them as they fail.",
	});
	const secret = await propose("ses_billing", -4 * MINUTE, {
		secret: {
			name: "Sentry auth token",
			description: "For the Billing project in Sentry.",
			hosts: ["sentry.io"],
			injection: { header: "Authorization", template: "Bearer {key}" },
		},
		route: route("sentry.io", ["GET"], "/api/0/projects/harbour/billing"),
		lifetime: { ttlMs: 30 * DAY },
		reason: "To read the billing service's new errors each morning for the sweep. There is no Sentry connection yet.",
	});
	const read = await propose("ses_release", -2 * MINUTE, {
		itemId: github.id,
		route: route("api.github.com", ["GET"], "/repos/harbour-dev/harbour/pulls"),
		lifetime: { ttlMs: HOUR, maxUses: 1 },
		reason: "To list last week's merged pull requests for the release notes.",
	});
	const personal = await propose("ses_ops", -90_000, {
		itemId: calendar.id,
		route: route("www.googleapis.com", ["GET"], "/calendar/v3/"),
		lifetime: { ttlMs: HOUR },
		reason: "To find a free hour tomorrow for the staging post-mortem.",
	});
	const proposed = await propose("ses_billing", -40_000, {
		itemId: linear.id,
		route: route("api.linear.app", ["POST"], "/graphql"),
		lifetime: { ttlMs: DAY, maxUses: 1 },
		reason: "To file the three bugs from last night's sweep as Linear issues in the Platform team.",
	});

	clock.set(base);
	// A live scenario's clock runs on from `base` in real time, so countdowns and expiry move.
	if (options.live === true) follow = base - Date.now();
	const proposals: Record<FixtureState, string> = {
		proposed: proposed.id,
		pending: pending.id,
		read: read.id,
		approved: approved.id,
		narrowed: narrowed.id,
		route: routeGrant.id,
		secret: secret.id,
		denied: denied.id,
		expired: expired.id,
		revoked: revoked.id,
		withdrawn: withdrawn.id,
		personal: personal.id,
	};

	const decider = (decision: Decision) =>
		decision.decidedBy.kind === "human" ? nameOf(decision.decidedBy.userId) : undefined;
	return {
		vault,
		audit,
		clock,
		proposals,
		decisions,
		ctxFor: human,
		propose: (sessionId, terms) => vault.propose(agentIn(sessionId), terms),
		load: (proposalId, viewer = people.tom) =>
			loadVaultRequest(vault, human(viewer), proposalId, describe, { decisions, decider }),
		grants: (viewer = people.tom) => loadActiveGrants(vault, human(viewer), describe),
	};
}
