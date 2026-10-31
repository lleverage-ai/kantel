/**
 * Prompt rules (docs/design/org-scope.md, decision 5): named pieces of system prompt owned by the platform, an
 * organisation, a project or a user, layered into every session's prompt around its profile's own layers:
 *
 *   platform → organisation → project → profile → user
 *
 * Each owner's rules are ordered by `order`, then by name. An organisation session has no project layer. The runtime
 * resolves a session's rules once, when it is created, and keeps the joined layers with its copy of the profile, so a
 * restart or a reopened session runs the same prompt and an edit reaches only new sessions.
 *
 * Kantel injects nothing of its own (the clean-prompt decision, #143): the platform layer is empty until the
 * deployment's operator, a `system` caller, adds rules to it.
 *
 * Who may do what:
 *
 * - Write (`put`, `remove`): platform rules only `system`; an organisation's rules an organisation-wide admin; a
 *   project's rules an admin on the project; a user's rules that user, or an organisation-wide admin. Agents never
 *   write rules, whatever their session's scope.
 * - Read (`list`, `get`): a project's rules need viewer on the project; platform, organisation and user rules are open
 *   to the organisation's members, as their skills and memory are.
 * - Every change is audited (`rules.rule.put`, `rules.rule.removed`) with the rule's ID and owner, never its text.
 *
 * Another organisation's rule is `not_found`.
 */
import type { CallContext, OwnerRef, ProjectId, Timestamp, UserId } from "./common.ts";
import type { PromptLayer } from "./session.ts";

export type PromptRuleId = string;

export interface PromptRule {
	readonly id: PromptRuleId;
	/** Who owns it, and so which layer it is in. Platform rules belong to no organisation. */
	readonly owner: OwnerRef;
	/** Unique among its owner's rules: `put` with an existing name replaces that rule. */
	readonly name: string;
	readonly text: string;
	/** Its place among its owner's rules, lowest first; ties go by name. Default 0. */
	readonly order: number;
	readonly createdAt: Timestamp;
	readonly updatedAt: Timestamp;
}

export interface PutPromptRuleInput {
	readonly owner: OwnerRef;
	/** 1 to 100 characters: letters, digits, `.`, `_` and `-`, starting with a letter or digit. */
	readonly name: string;
	/** The prompt text, 1 to 32,768 characters. */
	readonly text: string;
	readonly order?: number;
}

/** Whose rules a session gets: the platform's and its organisation's always, then its project's and its user's. */
export interface PromptRuleScope {
	/** The session's project. Absent for an organisation session, which has no project layer. */
	readonly projectId?: ProjectId;
	/** The person the session works for (`SessionRecord.userId`). */
	readonly userId?: UserId;
}

export interface PromptRules {
	/** Creates the owner's rule of that name, or replaces it. Audited as `rules.rule.put`. */
	put(ctx: CallContext, input: PutPromptRuleInput): Promise<PromptRule>;
	/** Removes a rule. Audited as `rules.rule.removed`. */
	remove(ctx: CallContext, ruleId: PromptRuleId): Promise<void>;
	get(ctx: CallContext, ruleId: PromptRuleId): Promise<PromptRule>;
	/** The owner's rules, in layer order. */
	list(ctx: CallContext, owner: OwnerRef): Promise<readonly PromptRule[]>;
	/**
	 * Every rule a session in `scope` gets, in layer order (platform, organisation, project, user). Reading a project's
	 * rules needs viewer on it, as `list` does; the runtime calls this as itself after its own create check.
	 */
	forSession(ctx: CallContext, scope: PromptRuleScope): Promise<readonly PromptRule[]>;
}

export const PROMPT_RULE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const PROMPT_RULE_TEXT_LIMIT = 32_768;

/** The layer of an owner kind, for ordering: the profile's own layers go between project (2) and user (3). */
const LAYER: Readonly<Record<OwnerRef["kind"], number>> = { platform: 0, organisation: 1, project: 2, user: 3 };

/** Rules in layer order: by owner kind, then `order`, then name. */
export function sortPromptRules(rules: readonly PromptRule[]): PromptRule[] {
	return [...rules].sort(
		(left, right) =>
			LAYER[left.owner.kind] - LAYER[right.owner.kind] ||
			left.order - right.order ||
			(left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
	);
}

/** The prompt layer a rule becomes: named `rules:<owner kind>:<name>`. */
export function promptRuleLayer(rule: Pick<PromptRule, "owner" | "name" | "text">): PromptLayer {
	return { name: `rules:${rule.owner.kind}:${rule.name}`, text: rule.text };
}

/**
 * A session's prompt layers: its rules around its profile's own layers, platform → organisation → project → profile →
 * user. Rules from another layer than these four (none today) are dropped.
 */
export function resolvePromptLayers(
	rules: readonly PromptRule[],
	profileLayers: readonly PromptLayer[],
): PromptLayer[] {
	const sorted = sortPromptRules(rules);
	const before = sorted.filter((rule) => LAYER[rule.owner.kind] < LAYER.user).map(promptRuleLayer);
	const after = sorted.filter((rule) => rule.owner.kind === "user").map(promptRuleLayer);
	return [...before, ...profileLayers, ...after];
}
