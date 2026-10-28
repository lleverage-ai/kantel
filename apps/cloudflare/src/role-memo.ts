/**
 * One role lookup per request, not one per item. The runtime's `ProjectAccess` asks `IdentityDirectory.roleOf` for every
 * session a list returns (`allows` per record), and on Cloudflare each answer is two or three D1 queries. On the
 * deployed stack (28 Oct 2026) `GET /v1/sessions?limit=1` took 12.3 s p50 with about 55 sessions, and the console polls
 * that list every 3 s.
 *
 * This wraps the directory the runtime checks access with, so the same caller's role on the same project is looked up
 * once while the caller's request lasts:
 *
 * - The memo is keyed on the `actor` object. The authenticator makes a new one for every request it signs in, so a
 *   request never sees another request's answer.
 * - An answer is kept at most `ttlMs` (default 1 s), so an actor object that outlives its request can't hold on to a
 *   role that has since been revoked for longer than that.
 * - Only `system` calls are memoised, as `ProjectAccess` makes them. Any other caller goes straight through, so the
 *   directory still refuses (and audits) it every time.
 * - A failed lookup isn't kept.
 */
import {
	type Actor,
	type Clock,
	type IdentityDirectory,
	isSystemActor,
	type Role,
	systemClock,
} from "@harbour/contracts";

export const ROLE_MEMO_TTL_MS = 1000;

export interface RoleMemoOptions {
	readonly clock?: Clock;
	readonly ttlMs?: number;
}

export function memoiseRoleOf(identity: IdentityDirectory, options: RoleMemoOptions = {}): IdentityDirectory {
	const clock = options.clock ?? systemClock;
	const ttlMs = options.ttlMs ?? ROLE_MEMO_TTL_MS;
	const memo = new WeakMap<Actor, Map<string, { readonly at: number; readonly role: Promise<Role | undefined> }>>();

	const roleOf: IdentityDirectory["roleOf"] = (ctx, actor, organisationId, projectId) => {
		if (!isSystemActor(ctx?.actor) || typeof actor !== "object" || actor === null) {
			return identity.roleOf(ctx, actor, organisationId, projectId);
		}
		const key = `${organisationId}\u0000${projectId ?? ""}`;
		let held = memo.get(actor);
		if (held === undefined) {
			held = new Map();
			memo.set(actor, held);
		}
		const now = clock.now();
		const found = held.get(key);
		if (found !== undefined && now - found.at < ttlMs) return found.role;
		const role = identity.roleOf(ctx, actor, organisationId, projectId);
		const entry = { at: now, role };
		held.set(key, entry);
		role.catch(() => {
			if (held.get(key) === entry) held.delete(key);
		});
		return role;
	};

	return new Proxy(identity, {
		get(target, property, receiver) {
			if (property === "roleOf") return roleOf;
			return Reflect.get(target, property, receiver);
		},
	});
}
