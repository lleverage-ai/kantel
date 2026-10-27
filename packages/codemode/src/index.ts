/**
 * Portable capability-registry logic shared by every target: canonical JSON, argument fingerprints, grant pattern
 * coverage and selector matching. No storage and no clock here.
 */
import {
	type AgentId,
	type CapabilityName,
	type CapabilitySelector,
	HarbourError,
	type ProjectId,
	type SessionId,
} from "@harbour/contracts";

/** JSON with object keys sorted recursively and no whitespace. `undefined` object fields are left out, as in JSON. */
export function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "boolean":
			return value ? "true" : "false";
		case "number":
			if (!Number.isFinite(value)) throw new HarbourError("invalid", "Cannot encode a non-finite number as JSON");
			return JSON.stringify(value);
		case "string":
			return JSON.stringify(value);
		case "object": {
			if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
			const record = value as { readonly [key: string]: unknown };
			const fields = Object.keys(record)
				.filter((key) => record[key] !== undefined)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
			return `{${fields.join(",")}}`;
		}
		default:
			throw new HarbourError("invalid", `Cannot encode a ${typeof value} as canonical JSON`);
	}
}

/** Hex SHA-256 of the canonical JSON of `args`: the journal's input fingerprint. */
export async function fingerprint(args: unknown): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(args)));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const CAPABILITY_NAME = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/** Whether `name` is a dotted capability name such as `github.issue.read`. */
export function isCapabilityName(name: string): boolean {
	return CAPABILITY_NAME.test(name);
}

/** Whether `pattern` is a grant pattern: an exact capability name, or a namespace ending in `.*`. */
export function isCapabilityPattern(pattern: string): boolean {
	return isCapabilityName(pattern.endsWith(".*") ? pattern.slice(0, -2) : pattern);
}

/**
 * Whether any pattern covers `name`: an exact match, or `ns.*` for every name under `ns.` (`ns.x`, `ns.x.y`), never
 * `ns` itself nor a sibling sharing its letters (`nsx.y`).
 */
export function capabilityCovered(patterns: readonly string[], name: CapabilityName): boolean {
	return patterns.some((pattern) => {
		if (!pattern.endsWith(".*")) return pattern === name;
		const namespace = pattern.slice(0, -1);
		return name.length > namespace.length && name.startsWith(namespace);
	});
}

/** Whether a grant's selector applies to a caller. Absent selector fields match anything. */
export function selectorMatches(
	selector: CapabilitySelector,
	caller: { readonly projectId?: ProjectId; readonly agentId: AgentId; readonly sessionId: SessionId },
): boolean {
	return (
		(selector.projectId === undefined || selector.projectId === caller.projectId) &&
		(selector.agentId === undefined || selector.agentId === caller.agentId) &&
		(selector.sessionId === undefined || selector.sessionId === caller.sessionId)
	);
}
