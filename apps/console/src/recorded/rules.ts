// The Rules page's stand-in host, in the page, for `source=recorded`: prompt rules in memory, kept in order as the
// rules service keeps them (`sortPromptRules`). It refuses platform rules as the API does, since only Harbour itself
// writes those, and lets the recorded person write everything else. On `source=api` the page runs over the public
// API's rule routes (`api/rules-http.ts`); nothing in src/app changes.

import { type OwnerRef, type PromptRule, sortPromptRules } from "@harbour/contracts";
import type { ConsoleRules } from "../api/rules-http.ts";

const ownerKey = (owner: OwnerRef): string =>
	owner.kind === "platform"
		? "platform"
		: owner.kind === "organisation"
			? `organisation:${owner.organisationId}`
			: owner.kind === "project"
				? `project:${owner.organisationId}:${owner.projectId}`
				: `user:${owner.organisationId}:${owner.userId}`;

const sameOwner = (left: OwnerRef, right: OwnerRef): boolean => ownerKey(left) === ownerKey(right);

export function createRecordedRules({
	organisationId,
	viewer,
	now = () => Date.now(),
}: {
	organisationId: string;
	viewer: string;
	now?: () => number;
}): ConsoleRules {
	let rules: PromptRule[] = [
		{
			id: "rul_recorded_1",
			owner: { kind: "organisation", organisationId },
			name: "british-english",
			text: "Write in British English.",
			order: 0,
			createdAt: now(),
			updatedAt: now(),
		},
	];
	let next = 2;
	/** Whether a new session in the project (or the organisation, with none) gets the rule, for the recorded person. */
	const applies = ({ owner }: PromptRule, projectId: string | undefined): boolean => {
		if (owner.kind === "project") return owner.projectId === projectId;
		if (owner.kind === "user") return owner.userId === viewer;
		return true;
	};
	return {
		organisationId,
		viewer,
		list: async (owner) => sortPromptRules(rules.filter((rule) => sameOwner(rule.owner, owner))),
		resolved: async (scope) => sortPromptRules(rules.filter((rule) => applies(rule, scope.projectId))),
		put: async (input) => {
			if (input.owner.kind === "platform") throw new Error("Only Harbour itself may write platform rules.");
			const at = now();
			const existing = rules.find((rule) => sameOwner(rule.owner, input.owner) && rule.name === input.name);
			const stored: PromptRule = {
				id: existing?.id ?? `rul_recorded_${next++}`,
				owner: input.owner,
				name: input.name,
				text: input.text,
				order: input.order ?? 0,
				createdAt: existing?.createdAt ?? at,
				updatedAt: at,
			};
			rules = [...rules.filter((rule) => rule.id !== stored.id), stored];
			return stored;
		},
		remove: async (ruleId) => {
			const found = rules.find((rule) => rule.id === ruleId);
			if (found === undefined) throw new Error("There's no such rule.");
			rules = rules.filter((rule) => rule.id !== ruleId);
			return found;
		},
	};
}
