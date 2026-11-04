import { describe, expect, it } from "vitest";
import {
	BASE_IMAGE_FINDINGS,
	BASE_IMAGE_HISTORY,
	type BaseImageIndex,
	type BaseImageVersion,
	emptyIndex,
	type ImageScan,
	needsRebuild,
	type PublishedBuild,
	recordBuild,
	recordScan,
	summariseTrivy,
} from "../../../packages/compute/src/base-images.ts";
import {
	indexCommand,
	indexMarkdown,
	loadIndex,
	parseBuild,
	publishedBuild,
	type Read,
	rebuildNames,
	splitArgs,
	stableImages,
	takesStable,
} from "../index.ts";
import { NEEDS_REBUILD_EXIT, parseScanArgs, SUMMARY_FINDINGS, scanCommand, scanMarkdown } from "../scan.ts";

const NOW = "2026-11-04T04:30:00.000Z";
const LATER = "2026-11-05T04:30:00.000Z";
const SCANNER = "trivy 0.76.1";

const digest = (char: string) => `sha256:${char.repeat(64)}`;

interface Vuln {
	readonly VulnerabilityID: string;
	readonly PkgName: string;
	readonly InstalledVersion: string;
	readonly Severity: string;
	readonly FixedVersion?: string;
	readonly Title?: string;
}

const vuln = (id: string, pkg: string, severity: string, fixed?: string): Vuln => ({
	VulnerabilityID: id,
	PkgName: pkg,
	InstalledVersion: "1.0-1",
	Severity: severity,
	...(fixed === undefined ? {} : { FixedVersion: fixed }),
	Title: `${id} in ${pkg}`,
});

const cve = (i: number) => `CVE-2026-${String(i).padStart(4, "0")}`;

/** A Trivy JSON report (`trivy image --format json`), cut down to what the summary reads: one result per target. */
const report = (...targets: readonly (readonly Vuln[])[]) => ({
	SchemaVersion: 2,
	ArtifactName: "kantel-sandbox:ci",
	Results: targets.map((vulnerabilities, i) => ({
		Target: `target ${i}`,
		Class: "os-pkgs",
		Vulnerabilities: vulnerabilities,
	})),
});

const scanOf = (critical: number, high: number): ImageScan => ({
	scanner: SCANNER,
	scannedAt: NOW,
	counts: { critical, high, medium: 0, low: 0, unknown: 0 },
	fixable: { critical, high },
	findings: [],
});

const version = (name: string, char: string, scan?: ImageScan): BaseImageVersion => ({
	version: name,
	digest: digest(char),
	builtAt: NOW,
	signed: true,
	...(scan === undefined ? {} : { scan }),
});

const build = (name: string, v: BaseImageVersion, channels: readonly string[] = ["stable"]): PublishedBuild => ({
	name,
	repository: `ghcr.io/lleverage-ai/kantel-${name}`,
	version: v,
	channels,
});

/** An in-memory file system for the commands; a missing path reads as undefined, as a missing file does. */
const files =
	(map: { readonly [path: string]: string }): Read =>
	(path) =>
		map[path];

describe("summariseTrivy", () => {
	it("counts each vulnerability once per package and version, however many targets list it", () => {
		const twice = vuln("CVE-2026-0001", "openssl", "HIGH", "3.5.4-1");
		const scan = summariseTrivy(report([twice], [twice, vuln("CVE-2026-0001", "libssl3t64", "HIGH")]), SCANNER, NOW);
		expect(scan.counts.high).toBe(2);
		expect(scan.fixable.high).toBe(1);
		expect(scan.findings.map((finding) => finding.package)).toEqual(["openssl", "libssl3t64"]);
		expect(scan.scanner).toBe(SCANNER);
		expect(scan.scannedAt).toBe(NOW);
	});

	it("counts fixable Critical and High only where a fix is out", () => {
		const scan = summariseTrivy(
			report([
				vuln(cve(1), "a", "CRITICAL", "2"),
				vuln(cve(2), "b", "CRITICAL"),
				vuln(cve(3), "c", "HIGH", "2"),
				vuln(cve(4), "d", "HIGH", ""),
				vuln(cve(5), "e", "MEDIUM", "2"),
				vuln(cve(6), "f", "LOW"),
				vuln(cve(7), "g", "NEGLIGIBLE"),
			]),
			SCANNER,
			NOW,
		);
		expect(scan.counts).toEqual({ critical: 2, high: 2, medium: 1, low: 1, unknown: 1 });
		expect(scan.fixable).toEqual({ critical: 1, high: 1 });
		// Only Critical and High are listed, and an empty FixedVersion is no fix.
		expect(scan.findings.map((finding) => finding.id)).toEqual([cve(1), cve(2), cve(3), cve(4)]);
		expect(scan.findings[3]?.fixed).toBeUndefined();
	});

	it("lists fixable Critical first, then Critical, fixable High and High, each by ID", () => {
		const scan = summariseTrivy(
			report([
				vuln(cve(9), "h1", "HIGH"),
				vuln(cve(8), "h2", "HIGH", "2"),
				vuln(cve(7), "c1", "CRITICAL"),
				vuln(cve(6), "c2", "CRITICAL", "2"),
				vuln(cve(5), "c3", "CRITICAL", "2"),
			]),
			SCANNER,
			NOW,
		);
		expect(scan.findings.map((finding) => finding.id)).toEqual([cve(5), cve(6), cve(7), cve(8), cve(9)]);
	});

	it(`keeps at most ${BASE_IMAGE_FINDINGS} findings but counts them all`, () => {
		const many = Array.from({ length: 60 }, (_, i) => vuln(cve(i), "p", "HIGH", "2"));
		const scan = summariseTrivy(report(many), SCANNER, NOW);
		expect(scan.findings).toHaveLength(BASE_IMAGE_FINDINGS);
		expect(scan.counts.high).toBe(60);
		expect(scan.fixable.high).toBe(60);
	});

	it("reads a report with no vulnerabilities as clean", () => {
		const scan = summariseTrivy({ SchemaVersion: 2, Results: [{ Target: "debian 13" }] }, SCANNER, NOW);
		expect(scan.counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });
		expect(scan.findings).toEqual([]);
	});
});

describe("needsRebuild", () => {
	it("is true only for a fixable Critical or High finding", () => {
		const unfixable: ImageScan = { ...scanOf(0, 0), counts: { critical: 3, high: 2, medium: 0, low: 0, unknown: 0 } };
		expect(needsRebuild(undefined)).toBe(false);
		expect(needsRebuild(scanOf(0, 0))).toBe(false);
		expect(needsRebuild(unfixable)).toBe(false);
		expect(needsRebuild(scanOf(0, 1))).toBe(true);
		expect(needsRebuild(scanOf(1, 0))).toBe(true);
	});
});

describe("recordBuild", () => {
	it("adds a new image, sorted by name, and moves its channels", () => {
		let index = recordBuild(emptyIndex(NOW), build("sandbox", version("2026.11.04.1", "a")), LATER);
		index = recordBuild(index, build("browser", version("2026.11.04.1", "b")), LATER);
		expect(index.generatedAt).toBe(LATER);
		expect(index.images.map((image) => image.name)).toEqual(["browser", "sandbox"]);
		expect(index.images[1]?.channels).toEqual({ stable: digest("a") });
		expect(index.images[1]?.repository).toBe("ghcr.io/lleverage-ai/kantel-sandbox");
	});

	it("puts the newest version first", () => {
		let index = recordBuild(emptyIndex(NOW), build("sandbox", version("1", "a")), NOW);
		index = recordBuild(index, build("sandbox", version("2", "b")), NOW);
		expect(index.images[0]?.versions.map((v) => v.version)).toEqual(["2", "1"]);
		expect(index.images[0]?.channels.stable).toBe(digest("b"));
	});

	it("replaces a version of the same digest, so a re-run keeps one entry", () => {
		let index = recordBuild(emptyIndex(NOW), build("sandbox", version("1", "a")), NOW);
		index = recordBuild(index, build("sandbox", version("2", "b")), NOW);
		index = recordBuild(index, build("sandbox", version("1-again", "a")), NOW);
		expect(index.images[0]?.versions.map((v) => v.version)).toEqual(["1-again", "2"]);
		expect(index.images[0]?.channels.stable).toBe(digest("a"));
	});

	it("leaves a channel where it was when the build doesn't take it", () => {
		let index = recordBuild(emptyIndex(NOW), build("sandbox", version("1", "a")), NOW);
		index = recordBuild(index, build("sandbox", version("2", "b"), []), NOW);
		expect(index.images[0]?.channels.stable).toBe(digest("a"));
		expect(index.images[0]?.versions[0]?.version).toBe("2");
	});

	it(`keeps the newest ${BASE_IMAGE_HISTORY} versions`, () => {
		let index = emptyIndex(NOW);
		for (let i = 0; i < BASE_IMAGE_HISTORY + 5; i++) {
			const v = { ...version(String(i), "a"), digest: `sha256:${i.toString(16).padStart(64, "0")}` };
			index = recordBuild(index, build("sandbox", v), NOW);
		}
		const versions = index.images[0]?.versions ?? [];
		expect(versions).toHaveLength(BASE_IMAGE_HISTORY);
		expect(versions[0]?.version).toBe(String(BASE_IMAGE_HISTORY + 4));
		expect(versions.at(-1)?.version).toBe("5");
	});
});

describe("recordScan", () => {
	it("records a fresh scan on the one version it is of", () => {
		let index = recordBuild(emptyIndex(NOW), build("sandbox", version("1", "a", scanOf(0, 0))), NOW);
		index = recordBuild(index, build("sandbox", version("2", "b", scanOf(0, 0))), NOW);
		index = recordBuild(index, build("browser", version("1", "a", scanOf(0, 0))), NOW);
		const rescanned = recordScan(index, "sandbox", digest("a"), scanOf(1, 0), LATER);
		expect(rescanned.generatedAt).toBe(LATER);
		const sandbox = rescanned.images.find((image) => image.name === "sandbox");
		expect(sandbox?.versions.map((v) => v.scan?.fixable.critical)).toEqual([0, 1]);
		// Another image with the same digest is another image.
		const browser = rescanned.images.find((image) => image.name === "browser");
		expect(browser?.versions[0]?.scan?.fixable.critical).toBe(0);
	});
});

describe("scan.ts", () => {
	const trivy = JSON.stringify(report([vuln(cve(1), "openssl", "CRITICAL", "3.5.4-1"), vuln(cve(2), "zlib", "HIGH")]));
	const clean = JSON.stringify(report([]));

	it("parses its command line", () => {
		expect(parseScanArgs(["trivy.json"])).toEqual({ report: "trivy.json", scanner: "trivy", needsRebuild: false });
		expect(parseScanArgs(["--scanner", SCANNER, "trivy.json", "--title", "Sandbox", "--needs-rebuild"])).toEqual({
			report: "trivy.json",
			scanner: SCANNER,
			title: "Sandbox",
			needsRebuild: true,
		});
		expect(() => parseScanArgs([])).toThrow("which report?");
		expect(() => parseScanArgs(["a.json", "b.json"])).toThrow("one report at a time");
		expect(() => parseScanArgs(["a.json", "--scanner"])).toThrow("needs a value");
		expect(() => parseScanArgs(["a.json", "--frobnicate"])).toThrow("unknown option");
	});

	it("prints the summary and the job summary's section", () => {
		const argv = ["trivy.json", "--scanner", SCANNER, "--title", "Sandbox"];
		const result = scanCommand(argv, files({ "trivy.json": trivy }), NOW);
		expect(result.code).toBe(0);
		const scan = JSON.parse(result.stdout) as ImageScan;
		expect(scan.fixable).toEqual({ critical: 1, high: 0 });
		expect(scan.scanner).toBe(SCANNER);
		expect(result.summary).toContain("### Sandbox");
		expect(result.summary).toContain(`| critical | ${cve(1)} | openssl | 1.0-1 | 3.5.4-1 |`);
		expect(result.summary).toContain(`| high | ${cve(2)} | zlib | 1.0-1 | no fix yet |`);
	});

	it("answers --needs-rebuild by exit code", () => {
		const read = files({ "trivy.json": trivy, "clean.json": clean });
		const rebuild = scanCommand(["trivy.json", "--needs-rebuild"], read, NOW);
		expect(rebuild.code).toBe(NEEDS_REBUILD_EXIT);
		expect(rebuild.stdout).toBe("");
		expect(rebuild.summary).toBe("");
		expect(scanCommand(["clean.json", "--needs-rebuild"], read, NOW).code).toBe(0);
	});

	it("fails on a report it can't read, and on a wrong command line", () => {
		const read = (path: string): string => {
			if (path === "broken.json") return "{";
			if (path === "other.json") return "{}";
			throw new Error(`ENOENT: ${path}`);
		};
		expect(scanCommand(["broken.json"], read, NOW).code).toBe(1);
		expect(scanCommand(["other.json"], read, NOW).stderr).toContain("isn't a Trivy JSON report");
		expect(scanCommand(["missing.json"], read, NOW).code).toBe(1);
		expect(scanCommand([], read, NOW).code).toBe(2);
	});

	it(`lists at most ${SUMMARY_FINDINGS} findings, and escapes the table's pipes`, () => {
		const many = Array.from({ length: 25 }, (_, i) => vuln(cve(i), "p", "HIGH"));
		const odd = { ...vuln(cve(9999), "q", "CRITICAL"), Title: "a | b\nc" };
		const markdown = scanMarkdown(summariseTrivy(report([odd, ...many]), SCANNER, NOW), "Sandbox");
		const rows = markdown.split("\n").filter((line) => line.startsWith("| critical") || line.startsWith("| high"));
		expect(rows).toHaveLength(SUMMARY_FINDINGS);
		expect(markdown).toContain("a \\| b c");
		expect(markdown).toContain("6 more critical or high findings are not listed here.");
		const empty = scanMarkdown(summariseTrivy(report([]), SCANNER, NOW), "Clean");
		expect(empty).toContain("No critical or high findings.");
	});
});

describe("index.ts", () => {
	const threeImages = (): BaseImageIndex => {
		let index = recordBuild(emptyIndex(NOW), build("sandbox", version("1", "a", scanOf(0, 0))), NOW);
		index = recordBuild(index, build("browser", version("1", "b", scanOf(0, 2))), NOW);
		return recordBuild(index, build("host", version("host-images-20261104.1", "c")), NOW);
	};

	it("reads no index, or an empty file, as an empty index", () => {
		expect(loadIndex(undefined, NOW)).toEqual(emptyIndex(NOW));
		expect(loadIndex(" \n", NOW)).toEqual(emptyIndex(NOW));
		expect(() => loadIndex(JSON.stringify({ version: 99, images: [] }), NOW)).toThrow();
	});

	it("splits arguments from options", () => {
		expect(splitArgs(["a", "--scan", "s.json", "--signed", "b"], ["--scan"], ["--signed"])).toEqual({
			positional: ["a", "b"],
			options: { "--scan": "s.json", "--signed": true },
		});
		expect(() => splitArgs(["--scan"], ["--scan"])).toThrow("needs a value");
		expect(() => splitArgs(["--other"], ["--scan"])).toThrow("unknown option");
	});

	it("checks a build file", () => {
		const good = build("sandbox", version("1", "a"));
		expect(parseBuild(JSON.parse(JSON.stringify(good)))).toEqual(good);
		expect(() => parseBuild({ name: "sandbox" })).toThrow("a name and a repository");
		expect(() => parseBuild({ ...good, version: { ...good.version, digest: "sha256:nope" } })).toThrow("bad digest");
		expect(() => parseBuild({ ...good, channels: [1] })).toThrow("channels are names");
	});

	it("never moves stable to a build with more fixable Critical findings", () => {
		const index = recordBuild(emptyIndex(NOW), build("sandbox", version("1", "a", scanOf(1, 0))), NOW);
		expect(takesStable(index, "sandbox", scanOf(2, 0))).toBe(false);
		expect(takesStable(index, "sandbox", scanOf(1, 5))).toBe(true);
		expect(takesStable(index, "sandbox", scanOf(0, 0))).toBe(true);
		expect(takesStable(index, "sandbox", undefined)).toBe(true);
		expect(takesStable(index, "browser", scanOf(3, 0))).toBe(true);
		const fields = {
			name: "sandbox",
			repository: "ghcr.io/lleverage-ai/kantel-sandbox",
			version: "2",
			digest: digest("b"),
			builtAt: NOW,
			signed: true,
		};
		expect(publishedBuild(index, { ...fields, scan: scanOf(2, 0) }).channels).toEqual([]);
		expect(publishedBuild(index, { ...fields, scan: scanOf(0, 0) }).channels).toEqual(["stable"]);
	});

	it("builds, then records, a build", () => {
		const built = indexCommand(
			[
				"build",
				"index.json",
				"sandbox",
				"ghcr.io/lleverage-ai/kantel-sandbox",
				"2026.11.04.812",
				digest("a"),
				"--scan",
				"scan.json",
				"--commit",
				"abc123",
				"--reason",
				"daily",
				"--signed",
			],
			files({ "scan.json": JSON.stringify(scanOf(0, 1)) }),
			NOW,
		);
		expect(built.stderr).toBe("");
		expect(built.code).toBe(0);
		const entry = JSON.parse(built.stdout) as PublishedBuild;
		expect(entry).toMatchObject({
			name: "sandbox",
			channels: ["stable"],
			version: { version: "2026.11.04.812", digest: digest("a"), commit: "abc123", reason: "daily", signed: true },
		});
		expect(entry.version.scan?.fixable.high).toBe(1);

		// No index yet: the first build starts an empty one.
		const recorded = indexCommand(["record", "index.json", "build.json"], files({ "build.json": built.stdout }), LATER);
		expect(recorded.code).toBe(0);
		const index = JSON.parse(recorded.stdout) as BaseImageIndex;
		expect(index.generatedAt).toBe(LATER);
		expect(index.images[0]?.channels.stable).toBe(digest("a"));
	});

	it("refuses a bad build", () => {
		const args = ["build", "-", "sandbox", "ghcr.io/x", "1"];
		expect(indexCommand([...args, "sha256:short"], files({}), NOW).code).toBe(1);
		expect(indexCommand([...args, digest("a"), "--reason", "whim"], files({}), NOW).code).toBe(2);
		expect(indexCommand(args, files({}), NOW).code).toBe(2);
		expect(indexCommand(["record", "index.json"], files({}), NOW).code).toBe(2);
		expect(indexCommand(["record", "index.json", "missing.json"], files({}), NOW).stderr).toContain("doesn't exist");
	});

	it("records a rescan of what the index names", () => {
		const read = files({
			"index.json": JSON.stringify(threeImages()),
			"trivy.json": JSON.stringify(report([vuln(cve(1), "openssl", "CRITICAL", "2")])),
		});
		const argv = ["scan", "index.json", "sandbox", digest("a"), "trivy.json", "--scanner", SCANNER];
		const result = indexCommand(argv, read, LATER);
		expect(result.code).toBe(0);
		const index = JSON.parse(result.stdout) as BaseImageIndex;
		const scan = index.images.find((image) => image.name === "sandbox")?.versions[0]?.scan;
		expect(scan).toMatchObject({ scanner: SCANNER, scannedAt: LATER, fixable: { critical: 1, high: 0 } });
		expect(indexCommand(["scan", "index.json", "sandbox", digest("f"), "trivy.json"], read, LATER).code).toBe(1);
	});

	it("names the images whose stable version needs a rebuild", () => {
		expect(rebuildNames(threeImages())).toEqual(["browser"]);
		const read = files({ "index.json": JSON.stringify(threeImages()) });
		expect(indexCommand(["needs-rebuild", "index.json"], read, NOW).stdout).toBe("browser\n");
		expect(indexCommand(["needs-rebuild", "none.json"], read, NOW).stdout).toBe("\n");
	});

	it("lists what stable names, and sums it up", () => {
		const index = threeImages();
		expect(stableImages(index).map((image) => image.name)).toEqual(["browser", "host", "sandbox"]);
		// A digest that fell out of the history has no version to record a rescan on.
		const gone: BaseImageIndex = {
			...index,
			images: index.images.map((image) => ({ ...image, channels: { stable: digest("e") } })),
		};
		expect(stableImages(gone)).toEqual([]);
		const read = files({ "index.json": JSON.stringify(index) });
		expect(indexCommand(["stable", "index.json"], read, NOW).stdout.split("\n")[2]).toBe(
			`sandbox\tghcr.io/lleverage-ai/kantel-sandbox\t${digest("a")}`,
		);
		const markdown = indexMarkdown(index);
		expect(markdown).toContain(`| sandbox | 1 | \`${digest("a")}\` | ${NOW} | 0 | 0 | yes |`);
		expect(markdown).toContain("| host | host-images-20261104.1 |");
		expect(markdown).toContain("not scanned");
	});

	it("rejects an unknown command", () => {
		expect(indexCommand(["frobnicate"], files({}), NOW).code).toBe(2);
		expect(indexCommand([], files({}), NOW).code).toBe(2);
	});
});
