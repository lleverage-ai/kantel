// Sample templates for the console's Templates pages and New sandbox's picker: one of each build state (ready, a new
// version building over a stale one, a pinned base behind its channel, a failed setup), a Dockerfile built on the
// base and an image reference (custom images, built in an isolated build microVM), the base channels they follow
// or pin, and an in-memory source that builds in the background as Kantel does, so a story or the sample console can
// make, change and rebuild one.

import { DAY, HOUR, MINUTE } from "../primitives/format.ts";
import type {
	Template,
	TemplateBaseChannel,
	TemplateSnapshot,
	TemplateSpec,
	TemplatesSource,
	TemplateVersion,
} from "./compute-model.ts";

/** A made-up digest, the same for the same seed. */
export function sampleDigest(seed: number): string {
	let state = seed * 2_654_435_761 + 1;
	let hex = "";
	while (hex.length < 64) {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		hex += state.toString(16).padStart(8, "0").slice(-8);
	}
	return `sha256:${hex.slice(0, 64)}`;
}

const KERNEL = "6.1.141";
const FIRECRACKER = "1.13.1";
const BASE_IMAGE = "kantel/sandbox";
/** The base channel's digest now, and the three before it. */
export const BASE_STABLE = sampleDigest(7);
const BASE_OLDER = [sampleDigest(6), sampleDigest(5), sampleDigest(4)];

interface Sample {
	readonly template: Template;
	readonly versions: readonly TemplateVersion[];
	readonly snapshots: readonly TemplateSnapshot[];
}

const snapshot = (
	templateId: string,
	spec: TemplateSpec,
	version: number,
	fields: Partial<TemplateSnapshot> & Pick<TemplateSnapshot, "id" | "state" | "startedAt">,
	baseDigest = spec.base.digest ?? BASE_STABLE,
): TemplateSnapshot => {
	const imageDigest = sampleDigest(templateId.length * 13 + version);
	// A custom image's key has its source from the claim, and the digest its build made once it is built.
	const built = fields.state === "ready" || fields.state === "stale";
	const custom =
		spec.image.kind === "dockerfile"
			? {
					key: { source: `dockerfile:${sampleDigest(spec.image.dockerfile.length)}` },
					builtFrom: { source: "dockerfile" as const, dockerfileDigest: sampleDigest(spec.image.dockerfile.length) },
				}
			: spec.image.kind === "image"
				? {
						key: { source: `image:${spec.image.ref}` },
						builtFrom: { source: "image" as const, imageRef: spec.image.ref },
					}
				: undefined;
	return {
		version,
		key: {
			templateVersion: `${templateId}@${version}`,
			baseDigest,
			...custom?.key,
			...(custom !== undefined && built ? { imageDigest } : {}),
			kernel: KERNEL,
			firecracker: FIRECRACKER,
			vcpus: spec.vcpus,
		},
		keyHash: sampleDigest(templateId.length * 31 + version * 7 + baseDigest.length).slice(7, 71),
		hostId: "hst_hetzner_1",
		builtFrom: {
			baseImage: spec.base.image,
			...(spec.base.channel === undefined ? {} : { channel: spec.base.channel }),
			baseDigest,
			pinned: spec.base.digest !== undefined,
			...(custom === undefined || built ? { imageDigest } : {}),
			...custom?.builtFrom,
		},
		...fields,
	};
};

// The samples boot Kantel's base and install the rest in their setup scripts, which run in the machine behind the
// template's egress grants: each allows the hosts its script fetches from (Ubuntu's packages are snapshot.ubuntu.com on
// the Kantel base).
const allow = (id: string, host: string) => ({ id, action: "allow", host, methods: [], paths: [] }) as const;
const UBUNTU_GRANT = allow("grt_tpl_ubuntu", "snapshot.ubuntu.com");
const KANTEL_BASE = { kind: "kantel-base" } as const;

const PYTHON: TemplateSpec = {
	image: KANTEL_BASE,
	base: { image: BASE_IMAGE, channel: "stable" },
	vcpus: 4,
	memoryMb: 8192,
	env: { PYTHONUNBUFFERED: "1", UV_LINK_MODE: "copy" },
	setup: [
		"apt-get update && apt-get install -y --no-install-recommends python3.12 python3.12-venv python3-pip",
		"pip install --break-system-packages uv==0.9.5",
		"uv pip install --system --break-system-packages pandas polars duckdb jupyterlab",
		"install -d -o user -g user /home/user/notebooks",
	].join("\n"),
	grants: [UBUNTU_GRANT, allow("grt_tpl_pypi", "pypi.org"), allow("grt_tpl_pyfiles", "files.pythonhosted.org")],
};

const NODE_V1: TemplateSpec = {
	image: KANTEL_BASE,
	base: { image: BASE_IMAGE, channel: "stable" },
	vcpus: 2,
	memoryMb: 4096,
	env: { NODE_ENV: "development" },
	setup: [
		"curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource.sh && bash /tmp/nodesource.sh",
		"apt-get install -y --no-install-recommends nodejs",
		"corepack enable && corepack prepare pnpm@10 --activate",
		"pnpm dlx playwright install --with-deps chromium",
		"install -d -o user -g user /home/user/app",
	].join("\n"),
	grants: [
		UBUNTU_GRANT,
		allow("grt_tpl_nodesource", "deb.nodesource.com"),
		allow("grt_tpl_npm", "registry.npmjs.org"),
		allow("grt_tpl_playwright", "cdn.playwright.dev"),
	],
};
const NODE_V2: TemplateSpec = { ...NODE_V1, vcpus: 4, memoryMb: 8192 };

const PINNED: TemplateSpec = {
	image: KANTEL_BASE,
	base: { image: BASE_IMAGE, digest: BASE_OLDER[2] as string },
	vcpus: 2,
	memoryMb: 4096,
	env: {},
	setup: [
		"apt-get update && apt-get install -y --no-install-recommends ffmpeg imagemagick",
		"install -d -o user -g user /home/user/media",
	].join("\n"),
	grants: [UBUNTU_GRANT],
};

const RUST: TemplateSpec = {
	image: KANTEL_BASE,
	base: { image: BASE_IMAGE, channel: "stable" },
	vcpus: 8,
	memoryMb: 16_384,
	env: { CARGO_TERM_COLOR: "always", RUSTFLAGS: "-D warnings" },
	setup: [
		"apt-get update && apt-get install -y --no-install-recommends rustup build-essential",
		"rustup toolchain install 1.83 --profile minimal --component clippy,rustfmt && rustup default 1.83",
		"cargo install cargo-nextest --locked",
	].join("\n"),
	grants: [
		UBUNTU_GRANT,
		allow("grt_tpl_rustup", "static.rust-lang.org"),
		allow("grt_tpl_crates", "crates.io"),
		allow("grt_tpl_crates_index", "index.crates.io"),
		allow("grt_tpl_static", "static.crates.io"),
	],
};

/** A Dockerfile on the template's base (`FROM $KANTEL_BASE`), built with no build context in a build microVM. */
const CI_DOCKERFILE = [
	"ARG KANTEL_BASE",
	"FROM $KANTEL_BASE",
	"RUN apt-get update && apt-get install -y --no-install-recommends ripgrep jq shellcheck \\",
	" && rm -rf /var/lib/apt/lists/*",
	"RUN curl -fsSL https://github.com/cli/cli/releases/download/v2.63.0/gh_2.63.0_linux_amd64.tar.gz \\",
	"  | tar -xz -C /usr/local --strip-components=1",
	"ENV GH_PROMPT_DISABLED=1",
	"",
].join("\n");

const CI_TOOLS: TemplateSpec = {
	image: { kind: "dockerfile", dockerfile: CI_DOCKERFILE },
	base: { image: BASE_IMAGE, channel: "stable" },
	vcpus: 2,
	memoryMb: 4096,
	env: {},
	grants: [
		UBUNTU_GRANT,
		allow("grt_tpl_github", "github.com"),
		allow("grt_tpl_ghobjects", "objects.githubusercontent.com"),
	],
};

/** An image reference, pulled in a build microVM; it boots with Kantel's guest agent added. */
const PYTHON_SLIM: TemplateSpec = {
	image: { kind: "image", ref: "python:3.13-slim" },
	base: { image: BASE_IMAGE, channel: "stable" },
	vcpus: 2,
	memoryMb: 2048,
	env: { PYTHONUNBUFFERED: "1" },
	setup: "pip install --no-cache-dir httpx==0.28.1",
	grants: [allow("grt_tpl_pypi_slim", "pypi.org"), allow("grt_tpl_pyfiles_slim", "files.pythonhosted.org")],
};

/**
 * The deployment's published bases: `kantel/sandbox`'s stable channel, its digest now and the three before it (the
 * oldest is media-tools' pin), and a beta channel a release ahead of it.
 */
export function sampleTemplateBases(now: number): readonly TemplateBaseChannel[] {
	const stable = [
		{ digest: BASE_STABLE, publishedAt: now - 3 * DAY },
		{ digest: BASE_OLDER[0] as string, publishedAt: now - 9 * DAY },
		{ digest: BASE_OLDER[1] as string, publishedAt: now - 16 * DAY },
		{ digest: BASE_OLDER[2] as string, publishedAt: now - 30 * DAY },
	];
	const beta = { digest: sampleDigest(8), publishedAt: now - 6 * HOUR };
	return [
		{ image: BASE_IMAGE, channel: "stable", digest: BASE_STABLE, publishedAt: now - 3 * DAY, history: stable },
		{ image: BASE_IMAGE, channel: "beta", ...beta, history: [beta, ...stable.slice(0, 1)] },
	];
}

const ACCOUNT = "org_lleverage";

function samples(now: number): readonly Sample[] {
	const python = "tpl_python";
	const node = "tpl_node";
	const pinned = "tpl_media";
	const rust = "tpl_rust";
	const ci = "tpl_ci";
	const slim = "tpl_slim";
	const ciReady = snapshot(ci, CI_TOOLS, 1, {
		id: "tsn_ci_1",
		state: "ready",
		startedAt: now - 5 * HOUR - 6 * MINUTE,
		readyAt: now - 5 * HOUR,
		sizeBytes: 1_356_000_000,
	});
	const slimReady = snapshot(slim, PYTHON_SLIM, 1, {
		id: "tsn_slim_1",
		state: "ready",
		startedAt: now - 26 * HOUR - 3 * MINUTE,
		readyAt: now - 26 * HOUR,
		sizeBytes: 412_000_000,
	});
	const pythonReady = snapshot(python, PYTHON, 3, {
		id: "tsn_python_3",
		state: "ready",
		startedAt: now - 2 * HOUR - 4 * MINUTE,
		readyAt: now - 2 * HOUR,
		sizeBytes: 1_812_000_000,
	});
	const nodeStale = snapshot(node, NODE_V1, 1, {
		id: "tsn_node_1",
		state: "stale",
		startedAt: now - 3 * DAY,
		readyAt: now - 3 * DAY + 3 * MINUTE,
		sizeBytes: 1_204_000_000,
	});
	const nodeBuilding = snapshot(node, NODE_V2, 2, { id: "tsn_node_2", state: "building", startedAt: now - 70_000 });
	const pinnedReady = snapshot(pinned, PINNED, 1, {
		id: "tsn_media_1",
		state: "ready",
		startedAt: now - 19 * DAY,
		readyAt: now - 19 * DAY + 2 * MINUTE,
		sizeBytes: 960_000_000,
	});
	const rustFailed = snapshot(rust, RUST, 1, {
		id: "tsn_rust_1",
		state: "failed",
		startedAt: now - 40 * MINUTE,
		error:
			"The setup script exited with 101.\n   Compiling ring v0.17.8\nerror: failed to run custom build command for `ring v0.17.8`\n  cc: fatal error: Killed signal terminated program cc1",
	});
	const template = (
		id: string,
		name: string,
		description: string | undefined,
		spec: TemplateSpec,
		version: number,
		build: Template["build"],
		sandboxCount: number,
		createdAt: number,
		updatedAt: number,
	): Template => ({
		id,
		accountId: ACCOUNT,
		name,
		...(description === undefined ? {} : { description }),
		version,
		spec,
		build,
		sandboxCount,
		createdAt,
		updatedAt,
	});
	return [
		{
			template: template(
				python,
				"python-data",
				"Python 3.12 with uv, pandas, polars and DuckDB for notebooks and evals.",
				PYTHON,
				3,
				{ state: "ready", ready: pythonReady },
				6,
				now - 30 * DAY,
				now - 2 * HOUR,
			),
			versions: [
				{ version: 3, spec: PYTHON, createdAt: now - 2 * HOUR, by: "Tom Davies" },
				{
					version: 2,
					spec: { ...PYTHON, setup: (PYTHON.setup as string).replace(" jupyterlab", "") },
					createdAt: now - 9 * DAY,
					by: "ci-bot",
				},
				{
					version: 1,
					spec: {
						...PYTHON,
						vcpus: 2,
						memoryMb: 4096,
						setup: (PYTHON.setup as string).replace(" duckdb jupyterlab", ""),
					},
					createdAt: now - 30 * DAY,
					by: "Tom Davies",
				},
			],
			snapshots: [
				pythonReady,
				snapshot(
					python,
					PYTHON,
					3,
					{
						id: "tsn_python_3_old",
						state: "discarded",
						startedAt: now - 2 * DAY,
						readyAt: now - 2 * DAY + 4 * MINUTE,
						sizeBytes: 1_809_000_000,
					},
					BASE_OLDER[0],
				),
			],
		},
		{
			template: template(
				node,
				"node-web",
				"Node 22 and pnpm with Playwright's Chromium, for the web app's tests.",
				NODE_V2,
				2,
				{ state: "building", ready: nodeStale, building: nodeBuilding },
				3,
				now - 12 * DAY,
				now - 2 * MINUTE,
			),
			versions: [
				{ version: 2, spec: NODE_V2, createdAt: now - 2 * MINUTE, by: "Tom Davies" },
				{ version: 1, spec: NODE_V1, createdAt: now - 12 * DAY, by: "Tom Davies" },
			],
			snapshots: [nodeBuilding, nodeStale],
		},
		{
			template: template(
				pinned,
				"media-tools",
				"ffmpeg on a base pinned for a customer's audit.",
				PINNED,
				1,
				{
					state: "ready",
					ready: pinnedReady,
					behind: { releases: 3, since: now - 16 * DAY, latestDigest: BASE_STABLE },
				},
				0,
				now - 19 * DAY,
				now - 19 * DAY,
			),
			versions: [{ version: 1, spec: PINNED, createdAt: now - 19 * DAY, by: "Ana Ruiz" }],
			snapshots: [pinnedReady],
		},
		{
			template: template(
				rust,
				"rust-ci",
				undefined,
				RUST,
				1,
				{ state: "failed", building: rustFailed, error: rustFailed.error as string },
				0,
				now - 41 * MINUTE,
				now - 41 * MINUTE,
			),
			versions: [{ version: 1, spec: RUST, createdAt: now - 41 * MINUTE, by: "ci-bot" }],
			snapshots: [rustFailed],
		},
		{
			template: template(
				ci,
				"ci-tools",
				"ripgrep, jq, shellcheck and the GitHub CLI, from a Dockerfile on the stable base.",
				CI_TOOLS,
				1,
				{ state: "ready", ready: ciReady },
				2,
				now - 5 * HOUR - 6 * MINUTE,
				now - 5 * HOUR - 6 * MINUTE,
			),
			versions: [{ version: 1, spec: CI_TOOLS, createdAt: now - 5 * HOUR - 6 * MINUTE, by: "Tom Davies" }],
			snapshots: [ciReady],
		},
		{
			template: template(
				slim,
				"python-slim",
				"Docker Hub's python:3.13-slim, with httpx.",
				PYTHON_SLIM,
				1,
				{ state: "ready", ready: slimReady },
				1,
				now - 26 * HOUR - 3 * MINUTE,
				now - 26 * HOUR - 3 * MINUTE,
			),
			versions: [{ version: 1, spec: PYTHON_SLIM, createdAt: now - 26 * HOUR - 3 * MINUTE, by: "Ana Ruiz" }],
			snapshots: [slimReady],
		},
	];
}

/** The sample templates, as their list shows them. */
export function sampleTemplates(now: number): readonly Template[] {
	return samples(now).map((sample) => sample.template);
}

export interface TemplateFixtureOptions {
	/** The time the samples are at. */
	readonly now: number;
	/** Now, as the source moves on: a live console's clock. */
	readonly clock?: () => number;
	/** No templates. */
	readonly empty?: boolean;
	/** How long a build takes, in milliseconds. */
	readonly buildMs?: number;
	/** Wraps every call: a delay, a hang or a failure. */
	readonly gate?: <T>(make: () => T | Promise<T>) => Promise<T>;
	/** Whose sample templates these are. */
	readonly accountId?: string;
}

let made = 0;

/** An in-memory templates source over the samples: makes, changes, rebuilds and deletes, building in the background. */
export function createTemplateFixtures(options: TemplateFixtureOptions): TemplatesSource {
	const clock = options.clock ?? (() => options.now);
	const gate = options.gate ?? (async <T>(make: () => T | Promise<T>) => make());
	const buildMs = options.buildMs ?? 4000;
	const account = options.accountId ?? ACCOUNT;
	const all = new Map<string, Sample>(
		(options.empty === true ? [] : samples(options.now)).map((sample) => [
			sample.template.id,
			{ ...sample, template: { ...sample.template, accountId: account } },
		]),
	);
	const find = (id: string): Sample => {
		const found = all.get(id);
		if (found === undefined) throw new Error(`No template ${id}.`);
		return found;
	};
	/**
	 * Starts a build of the template's current version; the last ready one goes stale, kept until it is done, and serves
	 * meanwhile only if it's of that version (a rebuild's), as `startingSnapshot` says.
	 */
	const build = (sample: Sample): Sample => {
		made += 1;
		const { template } = sample;
		const previous = template.build.ready;
		const stale = previous === undefined ? undefined : { ...previous, state: "stale" as const };
		const building = snapshot(template.id, template.spec, template.version, {
			id: `tsn_${template.id.slice(4)}_${template.version}_${made}`,
			state: "building",
			startedAt: clock(),
		});
		const next: Sample = {
			...sample,
			template: {
				...template,
				build: { state: "building", building, ...(stale === undefined ? {} : { ready: stale }) },
			},
			snapshots: [
				building,
				...sample.snapshots.map((entry) => (stale !== undefined && entry.id === stale.id ? stale : entry)),
			],
		};
		all.set(template.id, next);
		setTimeout(() => {
			const current = all.get(template.id);
			if (current === undefined || current.template.build.building?.id !== building.id) return;
			const ready: TemplateSnapshot = { ...building, state: "ready", readyAt: clock(), sizeBytes: 1_400_000_000 };
			all.set(template.id, {
				...current,
				template: { ...current.template, build: { state: "ready", ready } },
				snapshots: current.snapshots.map((entry) =>
					entry.id === building.id ? ready : entry.state === "stale" ? { ...entry, state: "discarded" } : entry,
				),
			});
		}, buildMs);
		return next;
	};
	const sameSpec = (a: TemplateSpec, b: TemplateSpec): boolean => JSON.stringify(a) === JSON.stringify(b);

	return {
		list: (accountId) =>
			gate(() =>
				[...all.values()]
					.map((sample) => sample.template)
					.filter((template) => template.accountId === accountId)
					.sort((a, b) => a.name.localeCompare(b.name)),
			),
		get: (id) => gate(() => find(id).template),
		create: (input) =>
			gate(() => {
				const name = input.name.trim();
				if (
					[...all.values()].some((each) => each.template.accountId === input.accountId && each.template.name === name)
				) {
					throw new Error(`There's already a template called ${name}.`);
				}
				made += 1;
				const id = `tpl_new${made.toString(36)}`;
				const at = clock();
				const sample: Sample = {
					template: {
						id,
						accountId: input.accountId,
						name,
						...(input.description === undefined || input.description === "" ? {} : { description: input.description }),
						version: 1,
						spec: input.spec,
						build: { state: "none" },
						sandboxCount: 0,
						createdAt: at,
						updatedAt: at,
					},
					versions: [{ version: 1, spec: input.spec, createdAt: at, by: "Tom Davies" }],
					snapshots: [],
				};
				return build(sample).template;
			}),
		update: (id, change) =>
			gate(() => {
				const sample = find(id);
				const { description: _, ...rest } = sample.template;
				const description = change.description ?? sample.template.description;
				const changed = change.spec !== undefined && !sameSpec(change.spec, sample.template.spec);
				const version = changed ? sample.template.version + 1 : sample.template.version;
				const next: Sample = {
					...sample,
					template: {
						...rest,
						name: change.name?.trim() || sample.template.name,
						...(description === undefined || description === "" ? {} : { description }),
						version,
						spec: change.spec ?? sample.template.spec,
						updatedAt: clock(),
					},
					versions:
						changed && change.spec !== undefined
							? [{ version, spec: change.spec, createdAt: clock(), by: "Tom Davies" }, ...sample.versions]
							: sample.versions,
				};
				all.set(id, next);
				return changed ? build(next).template : next.template;
			}),
		remove: (id) =>
			gate(() => {
				find(id);
				all.delete(id);
			}),
		versions: (id) => gate(() => find(id).versions),
		snapshots: (id) => gate(() => find(id).snapshots),
		bases: () => gate(() => sampleTemplateBases(options.now)),
		rebuild: (id) =>
			gate(() => {
				const sample = find(id);
				// As Kantel does: the ready snapshot goes stale, still serving if it's of the current version, until the
				// rebuild's replaces it; a build on its way or a failed one is thrown away.
				const setAside: Sample = {
					...sample,
					snapshots: sample.snapshots.map((entry) =>
						entry.state === "queued" || entry.state === "building" || entry.state === "failed"
							? { ...entry, state: "discarded" }
							: entry,
					),
				};
				return build(setAside).template;
			}),
	};
}
