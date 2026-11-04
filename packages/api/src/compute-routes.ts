/**
 * The compute plane's routes: sandboxes (isolates and microVMs) behind one API, with their commands, files, ports,
 * desktop, browser and SSH, their snapshots, and the accounts, scoped API keys, proxy, environments, webhooks,
 * OpenTelemetry export and hosts around them. A self-hosted gateway always serves them.
 *
 * Every route but a device sign-in's start and poll (`public`) takes a bearer: a scoped API key (`ksk_…`), or a person's
 * sign-in. A key acts in its own account; a person
 * acts in their personal account unless a route's `account` names an organisation they belong to. Each route names the
 * scope a key needs in its description, and a key without it is `forbidden`.
 */
import {
	Account,
	AccountJoinToken,
	AccountList,
	AccountPath,
	AccountScopedQuery,
	AccountUsage,
	ApiKey,
	ApiKeyList,
	ApiKeyPath,
	ApproveDeviceLoginBody,
	BrowserAccess,
	Caller,
	Command,
	CommandPage,
	CommandPath,
	CreateAccountJoinTokenBody,
	CreateApiKeyBody,
	CreateEnvironmentBody,
	CreateHostJoinTokenBody,
	CreateInviteBody,
	CreateOrganisationBody,
	CreateSandboxBody,
	CreateWebhookBody,
	DesktopAccess,
	DeviceLogin,
	DeviceLoginPath,
	DeviceLoginRequest,
	DeviceLoginResult,
	Environment,
	EnvironmentFileQuery,
	EnvironmentList,
	EnvironmentPath,
	EnvironmentVariablePath,
	EventPage,
	ExposedPort,
	ExposedPortList,
	ExposePortBody,
	FileContent,
	FileEntry,
	FileList,
	FilePathQuery,
	ForkedSandboxes,
	ForkSandboxBody,
	Host,
	HostJoinToken,
	HostList,
	HostPath,
	Invite,
	InviteList,
	InvitePath,
	IssuedApiKey,
	JoinOrganisationBody,
	ListEventsQuery,
	ListFilesQuery,
	ListSandboxesQuery,
	ListSnapshotsQuery,
	Member,
	MemberList,
	MemberPath,
	PageQueryCompute,
	PollDeviceLoginBody,
	PortPath,
	ProxySettings,
	PutEgressGrantsBody,
	PutEnvironmentReposBody,
	PutProxySettingsBody,
	PutTelemetryBody,
	ReadFileQuery,
	ReadSnapshotFileQuery,
	ResumeSandboxBody,
	RunCommandBody,
	Sandbox,
	SandboxEgress,
	SandboxEgressQuery,
	SandboxPage,
	SandboxPath,
	SandboxUsage,
	SaveSnapshotBody,
	SetEnvironmentFileBody,
	SetEnvironmentVariableBody,
	Snapshot,
	SnapshotFilesQuery,
	SnapshotPage,
	SnapshotPath,
	SshAccess,
	SshAccessBody,
	StartDeviceLoginBody,
	StopSandboxBody,
	TakeSnapshotBody,
	TelemetryExport,
	TelemetryTest,
	UpdateAccountBody,
	UpdateEnvironmentBody,
	UpdateHostBody,
	UpdateMemberBody,
	UpdateSandboxBody,
	UpdateWebhookBody,
	UsageQuery,
	ViewAccessBody,
	Webhook,
	WebhookDelivery,
	WebhookDeliveryPage,
	WebhookList,
	WebhookPath,
	WebhookWithSecret,
	WriteFileBody,
} from "./compute-schema.ts";
import { defineRoute } from "./route.ts";

const scope = (needed: string) => `A key needs \`${needed}\`.`;
const describe = (...parts: string[]) => parts.join(" ");
const readErrors = ["invalid", "forbidden", "not_found"] as const;
const changeErrors = ["invalid", "forbidden", "not_found", "conflict"] as const;
const lifecycleErrors = ["invalid", "forbidden", "not_found", "conflict", "not_supported", "unavailable"] as const;

// Who is calling, accounts and organisations.

export const getCaller = defineRoute({
	operationId: "getCaller",
	method: "GET",
	path: "/whoami",
	tag: "accounts",
	summary: "Who is calling",
	description: describe(
		"The person or key calling, the accounts they may act in (their personal account first), and the deployment's",
		"mode. Any key may call it.",
	),
	answer: { status: 200, description: "The caller.", schema: Caller },
	errors: [],
});

export const listAccounts = defineRoute({
	operationId: "listAccounts",
	method: "GET",
	path: "/accounts",
	tag: "accounts",
	summary: "List accounts",
	description: describe(
		"The caller's personal account and every organisation they belong to; for a key, its own account.",
		scope("account:read"),
	),
	answer: { status: 200, description: "The accounts.", schema: AccountList },
	errors: ["forbidden"],
});

export const createOrganisation = defineRoute({
	operationId: "createOrganisation",
	method: "POST",
	path: "/accounts",
	tag: "accounts",
	summary: "Create an organisation",
	description: describe("Makes an organisation account with the caller as its owner. People only: a key is refused."),
	body: CreateOrganisationBody,
	answer: { status: 201, description: "The organisation.", schema: Account },
	errors: ["invalid", "forbidden", "exhausted"],
});

export const getAccount = defineRoute({
	operationId: "getAccount",
	method: "GET",
	path: "/accounts/{accountId}",
	tag: "accounts",
	summary: "Get an account",
	description: describe(scope("account:read")),
	params: AccountPath,
	answer: { status: 200, description: "The account.", schema: Account },
	errors: readErrors,
});

export const updateAccount = defineRoute({
	operationId: "updateAccount",
	method: "PATCH",
	path: "/accounts/{accountId}",
	tag: "accounts",
	summary: "Change an account",
	description: describe("Renames it or sets new sandboxes' default visibility; needs admin.", scope("account:admin")),
	params: AccountPath,
	body: UpdateAccountBody,
	answer: { status: 200, description: "The account.", schema: Account },
	errors: changeErrors,
});

export const deleteOrganisation = defineRoute({
	operationId: "deleteOrganisation",
	method: "DELETE",
	path: "/accounts/{accountId}",
	tag: "accounts",
	summary: "Delete an organisation",
	description: describe(
		"Deletes an organisation with no sandboxes or saved snapshots left (`conflict` otherwise); needs its owner.",
		"A personal account can't be deleted here. People only.",
	),
	params: AccountPath,
	answer: { status: 204, description: "Deleted." },
	errors: changeErrors,
});

export const getAccountUsage = defineRoute({
	operationId: "getAccountUsage",
	method: "GET",
	path: "/accounts/{accountId}/usage",
	tag: "accounts",
	summary: "Get an account's usage",
	description: describe("Running time and cost since `since`, and the account's limits.", scope("account:read")),
	params: AccountPath,
	query: UsageQuery,
	answer: { status: 200, description: "The usage.", schema: AccountUsage },
	errors: readErrors,
});

export const listMembers = defineRoute({
	operationId: "listMembers",
	method: "GET",
	path: "/accounts/{accountId}/members",
	tag: "accounts",
	summary: "List an organisation's members",
	description: describe(scope("account:read")),
	params: AccountPath,
	answer: { status: 200, description: "The members.", schema: MemberList },
	errors: readErrors,
});

export const updateMember = defineRoute({
	operationId: "updateMember",
	method: "PATCH",
	path: "/accounts/{accountId}/members/{userId}",
	tag: "accounts",
	summary: "Change a member's role",
	description: describe(
		"Needs admin; only an owner makes or unmakes an owner, and the last owner stays.",
		scope("account:admin"),
	),
	params: MemberPath,
	body: UpdateMemberBody,
	answer: { status: 200, description: "The member.", schema: Member },
	errors: changeErrors,
});

export const removeMember = defineRoute({
	operationId: "removeMember",
	method: "DELETE",
	path: "/accounts/{accountId}/members/{userId}",
	tag: "accounts",
	summary: "Remove a member",
	description: describe(
		"Removes a member, or lets a member leave. Their private sandboxes in the organisation stay, stopped, for an",
		"admin to delete or share. The last owner can't leave.",
		scope("account:admin"),
	),
	params: MemberPath,
	answer: { status: 204, description: "Removed." },
	errors: changeErrors,
});

export const listInvites = defineRoute({
	operationId: "listInvites",
	method: "GET",
	path: "/accounts/{accountId}/invites",
	tag: "accounts",
	summary: "List an organisation's open invites",
	description: describe("Codes are not shown again.", scope("account:admin")),
	params: AccountPath,
	answer: { status: 200, description: "The invites.", schema: InviteList },
	errors: readErrors,
});

export const createInvite = defineRoute({
	operationId: "createInvite",
	method: "POST",
	path: "/accounts/{accountId}/invites",
	tag: "accounts",
	summary: "Invite someone to an organisation",
	description: describe(
		"Makes a join code, shown once, for one person or for anyone holding it; needs admin.",
		scope("account:admin"),
	),
	params: AccountPath,
	body: CreateInviteBody,
	answer: { status: 201, description: "The invite, with its code.", schema: Invite },
	errors: changeErrors,
});

export const revokeInvite = defineRoute({
	operationId: "revokeInvite",
	method: "DELETE",
	path: "/accounts/{accountId}/invites/{inviteId}",
	tag: "accounts",
	summary: "Revoke an invite",
	description: describe(scope("account:admin")),
	params: InvitePath,
	answer: { status: 204, description: "Revoked." },
	errors: readErrors,
});

export const joinOrganisation = defineRoute({
	operationId: "joinOrganisation",
	method: "POST",
	path: "/accounts/join",
	tag: "accounts",
	summary: "Join an organisation",
	description: describe(
		"Joins the organisation an invite's code is for, with the invite's role. People only. An expired or used code is",
		"`expired`.",
	),
	body: JoinOrganisationBody,
	answer: { status: 200, description: "The organisation joined.", schema: Account },
	errors: ["invalid", "forbidden", "not_found", "expired", "conflict"],
});

export const accountRoutes = {
	getCaller,
	listAccounts,
	createOrganisation,
	joinOrganisation,
	getAccount,
	updateAccount,
	deleteOrganisation,
	getAccountUsage,
	listMembers,
	updateMember,
	removeMember,
	listInvites,
	createInvite,
	revokeInvite,
} as const;

// Sandboxes.

export const listSandboxes = defineRoute({
	operationId: "listSandboxes",
	method: "GET",
	path: "/sandboxes",
	tag: "sandboxes",
	summary: "List sandboxes",
	description: describe(
		"The account's sandboxes the caller may see, newest first: by default the ones starting, running or stopping;",
		"`all` adds stopped, paused and errored ones. Deleted ones are left out.",
		scope("sandboxes:read"),
	),
	query: ListSandboxesQuery,
	answer: { status: 200, description: "A page of sandboxes.", schema: SandboxPage },
	errors: ["invalid", "forbidden"],
});

export const createSandbox = defineRoute({
	operationId: "createSandbox",
	method: "POST",
	path: "/sandboxes",
	tag: "sandboxes",
	summary: "Create a sandbox",
	description: describe(
		"Makes a sandbox and starts it: an isolate unless `type` says `microvm`, from a snapshot when `from` names one.",
		"Answers as soon as it is placed (`starting`), or once it runs with `wait`. A full deployment is `exhausted`; no",
		"host able to run the type is `unavailable`.",
		scope("sandboxes:write"),
	),
	body: CreateSandboxBody,
	idempotent: true,
	answer: { status: 201, description: "The sandbox.", schema: Sandbox },
	errors: ["invalid", "forbidden", "not_found", "conflict", "exhausted", "not_supported", "unavailable"],
});

export const getSandbox = defineRoute({
	operationId: "getSandbox",
	method: "GET",
	path: "/sandboxes/{sandboxId}",
	tag: "sandboxes",
	summary: "Get a sandbox",
	description: describe(scope("sandboxes:read")),
	params: SandboxPath,
	answer: { status: 200, description: "The sandbox.", schema: Sandbox },
	errors: readErrors,
});

export const updateSandbox = defineRoute({
	operationId: "updateSandbox",
	method: "PATCH",
	path: "/sandboxes/{sandboxId}",
	tag: "sandboxes",
	summary: "Change a sandbox",
	description: describe(
		"Renames it, changes its auto-stop or moves its stop time (`extendMinutes`), shares it with its organisation or",
		"makes it private again, or replaces its labels.",
		scope("sandboxes:write"),
	),
	params: SandboxPath,
	body: UpdateSandboxBody,
	answer: { status: 200, description: "The sandbox.", schema: Sandbox },
	errors: changeErrors,
});

export const startSandbox = defineRoute({
	operationId: "startSandbox",
	method: "POST",
	path: "/sandboxes/{sandboxId}/start",
	tag: "sandboxes",
	summary: "Start a sandbox",
	description: describe(
		"Boots a stopped, paused or errored sandbox fresh from its newest disk snapshot: programs start again, and a",
		"paused sandbox's memory is let go. To carry on where a paused sandbox left off, `resume` it instead. A running",
		"sandbox is answered as it is.",
		scope("sandboxes:write"),
	),
	params: SandboxPath,
	body: ResumeSandboxBody,
	answer: { status: 200, description: "The sandbox, starting.", schema: Sandbox },
	errors: [...lifecycleErrors, "exhausted"],
});

export const stopSandbox = defineRoute({
	operationId: "stopSandbox",
	method: "POST",
	path: "/sandboxes/{sandboxId}/stop",
	tag: "sandboxes",
	summary: "Stop or pause a sandbox",
	description: describe(
		"Saves its disk as a snapshot and lets the machine go; running programs end. With `keepMemory`, pauses it",
		"instead, keeping its memory too (microVMs only; `not_supported` on an isolate). A stopped sandbox costs",
		"nothing to run.",
		scope("sandboxes:write"),
	),
	params: SandboxPath,
	body: StopSandboxBody,
	answer: { status: 200, description: "The sandbox, stopping.", schema: Sandbox },
	errors: lifecycleErrors,
});

export const resumeSandbox = defineRoute({
	operationId: "resumeSandbox",
	method: "POST",
	path: "/sandboxes/{sandboxId}/resume",
	tag: "sandboxes",
	summary: "Resume a sandbox",
	description: describe(
		"Carries on a paused sandbox from its memory, or starts a stopped one from its newest snapshot, on the same",
		"size or the one given. Same ID; a new machine.",
		scope("sandboxes:write"),
	),
	params: SandboxPath,
	body: ResumeSandboxBody,
	answer: { status: 200, description: "The sandbox, starting.", schema: Sandbox },
	errors: [...lifecycleErrors, "exhausted"],
});

export const forkSandbox = defineRoute({
	operationId: "forkSandbox",
	method: "POST",
	path: "/sandboxes/{sandboxId}/fork",
	tag: "sandboxes",
	summary: "Fork a sandbox",
	description: describe(
		"Makes `count` new sandboxes, each a copy of this one's newest snapshot (or `snapshotId`); a running microVM on",
		"a host that can fork live is copied with its memory. The source doesn't change.",
		scope("sandboxes:write"),
	),
	params: SandboxPath,
	body: ForkSandboxBody,
	idempotent: true,
	answer: { status: 201, description: "The new sandboxes.", schema: ForkedSandboxes },
	errors: [...lifecycleErrors, "exhausted"],
});

export const recoverSandbox = defineRoute({
	operationId: "recoverSandbox",
	method: "POST",
	path: "/sandboxes/{sandboxId}/recover",
	tag: "sandboxes",
	summary: "Recover a sandbox",
	description: describe(
		"Restarts the machine of a sandbox that doesn't answer or is in `error`, on its disk as it is. Memory is lost.",
		scope("sandboxes:write"),
	),
	params: SandboxPath,
	answer: { status: 200, description: "The sandbox, starting.", schema: Sandbox },
	errors: lifecycleErrors,
});

export const deleteSandbox = defineRoute({
	operationId: "deleteSandbox",
	method: "DELETE",
	path: "/sandboxes/{sandboxId}",
	tag: "sandboxes",
	summary: "Delete a sandbox permanently",
	description: describe(
		"Erases it and its automatic snapshots for good; saved snapshots of it stay. It can't be undone.",
		scope("sandboxes:delete"),
	),
	params: SandboxPath,
	answer: { status: 200, description: "The sandbox, deleting.", schema: Sandbox },
	errors: changeErrors,
});

export const getSandboxUsage = defineRoute({
	operationId: "getSandboxUsage",
	method: "GET",
	path: "/sandboxes/{sandboxId}/usage",
	tag: "sandboxes",
	summary: "Get a sandbox's usage",
	description: describe("CPU, memory, running time and cost per interval.", scope("sandboxes:read")),
	params: SandboxPath,
	query: UsageQuery,
	answer: { status: 200, description: "The usage.", schema: SandboxUsage },
	errors: readErrors,
});

export const sandboxRoutes = {
	listSandboxes,
	createSandbox,
	getSandbox,
	updateSandbox,
	startSandbox,
	stopSandbox,
	resumeSandbox,
	forkSandbox,
	recoverSandbox,
	deleteSandbox,
	getSandboxUsage,
} as const;

// Commands and files.

export const runCommand = defineRoute({
	operationId: "runCommand",
	method: "POST",
	path: "/sandboxes/{sandboxId}/commands",
	tag: "commands",
	summary: "Run a command",
	description: describe(
		"Runs a command line in a running sandbox and answers when it ends, with its exit code and output, or at",
		"`timeoutMs` (`timed_out`, the command killed). `detached` answers at once and lets it run with no limit. A",
		"stopped sandbox is `conflict`: resume it first.",
		scope("exec"),
	),
	params: SandboxPath,
	body: RunCommandBody,
	idempotent: true,
	answer: { status: 200, description: "The command, ended (or running, when detached).", schema: Command },
	errors: ["invalid", "forbidden", "not_found", "conflict", "unavailable"],
});

export const listCommands = defineRoute({
	operationId: "listCommands",
	method: "GET",
	path: "/sandboxes/{sandboxId}/commands",
	tag: "commands",
	summary: "List a sandbox's commands",
	description: describe("Its commands, newest first, also while it is stopped.", scope("exec")),
	params: SandboxPath,
	query: PageQueryCompute,
	answer: { status: 200, description: "A page of commands.", schema: CommandPage },
	errors: readErrors,
});

export const getCommand = defineRoute({
	operationId: "getCommand",
	method: "GET",
	path: "/sandboxes/{sandboxId}/commands/{commandId}",
	tag: "commands",
	summary: "Get a command",
	description: describe("Its state and its output so far.", scope("exec")),
	params: CommandPath,
	answer: { status: 200, description: "The command.", schema: Command },
	errors: readErrors,
});

export const killCommand = defineRoute({
	operationId: "killCommand",
	method: "DELETE",
	path: "/sandboxes/{sandboxId}/commands/{commandId}",
	tag: "commands",
	summary: "Kill a command",
	description: describe("Ends a running command; one that has ended is answered as it is.", scope("exec")),
	params: CommandPath,
	answer: { status: 200, description: "The command.", schema: Command },
	errors: readErrors,
});

export const readFile = defineRoute({
	operationId: "readFile",
	method: "GET",
	path: "/sandboxes/{sandboxId}/files",
	tag: "files",
	summary: "Read a file",
	description: describe(
		"A file of up to 1 MiB, as UTF-8 text unless `encoding` asks for base64. A larger file is read in parts of up " +
			"to 1 MiB with `offset` and `length`; `size` in the answer is the whole file's. Use base64 for a part of a " +
			"binary file, or of a text file cut mid-character.",
		scope("files"),
	),
	params: SandboxPath,
	query: ReadFileQuery,
	answer: { status: 200, description: "The file.", schema: FileContent },
	errors: ["invalid", "forbidden", "not_found", "conflict"],
});

export const writeFile = defineRoute({
	operationId: "writeFile",
	method: "PUT",
	path: "/sandboxes/{sandboxId}/files",
	tag: "files",
	summary: "Write a file",
	description: describe("Writes a file, making its directories, replacing what was there.", scope("files")),
	params: SandboxPath,
	body: WriteFileBody,
	answer: { status: 200, description: "The file written.", schema: FileEntry },
	errors: ["invalid", "forbidden", "not_found", "conflict"],
});

export const deleteFile = defineRoute({
	operationId: "deleteFile",
	method: "DELETE",
	path: "/sandboxes/{sandboxId}/files",
	tag: "files",
	summary: "Delete a file",
	description: describe("Deletes a file, or a directory and everything in it.", scope("files")),
	params: SandboxPath,
	query: FilePathQuery,
	answer: { status: 204, description: "Deleted." },
	errors: ["invalid", "forbidden", "not_found", "conflict"],
});

export const listFiles = defineRoute({
	operationId: "listFiles",
	method: "GET",
	path: "/sandboxes/{sandboxId}/files/list",
	tag: "files",
	summary: "List a directory",
	description: describe(scope("files")),
	params: SandboxPath,
	query: ListFilesQuery,
	answer: { status: 200, description: "The directory's entries.", schema: FileList },
	errors: ["invalid", "forbidden", "not_found", "conflict"],
});

export const commandRoutes = { runCommand, listCommands, getCommand, killCommand } as const;
export const fileRoutes = { readFile, writeFile, deleteFile, listFiles } as const;

// Ports, desktop, browser and SSH.

export const listPorts = defineRoute({
	operationId: "listPorts",
	method: "GET",
	path: "/sandboxes/{sandboxId}/ports",
	tag: "access",
	summary: "List a sandbox's public ports",
	description: describe(scope("access")),
	params: SandboxPath,
	answer: { status: 200, description: "The ports.", schema: ExposedPortList },
	errors: readErrors,
});

export const exposePort = defineRoute({
	operationId: "exposePort",
	method: "POST",
	path: "/sandboxes/{sandboxId}/ports",
	tag: "access",
	summary: "Expose a port",
	description: describe(
		"Gives a port in the sandbox an HTTPS URL through its host's tunnel. The app must listen on the port; on",
		"`0.0.0.0` or `localhost` both work. Exposing it again answers its URL.",
		scope("access"),
	),
	params: SandboxPath,
	body: ExposePortBody,
	answer: { status: 201, description: "The port's URL.", schema: ExposedPort },
	errors: [...changeErrors, "not_supported"],
});

export const hidePort = defineRoute({
	operationId: "hidePort",
	method: "DELETE",
	path: "/sandboxes/{sandboxId}/ports/{port}",
	tag: "access",
	summary: "Hide a port",
	description: describe("Its URL stops working at once.", scope("access")),
	params: PortPath,
	answer: { status: 204, description: "Hidden." },
	errors: readErrors,
});

export const openSsh = defineRoute({
	operationId: "openSsh",
	method: "POST",
	path: "/sandboxes/{sandboxId}/ssh",
	tag: "access",
	summary: "Get SSH access",
	description: describe(
		"Lets a key in to the sandbox's SSH gateway for a while, and answers the command that connects. microVMs only.",
		scope("access"),
	),
	params: SandboxPath,
	body: SshAccessBody,
	answer: { status: 201, description: "How to connect.", schema: SshAccess },
	errors: [...changeErrors, "not_supported"],
});

export const openDesktop = defineRoute({
	operationId: "openDesktop",
	method: "POST",
	path: "/sandboxes/{sandboxId}/desktop",
	tag: "access",
	summary: "Open the desktop",
	description: describe(
		"A short-lived URL that streams the sandbox's Linux desktop to a browser, to watch or drive. microVMs only.",
		scope("access"),
	),
	params: SandboxPath,
	body: ViewAccessBody,
	answer: { status: 201, description: "The desktop's URL.", schema: DesktopAccess },
	errors: [...changeErrors, "not_supported"],
});

export const openBrowser = defineRoute({
	operationId: "openBrowser",
	method: "POST",
	path: "/sandboxes/{sandboxId}/browser",
	tag: "access",
	summary: "Open the browser",
	description: describe(
		"Starts the sandbox's Chromium if it isn't running, and answers a live view URL and a CDP URL for Playwright or",
		"Puppeteer. microVMs only.",
		scope("access"),
	),
	params: SandboxPath,
	body: ViewAccessBody,
	answer: { status: 201, description: "The browser's URLs.", schema: BrowserAccess },
	errors: [...changeErrors, "not_supported"],
});

export const accessRoutes = { listPorts, exposePort, hidePort, openSsh, openDesktop, openBrowser } as const;

// Snapshots.

export const listSnapshots = defineRoute({
	operationId: "listSnapshots",
	method: "GET",
	path: "/snapshots",
	tag: "snapshots",
	summary: "List snapshots",
	description: describe(
		"The account's snapshots, newest first: saved ones, one sandbox's history (`sandboxId`), or both.",
		scope("snapshots:read"),
	),
	query: ListSnapshotsQuery,
	answer: { status: 200, description: "A page of snapshots.", schema: SnapshotPage },
	errors: ["invalid", "forbidden"],
});

export const takeSnapshot = defineRoute({
	operationId: "takeSnapshot",
	method: "POST",
	path: "/sandboxes/{sandboxId}/snapshots",
	tag: "snapshots",
	summary: "Take a snapshot now",
	description: describe(
		"Adds a snapshot of the sandbox's disk to its history now, without stopping it. Kantel also takes them by itself.",
		scope("snapshots:write"),
	),
	params: SandboxPath,
	body: TakeSnapshotBody,
	answer: { status: 201, description: "The snapshot, being taken.", schema: Snapshot },
	errors: lifecycleErrors,
});

export const saveSnapshot = defineRoute({
	operationId: "saveSnapshot",
	method: "POST",
	path: "/snapshots",
	tag: "snapshots",
	summary: "Save a snapshot",
	description: describe(
		"Keeps a sandbox's state now, or one snapshot of its history, under a name until it is deleted. New sandboxes",
		"start from it with `from: <name>`. A name in use is `conflict` unless `replace`.",
		scope("snapshots:write"),
	),
	body: SaveSnapshotBody,
	answer: { status: 201, description: "The saved snapshot.", schema: Snapshot },
	errors: [...lifecycleErrors, "exhausted"],
});

export const getSnapshot = defineRoute({
	operationId: "getSnapshot",
	method: "GET",
	path: "/snapshots/{snapshotId}",
	tag: "snapshots",
	summary: "Get a snapshot",
	description: describe(scope("snapshots:read")),
	params: SnapshotPath,
	answer: { status: 200, description: "The snapshot.", schema: Snapshot },
	errors: readErrors,
});

export const listSnapshotFiles = defineRoute({
	operationId: "listSnapshotFiles",
	method: "GET",
	path: "/snapshots/{snapshotId}/files",
	tag: "snapshots",
	summary: "List a snapshot's files",
	description: describe("One directory of the snapshot's disk, for a file browser.", scope("snapshots:read")),
	params: SnapshotPath,
	query: SnapshotFilesQuery,
	answer: { status: 200, description: "The directory's entries.", schema: FileList },
	errors: [...readErrors, "not_supported"],
});

export const readSnapshotFile = defineRoute({
	operationId: "readSnapshotFile",
	method: "GET",
	path: "/snapshots/{snapshotId}/file",
	tag: "snapshots",
	summary: "Read a file from a snapshot",
	description: describe("A file of up to 1 MiB from the snapshot's disk.", scope("snapshots:read")),
	params: SnapshotPath,
	query: ReadSnapshotFileQuery,
	answer: { status: 200, description: "The file.", schema: FileContent },
	errors: [...readErrors, "not_supported"],
});

export const deleteSnapshot = defineRoute({
	operationId: "deleteSnapshot",
	method: "DELETE",
	path: "/snapshots/{snapshotId}",
	tag: "snapshots",
	summary: "Delete a snapshot",
	description: describe(
		"Deletes a saved snapshot, or one of a sandbox's history. A sandbox's newest snapshot, which a resume needs, is",
		"`conflict` while the sandbox is stopped.",
		scope("snapshots:write"),
	),
	params: SnapshotPath,
	answer: { status: 204, description: "Deleted." },
	errors: changeErrors,
});

export const snapshotRoutes = {
	listSnapshots,
	takeSnapshot,
	saveSnapshot,
	getSnapshot,
	listSnapshotFiles,
	readSnapshotFile,
	deleteSnapshot,
} as const;

// API keys.

export const listApiKeys = defineRoute({
	operationId: "listApiKeys",
	method: "GET",
	path: "/api-keys",
	tag: "api-keys",
	summary: "List API keys",
	description: describe("The account's keys, revoked ones included.", scope("account:read")),
	query: AccountScopedQuery,
	answer: { status: 200, description: "The keys.", schema: ApiKeyList },
	errors: ["invalid", "forbidden"],
});

export const createApiKey = defineRoute({
	operationId: "createApiKey",
	method: "POST",
	path: "/api-keys",
	tag: "api-keys",
	summary: "Create an API key",
	description: describe(
		"Makes a scoped key in the account. Its secret is answered once. A key can only make keys with scopes it holds",
		"itself.",
		scope("account:admin"),
	),
	body: CreateApiKeyBody,
	answer: { status: 201, description: "The key and its secret.", schema: IssuedApiKey },
	errors: ["invalid", "forbidden"],
});

export const getApiKey = defineRoute({
	operationId: "getApiKey",
	method: "GET",
	path: "/api-keys/{apiKeyId}",
	tag: "api-keys",
	summary: "Get an API key",
	description: describe(scope("account:read")),
	params: ApiKeyPath,
	answer: { status: 200, description: "The key.", schema: ApiKey },
	errors: readErrors,
});

export const rotateApiKey = defineRoute({
	operationId: "rotateApiKey",
	method: "POST",
	path: "/api-keys/{apiKeyId}/rotate",
	tag: "api-keys",
	summary: "Rotate an API key",
	description: describe("Replaces its secret; the old one stops working at once.", scope("account:admin")),
	params: ApiKeyPath,
	answer: { status: 200, description: "The key and its new secret.", schema: IssuedApiKey },
	errors: changeErrors,
});

export const revokeApiKey = defineRoute({
	operationId: "revokeApiKey",
	method: "DELETE",
	path: "/api-keys/{apiKeyId}",
	tag: "api-keys",
	summary: "Revoke an API key",
	description: describe("It stops working at once.", scope("account:admin")),
	params: ApiKeyPath,
	answer: { status: 200, description: "The key, revoked.", schema: ApiKey },
	errors: readErrors,
});

export const apiKeyRoutes = { listApiKeys, createApiKey, getApiKey, rotateApiKey, revokeApiKey } as const;

// Signing in a device in a browser: the command line's `kantel login`, as RFC 8628's device authorisation grant. The
// device starts it and polls with no credential; a signed-in person approves it on the console's page, and the device's
// next poll gets a new API key made for that person.

export const startDeviceLogin = defineRoute({
	operationId: "startDeviceLogin",
	method: "POST",
	path: "/auth/device",
	tag: "auth",
	summary: "Start a device sign-in",
	description: describe(
		"Answers a code to show the person and the console page to open, where a signed-in person approves it. Then poll",
		"`pollDeviceLogin` with the `deviceCode`. Takes no credential. A code lasts 15 minutes.",
	),
	body: StartDeviceLoginBody,
	public: true,
	answer: { status: 201, description: "The sign-in, pending.", schema: DeviceLogin },
	errors: ["invalid", "exhausted"],
});

export const pollDeviceLogin = defineRoute({
	operationId: "pollDeviceLogin",
	method: "POST",
	path: "/auth/device/token",
	tag: "auth",
	summary: "Poll a device sign-in",
	description: describe(
		"Its state, and once approved the new key's secret, answered to the first poll that sees it. Takes no credential:",
		"the `deviceCode` is the secret.",
	),
	body: PollDeviceLoginBody,
	public: true,
	answer: { status: 200, description: "Its state, with the key once approved.", schema: DeviceLoginResult },
	errors: ["invalid", "not_found"],
});

export const getDeviceLogin = defineRoute({
	operationId: "getDeviceLogin",
	method: "GET",
	path: "/auth/device/{userCode}",
	tag: "auth",
	summary: "Get a device sign-in",
	description: describe("What is asking to sign in with this code, for the approval page.", "A person only."),
	params: DeviceLoginPath,
	answer: { status: 200, description: "The sign-in.", schema: DeviceLoginRequest },
	errors: readErrors,
});

export const approveDeviceLogin = defineRoute({
	operationId: "approveDeviceLogin",
	method: "POST",
	path: "/auth/device/{userCode}/approve",
	tag: "auth",
	summary: "Approve a device sign-in",
	description: describe(
		"Makes an API key for the person, named after the device, and hands it to the device's next poll. A person only,",
		"who needs admin or owner in the account (`account:admin`), as for `createApiKey`.",
	),
	params: DeviceLoginPath,
	body: ApproveDeviceLoginBody,
	answer: { status: 200, description: "The sign-in, approved.", schema: DeviceLoginRequest },
	errors: changeErrors,
});

export const denyDeviceLogin = defineRoute({
	operationId: "denyDeviceLogin",
	method: "POST",
	path: "/auth/device/{userCode}/deny",
	tag: "auth",
	summary: "Deny a device sign-in",
	description: describe("The device's next poll is `denied`. A person only."),
	params: DeviceLoginPath,
	answer: { status: 200, description: "The sign-in, denied.", schema: DeviceLoginRequest },
	errors: changeErrors,
});

export const deviceLoginRoutes = {
	startDeviceLogin,
	pollDeviceLogin,
	getDeviceLogin,
	approveDeviceLogin,
	denyDeviceLogin,
} as const;

// The proxy.

export const getProxySettings = defineRoute({
	operationId: "getProxySettings",
	method: "GET",
	path: "/proxy",
	tag: "proxy",
	summary: "Get the proxy settings",
	description: describe("Where the account's sandboxes' outbound traffic may go.", scope("account:read")),
	query: AccountScopedQuery,
	answer: { status: 200, description: "The settings.", schema: ProxySettings },
	errors: ["invalid", "forbidden"],
});

export const putProxySettings = defineRoute({
	operationId: "putProxySettings",
	method: "PUT",
	path: "/proxy",
	tag: "proxy",
	summary: "Set the proxy settings",
	description: describe(
		"Replaces them. Running sandboxes pick them up within a minute. An upstream's header values are kept encrypted",
		"and never shown again; leave `upstream.headers` out to keep the ones it has.",
		scope("account:admin"),
	),
	body: PutProxySettingsBody,
	answer: { status: 200, description: "The settings.", schema: ProxySettings },
	errors: ["invalid", "forbidden", "not_supported"],
});

export const proxyRoutes = { getProxySettings, putProxySettings } as const;

// Environments: what sandboxes start with. And each sandbox's egress.

const RUNNING_AT_ONCE = "Running sandboxes made from it pick the change up at once.";

export const listEnvironments = defineRoute({
	operationId: "listEnvironments",
	method: "GET",
	path: "/environments",
	tag: "environments",
	summary: "List environments",
	description: describe("The account's environments, oldest first.", scope("account:read")),
	query: AccountScopedQuery,
	answer: { status: 200, description: "The environments.", schema: EnvironmentList },
	errors: ["invalid", "forbidden"],
});

export const createEnvironment = defineRoute({
	operationId: "createEnvironment",
	method: "POST",
	path: "/environments",
	tag: "environments",
	summary: "Create an environment",
	description: describe(
		"An empty environment, named uniquely in the account. A sandbox starts with it when its create names it.",
		scope("account:admin"),
	),
	body: CreateEnvironmentBody,
	answer: { status: 201, description: "The environment.", schema: Environment },
	errors: ["invalid", "forbidden", "conflict"],
});

export const getEnvironment = defineRoute({
	operationId: "getEnvironment",
	method: "GET",
	path: "/environments/{environmentId}",
	tag: "environments",
	summary: "Get an environment",
	description: describe("Never a protected variable's value nor a secret file's contents.", scope("account:read")),
	params: EnvironmentPath,
	answer: { status: 200, description: "The environment.", schema: Environment },
	errors: readErrors,
});

export const updateEnvironment = defineRoute({
	operationId: "updateEnvironment",
	method: "PATCH",
	path: "/environments/{environmentId}",
	tag: "environments",
	summary: "Change an environment",
	description: describe("Renames it or changes its description.", scope("account:admin")),
	params: EnvironmentPath,
	body: UpdateEnvironmentBody,
	answer: { status: 200, description: "The environment.", schema: Environment },
	errors: changeErrors,
});

export const deleteEnvironment = defineRoute({
	operationId: "deleteEnvironment",
	method: "DELETE",
	path: "/environments/{environmentId}",
	tag: "environments",
	summary: "Delete an environment",
	description: describe(
		"Sandboxes made from it keep what they started with, but their protected variables stop resolving at once.",
		scope("account:admin"),
	),
	params: EnvironmentPath,
	answer: { status: 204, description: "Deleted." },
	errors: readErrors,
});

export const setEnvironmentVariable = defineRoute({
	operationId: "setEnvironmentVariable",
	method: "PUT",
	path: "/environments/{environmentId}/variables/{name}",
	tag: "environments",
	summary: "Set an environment variable",
	description: describe(
		"Adds or changes a variable. A protected one needs at least one binding, and its value is kept encrypted and never",
		"shown again; leave `value` out to change only its bindings. A new value for a protected variable is a rotation:",
		"sandboxes keep their placeholders, and their next request carries the new value.",
		RUNNING_AT_ONCE,
		"Kantel's own names (`KANTEL_*`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, in any case) are refused. Protected",
		"values need the deployment's secrets key (`not_supported` without one).",
		scope("account:admin"),
	),
	params: EnvironmentVariablePath,
	body: SetEnvironmentVariableBody,
	answer: { status: 200, description: "The environment.", schema: Environment },
	errors: ["invalid", "forbidden", "not_found", "conflict", "not_supported"],
});

export const deleteEnvironmentVariable = defineRoute({
	operationId: "deleteEnvironmentVariable",
	method: "DELETE",
	path: "/environments/{environmentId}/variables/{name}",
	tag: "environments",
	summary: "Delete an environment variable",
	description: describe(
		"A protected variable stops resolving in the sandboxes made from the environment at once.",
		scope("account:admin"),
	),
	params: EnvironmentVariablePath,
	answer: { status: 200, description: "The environment.", schema: Environment },
	errors: readErrors,
});

export const setEnvironmentFile = defineRoute({
	operationId: "setEnvironmentFile",
	method: "PUT",
	path: "/environments/{environmentId}/files",
	tag: "environments",
	summary: "Set a secret file",
	description: describe(
		"Adds or replaces a file new sandboxes start with, written once they are running. Its contents are kept encrypted",
		"and never shown again; leave `content` out to change only its mode. Needs the deployment's secrets key",
		"(`not_supported` without one).",
		scope("account:admin"),
	),
	params: EnvironmentPath,
	body: SetEnvironmentFileBody,
	answer: { status: 200, description: "The environment.", schema: Environment },
	errors: ["invalid", "forbidden", "not_found", "conflict", "not_supported"],
});

export const deleteEnvironmentFile = defineRoute({
	operationId: "deleteEnvironmentFile",
	method: "DELETE",
	path: "/environments/{environmentId}/files",
	tag: "environments",
	summary: "Delete a secret file",
	description: describe("Sandboxes made from the environment keep their copy.", scope("account:admin")),
	params: EnvironmentPath,
	query: EnvironmentFileQuery,
	answer: { status: 200, description: "The environment.", schema: Environment },
	errors: readErrors,
});

export const putEnvironmentRepos = defineRoute({
	operationId: "putEnvironmentRepos",
	method: "PUT",
	path: "/environments/{environmentId}/repos",
	tag: "environments",
	summary: "Set an environment's repositories",
	description: describe(
		"Replaces them. New sandboxes clone each once they are running (`git clone --depth 1`), through the egress proxy.",
		scope("account:admin"),
	),
	params: EnvironmentPath,
	body: PutEnvironmentReposBody,
	answer: { status: 200, description: "The environment.", schema: Environment },
	errors: changeErrors,
});

export const putEnvironmentGrants = defineRoute({
	operationId: "putEnvironmentGrants",
	method: "PUT",
	path: "/environments/{environmentId}/grants",
	tag: "environments",
	summary: "Set an environment's egress grants",
	description: describe("Replaces them.", RUNNING_AT_ONCE, scope("account:admin")),
	params: EnvironmentPath,
	body: PutEgressGrantsBody,
	answer: { status: 200, description: "The environment.", schema: Environment },
	errors: changeErrors,
});

export const getSandboxEgress = defineRoute({
	operationId: "getSandboxEgress",
	method: "GET",
	path: "/sandboxes/{sandboxId}/egress",
	tag: "environments",
	summary: "Get a sandbox's egress",
	description: describe(
		"Its environment, its protected variables (each placeholder's first 8 characters, never a value), its grants and",
		"the newest of its egress log: what its host's proxy let through or refused.",
		scope("account:read"),
	),
	params: SandboxPath,
	query: SandboxEgressQuery,
	answer: { status: 200, description: "Its egress.", schema: SandboxEgress },
	errors: readErrors,
});

export const putSandboxGrants = defineRoute({
	operationId: "putSandboxGrants",
	method: "PUT",
	path: "/sandboxes/{sandboxId}/grants",
	tag: "environments",
	summary: "Set a sandbox's egress grants",
	description: describe(
		"Replaces its own grants, on top of its environment's. A running sandbox picks them up at once.",
		scope("account:admin"),
	),
	params: SandboxPath,
	body: PutEgressGrantsBody,
	answer: { status: 200, description: "Its egress.", schema: SandboxEgress },
	errors: changeErrors,
});

export const environmentComputeRoutes = {
	listEnvironments,
	createEnvironment,
	getEnvironment,
	updateEnvironment,
	deleteEnvironment,
	setEnvironmentVariable,
	deleteEnvironmentVariable,
	setEnvironmentFile,
	deleteEnvironmentFile,
	putEnvironmentRepos,
	putEnvironmentGrants,
	getSandboxEgress,
	putSandboxGrants,
} as const;

// Events, webhooks and telemetry.

export const listEvents = defineRoute({
	operationId: "listEvents",
	method: "GET",
	path: "/events",
	tag: "events",
	summary: "List events",
	description: describe(
		"The account's events, newest first: what webhooks deliver, and a sandbox's history with `sandboxId`.",
		scope("sandboxes:read"),
	),
	query: ListEventsQuery,
	answer: { status: 200, description: "A page of events.", schema: EventPage },
	errors: ["invalid", "forbidden"],
});

export const listWebhooks = defineRoute({
	operationId: "listWebhooks",
	method: "GET",
	path: "/webhooks",
	tag: "webhooks",
	summary: "List webhooks",
	description: describe(scope("account:admin")),
	query: AccountScopedQuery,
	answer: { status: 200, description: "The webhooks.", schema: WebhookList },
	errors: ["invalid", "forbidden"],
});

export const createWebhook = defineRoute({
	operationId: "createWebhook",
	method: "POST",
	path: "/webhooks",
	tag: "webhooks",
	summary: "Create a webhook",
	description: describe("Its signing secret is answered once.", scope("account:admin")),
	body: CreateWebhookBody,
	answer: { status: 201, description: "The webhook and its signing secret.", schema: WebhookWithSecret },
	errors: ["invalid", "forbidden", "exhausted"],
});

export const getWebhook = defineRoute({
	operationId: "getWebhook",
	method: "GET",
	path: "/webhooks/{webhookId}",
	tag: "webhooks",
	summary: "Get a webhook",
	description: describe(scope("account:admin")),
	params: WebhookPath,
	answer: { status: 200, description: "The webhook.", schema: Webhook },
	errors: readErrors,
});

export const updateWebhook = defineRoute({
	operationId: "updateWebhook",
	method: "PATCH",
	path: "/webhooks/{webhookId}",
	tag: "webhooks",
	summary: "Change a webhook",
	description: describe(scope("account:admin")),
	params: WebhookPath,
	body: UpdateWebhookBody,
	answer: { status: 200, description: "The webhook.", schema: Webhook },
	errors: changeErrors,
});

export const deleteWebhook = defineRoute({
	operationId: "deleteWebhook",
	method: "DELETE",
	path: "/webhooks/{webhookId}",
	tag: "webhooks",
	summary: "Delete a webhook",
	description: describe("Its queued deliveries are dropped.", scope("account:admin")),
	params: WebhookPath,
	answer: { status: 204, description: "Deleted." },
	errors: readErrors,
});

export const rotateWebhookSecret = defineRoute({
	operationId: "rotateWebhookSecret",
	method: "POST",
	path: "/webhooks/{webhookId}/rotate",
	tag: "webhooks",
	summary: "Rotate a webhook's signing secret",
	description: describe(
		"Deliveries are signed with the new secret from now; one already under way may carry the old signature.",
		scope("account:admin"),
	),
	params: WebhookPath,
	answer: { status: 200, description: "The webhook and its new secret.", schema: WebhookWithSecret },
	errors: readErrors,
});

export const testWebhook = defineRoute({
	operationId: "testWebhook",
	method: "POST",
	path: "/webhooks/{webhookId}/test",
	tag: "webhooks",
	summary: "Send a test delivery",
	description: describe("Sends a signed `sandbox.created` event for a made-up sandbox now.", scope("account:admin")),
	params: WebhookPath,
	answer: { status: 200, description: "The delivery, made.", schema: WebhookDelivery },
	errors: readErrors,
});

export const listWebhookDeliveries = defineRoute({
	operationId: "listWebhookDeliveries",
	method: "GET",
	path: "/webhooks/{webhookId}/deliveries",
	tag: "webhooks",
	summary: "List a webhook's deliveries",
	description: describe("The last 30 days, newest first.", scope("account:admin")),
	params: WebhookPath,
	query: PageQueryCompute,
	answer: { status: 200, description: "A page of deliveries.", schema: WebhookDeliveryPage },
	errors: readErrors,
});

export const getTelemetry = defineRoute({
	operationId: "getTelemetry",
	method: "GET",
	path: "/telemetry",
	tag: "telemetry",
	summary: "Get the OpenTelemetry export",
	description: describe("Absent: `not_found`.", scope("account:admin")),
	query: AccountScopedQuery,
	answer: { status: 200, description: "The export.", schema: TelemetryExport },
	errors: readErrors,
});

export const putTelemetry = defineRoute({
	operationId: "putTelemetry",
	method: "PUT",
	path: "/telemetry",
	tag: "telemetry",
	summary: "Set the OpenTelemetry export",
	description: describe(
		"Sets or replaces the account's one OTLP/HTTP endpoint, sends an empty export to test it, and answers what the",
		"collector said. Header values are kept encrypted and never shown again.",
		scope("account:admin"),
	),
	body: PutTelemetryBody,
	answer: { status: 200, description: "The export and its test.", schema: TelemetryTest },
	errors: ["invalid", "forbidden"],
});

export const deleteTelemetry = defineRoute({
	operationId: "deleteTelemetry",
	method: "DELETE",
	path: "/telemetry",
	tag: "telemetry",
	summary: "Remove the OpenTelemetry export",
	description: describe(scope("account:admin")),
	query: AccountScopedQuery,
	answer: { status: 204, description: "Removed." },
	errors: ["invalid", "forbidden"],
});

export const eventRoutes = { listEvents } as const;
export const webhookRoutes = {
	listWebhooks,
	createWebhook,
	getWebhook,
	updateWebhook,
	deleteWebhook,
	rotateWebhookSecret,
	testWebhook,
	listWebhookDeliveries,
} as const;
export const telemetryRoutes = { getTelemetry, putTelemetry, deleteTelemetry } as const;

// Hosts: the deployment's super-admins only. The host agent's own protocol is not part of the public API.

const SUPER_ADMIN = "A deployment super-admin only (a key needs `hosts:admin`).";

export const listHosts = defineRoute({
	operationId: "listHosts",
	method: "GET",
	path: "/admin/hosts",
	tag: "hosts",
	summary: "List hosts",
	description: describe("Every host that has joined, revoked ones included.", SUPER_ADMIN),
	answer: { status: 200, description: "The hosts.", schema: HostList },
	errors: ["forbidden"],
});

export const getHost = defineRoute({
	operationId: "getHost",
	method: "GET",
	path: "/admin/hosts/{hostId}",
	tag: "hosts",
	summary: "Get a host",
	description: describe(SUPER_ADMIN),
	params: HostPath,
	answer: { status: 200, description: "The host.", schema: Host },
	errors: readErrors,
});

export const updateHost = defineRoute({
	operationId: "updateHost",
	method: "PATCH",
	path: "/admin/hosts/{hostId}",
	tag: "hosts",
	summary: "Change a host",
	description: describe("Renames it, replaces its labels, or drains it.", SUPER_ADMIN),
	params: HostPath,
	body: UpdateHostBody,
	answer: { status: 200, description: "The host.", schema: Host },
	errors: changeErrors,
});

export const revokeHost = defineRoute({
	operationId: "revokeHost",
	method: "DELETE",
	path: "/admin/hosts/{hostId}",
	tag: "hosts",
	summary: "Revoke a host",
	description: describe(
		"Revokes its credential and closes its connection. Its sandboxes keep their disks but can't be reached until it",
		"joins again. `unavailable`, and not revoked, when its credential is kept by a part of the deployment that is",
		"off (an account's own host, with account hosts switched off).",
		SUPER_ADMIN,
	),
	params: HostPath,
	answer: { status: 200, description: "The host, revoked.", schema: Host },
	errors: [...readErrors, "unavailable"],
});

export const createHostJoinToken = defineRoute({
	operationId: "createHostJoinToken",
	method: "POST",
	path: "/admin/hosts/join-tokens",
	tag: "hosts",
	summary: "Make a host join token",
	description: describe(
		"A one-use token, shown once, and the one-line command that installs the host agent on a Linux machine and joins",
		"it with the token.",
		SUPER_ADMIN,
	),
	body: CreateHostJoinTokenBody,
	answer: { status: 201, description: "The token and its command.", schema: HostJoinToken },
	errors: ["invalid", "forbidden"],
});

export const hostRoutes = { listHosts, createHostJoinToken, getHost, updateHost, revokeHost } as const;

// An account's own hosts, added by its people rather than by the deployment's super-admin. Only that account's
// sandboxes run on them. Experimental: a deployment serves these only with KANTEL_ACCOUNT_HOSTS=experimental, and
// answers `not_supported` otherwise.

const ACCOUNT_HOSTS =
	"Experimental: `not_supported` unless the deployment has turned account hosts on (`KANTEL_ACCOUNT_HOSTS`).";

export const createAccountJoinToken = defineRoute({
	operationId: "createAccountJoinToken",
	method: "POST",
	path: "/hosts/join-tokens",
	tag: "account-hosts",
	summary: "Make a join token for one of your own hosts",
	description: describe(
		"A one-use token, shown once, and the one-line command that installs the host agent on a Linux machine and joins",
		"it to the account (the caller's personal account unless `account` names an organisation). The host dials out",
		"to this deployment and keeps the connection open, so it needs no inbound port. Once it has joined, the account's",
		"new sandboxes go on its own hosts, and no other account's sandboxes ever do.",
		scope("account:admin"),
		ACCOUNT_HOSTS,
	),
	body: CreateAccountJoinTokenBody,
	answer: { status: 201, description: "The token and its command.", schema: AccountJoinToken },
	errors: ["invalid", "forbidden", "not_supported"],
});

export const listAccountHosts = defineRoute({
	operationId: "listAccountHosts",
	method: "GET",
	path: "/hosts",
	tag: "account-hosts",
	summary: "List an account's hosts",
	description: describe(
		"The hosts joined to the account, revoked ones included. The deployment's shared hosts aren't listed.",
		scope("account:read"),
		ACCOUNT_HOSTS,
	),
	query: AccountScopedQuery,
	answer: { status: 200, description: "The hosts.", schema: HostList },
	errors: ["invalid", "forbidden", "not_supported"],
});

export const getAccountHost = defineRoute({
	operationId: "getAccountHost",
	method: "GET",
	path: "/hosts/{hostId}",
	tag: "account-hosts",
	summary: "Get one of an account's hosts",
	description: describe(scope("account:read"), ACCOUNT_HOSTS),
	params: HostPath,
	answer: { status: 200, description: "The host.", schema: Host },
	errors: [...readErrors, "not_supported"],
});

export const updateAccountHost = defineRoute({
	operationId: "updateAccountHost",
	method: "PATCH",
	path: "/hosts/{hostId}",
	tag: "account-hosts",
	summary: "Change one of an account's hosts",
	description: describe("Renames it, replaces its labels, or drains it.", scope("account:admin"), ACCOUNT_HOSTS),
	params: HostPath,
	body: UpdateHostBody,
	answer: { status: 200, description: "The host.", schema: Host },
	errors: [...changeErrors, "not_supported"],
});

export const removeAccountHost = defineRoute({
	operationId: "removeAccountHost",
	method: "DELETE",
	path: "/hosts/{hostId}",
	tag: "account-hosts",
	summary: "Remove one of an account's hosts",
	description: describe(
		"Revokes its credential and closes its connection. Its sandboxes keep their disks but can't be reached until it",
		"joins again. Run `sudo kantel-host uninstall` on the machine to take the agent off it.",
		scope("account:admin"),
		ACCOUNT_HOSTS,
	),
	params: HostPath,
	answer: { status: 200, description: "The host, revoked.", schema: Host },
	errors: [...readErrors, "not_supported"],
});

export const accountHostRoutes = {
	createAccountJoinToken,
	listAccountHosts,
	getAccountHost,
	updateAccountHost,
	removeAccountHost,
} as const;

/** Every compute-plane route, in the order the document and the SDK list them. */
export const computeRoutes = {
	...accountRoutes,
	...sandboxRoutes,
	...commandRoutes,
	...fileRoutes,
	...accessRoutes,
	...snapshotRoutes,
	...apiKeyRoutes,
	...deviceLoginRoutes,
	...proxyRoutes,
	...environmentComputeRoutes,
	...eventRoutes,
	...webhookRoutes,
	...telemetryRoutes,
	...hostRoutes,
	...accountHostRoutes,
} as const;

export type ComputeRoutes = typeof computeRoutes;

/** The compute routes that take no credential: a server answers them without signing the caller in. */
export const publicComputeRoutes = { startDeviceLogin, pollDeviceLogin } as const;
export type PublicComputeRoutes = typeof publicComputeRoutes;
/** The compute routes that sign the caller in first. */
export type SignedInComputeRoutes = Omit<ComputeRoutes, keyof PublicComputeRoutes>;
