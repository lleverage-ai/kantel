/**
 * The compute plane's wire shapes: accounts and organisations, sandboxes and their commands, files, ports and access,
 * snapshots, scoped API keys, the egress proxy's settings, environments and sandboxes' egress, templates, webhooks,
 * OpenTelemetry export, events, and the super-admin's hosts. The schemas are the contract: the types below are read from them (`Static`), and the SDK's types
 * are generated from them, so there is one definition of each shape.
 *
 * No shape carries a host's address, a machine's provider ID or a credential, except a secret the caller is shown once
 * when it is made (an API key's, a webhook's signing secret, a host's join token). A protected variable's value and a
 * secret file's contents are write-only: no shape answers them.
 */
import {
	BUNDLE_DIGEST_PATTERN,
	DEFAULT_FILE_URL_TTL_SECONDS,
	MAX_FILE_URL_TTL_SECONDS,
	MAX_MOUNTS,
} from "@kantel/contracts/mounts";
import Type, { type Static } from "typebox";
import { PlacementReason, Timestamp } from "./schema.ts";

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
			"`snapshots:write`: snapshots and saved snapshots. `account:read`: the account, its members, keys, environments, " +
			"templates and sandboxes' egress. `account:admin`: members, keys, webhooks, telemetry, the proxy, environments, " +
			"templates and sandboxes' grants. `hosts:admin`: the deployment's hosts and template bases, for " +
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
		sandboxDomain: Type.Optional(
			Type.String({
				description:
					"The domain sandboxes' addresses are under: a sandbox's is `<subdomain>.<sandboxDomain>` and its exposed ports " +
					"`<port>-<subdomain>.<sandboxDomain>`, such as `kantel.run` on Kantel's hosted service. Absent when the " +
					"deployment names none.",
			}),
		),
		protectedValues: Type.Optional(
			Type.Boolean({
				description:
					"Whether the deployment keeps environments' protected variables and secret files (and bucket sources' " +
					"credentials). `false`: setting one is refused with `not_supported`, and plain variables still work. Absent " +
					"from a deployment older than this field: try, and read the error.",
			}),
		),
	},
	{
		title: "Caller",
		description: "Who is calling, the accounts they may act in, and the deployment's mode and what it supports.",
	},
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
		emailed: Type.Optional(
			Type.Boolean({
				description:
					"Only when the invite is made: whether Kantel emailed it, with a link that joins with its code. False " +
					"without an email, where the deployment sends no mail, or when the send failed.",
			}),
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

export const SandboxNotRunningCode = Type.Union(
	[
		Type.Literal("sandbox_starting"),
		Type.Literal("sandbox_stopping"),
		Type.Literal("sandbox_stopped"),
		Type.Literal("sandbox_paused"),
		Type.Literal("sandbox_error"),
		Type.Literal("sandbox_deleting"),
	],
	{
		title: "SandboxNotRunningCode",
		description:
			"Why a call that needs a running sandbox was refused. `sandbox_starting`: it was still starting when the call's " +
			"wait for it ran out; send the call again. `sandbox_stopping`, `sandbox_stopped`, `sandbox_paused`, " +
			"`sandbox_error`: resume it (`POST /sandboxes/{sandboxId}/resume`), then send the call again. " +
			"`sandbox_deleting`: it is being deleted.",
	},
);

export const SandboxNotRunning = Type.Object(
	{
		code: SandboxNotRunningCode,
		sandboxId: Type.String(),
		state: SandboxState,
		stopReason: Type.Optional(
			Type.String({
				description:
					"Why it stopped, paused or failed, where Kantel recorded it (the sandbox's `reason`): `auto-stop` when its " +
					"auto-stop time came, `idle-stop` when it went `idleStopMinutes` without use, a rule's reason when Kantel " +
					"stopped it, or what failed. A stop someone asked for has none. Not `details.reason`, which is a placement's.",
			}),
		),
		hint: Type.String({
			description:
				"What to do, in words, such as `Resume it with kantel resume sbx_4kq9x2mt or POST " +
				"/v1/sandboxes/sbx_4kq9x2mt/resume, then try again`.",
		}),
	},
	{
		title: "SandboxNotRunning",
		description:
			"The `details` of the `conflict` (409) a call that needs a running sandbox (commands, files, ports, file URLs, " +
			"archives) answers when the sandbox isn't running. A call made while it is starting waits for it, up to 60 " +
			"seconds, before it answers `sandbox_starting`. Kantel never resumes a stopped sandbox for such a call.",
	},
);

export const SandboxHealth = Type.Union([Type.Literal("ok"), Type.Literal("degraded")], {
	title: "SandboxHealth",
	description: "`degraded`: the machine is up but its host can't fully reach it; it keeps running.",
});

export const SandboxSizeName = Type.Union(
	[Type.Literal("small"), Type.Literal("default"), Type.Literal("large"), Type.Literal("xlarge")],
	{
		title: "SandboxSizeName",
		description:
			"A microVM's named size; a deployment may offer fewer. Isolates have none. Superseded by `resources` on create: " +
			"a named size is still taken for now, alone or with a disk of its own (`resources` with only `diskGb`).",
	},
);

/** An isolate's memory: 128 to 512 MB in steps of 64, 256 by default. */
export const ISOLATE_MEMORY_MB = { min: 128, max: 512, step: 64, default: 256 } as const;

export const SandboxShapeInput = Type.Object(
	{
		vcpus: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "A microVM's vCPUs. An isolate has none of its own: it shares its account's VM's CPU.",
			}),
		),
		memoryMb: Type.Optional(
			Type.Integer({
				minimum: ISOLATE_MEMORY_MB.min,
				description:
					"Memory in MB. An isolate takes 128 to 512 in steps of 64; a microVM up to what a host offers " +
					"(`getSandboxShapes`). Needed unless `diskGb` is given alone.",
			}),
		),
		diskGb: Type.Optional(
			Type.Integer({
				minimum: 1,
				description:
					"A microVM's disk in GB, chosen apart from its vCPUs and memory, within `getSandboxShapes`' " +
					"`microvm.diskGb`. Alone (with `size` or neither), the vCPUs and memory are that size's or the default's. " +
					"Default: the disk its host gives the shape. Not for an isolate, or with `from`: a sandbox made from a " +
					"snapshot keeps the snapshot's disk.",
			}),
		),
	},
	{
		title: "SandboxShapeInput",
		description:
			"What a new sandbox gets. A microVM restores a template snapshot on its host: by default the one its host " +
			"keeps for its vCPU count, whatever its memory and disk, so a shape off the presets is as fast as a preset once " +
			"that count's template is made. A host with shared templates turned off keeps one per preset, and a shape off " +
			"the presets boots from scratch.",
	},
);

export const ShapeRange = Type.Object(
	{ min: Type.Integer(), max: Type.Integer(), step: Type.Integer(), default: Type.Integer() },
	{ title: "ShapeRange" },
);

export const ShapePreset = Type.Object(
	{
		name: SandboxSizeName,
		vcpus: Type.Integer(),
		memoryMb: Type.Integer(),
		diskGb: Type.Integer({
			description:
				"The disk the host gives a fresh sandbox of this size. One made from a snapshot keeps that snapshot's disk.",
		}),
	},
	{ title: "ShapePreset" },
);

export const SandboxShapes = Type.Object(
	{
		isolate: Type.Object(
			{
				memoryMb: ShapeRange,
				enforced: Type.Boolean({
					description:
						"Whether an isolate's memory is a hard limit. False today: the runtime records it, and the account VM's " +
						"memory, shared by its isolates, is the limit.",
				}),
			},
			{ title: "IsolateShapes" },
		),
		microvm: Type.Optional(
			Type.Object(
				{
					vcpus: ShapeRange,
					memoryMb: ShapeRange,
					memoryMbPerVcpu: Type.Object(
						{ min: Type.Integer(), max: Type.Integer() },
						{ description: "Memory follows vCPUs: each vCPU has at least `min` and at most `max` MB." },
					),
					/**
					 * The disk a microVM may ask for (`resources.diskGb`), whatever its vCPUs and memory: described on
					 * `MicrovmShapes`, since a referenced range carries no description of its own.
					 */
					diskGb: Type.Optional(ShapeRange),
					presets: Type.Array(ShapePreset, {
						description:
							"Each shape a host makes by name. Hosts may give one name different shapes: each is its own entry.",
					}),
					custom: Type.Boolean({
						description:
							"Whether a host takes shapes off the presets; when false, only the presets. Unless a create asks for a " +
							"disk (`diskGb`), its host gives one; the sandbox's `resources` say what it got.",
					}),
				},
				{
					title: "MicrovmShapes",
					description:
						"Absent when no host the account may use runs microVMs. `diskGb` is the disk a microVM may ask for " +
						"(`resources.diskGb`), whatever its vCPUs and memory: within the hosts' limits and the free disk they last " +
						"reported, its `default` the default preset's. A sandbox no host has the free disk for now goes to `error` " +
						"with `placementReason` `insufficient_capacity`. `diskGb` is absent when no host takes a disk off its presets, or none has " +
						"the free disk for its least.",
				},
			),
		),
		rates: Type.Optional(
			Type.Object(
				{
					currency: Type.String(),
					microvmPerVcpuHour: Type.Number(),
					microvmPerGbHour: Type.Number(),
					isolatePerGbHour: Type.Number(),
				},
				{ title: "ShapeRates", description: "What an hour costs, per vCPU and GB; absent where it is free." },
			),
		),
	},
	{
		title: "SandboxShapes",
		description: "What a new sandbox in the account may be: the ranges its hosts offer, their presets and the rates.",
	},
);

export const SandboxResources = Type.Object(
	{
		vcpus: Type.Integer(),
		memoryMb: Type.Integer(),
		diskGb: Type.Integer(),
	},
	{ title: "SandboxResources" },
);

export const GuestFeature = Type.Object(
	{
		available: Type.Boolean(),
		detail: Type.Optional(
			Type.String({ description: "What the guest agent found, such as `Xtigervnc, Openbox, Selkies`." }),
		),
		reason: Type.Optional(
			Type.String({ description: "Why it isn't available, in words, such as `No desktop in this image`." }),
		),
	},
	{ title: "GuestFeature", description: "One thing a microVM's image has or lacks." },
);

export const GuestCapabilities = Type.Object(
	{
		reportedAt: Timestamp,
		agent: Type.Object(
			{
				version: Type.String(),
				injected: Type.Boolean({
					description:
						"Kantel put its guest agent into the image at boot (any Linux image), rather than the image shipping it.",
				}),
			},
			{ title: "GuestAgent" },
		),
		os: Type.Object(
			{
				id: Type.String({ description: "`/etc/os-release`'s `ID`, such as `debian`, `alpine` or `ubuntu`." }),
				name: Type.String({ description: "Its pretty name, such as `Debian GNU/Linux 13 (trixie)`." }),
				version: Type.Optional(Type.String({ description: "`VERSION_ID`, such as `13` or `3.22.2`." })),
			},
			{ title: "GuestOs" },
		),
		arch: Type.String({ description: "The machine, as `uname -m` says it: `x86_64` or `aarch64`." }),
		libc: Type.Union([Type.Literal("glibc"), Type.Literal("musl"), Type.Literal("none")], {
			description: "The image's C library; `none` for a static userland such as busybox's.",
		}),
		shell: Type.Optional(
			Type.String({ description: "The shell a `command` runs in, such as `/bin/bash`; absent: `argv` only." }),
		),
		init: Type.Union([Type.Literal("systemd"), Type.Literal("kantel")], {
			description: "PID 1: the image's systemd, or Kantel's own init when the image has none.",
		}),
		desktop: GuestFeature,
		browser: GuestFeature,
		// The browser alone: Chromium on a display of its own, with a stream of just that display, apart from the
		// desktop. Absent from a guest agent too old to say.
		browserSurface: Type.Optional(GuestFeature),
		docker: Type.Object(
			{
				...GuestFeature.properties,
				kvm: Type.Boolean({ description: "`/dev/kvm` opens inside, so containers and VMs in it can nest." }),
			},
			{ title: "GuestDocker" },
		),
	},
	{
		title: "GuestCapabilities",
		description:
			"What a microVM's image has, as its guest agent found it when it last started: its OS, and whether it has a " +
			"desktop, a browser (and `browserSurface`, the browser alone on a display of its own) and Docker.",
	},
);

export const SandboxCapabilities = Type.Object(
	{
		exec: Type.Boolean(),
		files: Type.Boolean(),
		ssh: Type.Boolean(),
		desktop: Type.Boolean(),
		browser: Type.Boolean(),
		browserSurface: Type.Optional(
			Type.Boolean({
				description:
					"Experimental. Whether `openBrowser`'s `url` shows the browser alone rather than the desktop it runs on: the image " +
					"has a display and a stream for its browser. Absent: false.",
			}),
		),
		ports: Type.Boolean(),
		docker: Type.Boolean(),
		kvm: Type.Boolean({ description: "`/dev/kvm` inside, for nested virtualisation." }),
		pause: Type.Boolean({ description: "Whether it can be paused with its memory kept." }),
		guest: Type.Optional(GuestCapabilities),
	},
	{
		title: "SandboxCapabilities",
		description:
			"What this sandbox can do, from its type and its host, and for a microVM from what its guest agent found in its " +
			"image (`guest`): `desktop`, `browser`, `docker` and `kvm` are false where the image lacks them.",
	},
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
			description:
				"CPU utilisation, 0 to 1, over the last 24 intervals of 5 minutes, oldest first: a sparkline. The last may be " +
				"the interval under way.",
		}),
		recentMemory: Type.Array(Type.Number({ minimum: 0 }), {
			description: "Memory in use, in bytes, over the same intervals as `recentCpu` (the same length), oldest first.",
		}),
	},
	{ title: "UsageSummary" },
);

export const UsageSparklines = Type.Object(
	{
		recentCpu: Type.Array(Type.Number({ minimum: 0, maximum: 1 }), {
			description:
				"CPU utilisation, 0 to 1, over the last 24 intervals of 5 minutes, oldest first. The last may be the interval " +
				"under way.",
		}),
		recentMemory: Type.Array(Type.Number({ minimum: 0 }), {
			description: "Memory in use, in bytes, over the same intervals as `recentCpu` (the same length), oldest first.",
		}),
	},
	{ title: "UsageSparklines", description: "A host's recent CPU and memory, for sparklines." },
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

// Base images (experimental, behind the deployment's KANTEL_IMAGE_PATCHING switch).

export const SandboxBase = Type.Object(
	{
		image: Type.String({
			description:
				"The base image it is on, by its name in Kantel's base image index: `host` for a microVM (the host images: " +
				"kernel and root file system), `sandbox` for the container tier.",
		}),
		version: Type.Optional(
			Type.String({ description: "The version of the base it is on, such as `host-images-20261104.812`." }),
		),
		outdated: Type.Boolean({ description: "Its base isn't the version its channel (`stable`) names now." }),
		latest: Type.Optional(
			Type.Object(
				{
					version: Type.String(),
					builtAt: Type.String({ description: "When it was built, ISO 8601." }),
				},
				{ title: "SandboxBaseLatest", description: "The version its channel names now." },
			),
		),
		behind: Type.Optional(
			Type.Object(
				{
					days: Type.Integer({
						minimum: 0,
						description: "Whole days since the version after its own was built: how long it has been superseded.",
					}),
					versions: Type.Integer({ minimum: 0, description: "How many versions are newer." }),
				},
				{ title: "SandboxBaseBehind", description: "How far behind its channel it is, while outdated." },
			),
		),
		security: Type.Optional(
			Type.Boolean({
				description: "A newer version fixes Critical or High vulnerabilities this one has: restart it on the latest.",
			}),
		),
	},
	{
		title: "SandboxBase",
		description:
			"The base image a sandbox's (or a snapshot's) root file system is, and how far behind it is. A running sandbox is " +
			"never patched underneath: an outdated one stays on its base until it is restarted on the latest " +
			"(`restartSandboxOnLatest`) or made again. Experimental: present only where the deployment has image patching " +
			"on (`KANTEL_IMAGE_PATCHING`) and knows the version.",
	},
);

// Read-only mounts (experimental, behind the deployment's KANTEL_MOUNTS switch): what a sandbox's create names, and
// what its record answers.

const MOUNTS_EXPERIMENTAL =
	"Experimental: `not_supported` unless the deployment has turned mounts on (`KANTEL_MOUNTS=experimental`).";

export const BundleMountSource = Type.Object(
	{
		kind: Type.Literal("bundle"),
		digest: Type.String({
			pattern: BUNDLE_DIGEST_PATTERN,
			description: "A bundle uploaded to the sandbox's account, by its digest: `sha256:` and 64 hex digits.",
		}),
	},
	{
		title: "BundleMountSource",
		description:
			"A bundle's files: the tar the account uploaded (`POST /bundles`), unpacked read-only at the mount's path.",
	},
);

export const BucketMountSource = Type.Object(
	{
		kind: Type.Literal("bucket"),
		bucketSourceId: Type.String({ description: "A bucket source of the sandbox's account, such as `bks_4kq9x2mt`." }),
		prefix: Type.String({
			maxLength: 1024,
			description: "The objects under this key prefix, such as `org/42/skills/`; empty for the whole bucket.",
		}),
		refreshTtlSeconds: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: 86400,
				description:
					"How long the host trusts its listing of the prefix before it looks again, so objects added later appear. " +
					"0: never look again. Default: the host's.",
			}),
		),
	},
	{
		title: "BucketMountSource",
		description:
			"An object-store prefix, through a bucket source the account holds. The host reads objects as they are opened; " +
			"the bucket source's credentials stay on the host, never in the sandbox.",
	},
);

export const MountSource = Type.Union([BundleMountSource, BucketMountSource], { title: "MountSource" });

export const Mount = Type.Object(
	{
		path: Type.String({
			minLength: 2,
			maxLength: 1024,
			description:
				"Where it appears in the sandbox: absolute and normalised, not `/`, not at or under a system directory " +
				"(`/proc`, `/sys`, `/dev`, `/etc`, `/usr`, `/bin`, `/lib` and the like), and not overlapping another mount.",
		}),
		source: MountSource,
	},
	{
		title: "Mount",
		description: "Files from outside the sandbox, read-only inside it: nothing in the sandbox can change them.",
	},
);

export const MountStatus = Type.Union([Type.Literal("pending"), Type.Literal("ready"), Type.Literal("failed")], {
	title: "MountStatus",
	description:
		"`pending`: its host is still putting it in place. `ready`: its files are there. `failed`: they aren't, and " +
		"`error` says why; the sandbox runs without it.",
});

export const SandboxMount = Type.Object(
	{
		path: Type.String(),
		source: MountSource,
		status: MountStatus,
		error: Type.Optional(Type.String({ description: "Why it is `failed`, in words." })),
	},
	{ title: "SandboxMount", description: "A mount of a sandbox's, and whether its files are in place." },
);

export const SandboxTemplate = Type.Object(
	{
		id: Type.String({ description: "The template's ID, `tpl_…`." }),
		name: Type.String(),
		version: Type.Integer({ description: "The template's version it was made from." }),
		snapshotId: Type.Optional(
			Type.String({ description: "The template snapshot it started from, `tsn_…`; absent for a fresh boot." }),
		),
		start: Type.Union([Type.Literal("snapshot"), Type.Literal("boot")], {
			description:
				"`snapshot`: it started from the template's built snapshot. `boot`: none was ready, so it booted the template's " +
				"image and ran its setup itself (a custom image: the one its build made).",
		}),
	},
	{ title: "SandboxTemplate", description: "The template a sandbox was made from." },
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
		reason: Type.Optional(
			Type.String({
				description:
					"Why it is in `error` or `degraded`, in words; or why Kantel stopped or paused it: `auto-stop` when its " +
					"auto-stop time came, `idle-stop` when it went `idleStopMinutes` without use, or a rule's reason. A stop " +
					"someone asked for has none.",
			}),
		),
		placementReason: Type.Optional(PlacementReason),
		visibility: SandboxVisibility,
		capabilities: SandboxCapabilities,
		labels: Type.Record(Type.String(), Type.String(), { description: "The caller's own labels." }),
		autoStopMinutes: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
			description: "How long after a start or resume it stops by itself; `null` never.",
		}),
		stopsAt: Type.Optional(
			Type.Integer({ description: "When it will stop by itself, while running; the console's stops-in." }),
		),
		idleStopMinutes: Type.Optional(
			Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
				description:
					"How long it may go without use before it stops by itself (`idle-stop`), beside its auto-stop; `null` or " +
					"absent never. Use is a command (run, followed or killed), and traffic over SSH, the desktop or browser, " +
					"and its hosted ports. Stopping keeps its disk, as any stop does.",
			}),
		),
		lastActiveAt: Type.Optional(
			Type.Integer({
				description:
					"When it was last used, while running with an idle stop: its start, or its latest use, to within about 20 seconds.",
			}),
		),
		idleStopsAt: Type.Optional(
			Type.Integer({
				description:
					"When its idle stop will stop it if it isn't used before then, while running with one: `lastActiveAt` " +
					"plus `idleStopMinutes`. It stops within about 30 seconds after, once every gateway's record of use is in.",
			}),
		),
		latestSnapshotId: Type.Optional(Type.String({ description: "The snapshot a resume or fork would use." })),
		latestSnapshotAt: Type.Optional(
			Type.Integer({
				description:
					"When `latestSnapshotId` was taken (its `createdAt`), in milliseconds. Absent from a gateway before it, and where that snapshot's record is gone.",
			}),
		),
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
		template: Type.Optional(SandboxTemplate),
		grants: Type.Array(EgressGrant, { description: "Its own egress grants, on top of its environment's." }),
		mounts: Type.Optional(
			Type.Array(SandboxMount, {
				description: `Its read-only mounts, as its create named them, each with its status. Absent: none. ${MOUNTS_EXPERIMENTAL}`,
			}),
		),
		createdBy: CreatedBy,
		createdAt: Timestamp,
		startedAt: Type.Optional(Timestamp),
		stoppedAt: Type.Optional(Timestamp),
		cost: Cost,
		usage: UsageSummary,
		hostId: Type.Optional(Type.String({ description: "The host it runs on; only a super-admin is shown it." })),
		base: Type.Optional(SandboxBase),
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
		resources: Type.Optional(SandboxShapeInput),
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
		idleStopMinutes: Type.Optional(
			Type.Union([Type.Integer({ minimum: 1, maximum: 43200 }), Type.Null()], {
				description:
					"Stop it once it has gone this long without use (`idle-stop`), whatever its auto-stop says; with " +
					"`autoStopMinutes: null`, it runs while it is used. Default `null`: no idle stop. See the sandbox's " +
					"`idleStopMinutes` for what counts as use.",
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
		template: Type.Optional(
			Type.String({
				description:
					"Make a microVM from this template, a template's ID or name in the account (experimental, " +
					"`KANTEL_TEMPLATES`): from its newest built snapshot when one is ready, else by booting its image and running " +
					"its setup. A Dockerfile or image reference boots only once its current version's image is built (`unavailable` " +
					"until then), on the host that built it. Its variables go under the environment's and `env`, its grants with the sandbox's own, and with " +
					"`size` left out its resources are the machine's, exactly (`resources`), named by the smallest size with " +
					"them. Not with `from` or `image`. A template with setup needs a key with `exec` too: a host may boot it " +
					"fresh whatever its snapshot, running the setup with the sandbox's variables.",
			}),
		),
		hostLabels: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: 'Place it only on a host with each label, such as `{ site: "home" }`.',
			}),
		),
		mounts: Type.Optional(
			Type.Array(Mount, {
				maxItems: MAX_MOUNTS,
				description:
					`Files from outside the sandbox, read-only inside it: at most ${MAX_MOUNTS}, at paths that don't overlap. ` +
					"A bundle or bucket source it names must be the account's. microVMs only: an isolate is refused " +
					"(`not_supported`). A host that can't mount a source marks that mount `failed`, and the sandbox runs " +
					`without it. A fork keeps its source's mounts. ${MOUNTS_EXPERIMENTAL}`,
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
		idleStopMinutes: Type.Optional(
			Type.Union([Type.Integer({ minimum: 1, maximum: 43200 }), Type.Null()], {
				description: "Its idle stop; `null` turns it off. A running sandbox's idle time counts from now.",
			}),
		),
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
		measured: Type.Optional(
			Type.Boolean({
				description:
					"Whether any kept reading covers the interval: false where there is none (stopped, or older than the week kept), " +
					"and `cpu` and `memoryMb` are then 0 for want of a figure, not measured as 0. Absent from a gateway before it.",
			}),
		),
		diskUsedBytes: Type.Optional(
			Type.Integer({
				minimum: 0,
				description:
					"The sandbox's own disk in use, its mean over the interval; absent where its host doesn't send it.",
			}),
		),
		ioPressure: Type.Optional(
			Type.Number({
				minimum: 0,
				maximum: 1,
				description:
					"The share of the interval in which at least one of its tasks waited on IO, its mean; absent where its guest " +
					"has no pressure figures.",
			}),
		),
	},
	{
		title: "SandboxUsagePoint",
		description:
			"One interval's means. A sandbox keeps a day of 5-minute means and hourly ones for the six days before, so an " +
			"interval within the day can be as fine as 5 minutes, and one before it is an hour's mean at best.",
	},
);

export const SandboxSeriesPoint = Type.Object(
	{
		at: Timestamp,
		cpu: Type.Number({
			minimum: 0,
			maximum: 1,
			description: "CPU utilisation over the interval ending at `at`, 0 to 1 of the sandbox's own vCPUs.",
		}),
		memUsedBytes: Type.Integer({
			minimum: 0,
			description:
				"Memory in use at `at`. For a microVM, what its guest counts as used (total less available, page cache not " +
				"counted), so it falls when the guest frees memory; from a host or VM that can't report that, the memory " +
				"the VM holds on its host, which stays near its high point. For an isolate, its share of its account's runtime.",
		}),
		diskUsedBytes: Type.Optional(
			Type.Integer({
				minimum: 0,
				description:
					"A microVM's own disk in use at `at`, as its guest counts it (df's used). Absent for an isolate, and where the " +
					"host or the guest's agent doesn't send it.",
			}),
		),
		ioPressure: Type.Optional(
			Type.Number({
				minimum: 0,
				maximum: 1,
				description:
					"The share of the interval ending at `at` in which at least one of a microVM's tasks waited on IO (its " +
					"guest kernel's IO pressure, `some`). Absent where the guest has no pressure figures.",
			}),
		),
	},
	{ title: "SandboxSeriesPoint" },
);

export const SandboxUsageSeries = Type.Object(
	{
		intervalMs: Type.Integer({
			minimum: 1,
			description:
				"How far apart the points are: 5000 from a host that sends its readings, longer from one that doesn't yet.",
		}),
		points: Type.Array(SandboxSeriesPoint, {
			description: "Oldest first, at most the last hour; with `since`, only those after it.",
		}),
	},
	{
		title: "SandboxUsageSeries",
		description:
			"The sandbox's readings as they came, for a live graph: poll with `since` set to the last point's `at` for only " +
			"the newer ones.",
	},
);

export const SandboxUsage = Type.Object(
	{
		sandboxId: Type.String(),
		intervalSeconds: Type.Integer(),
		points: Type.Array(SandboxUsagePoint),
		totals: Type.Object({ runningSeconds: Type.Number(), cpuSeconds: Type.Number(), cost: Cost }),
		memLimitBytes: Type.Optional(
			Type.Integer({ minimum: 0, description: "The memory it may use, when its host reports it or its size sets it." }),
		),
		diskTotalBytes: Type.Optional(
			Type.Integer({
				minimum: 0,
				description: "Its own disk's size, as its guest counts it, when its host sends disk figures.",
			}),
		),
		series: SandboxUsageSeries,
	},
	{ title: "SandboxUsage" },
);

export const UsageQuery = Type.Object(
	{
		since: Type.Optional(
			Type.Integer({
				description:
					"From this time; default 24 hours ago. `series` then holds only the points after it, so a client polls with " +
					"the last point's `at`.",
			}),
		),
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
			Type.Integer({
				minimum: 1,
				maximum: 600_000,
				description:
					"Default 30 000; at most 600 000 (10 minutes). A detached command has no limit unless this gives one.",
			}),
		),
		detached: Type.Optional(
			Type.Boolean({
				description:
					"Start it and answer at once; it runs with no time limit unless `timeoutMs` gives one. Read it back by its ID.",
			}),
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
		stdout: Type.String({
			description:
				"Its output once it has ended, up to 1 MiB (a detached command's is empty while it runs); `truncated` says if there was more.",
		}),
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

export const FileUrlBody = Type.Object(
	{
		path: Type.String({
			minLength: 1,
			maxLength: 4096,
			description: "An absolute path, or one relative to the user's home.",
		}),
		ttlSeconds: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: MAX_FILE_URL_TTL_SECONDS,
				description: `How long the URL may be used: default ${DEFAULT_FILE_URL_TTL_SECONDS} (15 minutes), at most ${MAX_FILE_URL_TTL_SECONDS}.`,
			}),
		),
	},
	{ title: "FileUrlBody" },
);

export const FileUrl = Type.Object(
	{
		url: Type.String({
			description:
				"The signed URL. Send the request straight to it, with no `Authorization` header. Treat it as a secret until " +
				"it expires.",
		}),
		method: Type.Union([Type.Literal("GET"), Type.Literal("PUT")], {
			description: "`GET` downloads the file. `PUT` uploads the request's raw body as the file.",
		}),
		path: Type.String({ description: "The absolute path the URL is bound to." }),
		expiresAt: Timestamp,
	},
	{
		title: "FileUrl",
		description:
			"A short-lived URL for one file of one sandbox, streamed to or from the sandbox's host, so a file of any " +
			"size moves without base64.",
	},
);

export const ExtractArchiveQuery = Type.Object(
	{
		path: Type.String({
			minLength: 1,
			maxLength: 4096,
			description:
				"The directory to extract into, made if missing: absolute, or relative to the user's home. Not in or over a mount.",
		}),
	},
	{ title: "ExtractArchiveQuery" },
);

export const ExtractedArchive = Type.Object(
	{
		path: Type.String({ description: "The absolute directory it was extracted into." }),
		files: Type.Integer({ description: "Files written." }),
		directories: Type.Integer({ description: "Directories made." }),
		symlinks: Type.Integer({ description: "Symbolic links made." }),
		bytes: Type.Integer({ description: "Bytes of the files written." }),
	},
	{ title: "ExtractedArchive" },
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
		url: Type.String({
			description:
				"Watch and drive the sandbox's Chromium in a browser: the browser alone where `surface` is `browser`, else the " +
				"desktop it runs on.",
		}),
		embedUrl: Type.String({ description: "The same view, for an `<iframe>` in your own app." }),
		surface: Type.Union([Type.Literal("browser"), Type.Literal("desktop")], {
			description:
				"Experimental. What `url` shows: `browser`, the browser alone on a display of its own, sized to the viewer and " +
				"streamed only while someone watches; `desktop`, the sandbox's desktop with Chromium on it (an image without a " +
				"browser surface).",
		}),
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
		user: Type.Optional(
			Type.String({
				description:
					"The person whose device will open the session. Refused (`forbidden`) unless the call is that person's, so a browser whose sign-in may have changed under it (a cookie it can't read) never gets a URL for someone else's sign-in to use with its keys.",
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
		// The machine of the microVM it was taken of (a template's may differ from its size's): a sandbox made or forked
		// from it gets it, unless it asks for another size.
		size: Type.Optional(SandboxSizeName),
		resources: Type.Optional(SandboxResources),
		sizeBytes: Type.Optional(Type.Integer()),
		createdAt: Timestamp,
		expiresAt: Type.Optional(Timestamp),
		base: Type.Optional(SandboxBase),
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

export const ProxySettingsExpected = Type.Object(
	{
		enabled: Type.Boolean(),
		defaultAction: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
		allow: Type.Array(Type.String()),
		deny: Type.Array(Type.String()),
		upstream: Type.Optional(Type.Object({ url: Type.String(), headerNames: Type.Array(Type.String()) })),
		attribution: Type.Boolean(),
	},
	{
		title: "ProxySettingsExpected",
		description:
			"The settings as you last read them: `GET /proxy`'s answer will do. Given, the write is refused with `conflict` " +
			"if they have changed since, so an edit made from an older read can't undo someone else's: read them again and " +
			"redo the edit. Left out, the settings are replaced whatever they hold.",
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
		expected: Type.Optional(ProxySettingsExpected),
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

// Templates (experimental): how a platform defines a microVM, versioned, and the snapshots built from each version.

/** An image's digest: `sha256:` and 64 lower-case hex digits. */
export const IMAGE_DIGEST_PATTERN = "^sha256:[0-9a-f]{64}$";
/** A base image's channel, such as `stable`. */
export const TEMPLATE_CHANNEL_PATTERN = "^[a-z0-9][a-z0-9._-]{0,62}$";

/**
 * A Kantel base image's name: a repository path such as `kantel/sandbox`, with no registry, tag or digest. Hosts pull it
 * from their operator's registry (`templateRegistry`), by digest; an account never names where an image comes from.
 */
export const TEMPLATE_BASE_IMAGE_PATTERN = "^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$";

/**
 * An OCI image reference a template names (`{ kind: "image" }`): `[registry[:port]/]repository[:tag][@sha256:digest]`,
 * such as `python:3.13-slim`, `ghcr.io/acme/ci:1.8` or one pinned by digest. Only an isolated build microVM ever pulls
 * it, through the sandbox egress proxy: a registry on a host, private or metadata address is refused there, however it
 * is named.
 */
export const TEMPLATE_IMAGE_REF_PATTERN =
	"^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::[0-9]{1,5})?/)?" +
	"[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*" +
	"(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$";

const imageName = (description: string) =>
	Type.String({ minLength: 1, maxLength: 255, pattern: TEMPLATE_BASE_IMAGE_PATTERN, description });
const imageDigest = (description: string) => Type.String({ pattern: IMAGE_DIGEST_PATTERN, description });
const channelName = Type.String({ pattern: TEMPLATE_CHANNEL_PATTERN, description: "A channel, such as `stable`." });

export const TemplateImage = Type.Union(
	[
		Type.Object(
			{ kind: Type.Literal("kantel-base") },
			{
				title: "TemplateKantelBaseImage",
				description: "The template's `base` itself, as its deployment publishes it; the setup script adds the rest.",
			},
		),
		Type.Object(
			{
				kind: Type.Literal("dockerfile"),
				dockerfile: Type.String({
					minLength: 1,
					maxLength: 65_536,
					description:
						"A Dockerfile, built with no build context. `ARG KANTEL_BASE` then `FROM $KANTEL_BASE` starts from the " +
						"template's `base`; any other `FROM` image is pulled.",
				}),
			},
			{
				title: "TemplateDockerfileImage",
				description:
					"Built in an isolated build microVM whose only way out is the sandbox egress proxy: its pulls, `RUN` steps " +
					"and remote `ADD`s reach the template's egress grants and the registries the host's operator allows, and " +
					"never a host, private or metadata address.",
			},
		),
		Type.Object(
			{
				kind: Type.Literal("image"),
				ref: Type.String({
					minLength: 1,
					maxLength: 512,
					pattern: TEMPLATE_IMAGE_REF_PATTERN,
					description:
						"An image reference, such as `python:3.13-slim` or `ghcr.io/acme/ci@sha256:…`. A tag is resolved when the " +
						"template is built, and again on a rebuild.",
				}),
			},
			{
				title: "TemplateImageRef",
				description:
					"Pulled in an isolated build microVM, as a Dockerfile's images are. The template's `base` isn't used. An " +
					"image that isn't one of Kantel's boots through the guest agent the host injects.",
			},
		),
	],
	{
		title: "TemplateImage",
		description:
			"What a template's machines boot: `kantel-base`, Kantel's base image customised by the setup script; a " +
			"`dockerfile`; or an `image` reference. Custom images are built only on hosts that build them in a build " +
			"microVM. Default: `kantel-base`.",
	},
);

export const TemplateBase = Type.Union(
	[
		Type.Object(
			{ image: imageName("The base image, such as `kantel/sandbox`."), channel: channelName },
			{ title: "TemplateBaseChannelRef", description: "Follow a channel: rebuilt when it publishes a new digest." },
		),
		Type.Object(
			{ image: imageName("The base image, such as `kantel/sandbox`."), digest: imageDigest("The digest pinned.") },
			{
				title: "TemplateBasePinned",
				description: "Pin an exact digest, one its channels published: never rebuilt for a new release.",
			},
		),
	],
	{
		title: "TemplateBase",
		description:
			"The Kantel base image it boots: a channel the deployment publishes (`/v1/template-bases`), or a digest one " +
			"published. Default: `kantel/sandbox`'s `stable` channel; until that channel publishes a digest, each host's own " +
			"sandbox image.",
	},
);

export const TemplateResources = Type.Object(
	{
		vcpus: Type.Integer({ minimum: 1, maximum: 64 }),
		memoryMb: Type.Integer({ minimum: 128, maximum: 262_144 }),
	},
	{
		title: "TemplateResources",
		description:
			"Its sandboxes' and its builds' vCPUs and memory, exactly, unless a create names a size; a deployment must offer " +
			"a size with at least them. Default 2 vCPUs and 4096 MB.",
	},
);

export const TemplateNetwork = Type.Object(
	{ grants: Type.Array(EgressGrantInput, { maxItems: 200 }) },
	{ title: "TemplateNetwork", description: "Egress grants for its sandboxes and for its build's boot." },
);

export const TemplateSpec = Type.Object(
	{
		image: Type.Optional(TemplateImage),
		base: Type.Optional(TemplateBase),
		resources: Type.Optional(TemplateResources),
		env: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: "Plain variables, not secrets: under the environment's and the create's own.",
			}),
		),
		setup: Type.Optional(
			Type.String({
				maxLength: 65_536,
				description: "A shell script run once, as root, when the snapshot is built (or at a fresh boot).",
			}),
		),
		network: Type.Optional(TemplateNetwork),
	},
	{
		title: "TemplateSpec",
		description: "A template version's definition, never changed once made. Answered with every default filled in.",
	},
);

export const TemplateBuiltFrom = Type.Object(
	{
		baseImage: Type.String(),
		channel: Type.Optional(Type.String({ description: "The channel it followed; absent when pinned." })),
		baseDigest: Type.String({ description: "Empty while the channel has no published digest." }),
		pinned: Type.Boolean(),
		imageDigest: Type.Optional(
			Type.String({
				description:
					"The digest of the image its host booted, as the host reported it: for an `image`, the digest the reference " +
					"resolved to; for a `dockerfile`, the built image's ID.",
			}),
		),
		source: Type.Optional(
			Type.Union([Type.Literal("kantel-base"), Type.Literal("dockerfile"), Type.Literal("image")], {
				description: "The template image's kind it was built from. Absent: `kantel-base`.",
			}),
		),
		dockerfileDigest: Type.Optional(
			Type.String({ description: "For a `dockerfile`, the SHA-256 of the Dockerfile built, `sha256:…`." }),
		),
		imageRef: Type.Optional(Type.String({ description: "For an `image`, the reference pulled." })),
		kernel: Type.String(),
		firecracker: Type.String(),
	},
	{ title: "TemplateBuiltFrom", description: "What a template snapshot was built from." },
);

export const TemplateCacheKey = Type.Object(
	{
		templateVersion: Type.String({ description: "`<templateId>@<version>`." }),
		baseDigest: Type.String(),
		source: Type.Optional(
			Type.String({
				description:
					"A custom image's source: `dockerfile:sha256:…` (the Dockerfile's digest) or `image:<ref>`. Absent for " +
					"`kantel-base`.",
			}),
		),
		imageDigest: Type.Optional(
			Type.String({
				description:
					"A custom image's digest: the one an `image` pins from the start, else the one its build made or resolved, " +
					"recorded once the build answers. Absent for `kantel-base`.",
			}),
		),
		kernel: Type.String(),
		firecracker: Type.String(),
		vcpus: Type.Integer(),
		memoryMb: Type.Integer({
			description:
				"With `vcpus`, the machine it was built as: the template's resources, which a fresh boot from it gets too.",
		}),
	},
	{
		title: "TemplateCacheKey",
		description:
			"What a template snapshot is for: a change to any part builds another. A create starts from it only when it gets " +
			"the same vCPUs and memory.",
	},
);

export const TemplateSnapshotState = Type.Union(
	[
		Type.Literal("queued"),
		Type.Literal("building"),
		Type.Literal("ready"),
		Type.Literal("stale"),
		Type.Literal("failed"),
		Type.Literal("discarded"),
	],
	{
		title: "TemplateSnapshotState",
		description:
			"`stale`: built for a key no longer wanted, and used while its replacement builds only if it is of the template's " +
			"current version. `failed`: not tried again until its key changes or the template is rebuilt. `discarded`: " +
			"thrown away.",
	},
);

export const TemplateSnapshot = Type.Object(
	{
		id: id("The template snapshot's ID, `tsn_…`."),
		templateId: Type.String(),
		version: Type.Integer(),
		key: TemplateCacheKey,
		keyHash: Type.String({ description: "The SHA-256 hex of the key's canonical JSON." }),
		state: TemplateSnapshotState,
		hostId: Type.Optional(Type.String({ description: "The host it was built on, which holds it." })),
		builtFrom: TemplateBuiltFrom,
		startedAt: Timestamp,
		readyAt: Type.Optional(Timestamp),
		error: Type.Optional(Type.String({ description: "Why the build failed." })),
		sizeBytes: Type.Optional(Type.Integer()),
	},
	{
		title: "TemplateSnapshot",
		description:
			"A built template: its image booted once, its setup run, then snapshotted. A cache entry Kantel throws away and " +
			"rebuilds at will, never one of the account's snapshots.",
	},
);

export const TemplateBehind = Type.Object(
	{
		releases: Type.Integer({ description: "How many digests the base's channel has published since the pinned one." }),
		since: Timestamp,
		latestDigest: Type.String(),
	},
	{ title: "TemplateBehind", description: "How far a pinned base is behind its channel." },
);

export const TemplateBuildStatus = Type.Object(
	{
		state: Type.Union(
			[
				Type.Literal("none"),
				Type.Literal("building"),
				Type.Literal("ready"),
				Type.Literal("stale"),
				Type.Literal("failed"),
			],
			{
				description:
					"`none`: nothing built yet; sandboxes boot fresh. `stale`: what is built is for an older key, and used until " +
					"its replacement is ready if it is of the template's current version. A `ready` snapshot of an older version " +
					"starts no sandbox: they boot fresh until the current version's is ready. A template with a Dockerfile or " +
					"image reference doesn't boot fresh before its current version's image is built: its sandboxes wait for that " +
					"build (`unavailable` until then).",
			},
		),
		ready: Type.Optional(TemplateSnapshot),
		building: Type.Optional(TemplateSnapshot),
		error: Type.Optional(Type.String()),
		behind: Type.Optional(TemplateBehind),
	},
	{ title: "TemplateBuildStatus" },
);

export const Template = Type.Object(
	{
		id: id("The template's ID, such as `tpl_4kq9x2mt`."),
		accountId: Type.String(),
		name: Type.String(),
		description: Type.Optional(Type.String()),
		version: Type.Integer({ description: "Its current version; a new spec makes the next." }),
		spec: TemplateSpec,
		build: TemplateBuildStatus,
		sandboxCount: Type.Integer({ description: "How many sandboxes were made from it and still exist." }),
		createdAt: Timestamp,
		updatedAt: Timestamp,
		createdBy: CreatedBy,
	},
	{
		title: "Template",
		description: "A microVM profile: image, base, resources, variables, setup and egress, versioned.",
	},
);

export const TemplateVersion = Type.Object(
	{ version: Type.Integer(), spec: TemplateSpec, createdAt: Timestamp, createdBy: CreatedBy },
	{ title: "TemplateVersion" },
);

export const TemplateList = Type.Object({ items: Type.Array(Template) }, { title: "TemplateList" });
export const TemplateVersionList = Type.Object(
	{ items: Type.Array(TemplateVersion, { description: "Newest first." }) },
	{ title: "TemplateVersionList" },
);
export const TemplateSnapshotList = Type.Object(
	{ items: Type.Array(TemplateSnapshot, { description: "Newest first." }) },
	{ title: "TemplateSnapshotList" },
);

export const TemplateBaseChannel = Type.Object(
	{
		image: Type.String(),
		channel: Type.String(),
		digest: Type.String({ description: "The digest it publishes now." }),
		publishedAt: Timestamp,
		history: Type.Array(
			Type.Object({ digest: Type.String(), publishedAt: Timestamp }, { title: "TemplateBaseRelease" }),
			{ description: "Every digest it has published, newest first." },
		),
	},
	{ title: "TemplateBaseChannel", description: "A base image's channel and the digests it has published." },
);

export const TemplateBaseList = Type.Object({ items: Type.Array(TemplateBaseChannel) }, { title: "TemplateBaseList" });

export const CreateTemplateBody = Type.Object(
	{
		account: accountQuery,
		name: Type.String({
			pattern: ENVIRONMENT_NAME_PATTERN,
			description: "Unique in the account: lower-case letters, digits and dashes, at most 63.",
		}),
		description: Type.Optional(Type.String({ maxLength: 500 })),
		spec: TemplateSpec,
	},
	{ title: "CreateTemplateBody" },
);

export const UpdateTemplateBody = Type.Object(
	{
		name: Type.Optional(Type.String({ pattern: ENVIRONMENT_NAME_PATTERN })),
		description: Type.Optional(Type.String({ maxLength: 500, description: "Empty clears it." })),
		spec: Type.Optional(TemplateSpec),
	},
	{ title: "UpdateTemplateBody", description: "A `spec` that differs from the current one makes a new version." },
);

export const PublishTemplateBaseBody = Type.Object(
	{
		image: imageName("The base image, such as `kantel/sandbox`."),
		channel: channelName,
		digest: imageDigest("The digest the channel publishes from now."),
	},
	{ title: "PublishTemplateBaseBody" },
);

export const ListTemplatesQuery = Type.Object(
	{
		account: accountQuery,
		baseDigest: Type.Optional(
			Type.String({ description: "Only those with a snapshot built from this base digest, or pinned to it." }),
		),
	},
	{ title: "ListTemplatesQuery" },
);

export const TemplatePath = Type.Object({ templateId: id("The template's ID.") }, { title: "TemplatePath" });

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
			"or recovery. `sandbox.stopped`, `sandbox.paused`: it stopped (by a call, its auto-stop or its idle stop), or paused. " +
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
				placementReason: Type.Optional(PlacementReason),
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

export const LiveHello = Type.Object(
	{ type: Type.Literal("hello"), at: Timestamp },
	{
		title: "LiveHello",
		description:
			"The stream is open. Read what you show again after each one: changes made while no stream was open (before the " +
			"first, between a drop and the reconnection) are not sent.",
	},
);

export const LiveSandboxChange = Type.Object(
	{
		type: Type.Literal("sandbox"),
		sandboxId: Type.String(),
		accountId: Type.String(),
		state: SandboxState,
		previousState: Type.Optional(SandboxState),
		at: Timestamp,
	},
	{
		title: "LiveSandboxChange",
		description:
			"A sandbox moved to `state`, whoever moved it (a call from the console, the CLI, the API or an SDK, its auto-stop, " +
			"its host). No `previousState`: it was just made. Read the sandbox for the rest.",
	},
);

export const LiveFrame = Type.Union([LiveHello, LiveSandboxChange], {
	title: "LiveFrame",
	description: "One frame of the account's live stream.",
});

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
			"Where an account's telemetry goes: sandbox metrics (`kantel.sandbox.cpu`, `kantel.sandbox.memory_bytes` and " +
			"`kantel.sandbox.running_seconds`) every 60 seconds, and each lifecycle event as an OTLP log record when it happens.",
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
		usage: Type.Optional(UsageSparklines),
	},
	{
		title: "Host",
		description: "A machine that runs sandboxes. It dials out to the control plane; it takes no inbound ports.",
	},
);

export const HostList = Type.Object({ items: Type.Array(Host) }, { title: "HostList" });

export const HostPath = Type.Object({ hostId: id("The host's ID.") }, { title: "HostPath" });

export const HostUsagePoint = Type.Object(
	{
		at: Timestamp,
		cpu: Type.Number({
			minimum: 0,
			maximum: 1,
			description: "CPU utilisation over the interval ending at `at`, 0 to 1 of all the host's CPUs.",
		}),
		memUsedBytes: Type.Integer({ minimum: 0 }),
		diskUsedBytes: Type.Integer({ minimum: 0 }),
	},
	{ title: "HostUsagePoint" },
);

export const HostUsage = Type.Object(
	{
		hostId: Type.String(),
		intervalMs: Type.Integer({ minimum: 1, description: "How far apart the points are: 5000 from a current host." }),
		memTotalBytes: Type.Integer({ minimum: 0, description: "0 until the host has sent a reading." }),
		diskTotalBytes: Type.Integer({ minimum: 0, description: "0 until the host has sent a reading." }),
		points: Type.Array(HostUsagePoint, {
			description:
				"Oldest first, at most the last hour; with `since`, only those after it. Empty for a host that doesn't send " +
				"its readings yet (an older kantel-host).",
		}),
	},
	{
		title: "HostUsage",
		description:
			"A host's readings as they came, for a live graph: poll with `since` set to the last point's `at` for only the " +
			"newer ones.",
	},
);

export const HostUsageQuery = Type.Object(
	{
		since: Type.Optional(Type.Integer({ description: "Only the points after this time (epoch milliseconds)." })),
	},
	{ title: "HostUsageQuery" },
);

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

// Bundles and bucket sources: what mounts are made from (experimental, behind the deployment's KANTEL_MOUNTS switch).

export const Bundle = Type.Object(
	{
		digest: Type.String({ description: "`sha256:` and the hex SHA-256 of the tar: the bundle's name and its ID." }),
		accountId: Type.String(),
		sizeBytes: Type.Integer({ description: "The tar's size." }),
		mountedBy: Type.Integer({ description: "How many of the account's sandboxes that still exist mount it." }),
		createdAt: Timestamp,
	},
	{
		title: "Bundle",
		description:
			"A tar of files uploaded to an account once, named by its digest, which sandboxes mount read-only. It never " +
			"changes: other files are another bundle.",
	},
);

export const BundleList = Type.Object({ items: Type.Array(Bundle) }, { title: "BundleList" });

export const BundlePath = Type.Object(
	{ digest: Type.String({ pattern: BUNDLE_DIGEST_PATTERN, description: "The bundle's digest, `sha256:<hex>`." }) },
	{ title: "BundlePath" },
);

export const UploadBundleQuery = Type.Object(
	{
		account: accountQuery,
		digest: Type.Optional(
			Type.String({
				pattern: BUNDLE_DIGEST_PATTERN,
				description: "The digest the tar should have: an upload whose bytes don't match is refused (`invalid`).",
			}),
		),
	},
	{ title: "UploadBundleQuery" },
);

export const BucketProvider = Type.Union([Type.Literal("s3"), Type.Literal("gcs")], {
	title: "BucketProvider",
	description: "`s3`: Amazon S3 or an S3-compatible store (with `endpoint`). `gcs`: Google Cloud Storage.",
});

export const BucketCredentials = Type.Union(
	[
		Type.Object(
			{
				accessKeyId: Type.String({ minLength: 1, maxLength: 256 }),
				secretAccessKey: Type.String({ minLength: 1, maxLength: 1024 }),
				sessionToken: Type.Optional(Type.String({ maxLength: 8192 })),
			},
			{ title: "BucketAccessKey", description: "An S3 access key, or a GCS HMAC key." },
		),
		Type.Object(
			{
				serviceAccountKey: Type.String({
					minLength: 2,
					maxLength: 16384,
					description: "A GCS service account's JSON key, as Google gives it.",
				}),
			},
			{ title: "BucketServiceAccountKey" },
		),
	],
	{
		title: "BucketCredentials",
		description:
			"Write-only: kept encrypted, given only to the host of a sandbox that mounts the bucket, never answered.",
	},
);

const bucketFields = {
	name: Type.String({ minLength: 1, maxLength: 100, description: "A name for people, such as `org files`." }),
	provider: BucketProvider,
	bucket: Type.String({ minLength: 1, maxLength: 255, description: "The bucket's name." }),
	endpoint: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 2048,
			description: "An S3-compatible store's HTTPS endpoint, such as `https://<account>.r2.cloudflarestorage.com`.",
		}),
	),
	region: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Such as `eu-west-1`." })),
};

export const BucketSource = Type.Object(
	{
		id: id("The bucket source's ID, such as `bks_4kq9x2mt`."),
		accountId: Type.String(),
		...bucketFields,
		hasCredentials: Type.Boolean({ description: "Whether it was given credentials; they are never answered." }),
		mountedBy: Type.Integer({ description: "How many of the account's sandboxes that still exist mount it." }),
		createdAt: Timestamp,
	},
	{
		title: "BucketSource",
		description:
			"A bucket an account's sandboxes may mount prefixes of, with the credentials that read it. The credentials " +
			"are write-only.",
	},
);

export const BucketSourceList = Type.Object({ items: Type.Array(BucketSource) }, { title: "BucketSourceList" });

export const BucketSourcePath = Type.Object(
	{ bucketSourceId: id("The bucket source's ID.") },
	{ title: "BucketSourcePath" },
);

export const CreateBucketSourceBody = Type.Object(
	{
		account: accountQuery,
		...bucketFields,
		// What reads the bucket; absent for a public one. Needs the deployment's secrets key (`not_supported` without).
		credentials: Type.Optional(BucketCredentials),
	},
	{ title: "CreateBucketSourceBody" },
);

// Where hosts reach the control plane: the address in every join command.

export const PublicUrl = Type.Object(
	{
		publicUrl: Type.String({
			description:
				"Where hosts reach this control plane: the address in every join command, such as `https://kantel.example.com`.",
		}),
		source: Type.Union([Type.Literal("console"), Type.Literal("deployment")], {
			description:
				"`console`: a super-admin set it here. `deployment`: the deployment's own (`KANTEL_PUBLIC_URL`, or the address the call came in at).",
		}),
		deploymentUrl: Type.String({ description: "The deployment's own, which `publicUrl` goes back to when cleared." }),
		loopback: Type.Boolean({
			description:
				"`publicUrl` is a loopback address (`127.0.0.1`, `localhost`): only a host on the same machine can join.",
		}),
	},
	{ title: "PublicUrl" },
);

export const SetPublicUrlBody = Type.Object(
	{
		publicUrl: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()], {
			description: "An http(s) origin, such as `https://kantel.example.com`; `null` goes back to the deployment's own.",
		}),
	},
	{ title: "SetPublicUrlBody" },
);

// Base images, for the super-admin (experimental, behind the deployment's KANTEL_IMAGE_PATCHING switch).

const isoTime = (description: string) => Type.String({ description: `${description}, ISO 8601.` });

export const BaseImageFinding = Type.Object(
	{
		id: Type.String({ description: "`CVE-2026-1234`, or the scanner's own ID where there is no CVE." }),
		severity: Type.Union(
			[
				Type.Literal("critical"),
				Type.Literal("high"),
				Type.Literal("medium"),
				Type.Literal("low"),
				Type.Literal("unknown"),
			],
			{ title: "ScanSeverity" },
		),
		package: Type.String({ description: "The package it is in, such as `openssl`." }),
		installed: Type.String({ description: "The package's version in the image." }),
		fixed: Type.Optional(Type.String({ description: "The version that fixes it, where one is out." })),
		title: Type.Optional(Type.String()),
	},
	{ title: "BaseImageFinding", description: "One vulnerability a scan found in an image." },
);

const severityCount = (description: string) => Type.Integer({ minimum: 0, description });

export const BaseImageScan = Type.Object(
	{
		scanner: Type.String({ description: "What scanned it, such as `trivy 0.68.1`." }),
		scannedAt: isoTime("When"),
		counts: Type.Object(
			{
				critical: severityCount("Critical findings."),
				high: severityCount("High findings."),
				medium: severityCount("Medium findings."),
				low: severityCount("Low findings."),
				unknown: severityCount("Findings of no known severity."),
			},
			{ title: "BaseImageScanCounts", description: "Every finding, by severity." },
		),
		fixable: Type.Object(
			{
				critical: severityCount("Critical findings with a fix out."),
				high: severityCount("High findings with a fix out."),
			},
			{
				title: "BaseImageScanFixable",
				description: "Critical and High findings with a fix out: what makes Kantel rebuild the image at once.",
			},
		),
		findings: Type.Array(BaseImageFinding, {
			description: "The Critical and High findings, most severe first, at most 50.",
		}),
	},
	{ title: "BaseImageScan", description: "What the newest CVE scan of a version found." },
);

export const BaseImageVersion = Type.Object(
	{
		version: Type.String({ description: "Its tag, such as `2026.11.04.1`." }),
		digest: Type.String({ description: "`sha256:…`: the digest it is pulled by. A version's digest never changes." }),
		builtAt: isoTime("When it was built"),
		signed: Type.Boolean({ description: "Signed with cosign, keyless, by Kantel's build." }),
		reason: Type.Optional(
			Type.Union([Type.Literal("daily"), Type.Literal("cve"), Type.Literal("manual"), Type.Literal("push")], {
				description: "Why it was built: the daily build, a fixable Critical or High finding, by hand, or a change.",
			}),
		),
		scan: Type.Optional(BaseImageScan),
	},
	{ title: "BaseImageVersion", description: "One build of a base image." },
);

export const BaseImage = Type.Object(
	{
		name: Type.String({
			description: "`sandbox`, `browser`, `isolate-host`, or `host` for the microVM host images.",
		}),
		repository: Type.String({
			description: "Where it is pulled from, such as `ghcr.io/lleverage-ai/kantel-sandbox`; for `host`, the release's.",
		}),
		channel: Type.Literal("stable", { description: "The channel `latest` is of." }),
		latest: Type.Optional(BaseImageVersion),
		versions: Type.Array(BaseImageVersion, { description: "Its newest versions, newest first, at most 10." }),
	},
	{ title: "BaseImage" },
);

export const BaseImageTemplate = Type.Object(
	{
		id: Type.String(),
		name: Type.String(),
		image: Type.String({ description: "The base image it is built on." }),
		channel: Type.Optional(Type.String({ description: "The channel it follows, such as `stable`." })),
		pinned: Type.Optional(
			Type.String({ description: "The digest it is pinned to, when it doesn't follow a channel." }),
		),
		base: SandboxBase,
		rebuilding: Type.Boolean({ description: "Whether it is being rebuilt on the latest base now." }),
	},
	{ title: "BaseImageTemplate", description: "A template and the base it is built on." },
);

export const BaseImageList = Type.Object(
	{
		images: Type.Array(BaseImage),
		templates: Type.Array(BaseImageTemplate, {
			description: "Templates and their bases; empty until templates exist.",
		}),
		indexUrl: Type.String({
			description: "Where the deployment reads the base image index (`KANTEL_BASE_IMAGE_INDEX`).",
		}),
		generatedAt: Type.Optional(isoTime("When the index was last written")),
		error: Type.Optional(
			Type.String({ description: "Why the index couldn't be read; `images` is empty then. It is tried again soon." }),
		),
	},
	{
		title: "BaseImageList",
		description:
			"Kantel's base images as the index CI publishes them: each image's latest version, its newest versions and what " +
			"their CVE scans found.",
	},
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
export type SandboxNotRunningCode = Static<typeof SandboxNotRunningCode>;
export type SandboxNotRunning = Static<typeof SandboxNotRunning>;
export type SandboxVisibility = Static<typeof SandboxVisibility>;
export type SandboxSizeName = Static<typeof SandboxSizeName>;
export type SandboxShapeInput = Static<typeof SandboxShapeInput>;
export type SandboxShapes = Static<typeof SandboxShapes>;
export type ShapePreset = Static<typeof ShapePreset>;
export type SandboxCapabilities = Static<typeof SandboxCapabilities>;
export type GuestCapabilities = Static<typeof GuestCapabilities>;
export type GuestFeature = Static<typeof GuestFeature>;
export type Sandbox = Static<typeof Sandbox>;
export type CreateSandboxBody = Static<typeof CreateSandboxBody>;
export type BundleMountSource = Static<typeof BundleMountSource>;
export type BucketMountSource = Static<typeof BucketMountSource>;
export type MountSource = Static<typeof MountSource>;
export type Mount = Static<typeof Mount>;
export type MountStatus = Static<typeof MountStatus>;
export type SandboxMount = Static<typeof SandboxMount>;
export type Bundle = Static<typeof Bundle>;
export type BucketProvider = Static<typeof BucketProvider>;
export type BucketCredentials = Static<typeof BucketCredentials>;
export type BucketSource = Static<typeof BucketSource>;
export type CreateBucketSourceBody = Static<typeof CreateBucketSourceBody>;
export type FileUrl = Static<typeof FileUrl>;
export type ExtractedArchive = Static<typeof ExtractedArchive>;
export type Command = Static<typeof Command>;
export type FileEntry = Static<typeof FileEntry>;
export type ExposedPort = Static<typeof ExposedPort>;
export type Snapshot = Static<typeof Snapshot>;
export type SnapshotKind = Static<typeof SnapshotKind>;
export type ApiKeyScope = Static<typeof ApiKeyScope>;
export type ApiKeyPreset = Static<typeof ApiKeyPreset>;
export type ApiKey = Static<typeof ApiKey>;
export type ProxySettings = Static<typeof ProxySettings>;
export type ProxySettingsExpected = Static<typeof ProxySettingsExpected>;
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
export type SandboxTemplate = Static<typeof SandboxTemplate>;
export type TemplateImage = Static<typeof TemplateImage>;
export type TemplateBase = Static<typeof TemplateBase>;
export type TemplateResources = Static<typeof TemplateResources>;
export type TemplateNetwork = Static<typeof TemplateNetwork>;
export type TemplateSpec = Static<typeof TemplateSpec>;
export type TemplateBuiltFrom = Static<typeof TemplateBuiltFrom>;
export type TemplateCacheKey = Static<typeof TemplateCacheKey>;
export type TemplateSnapshotState = Static<typeof TemplateSnapshotState>;
export type TemplateSnapshot = Static<typeof TemplateSnapshot>;
export type TemplateBehind = Static<typeof TemplateBehind>;
export type TemplateBuildStatus = Static<typeof TemplateBuildStatus>;
export type Template = Static<typeof Template>;
export type TemplateVersion = Static<typeof TemplateVersion>;
export type TemplateBaseChannel = Static<typeof TemplateBaseChannel>;
export type CreateTemplateBody = Static<typeof CreateTemplateBody>;
export type UpdateTemplateBody = Static<typeof UpdateTemplateBody>;
export type PublishTemplateBaseBody = Static<typeof PublishTemplateBaseBody>;
export type EventType = Static<typeof EventType>;
export type Event = Static<typeof Event>;
export type LiveFrame = Static<typeof LiveFrame>;
export type LiveSandboxChange = Static<typeof LiveSandboxChange>;
export type Webhook = Static<typeof Webhook>;
export type WebhookDelivery = Static<typeof WebhookDelivery>;
export type TelemetryExport = Static<typeof TelemetryExport>;
export type Host = Static<typeof Host>;
export type HostUsage = Static<typeof HostUsage>;
export type HostUsagePoint = Static<typeof HostUsagePoint>;
export type SandboxUsage = Static<typeof SandboxUsage>;
export type SandboxUsagePoint = Static<typeof SandboxUsagePoint>;
export type SandboxSeriesPoint = Static<typeof SandboxSeriesPoint>;
export type UsageSparklines = Static<typeof UsageSparklines>;
export type HostState = Static<typeof HostState>;
export type HostJoinToken = Static<typeof HostJoinToken>;
export type PublicUrl = Static<typeof PublicUrl>;
export type AccountJoinToken = Static<typeof AccountJoinToken>;
export type DeviceLogin = Static<typeof DeviceLogin>;
export type DeviceLoginState = Static<typeof DeviceLoginState>;
export type DeviceLoginResult = Static<typeof DeviceLoginResult>;
export type DeviceLoginRequest = Static<typeof DeviceLoginRequest>;
export type SandboxBase = Static<typeof SandboxBase>;
export type BaseImageVersion = Static<typeof BaseImageVersion>;
export type BaseImage = Static<typeof BaseImage>;
export type BaseImageTemplate = Static<typeof BaseImageTemplate>;
export type BaseImageList = Static<typeof BaseImageList>;

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
