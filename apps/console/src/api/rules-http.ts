// The Rules page's seam on a Harbour host: prompt rules over the public API's rule routes (`/v1/rules`, `@harbour/api`'s
// generated SDK). Same-origin under /v1, like the session API: behind Cloudflare Access the browser's cookie signs each
// call in; signed in with an email code, `headers` adds the session's bearer.
//
// The server decides every call (packages/rules/CONTRACT.md): the organisation's rules need an organisation-wide admin,
// a project's an admin on it, a person's that person or an organisation-wide admin, and the platform's a `system`
// caller, which no one at the console is. A refusal rejects with the server's own message, for the page to show.

import { createHarbourClient } from "@harbour/api/sdk";
import type { MeResponse, OwnerRef, PromptRule, PutPromptRuleInput } from "@harbour/contracts";
import { PROMPT_RULE_NAME, PROMPT_RULE_TEXT_LIMIT } from "@harbour/contracts";

/** Prompt rules as the signed-in person may read and write them. */
export interface ConsoleRules {
	/** The signed-in person's organisation: the owner of its rules, and of each project's and person's. */
	readonly organisationId: string;
	/** The signed-in person's user ID, whose rules are "Yours". Absent for a caller who isn't a person. */
	readonly viewer?: string;
	/** The owner's rules, lowest `order` first, then by name. */
	list(owner: OwnerRef, signal?: AbortSignal): Promise<readonly PromptRule[]>;
	/**
	 * The rules a new session would get, in layer order: the platform's, the organisation's, the project's when one is
	 * named, then the signed-in person's.
	 */
	resolved(scope: { readonly projectId?: string }, signal?: AbortSignal): Promise<readonly PromptRule[]>;
	/** Creates the owner's rule of that name, or replaces its text and order. */
	put(input: PutPromptRuleInput): Promise<PromptRule>;
	/** Removes a rule, answering with it. New sessions stop getting it; running ones keep theirs. */
	remove(ruleId: string): Promise<PromptRule>;
}

export interface RulesApiOptions {
	/** Default `/v1`, on this origin. */
	readonly baseUrl?: string;
	/** Credentials for every call, such as `Authorization`; none behind Access. */
	readonly headers?: () => Readonly<Record<string, string>>;
	readonly fetch?: typeof fetch;
	/** A 401 from any call: the sign-in has ended. */
	readonly onUnauthenticated?: () => void;
}

/** `GET /v1/rules`'s query for an owner: its kind, and the project or the person it names. */
const ownerQuery = (owner: OwnerRef) => ({
	owner: owner.kind,
	...(owner.kind === "project" ? { projectId: owner.projectId } : {}),
	...(owner.kind === "user" ? { userId: owner.userId } : {}),
});

const callOptions = (signal: AbortSignal | undefined) => (signal === undefined ? undefined : { signal });

/** The Rules page on the gateway this console is served by (`source=api`), for the signed-in `me`. */
export function apiRules(
	me: Pick<MeResponse, "actor" | "organisationId">,
	options: RulesApiOptions = {},
): ConsoleRules {
	const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
	const watched: typeof fetch = async (input, init) => {
		const response = await doFetch(input, init);
		if (response.status === 401) options.onUnauthenticated?.();
		return response;
	};
	const api = createHarbourClient({
		baseUrl: options.baseUrl ?? "/v1",
		...(options.headers === undefined ? {} : { headers: options.headers }),
		fetch: watched,
	});
	return {
		organisationId: me.organisationId,
		...(me.actor.kind === "human" ? { viewer: me.actor.userId } : {}),
		list: async (owner, signal) =>
			(await api.listPromptRules(ownerQuery(owner), callOptions(signal))).items as readonly PromptRule[],
		resolved: async (scope, signal) => {
			const query = scope.projectId === undefined ? {} : { projectId: scope.projectId };
			return (await api.resolvePromptRules(query, callOptions(signal))).items as readonly PromptRule[];
		},
		put: async (input) => (await api.putPromptRule(input)) as PromptRule,
		remove: async (ruleId) => (await api.removePromptRule(ruleId)) as PromptRule,
	};
}

/** A rule as the Add rule and Edit forms hold it: the order as typed. */
export interface RuleDraft {
	readonly name: string;
	readonly order: string;
	readonly text: string;
}

export interface RuleDraftErrors {
	readonly name?: string;
	readonly order?: string;
	readonly text?: string;
}

/** The order a rule may have (packages/rules/CONTRACT.md). */
export const RULE_ORDER_LIMIT = 1_000_000;

const count = (value: number) => value.toLocaleString("en-GB");

/**
 * What's wrong with a draft before it is sent, by field: the name's shape, a whole-number order in range and the
 * text's length. An empty object when it may be sent; the server still decides.
 */
export function ruleDraftErrors(draft: RuleDraft): RuleDraftErrors {
	const name = draft.name.trim();
	const nameError =
		name === ""
			? "Give the rule a name."
			: PROMPT_RULE_NAME.test(name)
				? undefined
				: "Use up to 100 letters, digits, dots, underscores and hyphens, starting with a letter or digit.";
	const order = draft.order.trim() === "" ? 0 : Number(draft.order);
	const orderError =
		Number.isInteger(order) && Math.abs(order) <= RULE_ORDER_LIMIT
			? undefined
			: `Use a whole number from -${count(RULE_ORDER_LIMIT)} to ${count(RULE_ORDER_LIMIT)}.`;
	const textError =
		draft.text.trim() === ""
			? "Write what the rule tells the agent."
			: draft.text.length > PROMPT_RULE_TEXT_LIMIT
				? `Keep the text to ${count(PROMPT_RULE_TEXT_LIMIT)} characters; it has ${count(draft.text.length)}.`
				: undefined;
	return {
		...(nameError === undefined ? {} : { name: nameError }),
		...(orderError === undefined ? {} : { order: orderError }),
		...(textError === undefined ? {} : { text: textError }),
	};
}

/** A draft as `put`'s input for `owner`, once `ruleDraftErrors` has nothing to say about it. */
export function ruleInput(owner: OwnerRef, draft: RuleDraft): PutPromptRuleInput {
	const order = draft.order.trim() === "" ? 0 : Number(draft.order);
	return { owner, name: draft.name.trim(), text: draft.text, order };
}
