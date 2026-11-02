/**
 * The environments API's wire shapes (docs/site/src/content/docs/api/environments.md), each mirroring a type in
 * `@kantel/contracts`'s `environments.ts`. `test/types.test.ts` checks that each matches its contract type. No shape
 * carries a provider's machine ID, an address, a hosted port's token or a credential.
 */
import Type from "typebox";
import { Actor, Timestamp } from "./schema.ts";

export const EnvironmentState = Type.Union(
	[
		Type.Literal("creating"),
		Type.Literal("stopped"),
		Type.Literal("starting"),
		Type.Literal("running"),
		Type.Literal("idle"),
		Type.Literal("stopping"),
		Type.Literal("error"),
		Type.Literal("destroyed"),
	],
	{
		title: "EnvironmentState",
		description:
			"`running`: up with at least one session's lease. `idle`: up with none, stopping at `idleStopAt`. `stopped`: no " +
			"machine running; the disk is kept. `error`: the last operation failed, and Start tries again.",
	},
);

export const EnvironmentProviderKind = Type.Union(
	[Type.Literal("boat"), Type.Literal("firecracker"), Type.Literal("byo"), Type.Literal("fake")],
	{ title: "EnvironmentProviderKind", description: "Who provides the machine. Only `boat` and `fake` are built yet." },
);

const SizeName = Type.Union(
	[Type.Literal("small"), Type.Literal("default"), Type.Literal("large"), Type.Literal("xlarge")],
	{
		title: "EnvironmentSizeName",
	},
);

export const EnvironmentSize = Type.Object(
	{ name: SizeName, vcpus: Type.Integer(), memoryGb: Type.Integer(), diskGb: Type.Integer() },
	{ title: "EnvironmentSize" },
);

export const EnvironmentDefinition = Type.Object(
	{
		version: Type.Integer({ minimum: 1 }),
		template: Type.Optional(Type.String({ description: "A provider template, such as a boat saved snapshot." })),
		repository: Type.Optional(Type.String({ description: "A repository to keep a warm clone of: `owner/name`." })),
		setup: Type.Optional(Type.String({ description: "Run once after the machine is first created." })),
		composeFile: Type.Optional(Type.String()),
		readiness: Type.Optional(Type.String()),
	},
	{ title: "EnvironmentDefinition", description: "What a fresh machine starts with." },
);

const DefinitionInput = Type.Object({
	template: Type.Optional(Type.String()),
	repository: Type.Optional(Type.String()),
	setup: Type.Optional(Type.String()),
	composeFile: Type.Optional(Type.String()),
	readiness: Type.Optional(Type.String()),
});

export const EnvironmentOwner = Type.Object(
	{
		projectId: Type.String(),
		userId: Type.Optional(Type.String({ description: "Absent: every member's sessions in the project may attach." })),
	},
	{ title: "EnvironmentOwner" },
);

export const EnvironmentResumeStats = Type.Object(
	{
		lastMs: Type.Number({ description: "The last start, from the start call to the machine up, in milliseconds." }),
		p50Ms: Type.Number({ description: "The median of the recent starts." }),
		samples: Type.Integer(),
	},
	{ title: "EnvironmentResumeStats" },
);

const Sharing = Type.Union([Type.Literal("shared"), Type.Literal("exclusive")], { title: "EnvironmentSharing" });
const Egress = Type.Union([Type.Literal("managed"), Type.Literal("unmanaged")], {
	title: "EnvironmentEgress",
	description: "`unmanaged`: Kantel doesn't run the machine's network, and code on it reaches the internet directly.",
});

export const Environment = Type.Object(
	{
		id: Type.String({ description: "The environment's ID, `env_…`." }),
		organisationId: Type.String(),
		owner: EnvironmentOwner,
		name: Type.String({ description: "Unique in the project: `lleverage-dev`." }),
		alias: Type.String({ description: "The name sessions give `bash`'s `env`: `dev`." }),
		description: Type.Optional(Type.String()),
		provider: EnvironmentProviderKind,
		size: EnvironmentSize,
		definition: EnvironmentDefinition,
		sharing: Sharing,
		egress: Egress,
		placeholders: Type.Boolean({ description: "Whether connection placeholders work on it, through Kantel's proxy." }),
		idleTimeoutMs: Type.Integer(),
		state: EnvironmentState,
		error: Type.Optional(Type.String()),
		createdAt: Timestamp,
		createdBy: Actor,
		updatedAt: Timestamp,
		lastStartedAt: Type.Optional(Timestamp),
		lastStoppedAt: Type.Optional(Timestamp),
		idleStopAt: Type.Optional(Timestamp),
		leaseCount: Type.Integer({ description: "Sessions holding it now." }),
		resume: Type.Optional(EnvironmentResumeStats),
		runningMsThisMonth: Type.Number(),
	},
	{
		title: "Environment",
		description: "A long-lived machine owned by a project, by default by one person in it, that sessions attach to.",
	},
);

export const EnvironmentList = Type.Object({ items: Type.Array(Environment) }, { title: "EnvironmentList" });

export const EnvironmentGrant = Type.Object(
	{
		id: Type.String({ description: "The grant's ID, `eng_…`." }),
		organisationId: Type.String(),
		environmentId: Type.String(),
		sessionId: Type.String(),
		alias: Type.String(),
		rights: Type.Union([Type.Literal("worktree"), Type.Literal("machine")]),
		grantedBy: Actor,
		createdAt: Timestamp,
		status: Type.Union([Type.Literal("active"), Type.Literal("revoked"), Type.Literal("ended")]),
	},
	{ title: "EnvironmentGrant", description: "A session's permission to use an environment, by its alias." },
);

export const EnvironmentLease = Type.Object(
	{
		id: Type.String({ description: "The lease's ID, `enl_…`." }),
		environmentId: Type.String(),
		sessionId: Type.String(),
		grantId: Type.String(),
		worktree: Type.String({ description: "The session's own directory on the machine." }),
		composeProject: Type.String({ description: "The session's own `COMPOSE_PROJECT_NAME`." }),
		portBase: Type.Integer({ description: "The first of the session's ten ports." }),
		acquiredAt: Timestamp,
		renewedAt: Timestamp,
		expiresAt: Timestamp,
		endedAt: Type.Optional(Timestamp),
		endReason: Type.Optional(
			Type.Union([
				Type.Literal("released"),
				Type.Literal("expired"),
				Type.Literal("session_ended"),
				Type.Literal("revoked"),
				Type.Literal("stopped"),
			]),
		),
		commands: Type.Integer(),
	},
	{ title: "EnvironmentLease", description: "A session's hold on a running environment." },
);

export const EnvironmentEvent = Type.Object(
	{
		at: Timestamp,
		kind: Type.Union([
			Type.Literal("created"),
			Type.Literal("starting"),
			Type.Literal("started"),
			Type.Literal("stopping"),
			Type.Literal("stopped"),
			Type.Literal("failed"),
			Type.Literal("destroyed"),
			Type.Literal("lease.acquired"),
			Type.Literal("lease.ended"),
			Type.Literal("granted"),
			Type.Literal("revoked"),
		]),
		actor: Type.Optional(Actor),
		sessionId: Type.Optional(Type.String()),
		durationMs: Type.Optional(Type.Number()),
		reason: Type.Optional(Type.String()),
		message: Type.Optional(Type.String()),
	},
	{ title: "EnvironmentEvent" },
);

export const EnvironmentDetail = Type.Object(
	{
		environment: Environment,
		leases: Type.Array(EnvironmentLease),
		grants: Type.Array(EnvironmentGrant),
		events: Type.Array(EnvironmentEvent, { description: "Newest first." }),
	},
	{ title: "EnvironmentDetail", description: "An environment with the sessions holding it and its recent history." },
);

export const CreateEnvironmentBody = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		name: Type.String({ minLength: 1, maxLength: 63 }),
		alias: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
		description: Type.Optional(Type.String({ maxLength: 200 })),
		provider: Type.Optional(EnvironmentProviderKind),
		size: Type.Optional(SizeName),
		definition: Type.Optional(DefinitionInput),
		sharing: Type.Optional(Sharing),
		projectWide: Type.Optional(Type.Boolean()),
		idleTimeoutMs: Type.Optional(Type.Integer({ minimum: 60_000 })),
	},
	{ title: "CreateEnvironmentBody" },
);

export const UpdateEnvironmentBody = Type.Object(
	{
		description: Type.Optional(Type.String({ maxLength: 200 })),
		idleTimeoutMs: Type.Optional(Type.Integer({ minimum: 60_000 })),
		size: Type.Optional(SizeName),
	},
	{ title: "UpdateEnvironmentBody" },
);

export const GrantEnvironmentBody = Type.Object(
	{
		sessionId: Type.String({ minLength: 1 }),
		alias: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
		rights: Type.Optional(Type.Union([Type.Literal("worktree"), Type.Literal("machine")])),
	},
	{ title: "GrantEnvironmentBody" },
);

export const ListEnvironmentsQuery = Type.Object({ projectId: Type.Optional(Type.String({ minLength: 1 })) });
export const EnvironmentPath = Type.Object({ environmentId: Type.String({ minLength: 1 }) });
export const EnvironmentGrantPath = Type.Object({
	environmentId: Type.String({ minLength: 1 }),
	grantId: Type.String({ minLength: 1 }),
});
