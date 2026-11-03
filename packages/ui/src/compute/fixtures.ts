// Sample data for the compute console's pages: a personal account and two organisations, sandboxes in every state on
// both tiers, snapshots with a small file tree, keys, a proxy, webhooks, telemetry, three hosts and the hosted plans.
// `createComputeFixtures` serves it all from memory as a `ComputeSource`, so stories and the console's sample data can
// create, stop, resume, fork and delete. Nothing leaves the page.

import { DAY, HOUR, MINUTE } from "../primitives/format.ts";
import type {
	ApiKey,
	ApiScope,
	BillingSummary,
	ComputeAccount,
	ComputeSource,
	ComputeViewer,
	CreateSandboxInput,
	DeviceLogin,
	Host,
	HostingMode,
	OrganisationInvite,
	OrganisationMember,
	Plan,
	ProxyRequest,
	ProxySettings,
	Sandbox,
	SandboxCommand,
	SandboxSnapshot,
	SavedSnapshot,
	SnapshotEntry,
	TelemetrySettings,
	Webhook,
	WebhookDelivery,
} from "./compute-model.ts";
import { sizeSpec } from "./compute-model.ts";

/** The code the fixtures' waiting command line showed. */
export const FIXTURE_DEVICE_CODE = "BCDF-GHJK";

/** The moment the fixtures are at: Tuesday 3 November 2026, 10:00 UTC. */
export const FIXTURE_NOW = Date.UTC(2026, 10, 3, 10, 0, 0);

export const VIEWER: ComputeViewer = {
	id: "usr_tom",
	name: "Tom Davies",
	email: "tom@example.com",
	superAdmin: true,
};

export const PERSONAL: ComputeAccount = {
	id: "acc_tom",
	kind: "personal",
	name: "Tom Davies",
	slug: "tom",
	role: "owner",
	members: 1,
	planId: "plan_starter",
};

export const LLEVERAGE: ComputeAccount = {
	id: "org_lleverage",
	kind: "organisation",
	name: "Lleverage",
	slug: "lleverage",
	role: "admin",
	members: 6,
	planId: "plan_team",
};

export const EVALS: ComputeAccount = {
	id: "org_evals",
	kind: "organisation",
	name: "Eval lab",
	slug: "evals",
	role: "member",
	members: 3,
	planId: "plan_team",
};

/** A day of CPU use, shaped by `seed`: a few busy stretches on a quiet line. */
export function usageSeries(seed: number, busy = 0.5, points = 30): readonly number[] {
	const out: number[] = [];
	let value = 0.1 + (seed % 7) / 40;
	for (let at = 0; at < points; at += 1) {
		const wave = Math.sin((at + seed) / 3) * 0.5 + 0.5;
		const spike = (at * 7 + seed * 13) % 11 === 0 ? 0.35 : 0;
		value = Math.min(1, Math.max(0.02, value * 0.5 + (wave * busy + spike) * 0.5));
		out.push(Number(value.toFixed(3)));
	}
	return out;
}

const flat = (points = 30): readonly number[] => Array.from({ length: points }, () => 0);

const sandbox = (
	fields: Omit<Sandbox, "hostname" | "usage" | "createdBy"> &
		Partial<Pick<Sandbox, "usage" | "createdBy">> & { readonly slug: string },
): Sandbox => {
	const { slug, ...rest } = fields;
	return {
		createdBy: "Tom Davies",
		usage: rest.state === "running" ? usageSeries(rest.id.length + rest.name.length) : flat(),
		...rest,
		hostname: `${rest.name}.${slug}.kantel.example.com`,
	};
};

export const API_SERVER = sandbox({
	id: "sbx_7f3k2m9qa1",
	name: "api-server",
	slug: "lleverage",
	accountId: LLEVERAGE.id,
	kind: "microvm",
	size: "large",
	state: "running",
	createdAt: FIXTURE_NOW - 3 * HOUR - 12 * MINUTE,
	stopsAt: FIXTURE_NOW + 52 * MINUTE,
	snapshot: { id: "snp_api_0958", takenAt: FIXTURE_NOW - 2 * MINUTE },
	costCents: 31,
	usage: usageSeries(4, 0.8),
	hostId: "hst_hetzner_1",
	shared: true,
	createdBy: "Alex Kemp",
});

export const DEV_STACK = sandbox({
	id: "sbx_4d8n1x7pe2",
	name: "dev-stack",
	slug: "lleverage",
	accountId: LLEVERAGE.id,
	kind: "microvm",
	size: "xlarge",
	state: "running",
	createdAt: FIXTURE_NOW - 2 * DAY,
	snapshot: { id: "snp_dev_0959", takenAt: FIXTURE_NOW - MINUTE },
	costCents: 1094,
	usage: usageSeries(9, 0.6),
	hostId: "hst_hetzner_1",
	shared: true,
});

export const SCRATCH = sandbox({
	id: "sbx_9a2b6c4dq3",
	name: "scratch",
	slug: "lleverage",
	accountId: LLEVERAGE.id,
	kind: "isolate",
	size: "small",
	state: "running",
	createdAt: FIXTURE_NOW - 6 * MINUTE,
	stopsAt: FIXTURE_NOW + 9 * MINUTE,
	costCents: 0.2,
	usage: usageSeries(2, 0.2),
	hostId: "hst_home",
	createdBy: "ci-runner",
});

export const RENDER = sandbox({
	id: "sbx_2q8w5e1rz4",
	name: "render-farm",
	slug: "lleverage",
	accountId: LLEVERAGE.id,
	kind: "microvm",
	size: "large",
	state: "stopped",
	createdAt: FIXTURE_NOW - 4 * DAY,
	snapshot: { id: "snp_render_1", takenAt: FIXTURE_NOW - 20 * HOUR },
	costCents: 412,
	hostId: "hst_hetzner_2",
	shared: true,
	createdBy: "Bethan Price",
});

export const BROWSER_AGENT = sandbox({
	id: "sbx_6t3y8u2iw5",
	name: "browser-agent",
	slug: "lleverage",
	accountId: LLEVERAGE.id,
	kind: "microvm",
	size: "medium",
	state: "paused",
	createdAt: FIXTURE_NOW - 9 * HOUR,
	snapshot: { id: "snp_browser_3", takenAt: FIXTURE_NOW - 40 * MINUTE },
	costCents: 33,
	hostId: "hst_hetzner_2",
	shared: true,
});

export const EVAL_RUNNER = sandbox({
	id: "sbx_1o9p4a7se6",
	name: "eval-runner-12",
	slug: "lleverage",
	accountId: LLEVERAGE.id,
	kind: "microvm",
	size: "medium",
	state: "error",
	createdAt: FIXTURE_NOW - 50 * MINUTE,
	snapshot: { id: "snp_eval_2", takenAt: FIXTURE_NOW - 12 * MINUTE },
	costCents: 3,
	hostId: "hst_home",
	error: "The machine stopped answering. Its disk is safe: recover it, or resume it on another host.",
	forkedFrom: DEV_STACK.id,
});

export const NEW_ONE = sandbox({
	id: "sbx_8f2g5h3jd7",
	name: "preview-pr-412",
	slug: "lleverage",
	accountId: LLEVERAGE.id,
	kind: "isolate",
	size: "small",
	state: "starting",
	createdAt: FIXTURE_NOW - 2_000,
	stopsAt: FIXTURE_NOW + HOUR,
	costCents: 0,
	hostId: "hst_home",
});

export const PERSONAL_BOX = sandbox({
	id: "sbx_3k7l1z9xc8",
	name: "playground",
	slug: "tom",
	accountId: PERSONAL.id,
	kind: "microvm",
	size: "medium",
	state: "running",
	createdAt: FIXTURE_NOW - 25 * MINUTE,
	stopsAt: FIXTURE_NOW + 35 * MINUTE,
	snapshot: { id: "snp_play_1", takenAt: FIXTURE_NOW - MINUTE },
	costCents: 2,
	usage: usageSeries(1, 0.4),
	hostId: "hst_home",
});

export const PERSONAL_OLD = sandbox({
	id: "sbx_5v2b8n4mf9",
	name: "wine-test",
	slug: "tom",
	accountId: PERSONAL.id,
	kind: "microvm",
	size: "large",
	state: "stopped",
	createdAt: FIXTURE_NOW - 6 * DAY,
	snapshot: { id: "snp_wine_4", takenAt: FIXTURE_NOW - 5 * DAY },
	costCents: 96,
	hostId: "hst_hetzner_2",
});

export const SANDBOXES: readonly Sandbox[] = [
	NEW_ONE,
	SCRATCH,
	API_SERVER,
	EVAL_RUNNER,
	BROWSER_AGENT,
	DEV_STACK,
	RENDER,
	PERSONAL_BOX,
	PERSONAL_OLD,
];

export const SAVED: readonly SavedSnapshot[] = [
	{
		id: "ssn_node22_base",
		name: "node22-base",
		accountId: LLEVERAGE.id,
		sandboxName: "base-builder",
		kind: "microvm",
		createdAt: FIXTURE_NOW - 12 * DAY,
		createdBy: "Alex Kemp",
		sizeBytes: 3.4 * 1024 ** 3,
		uses: 214,
	},
	{
		id: "ssn_dev_stack_warm",
		name: "dev-stack-warm",
		accountId: LLEVERAGE.id,
		sandboxId: DEV_STACK.id,
		sandboxName: DEV_STACK.name,
		kind: "microvm",
		createdAt: FIXTURE_NOW - 2 * DAY,
		createdBy: "Tom Davies",
		sizeBytes: 11.8 * 1024 ** 3,
		uses: 37,
	},
	{
		id: "ssn_playwright",
		name: "playwright-chrome",
		accountId: LLEVERAGE.id,
		sandboxId: BROWSER_AGENT.id,
		sandboxName: BROWSER_AGENT.name,
		kind: "microvm",
		createdAt: FIXTURE_NOW - 8 * HOUR,
		createdBy: "Bethan Price",
		sizeBytes: 5.1 * 1024 ** 3,
		uses: 9,
	},
	{
		id: "ssn_py_tools",
		name: "python-tools",
		accountId: LLEVERAGE.id,
		sandboxName: "scratch-py",
		kind: "isolate",
		createdAt: FIXTURE_NOW - 30 * DAY,
		createdBy: "Dean Smit",
		sizeBytes: 86 * 1024 ** 2,
		uses: 1_032,
	},
	{
		id: "ssn_wine",
		name: "wine-paint-net",
		accountId: PERSONAL.id,
		sandboxId: PERSONAL_OLD.id,
		sandboxName: PERSONAL_OLD.name,
		kind: "microvm",
		createdAt: FIXTURE_NOW - 5 * DAY,
		createdBy: "Tom Davies",
		sizeBytes: 7.2 * 1024 ** 3,
		uses: 2,
	},
];

/** Each sandbox's history: one snapshot a minute while it runs would be a lot, so the fixtures keep a handful. */
function historyFor(box: Sandbox): readonly SandboxSnapshot[] {
	if (box.snapshot === undefined) return [];
	const out: SandboxSnapshot[] = [];
	const count = box.state === "running" ? 6 : 3;
	for (let at = 0; at < count; at += 1) {
		const takenAt = box.snapshot.takenAt - at * (box.state === "running" ? 10 * MINUTE : 7 * HOUR);
		out.push({
			id: at === 0 ? box.snapshot.id : `${box.snapshot.id}_${at}`,
			sandboxId: box.id,
			takenAt,
			reason: at === 0 && box.state !== "running" ? "stop" : at === count - 1 && box.forkedFrom ? "fork" : "periodic",
			sizeBytes: Math.round((sizeSpec(box.size).diskGb * 1024 ** 3 * (0.08 + at * 0.004)) / 1024) * 1024,
			expiresAt: takenAt + 14 * DAY,
		});
	}
	return out;
}

/** The same small tree in every snapshot: a home folder with an app, its logs and some config. */
const TREE: Readonly<Record<string, readonly SnapshotEntry[]>> = {
	"": [
		{ name: "etc", path: "etc", kind: "folder" },
		{ name: "home", path: "home", kind: "folder" },
		{ name: "var", path: "var", kind: "folder" },
	],
	etc: [
		{ name: "hostname", path: "etc/hostname", kind: "file", sizeBytes: 11, modifiedAt: FIXTURE_NOW - 3 * HOUR },
		{ name: "os-release", path: "etc/os-release", kind: "file", sizeBytes: 386, modifiedAt: FIXTURE_NOW - 40 * DAY },
	],
	home: [{ name: "user", path: "home/user", kind: "folder" }],
	"home/user": [
		{ name: "app", path: "home/user/app", kind: "folder" },
		{ name: ".bashrc", path: "home/user/.bashrc", kind: "file", sizeBytes: 3_771, modifiedAt: FIXTURE_NOW - 9 * DAY },
		{
			name: "notes.md",
			path: "home/user/notes.md",
			kind: "file",
			sizeBytes: 412,
			modifiedAt: FIXTURE_NOW - 20 * MINUTE,
		},
	],
	"home/user/app": [
		{ name: "src", path: "home/user/app/src", kind: "folder" },
		{
			name: "docker-compose.yml",
			path: "home/user/app/docker-compose.yml",
			kind: "file",
			sizeBytes: 640,
			modifiedAt: FIXTURE_NOW - 2 * DAY,
		},
		{
			name: "package.json",
			path: "home/user/app/package.json",
			kind: "file",
			sizeBytes: 822,
			modifiedAt: FIXTURE_NOW - 2 * DAY,
		},
		{
			name: "screenshot.png",
			path: "home/user/app/screenshot.png",
			kind: "file",
			sizeBytes: 248_113,
			modifiedAt: FIXTURE_NOW - HOUR,
		},
	],
	"home/user/app/src": [
		{
			name: "server.ts",
			path: "home/user/app/src/server.ts",
			kind: "file",
			sizeBytes: 1_204,
			modifiedAt: FIXTURE_NOW - 30 * MINUTE,
		},
	],
	var: [{ name: "log", path: "var/log", kind: "folder" }],
	"var/log": [
		{ name: "syslog", path: "var/log/syslog", kind: "file", sizeBytes: 2_481_662, modifiedAt: FIXTURE_NOW - MINUTE },
	],
};

const FILES: Readonly<Record<string, string>> = {
	"etc/hostname": "api-server\n",
	"etc/os-release": 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\n',
	"home/user/.bashrc": "# ~/.bashrc\nexport PATH=$HOME/.local/bin:$PATH\nalias ll='ls -la'\n",
	"home/user/notes.md":
		"# Notes\n\n- The API listens on 3000; `kantel url 3000` gives its public address.\n- Postgres runs in Docker (`docker compose up -d db`).\n",
	"home/user/app/docker-compose.yml":
		"services:\n  db:\n    image: postgres:17\n    environment:\n      POSTGRES_PASSWORD: dev\n    ports:\n      - 5432:5432\n",
	"home/user/app/package.json":
		'{\n  "name": "app",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "node --watch src/server.ts"\n  }\n}\n',
	"home/user/app/src/server.ts":
		'import { createServer } from "node:http";\n\ncreateServer((_, res) => res.end("ok")).listen(3000);\n',
};

export const KEYS: readonly ApiKey[] = [
	{
		id: "key_ci",
		name: "GitHub Actions",
		prefix: "kt_live_4f8a",
		accountId: LLEVERAGE.id,
		scopes: [
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
		createdAt: FIXTURE_NOW - 20 * DAY,
		createdBy: "Alex Kemp",
		lastUsedAt: FIXTURE_NOW - 4 * MINUTE,
		expiresAt: FIXTURE_NOW + 70 * DAY,
	},
	{
		id: "key_claude",
		name: "Claude Code on Tom's laptop",
		prefix: "kt_live_91c2",
		accountId: LLEVERAGE.id,
		scopes: ["sandboxes:read", "sandboxes:write", "exec", "files", "access", "snapshots:read"],
		createdAt: FIXTURE_NOW - 3 * DAY,
		createdBy: "Tom Davies",
		lastUsedAt: FIXTURE_NOW - 40 * MINUTE,
	},
	{
		id: "key_grafana",
		name: "Usage dashboard",
		prefix: "kt_live_0b7d",
		accountId: LLEVERAGE.id,
		scopes: ["sandboxes:read", "snapshots:read", "account:read"],
		createdAt: FIXTURE_NOW - 60 * DAY,
		createdBy: "Bethan Price",
		lastUsedAt: FIXTURE_NOW - 2 * DAY,
	},
	{
		id: "key_old",
		name: "Old deploy key",
		prefix: "kt_live_77e0",
		accountId: LLEVERAGE.id,
		scopes: ["sandboxes:write"],
		createdAt: FIXTURE_NOW - 120 * DAY,
		createdBy: "Dean Smit",
		lastUsedAt: FIXTURE_NOW - 50 * DAY,
		revokedAt: FIXTURE_NOW - 30 * DAY,
	},
];

export const PROXY: ProxySettings = {
	accountId: LLEVERAGE.id,
	enabled: true,
	policy: "allowlist",
	allow: ["api.github.com", "*.githubusercontent.com", "registry.npmjs.org", "pypi.org", "*.pythonhosted.org"],
	deny: ["169.254.169.254"],
	upstream: { url: "https://mehen.internal.example.com:8443", authSet: true },
	tlsInspection: true,
	headers: [
		{ id: "hdr_gh", host: "api.github.com", header: "Authorization", set: true },
		{ id: "hdr_npm", host: "registry.npmjs.org", header: "Authorization", set: true },
	],
	logRequests: true,
};

const proxyRequest = (
	id: string,
	ago: number,
	box: Sandbox,
	method: string,
	host: string,
	path: string,
	status: number,
	decision: ProxyRequest["decision"],
	bytes: number,
): ProxyRequest => ({
	id,
	at: FIXTURE_NOW - ago,
	sandboxId: box.id,
	sandboxName: box.name,
	method,
	host,
	path,
	status,
	decision,
	bytes,
});

export const PROXY_REQUESTS: readonly ProxyRequest[] = [
	proxyRequest("req_1", 4_000, API_SERVER, "GET", "registry.npmjs.org", "/react", 200, "allowed", 18_220),
	proxyRequest(
		"req_2",
		9_000,
		DEV_STACK,
		"POST",
		"api.github.com",
		"/repos/lleverage-ai/kantel/pulls",
		201,
		"allowed",
		4_210,
	),
	proxyRequest("req_3", 31_000, SCRATCH, "GET", "example-tracker.io", "/collect", 403, "denied", 0),
	proxyRequest("req_4", 75_000, DEV_STACK, "GET", "pypi.org", "/simple/httpx/", 200, "allowed", 9_871),
	proxyRequest("req_5", 2 * MINUTE, API_SERVER, "GET", "169.254.169.254", "/latest/meta-data/", 403, "denied", 0),
];

const delivery = (
	id: string,
	event: WebhookDelivery["event"],
	ago: number,
	status: number | undefined,
	attempt = 1,
): WebhookDelivery => ({
	id,
	event,
	at: FIXTURE_NOW - ago,
	...(status === undefined ? {} : { status }),
	durationMs: status === undefined ? 10_000 : 120 + ((id.length * 37) % 200),
	attempt,
	ok: status !== undefined && status < 300,
});

export const DELIVERIES: Readonly<Record<string, readonly WebhookDelivery[]>> = {
	whk_slack: [
		delivery("dlv_1", "sandbox.error", 12 * MINUTE, 200),
		delivery("dlv_2", "sandbox.running", 50 * MINUTE, 200),
		delivery("dlv_3", "sandbox.stopped", 20 * HOUR, 200),
	],
	whk_ops: [
		delivery("dlv_4", "sandbox.stopped", 20 * HOUR, undefined, 3),
		delivery("dlv_5", "sandbox.stopped", 20 * HOUR + 5 * MINUTE, 503, 2),
		delivery("dlv_6", "sandbox.stopped", 20 * HOUR + 6 * MINUTE, 503, 1),
	],
};

export const WEBHOOKS: readonly Webhook[] = [
	{
		id: "whk_slack",
		accountId: LLEVERAGE.id,
		url: "https://hooks.example.com/kantel/sandbox-alerts",
		description: "Alerts channel",
		events: ["sandbox.error", "sandbox.running", "sandbox.stopped"],
		enabled: true,
		createdAt: FIXTURE_NOW - 14 * DAY,
		secretPrefix: "whsec_9c1e",
		lastDelivery: DELIVERIES.whk_slack?.[0] as WebhookDelivery,
	},
	{
		id: "whk_ops",
		accountId: LLEVERAGE.id,
		url: "https://ops.example.com/webhooks/kantel",
		events: ["sandbox.stopped", "sandbox.deleted", "snapshot.saved"],
		enabled: true,
		createdAt: FIXTURE_NOW - 40 * DAY,
		secretPrefix: "whsec_44ab",
		lastDelivery: DELIVERIES.whk_ops?.[0] as WebhookDelivery,
	},
];

export const TELEMETRY: TelemetrySettings = {
	accountId: LLEVERAGE.id,
	enabled: true,
	endpoint: "https://otlp-gateway-prod-eu-west-2.grafana.net/otlp",
	protocol: "http/protobuf",
	headers: ["Authorization"],
	metrics: true,
	events: true,
	attributes: { "deployment.environment": "production", team: "platform" },
	lastExport: { at: FIXTURE_NOW - 30_000, ok: true },
};

export const HOSTS: readonly Host[] = [
	{
		id: "hst_hetzner_1",
		name: "hetzner-fsn1-01",
		state: "online",
		arch: "x86_64",
		os: "Ubuntu 24.04",
		version: "0.4.2",
		vcpus: 64,
		memoryGb: 256,
		diskGb: 3_840,
		used: { vcpus: 38, memoryGb: 141, diskGb: 1_210 },
		sandboxes: { isolates: 112, microvms: 14 },
		kvm: true,
		nestedVirtualisation: true,
		labels: { site: "fsn1", tier: "microvm" },
		lastSeenAt: FIXTURE_NOW - 3_000,
		joinedAt: FIXTURE_NOW - 30 * DAY,
	},
	{
		id: "hst_hetzner_2",
		name: "hetzner-fsn1-02",
		state: "draining",
		arch: "x86_64",
		os: "Ubuntu 24.04",
		version: "0.4.1",
		updateAvailable: "0.4.2",
		vcpus: 64,
		memoryGb: 256,
		diskGb: 3_840,
		used: { vcpus: 12, memoryGb: 40, diskGb: 2_960 },
		sandboxes: { isolates: 4, microvms: 3 },
		kvm: true,
		nestedVirtualisation: true,
		labels: { site: "fsn1", tier: "microvm" },
		lastSeenAt: FIXTURE_NOW - 5_000,
		joinedAt: FIXTURE_NOW - 30 * DAY,
	},
	{
		id: "hst_home",
		name: "home-server",
		state: "online",
		arch: "x86_64",
		os: "Debian 13",
		version: "0.4.2",
		vcpus: 16,
		memoryGb: 64,
		diskGb: 1_000,
		used: { vcpus: 6, memoryGb: 21, diskGb: 310 },
		sandboxes: { isolates: 37, microvms: 2 },
		kvm: true,
		nestedVirtualisation: false,
		labels: { owner: "tom", site: "home" },
		lastSeenAt: FIXTURE_NOW - 2_000,
		joinedAt: FIXTURE_NOW - 6 * DAY,
	},
	{
		id: "hst_mac",
		name: "toms-macbook",
		state: "offline",
		arch: "aarch64",
		os: "macOS 15 (helper VM)",
		version: "0.4.0",
		updateAvailable: "0.4.2",
		vcpus: 8,
		memoryGb: 24,
		diskGb: 200,
		used: { vcpus: 0, memoryGb: 0, diskGb: 22 },
		sandboxes: { isolates: 0, microvms: 0 },
		kvm: true,
		nestedVirtualisation: false,
		labels: { owner: "tom", site: "laptop" },
		lastSeenAt: FIXTURE_NOW - 14 * HOUR,
		joinedAt: FIXTURE_NOW - 3 * DAY,
	},
];

export const PLANS: readonly Plan[] = [
	{
		id: "plan_hobby",
		name: "Hobby",
		priceCents: 0,
		concurrent: 2,
		startsPerMinute: 5,
		includedCents: 500,
		savedSnapshots: 2,
		sizes: ["small", "medium"],
	},
	{
		id: "plan_starter",
		name: "Starter",
		priceCents: 2_000,
		concurrent: 50,
		startsPerMinute: 20,
		includedCents: 2_000,
		savedSnapshots: 10,
		sizes: ["small", "medium", "large"],
	},
	{
		id: "plan_team",
		name: "Team",
		priceCents: 10_000,
		concurrent: 250,
		startsPerMinute: 60,
		includedCents: 10_000,
		savedSnapshots: 50,
		sizes: ["small", "medium", "large", "xlarge"],
	},
	{
		id: "plan_scale",
		name: "Scale",
		priceCents: 50_000,
		concurrent: 1_000,
		startsPerMinute: 200,
		includedCents: 50_000,
		savedSnapshots: 250,
		sizes: ["small", "medium", "large", "xlarge"],
	},
];

export const MEMBERS: readonly OrganisationMember[] = [
	{ id: "usr_tom", name: "Tom Davies", email: "tom@example.com", role: "admin", joinedAt: FIXTURE_NOW - 90 * DAY },
	{ id: "usr_alex", name: "Alex Kemp", email: "alex@example.com", role: "owner", joinedAt: FIXTURE_NOW - 120 * DAY },
	{
		id: "usr_bethan",
		name: "Bethan Price",
		email: "bethan@example.com",
		role: "member",
		joinedAt: FIXTURE_NOW - 90 * DAY,
	},
	{ id: "usr_dean", name: "Dean Smit", email: "dean@example.com", role: "member", joinedAt: FIXTURE_NOW - 90 * DAY },
	{ id: "usr_ci", name: "ci-runner", email: "ci@example.com", role: "member", joinedAt: FIXTURE_NOW - 20 * DAY },
	{ id: "usr_maya", name: "Maya Osei", email: "maya@example.com", role: "member", joinedAt: FIXTURE_NOW - 2 * DAY },
];

export const INVITES: readonly OrganisationInvite[] = [
	{ id: "inv_1", email: "sam@example.com", role: "member", sentAt: FIXTURE_NOW - 5 * HOUR },
];

export const COMMANDS: readonly SandboxCommand[] = [
	{
		id: "cmd_5",
		command: "npm test",
		startedAt: FIXTURE_NOW - 3 * MINUTE,
		durationMs: 41_200,
		exitCode: 0,
		by: "GitHub Actions",
	},
	{
		id: "cmd_4",
		command: "docker compose up -d db",
		startedAt: FIXTURE_NOW - 18 * MINUTE,
		durationMs: 6_100,
		exitCode: 0,
		by: "Tom Davies",
	},
	{
		id: "cmd_3",
		command: "npm ci",
		startedAt: FIXTURE_NOW - 19 * MINUTE,
		durationMs: 22_870,
		exitCode: 0,
		by: "Tom Davies",
	},
	{
		id: "cmd_2",
		command: "git clone https://github.com/lleverage-ai/kantel app",
		startedAt: FIXTURE_NOW - 21 * MINUTE,
		durationMs: 3_400,
		exitCode: 0,
		by: "Claude Code on Tom's laptop",
	},
	{
		id: "cmd_1",
		command: "node --version",
		startedAt: FIXTURE_NOW - 22 * MINUTE,
		durationMs: 90,
		exitCode: 0,
		by: "Claude Code on Tom's laptop",
	},
];

export interface ComputeFixtureOptions {
	readonly hosting?: HostingMode;
	/** The time the source is at; default `FIXTURE_NOW`. Pass `Date.now()` for a live console. */
	readonly now?: number;
	/** Every read waits forever: a loading state. */
	readonly hang?: boolean;
	/** Every read fails: an error state. */
	readonly fail?: boolean;
	/** No sandboxes, snapshots, keys, webhooks or hosts: the empty states. */
	readonly empty?: boolean;
	/** How long a sandbox takes to start or stop, in milliseconds. Default 1200. */
	readonly settleMs?: number;
	/** The viewer is not a super-admin. */
	readonly notSuperAdmin?: boolean;
}

let counter = 0;
const nextId = (prefix: string): string => {
	counter += 1;
	const tail = (Date.now() + counter * 7_919).toString(36).slice(-8);
	return `${prefix}_${tail}${counter.toString(36)}`;
};

/** A secret the fixtures hand out once: not a real credential. */
const fakeSecret = (prefix: string): string =>
	`${prefix}${Array.from({ length: 32 }, (_, at) => "abcdefghjkmnpqrstuvwxyz23456789"[(at * 7 + counter * 3) % 31]).join("")}`;

/** In-memory sample data behind every page of the compute console. */
export function createComputeFixtures(options: ComputeFixtureOptions = {}): ComputeSource {
	const hosting = options.hosting ?? "self-hosted";
	const base = FIXTURE_NOW;
	// Shift every time onto `now`, so a live console shows ages and countdowns from the moment it opened.
	const shift = (options.now ?? base) - base;
	const at = (time: number): number => time + shift;
	const now = (): number => (options.now === undefined ? base : Date.now());
	const settleMs = options.settleMs ?? 1200;
	const empty = options.empty === true;

	const moved = <T extends object>(record: T, keys: readonly (keyof T)[]): T => {
		const copy = { ...record } as Record<string, unknown>;
		for (const key of keys) {
			const value = copy[key as string];
			if (typeof value === "number") copy[key as string] = at(value);
		}
		return copy as T;
	};
	const withCost = (box: Sandbox): Sandbox => {
		if (hosting === "hosted") return box;
		const { costCents: _, ...rest } = box;
		return rest;
	};

	const sandboxes = new Map<string, Sandbox>(
		(empty ? [] : SANDBOXES).map((box) => {
			const copy = moved(box, ["createdAt", "stopsAt"]);
			const snapshot =
				box.snapshot === undefined ? {} : { snapshot: { ...box.snapshot, takenAt: at(box.snapshot.takenAt) } };
			return [box.id, withCost({ ...copy, ...snapshot })];
		}),
	);
	const saved = new Map<string, SavedSnapshot>(
		(empty ? [] : SAVED).map((entry) => [entry.id, moved(entry, ["createdAt"])]),
	);
	const history = new Map<string, SandboxSnapshot[]>(
		[...sandboxes.values()].map((box) => [box.id, [...historyFor(box)]]),
	);
	const keys = new Map<string, ApiKey>(
		(empty ? [] : KEYS).map((key) => [key.id, moved(key, ["createdAt", "lastUsedAt", "expiresAt", "revokedAt"])]),
	);
	const webhooks = new Map<string, Webhook>(
		(empty ? [] : WEBHOOKS).map((hook) => [
			hook.id,
			{
				...moved(hook, ["createdAt"]),
				...(hook.lastDelivery === undefined ? {} : { lastDelivery: moved(hook.lastDelivery, ["at"]) }),
			},
		]),
	);
	const deliveries = new Map<string, WebhookDelivery[]>(
		Object.entries(DELIVERIES).map(([id, list]) => [id, list.map((entry) => moved(entry, ["at"]))]),
	);
	const hosts = new Map<string, Host>(
		(empty ? [] : HOSTS).map((host) => [host.id, moved(host, ["lastSeenAt", "joinedAt"])]),
	);
	const proxies = new Map<string, ProxySettings>();
	const telemetry = new Map<string, TelemetrySettings>();
	const accounts: ComputeAccount[] = [PERSONAL, LLEVERAGE, EVALS];
	const members = new Map<string, OrganisationMember[]>([
		[LLEVERAGE.id, MEMBERS.map((member) => moved(member, ["joinedAt"]))],
		[EVALS.id, MEMBERS.slice(0, 3).map((member) => moved(member, ["joinedAt"]))],
	]);
	const invites = new Map<string, OrganisationInvite[]>([
		[LLEVERAGE.id, INVITES.map((invite) => moved(invite, ["sentAt"]))],
	]);
	let planOf = new Map<string, string>(accounts.map((account) => [account.id, account.planId ?? "plan_starter"]));
	// One command line waiting to sign in, as `kantel login` on a build machine shows its code.
	const deviceLogins = new Map<string, DeviceLogin>([
		[
			FIXTURE_DEVICE_CODE,
			{
				userCode: FIXTURE_DEVICE_CODE,
				clientName: "kantel on build-01",
				state: "pending",
				createdAt: at(base - MINUTE),
				expiresAt: at(base + 14 * MINUTE),
			},
		],
	]);
	const deviceLogin = (userCode: string): DeviceLogin => {
		const typed = userCode.toUpperCase().replace(/[^A-Z]/g, "");
		return find(deviceLogins, `${typed.slice(0, 4)}-${typed.slice(4)}`, "sign-in with the code");
	};
	const decide = (userCode: string, state: "approved" | "denied"): DeviceLogin => {
		const login = deviceLogin(userCode);
		if (login.state !== "pending") throw new Error(`That sign-in is already ${login.state}.`);
		const decided = { ...login, state };
		deviceLogins.set(login.userCode, decided);
		return decided;
	};

	const gate = async <T>(make: () => T | Promise<T>): Promise<T> => {
		if (options.hang === true) return new Promise<T>(() => {});
		if (options.fail === true) throw new Error("Kantel can't be reached right now.");
		await new Promise((resolve) => setTimeout(resolve, 60));
		return make();
	};
	const find = <T>(map: Map<string, T>, id: string, what: string): T => {
		const found = map.get(id);
		if (found === undefined) throw new Error(`No ${what} ${id}.`);
		return found;
	};
	const put = (box: Sandbox): Sandbox => {
		sandboxes.set(box.id, box);
		return box;
	};
	/** Moves a sandbox to `to` after `settleMs`, as a host would report. */
	const settle = (id: string, to: (box: Sandbox) => Sandbox) => {
		setTimeout(() => {
			const box = sandboxes.get(id);
			if (box !== undefined) put(to(box));
		}, settleMs);
	};
	const snapshotNow = (box: Sandbox, reason: SandboxSnapshot["reason"]): SandboxSnapshot => {
		const snap: SandboxSnapshot = {
			id: nextId("snp"),
			sandboxId: box.id,
			takenAt: now(),
			reason,
			sizeBytes: Math.round(sizeSpec(box.size).diskGb * 1024 ** 3 * 0.09),
			expiresAt: now() + 14 * DAY,
		};
		history.set(box.id, [snap, ...(history.get(box.id) ?? [])]);
		return snap;
	};
	const slugOf = (accountId: string) => accounts.find((account) => account.id === accountId)?.slug ?? "you";

	const source: ComputeSource = {
		hosting,
		domain: "kantel.example.com",
		accounts: {
			viewer: () => gate(() => (options.notSuperAdmin === true ? { ...VIEWER, superAdmin: false } : VIEWER)),
			list: () => gate(() => [...accounts]),
			createOrganisation: (input) =>
				gate(() => {
					const account: ComputeAccount = {
						id: nextId("org"),
						kind: "organisation",
						name: input.name,
						slug: input.slug,
						role: "owner",
						members: 1,
						planId: "plan_starter",
					};
					accounts.push(account);
					members.set(account.id, [
						{ id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, role: "owner", joinedAt: now() },
					]);
					planOf = new Map(planOf).set(account.id, "plan_starter");
					return account;
				}),
			join: (code) =>
				gate(() => {
					if (code.trim().length < 6) throw new Error("That code isn't right. Check it and try again.");
					const account: ComputeAccount = {
						id: nextId("org"),
						kind: "organisation",
						name: "Design partners",
						slug: "partners",
						role: "member",
						members: 4,
					};
					accounts.push(account);
					return account;
				}),
			members: (accountId) => gate(() => members.get(accountId) ?? []),
			invites: (accountId) => gate(() => invites.get(accountId) ?? []),
			invite: (accountId, input) =>
				gate(() => {
					const invite: OrganisationInvite = { id: nextId("inv"), email: input.email, role: input.role, sentAt: now() };
					invites.set(accountId, [...(invites.get(accountId) ?? []), invite]);
					// The code comes back once, with the invite just made, and is never listed.
					return { ...invite, code: fakeSecret("kji_") };
				}),
			revokeInvite: (accountId, inviteId) =>
				gate(() => {
					invites.set(
						accountId,
						(invites.get(accountId) ?? []).filter((invite) => invite.id !== inviteId),
					);
				}),
			removeMember: (accountId, memberId) =>
				gate(() => {
					members.set(
						accountId,
						(members.get(accountId) ?? []).filter((member) => member.id !== memberId),
					);
				}),
			leave: (accountId) =>
				gate(() => {
					const at = accounts.findIndex((account) => account.id === accountId);
					if (at > 0) accounts.splice(at, 1);
				}),
		},
		sandboxes: {
			list: (accountId) =>
				gate(() =>
					[...sandboxes.values()]
						.filter((box) => box.accountId === accountId)
						.sort((a, b) => b.createdAt - a.createdAt),
				),
			create: (input: CreateSandboxInput) =>
				gate(() => {
					const id = nextId("sbx");
					const name = input.name?.trim() || `sandbox-${id.slice(-4)}`;
					const box: Sandbox = {
						id,
						name,
						hostname: `${name}.${slugOf(input.accountId)}.kantel.example.com`,
						accountId: input.accountId,
						kind: input.kind,
						size: input.size,
						state: "starting",
						createdAt: now(),
						createdBy: VIEWER.name,
						...(input.autoStopMinutes === undefined ? {} : { stopsAt: now() + input.autoStopMinutes * MINUTE }),
						usage: flat(),
						...(hosting === "hosted" ? { costCents: 0 } : {}),
						hostId: input.kind === "isolate" ? "hst_home" : "hst_hetzner_1",
						shared: input.accountId !== PERSONAL.id,
					};
					put(box);
					history.set(id, []);
					// An isolate is up almost at once; a microVM from a snapshot in about a second.
					settle(id, (current) => ({ ...current, state: "running", usage: usageSeries(id.length, 0.3) }));
					return box;
				}),
			stop: (id) =>
				gate(() => {
					const box = put({ ...find(sandboxes, id, "sandbox"), state: "stopping" });
					settle(id, (current) => {
						const snap = snapshotNow(current, "stop");
						const { stopsAt: _, ...rest } = current;
						return { ...rest, state: "stopped", snapshot: { id: snap.id, takenAt: snap.takenAt }, usage: flat() };
					});
					return box;
				}),
			resume: (id) =>
				gate(() => {
					const { error: _, ...current } = find(sandboxes, id, "sandbox");
					const box = put({ ...current, state: "starting", stopsAt: now() + HOUR });
					settle(id, (latest) => ({ ...latest, state: "running", usage: usageSeries(id.length + 3, 0.3) }));
					return box;
				}),
			fork: (id) =>
				gate(() => {
					const from = find(sandboxes, id, "sandbox");
					const forkId = nextId("sbx");
					const name = `${from.name}-fork`;
					const box: Sandbox = {
						...from,
						id: forkId,
						name,
						hostname: `${name}.${slugOf(from.accountId)}.kantel.example.com`,
						state: "starting",
						createdAt: now(),
						createdBy: VIEWER.name,
						stopsAt: now() + HOUR,
						usage: flat(),
						forkedFrom: from.id,
						...(hosting === "hosted" ? { costCents: 0 } : {}),
					};
					put(box);
					history.set(forkId, []);
					settle(forkId, (current) => ({ ...current, state: "running", usage: usageSeries(forkId.length, 0.3) }));
					return box;
				}),
			recover: (id) =>
				gate(() => {
					const { error: _, ...current } = find(sandboxes, id, "sandbox");
					const box = put({ ...current, state: "starting" });
					settle(id, (latest) => ({ ...latest, state: "running", stopsAt: now() + HOUR }));
					return box;
				}),
			remove: (id) =>
				gate(() => {
					find(sandboxes, id, "sandbox");
					sandboxes.delete(id);
					history.delete(id);
				}),
			access: (id) =>
				gate(() => {
					const box = find(sandboxes, id, "sandbox");
					const token = fakeSecret("").slice(0, 16);
					return {
						ssh: `ssh ${box.id}@ssh.kantel.example.com`,
						desktopUrl: `https://${box.hostname}/desktop?token=${token}`,
						browserUrl: `https://${box.hostname}/browser?token=${token}`,
					};
				}),
			history: (id) =>
				gate(() => {
					find(sandboxes, id, "sandbox");
					return COMMANDS.map((command) => moved(command, ["startedAt"]));
				}),
		},
		snapshots: {
			saved: (accountId) =>
				gate(() =>
					[...saved.values()]
						.filter((entry) => entry.accountId === accountId)
						.sort((a, b) => b.createdAt - a.createdAt),
				),
			history: (sandboxId) => gate(() => [...(history.get(sandboxId) ?? [])]),
			save: (sandboxId, name) =>
				gate(() => {
					const box = find(sandboxes, sandboxId, "sandbox");
					if ([...saved.values()].some((entry) => entry.accountId === box.accountId && entry.name === name)) {
						throw new Error(`There's already a saved snapshot called ${name}.`);
					}
					const entry: SavedSnapshot = {
						id: nextId("ssn"),
						name,
						accountId: box.accountId,
						sandboxId: box.id,
						sandboxName: box.name,
						kind: box.kind,
						createdAt: now(),
						createdBy: VIEWER.name,
						sizeBytes: Math.round(sizeSpec(box.size).diskGb * 1024 ** 3 * 0.1),
						uses: 0,
					};
					saved.set(entry.id, entry);
					return entry;
				}),
			removeSaved: (id) =>
				gate(() => {
					saved.delete(id);
				}),
			removeSnapshot: (id) =>
				gate(() => {
					for (const [sandboxId, list] of history) {
						history.set(
							sandboxId,
							list.filter((snap) => snap.id !== id),
						);
					}
				}),
			list: (_snapshotId, path) =>
				gate(() => (TREE[path.replace(/^\/+|\/+$/g, "")] ?? []).map((entry) => moved(entry, ["modifiedAt"]))),
			read: (_snapshotId, path) => gate(() => FILES[path.replace(/^\/+/, "")]),
			downloadUrl: (snapshotId, path) =>
				`https://kantel.example.com/v1/snapshots/${encodeURIComponent(snapshotId)}/download?path=${encodeURIComponent(path)}`,
		},
		keys: {
			list: (accountId) =>
				gate(() =>
					[...keys.values()].filter((key) => key.accountId === accountId).sort((a, b) => b.createdAt - a.createdAt),
				),
			create: (input) =>
				gate(() => {
					const secret = fakeSecret("kt_live_");
					const key: ApiKey = {
						id: nextId("key"),
						name: input.name,
						prefix: secret.slice(0, 12),
						accountId: input.accountId,
						scopes: [...input.scopes] as ApiScope[],
						createdAt: now(),
						createdBy: VIEWER.name,
						...(input.expiresInDays === undefined ? {} : { expiresAt: now() + input.expiresInDays * DAY }),
					};
					keys.set(key.id, key);
					return { key, secret };
				}),
			revoke: (id) =>
				gate(() => {
					const key = { ...find(keys, id, "key"), revokedAt: now() };
					keys.set(id, key);
					return key;
				}),
		},
		proxy: {
			get: (accountId) =>
				gate(
					() =>
						proxies.get(accountId) ??
						(accountId === LLEVERAGE.id
							? { ...PROXY }
							: {
									accountId,
									enabled: false,
									policy: "open",
									allow: [],
									deny: [],
									tlsInspection: false,
									headers: [],
									logRequests: false,
								}),
				),
			update: (accountId, change) =>
				gate(async () => {
					const current = proxies.get(accountId) ?? (await source.proxy.get(accountId));
					const { upstream, headers, ...rest } = change;
					const next: ProxySettings = {
						...current,
						...rest,
						...(headers === undefined
							? {}
							: {
									headers: headers.map(({ value, ...header }) => ({
										...header,
										set: header.set || value !== undefined,
									})),
								}),
					};
					const withUpstream: ProxySettings =
						upstream === undefined
							? next
							: upstream === null
								? (({ upstream: _, ...without }) => without)(next)
								: {
										...next,
										upstream: {
											url: upstream.url,
											authSet: upstream.auth !== undefined || current.upstream?.authSet === true,
										},
									};
					proxies.set(accountId, withUpstream);
					return withUpstream;
				}),
			recent: (accountId) =>
				gate(() => (accountId === LLEVERAGE.id && !empty ? PROXY_REQUESTS.map((entry) => moved(entry, ["at"])) : [])),
		},
		webhooks: {
			list: (accountId) => gate(() => [...webhooks.values()].filter((hook) => hook.accountId === accountId)),
			create: (input) =>
				gate(() => {
					const secret = fakeSecret("whsec_");
					const webhook: Webhook = {
						id: nextId("whk"),
						accountId: input.accountId,
						url: input.url,
						...(input.description === undefined || input.description === "" ? {} : { description: input.description }),
						events: [...input.events],
						enabled: true,
						createdAt: now(),
						secretPrefix: secret.slice(0, 10),
					};
					webhooks.set(webhook.id, webhook);
					return { webhook, secret };
				}),
			update: (id, change) =>
				gate(() => {
					const webhook = { ...find(webhooks, id, "webhook"), ...change };
					webhooks.set(id, webhook);
					return webhook;
				}),
			remove: (id) =>
				gate(() => {
					webhooks.delete(id);
				}),
			deliveries: (id) => gate(() => deliveries.get(id) ?? []),
			test: (id) =>
				gate(() => {
					const hook = find(webhooks, id, "webhook");
					const sent: WebhookDelivery = {
						id: nextId("dlv"),
						event: hook.events[0] ?? "sandbox.running",
						at: now(),
						status: 200,
						durationMs: 143,
						attempt: 1,
						ok: true,
					};
					deliveries.set(id, [sent, ...(deliveries.get(id) ?? [])]);
					webhooks.set(id, { ...hook, lastDelivery: sent });
					return sent;
				}),
		},
		telemetry: {
			get: (accountId) =>
				gate(
					() =>
						telemetry.get(accountId) ??
						(accountId === LLEVERAGE.id
							? { ...TELEMETRY, lastExport: { at: at(TELEMETRY.lastExport?.at ?? base), ok: true } }
							: {
									accountId,
									enabled: false,
									endpoint: "",
									protocol: "http/protobuf",
									headers: [],
									metrics: true,
									events: true,
									attributes: {},
								}),
				),
			update: (accountId, change) =>
				gate(async () => {
					const current = telemetry.get(accountId) ?? (await source.telemetry.get(accountId));
					const { headers, ...rest } = change;
					const names = new Set(current.headers);
					for (const [name, value] of Object.entries(headers ?? {})) {
						if (value === null) names.delete(name);
						else names.add(name);
					}
					const next: TelemetrySettings = { ...current, ...rest, headers: [...names] };
					telemetry.set(accountId, next);
					return next;
				}),
			test: (accountId) =>
				gate(async () => {
					const current = telemetry.get(accountId) ?? (await source.telemetry.get(accountId));
					if (current.endpoint === "") return { ok: false, message: "Set an endpoint first." };
					return { ok: true, message: "Sent a test metric and event. The collector answered 200 in 182 ms." };
				}),
		},
		...(options.notSuperAdmin === true
			? {}
			: {
					hosts: {
						list: () => gate(() => [...hosts.values()]),
						// The command as the control plane makes it (packages/compute, createHostJoinToken): the host's name and
						// labels go with the token, not on the command line.
						join: () =>
							gate(() => {
								const token = fakeSecret("kth_");
								return {
									token,
									expiresAt: now() + HOUR,
									command: `curl -fsSL https://kantel.example.com/install-host.sh | sh -s -- --join ${token}`,
								};
							}),
						drain: (id) =>
							gate(() => {
								const host = { ...find(hosts, id, "host"), state: "draining" as const };
								hosts.set(id, host);
								return host;
							}),
						undrain: (id) =>
							gate(() => {
								const host = { ...find(hosts, id, "host"), state: "online" as const };
								hosts.set(id, host);
								return host;
							}),
						remove: (id) =>
							gate(() => {
								hosts.delete(id);
							}),
					},
				}),
		devices: {
			get: (userCode) => gate(() => deviceLogin(userCode)),
			approve: (userCode) => gate(() => decide(userCode, "approved")),
			deny: (userCode) => gate(() => decide(userCode, "denied")),
		},
		...(hosting !== "hosted"
			? {}
			: {
					billing: {
						plans: () => gate(() => PLANS),
						summary: (accountId) => gate(() => summaryFor(accountId)),
						changePlan: (accountId, planId) =>
							gate(() => {
								planOf = new Map(planOf).set(accountId, planId);
								return summaryFor(accountId);
							}),
					},
				}),
	};

	function summaryFor(accountId: string): BillingSummary {
		const plan = PLANS.find((entry) => entry.id === planOf.get(accountId)) ?? (PLANS[1] as Plan);
		const boxes = [...sandboxes.values()].filter((box) => box.accountId === accountId);
		const used = boxes.reduce((sum, box) => sum + (box.costCents ?? 0), 0);
		const start = Date.UTC(2026, 10, 1) + shift;
		return {
			accountId,
			plan,
			periodStart: start,
			periodEnd: Date.UTC(2026, 11, 1) + shift,
			usedCents: used,
			running: boxes.filter((box) => box.state === "running").length,
			savedSnapshots: [...saved.values()].filter((entry) => entry.accountId === accountId).length,
			daily: [Math.round(used * 0.35), Math.round(used * 0.45), Math.round(used * 0.2)],
		};
	}

	return source;
}
