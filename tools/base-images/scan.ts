#!/usr/bin/env node
/**
 * Sums up a Trivy report for the base image pipeline (.github/workflows/sandbox-image.yml), with the index's own
 * functions (packages/compute/src/base-images.ts), so the workflow and the gateway read a scan the same way.
 *
 *   node tools/base-images/scan.ts <trivy.json> [--scanner "trivy 0.76.1"] [--title <heading>]
 *       prints the summary (an `ImageScan`) as JSON; with GITHUB_STEP_SUMMARY set, it also appends a Markdown section
 *       to the job's summary: the counts, what is fixable, and a table of the first findings
 *   node tools/base-images/scan.ts <trivy.json> --needs-rebuild
 *       exits 3 when the image has a Critical or High finding with a fix out (a rebuild now may pick the fix up), else 0
 *
 * Findings never fail it: a fix may not be in Debian yet, and the index reports them either way. Only a report it
 * can't read does (exit 1), or a wrong command line (exit 2).
 *
 * Runs with Node's type stripping, so it imports nothing beyond Node's own modules and the shared module.
 */
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { type ImageScan, needsRebuild, summariseTrivy } from "../../packages/compute/src/base-images.ts";

/** The exit code of `--needs-rebuild` when a rebuild is called for; the workflow branches on it. */
export const NEEDS_REBUILD_EXIT = 3;

/** How many findings the job summary's table lists; the index keeps more. */
export const SUMMARY_FINDINGS = 20;

const USAGE =
	'usage: scan.ts <trivy.json> [--scanner "trivy 0.76.1"] [--title <heading>]\n       scan.ts <trivy.json> --needs-rebuild';

/** A command line that can't be run as given (exit 2). */
export class UsageError extends Error {}

export interface ScanArgs {
	/** The Trivy JSON report (`trivy image --format json`). */
	readonly report: string;
	/** What the index records as the scanner, such as `trivy 0.76.1`. */
	readonly scanner: string;
	/** The job summary section's heading. */
	readonly title?: string;
	/** Only answer whether the image needs a rebuild, by exit code. */
	readonly needsRebuild: boolean;
}

export function parseScanArgs(argv: readonly string[]): ScanArgs {
	let report: string | undefined;
	let scanner = "trivy";
	let title: string | undefined;
	let rebuild = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--needs-rebuild") {
			rebuild = true;
		} else if (arg === "--scanner" || arg === "--title") {
			const value = argv[i + 1];
			if (value === undefined) throw new UsageError(`${arg} needs a value`);
			i += 1;
			if (arg === "--scanner") scanner = value;
			else title = value;
		} else if (arg.startsWith("--")) {
			throw new UsageError(`unknown option ${arg}`);
		} else if (report === undefined) {
			report = arg;
		} else {
			throw new UsageError(`one report at a time, not ${arg} as well`);
		}
	}
	if (report === undefined) throw new UsageError("which report?");
	return { report, scanner, ...(title === undefined ? {} : { title }), needsRebuild: rebuild };
}

/** A table cell: Trivy's titles can hold pipes and line breaks, which would break the table. */
const cell = (text: string) => text.replace(/\s*\r?\n\s*/g, " ").replaceAll("|", "\\|");

/** The job summary's section for one scan: the counts, what is fixable, and up to `SUMMARY_FINDINGS` findings. */
export function scanMarkdown(scan: ImageScan, title: string): string {
	const { counts, fixable } = scan;
	const verdict = needsRebuild(scan) ? ": a rebuild now may pick the fixes up." : ".";
	const lines = [
		`### ${title}`,
		"",
		`${scan.scanner} at ${scan.scannedAt}: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ` +
			`${counts.low} low and ${counts.unknown} unknown findings.`,
		`Fixable now: ${fixable.critical} critical and ${fixable.high} high${verdict}`,
		"",
	];
	const shown = scan.findings.slice(0, SUMMARY_FINDINGS);
	if (shown.length === 0) {
		lines.push("No critical or high findings.");
	} else {
		lines.push("| Severity | ID | Package | Installed | Fixed in | Title |", "| --- | --- | --- | --- | --- | --- |");
		for (const finding of shown) {
			lines.push(
				`| ${finding.severity} | ${cell(finding.id)} | ${cell(finding.package)} | ${cell(finding.installed)} | ` +
					`${cell(finding.fixed ?? "no fix yet")} | ${cell(finding.title ?? "")} |`,
			);
		}
		const more = counts.critical + counts.high - shown.length;
		if (more > 0) lines.push("", `${more} more critical or high findings are not listed here.`);
	}
	return `${lines.join("\n")}\n\n`;
}

/** Trivy's JSON report carries its schema's version; anything else is the wrong file, not a clean image. */
const isTrivyReport = (value: unknown) =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { SchemaVersion?: unknown }).SchemaVersion === "number";

export interface CommandResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	/** Markdown for the job summary; empty for none. */
	readonly summary: string;
}

/** The command, without its side effects: `read` reads a file, and `now` is the scan's time (ISO 8601). */
export function scanCommand(argv: readonly string[], read: (path: string) => string, now: string): CommandResult {
	let args: ScanArgs;
	try {
		args = parseScanArgs(argv);
	} catch (error) {
		return { code: 2, stdout: "", stderr: `${(error as Error).message}\n${USAGE}\n`, summary: "" };
	}
	let report: unknown;
	try {
		report = JSON.parse(read(args.report));
	} catch (error) {
		return { code: 1, stdout: "", stderr: `can't read ${args.report}: ${(error as Error).message}\n`, summary: "" };
	}
	if (!isTrivyReport(report)) {
		return { code: 1, stdout: "", stderr: `${args.report} isn't a Trivy JSON report\n`, summary: "" };
	}
	const scan = summariseTrivy(report, args.scanner, now);
	if (args.needsRebuild) {
		const rebuild = needsRebuild(scan);
		const stderr = rebuild
			? `${scan.fixable.critical} critical and ${scan.fixable.high} high findings have a fix out: rebuild\n`
			: "";
		return { code: rebuild ? NEEDS_REBUILD_EXIT : 0, stdout: "", stderr, summary: "" };
	}
	return {
		code: 0,
		stdout: `${JSON.stringify(scan, null, "\t")}\n`,
		stderr: "",
		summary: scanMarkdown(scan, args.title ?? `Scan of ${args.report}`),
	};
}

function main(argv: readonly string[]): number {
	const result = scanCommand(argv, (path) => readFileSync(path, "utf8"), new Date().toISOString());
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (result.summary !== "" && summary !== undefined && summary !== "") appendFileSync(summary, result.summary);
	return result.code;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
