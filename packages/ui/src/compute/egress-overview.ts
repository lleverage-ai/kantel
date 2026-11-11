// The account's egress in one place, for the Egress page: its proxy settings, every rule from the account, its
// environments and its sandboxes in one list with what each applies to, the protected variables and where they may be
// sent, and one log of every sandbox's requests. Kantel's API keeps a log per sandbox and none for the account, so the
// account's log is its sandboxes' logs read together.

import type {
	ComputeSource,
	DestinationBinding,
	EgressEntry,
	EgressGrant,
	Environment,
	EnvironmentRef,
	ProxySettings,
	SandboxEgress,
} from "./compute-model.ts";

/** What a rule applies to: every sandbox in the account (the proxy's lists), an environment's sandboxes, or one. */
export type RuleScope =
	| { readonly kind: "account" }
	| { readonly kind: "environment"; readonly id: string; readonly name: string }
	| { readonly kind: "sandbox"; readonly id: string; readonly name: string };

/** One rule on the Rules tab. */
export interface EgressRule {
	/** Unique on the page: the scope's and the rule's. */
	readonly key: string;
	readonly action: EgressGrant["action"];
	readonly host: string;
	/** Empty: every method. A rule for every sandbox is for whole hosts: it has none. */
	readonly methods: EgressGrant["methods"];
	/** Empty: every path. */
	readonly paths: readonly string[];
	readonly scope: RuleScope;
	/** The grant it is, for an environment's or a sandbox's. */
	readonly grant?: EgressGrant;
}

/** A protected variable and the hosts it may be sent to: where the proxy swaps in its value. */
export interface ProtectedVariableRow {
	readonly name: string;
	readonly bindings: readonly DestinationBinding[];
	readonly environment: { readonly id: string; readonly name: string };
}

/** A log entry with the sandbox it came from. */
export interface LoggedEntry extends EgressEntry {
	readonly sandboxId: string;
	readonly sandboxName: string;
	/** The sandbox's environments, in order. Absent or empty: none. */
	readonly environments?: readonly EnvironmentRef[];
	/** Each of its protected variables' names, and the environment whose value it takes. */
	readonly protectedFrom?: Readonly<Record<string, string>>;
}

export interface EgressOverview {
	readonly proxy: ProxySettings;
	readonly environments: readonly Environment[];
	readonly sandboxes: readonly SandboxEgress[];
	/** The sandboxes whose egress Kantel couldn't read, by name: the log is missing theirs. */
	readonly unread: readonly string[];
	/** The same sandboxes, by ID. */
	readonly unreadIds: readonly string[];
}

export type EgressOverviewSources = Pick<ComputeSource, "proxy" | "environments" | "sandboxes" | "egress">;

/** Reads the account's proxy, environments and every sandbox's egress. A sandbox that can't be read is left out. */
export async function loadEgressOverview(source: EgressOverviewSources, accountId: string): Promise<EgressOverview> {
	const [proxy, environments, sandboxes] = await Promise.all([
		source.proxy.get(accountId),
		source.environments.list(accountId),
		source.sandboxes.list(accountId),
	]);
	const read = await Promise.allSettled(sandboxes.map((sandbox) => source.egress.get(sandbox.id)));
	const egress: SandboxEgress[] = [];
	const unread: string[] = [];
	const unreadIds: string[] = [];
	read.forEach((result, at) => {
		if (result.status === "fulfilled") egress.push(result.value);
		else {
			unread.push(sandboxes[at]?.name ?? "a sandbox");
			if (sandboxes[at] !== undefined) unreadIds.push(sandboxes[at].id);
		}
	});
	return { proxy, environments, sandboxes: egress, unread, unreadIds };
}

/**
 * A read of the account's egress over `known`, what the page had: a sandbox the read couldn't get keeps what the page
 * knew of it, such as the grants a write just answered with, and stays named as unread.
 */
export function overRead(known: EgressOverview, read: EgressOverview): EgressOverview {
	const kept = known.sandboxes.filter((box) => read.unreadIds.includes(box.sandboxId));
	return kept.length === 0 ? read : { ...read, sandboxes: [...read.sandboxes, ...kept] };
}

const grantRule = (grant: EgressGrant, scope: RuleScope): EgressRule => ({
	key: `${scope.kind}:${scope.kind === "account" ? "" : scope.id}:${grant.id}`,
	action: grant.action,
	host: grant.host,
	methods: grant.methods,
	paths: grant.paths,
	scope,
	grant,
});

/** Every rule, the account's first (allows, then denies), then each environment's, then each sandbox's own. */
export function rulesOf(overview: EgressOverview): EgressRule[] {
	const account: RuleScope = { kind: "account" };
	const listed = (action: EgressRule["action"], hosts: readonly string[]): EgressRule[] =>
		hosts.map((host) => ({ key: `account:${action}:${host}`, action, host, methods: [], paths: [], scope: account }));
	return [
		// Closed allows nothing, whatever the list says.
		...listed("allow", overview.proxy.policy === "closed" ? [] : overview.proxy.allow),
		...listed("deny", overview.proxy.deny),
		...overview.environments.flatMap((env) =>
			env.grants.map((grant) => grantRule(grant, { kind: "environment", id: env.id, name: env.name })),
		),
		...overview.sandboxes.flatMap((box) =>
			box.grants.map((grant) => grantRule(grant, { kind: "sandbox", id: box.sandboxId, name: box.sandboxName })),
		),
	];
}

/** Each environment's protected variables, with where they may be sent. */
export function protectedVariablesOf(overview: EgressOverview): ProtectedVariableRow[] {
	return overview.environments.flatMap((env) =>
		env.variables
			.filter((variable) => variable.protected)
			.map((variable) => ({
				name: variable.name,
				bindings: variable.bindings,
				environment: { id: env.id, name: env.name },
			})),
	);
}

/** Every sandbox's log as one, newest first. */
export function logOf(overview: EgressOverview): LoggedEntry[] {
	return overview.sandboxes
		.flatMap((box) =>
			box.entries.map((entry) => ({
				...entry,
				sandboxId: box.sandboxId,
				sandboxName: box.sandboxName,
				...(box.environments.length === 0 ? {} : { environments: box.environments }),
				...(box.protectedVariables.some((variable) => variable.environmentId !== undefined)
					? {
							protectedFrom: Object.fromEntries(
								box.protectedVariables.flatMap((variable) =>
									variable.environmentId === undefined ? [] : [[variable.name, variable.environmentId]],
								),
							),
						}
					: {}),
			})),
		)
		.sort((a, b) => b.at - a.at);
}

/** The refusal code for a protected variable's placeholder sent to a host it isn't bound to. */
export const UNBOUND_CODE = "placeholder-unbound";

/** What could let a denied request through: bind the variable whose placeholder it carried, or allow its host. */
export type DenialFix =
	| {
			readonly kind: "bind";
			readonly variable?: string;
			readonly environment: { readonly id: string; readonly name: string };
	  }
	| { readonly kind: "allow" };

/**
 * The fixes a denial offers, in the order shown. A placeholder sent to an unbound host is fixed in the environment its
 * value comes from, by binding the variable there (its name, when the reason gives it): of a sandbox's several, the one
 * that wins the name, so the last of them that has it. With several and no name, there's no saying which. A host the
 * rules don't allow is fixed by a rule. A request a deny rule refused, or one to the cloud metadata address, offers
 * none: the rule is on the Rules tab.
 */
export function denialFixes(entry: LoggedEntry, variables: readonly ProtectedVariableRow[]): DenialFix[] {
	if (entry.decision !== "denied") return [];
	if (entry.code === UNBOUND_CODE) {
		const envs = entry.environments ?? [];
		const named = variables.find(
			(variable) =>
				envs.some((env) => env.id === variable.environment.id) && entry.reason?.includes(variable.name) === true,
		);
		if (named === undefined)
			return envs.length === 1 && envs[0] !== undefined ? [{ kind: "bind", environment: envs[0] }] : [];
		// The environment whose value it takes, as the sandbox says; else the last of its environments that has it.
		const fromId = entry.protectedFrom?.[named.name];
		const from =
			envs.find((env) => env.id === fromId) ??
			[...envs]
				.reverse()
				.find((env) => variables.some((each) => each.name === named.name && each.environment.id === env.id));
		return from === undefined ? [] : [{ kind: "bind", variable: named.name, environment: from }];
	}
	// The host records every policy refusal as `denied`, its reason saying which. Only a host no rule allows can be let
	// through by allowing it: a deny rule wins over an allow, and a sandbox with no network has none to allow.
	if (entry.code !== undefined && entry.code !== DENIED_CODE) return [];
	if (entry.rule !== undefined || isMetadataHost(entry.host)) return [];
	if (entry.reason !== undefined && !ALLOW_LIST_MISS.test(entry.reason)) return [];
	return [{ kind: "allow" }];
}

/** The host's code for a request its rules refused. */
const DENIED_CODE = "denied";
/** The host's reason for a host no allow list or grant names (apps/host/internal/egress, `Decide`). */
const ALLOW_LIST_MISS = /allow list/i;

/** The cloud metadata address, which is always blocked. */
const isMetadataHost = (host: string): boolean => host === "169.254.169.254";

/** "Any", "DELETE /repos/*", "POST, GET /v1/". */
export function methodsAndPaths(rule: Pick<EgressRule, "methods" | "paths">): string {
	const methods = rule.methods.join(", ");
	const paths = rule.paths.join(", ");
	if (methods === "" && paths === "") return "Any";
	return [methods, paths].filter((part) => part !== "").join(" ");
}
