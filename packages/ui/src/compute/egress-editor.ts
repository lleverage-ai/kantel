// What the Egress page changes, one change at a time. What a write answers with goes into the page's snapshot straight
// away, and only then is the account's egress read again, so a read that fails can't undo a change Kantel accepted.
// Grants are written with the API's `expected`, the grants as read: if someone changed them since (another page, the
// CLI), Kantel refuses with `conflict` and the change is made again on a fresh read, as the CLI does. The account's
// lists are changed the same way, with the proxy settings as read as the change's `expected`.

import type {
	EgressGrant,
	EgressPolicy,
	Environment,
	ProxySettings,
	ProxySettingsChange,
	SandboxEgress,
} from "./compute-model.ts";
import {
	type EgressOverview,
	type EgressOverviewSources,
	type EgressRule,
	loadEgressOverview,
	overRead,
	type RuleScope,
} from "./egress-overview.ts";

/** A rule from Add rule. */
export interface NewRule {
	readonly action: EgressGrant["action"];
	readonly host: string;
	readonly methods: EgressGrant["methods"];
	readonly paths: readonly string[];
	readonly scope: RuleScope;
}

/** What a change came to. */
export type ChangeResult =
	/** Written, and the account's egress read again. */
	| { readonly status: "saved" }
	/** Written, but reading the account's egress again failed: the page shows what the write answered. */
	| { readonly status: "saved-unrefreshed"; readonly error: unknown }
	/** Another change hasn't finished. Nothing was written. */
	| { readonly status: "busy" };

export interface EgressEditorOptions {
	readonly source: EgressOverviewSources;
	readonly accountId: string;
	readonly initial: EgressOverview;
	/** The newest snapshot, after each write and each read. */
	readonly publish: (overview: EgressOverview) => void;
	/** Which change is running, or undefined when none is. */
	readonly onBusy?: (what: string | undefined) => void;
}

export const BUSY_TEXT = "Another change is still being saved. Try again when it finishes.";

/** How many times a change is made on a fresh read when Kantel says what it changes changed since: the CLI's too. */
const ATTEMPTS = 3;

const isConflict = (error: unknown): boolean =>
	typeof error === "object" && error !== null && (error as { readonly code?: unknown }).code === "conflict";

/** Writes from `grants`, the grants as read; on `conflict`, reads them again and writes again, up to ATTEMPTS. */
async function asRead<T>(
	grants: readonly EgressGrant[],
	reread: () => Promise<readonly EgressGrant[]>,
	write: (grants: readonly EgressGrant[]) => Promise<T>,
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await write(grants);
		} catch (error) {
			if (attempt >= ATTEMPTS || !isConflict(error)) throw error;
		}
		grants = await reread();
	}
}

export class EgressEditor {
	#current: EgressOverview;
	#running: string | undefined;
	#grants = 0;
	readonly #options: EgressEditorOptions;

	constructor(options: EgressEditorOptions) {
		this.#options = options;
		this.#current = options.initial;
	}

	/** The newest snapshot. */
	get current(): EgressOverview {
		return this.#current;
	}

	/** The change running, if any. */
	get running(): string | undefined {
		return this.#running;
	}

	/** A read the page did itself, such as Try again: the editor writes from it next, unless a change is running. */
	replace(overview: EgressOverview): void {
		if (this.#running !== undefined) return;
		this.#current = overview;
	}

	/** Changes the account's proxy settings. */
	updateProxy(what: string, change: ProxySettingsChange): Promise<ChangeResult> {
		return this.#run(
			what,
			() => this.#options.source.proxy.update(this.#options.accountId, change),
			(base, proxy) => ({ ...base, proxy }),
		);
	}

	/**
	 * Chooses what sandboxes may reach. Allowed hosts needs a host for every sandbox: with none, Kantel's API reads it
	 * back as Nothing, so `firstHost` is sent with it in one write, and nothing is open in between.
	 */
	choosePolicy(policy: EgressPolicy, firstHost?: string): Promise<ChangeResult> {
		if (policy !== "allowlist" || firstHost === undefined) return this.updateProxy("policy", { policy });
		return this.#editProxy("policy", (proxy) =>
			proxy.allow.includes(firstHost) ? { policy } : { policy, allow: [...proxy.allow, firstHost] },
		);
	}

	/** Adds a rule where it applies. One for every sandbox while sandboxes may reach nothing makes it Allowed hosts. */
	addRule(rule: NewRule): Promise<ChangeResult> {
		const { scope } = rule;
		if (scope.kind === "account") {
			return this.#editProxy("add", (proxy) => {
				if (rule.action === "allow" && proxy.policy === "closed") return { policy: "allowlist", allow: [rule.host] };
				const list = rule.action === "allow" ? proxy.allow : proxy.deny;
				if (list.includes(rule.host)) return undefined;
				return rule.action === "allow" ? { allow: [...list, rule.host] } : { deny: [...list, rule.host] };
			});
		}
		return this.#replaceGrants("add", scope, (grants) => {
			this.#grants += 1;
			return [
				...grants,
				{
					// The API gives a grant its own ID; this one only has to be unique until it does.
					id: `grt_new_${Date.now()}_${this.#grants}`,
					action: rule.action,
					host: rule.host,
					methods: rule.methods,
					paths: rule.paths,
				},
			];
		});
	}

	/** Removes a rule from where it applies. */
	removeRule(rule: EgressRule): Promise<ChangeResult> {
		const { scope } = rule;
		if (scope.kind === "account") {
			return this.#editProxy(rule.key, (proxy) =>
				rule.action === "allow"
					? { allow: proxy.allow.filter((host) => host !== rule.host) }
					: { deny: proxy.deny.filter((host) => host !== rule.host) },
			);
		}
		return this.#replaceGrants(rule.key, scope, (grants) => grants.filter((grant) => grant.id !== rule.grant?.id));
	}

	/** Reads the account's egress again, as one of the page's changes. */
	refresh(): Promise<ChangeResult> {
		return this.#run(
			"reload",
			() => Promise.resolve(undefined),
			(base) => base,
		);
	}

	/**
	 * Changes the account's lists with `edit` of the settings read just now, sent with them as `expected`; `undefined`
	 * writes nothing. On `conflict` someone changed them since: `edit` is made again on a fresh read.
	 */
	#editProxy(what: string, edit: (proxy: ProxySettings) => ProxySettingsChange | undefined): Promise<ChangeResult> {
		const { source, accountId } = this.#options;
		return this.#run(
			what,
			async () => {
				for (let attempt = 1; ; attempt++) {
					const proxy = await source.proxy.get(accountId);
					const change = edit(proxy);
					if (change === undefined) return proxy;
					try {
						return await source.proxy.update(accountId, { ...change, expected: proxy });
					} catch (error) {
						if (attempt >= ATTEMPTS || !isConflict(error)) throw error;
					}
				}
			},
			(base, proxy) => ({ ...base, proxy }),
		);
	}

	/**
	 * Replaces an environment's or a sandbox's grants with `next` of the newest ones, sent with those as `expected`. On
	 * `conflict` someone changed them since: `next` is made again on a fresh read of them.
	 */
	#replaceGrants(
		what: string,
		scope: Exclude<RuleScope, { kind: "account" }>,
		next: (grants: readonly EgressGrant[]) => readonly EgressGrant[],
	): Promise<ChangeResult> {
		const { source } = this.#options;
		if (scope.kind === "environment") {
			return this.#run(
				what,
				() =>
					asRead(
						this.#current.environments.find((env) => env.id === scope.id)?.grants ?? [],
						async () => (await source.environments.get(scope.id)).grants,
						(grants) => source.environments.setGrants(scope.id, next(grants), grants),
					),
				withEnvironment,
			);
		}
		return this.#run(
			what,
			() =>
				asRead(
					this.#current.sandboxes.find((box) => box.sandboxId === scope.id)?.grants ?? [],
					async () => (await source.egress.get(scope.id)).grants,
					(grants) => source.egress.setGrants(scope.id, next(grants), grants),
				),
			withSandbox,
		);
	}

	async #run<T>(
		what: string,
		write: () => Promise<T>,
		apply: (base: EgressOverview, written: T) => EgressOverview,
	): Promise<ChangeResult> {
		if (this.#running !== undefined) return { status: "busy" };
		this.#running = what;
		this.#options.onBusy?.(what);
		try {
			// A failed write throws to the caller, with the snapshot as it was.
			const written = await write();
			this.#publish(apply(this.#current, written));
			try {
				// A sandbox this read can't get keeps what the write answered for it.
				this.#publish(overRead(this.#current, await loadEgressOverview(this.#options.source, this.#options.accountId)));
				return { status: "saved" };
			} catch (error) {
				return { status: "saved-unrefreshed", error };
			}
		} finally {
			this.#running = undefined;
			this.#options.onBusy?.(undefined);
		}
	}

	#publish(overview: EgressOverview): void {
		this.#current = overview;
		this.#options.publish(overview);
	}
}

/** `overview` with an environment as a write answered it, and its sandboxes with its grants. */
export function withEnvironment(overview: EgressOverview, env: Environment): EgressOverview {
	return {
		...overview,
		environments: overview.environments.map((each) => (each.id === env.id ? env : each)),
		sandboxes: overview.sandboxes.map((box) =>
			box.environment?.id === env.id ? { ...box, environmentGrants: env.grants } : box,
		),
	};
}

/** `overview` with a sandbox's egress as a write answered it. Its log is kept: a grant changes no past request. */
export function withSandbox(overview: EgressOverview, egress: SandboxEgress): EgressOverview {
	return {
		...overview,
		sandboxes: overview.sandboxes.map((box) =>
			box.sandboxId === egress.sandboxId
				? { ...egress, entries: egress.entries.length > 0 ? egress.entries : box.entries }
				: box,
		),
	};
}
