/** The reference `PromptRules`: rows in a map, every rule in `createPromptRules`. */
import type { PromptRule, PromptRules } from "@harbour/contracts";
import { createPromptRules, ownerKey, type PromptRuleStore, type PromptRulesOptions } from "./index.ts";

export function createMemoryPromptRuleStore(): PromptRuleStore {
	const rules = new Map<string, PromptRule>();
	return {
		async get(id) {
			return rules.get(id);
		},
		async ofOwner(owner) {
			const key = ownerKey(owner);
			return [...rules.values()].filter((rule) => ownerKey(rule.owner) === key);
		},
		async save(rule) {
			const key = ownerKey(rule.owner);
			const existing = [...rules.values()].find((other) => ownerKey(other.owner) === key && other.name === rule.name);
			const stored = existing === undefined ? rule : { ...rule, id: existing.id, createdAt: existing.createdAt };
			rules.set(stored.id, stored);
			return stored;
		},
		async delete(id) {
			rules.delete(id);
		},
	};
}

export function createMemoryPromptRules(options: Omit<PromptRulesOptions, "store"> = {}): PromptRules {
	return createPromptRules({ ...options, store: createMemoryPromptRuleStore() });
}
