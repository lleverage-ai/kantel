#!/usr/bin/env node
/**
 * The base image index's command line, for the pipeline in .github/workflows/sandbox-image.yml. Every change goes
 * through the index's own functions (packages/compute/src/base-images.ts), which the gateway reads it with. Each
 * command prints its result to stdout; the workflow signs and uploads it. An index file that doesn't exist is an empty
 * index (the first build), and `-` reads it from standard input.
 *
 *   index.ts record <index.json|-> <build.json>...
 *       the index with each build recorded (`recordBuild`): its version first, and its channels moved to it
 *   index.ts build <index.json|-> <name> <repository> <version> <digest> [--scan <scan.json>] [--commit <sha>]
 *                  [--reason daily|cve|manual|push] [--signed] [--built-at <ISO 8601>]
 *       a build to record (a `PublishedBuild`), taking `stable` only when that doesn't regress the channel: never with
 *       more fixable Critical findings than what `stable` names now. <scan.json> is scan.ts's summary.
 *   index.ts scan <index.json|-> <name> <digest> <trivy.json> [--scanner "trivy 0.76.1"]
 *       the index with a fresh scan of one version recorded (`recordScan`)
 *   index.ts needs-rebuild <index.json|->
 *       the names, comma-separated, whose `stable` version has a fixable Critical or High finding (an empty line if none)
 *   index.ts stable <index.json|->
 *       one line per image whose `stable` names a version the index lists: name, repository and digest, tab-separated
 *   index.ts summary <index.json|->
 *       a Markdown table of what each image's `stable` names, for the job summary
 *
 * Exit 1 on a file it can't read or an index it refuses, 2 on a wrong command line.
 *
 * Runs with Node's type stripping, so it imports nothing beyond Node's own modules and the shared module.
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import {
	BASE_IMAGE_INDEX_VERSION,
	type BaseImageIndex,
	type BaseImageVersion,
	type BuildReason,
	emptyIndex,
	type ImageScan,
	needsRebuild,
	type PublishedBuild,
	parseIndex,
	recordBuild,
	recordScan,
	summariseTrivy,
} from "../../packages/compute/src/base-images.ts";

/** Reads a file, or standard input for `-`; undefined when the file doesn't exist. */
export type Read = (path: string) => string | undefined;

/** A command line that can't be run as given (exit 2). */
export class UsageError extends Error {}

const USAGE = `usage: index.ts record <index.json|-> <build.json>...
       index.ts build <index.json|-> <name> <repository> <version> <digest> [--scan <scan.json>] [--commit <sha>]
                      [--reason daily|cve|manual|push] [--signed] [--built-at <ISO 8601>]
       index.ts scan <index.json|-> <name> <digest> <trivy.json> [--scanner "trivy 0.76.1"]
       index.ts needs-rebuild <index.json|->
       index.ts stable <index.json|->
       index.ts summary <index.json|->`;

const REASONS: readonly BuildReason[] = ["daily", "cve", "manual", "push"];

const isObject = (value: unknown): value is { readonly [key: string]: unknown } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** An index from its file's text: none, or an empty file, is an empty index (the first build). */
export function loadIndex(text: string | undefined, at: string): BaseImageIndex {
	return text === undefined || text.trim() === "" ? emptyIndex(at) : parseIndex(JSON.parse(text));
}

/** A version as the index holds it, checked by the index's own parser (the digest's form, the scan's fields). */
export function parseVersion(name: string, raw: unknown): BaseImageVersion {
	const parsed = parseIndex({
		version: BASE_IMAGE_INDEX_VERSION,
		images: [{ name, repository: "-", versions: [raw] }],
	});
	const version = parsed.images[0]?.versions[0];
	if (version === undefined) throw new Error(`${name}: no version`);
	return version;
}

/** A build file (what `build` prints), checked. */
export function parseBuild(raw: unknown): PublishedBuild {
	if (!isObject(raw) || typeof raw.name !== "string" || typeof raw.repository !== "string") {
		throw new Error("A build needs a name and a repository");
	}
	const channels: readonly unknown[] = Array.isArray(raw.channels) ? raw.channels : [];
	if (!channels.every((channel): channel is string => typeof channel === "string")) {
		throw new Error(`${raw.name}: a build's channels are names`);
	}
	return { name: raw.name, repository: raw.repository, version: parseVersion(raw.name, raw.version), channels };
}

/**
 * Whether a new build of `name` may take `stable`: not when its scan has more fixable Critical findings than the scan
 * of what `stable` names now, so the channel never moves to a worse image. Without either scan, it may.
 */
export function takesStable(index: BaseImageIndex, name: string, scan: ImageScan | undefined): boolean {
	const image = index.images.find((entry) => entry.name === name);
	const stable = image?.channels.stable;
	const previous = image?.versions.find((version) => version.digest === stable)?.scan;
	return scan === undefined || previous === undefined || scan.fixable.critical <= previous.fixable.critical;
}

export interface BuildFields {
	readonly name: string;
	readonly repository: string;
	readonly version: string;
	readonly digest: string;
	readonly builtAt: string;
	readonly commit?: string;
	readonly reason?: BuildReason;
	readonly signed: boolean;
	readonly scan?: ImageScan;
}

/** A build to record, with `stable` when `takesStable` allows it. */
export function publishedBuild(index: BaseImageIndex, fields: BuildFields): PublishedBuild {
	const version = parseVersion(fields.name, {
		version: fields.version,
		digest: fields.digest,
		builtAt: fields.builtAt,
		...(fields.commit === undefined ? {} : { commit: fields.commit }),
		...(fields.reason === undefined ? {} : { reason: fields.reason }),
		signed: fields.signed,
		...(fields.scan === undefined ? {} : { scan: fields.scan }),
	});
	return {
		name: fields.name,
		repository: fields.repository,
		version,
		channels: takesStable(index, fields.name, version.scan) ? ["stable"] : [],
	};
}

/**
 * What each image's `stable` channel names, for the images that have one the index still lists (a rescan is recorded
 * on a listed version; one that fell out of the history has nowhere to go).
 */
export function stableImages(
	index: BaseImageIndex,
): readonly { readonly name: string; readonly repository: string; readonly digest: string }[] {
	return index.images.flatMap((image) => {
		const digest = image.channels.stable;
		if (digest === undefined || !image.versions.some((version) => version.digest === digest)) return [];
		return [{ name: image.name, repository: image.repository, digest }];
	});
}

/** The images whose `stable` version's newest scan has a Critical or High finding with a fix out. */
export function rebuildNames(index: BaseImageIndex): readonly string[] {
	return index.images
		.filter((image) => {
			const digest = image.channels.stable;
			return needsRebuild(image.versions.find((version) => version.digest === digest)?.scan);
		})
		.map((image) => image.name);
}

/** The job summary's table of what each image's `stable` names. */
export function indexMarkdown(index: BaseImageIndex): string {
	const lines = [
		`Generated at ${index.generatedAt}.`,
		"",
		"| Image | Stable version | Digest | Built | Fixable critical | Fixable high | Signed |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const image of index.images) {
		const digest = image.channels.stable;
		const version = image.versions.find((entry) => entry.digest === digest);
		if (digest === undefined || version === undefined) {
			lines.push(`| ${image.name} | none | | | | | |`);
			continue;
		}
		const fixable = version.scan?.fixable;
		lines.push(
			`| ${image.name} | ${version.version} | \`${digest}\` | ${version.builtAt} | ` +
				`${fixable?.critical ?? "not scanned"} | ${fixable?.high ?? "not scanned"} | ${version.signed ? "yes" : "no"} |`,
		);
	}
	return `${lines.join("\n")}\n`;
}

/** Splits a command line into its arguments and its options; `flags` take no value. */
export function splitArgs(
	argv: readonly string[],
	options: readonly string[],
	flags: readonly string[] = [],
): { readonly positional: readonly string[]; readonly options: { readonly [name: string]: string | true } } {
	const positional: string[] = [];
	const found: { [name: string]: string | true } = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (flags.includes(arg)) {
			found[arg] = true;
		} else if (options.includes(arg)) {
			const value = argv[i + 1];
			if (value === undefined) throw new UsageError(`${arg} needs a value`);
			found[arg] = value;
			i += 1;
		} else if (arg.startsWith("--")) {
			throw new UsageError(`unknown option ${arg}`);
		} else {
			positional.push(arg);
		}
	}
	return { positional, options: found };
}

const option = (options: { readonly [name: string]: string | true }, name: string): string | undefined => {
	const value = options[name];
	return typeof value === "string" ? value : undefined;
};

const json = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;

function readJson(read: Read, path: string): unknown {
	const text = read(path);
	if (text === undefined) throw new Error(`${path} doesn't exist`);
	return JSON.parse(text);
}

function readIndex(read: Read, path: string | undefined, now: string): BaseImageIndex {
	if (path === undefined) throw new UsageError("which index?");
	return loadIndex(read(path), now);
}

/** What a command printed, and how it ended. */
export interface CommandResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** The command, without its side effects: `read` reads a file, and `now` is the time it records (ISO 8601). */
export function indexCommand(argv: readonly string[], read: Read, now: string): CommandResult {
	try {
		return { code: 0, stdout: run(argv, read, now), stderr: "" };
	} catch (error) {
		const message = (error as Error).message;
		return error instanceof UsageError
			? { code: 2, stdout: "", stderr: `${message}\n${USAGE}\n` }
			: { code: 1, stdout: "", stderr: `${message}\n` };
	}
}

function run(argv: readonly string[], read: Read, now: string): string {
	const [command, ...rest] = argv;
	switch (command) {
		case "record": {
			const { positional } = splitArgs(rest, []);
			const [indexPath, ...builds] = positional;
			if (builds.length === 0) throw new UsageError("record needs at least one build file");
			let index = readIndex(read, indexPath, now);
			for (const path of builds) index = recordBuild(index, parseBuild(readJson(read, path)), now);
			return json(index);
		}
		case "build": {
			const { positional, options } = splitArgs(rest, ["--scan", "--commit", "--reason", "--built-at"], ["--signed"]);
			const [indexPath, name, repository, version, digest, ...extra] = positional;
			if (name === undefined || repository === undefined || version === undefined || digest === undefined) {
				throw new UsageError("build needs an index, a name, a repository, a version and a digest");
			}
			if (extra.length > 0) throw new UsageError(`unexpected ${extra.join(" ")}`);
			const reason = option(options, "--reason");
			if (reason !== undefined && !(REASONS as readonly string[]).includes(reason)) {
				throw new UsageError(`--reason is one of ${REASONS.join(", ")}`);
			}
			const scanPath = option(options, "--scan");
			const commit = option(options, "--commit");
			const index = readIndex(read, indexPath, now);
			const fields: BuildFields = {
				name,
				repository,
				version,
				digest,
				builtAt: option(options, "--built-at") ?? now,
				...(commit === undefined ? {} : { commit }),
				...(reason === undefined ? {} : { reason: reason as BuildReason }),
				signed: options["--signed"] === true,
				...(scanPath === undefined ? {} : { scan: readJson(read, scanPath) as ImageScan }),
			};
			return json(publishedBuild(index, fields));
		}
		case "scan": {
			const { positional, options } = splitArgs(rest, ["--scanner"]);
			const [indexPath, name, digest, report, ...extra] = positional;
			if (name === undefined || digest === undefined || report === undefined) {
				throw new UsageError("scan needs an index, a name, a digest and a Trivy report");
			}
			if (extra.length > 0) throw new UsageError(`unexpected ${extra.join(" ")}`);
			const index = readIndex(read, indexPath, now);
			const image = index.images.find((entry) => entry.name === name);
			if (image?.versions.some((version) => version.digest === digest) !== true) {
				throw new Error(`The index has no ${name} at ${digest}`);
			}
			const trivy = readJson(read, report);
			// Trivy's JSON report carries its schema's version; anything else is the wrong file, not a clean image.
			if (!isObject(trivy) || typeof trivy.SchemaVersion !== "number")
				throw new Error(`${report} isn't a Trivy JSON report`);
			const scan = summariseTrivy(trivy, option(options, "--scanner") ?? "trivy", now);
			return json(recordScan(index, name, digest, scan, now));
		}
		case "needs-rebuild":
		case "stable":
		case "summary": {
			const { positional } = splitArgs(rest, []);
			if (positional.length !== 1) throw new UsageError(`${command} needs just an index`);
			const index = readIndex(read, positional[0], now);
			if (command === "needs-rebuild") return `${rebuildNames(index).join(",")}\n`;
			if (command === "summary") return indexMarkdown(index);
			return stableImages(index)
				.map((image) => `${image.name}\t${image.repository}\t${image.digest}\n`)
				.join("");
		}
		default:
			throw new UsageError(command === undefined ? "which command?" : `unknown command ${command}`);
	}
}

/** Node's reader: standard input for `-`, and undefined for a file that doesn't exist. */
const readFile: Read = (path) => {
	try {
		return readFileSync(path === "-" ? 0 : path, "utf8");
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return undefined;
		throw error;
	}
};

function main(argv: readonly string[]): number {
	const result = indexCommand(argv, readFile, new Date().toISOString());
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	return result.code;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
