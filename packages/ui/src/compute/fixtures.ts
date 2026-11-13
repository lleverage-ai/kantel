// Sample data for the compute console's pages: a personal account and two organisations, sandboxes in every state on
// both tiers (some on an outdated base image), snapshots with a small file tree, keys, a proxy, webhooks, telemetry,
// three hosts, the base images with their scans and templates, the hosted plans, and the bundles and bucket sources
// two sandboxes mount read-only.
// `createComputeFixtures` serves it all from memory as a `ComputeSource`, so stories and the console's sample data can
// create, stop, resume, fork and delete. Nothing leaves the page.

import { DAY, HOUR, MINUTE } from "../primitives/format.ts";
import type {
	ApiKey,
	ApiScope,
	BaseImage,
	BaseImagesOverview,
	BaseImageTemplate,
	BaseImageVersion,
	BillingSummary,
	BucketSource,
	Bundle,
	ComputeAccount,
	ComputeSource,
	ComputeViewer,
	CreateSandboxInput,
	DestinationBinding,
	DeviceLogin,
	EgressEntry,
	EgressGrant,
	Environment,
	EnvironmentRef,
	FilePart,
	FileRange,
	Host,
	HostDisk,
	HostingMode,
	ImageBuildReason,
	ImageFinding,
	ImageScan,
	ImageSeverity,
	MountSource,
	OrganisationInvite,
	OrganisationMember,
	PersonalToken,
	Plan,
	Pool,
	ProxySettings,
	PublicUrl,
	Sandbox,
	SandboxBase,
	SandboxCommand,
	SandboxCreator,
	SandboxEgress,
	SandboxEnvironment,
	SandboxImage,
	SandboxKind,
	SandboxPort,
	SandboxProcess,
	SandboxSnapshot,
	SavedSnapshot,
	SnapshotEntry,
	TelemetrySettings,
	UsageRange,
	UsageSeries,
	Webhook,
	WebhookDelivery,
} from "./compute-model.ts";
import {
	cliLoginCommand,
	cliSshCommand,
	DEFAULT_SANDBOX_SHAPES,
	FilesRefusedError,
	MAX_SANDBOX_ENVIRONMENTS,
	POOL_NAME_PATTERN,
	presetOf,
	type SandboxSize,
	sameProxySettings,
	sandboxScreen,
	sizeSpec,
	sshWithoutCliCommand,
	startingSnapshot,
} from "./compute-model.ts";
import { inUseText } from "./mounts.ts";
import { createTemplateFixtures } from "./template-fixtures.ts";
import { stubUsage } from "./usage-stub.ts";

/** The code the fixtures' waiting command line showed: an older one, asking for an API key in one account. */
export const FIXTURE_DEVICE_CODE = "BCDF-GHJK";
/** The code of the fixtures' laptop signing in, which asks for a personal access token. */
export const FIXTURE_PERSONAL_DEVICE_CODE = "MNPQ-RSTV";

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

/** What a sandbox's history range spans, and the interval its points are at, as the API keeps them. */
const HISTORY: Readonly<Record<UsageRange, { readonly spanMs: number; readonly intervalMs: number }>> = {
	"1h": { spanMs: HOUR, intervalMs: 5_000 },
	"24h": { spanMs: DAY, intervalMs: 5 * MINUTE },
	"1w": { spanMs: 7 * DAY, intervalMs: HOUR },
};

/** A running sandbox's busiest processes, as `ps` would list them: a desktop's for one with a screen, else a server's. */
function sampleProcesses(box: Sandbox): readonly SandboxProcess[] {
	const mb = 1024 ** 2;
	// They move a little on each read, as a live list does.
	const wobble = (base: number, at: number) =>
		Math.max(0, Math.round((base + Math.sin(Date.now() / 7_000 + at) * base * 0.15) * 10) / 10);
	const desktop: readonly [string, number, number][] = [
		[
			"/opt/google/chrome/chrome --type=gpu-process --disable-dev-shm-usage --use-gl=angle --use-angle=swiftshader-webgl --field-trial-handle=3,i,1738263561934",
			38.4,
			269,
		],
		["/usr/bin/sunshine /etc/kantel/sunshine.conf", 11.8, 268],
		[
			"/opt/google/chrome/chrome --type=renderer --disable-dev-shm-usage --lang=en-GB --num-raster-threads=2 --enable-main-frame-before-activation",
			6.1,
			204,
		],
		["/usr/lib/xorg/Xorg -core :0 -seat seat0 -auth /var/run/lightdm/root/:0 -nolisten tcp vt7 -novtswitch", 0.8, 50],
		["node /home/kantel/app/node_modules/.bin/next dev --port 3000", 0.6, 302],
		["/usr/local/bin/kantel-guest serve --vsock 1024", 0.3, 18],
		["/usr/sbin/sshd -D -e", 0, 7],
	];
	const server: readonly [string, number, number][] = [
		["node --enable-source-maps dist/server.js --port 8080", 24.6, 412],
		["postgres: kantel app 127.0.0.1(51422) SELECT", 7.2, 96],
		["/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock", 1.4, 88],
		["/usr/bin/containerd", 0.7, 41],
		["redis-server *:6379", 0.4, 12],
		["/usr/local/bin/kantel-guest serve --vsock 1024", 0.3, 18],
		["/usr/sbin/sshd -D -e", 0, 7],
	];
	const rows = sandboxScreen(box) === "desktop" ? desktop : server;
	return rows
		.map(([command, cpu, memory], at) => ({
			pid: 412 + at * 37,
			command,
			cpuPercent: wobble(cpu, at),
			memoryBytes: Math.round(wobble(memory, at + 3) * mb),
		}))
		.sort((a, b) => b.cpuPercent - a.cpuPercent);
}

/** The sample hosts' disk for a microVM of `memoryMb`: the first preset's with at least that memory, else the last's. */
const sampleDisk = (memoryMb: number): number => {
	const presets = DEFAULT_SANDBOX_SHAPES.microvm.presets;
	return (presets.find((preset) => preset.memoryMb >= memoryMb) ?? presets.at(-1))?.diskGb ?? 0;
};

/**
 * The sample's figures for one of its sandboxes: what its host said, else its size's in `SANDBOX_SIZES`, which are this
 * sample's sizes (and no real host's: the console never shows them for a real sandbox).
 */
const sampleSpec = (box: Sandbox): { readonly vcpus: number; readonly memoryGb: number; readonly diskGb: number } =>
	box.resources ?? sizeSpec(box.size ?? "medium");

/** A sample microVM's machine, as its host would say: its size's figures. */
const sampleResources = (size: SandboxSize) => {
	const { vcpus, memoryGb, diskGb } = sizeSpec(size);
	return { vcpus, memoryGb, diskGb };
};

/** The sample's makers by name: its people, and ci-runner, an API key. */
const sampleCreator = (name: string): SandboxCreator =>
	name === VIEWER.name
		? { kind: "user", id: VIEWER.id }
		: name === "ci-runner"
			? { kind: "api_key", id: "key_ci_runner" }
			: { kind: "user", id: `usr_${name.split(" ")[0]?.toLowerCase()}` };

const sandbox = (
	fields: Omit<Sandbox, "hostname" | "usage" | "createdBy"> &
		Partial<Pick<Sandbox, "usage" | "createdBy">> & { readonly slug: string },
): Sandbox => {
	const { slug, ...rest } = fields;
	return {
		createdBy: "Tom Davies",
		creator: sampleCreator(rest.createdBy ?? VIEWER.name),
		usage: rest.state === "running" ? usageSeries(rest.id.length + rest.name.length) : flat(),
		// What its host gave it, as a real one says: the page shows only that (or the shape it asked for).
		...(rest.kind === "microvm" && rest.resources === undefined && rest.size !== undefined
			? { resources: sampleResources(rest.size) }
			: {}),
		...rest,
		hostname: `${rest.name}.${slug}.kantel.example.com`,
	};
};

/** The latest `sandbox` base image on the stable channel: a rebuild for a fixable vulnerability, three hours ago. */
export const SANDBOX_IMAGE_LATEST = { version: "2026.11.04.812", builtAt: FIXTURE_NOW - 3 * HOUR } as const;

/** The latest `browser` base image: the daily rebuild, nine hours ago. */
export const BROWSER_IMAGE_LATEST = { version: "2026.11.03.811", builtAt: FIXTURE_NOW - 9 * HOUR } as const;

/** A base on `image` at `version`: the latest, or behind it by `behind`, with security fixes waiting if `security`. */
const onBase = (
	image: string,
	latest: { readonly version: string; readonly builtAt: number },
	version: string,
	behind?: { readonly days: number; readonly versions: number },
	security = false,
): SandboxBase => ({
	image,
	version,
	outdated: behind !== undefined,
	latest,
	...(behind === undefined ? {} : { behind }),
	...(security ? { security: true } : {}),
});
/** The sample bundles' digests: the tars' SHA-256s. */
export const SKILLS_DIGEST = "sha256:3f2a7c1e9b4d8a6f0e5c2b7a9d1f4e8c6b3a0d7f2e9c5b1a8d4f6e0c3b7a9c01";
export const ATTACHMENTS_DIGEST = "sha256:a41c9e075d2b8f36e1a7c4d90b6f3e28c75a1d94f2e08b6c3d9a7e15b4c62f8e";
export const MODELS_DIGEST = "sha256:7e09b3d52c8f1a649b5e0d7ca3f6248e1d7c9b05e8a2f63d4c0b7e91d5a3c8f2";

/** The sample bucket sources' IDs. */
export const ORG_FILES_ID = "bks_4kq9x2mt";
export const DATASETS_ID = "bks_7hp3w8rn";

/** Kantel's own image: a desktop, Chromium and Docker, with its agent built in. */
export const KANTEL_IMAGE: SandboxImage = {
	os: "Ubuntu 26.04 LTS",
	osId: "ubuntu",
	arch: "x86_64",
	libc: "glibc",
	shell: "/bin/bash",
	init: "systemd",
	injected: false,
	agentVersion: "0.42.0",
	desktop: { available: true, detail: "Xtigervnc, Openbox, Selkies" },
	browser: { available: true, detail: "Chromium" },
	docker: { available: true, detail: "dockerd 29.1" },
	kvm: true,
};

/** A plain Alpine image Kantel put its agent into: commands, files, ports and SSH, and nothing more. */
export const ALPINE_IMAGE: SandboxImage = {
	os: "Alpine Linux v3.22",
	osId: "alpine",
	arch: "x86_64",
	libc: "musl",
	shell: "/bin/sh",
	init: "kantel",
	injected: true,
	agentVersion: "0.42.0",
	desktop: { available: false, reason: "No desktop in this image" },
	browser: { available: false, reason: "No browser in this image" },
	docker: { available: false, reason: "No Docker in this image" },
	kvm: true,
};

/** Debian with Docker added and no desktop: Docker is there, the screens aren't. */
export const DEBIAN_DOCKER_IMAGE: SandboxImage = {
	os: "Debian GNU/Linux 13 (trixie)",
	osId: "debian",
	arch: "x86_64",
	libc: "glibc",
	shell: "/bin/bash",
	init: "kantel",
	injected: true,
	agentVersion: "0.42.0",
	desktop: { available: false, reason: "No desktop in this image" },
	browser: { available: false, reason: "No browser in this image" },
	docker: { available: true, detail: "dockerd 26.1.5" },
	kvm: true,
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
	hostName: "hetzner-fsn1-01",
	shared: true,
	createdBy: "Alex Kemp",
	// lleverage-github is later, so its GH_TOKEN and its clone of kantel win over backend-dev's.
	environments: [
		{ id: "env_backend", name: "backend-dev" },
		{ id: "env_github", name: "lleverage-github" },
	],
	// Six days behind, with the openssl fix the latest was rebuilt for.
	base: onBase("sandbox", SANDBOX_IMAGE_LATEST, "2026.10.29.809", { days: 6, versions: 3 }, true),
	mounts: [
		{ path: "/mnt/skills", source: { kind: "bundle", digest: SKILLS_DIGEST }, status: "ready" },
		{
			path: "/mnt/org-files",
			source: {
				kind: "bucket",
				bucketSourceId: ORG_FILES_ID,
				prefix: "org/42/",
				refreshTtlSeconds: 60,
				bucketSourceName: "org files",
				bucket: "lleverage-org-files",
			},
			status: "ready",
		},
		{
			path: "/mnt/attachments",
			source: { kind: "bundle", digest: ATTACHMENTS_DIGEST },
			status: "failed",
			error: "This host can't mount bundles yet",
		},
	],
	image: KANTEL_IMAGE,
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
	hostName: "hetzner-fsn1-01",
	shared: true,
	environments: [{ id: "env_backend", name: "backend-dev" }],
	base: onBase("sandbox", SANDBOX_IMAGE_LATEST, SANDBOX_IMAGE_LATEST.version),
	mounts: [
		{ path: "/mnt/skills", source: { kind: "bundle", digest: SKILLS_DIGEST }, status: "ready" },
		{
			path: "/mnt/shared",
			source: {
				kind: "bucket",
				bucketSourceId: ORG_FILES_ID,
				prefix: "shared/",
				bucketSourceName: "org files",
				bucket: "lleverage-org-files",
			},
			status: "pending",
		},
	],
	image: KANTEL_IMAGE,
});

/** Any Linux image runs: plain Alpine, with Kantel's agent put in at boot. */
export const ALPINE_WORKER = sandbox({
	id: "sbx_7c4x1n8ka2",
	name: "alpine-worker",
	slug: "lleverage",
	accountId: LLEVERAGE.id,
	kind: "microvm",
	size: "small",
	state: "running",
	createdAt: FIXTURE_NOW - 40 * MINUTE,
	stopsAt: FIXTURE_NOW + 20 * MINUTE,
	snapshot: { id: "snp_alpine_1", takenAt: FIXTURE_NOW - 3 * MINUTE },
	costCents: 1,
	usage: usageSeries(3, 0.3),
	hostId: "hst_hetzner_1",
	hostName: "hetzner-fsn1-01",
	shared: true,
	createdBy: "Dean Smit",
	image: ALPINE_IMAGE,
});

/** Debian with Docker and no desktop. */
export const DEBIAN_CI = sandbox({
	id: "sbx_2m6v9r3kd4",
	name: "ci-docker",
	slug: "lleverage",
	accountId: LLEVERAGE.id,
	kind: "microvm",
	size: "medium",
	state: "running",
	createdAt: FIXTURE_NOW - 2 * HOUR,
	stopsAt: FIXTURE_NOW + 30 * MINUTE,
	// Stops sooner if nobody uses it: its idle stop.
	idleStopMinutes: 30,
	idleStopsAt: FIXTURE_NOW + 24 * MINUTE,
	snapshot: { id: "snp_ci_1", takenAt: FIXTURE_NOW - 5 * MINUTE },
	costCents: 8,
	usage: usageSeries(6, 0.5),
	hostId: "hst_hetzner_2",
	hostName: "hetzner-fsn1-02",
	shared: true,
	createdBy: "ci-runner",
	image: DEBIAN_DOCKER_IMAGE,
});

export const SCRATCH = sandbox({
	id: "sbx_9a2b6c4dq3",
	name: "scratch",
	slug: "lleverage",
	accountId: LLEVERAGE.id,
	kind: "isolate",
	size: "small",
	resources: { vcpus: 0, memoryGb: 0.25, diskGb: 0 },
	state: "running",
	createdAt: FIXTURE_NOW - 6 * MINUTE,
	stopsAt: FIXTURE_NOW + 9 * MINUTE,
	costCents: 0.2,
	usage: usageSeries(2, 0.2),
	hostId: "hst_home",
	hostName: "home-server",
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
	// Its idle stop stopped it, with its disk kept.
	idleStopMinutes: 60,
	stopReason: "idle-stop",
	snapshot: { id: "snp_render_1", takenAt: FIXTURE_NOW - 20 * HOUR },
	costCents: 412,
	hostId: "hst_hetzner_2",
	hostName: "hetzner-fsn1-02",
	shared: true,
	createdBy: "Bethan Price",
	base: onBase("sandbox", SANDBOX_IMAGE_LATEST, "2026.11.02.811", { days: 2, versions: 1 }),
	// lleverage-github was attached while it was stopped: its file and repository come when it next starts.
	environments: [{ id: "env_github", name: "lleverage-github" }],
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
	hostName: "hetzner-fsn1-02",
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
	hostName: "home-server",
	error: "The machine stopped answering. Its disk is safe: recover it, or resume it on another host.",
	forkedFrom: DEV_STACK.id,
	environments: [{ id: "env_evals", name: "evals" }],
});

export const NEW_ONE = sandbox({
	id: "sbx_8f2g5h3jd7",
	name: "preview-pr-412",
	slug: "lleverage",
	accountId: LLEVERAGE.id,
	kind: "isolate",
	size: "small",
	resources: { vcpus: 0, memoryGb: 0.25, diskGb: 0 },
	state: "starting",
	createdAt: FIXTURE_NOW - 2_000,
	stopsAt: FIXTURE_NOW + HOUR,
	costCents: 0,
	hostId: "hst_home",
	hostName: "home-server",
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
	hostName: "home-server",
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
	hostName: "hetzner-fsn1-02",
	base: onBase("sandbox", SANDBOX_IMAGE_LATEST, "2026.10.23.803", { days: 12, versions: 9 }),
});

export const SANDBOXES: readonly Sandbox[] = [
	NEW_ONE,
	SCRATCH,
	API_SERVER,
	ALPINE_WORKER,
	DEBIAN_CI,
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
		base: onBase("sandbox", SANDBOX_IMAGE_LATEST, "2026.10.22.802", { days: 13, versions: 10 }),
	},
	{
		id: "ssn_dev_stack_warm",
		name: "dev-stack-warm",
		accountId: LLEVERAGE.id,
		sandboxId: DEV_STACK.id,
		sandboxName: DEV_STACK.name,
		kind: "microvm",
		description: "Dev stack built, Turbo cache warm",
		labels: { "git.base": "9540593c" },
		createdAt: FIXTURE_NOW - 2 * DAY,
		createdBy: "Tom Davies",
		sizeBytes: 11.8 * 1024 ** 3,
		uses: 37,
		memory: true,
		machine: { vcpus: 16, memoryMb: 32_768 },
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
		base: onBase("browser", BROWSER_IMAGE_LATEST, BROWSER_IMAGE_LATEST.version),
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

/**
 * Lleverage's bundles, newest first: skills its agents read, the attachments a host couldn't mount, and model weights no
 * sandbox mounts any more, which can go. `mountedBy` is what the sample sandboxes mount; the source counts it again as
 * they come and go.
 */
export const BUNDLES: readonly Bundle[] = [
	{
		digest: SKILLS_DIGEST,
		accountId: LLEVERAGE.id,
		sizeBytes: 4.2 * 1024 ** 2,
		mountedBy: 2,
		createdAt: FIXTURE_NOW - 3 * HOUR,
	},
	{
		digest: ATTACHMENTS_DIGEST,
		accountId: LLEVERAGE.id,
		sizeBytes: 118 * 1024 ** 2,
		mountedBy: 1,
		createdAt: FIXTURE_NOW - 2 * DAY,
	},
	{
		digest: MODELS_DIGEST,
		accountId: LLEVERAGE.id,
		sizeBytes: 1.3 * 1024 ** 3,
		mountedBy: 0,
		createdAt: FIXTURE_NOW - 9 * DAY,
	},
];

/** Lleverage's bucket sources, oldest first: its own files in R2, with credentials, and a public GCS bucket. */
export const BUCKET_SOURCES: readonly BucketSource[] = [
	{
		id: ORG_FILES_ID,
		accountId: LLEVERAGE.id,
		name: "org files",
		provider: "s3",
		bucket: "lleverage-org-files",
		endpoint: "https://acct.r2.cloudflarestorage.com",
		region: "auto",
		hasCredentials: true,
		mountedBy: 2,
		createdAt: FIXTURE_NOW - 20 * DAY,
	},
	{
		id: DATASETS_ID,
		accountId: LLEVERAGE.id,
		name: "public datasets",
		provider: "gcs",
		bucket: "kantel-public-datasets",
		hasCredentials: false,
		mountedBy: 0,
		createdAt: FIXTURE_NOW - 6 * DAY,
	},
];

/** Each sandbox's history: one snapshot a minute while it runs would be a lot, so the fixtures keep a handful. */
function historyFor(box: Sandbox): readonly SandboxSnapshot[] {
	if (box.snapshot === undefined) return [];
	const out: SandboxSnapshot[] = [];
	const count = box.state === "running" ? 6 : 3;
	for (let at = 0; at < count; at += 1) {
		const takenAt = (box.snapshot.takenAt ?? box.createdAt) - at * (box.state === "running" ? 10 * MINUTE : 7 * HOUR);
		out.push({
			id: at === 0 ? box.snapshot.id : `${box.snapshot.id}_${at}`,
			sandboxId: box.id,
			takenAt,
			reason: at === 0 && box.state !== "running" ? "stop" : at === count - 1 && box.forkedFrom ? "fork" : "periodic",
			sizeBytes: Math.round((sampleSpec(box).diskGb * 1024 ** 3 * (0.08 + at * 0.004)) / 1024) * 1024,
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
		{ name: "node_modules", path: "home/user/app/node_modules", kind: "folder", modifiedAt: FIXTURE_NOW - 2 * DAY },
		{
			name: "README.md",
			path: "home/user/app/README.md",
			kind: "file",
			sizeBytes: 1_902,
			modifiedAt: FIXTURE_NOW - 3 * DAY,
		},
		{
			name: "tsconfig.json",
			path: "home/user/app/tsconfig.json",
			kind: "file",
			sizeBytes: 318,
			modifiedAt: FIXTURE_NOW - 2 * DAY,
		},
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

/**
 * An isolate's files: its workspace and nothing else. The host refuses any other path ("/ is outside /workspace, an
 * isolate's only files"), as the fixtures do.
 */
const WORKSPACE_TREE: Readonly<Record<string, readonly SnapshotEntry[]>> = {
	workspace: [
		{ name: "src", path: "workspace/src", kind: "folder" },
		{
			name: ".gitignore",
			path: "workspace/.gitignore",
			kind: "file",
			sizeBytes: 24,
			modifiedAt: FIXTURE_NOW - 5 * MINUTE,
		},
		{
			name: "README.md",
			path: "workspace/README.md",
			kind: "file",
			sizeBytes: 214,
			modifiedAt: FIXTURE_NOW - 4 * MINUTE,
		},
		{
			name: "package.json",
			path: "workspace/package.json",
			kind: "file",
			sizeBytes: 168,
			modifiedAt: FIXTURE_NOW - 4 * MINUTE,
		},
	],
	"workspace/src": [
		{
			name: "index.ts",
			path: "workspace/src/index.ts",
			kind: "file",
			sizeBytes: 96,
			modifiedAt: FIXTURE_NOW - 2 * MINUTE,
		},
	],
};

/** A folder of a sample sandbox or snapshot of this kind: an isolate's refuses anything outside /workspace. */
export function sampleFolder(kind: SandboxKind | undefined, path: string): readonly SnapshotEntry[] {
	const key = path.replace(/^\/+|\/+$/g, "");
	if (kind !== "isolate") return TREE[key] ?? [];
	if (key !== "workspace" && !key.startsWith("workspace/")) {
		throw new FilesRefusedError(`/${key} is outside /workspace, an isolate's only files`);
	}
	const entries = WORKSPACE_TREE[key];
	if (entries === undefined) throw new FilesRefusedError(`There's no folder /${key}.`);
	return entries;
}

const FILES: Readonly<Record<string, string>> = {
	"workspace/.gitignore": "node_modules\ndist\n.env\n",
	"workspace/README.md":
		"# scratch\n\nA quick place to try things. Everything here is in /workspace, the only files an isolate has.\n",
	"workspace/package.json": '{\n  "name": "scratch",\n  "private": true,\n  "type": "module"\n}\n',
	"workspace/src/index.ts": 'console.log("hello from an isolate");\n',
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
	"home/user/app/README.md":
		"# app\n\nA small API for the dev stack.\n\n## Run it\n\n```sh\npnpm install\npnpm dev\n```\n\nIt listens on 3000.\n",
	"home/user/app/tsconfig.json":
		'{\n  "compilerOptions": {\n    "target": "es2023",\n    "module": "nodenext",\n    "strict": true\n  }\n}\n',
};

const sampleText = new TextEncoder();
let syslog: Uint8Array | undefined;

/**
 * A sample file's bytes: its text; for the screenshot, a PNG's signature and then zeros, to its size; for the syslog,
 * lines written out to its size, so the preview reads a part of it.
 */
function sampleBytes(path: string): Uint8Array {
	const key = path.replace(/^\/+/, "");
	const text = FILES[key];
	if (text !== undefined) return sampleText.encode(text);
	if (key === "home/user/app/screenshot.png") {
		const png = new Uint8Array(248_113);
		png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		return png;
	}
	if (key === "var/log/syslog") {
		if (syslog === undefined) {
			const lines: string[] = [];
			let size = 0;
			for (let at = 0; size < 2_481_662; at += 1) {
				const second = String(at % 60).padStart(2, "0");
				const line = `Nov  4 09:${String(Math.floor(at / 60) % 60).padStart(2, "0")}:${second} api-server node[812]: GET /health 200 ${at % 7}ms\n`;
				lines.push(line);
				size += line.length;
			}
			syslog = sampleText.encode(lines.join("")).subarray(0, 2_481_662);
		}
		return syslog;
	}
	throw new Error(`There's no ${path} here.`);
}

/** The part of a sample file a range asks for, and its size. */
export function samplePart(path: string, range: FileRange): FilePart {
	const bytes = sampleBytes(path);
	const start = Math.min(range.offset, bytes.byteLength);
	return { bytes: bytes.subarray(start, Math.min(start + range.length, bytes.byteLength)), size: bytes.byteLength };
}

/** Tom's personal access tokens: his laptop's, signed in with kantel login, and a deploy script's in one account. */
export const PERSONAL_TOKENS: readonly PersonalToken[] = [
	{
		id: "pat_laptop",
		name: "kantel on toms-laptop",
		prefix: "kpt_7Qd2",
		createdAt: FIXTURE_NOW - 12 * DAY,
		expiresAt: FIXTURE_NOW + 78 * DAY,
		lastUsedAt: FIXTURE_NOW - 4 * MINUTE,
	},
	{
		id: "pat_deploy",
		name: "Deploy script",
		prefix: "kpt_Lm9x",
		scopes: [
			"sandboxes:read",
			"sandboxes:write",
			"exec",
			"files",
			"access",
			"snapshots:read",
			"snapshots:write",
			"account:read",
		],
		accounts: ["org_lleverage"],
		createdAt: FIXTURE_NOW - 40 * DAY,
		expiresAt: FIXTURE_NOW + 2 * DAY,
		lastUsedAt: FIXTURE_NOW - 6 * HOUR,
	},
	{
		id: "pat_old",
		name: "kantel on build-02",
		prefix: "kpt_Rr3a",
		createdAt: FIXTURE_NOW - 120 * DAY,
		expiresAt: FIXTURE_NOW - 30 * DAY,
		lastUsedAt: FIXTURE_NOW - 31 * DAY,
	},
];

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
	logRequests: true,
};

const GITHUB: DestinationBinding = { host: "api.github.com", pathPrefixes: [], methods: [] };

/** The organisation's environments: one for backend work, one for evals, and one for GitHub that goes with others. */
export const ENVIRONMENTS: readonly Environment[] = [
	{
		id: "env_backend",
		accountId: LLEVERAGE.id,
		name: "backend-dev",
		description: "The API and its workers, with GitHub, npm and OpenAI.",
		variables: [
			{ name: "NODE_ENV", protected: false, value: "development", bindings: [], updatedAt: FIXTURE_NOW - 6 * DAY },
			{
				name: "DATABASE_URL",
				protected: false,
				value: "postgres://app:app@localhost:5432/app",
				bindings: [],
				updatedAt: FIXTURE_NOW - 6 * DAY,
			},
			{
				name: "GH_TOKEN",
				protected: true,
				bindings: [GITHUB, { host: "github.com", pathPrefixes: ["/lleverage-ai/"], methods: [] }],
				updatedAt: FIXTURE_NOW - 2 * HOUR,
			},
			{
				name: "NPM_TOKEN",
				protected: true,
				bindings: [{ host: "registry.npmjs.org", pathPrefixes: [], methods: ["GET", "PUT"] }],
				updatedAt: FIXTURE_NOW - 3 * DAY,
			},
			{
				name: "OPENAI_API_KEY",
				protected: true,
				bindings: [{ host: "api.openai.com", pathPrefixes: ["/v1/"], methods: ["POST", "GET"] }],
				updatedAt: FIXTURE_NOW - 5 * DAY,
			},
		],
		files: [
			{ path: "/home/user/.npmrc", mode: 0o600, sizeBytes: 112, updatedAt: FIXTURE_NOW - 3 * DAY },
			{ path: "/home/user/.config/app/dev.env", mode: 0o600, sizeBytes: 486, updatedAt: FIXTURE_NOW - 6 * DAY },
		],
		repos: [
			{ url: "https://github.com/lleverage-ai/kantel", ref: "main" },
			{ url: "https://github.com/lleverage-ai/agent-sdk", path: "/home/user/src/agent-sdk" },
		],
		grants: [
			{ id: "grt_gh", action: "allow", host: "api.github.com", methods: [], paths: [] },
			{ id: "grt_gh_delete", action: "deny", host: "api.github.com", methods: ["DELETE"], paths: ["/repos/*"] },
			{ id: "grt_npm", action: "allow", host: "registry.npmjs.org", methods: [], paths: [] },
			{ id: "grt_tracker", action: "deny", host: "*.example-tracker.io", methods: [], paths: [] },
		],
		sandboxCount: 2,
		createdAt: FIXTURE_NOW - 6 * DAY,
		updatedAt: FIXTURE_NOW - 2 * HOUR,
	},
	{
		id: "env_evals",
		accountId: LLEVERAGE.id,
		name: "evals",
		description: "The nightly eval runners.",
		variables: [
			{ name: "EVAL_SUITE", protected: false, value: "nightly", bindings: [], updatedAt: FIXTURE_NOW - 2 * DAY },
			{
				name: "ANTHROPIC_API_KEY",
				protected: true,
				bindings: [{ host: "api.anthropic.com", pathPrefixes: ["/v1/messages"], methods: ["POST"] }],
				updatedAt: FIXTURE_NOW - 2 * DAY,
			},
		],
		files: [],
		repos: [{ url: "https://github.com/lleverage-ai/evals" }],
		grants: [{ id: "grt_anthropic", action: "allow", host: "api.anthropic.com", methods: [], paths: [] }],
		sandboxCount: 1,
		createdAt: FIXTURE_NOW - 2 * DAY,
		updatedAt: FIXTURE_NOW - 2 * DAY,
	},
	{
		id: "env_github",
		accountId: LLEVERAGE.id,
		name: "lleverage-github",
		description: "A GitHub token for the lleverage-ai organisation, to put after any environment that needs one.",
		variables: [
			{
				name: "GH_TOKEN",
				protected: true,
				bindings: [GITHUB, { host: "github.com", pathPrefixes: ["/lleverage-ai/"], methods: [] }],
				updatedAt: FIXTURE_NOW - DAY,
			},
			{ name: "GIT_AUTHOR_NAME", protected: false, value: "Kantel", bindings: [], updatedAt: FIXTURE_NOW - DAY },
		],
		files: [{ path: "/home/user/.config/gh/hosts.yml", mode: 0o600, sizeBytes: 164, updatedAt: FIXTURE_NOW - DAY }],
		repos: [{ url: "https://github.com/lleverage-ai/kantel" }],
		grants: [{ id: "grt_gh_org", action: "allow", host: "github.com", methods: [], paths: ["/lleverage-ai/*"] }],
		sandboxCount: 2,
		createdAt: FIXTURE_NOW - 3 * DAY,
		updatedAt: FIXTURE_NOW - DAY,
	},
];

const egressEntry = (
	id: string,
	ago: number,
	fields: Omit<EgressEntry, "id" | "at" | "port" | "swapped" | "inspected" | "bytesUp" | "bytesDown"> &
		Partial<Pick<EgressEntry, "port" | "swapped" | "inspected" | "bytesUp" | "bytesDown">>,
): EgressEntry => ({
	id,
	at: FIXTURE_NOW - ago,
	port: 443,
	swapped: [],
	inspected: false,
	bytesUp: 0,
	bytesDown: 0,
	...fields,
});

/** dev-stack's recent egress: swaps, a tunnel, a placeholder sent to the wrong host and two refusals. */
export const EGRESS_LOG: readonly EgressEntry[] = [
	egressEntry("egr_9", 3_000, {
		method: "GET",
		host: "api.github.com",
		path: "/user",
		decision: "allowed",
		swapped: ["GH_TOKEN"],
		inspected: true,
		status: 200,
		bytesUp: 412,
		bytesDown: 1_380,
	}),
	egressEntry("egr_8", 8_000, {
		method: "POST",
		host: "webhook.site",
		path: "/3f9a1c",
		decision: "denied",
		reason: "GH_TOKEN's placeholder was sent to webhook.site, which it isn't bound to. Kantel didn't swap it.",
		code: "placeholder-unbound",
		inspected: true,
		status: 403,
		bytesUp: 220,
	}),
	egressEntry("egr_7", 14_000, {
		method: "DELETE",
		host: "api.github.com",
		path: "/repos/lleverage-ai/kantel/branches/old",
		decision: "denied",
		code: "denied",
		reason: "Denied by the environment's grant.",
		rule: "deny DELETE api.github.com /repos/*",
		inspected: true,
		status: 403,
		bytesUp: 380,
	}),
	egressEntry("egr_6", 40_000, {
		method: "POST",
		host: "api.openai.com",
		path: "/v1/responses",
		decision: "allowed",
		swapped: ["OPENAI_API_KEY"],
		inspected: true,
		status: 200,
		bytesUp: 2_904,
		bytesDown: 18_220,
	}),
	egressEntry("egr_5", 55_000, {
		method: "CONNECT",
		host: "pypi.org",
		decision: "allowed",
		bytesUp: 1_840,
		bytesDown: 92_610,
	}),
	egressEntry("egr_4", 70_000, {
		method: "CONNECT",
		host: "collect.example-tracker.io",
		decision: "denied",
		code: "denied",
		reason: "Denied by the environment's grant.",
		rule: "deny *.example-tracker.io",
	}),
	egressEntry("egr_3", 2 * MINUTE, {
		method: "GET",
		host: "registry.npmjs.org",
		path: "/@lleverage-ai%2fagent-sdk",
		decision: "allowed",
		swapped: ["NPM_TOKEN"],
		inspected: true,
		status: 200,
		bytesUp: 380,
		bytesDown: 24_100,
	}),
	egressEntry("egr_2", 3 * MINUTE, {
		method: "GET",
		host: "api.github.com",
		path: "/repos/lleverage-ai/kantel/pulls",
		decision: "allowed",
		inspected: true,
		status: 200,
		bytesUp: 300,
		bytesDown: 41_280,
	}),
	egressEntry("egr_1", 4 * MINUTE, {
		method: "GET",
		host: "169.254.169.254",
		port: 80,
		path: "/latest/meta-data/",
		decision: "denied",
		reason: "169.254.169.254 isn't on the public internet.",
		status: 403,
	}),
];

/** scratch's: an isolate with no environment, so only the account's rules decide. */
export const SCRATCH_EGRESS_LOG: readonly EgressEntry[] = [
	egressEntry("egr_s3", 20_000, {
		method: "CONNECT",
		host: "registry.npmjs.org",
		decision: "allowed",
		bytesUp: 2_210,
		bytesDown: 418_400,
	}),
	egressEntry("egr_s2", 31_000, {
		method: "CONNECT",
		host: "example-tracker.io",
		decision: "denied",
		// As the host records it: every refusal by the rules is `denied`, its reason saying which.
		code: "denied",
		reason: "example-tracker.io isn't on the proxy settings' allow list.",
	}),
	egressEntry("egr_s1", 5 * MINUTE, {
		method: "CONNECT",
		host: "pypi.org",
		decision: "allowed",
		bytesUp: 1_120,
		bytesDown: 61_900,
	}),
];

/** eval-runner-12's, before its machine stopped answering: its Anthropic key swapped in. */
export const EVAL_EGRESS_LOG: readonly EgressEntry[] = [
	egressEntry("egr_e1", 12 * MINUTE, {
		method: "POST",
		host: "api.anthropic.com",
		path: "/v1/messages",
		decision: "allowed",
		swapped: ["ANTHROPIC_API_KEY"],
		inspected: true,
		status: 200,
		bytesUp: 8_400,
		bytesDown: 3_120,
	}),
];

/** Each sandbox's log; the others haven't sent anything. */
const EGRESS_LOGS: Readonly<Record<string, readonly EgressEntry[]>> = {
	[DEV_STACK.id]: EGRESS_LOG,
	[SCRATCH.id]: SCRATCH_EGRESS_LOG,
	[EVAL_RUNNER.id]: EVAL_EGRESS_LOG,
};

/** Placeholders as each of the environment's sandboxes has them: sample text, not real ones. */
const placeholderOf = (sandboxId: string, name: string): string => {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
	let seed = 0;
	for (const char of `${sandboxId}/${name}`) seed = (seed * 31 + char.charCodeAt(0)) % 1_000_003;
	return `kph_${Array.from({ length: 4 }, (_, at) => alphabet[(seed * (at + 7)) % alphabet.length]).join("")}`;
};

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

/** A host's disk as it measured it 3 minutes before `FIXTURE_NOW`: its parts in GB, the rest of 6% of it other. */
function sampleDiskUsage(
	totalGb: number,
	parts: {
		readonly saved: number;
		readonly automatic: number;
		readonly sandboxes: number;
		readonly images: number;
		readonly templates: number;
		readonly bundles: number;
	},
): HostDisk {
	const gb = (value: number) => Math.round(value * 1024 ** 3);
	const other = gb(totalGb * 0.06);
	const known = gb(parts.saved + parts.automatic + parts.sandboxes + parts.images + parts.templates + parts.bundles);
	return {
		totalBytes: gb(totalGb),
		usedBytes: known + other,
		savedSnapshots: gb(parts.saved),
		automaticSnapshots: gb(parts.automatic),
		sandboxes: gb(parts.sandboxes),
		images: gb(parts.images),
		templates: gb(parts.templates),
		bundles: gb(parts.bundles),
		other,
		measuredAt: FIXTURE_NOW - 3 * MINUTE,
	};
}

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
		disk: sampleDiskUsage(3_840, {
			saved: 182,
			automatic: 611,
			sandboxes: 1_204,
			images: 38,
			templates: 96,
			bundles: 9,
		}),
		poolId: "pool_ci",
		// Its pool syncs: it reaches the other Hetzner host directly, and the home server not at all.
		mesh: {
			address: "fd4b:91c2:7e10:0:5a1e:3f20:9c4d:1b07",
			peers: [
				{
					hostId: "hst_hetzner_2",
					path: "direct",
					endpoint: "203.0.113.24:51820",
					lastHandshake: FIXTURE_NOW - 42_000,
					rttMs: 0.4,
				},
				{ hostId: "hst_home", path: "none", endpoint: "198.51.100.7:51820", lastHandshake: FIXTURE_NOW - 26 * MINUTE },
			],
		},
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
		disk: sampleDiskUsage(3_840, {
			saved: 1_310,
			automatic: 1_906,
			sandboxes: 288,
			images: 38,
			templates: 96,
			bundles: 4,
		}),
		savedSnapshotLimitBytes: 200 * 1024 ** 3,
		poolId: "pool_ci",
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
		disk: sampleDiskUsage(1_000, { saved: 41, automatic: 66, sandboxes: 187, images: 21, templates: 24, bundles: 2 }),
		savedSnapshotLimitBytes: 50 * 1024 ** 3,
		poolId: "pool_default",
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
		poolId: "pool_default",
	},
];

/** A sample image digest: `sha256:` and 64 hex digits, the same for the same seed. Not a real image's. */
export function sampleDigest(seed: string): string {
	let hash = 2_166_136_261;
	let hex = "";
	for (let round = 0; hex.length < 64; round += 1) {
		for (const char of `${seed}/${round}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16_777_619) >>> 0;
		hex += hash.toString(16).padStart(8, "0");
	}
	return `sha256:${hex.slice(0, 64)}`;
}

/** A scan that found `findings`, counted as a scanner counts them. */
function sampleScan(scannedAt: number, findings: readonly ImageFinding[] = []): ImageScan {
	const counts: Record<ImageSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
	for (const finding of findings) counts[finding.severity] += 1;
	const fixable = (severity: ImageSeverity) =>
		findings.filter((finding) => finding.severity === severity && finding.fixed !== undefined).length;
	return {
		scanner: "trivy 0.67.2",
		scannedAt,
		counts,
		fixable: { critical: fixable("critical"), high: fixable("high") },
		findings,
	};
}

const imageVersion = (
	image: string,
	version: string,
	builtAt: number,
	reason: ImageBuildReason,
	scan?: ImageScan,
): BaseImageVersion => ({
	version,
	digest: sampleDigest(`${image}@${version}`),
	builtAt,
	signed: true,
	reason,
	...(scan === undefined ? {} : { scan }),
});

const baseImage = (name: string, versions: readonly BaseImageVersion[]): BaseImage => ({
	name,
	// The microVM host images are GitHub Releases; the others are containers on GHCR.
	repository:
		name === "host"
			? `https://github.com/lleverage-ai/kantel/releases/download/${versions[0]?.version ?? "host-images"}`
			: `ghcr.io/lleverage-ai/kantel-${name}`,
	channel: "stable",
	...(versions[0] === undefined ? {} : { latest: versions[0] }),
	versions,
});

/** What the browser image's latest scan found: a Critical in openssl with a fix out, and a High with none yet. */
export const BROWSER_FINDINGS: readonly ImageFinding[] = [
	{
		id: "CVE-2026-31789",
		severity: "critical",
		package: "openssl",
		installed: "3.0.13-0ubuntu3.5",
		fixed: "3.0.13-0ubuntu3.6",
		title: "openssl: heap overflow in X.509 name constraint checks",
	},
	{
		id: "CVE-2026-28114",
		severity: "high",
		package: "libxml2",
		installed: "2.9.14+dfsg-1.3ubuntu3.4",
		title: "libxml2: use after free in xmlXIncludeCopyNode",
	},
	{
		id: "CVE-2026-20417",
		severity: "medium",
		package: "curl",
		installed: "8.5.0-2ubuntu10.6",
		fixed: "8.5.0-2ubuntu10.7",
		title: "curl: cookie leak across redirects to another port",
	},
	{
		id: "GHSA-7q4v-9hx2-mq3c",
		severity: "low",
		package: "node-tar",
		installed: "6.2.0",
		fixed: "6.2.1",
	},
];

/**
 * The deployment's base images and templates, at `at` (the fixtures' clock): the sandbox image just rebuilt for a
 * fixable vulnerability, the browser image's scan finding a fixable Critical, the rest clean; one template rebuilding,
 * one pinned behind, one current.
 */
function sampleImages(at: (time: number) => number): BaseImagesOverview {
	const ago = (ms: number) => at(FIXTURE_NOW - ms);
	const latest = (image: { readonly version: string; readonly builtAt: number }) => ({
		version: image.version,
		builtAt: at(image.builtAt),
	});
	const sandboxLatest = latest(SANDBOX_IMAGE_LATEST);
	const browserLatest = latest(BROWSER_IMAGE_LATEST);
	const images: readonly BaseImage[] = [
		baseImage("sandbox", [
			imageVersion("sandbox", SANDBOX_IMAGE_LATEST.version, sandboxLatest.builtAt, "cve", sampleScan(ago(2 * HOUR))),
			imageVersion("sandbox", "2026.11.02.811", ago(2 * DAY + 3 * HOUR), "daily"),
			imageVersion("sandbox", "2026.10.31.810", ago(4 * DAY + 3 * HOUR), "daily"),
		]),
		baseImage("browser", [
			imageVersion(
				"browser",
				BROWSER_IMAGE_LATEST.version,
				browserLatest.builtAt,
				"daily",
				sampleScan(ago(HOUR), BROWSER_FINDINGS),
			),
			imageVersion("browser", "2026.11.02.810", ago(DAY + 9 * HOUR), "daily"),
		]),
		baseImage("isolate-host", [
			imageVersion("isolate-host", "2026.11.04.812", ago(4 * HOUR), "daily", sampleScan(ago(3 * HOUR))),
			imageVersion("isolate-host", "2026.11.03.811", ago(DAY + 4 * HOUR), "daily"),
		]),
		baseImage("host", [
			imageVersion("host", "host-images-20261104.812", ago(5 * HOUR), "push", sampleScan(ago(4 * HOUR))),
			imageVersion("host", "host-images-20261103.811", ago(DAY + 5 * HOUR), "daily"),
		]),
	];
	const templates: readonly BaseImageTemplate[] = [
		{
			id: "tpl_node22",
			name: "node-22",
			image: "sandbox",
			channel: "stable",
			base: onBase("sandbox", sandboxLatest, "2026.11.02.811", { days: 2, versions: 1 }, true),
			rebuilding: true,
		},
		{
			id: "tpl_python313",
			name: "python-3.13",
			image: "sandbox",
			pinned: sampleDigest("sandbox@2026.10.31.810"),
			base: onBase("sandbox", sandboxLatest, "2026.10.31.810", { days: 4, versions: 2 }, true),
			rebuilding: false,
		},
		{
			id: "tpl_browser_agent",
			name: "browser-agent",
			image: "browser",
			channel: "stable",
			base: onBase("browser", browserLatest, BROWSER_IMAGE_LATEST.version),
			rebuilding: false,
		},
	];
	return {
		images,
		templates,
		indexUrl: "https://github.com/lleverage-ai/kantel/releases/download/base-images/index.json",
		generatedAt: ago(20 * MINUTE),
	};
}

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
		id: "cmd_4b",
		command: "pnpm build",
		startedAt: FIXTURE_NOW - 9 * MINUTE,
		durationMs: 18_300,
		exitCode: 1,
		by: "Claude Code on Tom's laptop",
		output:
			"> tsc -p tsconfig.build.json\nsrc/routes/sandboxes.ts(212,7): error TS2322: Type 'string | undefined' is not assignable to type 'string'.\nFound 1 error in src/routes/sandboxes.ts:212\n ELIFECYCLE  Command failed with exit code 1.",
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

/** The ports the sample sandboxes have given a URL. */
export const PORTS: Readonly<Record<string, readonly SandboxPort[]>> = {
	[API_SERVER.id]: [
		{ port: 3000, url: `https://3000-${API_SERVER.hostname}`, public: false, createdAt: FIXTURE_NOW - 2 * HOUR },
		{ port: 8080, url: `https://8080-${API_SERVER.hostname}`, public: true, createdAt: FIXTURE_NOW - 40 * MINUTE },
	],
	[DEV_STACK.id]: [
		{ port: 5173, url: `https://5173-${DEV_STACK.hostname}`, public: false, createdAt: FIXTURE_NOW - DAY },
	],
};

export interface ComputeFixtureOptions {
	readonly hosting?: HostingMode;
	/** The time the source is at; default `FIXTURE_NOW`. Pass `Date.now()` for a live console. */
	readonly now?: number;
	/** Every read waits forever: a loading state. */
	readonly hang?: boolean;
	/** Every read fails: an error state. */
	readonly fail?: boolean;
	/** No sandboxes, snapshots, keys, webhooks, hosts, images, bundles or bucket sources: the empty states. */
	readonly empty?: boolean;
	/** The deployment hasn't turned mounts on: no Mounts page, and no sandbox mounts anything. */
	readonly noMounts?: boolean;
	/** How long a sandbox takes to start or stop, in milliseconds. Default 1200. */
	readonly settleMs?: number;
	/** The viewer is not a super-admin. */
	readonly notSuperAdmin?: boolean;
	/** A new install's first run: no hosts, so no sandboxes either, with the rest as usual. */
	readonly noHosts?: boolean;
	/** Changes to sample hosts by ID, for a story of a state the sample doesn't have (one updating). */
	readonly hostOverrides?: Readonly<Record<string, Partial<Host>>>;
	/**
	 * Sample hosts, by ID, that aren't connected: they show offline, and their sandboxes `hostUnreachable`, for a story
	 * of a host that went away under its sandboxes.
	 */
	readonly hostsAway?: readonly string[];
	/**
	 * Where hosts reach the control plane, as the deployment set it. Default a default install's loopback address
	 * (`http://127.0.0.1:58090`), or Kantel's own address when hosted.
	 */
	readonly publicUrl?: string;
	/** The deployment has templates turned on (experimental): Templates in the sidebar and a picker in New sandbox. */
	readonly templates?: boolean;
	/**
	 * What a sandbox's host measures: `all` (default) CPU, memory, disk and IO; `cpu-memory` an older host's CPU and
	 * memory alone, with no history beyond the live hour and no process list.
	 */
	readonly metrics?: "all" | "cpu-memory";
	/**
	 * The deployment keeps no protected values (it has no secrets key): the samples have no protected variables or secret
	 * files, the Environments pages offer neither, and setting one is refused as the API refuses it.
	 */
	readonly noProtectedValues?: boolean;
	/**
	 * The pools the sample hosts are in: `many` (default) the default pool, `ci` with the Hetzner hosts and an empty
	 * `workflows`; `one` the default alone, with every host in it; `long-names` the three with names as long as a name
	 * may be; `none` a source with no pools, as an older gateway's; `fail` pools that can't be read.
	 */
	readonly pools?: "many" | "one" | "long-names" | "none" | "fail";
}

/** The sample pools, by the `pools` option: the default first. */
function samplePools(kind: "many" | "one" | "long-names", at: (time: number) => number): Pool[] {
	const pool = (id: string, name: string, made: number): Pool => ({
		id,
		name,
		default: id === "pool_default",
		hosts: 0,
		createdAt: at(FIXTURE_NOW - made),
	});
	if (kind === "one") return [pool("pool_default", "default", 30 * DAY)];
	const long = kind === "long-names";
	return [
		pool("pool_default", long ? "default-pool-for-the-analytical-engines-research-and-dev-team" : "default", 30 * DAY),
		pool("pool_ci", long ? "continuous-integration-runners-for-every-repository-we-maintain" : "ci", 20 * DAY),
		pool(
			"pool_workflows",
			long ? "workflow-runtimes-and-scheduled-jobs-for-the-production-stack" : "workflows",
			2 * DAY,
		),
	];
}

/** What the fixtures refuse a protected value or a secret file with under `noProtectedValues`, as the API does. */
const NO_PROTECTED_VALUES =
	"This deployment doesn't support protected variables or secret files; plain variables still work";

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
	const noProtectedValues = options.noProtectedValues === true;
	const allMetrics = (options.metrics ?? "all") === "all";
	/** A sandbox's made-up readings between two times: none while it isn't running, its disk and IO where measured. */
	const sandboxUsage = (id: string, since: number, to: number, intervalMs?: number, history = false): UsageSeries => {
		const box = find(sandboxes, id, "sandbox");
		const spec = sampleSpec(box);
		const memLimitBytes = spec.memoryGb * 1024 ** 3;
		const disk = allMetrics && box.kind === "microvm" ? { diskTotalBytes: spec.diskGb * 1024 ** 3 } : {};
		// A stopped one has its history up to when it stopped; the live read has nothing for it.
		if (box.state !== "running" && !history) return { intervalMs: 5_000, memLimitBytes, ...disk, points: [] };
		const stopped = box.state === "running" ? to : Math.min(to, box.snapshot?.takenAt ?? box.createdAt);
		return stubUsage(id, {
			since: Math.max(since, box.createdAt),
			now: stopped,
			memLimitBytes,
			...disk,
			...(allMetrics && box.kind === "microvm" ? { io: true } : {}),
			...(intervalMs === undefined ? {} : { intervalMs }),
			...(box.kind === "isolate" ? { busy: 0.04 + (id.length % 5) / 50 } : {}),
		});
	};
	const empty = options.empty === true;
	const mountsOn = options.noMounts !== true;

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
	/** A record's base image with its latest's build time on `now` too. */
	const movedBase = <T extends { readonly base?: SandboxBase }>(record: T): T => {
		const latest = record.base?.latest;
		if (record.base === undefined || latest === undefined) return record;
		return { ...record, base: { ...record.base, latest: { ...latest, builtAt: at(latest.builtAt) } } };
	};

	const withMounts = (box: Sandbox): Sandbox => {
		if (mountsOn) return box;
		const { mounts: _, ...rest } = box;
		return rest;
	};

	const sandboxes = new Map<string, Sandbox>(
		(empty || options.noHosts === true ? [] : SANDBOXES).map((box) => {
			const copy = moved(box, ["createdAt", "stopsAt", "idleStopsAt"]);
			const snapshot =
				box.snapshot?.takenAt === undefined ? {} : { snapshot: { ...box.snapshot, takenAt: at(box.snapshot.takenAt) } };
			const away =
				box.hostId !== undefined && options.hostsAway?.includes(box.hostId) === true ? { hostUnreachable: true } : {};
			return [box.id, withMounts(withCost(movedBase({ ...copy, ...snapshot, ...away })))];
		}),
	);
	// Bundles by account and digest: a digest names a bundle only within its account.
	const bundleKey = (accountId: string, digest: string) => `${accountId} ${digest}`;
	const bundles = new Map<string, Bundle>(
		(empty || !mountsOn ? [] : BUNDLES).map((bundle) => [
			bundleKey(bundle.accountId, bundle.digest),
			moved(bundle, ["createdAt"]),
		]),
	);
	const bucketSources = new Map<string, BucketSource>(
		(empty || !mountsOn ? [] : BUCKET_SOURCES).map((bucket) => [bucket.id, moved(bucket, ["createdAt"])]),
	);
	const saved = new Map<string, SavedSnapshot>(
		(empty ? [] : SAVED).map((entry) => [entry.id, movedBase(moved(entry, ["createdAt"]))]),
	);
	const history = new Map<string, SandboxSnapshot[]>(
		[...sandboxes.values()].map((box) => [box.id, [...historyFor(box)]]),
	);
	/** The kind of sandbox a snapshot is of: a saved one's own, or its sandbox's. */
	const snapshotKind = (snapshotId: string): SandboxKind | undefined => {
		const named = saved.get(snapshotId);
		if (named !== undefined) return named.kind;
		for (const box of sandboxes.values()) {
			if (box.snapshot?.id === snapshotId || history.get(box.id)?.some((snap) => snap.id === snapshotId)) {
				return box.kind;
			}
		}
		return undefined;
	};
	const keys = new Map<string, ApiKey>(
		(empty ? [] : KEYS).map((key) => [key.id, moved(key, ["createdAt", "lastUsedAt", "expiresAt", "revokedAt"])]),
	);
	const personalTokens = new Map<string, PersonalToken>(
		(empty ? [] : PERSONAL_TOKENS).map((token) => [
			token.id,
			moved(token, ["createdAt", "lastUsedAt", "expiresAt", "revokedAt"]),
		]),
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
		(empty || options.noHosts === true ? [] : HOSTS).map((host) => [
			host.id,
			{
				...moved(host, ["lastSeenAt", "joinedAt"]),
				...(host.disk === undefined ? {} : { disk: moved(host.disk, ["measuredAt"]) }),
				...(options.hostsAway?.includes(host.id) === true ? { state: "offline" as const } : {}),
				...(options.pools === "one" ? { poolId: "pool_default" } : {}),
				...options.hostOverrides?.[host.id],
			},
		]),
	);
	const poolKind = options.pools ?? "many";
	const pools = new Map<string, Pool>(
		poolKind === "none" || poolKind === "fail" ? [] : samplePools(poolKind, at).map((pool) => [pool.id, pool]),
	);
	/** A pool as the API answers it: how many hosts are in it now. */
	const poolView = (pool: Pool): Pool => ({
		...pool,
		hosts: [...hosts.values()].filter((host) => host.poolId === pool.id).length,
	});
	const poolNamed = (name: string, except?: string) => {
		if (!POOL_NAME_PATTERN.test(name)) {
			throw new Error("A pool's name is lower-case letters, digits and dashes, such as ci");
		}
		if ([...pools.values()].some((pool) => pool.name === name && pool.id !== except)) {
			throw Object.assign(new Error(`The account has a pool named ${name}`), { code: "conflict" });
		}
	};
	/** A pool's hosts that are up and run `kind`. */
	const poolHosts = (poolId: string, kind: SandboxKind): Host[] =>
		[...hosts.values()].filter(
			(host) => host.poolId === poolId && host.state === "online" && (kind === "isolate" || host.kvm),
		);
	/** "a microvm", "an isolate". */
	const article = (kind: SandboxKind): string => `${kind === "isolate" ? "an" : "a"} ${kind}`;
	/** When each host updating comes back on its new version (wall-clock, so a story sees it finish). */
	const updateDone = new Map<string, number>();
	const deploymentUrl =
		options.publicUrl ?? (hosting === "hosted" ? "https://kantel.example.com" : "http://127.0.0.1:58090");
	let publicUrlSet: string | undefined;
	const publicUrl = (): PublicUrl => {
		const url = publicUrlSet ?? deploymentUrl;
		return {
			publicUrl: url,
			setHere: publicUrlSet !== undefined,
			deploymentUrl,
			loopback: /^https?:\/\/(127\.|localhost|\[::1\]|0\.0\.0\.0)/.test(url),
		};
	};
	const proxies = new Map<string, ProxySettings>();
	const environments = new Map<string, Environment>(
		(empty ? [] : ENVIRONMENTS).map((env) => [
			env.id,
			{
				...moved(env, ["createdAt", "updatedAt"]),
				variables: env.variables
					.filter((variable) => !(noProtectedValues && variable.protected))
					.map((variable) => moved(variable, ["updatedAt"])),
				files: noProtectedValues ? [] : env.files.map((file) => moved(file, ["updatedAt"])),
			},
		]),
	);
	const ports = new Map<string, readonly SandboxPort[]>(
		empty ? [] : Object.entries(PORTS).map(([id, list]) => [id, list.map((entry) => moved(entry, ["createdAt"]))]),
	);
	const sandboxGrants = new Map<string, readonly EgressGrant[]>(
		empty ? [] : [[DEV_STACK.id, [{ id: "grt_dev_pypi", action: "allow", host: "pypi.org", methods: [], paths: [] }]]],
	);
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
		[
			FIXTURE_PERSONAL_DEVICE_CODE,
			{
				userCode: FIXTURE_PERSONAL_DEVICE_CODE,
				clientName: "kantel on toms-laptop",
				personal: true,
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
	const templates =
		options.templates === true
			? createTemplateFixtures({ now: at(base), clock: now, empty, gate, accountId: LLEVERAGE.id })
			: undefined;
	/** Refuses a grant write made from an older read, as Kantel's API does with `conflict`. */
	const requireGrants = (expected: readonly EgressGrant[] | undefined, now: readonly EgressGrant[], what: string) => {
		const key = (grants: readonly EgressGrant[]) =>
			JSON.stringify(grants.map((grant) => [grant.id, grant.action, grant.host, grant.methods, grant.paths]));
		if (expected !== undefined && key(expected) !== key(now)) {
			throw Object.assign(new Error(`${what} changed since you read them; read them again and redo the change`), {
				code: "conflict",
			});
		}
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
	const putEnvironment = (env: Environment): Environment => {
		const next = { ...env, updatedAt: now() };
		environments.set(env.id, next);
		return next;
	};
	/** A sandbox's environments as they are now, in order: one deleted since is gone. */
	const environmentsOf = (box: Sandbox): Environment[] =>
		(box.environments ?? []).flatMap((ref) => {
			const env = environments.get(ref.id);
			return env === undefined ? [] : [env];
		});
	/** Refs to environments by ID, in order, with their names now. */
	const refsOf = (ids: readonly string[]): EnvironmentRef[] =>
		ids.map((id) => ({ id, name: find(environments, id, "environment").name }));
	/** Each name's (or path's) environment: the last that has it, as the API's resolver decides. */
	const winners = (envs: readonly Environment[], keys: (env: Environment) => readonly string[]) => {
		const won = new Map<string, Environment>();
		for (const env of envs) for (const key of keys(env)) won.set(key, env);
		return won;
	};
	const repoPath = (repo: Environment["repos"][number]): string =>
		repo.path ??
		`~/${
			repo.url
				.replace(/\.git$/, "")
				.split("/")
				.at(-1) ?? ""
		}`;
	const variableNames = (env: Environment) => env.variables.map((variable) => variable.name);
	const filePaths = (env: Environment) => env.files.map((file) => file.path);
	const repoPaths = (env: Environment) => env.repos.map(repoPath);
	// The environments whose files and repositories a stopped sandbox gets when it next starts.
	const pendingEnvironments = new Map<string, Set<string>>(empty ? [] : [[RENDER.id, new Set(["env_github"])]]);
	const sandboxEnvironmentsOf = (sandboxId: string): readonly SandboxEnvironment[] => {
		const envs = environmentsOf(find(sandboxes, sandboxId, "sandbox"));
		const lost = (env: Environment, keys: (env: Environment) => readonly string[]) => {
			const won = winners(envs, keys);
			return keys(env).filter((key) => won.get(key)?.id !== env.id);
		};
		return envs.map((env) => ({
			id: env.id,
			name: env.name,
			shadowed: {
				variables: lost(env, variableNames),
				files: lost(env, filePaths),
				repos: lost(env, repoPaths),
			},
			pending: pendingEnvironments.get(sandboxId)?.has(env.id) === true,
		}));
	};
	const egressOf = (sandboxId: string): SandboxEgress => {
		const box = find(sandboxes, sandboxId, "sandbox");
		const envs = environmentsOf(box);
		const won = winners(envs, variableNames);
		return {
			sandboxId: box.id,
			sandboxName: box.name,
			accountId: box.accountId,
			environments: envs.map((env) => ({ id: env.id, name: env.name })),
			// The protected one of each name, from the environment that wins it.
			protectedVariables: [...won].flatMap(([name, env]) => {
				const variable = env.variables.find((each) => each.name === name);
				return variable?.protected === true
					? [
							{
								name,
								placeholderPrefix: placeholderOf(box.id, name),
								bindings: variable.bindings,
								environmentId: env.id,
							},
						]
					: [];
			}),
			environmentGrants: envs.flatMap((env) => env.grants),
			grants: sandboxGrants.get(box.id) ?? [],
			entries: (EGRESS_LOGS[box.id] ?? []).map((entry) => moved(entry, ["at"])),
		};
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
			sizeBytes: Math.round(sampleSpec(box).diskGb * 1024 ** 3 * 0.09),
			expiresAt: now() + 14 * DAY,
		};
		history.set(box.id, [snap, ...(history.get(box.id) ?? [])]);
		return snap;
	};
	const slugOf = (accountId: string) => accounts.find((account) => account.id === accountId)?.slug ?? "you";
	/** How many of the account's sandboxes mount what `uses` picks: what Kantel counts as `mountedBy`. */
	const mountCount = (accountId: string, uses: (from: MountSource) => boolean): number =>
		[...sandboxes.values()].filter(
			(box) => box.accountId === accountId && (box.mounts ?? []).some((mount) => uses(mount.source)),
		).length;
	const bundleUses = (digest: string) => (from: MountSource) => from.kind === "bundle" && from.digest === digest;
	const bucketUses = (id: string) => (from: MountSource) => from.kind === "bucket" && from.bucketSourceId === id;
	/** Refuses a delete while a sandbox that still exists mounts it, as Kantel's API does with `conflict`. */
	const requireUnmounted = (count: number) => {
		const refusal = inUseText(count);
		if (refusal !== undefined) throw Object.assign(new Error(`${refusal}.`), { code: "conflict" });
	};

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
					// A code made for another email, refused as the API refuses it.
					if (code.trim().startsWith("kji_other")) {
						throw Object.assign(
							new Error(
								`This invite is for ada@example.com, but you're signed in as ${VIEWER.email}. Sign in as ada@example.com to join.`,
							),
							{ code: "forbidden" },
						);
					}
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
			rename: (accountId, name) =>
				gate(() => {
					const at = accounts.findIndex((account) => account.id === accountId);
					const account = accounts[at];
					if (account === undefined) throw new Error(`No account ${accountId}.`);
					const renamed = { ...account, name };
					accounts[at] = renamed;
					return renamed;
				}),
			setPersonalTokens: (accountId, policy) =>
				gate(() => {
					const at = accounts.findIndex((account) => account.id === accountId);
					const account = accounts[at];
					if (account === undefined) throw new Error(`No account ${accountId}.`);
					const changed = { ...account, personalTokens: policy };
					accounts[at] = changed;
					return changed;
				}),
			setRole: (accountId, memberId, role) =>
				gate(() => {
					const list = members.get(accountId) ?? [];
					const member = list.find((each) => each.id === memberId);
					if (member === undefined) throw new Error(`No member ${memberId}.`);
					const changed = { ...member, role };
					members.set(
						accountId,
						list.map((each) => (each.id === memberId ? changed : each)),
					);
					return changed;
				}),
		},
		sandboxes: {
			// A pool's shapes are the sample's, with no microVMs where none of its hosts that are up runs them.
			shapes: (_accountId: string, _hostId?: string, poolId?: string) =>
				gate(() => ({
					isolate: DEFAULT_SANDBOX_SHAPES.isolate,
					microvm:
						poolId === undefined || poolHosts(poolId, "microvm").length > 0
							? DEFAULT_SANDBOX_SHAPES.microvm
							: { ...DEFAULT_SANDBOX_SHAPES.microvm, available: false },
					...(hosting === "hosted" && DEFAULT_SANDBOX_SHAPES.rates !== undefined
						? { rates: DEFAULT_SANDBOX_SHAPES.rates }
						: {}),
				})),
			// The sample's hosts as a super-admin sees them: each one shared, so any account may be put on one.
			hosts: () =>
				gate(() =>
					HOSTS.map((sample) => {
						const host = hosts.get(sample.id) ?? sample;
						return {
							id: host.id,
							name: host.name,
							state: host.state,
							kinds: host.kvm ? (["microvm", "isolate"] as const) : (["isolate"] as const),
							shared: true,
							...(host.poolId === undefined ? {} : { poolId: host.poolId }),
						};
					}),
				),
			// The pools the Hosts page has, which the `pools` option chooses: `fail` can't be read.
			pools: () =>
				gate(() => {
					if (poolKind === "fail") throw new Error("Kantel couldn't read the pools right now.");
					return [...pools.values()].map(poolView);
				}),
			list: (accountId) =>
				gate(() =>
					[...sandboxes.values()]
						.filter((box) => box.accountId === accountId)
						.sort((a, b) => b.createdAt - a.createdAt),
				),
			create: (input: CreateSandboxInput) =>
				gate(async () => {
					// In a pool, on one of its hosts that is up and runs the type; refused as Kantel refuses it, naming the pool.
					const pooled = input.poolId === undefined ? undefined : poolHosts(input.poolId, input.kind);
					if (input.poolId !== undefined && pooled?.length === 0) {
						const name = pools.get(input.poolId)?.name ?? input.poolId;
						throw Object.assign(new Error(`No host in pool ${name} can run ${article(input.kind)} sandbox now`), {
							code: "unavailable",
						});
					}
					const hostId = input.hostId ?? pooled?.[0]?.id;
					const made = input.templateId === undefined ? undefined : await templates?.get(input.templateId);
					// A template's own vCPUs and memory when the sliders weren't moved off them.
					const shape =
						input.shape ?? (made === undefined ? undefined : { vcpus: made.spec.vcpus, memoryMb: made.spec.memoryMb });
					const id = nextId("sbx");
					const name = input.name?.trim() || `sandbox-${id.slice(-4)}`;
					const box: Sandbox = {
						id,
						name,
						hostname: `${name}.${slugOf(input.accountId)}.kantel.example.com`,
						accountId: input.accountId,
						kind: input.kind,
						size:
							shape === undefined
								? "medium"
								: ((presetOf(DEFAULT_SANDBOX_SHAPES, shape)?.name ?? "medium") as SandboxSize),
						...(shape === undefined
							? input.kind === "isolate"
								? {}
								: { resources: sampleResources("medium") }
							: {
									resources: {
										vcpus: shape.vcpus,
										memoryGb: shape.memoryMb / 1024,
										// The disk chosen, else as a host gives it: a preset's own, else the smallest preset's with
										// at least its memory.
										diskGb: input.kind === "isolate" ? 0 : (input.shape?.diskGb ?? sampleDisk(shape.memoryMb)),
									},
								}),
						state: "starting",
						createdAt: now(),
						createdBy: VIEWER.name,
						creator: { kind: "user", id: VIEWER.id },
						...(input.autoStopMinutes === undefined ? {} : { stopsAt: now() + input.autoStopMinutes * MINUTE }),
						...(input.idleStopMinutes === undefined
							? {}
							: { idleStopMinutes: input.idleStopMinutes, idleStopsAt: now() + input.idleStopMinutes * MINUTE }),
						usage: flat(),
						...(hosting === "hosted" ? { costCents: 0 } : {}),
						// The host asked for, else where the sample's placement puts each type.
						...((hostId ?? (input.kind === "isolate" ? "hst_home" : "hst_hetzner_1")) === "hst_home"
							? { hostId: "hst_home", hostName: "home-server" }
							: hostId === undefined || hostId === "hst_hetzner_1"
								? { hostId: "hst_hetzner_1", hostName: "hetzner-fsn1-01" }
								: {
										hostId,
										hostName: HOSTS.find((host) => host.id === hostId)?.name ?? hostId,
									}),
						shared: input.accountId !== PERSONAL.id,
						...(input.environmentIds === undefined || input.environmentIds.length === 0
							? {}
							: { environments: refsOf(input.environmentIds) }),
						...(made === undefined
							? {}
							: {
									template: {
										id: made.id,
										name: made.name,
										version: made.version,
										// Only a snapshot of its current version restores, and only into the vCPUs and memory it was
										// built as.
										start:
											startingSnapshot(made) === undefined ||
											shape?.vcpus !== made.spec.vcpus ||
											shape.memoryMb !== made.spec.memoryMb
												? "boot"
												: "snapshot",
									},
								}),
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
					settle(id, (latest) => {
						// Running, it has its pending environments' files and repositories.
						pendingEnvironments.delete(id);
						return { ...latest, state: "running", usage: usageSeries(id.length + 3, 0.3) };
					});
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
						creator: { kind: "user", id: VIEWER.id },
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
			// As Kantel does: the same sandbox, a microVM now, running once its files are in.
			upgrade: (id) =>
				gate(() => {
					const current = find(sandboxes, id, "sandbox");
					if (current.kind !== "isolate") return current;
					const box = put({ ...current, kind: "microvm", state: "running" });
					return box;
				}),
			recover: (id) =>
				gate(() => {
					const { error: _, ...current } = find(sandboxes, id, "sandbox");
					const box = put({ ...current, state: "starting" });
					settle(id, (latest) => ({ ...latest, state: "running", stopsAt: now() + HOUR }));
					return box;
				}),
			// As a recover, but it comes back on its base image's latest version: nothing outdated about it any more.
			restartOnLatest: (id) =>
				gate(() => {
					const { error: _, base, ...current } = find(sandboxes, id, "sandbox");
					const onLatest =
						base === undefined
							? {}
							: {
									base: {
										image: base.image,
										outdated: false,
										...(base.latest === undefined
											? base.version === undefined
												? {}
												: { version: base.version }
											: { version: base.latest.version, latest: base.latest }),
									},
								};
					const box = put({ ...current, ...onLatest, state: "starting" });
					settle(id, (latest) => ({
						...latest,
						state: "running",
						stopsAt: now() + HOUR,
						usage: usageSeries(id.length + 5, 0.3),
					}));
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
						ssh: cliSshCommand(box.id),
						cliLogin: cliLoginCommand("https://kantel.example.com"),
						sshWithoutCli: true,
						desktopUrl: `https://${box.hostname}/desktop?token=${token}`,
						desktopViewUrl: `https://${box.hostname}/desktop?token=${token}#shared`,
						browserUrl: `https://${box.hostname}/browser?token=${token}`,
					};
				}),
			sshKey: (id, publicKey) =>
				gate(() => {
					const box = find(sandboxes, id, "sandbox");
					const target = {
						sandboxId: box.id,
						user: "user",
						host: "kantel.example.com",
						port: 443,
						proxyUrl: `wss://kantel.example.com/v1/hosts/tunnel/${fakeSecret("").slice(0, 24)}`,
					};
					const shown = {
						hostKeyFingerprint: "SHA256:q8Yf3uZb1nO0xT4rWk7mJcVd2sLhP9aE6gRiKy5tBvU",
						expiresAt: now() + 10 * MINUTE,
					};
					if (publicKey !== undefined) return { command: sshWithoutCliCommand(target), ...shown };
					const keyFile = { name: `kantel-${box.id}`, path: `~/Downloads/kantel-${box.id}` };
					return {
						command: sshWithoutCliCommand(target, keyFile.path),
						privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${fakeSecret("sample")}\n-----END OPENSSH PRIVATE KEY-----\n`,
						keyFile,
						...shown,
					};
				}),
			history: (id) =>
				gate(() => {
					const box = find(sandboxes, id, "sandbox");
					// Commands ran only in a sandbox that has been up: one starting for the first time has none yet.
					return box.state === "starting" && box.snapshot === undefined
						? []
						: COMMANDS.map((command) => moved(command, ["startedAt"]));
				}),
			get: (id) => gate(() => find(sandboxes, id, "sandbox")),
			environments: {
				list: (sandboxId) => gate(() => sandboxEnvironmentsOf(sandboxId)),
				attach: (sandboxId, environmentId, position) =>
					gate(() => {
						const box = find(sandboxes, sandboxId, "sandbox");
						const env = find(environments, environmentId, "environment");
						if (env.accountId !== box.accountId) throw new Error(`No environment ${environmentId}.`);
						// Attaching one it has moves it.
						const ids = (box.environments ?? []).map((ref) => ref.id).filter((id) => id !== env.id);
						if (ids.length >= MAX_SANDBOX_ENVIRONMENTS) {
							throw new Error(`A sandbox has at most ${MAX_SANDBOX_ENVIRONMENTS} environments.`);
						}
						ids.splice(position ?? ids.length, 0, env.id);
						put({ ...box, environments: refsOf(ids) });
						// A running sandbox gets its files and repositories now; a stopped one when it next starts.
						const pending = pendingEnvironments.get(box.id) ?? new Set<string>();
						if (box.state === "running") pending.delete(env.id);
						else pending.add(env.id);
						pendingEnvironments.set(box.id, pending);
						return sandboxEnvironmentsOf(box.id);
					}),
				detach: (sandboxId, environmentId) =>
					gate(() => {
						const box = find(sandboxes, sandboxId, "sandbox");
						const ids = (box.environments ?? []).map((ref) => ref.id);
						if (!ids.includes(environmentId)) throw new Error("That environment isn't one of this sandbox's.");
						const left = ids.filter((id) => id !== environmentId);
						const { environments: _, ...rest } = box;
						put(left.length === 0 ? rest : { ...rest, environments: refsOf(left) });
						pendingEnvironments.get(box.id)?.delete(environmentId);
						return sandboxEnvironmentsOf(box.id);
					}),
			},
			setAutoStop: (id, minutes) =>
				gate(() => {
					const { stopsAt: _, ...box } = find(sandboxes, id, "sandbox");
					return put(minutes === undefined ? box : { ...box, stopsAt: now() + minutes * MINUTE });
				}),
			setIdleStop: (id, minutes) =>
				gate(() => {
					const { idleStopMinutes: _, idleStopsAt: __, ...box } = find(sandboxes, id, "sandbox");
					return put(
						minutes === undefined ? box : { ...box, idleStopMinutes: minutes, idleStopsAt: now() + minutes * MINUTE },
					);
				}),
			usageNow: (id) =>
				gate(() => {
					const box = find(sandboxes, id, "sandbox");
					const spec = sampleSpec(box);
					return { memoryGb: Math.round(spec.memoryGb * 0.32 * 10) / 10, diskGb: Math.round(spec.diskGb * 0.32) };
				}),
			// Live on this browser's clock, whatever time the rest is at: the graphs move.
			usageSeries: (id, since) => gate(() => sandboxUsage(id, since, Date.now())),
			...(allMetrics
				? {
						// Every 5 seconds over the last hour, 5-minute means over a day, hourly over a week, as the API keeps them.
						usageHistory: (id: string, range: UsageRange) =>
							gate(() => {
								// On this browser's clock, as the live read is.
								const to = Date.now();
								const { spanMs, intervalMs } = HISTORY[range];
								return sandboxUsage(id, to - spanMs, to, intervalMs, true);
							}),
						processes: (id: string) =>
							gate(() => {
								const box = find(sandboxes, id, "sandbox");
								return box.state === "running" ? sampleProcesses(box) : [];
							}),
					}
				: {}),
			rename: (id, name) =>
				gate(() => {
					const box = find(sandboxes, id, "sandbox");
					if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name))
						throw new Error(
							"A name is lowercase letters, digits and dashes, and starts and ends with a letter or digit.",
						);
					if (
						[...sandboxes.values()].some(
							(other) => other.id !== id && other.accountId === box.accountId && other.name === name,
						)
					)
						throw new Error(`This account already has a sandbox called ${name}.`);
					// As the API's: the name only, its address stays.
					return put({ ...box, name });
				}),
			ports: (id) => gate(() => [...(ports.get(id) ?? [])].sort((a, b) => a.port - b.port)),
			exposePort: (id, port, isPublic) =>
				gate(() => {
					const box = find(sandboxes, id, "sandbox");
					const url = `https://${port}-${box.hostname}`;
					const entry: SandboxPort = { port, url, public: isPublic, createdAt: now() };
					ports.set(id, [...(ports.get(id) ?? []).filter((each) => each.port !== port), entry]);
					// A private port's answer carries its token, once.
					return isPublic ? entry : { ...entry, url: `${url}?token=${fakeSecret("").slice(0, 16)}` };
				}),
			hidePort: (id, port) =>
				gate(() => {
					ports.set(
						id,
						(ports.get(id) ?? []).filter((each) => each.port !== port),
					);
				}),
			files: {
				list: (id, path) =>
					gate(() => ({
						entries: sampleFolder(sandboxes.get(id)?.kind, path).map((entry) => moved(entry, ["modifiedAt"])),
						more: false,
					})),
				read: (_id, path, range) => gate(() => samplePart(path, range)),
			},
		},
		snapshots: {
			saved: (accountId) =>
				gate(() =>
					[...saved.values()]
						.filter((entry) => entry.accountId === accountId)
						.sort((a, b) => b.createdAt - a.createdAt),
				),
			history: (sandboxId) => gate(() => [...(history.get(sandboxId) ?? [])]),
			save: (sandboxId, name, options) =>
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
						sizeBytes: Math.round(sampleSpec(box).diskGb * 1024 ** 3 * 0.1),
						uses: 0,
						...(options?.memory === true ? { memory: true } : {}),
						// Saved on the base the sandbox is on now.
						...(box.base === undefined ? {} : { base: box.base }),
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
			list: (snapshotId, path) =>
				gate(() => sampleFolder(snapshotKind(snapshotId), path).map((entry) => moved(entry, ["modifiedAt"]))),
			kindOf: (snapshotId) => gate(() => snapshotKind(snapshotId) ?? "microvm"),
			read: (_snapshotId, path, range) => gate(() => samplePart(path, range)),
			downloadUrl: (snapshotId, path) =>
				`https://kantel.example.com/v1/snapshots/${encodeURIComponent(snapshotId)}/download?path=${encodeURIComponent(path)}`,
		},
		personalTokens: {
			list: () => gate(() => [...personalTokens.values()].sort((a, b) => b.createdAt - a.createdAt)),
			create: (input) =>
				gate(() => {
					const secret = fakeSecret("kpt_");
					const token: PersonalToken = {
						id: nextId("pat"),
						name: input.name,
						prefix: secret.slice(0, 8),
						...(input.scopes === undefined ? {} : { scopes: input.scopes }),
						...(input.accounts === undefined ? {} : { accounts: input.accounts }),
						createdAt: now(),
						expiresAt: now() + input.expiresInDays * DAY,
					};
					personalTokens.set(token.id, token);
					return { token, secret };
				}),
			revoke: (id) =>
				gate(() => {
					const revoked = { ...find(personalTokens, id, "personal token"), revokedAt: now() };
					personalTokens.set(id, revoked);
					return revoked;
				}),
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
									logRequests: false,
								}),
				),
			update: (accountId, change) =>
				gate(async () => {
					const current = proxies.get(accountId) ?? (await source.proxy.get(accountId));
					const { upstream, expected, ...rest } = change;
					// As with Kantel's API, a change made from an older read is refused.
					if (expected !== undefined && !sameProxySettings(expected, current)) {
						throw Object.assign(
							new Error("The proxy settings changed since you read them; read them again and redo the change"),
							{ code: "conflict" },
						);
					}
					const merged: ProxySettings = { ...current, ...rest };
					// As with Kantel's API, nothing allowed is closed: closing empties the allow list, and Allowed hosts with
					// none allowed reads back as closed.
					const next: ProxySettings =
						merged.policy === "closed"
							? { ...merged, allow: [] }
							: merged.policy === "allowlist" && merged.allow.length === 0
								? { ...merged, policy: "closed" }
								: merged;
					const withUpstream: ProxySettings =
						upstream === undefined
							? next
							: upstream === null
								? (({ upstream: _, ...without }) => without)(next)
								: {
										...next,
										upstream: {
											url: upstream.url,
											// No `auth` keeps the credentials; an empty one removes them.
											authSet: upstream.auth === undefined ? current.upstream?.authSet === true : upstream.auth !== "",
										},
									};
					proxies.set(accountId, withUpstream);
					return withUpstream;
				}),
		},
		...(templates === undefined ? {} : { templates }),
		environments: {
			...(noProtectedValues ? { protectedValues: false } : {}),
			list: (accountId) =>
				gate(() =>
					[...environments.values()]
						.filter((env) => env.accountId === accountId)
						.sort((a, b) => a.name.localeCompare(b.name)),
				),
			get: (id) => gate(() => find(environments, id, "environment")),
			create: (input) =>
				gate(() => {
					const name = input.name.trim();
					if ([...environments.values()].some((env) => env.accountId === input.accountId && env.name === name)) {
						throw new Error(`There's already an environment called ${name}.`);
					}
					const env: Environment = {
						id: nextId("env"),
						accountId: input.accountId,
						name,
						...(input.description === undefined || input.description === "" ? {} : { description: input.description }),
						variables: [],
						files: [],
						repos: [],
						grants: [],
						sandboxCount: 0,
						createdAt: now(),
						updatedAt: now(),
					};
					environments.set(env.id, env);
					return env;
				}),
			update: (id, change) =>
				gate(() => {
					const env = find(environments, id, "environment");
					const { description: _, ...rest } = env;
					const description = change.description ?? env.description;
					return putEnvironment({
						...rest,
						name: change.name?.trim() || env.name,
						...(description === undefined || description === "" ? {} : { description }),
					});
				}),
			// It comes off every sandbox that has it.
			remove: (id) =>
				gate(() => {
					find(environments, id, "environment");
					environments.delete(id);
					for (const box of sandboxes.values()) {
						if (box.environments?.some((ref) => ref.id === id) !== true) continue;
						const left = box.environments.filter((ref) => ref.id !== id);
						const { environments: _, ...rest } = box;
						put(left.length === 0 ? rest : { ...rest, environments: left });
						pendingEnvironments.get(box.id)?.delete(id);
					}
				}),
			setVariable: (id, input) =>
				gate(() => {
					const env = find(environments, id, "environment");
					const existing = env.variables.find((variable) => variable.name === input.name);
					if (input.protected && noProtectedValues)
						throw Object.assign(new Error(NO_PROTECTED_VALUES), { code: "not_supported" });
					if (input.protected && input.bindings.length === 0) {
						throw new Error("A protected variable needs at least one host it's bound to.");
					}
					if (input.value === undefined && (existing === undefined || existing.protected !== input.protected)) {
						throw new Error(`Give ${input.name} a value.`);
					}
					const value = input.value ?? existing?.value;
					const variable = {
						name: input.name,
						protected: input.protected,
						...(input.protected || value === undefined ? {} : { value }),
						bindings: input.protected ? input.bindings : [],
						updatedAt: now(),
					};
					return putEnvironment({
						...env,
						variables:
							existing === undefined
								? [...env.variables, variable]
								: env.variables.map((each) => (each.name === input.name ? variable : each)),
					});
				}),
			removeVariable: (id, name) =>
				gate(() => {
					const env = find(environments, id, "environment");
					return putEnvironment({ ...env, variables: env.variables.filter((variable) => variable.name !== name) });
				}),
			setFile: (id, input) =>
				gate(() => {
					if (noProtectedValues) throw Object.assign(new Error(NO_PROTECTED_VALUES), { code: "not_supported" });
					const env = find(environments, id, "environment");
					const existing = env.files.find((file) => file.path === input.path);
					if (input.content === undefined && existing === undefined)
						throw new Error(`Give ${input.path} its contents.`);
					const file = {
						path: input.path,
						mode: input.mode,
						sizeBytes: input.content === undefined ? (existing?.sizeBytes ?? 0) : new Blob([input.content]).size,
						updatedAt: now(),
					};
					return putEnvironment({
						...env,
						files:
							existing === undefined
								? [...env.files, file]
								: env.files.map((each) => (each.path === input.path ? file : each)),
					});
				}),
			removeFile: (id, path) =>
				gate(() => {
					const env = find(environments, id, "environment");
					return putEnvironment({ ...env, files: env.files.filter((file) => file.path !== path) });
				}),
			setRepos: (id, repos) =>
				gate(() => {
					const env = find(environments, id, "environment");
					const urls = repos.map((repo) => repo.url);
					const twice = urls.find((url, at) => urls.indexOf(url) !== at);
					if (twice !== undefined) throw new Error(`${twice} is in the list twice.`);
					return putEnvironment({ ...env, repos });
				}),
			setGrants: (id, grants, expected) =>
				gate(() => {
					const env = find(environments, id, "environment");
					requireGrants(expected, env.grants, "The environment's grants");
					return putEnvironment({ ...env, grants });
				}),
		},
		egress: {
			get: (sandboxId) => gate(() => egressOf(sandboxId)),
			setGrants: (sandboxId, grants, expected) =>
				gate(() => {
					find(sandboxes, sandboxId, "sandbox");
					requireGrants(expected, sandboxGrants.get(sandboxId) ?? [], "The sandbox's grants");
					sandboxGrants.set(sandboxId, grants);
					return egressOf(sandboxId);
				}),
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
		...(mountsOn
			? {
					mounts: {
						bundles: (accountId) =>
							gate(() =>
								[...bundles.values()]
									.filter((bundle) => bundle.accountId === accountId)
									.map((bundle) => ({ ...bundle, mountedBy: mountCount(accountId, bundleUses(bundle.digest)) }))
									.sort((a, b) => b.createdAt - a.createdAt),
							),
						removeBundle: (accountId, digest) =>
							gate(() => {
								const key = bundleKey(accountId, digest);
								if (!bundles.has(key)) throw new Error(`No bundle ${digest}.`);
								requireUnmounted(mountCount(accountId, bundleUses(digest)));
								bundles.delete(key);
							}),
						bucketSources: (accountId) =>
							gate(() =>
								[...bucketSources.values()]
									.filter((bucket) => bucket.accountId === accountId)
									.map((bucket) => ({ ...bucket, mountedBy: mountCount(accountId, bucketUses(bucket.id)) }))
									.sort((a, b) => a.createdAt - b.createdAt),
							),
						removeBucketSource: (id) =>
							gate(() => {
								const bucket = find(bucketSources, id, "bucket source");
								requireUnmounted(mountCount(bucket.accountId, bucketUses(id)));
								bucketSources.delete(id);
							}),
					},
				}
			: {}),
		...(options.notSuperAdmin === true
			? {}
			: {
					hosts: {
						// An update finishes a few seconds after it's asked for, as a host's restart does.
						list: () =>
							gate(() => {
								for (const [id, host] of hosts) {
									const done = updateDone.get(id);
									if (host.updating === undefined || done === undefined || Date.now() < done) continue;
									const { updating, updateAvailable: _, ...rest } = host;
									hosts.set(id, { ...rest, version: updating.version });
									updateDone.delete(id);
								}
								return [...hosts.values()];
							}),
						update: (id) =>
							gate(() => {
								const host = find(hosts, id, "host");
								if (host.updateAvailable === undefined) throw new Error(`${host.name} is up to date.`);
								if (host.state === "offline")
									throw new Error(`${host.name} isn't connected: update it once it's back.`);
								const next = { ...host, updating: { version: host.updateAvailable, since: now() } };
								hosts.set(id, next);
								updateDone.set(id, Date.now() + 8_000);
								return next;
							}),
						// The release the sample hosts are behind.
						checkForUpdates: () => gate(() => ({ checked: true, latestVersion: "0.4.2" })),
						usage: (id, since) =>
							gate(() => {
								const host = find(hosts, id, "host");
								const memLimitBytes = host.memoryGb * 1024 ** 3;
								const diskTotalBytes = host.diskGb * 1024 ** 3;
								if (host.state === "offline" || host.state === "joining") {
									return { intervalMs: 5_000, memLimitBytes, diskTotalBytes, points: [] };
								}
								// Round what's allocated on it, which is what its sandboxes could use.
								return stubUsage(id, {
									since,
									now: Date.now(),
									memLimitBytes,
									diskTotalBytes,
									busy: Math.max(0.03, (host.used.vcpus / Math.max(1, host.vcpus)) * 0.6),
									memory: Math.max(0.05, (host.used.memoryGb / Math.max(1, host.memoryGb)) * 0.8),
									disk: host.used.diskGb / Math.max(1, host.diskGb),
								});
							}),
						// The command as the control plane makes it (packages/compute, createHostJoinToken): the host's name and
						// labels go with the token, not on the command line.
						join: () =>
							gate(() => {
								const token = fakeSecret("kth_");
								return {
									token,
									expiresAt: now() + HOUR,
									command: `curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url ${publicUrl().publicUrl} --token ${token}`,
								};
							}),
						publicUrl: {
							get: () => gate(publicUrl),
							set: (url) =>
								gate(() => {
									if (url !== null && !/^https?:\/\/[^/\s]+\/?$/.test(url.trim())) {
										throw new Error("The public URL is an origin, with no path, such as https://kantel.example.com");
									}
									publicUrlSet = url === null ? undefined : url.trim().replace(/\/$/, "");
									return publicUrl();
								}),
						},
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
						setSnapshotLimit: (id, bytes) =>
							gate(() => {
								const { savedSnapshotLimitBytes: _, ...rest } = find(hosts, id, "host");
								const host: Host = bytes === null ? rest : { ...rest, savedSnapshotLimitBytes: bytes };
								hosts.set(id, host);
								return host;
							}),
						// As Kantel's API moves a host: only a draining one with no sandboxes, refused otherwise with the reason.
						...(poolKind === "none"
							? {}
							: {
									move: (id: string, poolId: string) =>
										gate(() => {
											const host = find(hosts, id, "host");
											const into = find(pools, poolId, "pool");
											if (host.poolId === into.id) return host;
											if (host.state !== "draining") {
												throw Object.assign(
													new Error(
														"Drain the host before moving it to another pool, and move it once it has no sandboxes",
													),
													{ code: "conflict" },
												);
											}
											if (host.sandboxes.isolates + host.sandboxes.microvms > 0) {
												throw Object.assign(new Error("The host still has sandboxes: move it once they are deleted"), {
													code: "conflict",
												});
											}
											const moved = { ...host, poolId: into.id };
											hosts.set(id, moved);
											return moved;
										}),
									pools: {
										list: () =>
											gate(() => {
												if (poolKind === "fail") throw new Error("Kantel couldn't read the pools right now.");
												return [...pools.values()].map(poolView);
											}),
										create: (name: string) =>
											gate(() => {
												poolNamed(name);
												const pool: Pool = { id: nextId("pool"), name, default: false, hosts: 0, createdAt: now() };
												pools.set(pool.id, pool);
												return poolView(pool);
											}),
										rename: (id: string, name: string) =>
											gate(() => {
												poolNamed(name, id);
												const pool = { ...find(pools, id, "pool"), name };
												pools.set(id, pool);
												return poolView(pool);
											}),
										makeDefault: (id: string) =>
											gate(() => {
												find(pools, id, "pool");
												for (const [key, pool] of pools) pools.set(key, { ...pool, default: key === id });
												return poolView(find(pools, id, "pool"));
											}),
										remove: (id: string) =>
											gate(() => {
												const pool = poolView(find(pools, id, "pool"));
												if (pool.default) {
													throw Object.assign(
														new Error(`${pool.name} is the default pool: make another the default first`),
														{ code: "conflict" },
													);
												}
												if (pool.hosts > 0) {
													throw Object.assign(
														new Error(
															`${pool.name} still has ${pool.hosts === 1 ? "a host" : `${pool.hosts} hosts`} in it: move them to another pool first`,
														),
														{ code: "conflict" },
													);
												}
												pools.delete(id);
											}),
									},
								}),
					},
					images: {
						overview: () =>
							gate(() =>
								empty
									? {
											images: [],
											templates: [],
											indexUrl: "https://github.com/lleverage-ai/kantel/releases/download/base-images/index.json",
										}
									: sampleImages(at),
							),
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
