import { describe, expect, it } from "vitest";
import { baseOutdatedTitle, behindText } from "./base-outdated.tsx";
import type { ImageScan, SandboxBase } from "./compute-model.ts";
import { findingHref, findingsInOrder, scanStatus, shortDigest, templateStatus } from "./images-page.tsx";
import { canRestartOnLatest } from "./sandbox-actions.tsx";

const scan = (fields: Partial<Pick<ImageScan, "counts" | "fixable">>): ImageScan => ({
	scanner: "trivy",
	scannedAt: 0,
	counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, ...fields.counts },
	fixable: { critical: 0, high: 0, ...fields.fixable },
	findings: [],
});

const outdated: SandboxBase = {
	image: "sandbox",
	version: "2026.10.29.809",
	outdated: true,
	latest: { version: "2026.11.04.812", builtAt: 0 },
	behind: { days: 6, versions: 3 },
};

describe("a base image's scan", () => {
	it("says the worst it found first, a fixable one before one with no fix", () => {
		const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
		expect(
			scanStatus(scan({ counts: { ...counts, critical: 1, high: 2 }, fixable: { critical: 1, high: 0 } })),
		).toEqual({
			tone: "error",
			text: "1 critical fixable",
		});
		expect(scanStatus(scan({ counts: { ...counts, critical: 1 } }))).toEqual({
			tone: "error",
			text: "1 critical",
		});
		expect(scanStatus(scan({ counts: { ...counts, high: 2 }, fixable: { critical: 0, high: 1 } }))).toEqual({
			tone: "approval",
			text: "2 high",
		});
	});

	it("is clean with no High or Critical, and says when there's no scan yet", () => {
		expect(scanStatus(scan({ counts: { critical: 0, high: 0, medium: 4, low: 9, unknown: 1 } }))).toEqual({
			tone: "done",
			text: "No high or critical",
		});
		expect(scanStatus(undefined)).toEqual({ tone: "neutral", text: "Not scanned" });
	});

	it("lists findings the worst first, then by package", () => {
		const finding = (id: string, severity: "critical" | "high" | "low", pkg: string) => ({
			id,
			severity,
			package: pkg,
			installed: "1",
		});
		const ordered = findingsInOrder([
			finding("a", "low", "zlib"),
			finding("b", "high", "openssl"),
			finding("c", "critical", "curl"),
			finding("d", "high", "curl"),
		]);
		expect(ordered.map((each) => each.id)).toEqual(["c", "d", "b", "a"]);
	});

	it("links a CVE to the NVD, and nothing else", () => {
		expect(findingHref("CVE-2026-31789")).toBe("https://nvd.nist.gov/vuln/detail/CVE-2026-31789");
		expect(findingHref("GHSA-7q4v-9hx2-mq3c")).toBeUndefined();
	});

	it("shortens a digest, with or without its algorithm", () => {
		expect(shortDigest(`sha256:${"ab12cd34".repeat(8)}`)).toBe("sha256:ab12cd34");
		expect(shortDigest("ab12cd34".repeat(8))).toBe("sha256:ab12cd34");
	});
});

describe("a template's base", () => {
	it("is rebuilding, up to date, or behind by days and versions", () => {
		expect(templateStatus({ base: outdated, rebuilding: true })).toEqual({ tone: "accent", text: "Rebuilding" });
		expect(templateStatus({ base: { ...outdated, outdated: false }, rebuilding: false })).toEqual({
			tone: "done",
			text: "Up to date",
		});
		expect(templateStatus({ base: { ...outdated, behind: { days: 4, versions: 2 } }, rebuilding: false })).toEqual({
			tone: "approval",
			text: "4 days, 2 versions behind",
		});
	});
});

describe("an outdated base", () => {
	it("says how far behind, in days and versions", () => {
		expect(behindText({ days: 6, versions: 3 })).toBe("6 days, 3 versions behind");
		expect(behindText({ days: 1, versions: 1 })).toBe("1 day, 1 version behind");
		expect(behindText({ days: 0, versions: 2 })).toBe("2 versions behind");
		expect(behindText({ days: 0, versions: 0 })).toBe("under a day behind");
	});

	it("can be restarted on the latest from running, stopped or failed", () => {
		expect(canRestartOnLatest({ state: "running", base: outdated })).toBe(true);
		expect(canRestartOnLatest({ state: "stopped", base: outdated })).toBe(true);
		expect(canRestartOnLatest({ state: "error", base: outdated })).toBe(true);
		expect(canRestartOnLatest({ state: "starting", base: outdated })).toBe(false);
		expect(canRestartOnLatest({ state: "running", base: { ...outdated, outdated: false } })).toBe(false);
	});

	it("names both versions in its tooltip, and what to do", () => {
		expect(baseOutdatedTitle(outdated)).toBe(
			"On 2026.10.29.809; the latest is 2026.11.04.812 (6 days, 3 versions behind). Restart on latest to move it.",
		);
		expect(baseOutdatedTitle({ ...outdated, security: true }, "snapshot")).toBe(
			"On 2026.10.29.809; the latest is 2026.11.04.812 (6 days, 3 versions behind). It has security fixes. Sandboxes started from it start on the old base. Save a new snapshot from a sandbox restarted on latest to refresh it.",
		);
	});
});
