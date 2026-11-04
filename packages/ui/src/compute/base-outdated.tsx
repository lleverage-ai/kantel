// A sandbox's or a saved snapshot's base image when a newer one is out: a small badge, amber, or red when the newer
// one has security fixes, with the versions and how far behind it is in its tooltip. The Sandboxes list, a sandbox's
// page and the Snapshots page show the same one. Kantel never patches a running sandbox; it moves to the latest base
// when it restarts on it, and a snapshot only by saving a new one.

import { compactAge } from "../primitives/format.ts";
import { Badge } from "../primitives/status.tsx";
import type { SandboxBase } from "./compute-model.ts";

const count = (value: number, one: string, many: string): string => `${value} ${value === 1 ? one : many}`;

/** "6 days, 3 versions behind", "1 version behind", "under a day behind". */
export function behindText(behind: { readonly days: number; readonly versions: number }): string {
	const parts = [
		...(behind.days > 0 ? [count(behind.days, "day", "days")] : []),
		...(behind.versions > 0 ? [count(behind.versions, "version", "versions")] : []),
	];
	return parts.length === 0 ? "under a day behind" : `${parts.join(", ")} behind`;
}

/**
 * The badge's tooltip: "On 2026.10.29.809; the latest is 2026.11.04.812, built 3h ago (6 days, 3 versions behind).
 * Restart on latest to move it." For a snapshot, what that means for sandboxes started from it.
 */
export function baseOutdatedTitle(
	base: SandboxBase,
	subject: "sandbox" | "snapshot" = "sandbox",
	now?: number,
): string {
	const on = `On ${base.version ?? `an older ${base.image}`}`;
	const latest =
		base.latest === undefined
			? "a newer version is out"
			: `the latest is ${base.latest.version}${now === undefined ? "" : `, built ${builtText(base.latest.builtAt, now)}`}`;
	const behind = base.behind === undefined ? "" : ` (${behindText(base.behind)})`;
	const security = base.security === true ? " It has security fixes." : "";
	const next =
		subject === "sandbox"
			? "Restart on latest to move it."
			: "Sandboxes started from it start on the old base. Save a new snapshot from a sandbox restarted on latest to refresh it.";
	return `${on}; ${latest}${behind}.${security} ${next}`;
}

/** "3h ago", "just now". */
const builtText = (at: number, now: number): string => {
	const age = compactAge(at, now);
	return age === "now" ? "just now" : `${age} ago`;
};

/**
 * "Base outdated", amber, or red when the newer base has security fixes, with the versions in its tooltip. Nothing
 * for a base that's current, or none. It sits above a row's covering link, so its tooltip shows under the pointer.
 */
export function BaseOutdatedBadge({
	base,
	now,
	subject = "sandbox",
}: {
	base: SandboxBase | undefined;
	/** The time, for how long ago the latest was built. */
	now?: number;
	/** What is on the base: a snapshot's tooltip says what happens to sandboxes started from it. */
	subject?: "sandbox" | "snapshot";
}) {
	if (base?.outdated !== true) return null;
	return (
		<span className="kt-base-outdated relative z-1 inline-flex flex-none" title={baseOutdatedTitle(base, subject, now)}>
			<Badge tone={base.security === true ? "error" : "approval"}>Base outdated</Badge>
		</span>
	);
}
