/**
 * `KantelSession`: one session's own Durable Object, with `KANTEL_SESSION_OBJECTS=on` (experimental,
 * `src/session-homes.ts`). The Worker creates one for each new session (`POST /v1/sessions`), and sends it every later
 * request for that session and for its subagents, which live in it too. It is the stack's code, built as a session
 * object's (`StackOptions.home`):
 *
 * - its sessions' Pi storage, transcripts and wakes in this object's own SQLite, so each session's schema is its own
 *   (#216) and its agent loop's memory is this object's, not the stack's;
 * - their records, profiles, submissions and host registrations in the stack object's store, over RPC
 *   (`sessionStoreCall`), so the stack's directory lists them and its profiles apply;
 * - identity, audit, skills, memory, sharing and connections in D1 and workspaces in R2, as the stack has them.
 *   It keeps no workspace heads (`src/workspace-heads.ts`): with more than one object writing, each reads R2's;
 * - the browser broker for its sessions' browsers, in this object's memory, as the stack's is in the stack's;
 * - its own audit queue and usage ledger, each drained to D1;
 * - the bootstrap the stack made, read from the stack, never made again.
 *
 * Schedules, program recoveries, token refreshes and tool servers' tunnels stay with the stack object.
 */

import { createR2WorkspaceStore } from "@kantel/cloudflare-workspace";
import { namedObject, STACK_NAME } from "./route.ts";
import { type RemoteStoreMethod, remoteSessionStore } from "./session-homes.ts";
import type { BootstrapRecord, StackOptions, StackStorage } from "./stack.ts";
import { KantelStackBase } from "./stack-object.ts";

/** The stack object's RPC a session object calls. */
interface StackRpc {
	sessionStoreCall(home: string, method: RemoteStoreMethod, args: readonly unknown[]): Promise<unknown>;
	bootstrapRecord(): Promise<BootstrapRecord>;
}

/** Workspace objects live under this prefix in the bucket, as the stack's do. */
const WORKSPACE_PREFIX = "workspaces";

export abstract class KantelSessionBase extends KantelStackBase {
	/** This object's name in the stack's table of homes: its own ID, which the Worker routes by. */
	get #home(): string {
		return this.ctx.id.toString();
	}

	#stack(): StackRpc {
		return namedObject(this.env.STACK, STACK_NAME, this.env) as unknown as StackRpc;
	}

	protected override get objectKind(): string {
		return "session";
	}

	protected override stackOptions(): Omit<StackOptions, "config" | "storage"> {
		return { ...super.stackOptions(), home: true };
	}

	protected override stackStorage(): StackStorage {
		const storage = this.ctx.storage;
		const home = this.#home;
		return {
			...this.sharedStorage(),
			sessions: {
				sql: storage.sql,
				transaction: (work) => storage.transaction(() => work()),
				setAlarm: (at) => storage.setAlarm(at),
				getAlarm: () => storage.getAlarm(),
				// The directory is the stack's; only the wakes are kept here, beside the Pi storage they resume.
				store: (_local, database) =>
					remoteSessionStore((method, args) => this.#stack().sessionStoreCall(home, method, args), database),
			},
			workspaces: createR2WorkspaceStore({ bucket: this.env.WORKSPACES, prefix: WORKSPACE_PREFIX }),
			bootstrap: {
				load: () => this.#stack().bootstrapRecord(),
				// The stack's record is the one: a session object never bootstraps anything of its own.
				save: async () => {},
			},
		};
	}

	/** Every request the Worker sends here is for this object's sessions: none is forwarded on. */
	protected override elsewhere(_request: Request): string | undefined {
		return undefined;
	}
}
