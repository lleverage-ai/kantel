import { createFakeBrowserProvider, createMemoryBrowser } from "@harbour/browser/memory";
import type { SessionId } from "@harbour/contracts";
import { registerBrowserConformance } from "@harbour/testing/browser";
import { describe, expect, it } from "vitest";

registerBrowserConformance(
	{ describe, expect, it },
	"in-memory browser broker",
	async (deps, use) => {
		const fake = createFakeBrowserProvider();
		const parents = new Map<SessionId, SessionId>();
		await use({
			browser: createMemoryBrowser({
				clock: deps.clock,
				audit: deps.audit,
				access: deps.access,
				provider: fake.provider,
				parentOf: (sessionId) => parents.get(sessionId),
			}),
			providerLive: () => fake.live(),
			setParent: (child, parent) => {
				parents.set(child, parent);
			},
			failReleases: (times) => fake.failReleases(times),
			holdNextOpen: () => fake.holdNextOpen(),
			nextClickLandsOn: (url) => fake.nextClickLandsOn(url),
			providerUrls: () => Object.values(fake.urls()),
		});
	},
	{ projectAccess: true },
);
