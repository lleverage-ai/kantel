/** A base image index for the image patching tests: three host image versions and two container image versions. */
import type { BaseImageIndex, ImageScan } from "../src/base-images.ts";

export const digest = (hex: string): string => `sha256:${hex.repeat(64)}`;

const scan = (critical: number, high: number): ImageScan => ({
	scanner: "trivy 0.68.1",
	scannedAt: "2026-11-04T01:00:00.000Z",
	counts: { critical, high, medium: 3, low: 7, unknown: 0 },
	fixable: { critical, high },
	findings:
		critical === 0
			? []
			: [{ id: "CVE-2026-1234", severity: "critical", package: "openssl", installed: "3.0.13", fixed: "3.0.14" }],
});

export const HOST_LATEST = "host-images-20261104.812";
export const HOST_BEHIND = "host-images-20261102.700";
export const HOST_OLDEST = "host-images-20261101.600";
export const HOST_REPOSITORY = "https://github.com/lleverage-ai/kantel/releases/download/host-images-20261104.812";

export const INDEX: BaseImageIndex = {
	version: 1,
	generatedAt: "2026-11-04T02:00:00.000Z",
	images: [
		{
			name: "host",
			repository: HOST_REPOSITORY,
			channels: { stable: digest("c") },
			versions: [
				{
					version: HOST_LATEST,
					digest: digest("c"),
					builtAt: "2026-11-04T00:00:00.000Z",
					reason: "cve",
					signed: true,
					scan: scan(0, 0),
				},
				{
					version: HOST_BEHIND,
					digest: digest("b"),
					builtAt: "2026-11-02T00:00:00.000Z",
					reason: "daily",
					signed: true,
					scan: scan(1, 0),
				},
				{ version: HOST_OLDEST, digest: digest("a"), builtAt: "2026-11-01T00:00:00.000Z", signed: true },
			],
		},
		{
			name: "sandbox",
			repository: "ghcr.io/lleverage-ai/kantel-sandbox",
			channels: { stable: digest("e") },
			versions: [
				{ version: "2026.11.04.1", digest: digest("e"), builtAt: "2026-11-04T00:00:00.000Z", signed: true },
				{ version: "2026.11.03.1", digest: digest("d"), builtAt: "2026-11-03T00:00:00.000Z", signed: true },
			],
		},
		// Published, but no channel names a version yet.
		{ name: "browser", repository: "ghcr.io/lleverage-ai/kantel-browser", channels: {}, versions: [] },
	],
};

/** The day after the newest build. */
export const NOW = Date.parse("2026-11-05T00:00:00.000Z");
