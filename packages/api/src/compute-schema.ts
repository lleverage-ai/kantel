/**
 * The compute plane's wire shapes: accounts and organisations, sandboxes and their commands, files, ports and access,
 * snapshots, scoped API keys, the egress proxy's settings, environments and sandboxes' egress, webhooks, OpenTelemetry
 * export, events, and the super-admin's hosts. The schemas are the contract: the types below are read from them (`Static`), and the SDK's types
 * are generated from them, so there is one definition of each shape.
 *
 * No shape carries a host's address, a machine's provider ID or a credential, except a secret the caller is shown once
 * when it is made (an API key's, a webhook's signing secret, a host's join token). A protected variable's value and a
 * secret file's contents are write-only: no shape answers them.
 */
import Type, { type Static } from "typebox";
import { Timestamp } from "./schema.ts";

const id = (description: string) => Type.String({ description });
const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "At most this many; default 50." }));
const cursor = Type.Optional(Type.String({ description: "A previous page's `nextCursor`." }));
const nextCursor = Type.Optional(Type.String({ description: "Present when more items follow." }));
const accountQuery = Type.Optional(
	Type.String({
		description:
			"The account to act in: the caller's personal account (the default for a person) or an organisation they belong " +
			"to. An API key always acts in its own account, and naming another is `forbidden`.",
	}),
);

export const PageQueryCompute = Type.Object({ limit, cursor }, { title: "ComputePageQuery" });

// API key scopes, which the caller and keys both name.

export const ApiKeyScope = Type.Union(
	[
		Type.Literal("sandboxes:read"),
		Type.Literal("sandboxes:write"),
		Type.Literal("sandboxes:delete"),
		Type.Literal("exec"),
		Type.Literal("files"),
		Type.Literal("access"),
		Type.Literal("snapshots:read"),
		Type.Literal("snapshots:write"),
		Type.Literal("account:read"),
		Type.Literal("account:admin"),
		Type.Literal("hosts:admin"),
	],
	{
		title: "ApiKeyScope",
		description:
			"What a key may do. `sandboxes:read`: list and inspect sandboxes, their usage and events. `sandboxes:write`: " +
			"create, change, start, stop, pause, resume, fork and recover. `sandboxes:delete`: delete for good. `exec`: run " +
			"commands. `files`: read and write files. `access`: SSH, desktop, browser and public ports. `snapshots:read`, " +
			"`snapshots:write`: snapshots and saved snapshots. `account:read`: the account, its members, keys, environments " +
			"and sandboxes' egress. `account:admin`: members, keys, webhooks, telemetry, the proxy, environments and " +
			"sandboxes' grants. `hosts:admin`: the deployment's hosts, for " +
			"a super-admin's key only.",
	},
);

// Accounts and organisations.

export const AccountKind = Type.Union([Type.Literal("personal"), Type.Literal("organisation")], {
	title: "AccountKind",
	description:
		"`personal`: one person's own account, made at their first sign-in; what they create is theirs alone unless they " +
		"move it. `organisation`: an account people create or join, where sandboxes and snapshots are shared.",
});

export const MemberRole = Type.Union([Type.Literal("member"), Type.Literal("admin"), Type.Literal("owner")], {
	title: "MemberRole",
	description:
		"`member`: uses the organisation's shared sandboxes and snapshots and makes their own. `admin`: also manages " +
		"members, API keys, webhooks, telemetry and the proxy. `owner`: also renames or deletes the organisation. A " +
		"personal account's person is its `owner`.",
});

export const SandboxVisibility = Type.Union([Type.Literal("private"), Type.Literal("organisation")], {
	title: "SandboxVisibility",
	description:
		"`private`: only the person who made it (and API keys of theirs) may see or use it. `organisation`: every member " +
		"of its organisation may. A personal account's sandboxes are always `private`.",
});

export const Account = Type.Object(
	{
		id: id("The account's ID, such as `acc_7f3k2m9q`."),
		kind: AccountKind,
		name: Type.String(),
		role: MemberRole,
		defaultVisibility: SandboxVisibility,
		createdAt: Timestamp,
	},
	{
		title: "Account",
		description: "An account the caller may act in, with the caller's role in it.",
	},
);

export const AccountList = Type.Object({ items: Type.Array(Account) }, { title: "AccountList" });

export const AccountPath = Type.Object({ accountId: id("The account's ID.") }, { title: "AccountPath" });

export const Caller = Type.Object(
	{
		user: Type.Optional(
			Type.Object(
				{ id: Type.String(), name: Type.String(), email: Type.Optional(Type.String()) },
				{ title: "CallerUser" },
			),
		),
		apiKey: Type.Optional(
			Type.Object(
				{
					id: Type.String(),
					name: Type.String(),
					scopes: Type.Array(ApiKeyScope),
				},
				{ title: "CallerApiKey", description: "The key the call was signed in with, when it was a key." },
			),
		),
		accountId: Type.String({ description: "The account the call acts in when it names none." }),
		accounts: Type.Array(Account),
		superAdmin: Type.Boolean({ description: "Whether the caller may manage the deployment's hosts." }),
		mode: Type.Union([Type.Literal("selfhosted"), Type.Literal("hosted")], {
			title: "DeploymentMode",
			description: "`selfhosted`: an install someone runs for themselves. `hosted`: a hosted service with plans.",
		}),
	},
	{ title: "Caller", description: "Who is calling, the accounts they may act in, and the deployment's mode." },
);

export const CreateOrganisationBody = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 100 }),
		defaultVisibility: Type.Optional(SandboxVisibility),
	},
	{ title: "CreateOrganisationBody" },
);

export const UpdateAccountBody = Type.Object(
	{
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
		defaultVisibility: Type.Optional(SandboxVisibility),
	},
	{ title: "UpdateAccountBody" },
);

export const Member = Type.Object(
	{
		userId: Type.String(),
		name: Type.String(),
		email: Type.Optional(Type.String()),
		role: MemberRole,
		joinedAt: Timestamp,
	},
	{ title: "Member" },
);

export const MemberList = Type.Object({ items: Type.Array(Member) }, { title: "MemberList" });

export const MemberPath = Type.Object(
	{ accountId: id("The organisation's account ID."), userId: id("The member's user ID.") },
	{ title: "MemberPath" },
);

export const UpdateMemberBody = Type.Object({ role: MemberRole }, { title: "UpdateMemberBody" });

export const CreateInviteBody = Type.Object(
	{
		role: Type.Optional(MemberRole),
		email: Type.Optional(Type.String({ description: "Only this person may use it. Absent: anyone with the code." })),
		expiresInHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720, description: "Default 168 (a week)." })),
	},
	{ title: "CreateInviteBody" },
);

export const Invite = Type.Object(
	{
		id: id("The invite's ID."),
		accountId: Type.String(),
		role: MemberRole,
		email: Type.Optional(Type.String()),
		code: Type.Optional(
			Type.String({ description: "The join code, such as `kji_…`. Shown once, when the invite is made." }),
		),
		expiresAt: Timestamp,
		createdAt: Timestamp,
	},
	{ title: "Invite", description: "A way into an organisation: whoever joins with its code becomes a member." },
);

export const InviteList = Type.Object({ items: Type.Array(Invite) }, { title: "InviteList" });

export const InvitePath = Type.Object(
	{ accountId: id("The organisation's account ID."), inviteId: id("The invite's ID.") },
	{ title: "InvitePath" },
);

export const JoinOrganisationBody = Type.Object(
	{ code: Type.String({ description: "An invite's join code." }) },
	{ title: "JoinOrganisationBody" },
);

// Sandboxes.

export const SandboxType = Type.Union([Type.Literal("isolate"), Type.Literal("microvm")], {
	title: "SandboxType",
	description:
		"`isolate`: a workerd isolate with a JavaScript shell over the sandbox's files. Starts in milliseconds and costs " +
		"almost nothing, but runs no native binaries, has no desktop and no SSH. `microvm`: a Firecracker microVM with " +
		"a full Linux, root, Docker and `/dev/kvm` inside, a desktop, a browser and SSH.",
});

export const SandboxState = Type.Union(
	[
		Type.Literal("starting"),
		Type.Literal("running"),
		Type.Literal("stopping"),
		Type.Literal("stopped"),
		Type.Literal("paused"),
		Type.Literal("error"),
		Type.Literal("deleting"),
		Type.Literal("deleted"),
	],
	{
		title: "SandboxState",
		description:
			"`starting`: being placed and booted. `running`: commands run now. `stopping`: its disk is being saved. " +
			"`stopped`: no machine; its disk is kept as its newest snapshot, and running programs are gone. `paused`: like " +
			"`stopped`, but its memory is kept too, so `resume` carries on where it left off (microVMs only). `error`: the " +
			"last operation failed or the machine was lost; `recover` or `resume` it. `deleting`, `deleted`: erased for " +
			"good, with its snapshots.",
	},
);

export const SandboxHealth = Type.Union([Type.Literal("ok"), Type.Literal("degraded")], {
	title: "SandboxHealth",
	description: "`degraded`: the machine is up but its host can't fully reach it; it keeps running.",
});

export const SandboxSizeName = Type.Union(
	[Type.Literal("small"), Type.Literal("default"), Type.Literal("large"), Type.Literal("xlarge")],
	{ title: "SandboxSizeName", description: "A microVM's size; a deployment may offer fewer. Isolates have none." },
);

export const SandboxResources = Type.Object(
	{
		vcpus: Type.Integer(),
		memoryMb: Type.Integer(),
		diskGb: Type.Integer(),
	},
	{ title: "SandboxResources" },
);

export const SandboxCapabilities = Type.Object(
	{
		exec: Type.Boolean(),
		files: Type.Boolean(),
		ssh: Type.Boolean(),
		desktop: Type.Boolean(),
		browser: Type.Boolean(),
		ports: Type.Boolean(),
		docker: Type.Boolean(),
		kvm: Type.Boolean({ description: "`/dev/kvm` inside, for nested virtualisation." }),
		pause: Type.Boolean({ description: "Whether it can be paused with its memory kept." }),
	},
	{ title: "SandboxCapabilities", description: "What this sandbox can do, from its type and its host." },
);

export const Cost = Type.Object(
	{
		currency: Type.String({ description: "ISO 4217, such as `USD`." }),
		total: Type.Number({ description: "What it has cost so far, in `currency`." }),
		ratePerHour: Type.Number({ description: "What an hour of running costs at its size, in `currency`." }),
	},
	{
		title: "Cost",
		description:
			"What a sandbox costs at the deployment's rates. A self-hosted install's rates are 0 unless its operator sets them.",
	},
);

export const UsageSummary = Type.Object(
	{
		runningSeconds: Type.Number(),
		cpuSeconds: Type.Number(),
		recentCpu: Type.Array(Type.Number({ minimum: 0, maximum: 1 }), {
			description: "CPU utilisation, 0 to 1, over the last 24 intervals of 5 minutes, oldest first: a sparkline.",
		}),
	},
	{ title: "UsageSummary" },
);

export const CreatedBy = Type.Object(
	{
		kind: Type.Union([Type.Literal("user"), Type.Literal("api_key")]),
		id: Type.String({ description: "The user's or the API key's ID." }),
		name: Type.Optional(Type.String()),
	},
	{ title: "CreatedBy" },
);

// Destinations and egress grants, which environments and sandboxes both carry.

const HttpMethodName = Type.String({
	pattern: "^[A-Z]{1,16}$",
	description: "An HTTP method in capitals, such as `GET` or `POST`.",
});
const hostPattern = (what: string) =>
	Type.String({
		minLength: 1,
		maxLength: 253,
		description: `${what}: \`api.github.com\`, or \`*.example.com\` for its subdomains (not \`example.com\` itself).`,
	});
const pathList = (description: string) =>
	Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 32, description }));
const methodList = (description: string) => Type.Optional(Type.Array(HttpMethodName, { maxItems: 16, description }));

export const DestinationBinding = Type.Object(
	{
		host: hostPattern("The host, on port 443"),
		pathPrefixes: pathList("Only paths under these, such as `/repos/`. Absent or empty: any path."),
		methods: methodList("Only these methods. Absent or empty: any method."),
	},
	{
		title: "DestinationBinding",
		description:
			"Where a protected variable's value may go: the host's egress proxy swaps the sandbox's placeholder for the value " +
			"only on a request that matches, and refuses a request that carries the placeholder anywhere else.",
	},
);

const grantFields = {
	action: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
	host: hostPattern("The host"),
	methods: methodList("Only these methods. Absent or empty: every method."),
	paths: pathList(
		"Path patterns, `*` one segment and `**` the rest, such as `/repos/lleverage-ai/*`. Absent or empty: every path.",
	),
};

export const EgressGrant = Type.Object(
	{ id: id("The grant's ID, such as `grt_4kq9x2mt`."), ...grantFields },
	{
		title: "EgressGrant",
		description:
			"An egress rule on top of the account's proxy settings: let a sandbox reach a host, or refuse it. Deny wins. A " +
			"grant naming methods or paths makes the proxy look inside that host's HTTPS, as a protected variable's host does.",
	},
);

export const EgressGrantInput = Type.Object(
	{ id: Type.Optional(Type.String({ description: "Keep a grant's ID; absent, a new one is made." })), ...grantFields },
	{ title: "EgressGrantInput" },
);

export const Sandbox = Type.Object(
	{
		id: id("The sandbox's ID, such as `sbx_4kq9x2mt`."),
		accountId: Type.String(),
		name: Type.String(),
		subdomain: Type.String({
			description: "Its name under the deployment's sandbox domain, which its public port URLs start with.",
		}),
		type: SandboxType,
		size: Type.Optional(SandboxSizeName),
		resources: Type.Optional(SandboxResources),
		image: Type.Optional(
			Type.String({ description: "The base image a microVM was made from, such as `ubuntu-24.04`." }),
		),
		state: SandboxState,
		health: Type.Optional(SandboxHealth),
		reason: Type.Optional(Type.String({ description: "Why it is in `error` or `degraded`, in words." })),
		visibility: SandboxVisibility,
		capabilities: SandboxCapabilities,
		labels: Type.Record(Type.String(), Type.String(), { description: "The caller's own labels." }),
		autoStopMinutes: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
			description: "How long after a start or resume it stops by itself; `null` never.",
		}),
		stopsAt: Type.Optional(
			Type.Integer({ description: "When it will stop by itself, while running; the console's stops-in." }),
		),
		latestSnapshotId: Type.Optional(Type.String({ description: "The snapshot a resume or fork would use." })),
		source: Type.Optional(
			Type.Object(
				{
					snapshotId: Type.Optional(Type.String()),
					sandboxId: Type.Optional(Type.String({ description: "Set when it was forked from another sandbox." })),
				},
				{ title: "SandboxSource", description: "What it was made from." },
			),
		),
		environmentId: Type.Optional(Type.String({ description: "The environment it was made from." })),
		grants: Type.Array(EgressGrant, { description: "Its own egress grants, on top of its environment's." }),
		createdBy: CreatedBy,
		createdAt: Timestamp,
		startedAt: Type.Optional(Timestamp),
		stoppedAt: Type.Optional(Timestamp),
		cost: Cost,
		usage: UsageSummary,
		hostId: Type.Optional(Type.String({ description: "The host it runs on; only a super-admin is shown it." })),
	},
	{ title: "Sandbox" },
);

export const SandboxPage = Type.Object({ items: Type.Array(Sandbox), nextCursor }, { title: "SandboxPage" });

export const SandboxPath = Type.Object({ sandboxId: id("The sandbox's ID.") }, { title: "SandboxPath" });

export const ListSandboxesQuery = Type.Object(
	{
		account: accountQuery,
		state: Type.Optional(SandboxState),
		all: Type.Optional(
			Type.Boolean({ description: "Include stopped, paused and errored sandboxes. Default: only active ones." }),
		),
		label: Type.Optional(
			Type.Record(Type.String(), Type.String(), { description: "Only those with each label: `label.ticket=PROJ-12`." }),
		),
		limit,
		cursor,
	},
	{ title: "ListSandboxesQuery" },
);

export const CreateSandboxBody = Type.Object(
	{
		account: accountQuery,
		name: Type.Optional(
			Type.String({ maxLength: 63, description: "Default: a generated name, such as `brave-otter`." }),
		),
		type: Type.Optional(SandboxType),
		size: Type.Optional(SandboxSizeName),
		image: Type.Optional(Type.String({ description: "A microVM's base image. Default: the deployment's." })),
		from: Type.Optional(
			Type.String({
				description: "Start from this snapshot: a snapshot's ID or a saved snapshot's name in the account.",
			}),
		),
		autoStopMinutes: Type.Optional(
			Type.Union([Type.Integer({ minimum: 1, maximum: 43200 }), Type.Null()], {
				description: "Default 60. `null`: never stop by itself.",
			}),
		),
		visibility: Type.Optional(SandboxVisibility),
		labels: Type.Optional(Type.Record(Type.String(), Type.String())),
		env: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description:
					"Environment variables every command sees, after the environment's. Not secrets: they are shown to anyone who " +
					"may exec. Kantel's own names (`KANTEL_*`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, in any case) are refused.",
			}),
		),
		environment: Type.Optional(
			Type.String({
				description:
					"Start with this environment, an environment's ID or name in the account: its plain variables, a placeholder " +
					"for each protected one, its secret files and repositories, and its grants. `env` may not name one of its " +
					"protected variables.",
			}),
		),
		hostLabels: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: 'Place it only on a host with each label, such as `{ site: "home" }`.',
			}),
		),
		wait: Type.Optional(
			Type.Boolean({ description: "Answer once it is `running` (or `error`) rather than as soon as it is placed." }),
		),
	},
	{
		title: "CreateSandboxBody",
		description: "Every field is optional: `{}` makes a running isolate in the caller's account.",
	},
);

export const UpdateSandboxBody = Type.Object(
	{
		name: Type.Optional(Type.String({ maxLength: 63 })),
		autoStopMinutes: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 43200 }), Type.Null()])),
		extendMinutes: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 43200, description: "Move `stopsAt` to this long from now." }),
		),
		visibility: Type.Optional(SandboxVisibility),
		labels: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Replaces its labels." })),
	},
	{ title: "UpdateSandboxBody" },
);

export const StopSandboxBody = Type.Object(
	{
		keepMemory: Type.Optional(
			Type.Boolean({
				description: "Pause instead: keep its memory as well as its disk (`paused`). microVMs only. Default false.",
			}),
		),
		wait: Type.Optional(Type.Boolean({ description: "Answer once it is `stopped` or `paused`." })),
	},
	{ title: "StopSandboxBody" },
);

export const ResumeSandboxBody = Type.Object(
	{
		size: Type.Optional(SandboxSizeName),
		wait: Type.Optional(Type.Boolean({ description: "Answer once it is `running` (or `error`)." })),
	},
	{ title: "ResumeSandboxBody" },
);

export const ForkSandboxBody = Type.Object(
	{
		name: Type.Optional(Type.String({ maxLength: 63 })),
		snapshotId: Type.Optional(
			Type.String({ description: "Fork from this snapshot of the sandbox. Default: its newest, or its live state." }),
		),
		size: Type.Optional(SandboxSizeName),
		count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "How many copies; default 1." })),
		visibility: Type.Optional(SandboxVisibility),
		labels: Type.Optional(Type.Record(Type.String(), Type.String())),
		wait: Type.Optional(Type.Boolean()),
	},
	{ title: "ForkSandboxBody" },
);

export const ForkedSandboxes = Type.Object({ items: Type.Array(Sandbox) }, { title: "ForkedSandboxes" });

export const SandboxUsagePoint = Type.Object(
	{
		at: Timestamp,
		cpu: Type.Number({ minimum: 0, maximum: 1, description: "CPU utilisation over the interval." }),
		memoryMb: Type.Number(),
		runningSeconds: Type.Number(),
		cost: Type.Number(),
	},
	{ title: "SandboxUsagePoint" },
);

export const SandboxUsage = Type.Object(
	{
		sandboxId: Type.String(),
		intervalSeconds: Type.Integer(),
		points: Type.Array(SandboxUsagePoint),
		totals: Type.Object({ runningSeconds: Type.Number(), cpuSeconds: Type.Number(), cost: Cost }),
	},
	{ title: "SandboxUsage" },
);

export const UsageQuery = Type.Object(
	{
		since: Type.Optional(Type.Integer({ description: "From this time; default 24 hours ago." })),
		intervalSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 86400, description: "Default 300." })),
	},
	{ title: "UsageQuery" },
);

export const AccountUsage = Type.Object(
	{
		accountId: Type.String(),
		since: Timestamp,
		running: Type.Integer({ description: "Sandboxes running now." }),
		runningSeconds: Type.Number(),
		cost: Cost,
		limits: Type.Optional(
			Type.Object(
				{
					concurrentSandboxes: Type.Optional(Type.Integer()),
					startsPerMinute: Type.Optional(Type.Integer()),
					savedSnapshots: Type.Optional(Type.Integer()),
				},
				{ title: "AccountLimits", description: "The account's limits, where the deployment sets any." },
			),
		),
	},
	{ title: "AccountUsage" },
);

// Commands.

export const RunCommandBody = Type.Object(
	{
		command: Type.String({
			minLength: 1,
			description: "A shell command line, run with `bash -lc` (or the isolate's shell).",
		}),
		cwd: Type.Optional(Type.String({ description: "Default: the sandbox user's home." })),
		env: Type.Optional(Type.Record(Type.String(), Type.String())),
		stdin: Type.Optional(Type.String()),
		timeoutMs: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 600_000, description: "Default 30 000; at most 600 000 (10 minutes)." }),
		),
		detached: Type.Optional(
			Type.Boolean({ description: "Start it and answer at once, with no time limit; read it back by its ID." }),
		),
	},
	{ title: "RunCommandBody" },
);

export const CommandState = Type.Union(
	[Type.Literal("running"), Type.Literal("exited"), Type.Literal("killed"), Type.Literal("timed_out")],
	{ title: "CommandState" },
);

export const Command = Type.Object(
	{
		id: id("The command's ID, such as `cmd_9a8b7c`."),
		sandboxId: Type.String(),
		command: Type.String(),
		cwd: Type.Optional(Type.String()),
		state: CommandState,
		exitCode: Type.Optional(Type.Integer()),
		stdout: Type.String({ description: "Its output so far, up to 1 MiB; `truncated` says if there was more." }),
		stderr: Type.String(),
		truncated: Type.Boolean(),
		startedAt: Timestamp,
		endedAt: Type.Optional(Timestamp),
		durationMs: Type.Optional(Type.Integer()),
	},
	{ title: "Command" },
);

export const CommandPage = Type.Object({ items: Type.Array(Command), nextCursor }, { title: "CommandPage" });

export const CommandPath = Type.Object(
	{ sandboxId: id("The sandbox's ID."), commandId: id("The command's ID.") },
	{ title: "CommandPath" },
);

// Files.

export const FileEncoding = Type.Union([Type.Literal("utf8"), Type.Literal("base64")], { title: "FileEncoding" });

export const FilePathQuery = Type.Object(
	{ path: Type.String({ minLength: 1, description: "An absolute path, or one relative to the user's home." }) },
	{ title: "FilePathQuery" },
);

export const ReadFileQuery = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		encoding: Type.Optional(FileEncoding),
		offset: Type.Optional(
			Type.Integer({
				minimum: 0,
				description:
					"Read from this byte (default 0). With `offset` or `length`, a file of any size is read a part at a time.",
			}),
		),
		length: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 1024 * 1024,
				description: "Read at most this many bytes: default, and at most, 1 MiB (1048576).",
			}),
		),
	},
	{ title: "ReadFileQuery" },
);

export const ReadSnapshotFileQuery = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		encoding: Type.Optional(FileEncoding),
	},
	{ title: "ReadSnapshotFileQuery" },
);

export const FileContent = Type.Object(
	{
		path: Type.String(),
		encoding: FileEncoding,
		content: Type.String({ description: "The file, or with `offset` or `length`, the part read." }),
		size: Type.Integer({ description: "The whole file's size in bytes." }),
		offset: Type.Optional(
			Type.Integer({ description: "With `offset` or `length`: the byte `content` starts at. At `size`, it's empty." }),
		),
	},
	{
		title: "FileContent",
		description:
			"A file of at most 1 MiB, or a part of at most 1 MiB of a larger one, read with `offset` and `length`.",
	},
);

export const WriteFileBody = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		content: Type.String(),
		encoding: Type.Optional(FileEncoding),
		mode: Type.Optional(Type.String({ description: "Octal permissions, such as `0755`." })),
	},
	{ title: "WriteFileBody" },
);

export const FileEntry = Type.Object(
	{
		name: Type.String(),
		path: Type.String(),
		kind: Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("symlink")]),
		size: Type.Integer(),
		modifiedAt: Type.Optional(Timestamp),
	},
	{ title: "FileEntry" },
);

export const FileList = Type.Object(
	{ path: Type.String(), items: Type.Array(FileEntry), nextCursor },
	{ title: "FileList" },
);

export const ListFilesQuery = Type.Object(
	{ path: Type.Optional(Type.String({ description: "Default: the user's home." })), limit, cursor },
	{ title: "ListFilesQuery" },
);

// Ports, desktop, browser and SSH.

export const ExposePortBody = Type.Object(
	{
		port: Type.Integer({ minimum: 1, maximum: 65535 }),
		public: Type.Optional(
			Type.Boolean({ description: "Anyone with the URL may open it, with no token. Default false." }),
		),
	},
	{ title: "ExposePortBody" },
);

export const ExposedPort = Type.Object(
	{
		port: Type.Integer(),
		url: Type.String({
			description:
				"Its HTTPS URL. Unless `public`, the answer to exposing it carries a token anyone holding it may use, shown " +
				"only then (Kantel keeps its hash); listed, the URL has none. Exposing the port again gives a new token and " +
				"ends the old. Access through it ends when the key or sign-in that exposed it loses access to the sandbox.",
		}),
		public: Type.Boolean(),
		createdAt: Timestamp,
	},
	{ title: "ExposedPort" },
);

export const ExposedPortList = Type.Object({ items: Type.Array(ExposedPort) }, { title: "ExposedPortList" });

export const PortPath = Type.Object(
	{ sandboxId: id("The sandbox's ID."), port: Type.String({ pattern: "^[0-9]+$", description: "The port." }) },
	{ title: "PortPath" },
);

export const SshAccessBody = Type.Object(
	{
		publicKey: Type.Optional(
			Type.String({ description: "An OpenSSH public key to let in. Absent: Kantel makes a key pair for this access." }),
		),
		ttlMinutes: Type.Optional(
			Type.Integer({
				minimum: 5,
				maximum: 60,
				description:
					"How long a connection can be started with this access; one started in time stays open. Default 10.",
			}),
		),
	},
	{ title: "SshAccessBody" },
);

export const SshAccess = Type.Object(
	{
		host: Type.String({ description: "The SSH gateway's host name." }),
		port: Type.Integer(),
		user: Type.String({ description: "Names the sandbox to the gateway." }),
		command: Type.String({
			description: "A command line that connects, such as `ssh -p 2222 sbx_4kq9x2mt@ssh.example`.",
		}),
		proxyUrl: Type.Optional(
			Type.String({
				description:
					"When there is no SSH gateway to dial: a WebSocket URL carrying the sandbox's SSH as binary frames, for an `ssh -o ProxyCommand=…` (`kantel ssh-proxy` is one). Anyone holding it can start a connection until `expiresAt`.",
			}),
		),
		privateKey: Type.Optional(
			Type.String({ description: "When Kantel made the key pair: its private key, shown once." }),
		),
		hostKeyFingerprint: Type.Optional(Type.String()),
		expiresAt: Timestamp,
	},
	{ title: "SshAccess" },
);

export const ViewAccessBody = Type.Object(
	{
		viewOnly: Type.Optional(Type.Boolean({ description: "Watch only: no keyboard or mouse. Default false." })),
		ttlMinutes: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 60,
				description: "How long the URLs can be opened for; a view or connection opened in time stays open. Default 10.",
			}),
		),
	},
	{ title: "ViewAccessBody" },
);

export const DesktopAccess = Type.Object(
	{
		url: Type.String({ description: "Opens the desktop in a browser. Anyone holding it may use it until it expires." }),
		embedUrl: Type.String({ description: "The same, for an iframe." }),
		viewOnly: Type.Boolean(),
		expiresAt: Timestamp,
	},
	{ title: "DesktopAccess" },
);

export const BrowserAccess = Type.Object(
	{
		url: Type.String({ description: "Watch and drive the sandbox's Chromium in a browser." }),
		cdpUrl: Type.String({
			description: "A Chrome DevTools Protocol WebSocket URL, for Playwright's `connectOverCDP` or Puppeteer.",
		}),
		viewOnly: Type.Boolean(),
		expiresAt: Timestamp,
	},
	{ title: "BrowserAccess" },
);

// End-to-end encryption (`@kantel/e2e`).

export const E2EAccessBody = Type.Object(
	{
		ttlMinutes: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 60,
				description: "How long a session can be started with this URL; one started in time stays open. Default 10.",
			}),
		),
	},
	{ title: "E2EAccessBody" },
);

export const E2EAccess = Type.Object(
	{
		url: Type.String({
			description:
				"A WebSocket URL to the sandbox's host that carries a Noise session as binary frames. The gateway relays it and can't read it: the device checks the host's key against the space's chain, and the host checks the device's.",
		}),
		hostId: Type.String({ description: "The host the sandbox is on: the chain's entry for it has its key." }),
		accountId: Type.String({ description: "The sandbox's organisation: the space whose chain the session is in." }),
		expiresAt: Timestamp,
	},
	{ title: "E2EAccess" },
);

export const E2EEntry = Type.Object(
	{
		payload: Type.String({ description: "Base64url of the entry's JSON, exactly the bytes that were signed." }),
		sig: Type.String({ description: "Base64url of its Ed25519 signature." }),
	},
	{ title: "E2EEntry" },
);

export const E2EChain = Type.Object(
	{
		entries: Type.Array(E2EEntry, { description: "Oldest first; an entry's `seq` is its index." }),
	},
	{ title: "E2EChain" },
);

export const E2EChainAppend = Type.Object(
	{
		from: Type.Integer({
			minimum: 0,
			description: "The seq of the first entry given: the chain's length as the caller last saw it.",
		}),
		entries: Type.Array(E2EEntry, { minItems: 1, maxItems: 100 }),
	},
	{ title: "E2EChainAppend" },
);

// Snapshots.

export const SnapshotKind = Type.Union([Type.Literal("automatic"), Type.Literal("saved")], {
	title: "SnapshotKind",
	description:
		"`automatic`: one of a sandbox's own history, taken as it runs and at each stop; the newest is what a resume or " +
		"fork uses, and older ones expire. `saved`: kept under a name until deleted, and usable as a template for new " +
		"sandboxes, even after its sandbox is deleted.",
});

export const SnapshotState = Type.Union(
	[Type.Literal("creating"), Type.Literal("ready"), Type.Literal("failed"), Type.Literal("deleting")],
	{ title: "SnapshotState" },
);

export const Snapshot = Type.Object(
	{
		id: id("The snapshot's ID, such as `snap_2h8d6f`."),
		accountId: Type.String(),
		kind: SnapshotKind,
		name: Type.Optional(Type.String({ description: "A saved snapshot's name, unique in its account." })),
		description: Type.Optional(Type.String()),
		sandboxId: Type.Optional(Type.String({ description: "The sandbox it was taken of; absent once that is deleted." })),
		sandboxType: SandboxType,
		state: SnapshotState,
		trigger: Type.Optional(
			Type.Union([Type.Literal("periodic"), Type.Literal("stop"), Type.Literal("manual"), Type.Literal("save")], {
				description: "What took it.",
			}),
		),
		memory: Type.Boolean({ description: "Whether it holds the sandbox's memory as well as its disk (a pause)." }),
		sizeBytes: Type.Optional(Type.Integer()),
		createdAt: Timestamp,
		expiresAt: Type.Optional(Timestamp),
	},
	{ title: "Snapshot" },
);

export const SnapshotPage = Type.Object({ items: Type.Array(Snapshot), nextCursor }, { title: "SnapshotPage" });

export const SnapshotPath = Type.Object({ snapshotId: id("The snapshot's ID.") }, { title: "SnapshotPath" });

export const ListSnapshotsQuery = Type.Object(
	{
		account: accountQuery,
		kind: Type.Optional(SnapshotKind),
		sandboxId: Type.Optional(Type.String()),
		limit,
		cursor,
	},
	{ title: "ListSnapshotsQuery" },
);

export const TakeSnapshotBody = Type.Object(
	{ description: Type.Optional(Type.String({ maxLength: 500 })) },
	{ title: "TakeSnapshotBody" },
);

export const SaveSnapshotBody = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 63, pattern: "^[a-z0-9][a-z0-9-_.]*$" }),
		sandboxId: Type.String({ description: "The sandbox to save, running or stopped." }),
		snapshotId: Type.Optional(
			Type.String({ description: "Save this snapshot of the sandbox's history. Default: its state now." }),
		),
		description: Type.Optional(Type.String({ maxLength: 500 })),
		replace: Type.Optional(Type.Boolean({ description: "Replace a saved snapshot of the same name." })),
	},
	{ title: "SaveSnapshotBody" },
);

export const SnapshotFilesQuery = Type.Object(
	{ path: Type.Optional(Type.String({ description: "A directory; default the user's home." })), limit, cursor },
	{ title: "SnapshotFilesQuery" },
);

// API keys.

export const ApiKey = Type.Object(
	{
		id: id("The key's ID, such as `key_5n2p8r`."),
		accountId: Type.String(),
		name: Type.String(),
		prefix: Type.String({ description: "The secret's first characters, such as `ksk_5n2p`, to tell keys apart." }),
		scopes: Type.Array(ApiKeyScope),
		sandboxIds: Type.Optional(
			Type.Array(Type.String(), { description: "Limited to these sandboxes (and the ones it creates)." }),
		),
		createdBy: CreatedBy,
		createdAt: Timestamp,
		expiresAt: Type.Optional(Timestamp),
		lastUsedAt: Type.Optional(
			Type.Integer({
				description: "When the key last signed a call in, to within a minute. Absent until its first use.",
			}),
		),
		revokedAt: Type.Optional(Timestamp),
	},
	{ title: "ApiKey", description: "A scoped API key. Its secret is never stored or shown after it is made." },
);

export const ApiKeyList = Type.Object({ items: Type.Array(ApiKey) }, { title: "ApiKeyList" });

export const ApiKeyPath = Type.Object({ apiKeyId: id("The key's ID.") }, { title: "ApiKeyPath" });

export const ApiKeyPreset = Type.Union(
	[Type.Literal("read-only"), Type.Literal("agent"), Type.Literal("ci"), Type.Literal("admin")],
	{
		title: "ApiKeyPreset",
		description:
			"A named set of scopes. `read-only`: the `:read` scopes. `agent`: what a coding agent needs to make and drive its " +
			"own sandboxes, everything but `sandboxes:delete` and the account and host scopes. `ci`: `agent` plus " +
			"`sandboxes:delete`. `admin`: every scope but `hosts:admin`.",
	},
);

export const CreateApiKeyBody = Type.Object(
	{
		account: accountQuery,
		name: Type.String({ minLength: 1, maxLength: 100 }),
		scopes: Type.Optional(Type.Array(ApiKeyScope, { minItems: 1 })),
		preset: Type.Optional(ApiKeyPreset),
		sandboxIds: Type.Optional(Type.Array(Type.String())),
		expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650, description: "Absent: it never expires." })),
	},
	{
		title: "CreateApiKeyBody",
		description: "Give `scopes` or a `preset` (or both, which adds them). A key can't hold a scope its maker lacks.",
	},
);

export const IssuedApiKey = Type.Object(
	{ key: ApiKey, secret: Type.String({ description: "The key itself, `ksk_…`. Shown once: store it now." }) },
	{ title: "IssuedApiKey" },
);

// Signing in a device (the command line) in a browser.

export const StartDeviceLoginBody = Type.Object(
	{
		clientName: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 100,
				description:
					"What is signing in, shown to the person who approves it and given to its key: `kantel on build-01`.",
			}),
		),
	},
	{ title: "StartDeviceLoginBody" },
);

export const DeviceLogin = Type.Object(
	{
		deviceCode: Type.String({ description: "`kdc_…`: the device's secret, which it polls with. Never show it." }),
		userCode: Type.String({ description: "`ABCD-EFGH`: the code the person checks in the browser." }),
		verificationUrl: Type.String({ description: "The console's page where a signed-in person approves it." }),
		verificationUrlComplete: Type.String({ description: "The same page with the code filled in." }),
		intervalSeconds: Type.Integer({ description: "Poll no more often than this." }),
		expiresAt: Timestamp,
	},
	{
		title: "DeviceLogin",
		description: "A sign-in in the browser under way, as RFC 8628's device authorisation grant.",
	},
);

export const PollDeviceLoginBody = Type.Object(
	{ deviceCode: Type.String({ minLength: 1 }) },
	{ title: "PollDeviceLoginBody" },
);

export const DeviceLoginState = Type.Union(
	[Type.Literal("pending"), Type.Literal("approved"), Type.Literal("denied"), Type.Literal("expired")],
	{
		title: "DeviceLoginState",
		description:
			"`pending`: no one has approved it yet. `approved`: the poll that sees it first gets the key; later polls are " +
			"`expired`. `denied`: the person refused it. `expired`: too late, or already collected.",
	},
);

export const DeviceLoginResult = Type.Object(
	{
		state: DeviceLoginState,
		issued: Type.Optional(IssuedApiKey),
	},
	{ title: "DeviceLoginResult", description: "With `approved`, the new key and its secret, shown this once." },
);

export const DeviceLoginPath = Type.Object(
	{ userCode: Type.String({ minLength: 1, description: "The code the device showed, such as `ABCD-EFGH`." }) },
	{ title: "DeviceLoginPath" },
);

export const DeviceLoginRequest = Type.Object(
	{
		userCode: Type.String(),
		clientName: Type.String(),
		state: DeviceLoginState,
		createdAt: Timestamp,
		expiresAt: Timestamp,
	},
	{
		title: "DeviceLoginRequest",
		description: "A device waiting for a person to approve it, as the approval page shows it.",
	},
);

export const ApproveDeviceLoginBody = Type.Object(
	{
		account: accountQuery,
		preset: Type.Optional(ApiKeyPreset),
		expiresInDays: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 3650, description: "Default 90. The key stops working after it." }),
		),
	},
	{
		title: "ApproveDeviceLoginBody",
		description:
			"The key the device gets, in the approver's personal account unless `account` names an organisation. Without " +
			"`preset`, every scope the approver may grant there, `hosts:admin` included for a super-admin.",
	},
);

// The egress proxy.

export const ProxySettings = Type.Object(
	{
		accountId: Type.String(),
		enabled: Type.Boolean({ description: "Send sandboxes' outbound traffic through the proxy." }),
		defaultAction: Type.Union([Type.Literal("allow"), Type.Literal("deny")], {
			description: "What happens to a host no rule names.",
		}),
		allow: Type.Array(Type.String(), { description: "Hosts always let through: `api.github.com`, `*.npmjs.org`." }),
		deny: Type.Array(Type.String(), { description: "Hosts always refused; deny wins over allow." }),
		upstream: Type.Optional(
			Type.Object(
				{
					url: Type.String({ description: "Another proxy every allowed request goes on to, such as a Mehen." }),
					headerNames: Type.Array(Type.String(), {
						description: "The names of the headers Kantel sends it; their values are never shown.",
					}),
				},
				{ title: "ProxyUpstream" },
			),
		),
		attribution: Type.Boolean({
			description:
				"Tell the upstream which sandbox and account each request came from, in signed `Kantel-Sandbox` and " +
				"`Kantel-Account` headers.",
		}),
		updatedAt: Timestamp,
	},
	{
		title: "ProxySettings",
		description: "Where sandboxes' outbound traffic may go, and through what, for one account. Experimental.",
	},
);

export const PutProxySettingsBody = Type.Object(
	{
		account: accountQuery,
		enabled: Type.Boolean(),
		defaultAction: Type.Optional(Type.Union([Type.Literal("allow"), Type.Literal("deny")])),
		allow: Type.Optional(Type.Array(Type.String())),
		deny: Type.Optional(Type.Array(Type.String())),
		upstream: Type.Optional(
			Type.Union([
				Type.Object({
					url: Type.String(),
					headers: Type.Optional(
						Type.Record(Type.String(), Type.String(), { description: "Kept encrypted, never shown again." }),
					),
				}),
				Type.Null(),
			]),
		),
		attribution: Type.Optional(Type.Boolean()),
	},
	{ title: "PutProxySettingsBody" },
);

export const AccountScopedQuery = Type.Object({ account: accountQuery }, { title: "AccountScopedQuery" });

// Environments: what a sandbox starts with. And a sandbox's egress.

/** An environment's name: lower-case letters, digits and dashes, as a DNS label. */
export const ENVIRONMENT_NAME_PATTERN = "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$";

export const EnvironmentVariable = Type.Object(
	{
		name: Type.String(),
		protected: Type.Boolean({
			description:
				"A protected variable is a `kph_` placeholder in the sandbox, its own per sandbox, which the host's egress proxy " +
				"swaps for the value on requests to its bindings: the value never enters the sandbox.",
		}),
		value: Type.Optional(Type.String({ description: "A plain variable's value. Never answered for a protected one." })),
		bindings: Type.Array(DestinationBinding, {
			description: "A protected variable's destinations, at least one. Empty for a plain one.",
		}),
		updatedAt: Timestamp,
	},
	{ title: "EnvironmentVariable" },
);

export const EnvironmentFile = Type.Object(
	{
		path: Type.String({ description: "Absolute, such as `/home/user/.npmrc`." }),
		mode: Type.Integer({ description: "Its permissions, such as 384 (0o600)." }),
		sizeBytes: Type.Integer(),
		updatedAt: Timestamp,
	},
	{
		title: "EnvironmentFile",
		description: "A secret file every new sandbox starts with. Its contents are write-only, and kept encrypted.",
	},
);

export const EnvironmentRepo = Type.Object(
	{
		url: Type.String({
			minLength: 1,
			maxLength: 2048,
			description: "HTTPS with no credentials in it, such as `https://github.com/lleverage-ai/kantel`.",
		}),
		path: Type.Optional(
			Type.String({ minLength: 1, maxLength: 1024, description: "Where it is cloned; default `~/<name>`." }),
		),
		ref: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 255,
				description: "A branch or tag; default the repository's default branch.",
			}),
		),
	},
	{
		title: "EnvironmentRepo",
		description: "A repository every new sandbox starts with, cloned through the egress proxy once it is running.",
	},
);

export const Environment = Type.Object(
	{
		id: id("The environment's ID, such as `env_4kq9x2mt`."),
		accountId: Type.String(),
		name: Type.String(),
		description: Type.Optional(Type.String()),
		variables: Type.Array(EnvironmentVariable),
		files: Type.Array(EnvironmentFile),
		repos: Type.Array(EnvironmentRepo),
		grants: Type.Array(EgressGrant),
		sandboxCount: Type.Integer({ description: "How many sandboxes were made from it and still exist." }),
		createdAt: Timestamp,
		updatedAt: Timestamp,
	},
	{
		title: "Environment",
		description:
			"What a sandbox starts with: variables, secret files, repositories and egress grants. A change reaches " +
			"sandboxes made after it, except a protected variable's value, bindings and the grants, which reach running " +
			"ones at once.",
	},
);

export const EnvironmentList = Type.Object({ items: Type.Array(Environment) }, { title: "EnvironmentList" });

export const EnvironmentPath = Type.Object(
	{ environmentId: id("The environment's ID.") },
	{ title: "EnvironmentPath" },
);

export const EnvironmentVariablePath = Type.Object(
	{ environmentId: id("The environment's ID."), name: Type.String({ description: "The variable's name." }) },
	{ title: "EnvironmentVariablePath" },
);

export const CreateEnvironmentBody = Type.Object(
	{
		account: accountQuery,
		name: Type.String({
			pattern: ENVIRONMENT_NAME_PATTERN,
			description: "Unique in the account: lower-case letters, digits and dashes, at most 63.",
		}),
		description: Type.Optional(Type.String({ maxLength: 500 })),
	},
	{ title: "CreateEnvironmentBody" },
);

export const UpdateEnvironmentBody = Type.Object(
	{
		name: Type.Optional(Type.String({ pattern: ENVIRONMENT_NAME_PATTERN })),
		description: Type.Optional(Type.String({ maxLength: 500, description: "Empty clears it." })),
	},
	{ title: "UpdateEnvironmentBody" },
);

export const SetEnvironmentVariableBody = Type.Object(
	{
		protected: Type.Optional(Type.Boolean({ description: "Default false." })),
		value: Type.Optional(
			Type.String({
				maxLength: 32_768,
				description:
					"Required for a new variable and when it becomes protected or plain. Left out on a protected one, it keeps " +
					"its value (to change its bindings); a new value for a protected one is a rotation.",
			}),
		),
		bindings: Type.Optional(
			Type.Array(DestinationBinding, {
				maxItems: 32,
				description: "A protected variable's destinations, at least one. Left out, a protected one keeps its own.",
			}),
		),
	},
	{ title: "SetEnvironmentVariableBody" },
);

export const SetEnvironmentFileBody = Type.Object(
	{
		path: Type.String({ minLength: 1, maxLength: 1024, description: "Absolute, or relative to `/home/user`." }),
		mode: Type.Optional(Type.Integer({ minimum: 0, maximum: 4095, description: "Default 384 (0o600)." })),
		content: Type.Optional(
			Type.String({
				description: "At most 1 MiB, in `encoding`. Required for a new file; left out, the file keeps its contents.",
			}),
		),
		encoding: Type.Optional(FileEncoding),
	},
	{
		title: "SetEnvironmentFileBody",
		description: "`encoding` says how `content` is written: `utf8` (the default) or `base64`.",
	},
);

export const EnvironmentFileQuery = Type.Object(
	{ path: Type.String({ minLength: 1, maxLength: 1024 }) },
	{ title: "EnvironmentFileQuery" },
);

const EXPECTED =
	"The list as you last read it. Given, the write is refused with `conflict` if the list has changed since, so an " +
	"edit made from an older read can't undo someone else's: read it again and redo the edit. Left out, the list is " +
	"replaced whatever it holds.";

export const PutEnvironmentReposBody = Type.Object(
	{
		repos: Type.Array(EnvironmentRepo, { maxItems: 20 }),
		expected: Type.Optional(Type.Array(EnvironmentRepo, { maxItems: 20, description: EXPECTED })),
	},
	{ title: "PutEnvironmentReposBody" },
);

export const PutEgressGrantsBody = Type.Object(
	{
		grants: Type.Array(EgressGrantInput, { maxItems: 200 }),
		expected: Type.Optional(Type.Array(EgressGrantInput, { maxItems: 200, description: EXPECTED })),
	},
	{ title: "PutEgressGrantsBody" },
);

export const EgressEntry = Type.Object(
	{
		id: id("The entry's ID."),
		at: Timestamp,
		method: Type.String({ description: "`CONNECT` for a tunnel the proxy didn't look inside." }),
		host: Type.String(),
		port: Type.Integer(),
		path: Type.Optional(
			Type.String({ description: "The path, when the proxy saw it (plain HTTP or inspected HTTPS); never the query." }),
		),
		decision: Type.Union([Type.Literal("allowed"), Type.Literal("denied")]),
		reason: Type.Optional(Type.String({ description: "Why it was denied, or what failed, in words." })),
		rule: Type.Optional(
			Type.String({ description: "The rule that decided it, such as `deny DELETE api.github.com /repos/*`." }),
		),
		code: Type.Optional(
			Type.String({ description: "A refusal's `X-Kantel-Proxy-Error` code, such as `placeholder-unbound`." }),
		),
		swapped: Type.Array(Type.String(), {
			description: "The protected variables whose values the proxy put in, by name.",
		}),
		inspected: Type.Boolean({ description: "Whether the proxy looked inside the HTTPS." }),
		status: Type.Optional(Type.Integer({ description: "The answer's status, when the proxy saw one." })),
		bytesUp: Type.Integer(),
		bytesDown: Type.Integer(),
	},
	{
		title: "EgressEntry",
		description: "One request or connection a sandbox made through its host's egress proxy. Never a value.",
	},
);

export const SandboxProtectedVariable = Type.Object(
	{
		name: Type.String(),
		placeholderPrefix: Type.String({ description: "The first 8 characters of its placeholder, such as `kph_7Qx2`." }),
		bindings: Type.Array(DestinationBinding),
	},
	{ title: "SandboxProtectedVariable", description: "A protected variable as one sandbox has it: never its value." },
);

export const SandboxEgress = Type.Object(
	{
		sandboxId: Type.String(),
		sandboxName: Type.String(),
		accountId: Type.String(),
		environment: Type.Optional(
			Type.Object({ id: Type.String(), name: Type.String() }, { title: "SandboxEgressEnvironment" }),
		),
		protectedVariables: Type.Array(SandboxProtectedVariable),
		environmentGrants: Type.Array(EgressGrant, { description: "Its environment's grants, which it has too." }),
		grants: Type.Array(EgressGrant, { description: "Its own grants, on top of its environment's." }),
		entries: Type.Array(EgressEntry, { description: "Newest first; Kantel keeps the newest 1000." }),
	},
	{ title: "SandboxEgress", description: "A sandbox's egress: what it was made with, its own grants and its log." },
);

export const SandboxEgressQuery = Type.Object(
	{
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 1000, description: "At most this many entries; default 100." }),
		),
	},
	{ title: "SandboxEgressQuery" },
);

// Events and webhooks.

export const EventType = Type.Union(
	[
		Type.Literal("sandbox.created"),
		Type.Literal("sandbox.running"),
		Type.Literal("sandbox.stopped"),
		Type.Literal("sandbox.paused"),
		Type.Literal("sandbox.error"),
		Type.Literal("sandbox.degraded"),
		Type.Literal("sandbox.recovered"),
		Type.Literal("sandbox.deleted"),
		Type.Literal("snapshot.saved"),
		Type.Literal("snapshot.deleted"),
	],
	{
		title: "EventType",
		description:
			"`sandbox.created`: made, before it runs. `sandbox.running`: it runs commands now, after a create, resume, fork " +
			"or recovery. `sandbox.stopped`, `sandbox.paused`: it stopped (by a call or its auto-stop), or paused. " +
			"`sandbox.error`: it entered `error`. `sandbox.degraded`, `sandbox.recovered`: its host lost and regained it; " +
			"`sandbox.degraded` also when its environment's secret file or repository couldn't be set up (its reason " +
			"says which), which leaves it running. " +
			"`sandbox.deleted`: erased. `snapshot.saved`, `snapshot.deleted`: a saved snapshot was made or deleted.",
	},
);

export const Event = Type.Object(
	{
		id: id("The event's ID, such as `evt_8x7w6v`: a webhook's delivery ID, so deduplicate on it."),
		type: EventType,
		accountId: Type.String(),
		createdAt: Timestamp,
		sandboxId: Type.Optional(Type.String()),
		snapshotId: Type.Optional(Type.String()),
		data: Type.Object(
			{
				name: Type.Optional(Type.String()),
				state: Type.Optional(SandboxState),
				previousState: Type.Optional(SandboxState),
				reason: Type.Optional(Type.String()),
				actor: Type.Optional(CreatedBy),
			},
			{ title: "EventData" },
		),
	},
	{
		title: "Event",
		description: "Something that happened in an account: what webhooks deliver and the history shows.",
	},
);

export const EventPage = Type.Object({ items: Type.Array(Event), nextCursor }, { title: "EventPage" });

export const ListEventsQuery = Type.Object(
	{
		account: accountQuery,
		sandboxId: Type.Optional(Type.String()),
		type: Type.Optional(EventType),
		since: Type.Optional(Type.Integer()),
		limit,
		cursor,
	},
	{ title: "ListEventsQuery" },
);

export const Webhook = Type.Object(
	{
		id: id("The webhook's ID, such as `whk_3m4n5b`."),
		accountId: Type.String(),
		name: Type.String(),
		url: Type.String(),
		events: Type.Array(EventType),
		enabled: Type.Boolean(),
		createdAt: Timestamp,
		lastDelivery: Type.Optional(
			Type.Object(
				{ at: Timestamp, ok: Type.Boolean(), status: Type.Optional(Type.Integer()) },
				{ title: "WebhookLastDelivery" },
			),
		),
	},
	{
		title: "Webhook",
		description:
			"An HTTPS endpoint that gets an account's events, signed as Standard Webhooks are: `webhook-id`, " +
			"`webhook-timestamp` and `webhook-signature` (`v1,` and the base64 HMAC-SHA256 of `id.timestamp.body`, keyed " +
			"by the secret after its `whsec_`). Failed deliveries are retried with backoff, up to 8 attempts.",
	},
);

export const WebhookList = Type.Object({ items: Type.Array(Webhook) }, { title: "WebhookList" });

export const WebhookPath = Type.Object({ webhookId: id("The webhook's ID.") }, { title: "WebhookPath" });

export const CreateWebhookBody = Type.Object(
	{
		account: accountQuery,
		name: Type.String({ minLength: 1, maxLength: 100 }),
		url: Type.String({ description: "HTTPS; a self-hosted install may allow `http://` to a private address." }),
		events: Type.Array(EventType, { minItems: 1 }),
	},
	{ title: "CreateWebhookBody" },
);

export const UpdateWebhookBody = Type.Object(
	{
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
		url: Type.Optional(Type.String()),
		events: Type.Optional(Type.Array(EventType, { minItems: 1 })),
		enabled: Type.Optional(Type.Boolean()),
	},
	{ title: "UpdateWebhookBody" },
);

export const WebhookWithSecret = Type.Object(
	{ webhook: Webhook, secret: Type.String({ description: "The signing secret, `whsec_…`. Shown once." }) },
	{ title: "WebhookWithSecret" },
);

export const WebhookDelivery = Type.Object(
	{
		id: id("The delivery's ID."),
		webhookId: Type.String(),
		eventId: Type.String(),
		eventType: EventType,
		state: Type.Union([Type.Literal("pending"), Type.Literal("delivered"), Type.Literal("failed")]),
		attempts: Type.Integer(),
		lastStatus: Type.Optional(Type.Integer()),
		lastError: Type.Optional(Type.String()),
		nextAttemptAt: Type.Optional(Timestamp),
		createdAt: Timestamp,
		deliveredAt: Type.Optional(Timestamp),
	},
	{ title: "WebhookDelivery" },
);

export const WebhookDeliveryPage = Type.Object(
	{ items: Type.Array(WebhookDelivery), nextCursor },
	{ title: "WebhookDeliveryPage" },
);

// OpenTelemetry export.

export const TelemetryExport = Type.Object(
	{
		accountId: Type.String(),
		endpoint: Type.String({
			description: "An OTLP/HTTP collector's base URL; `/v1/metrics` and `/v1/logs` are added.",
		}),
		headerNames: Type.Array(Type.String(), { description: "The headers sent with each export; values never shown." }),
		signals: Type.Array(Type.Union([Type.Literal("metrics"), Type.Literal("logs")])),
		lastExport: Type.Optional(
			Type.Object(
				{
					at: Timestamp,
					ok: Type.Boolean(),
					status: Type.Optional(Type.Integer()),
					error: Type.Optional(Type.String()),
				},
				{ title: "TelemetryLastExport" },
			),
		),
		updatedAt: Timestamp,
	},
	{
		title: "TelemetryExport",
		description:
			"Where an account's telemetry goes: sandbox metrics (`kantel.sandbox.running`, `kantel.sandbox.cpu.seconds`, " +
			"`kantel.sandbox.cost`, …) every 60 seconds, and each lifecycle event as an OTLP log record when it happens.",
	},
);

export const PutTelemetryBody = Type.Object(
	{
		account: accountQuery,
		endpoint: Type.String(),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		signals: Type.Optional(Type.Array(Type.Union([Type.Literal("metrics"), Type.Literal("logs")]), { minItems: 1 })),
	},
	{ title: "PutTelemetryBody" },
);

export const TelemetryTest = Type.Object(
	{
		telemetry: TelemetryExport,
		test: Type.Object(
			{ ok: Type.Boolean(), status: Type.Optional(Type.Integer()), error: Type.Optional(Type.String()) },
			{ title: "TelemetryTestResult", description: "What the collector answered to an empty export sent on save." },
		),
	},
	{ title: "TelemetryTest" },
);

// Hosts (super-admin).

export const HostState = Type.Union(
	[Type.Literal("online"), Type.Literal("unreachable"), Type.Literal("draining"), Type.Literal("revoked")],
	{
		title: "HostState",
		description:
			"`online`: connected and taking sandboxes. `unreachable`: its connection dropped; its sandboxes can't be reached " +
			"until it is back. `draining`: connected, but takes no new sandboxes. `revoked`: its credential is revoked.",
	},
);

export const Host = Type.Object(
	{
		id: id("The host's ID, such as `host_6t5r4e`."),
		name: Type.String(),
		state: HostState,
		version: Type.Optional(Type.String({ description: "Its host agent's version." })),
		latestVersion: Type.Optional(Type.String({ description: "The newest version the control plane offers." })),
		os: Type.Optional(Type.String()),
		arch: Type.Optional(Type.Union([Type.Literal("x86_64"), Type.Literal("aarch64")])),
		tiers: Type.Array(SandboxType, { description: "The sandbox types it runs." }),
		kvm: Type.Boolean(),
		nestedVirtualisation: Type.Boolean(),
		capacity: Type.Object(
			{
				vcpus: Type.Integer(),
				memoryMb: Type.Integer(),
				diskGb: Type.Integer(),
			},
			{ title: "HostCapacity" },
		),
		allocated: Type.Object(
			{
				sandboxes: Type.Integer(),
				vcpus: Type.Integer(),
				memoryMb: Type.Integer(),
				diskGb: Type.Integer(),
			},
			{ title: "HostAllocated" },
		),
		labels: Type.Record(Type.String(), Type.String()),
		accountId: Type.Optional(
			id(
				"The account the host belongs to, when it was added to one by its people: only that account's " +
					"sandboxes run on it. Absent for a host the deployment's super-admin joined, which any account's sandboxes " +
					"may use.",
			),
		),
		joinedAt: Timestamp,
		lastSeenAt: Type.Optional(Timestamp),
	},
	{
		title: "Host",
		description: "A machine that runs sandboxes. It dials out to the control plane; it takes no inbound ports.",
	},
);

export const HostList = Type.Object({ items: Type.Array(Host) }, { title: "HostList" });

export const HostPath = Type.Object({ hostId: id("The host's ID.") }, { title: "HostPath" });

export const UpdateHostBody = Type.Object(
	{
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
		labels: Type.Optional(Type.Record(Type.String(), Type.String())),
		draining: Type.Optional(Type.Boolean({ description: "Stop placing new sandboxes on it." })),
	},
	{ title: "UpdateHostBody" },
);

export const CreateHostJoinTokenBody = Type.Object(
	{
		name: Type.Optional(Type.String({ maxLength: 100 })),
		labels: Type.Optional(Type.Record(Type.String(), Type.String())),
		expiresInMinutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 10080, description: "Default 60." })),
	},
	{ title: "CreateHostJoinTokenBody" },
);

export const HostJoinToken = Type.Object(
	{
		id: id("The token's ID."),
		token: Type.String({ description: "`kth_…`, shown once. It joins one host." }),
		command: Type.String({ description: "The one-line command that installs and registers a host with it." }),
		expiresAt: Timestamp,
	},
	{ title: "HostJoinToken" },
);

// An account's own hosts (experimental, behind the deployment's KANTEL_ACCOUNT_HOSTS switch).

export const CreateAccountJoinTokenBody = Type.Object(
	{
		account: accountQuery,
		name: Type.Optional(
			Type.String({ maxLength: 100, description: "The host's name. Default: the machine's hostname." }),
		),
		labels: Type.Optional(Type.Record(Type.String(), Type.String())),
		expiresInMinutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 10080, description: "Default 60." })),
	},
	{ title: "CreateAccountJoinTokenBody" },
);

export const AccountJoinToken = Type.Object(
	{
		id: id("The token's ID."),
		accountId: id("The account the host joins: only its sandboxes will run there."),
		token: Type.String({ description: "`kth_…`, shown once. It joins one host, once, before `expiresAt`." }),
		command: Type.String({
			description:
				"The one-line command that installs the host agent on a Linux machine and joins it with the token. The host " +
				"dials out to this deployment and keeps that connection open, so it needs no inbound port.",
		}),
		expiresAt: Timestamp,
	},
	{ title: "AccountJoinToken" },
);

export type Account = Static<typeof Account>;
export type AccountKind = Static<typeof AccountKind>;
export type MemberRole = Static<typeof MemberRole>;
export type Member = Static<typeof Member>;
export type Invite = Static<typeof Invite>;
export type Caller = Static<typeof Caller>;
export type SandboxType = Static<typeof SandboxType>;
export type SandboxState = Static<typeof SandboxState>;
export type SandboxVisibility = Static<typeof SandboxVisibility>;
export type SandboxSizeName = Static<typeof SandboxSizeName>;
export type SandboxCapabilities = Static<typeof SandboxCapabilities>;
export type Sandbox = Static<typeof Sandbox>;
export type CreateSandboxBody = Static<typeof CreateSandboxBody>;
export type Command = Static<typeof Command>;
export type FileEntry = Static<typeof FileEntry>;
export type ExposedPort = Static<typeof ExposedPort>;
export type Snapshot = Static<typeof Snapshot>;
export type SnapshotKind = Static<typeof SnapshotKind>;
export type ApiKeyScope = Static<typeof ApiKeyScope>;
export type ApiKeyPreset = Static<typeof ApiKeyPreset>;
export type ApiKey = Static<typeof ApiKey>;
export type ProxySettings = Static<typeof ProxySettings>;
export type DestinationBinding = Static<typeof DestinationBinding>;
export type EgressGrant = Static<typeof EgressGrant>;
export type EgressGrantInput = Static<typeof EgressGrantInput>;
export type EnvironmentVariable = Static<typeof EnvironmentVariable>;
export type EnvironmentFile = Static<typeof EnvironmentFile>;
export type EnvironmentRepo = Static<typeof EnvironmentRepo>;
export type Environment = Static<typeof Environment>;
export type EgressEntry = Static<typeof EgressEntry>;
export type SandboxProtectedVariable = Static<typeof SandboxProtectedVariable>;
export type SandboxEgress = Static<typeof SandboxEgress>;
export type EventType = Static<typeof EventType>;
export type Event = Static<typeof Event>;
export type Webhook = Static<typeof Webhook>;
export type WebhookDelivery = Static<typeof WebhookDelivery>;
export type TelemetryExport = Static<typeof TelemetryExport>;
export type Host = Static<typeof Host>;
export type HostState = Static<typeof HostState>;
export type HostJoinToken = Static<typeof HostJoinToken>;
export type AccountJoinToken = Static<typeof AccountJoinToken>;
export type DeviceLogin = Static<typeof DeviceLogin>;
export type DeviceLoginState = Static<typeof DeviceLoginState>;
export type DeviceLoginResult = Static<typeof DeviceLoginResult>;
export type DeviceLoginRequest = Static<typeof DeviceLoginRequest>;

/** Every scope, in the order the docs list them. */
export const API_KEY_SCOPES: readonly ApiKeyScope[] = [
	"sandboxes:read",
	"sandboxes:write",
	"sandboxes:delete",
	"exec",
	"files",
	"access",
	"snapshots:read",
	"snapshots:write",
	"account:read",
	"account:admin",
	"hosts:admin",
];

/** The scopes each preset stands for. */
export const API_KEY_PRESETS: { readonly [preset in ApiKeyPreset]: readonly ApiKeyScope[] } = {
	"read-only": ["sandboxes:read", "snapshots:read", "account:read"],
	agent: [
		"sandboxes:read",
		"sandboxes:write",
		"exec",
		"files",
		"access",
		"snapshots:read",
		"snapshots:write",
		"account:read",
	],
	ci: [
		"sandboxes:read",
		"sandboxes:write",
		"sandboxes:delete",
		"exec",
		"files",
		"access",
		"snapshots:read",
		"snapshots:write",
		"account:read",
	],
	admin: API_KEY_SCOPES.filter((scope) => scope !== "hosts:admin"),
};

/** Every event type. */
export const EVENT_TYPES: readonly EventType[] = [
	"sandbox.created",
	"sandbox.running",
	"sandbox.stopped",
	"sandbox.paused",
	"sandbox.error",
	"sandbox.degraded",
	"sandbox.recovered",
	"sandbox.deleted",
	"snapshot.saved",
	"snapshot.deleted",
];
