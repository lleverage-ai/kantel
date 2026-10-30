/**
 * Prompt rules (`PromptRules`, `@harbour/contracts/rules`) over any `PromptRuleStore`: every check, the validation and
 * the audit events live here, so the in-memory store (`./memory.ts`) and the SQL one (`./sql.ts`) cannot drift apart.
 * A store only keeps rows.
 */
import {
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	HarbourError,
	type OwnerRef,
	PLATFORM_ORGANISATION,
	PROMPT_RULE_NAME,
	PROMPT_RULE_TEXT_LIMIT,
	type ProjectAccess,
	type PromptRule,
	type PromptRuleId,
	type PromptRuleScope,
	type PromptRules,
	type PutPromptRuleInput,
	requireSystem,
	sortPromptRules,
	systemClock,
	systemContext,
} from "@harbour/contracts";

/** Rules append their audit events as themselves. */
const AUDIT_CONTEXT = systemContext("rules");

/** What a store keeps: rows by ID and by owner and name. Checks, validation and audit are `createPromptRules`'s. */
export interface PromptRuleStore {
	get(id: PromptRuleId): Promise<PromptRule | undefined>;
	/** The owner's rules, in any order. */
	ofOwner(owner: OwnerRef): Promise<readonly PromptRule[]>;
	/**
	 * Writes the rule. When its owner already has a rule of that name, that rule takes the new text, order and
	 * `updatedAt` and keeps its ID and `createdAt`, atomically, so two racing writes of one name leave one rule. Resolves
	 * the rule as stored.
	 */
	save(rule: PromptRule): Promise<PromptRule>;
	delete(id: PromptRuleId): Promise<void>;
}

export interface PromptRulesOptions {
	readonly store: PromptRuleStore;
	/** Checks project and organisation roles. Without it only the owner and agent rules apply. */
	readonly access?: ProjectAccess;
	readonly audit?: AuditSink;
	readonly clock?: Clock;
}

/** A stable key for an owner: its kind and IDs, as JSON. */
export function ownerKey(owner: OwnerRef): string {
	switch (owner.kind) {
		case "platform":
			return JSON.stringify([owner.kind]);
		case "organisation":
			return JSON.stringify([owner.kind, owner.organisationId]);
		case "project":
			return JSON.stringify([owner.kind, owner.organisationId, owner.projectId]);
		case "user":
			return JSON.stringify([owner.kind, owner.organisationId, owner.userId]);
	}
}

/** The organisation a rule's rows and audit events go under: the platform's has its own. */
export function organisationOf(owner: OwnerRef): string {
	return owner.kind === "platform" ? PLATFORM_ORGANISATION : owner.organisationId;
}

export function createPromptRules(options: PromptRulesOptions): PromptRules {
	const { store, access } = options;
	const clock = options.clock ?? systemClock;

	/** A rule the caller's organisation may know of: its own organisation's, or the platform's. */
	const visible = (ctx: CallContext, rule: PromptRule | undefined): rule is PromptRule =>
		rule !== undefined && (rule.owner.kind === "platform" || rule.owner.organisationId === ctx.organisationId);

	const notFound = (id: string) => new HarbourError("not_found", `No prompt rule ${id}`);

	/** The owner as a well-formed `OwnerRef` (only its own fields), in the caller's organisation unless the platform. */
	function checkOwner(ctx: CallContext, owner: unknown): OwnerRef {
		const fields = (typeof owner === "object" && owner !== null ? owner : {}) as Record<string, unknown>;
		const id = (key: string): string => {
			const value = fields[key];
			if (typeof value !== "string" || value === "") throw new HarbourError("invalid", `A rule's owner needs ${key}`);
			return value;
		};
		const kind = fields.kind;
		if (kind === "platform") return { kind };
		if (kind !== "organisation" && kind !== "project" && kind !== "user") {
			throw new HarbourError("invalid", "A rule's owner is the platform, an organisation, a project or a user");
		}
		const organisationId = id("organisationId");
		const checked: OwnerRef =
			kind === "organisation"
				? { kind, organisationId }
				: kind === "project"
					? { kind, organisationId, projectId: id("projectId") }
					: { kind, organisationId, userId: id("userId") };
		// Another organisation's owner is one the caller can't know of.
		if (organisationId !== ctx.organisationId) throw new HarbourError("not_found", "No such owner");
		return checked;
	}

	/** Who may change an owner's rules. Agents never may; every refusal but the owner check is audited once. */
	async function requireWrite(ctx: CallContext, owner: OwnerRef, operation: string): Promise<void> {
		if (owner.kind === "platform") {
			await requireSystem(ctx, operation, {
				...(options.audit === undefined ? {} : { audit: options.audit }),
				clock,
				organisationId: ctx.organisationId,
			});
			return;
		}
		if (ctx.actor.kind === "system") return;
		if (owner.kind === "user" && ctx.actor.kind === "human" && ctx.actor.userId === owner.userId) return;
		if (access === undefined) {
			if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", "Agents may not change prompt rules");
			return;
		}
		// Admin, which no agent holds: on the project for its rules, else across the organisation (a user's rules too,
		// when someone other than that user changes them).
		await access.require(ctx, {
			...(owner.kind === "project" ? { projectId: owner.projectId } : {}),
			needed: "admin",
			operation,
		});
	}

	/** A project's rules need viewer on it; the others are open to the organisation. */
	async function requireRead(ctx: CallContext, owner: OwnerRef, operation: string): Promise<void> {
		if (owner.kind !== "project" || access === undefined) return;
		await access.require(ctx, { projectId: owner.projectId, needed: "viewer", operation });
	}

	async function audit(ctx: CallContext, type: string, rule: PromptRule): Promise<void> {
		if (options.audit === undefined) return;
		const owner = rule.owner;
		const event: AuditEventInput = {
			id: `rules:${type}:${rule.id}:${crypto.randomUUID()}`,
			at: clock.now(),
			source: "rules",
			type,
			actor: ctx.actor,
			organisationId: organisationOf(owner),
			...(owner.kind === "project" ? { projectId: owner.projectId } : {}),
			...(ctx.actor.kind === "agent" ? { sessionId: ctx.actor.sessionId, agentId: ctx.actor.agentId } : {}),
			subject: { kind: "rules.rule", id: rule.id },
			// The rule's ID and owner, never its text.
			data: {
				owner: {
					kind: owner.kind,
					...(owner.kind === "project" ? { projectId: owner.projectId } : {}),
					...(owner.kind === "user" ? { userId: owner.userId } : {}),
				},
			},
		};
		await options.audit.append(AUDIT_CONTEXT, [event]);
	}

	function validate(input: PutPromptRuleInput): { name: string; text: string; order: number } {
		const { name, text } = input;
		if (typeof name !== "string" || !PROMPT_RULE_NAME.test(name)) {
			throw new HarbourError(
				"invalid",
				"A rule's name is 1 to 100 letters, digits, '.', '_' or '-', starting with a letter or digit",
			);
		}
		if (typeof text !== "string" || text.trim() === "" || text.length > PROMPT_RULE_TEXT_LIMIT) {
			throw new HarbourError("invalid", `A rule's text is 1 to ${PROMPT_RULE_TEXT_LIMIT} characters`);
		}
		const order = input.order ?? 0;
		if (typeof order !== "number" || !Number.isInteger(order) || Math.abs(order) > 1_000_000) {
			throw new HarbourError("invalid", "A rule's order is a whole number between -1,000,000 and 1,000,000");
		}
		return { name, text, order };
	}

	return {
		async put(ctx, input) {
			const owner = checkOwner(ctx, input?.owner);
			await requireWrite(ctx, owner, "rules.rule.put");
			const { name, text, order } = validate(input);
			const now = clock.now();
			const rule = await store.save({
				id: `rule_${crypto.randomUUID()}`,
				owner,
				name,
				text,
				order,
				createdAt: now,
				updatedAt: now,
			});
			await audit(ctx, "rules.rule.put", rule);
			return rule;
		},

		async remove(ctx, ruleId) {
			const rule = await store.get(ruleId);
			if (!visible(ctx, rule)) throw notFound(ruleId);
			await requireWrite(ctx, rule.owner, "rules.rule.remove");
			await store.delete(rule.id);
			await audit(ctx, "rules.rule.removed", rule);
		},

		async get(ctx, ruleId) {
			const rule = await store.get(ruleId);
			if (!visible(ctx, rule)) throw notFound(ruleId);
			await requireRead(ctx, rule.owner, "rules.rule.get");
			return rule;
		},

		async list(ctx, owner) {
			const checked = checkOwner(ctx, owner);
			await requireRead(ctx, checked, "rules.rule.list");
			return sortPromptRules(await store.ofOwner(checked));
		},

		async forSession(ctx, scope: PromptRuleScope) {
			const organisationId = ctx.organisationId;
			const owners: OwnerRef[] = [{ kind: "platform" }, { kind: "organisation", organisationId }];
			if (scope.projectId !== undefined) {
				const project: OwnerRef = { kind: "project", organisationId, projectId: scope.projectId };
				await requireRead(ctx, project, "rules.rule.list");
				owners.push(project);
			}
			if (scope.userId !== undefined) owners.push({ kind: "user", organisationId, userId: scope.userId });
			const rules = (await Promise.all(owners.map((owner) => store.ofOwner(owner)))).flat();
			return sortPromptRules(rules);
		},
	};
}
