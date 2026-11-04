// The console as `kantel console` serves it (packages/cli/src/console.ts): from the CLI's own files on 127.0.0.1, with
// `/local/info` saying which accounts are end-to-end encrypted for this device, and `/local/e2e` running a call on a
// sandbox's host over an E2E session with the CLI's device key. The gateway relays those sessions but can't read them,
// and never served this page's code.
//
// Served by the gateway, there is no `/local/`: the console asks only on 127.0.0.1, and anything but the CLI's answer
// means it isn't local.

import { SessionError } from "@kantel/e2e/session";
import type { E2EMode } from "@kantel/ui";

export interface LocalInfo {
	readonly local: true;
	readonly device?: { readonly id: string; readonly label: string };
	readonly spaces: readonly { readonly id: string; readonly mode: E2EMode; readonly error?: string }[];
}

/** What the page has of `kantel console`: what it said about E2E, and a way to call a host over a session. */
export interface LocalBridge {
	readonly info: LocalInfo;
	/** The account's mode as this device verified it; an account it holds no chain for is off. */
	mode(accountId: string): E2EMode;
	call<T>(sandboxId: string, method: string, params?: object): Promise<T>;
}

/** A sandbox's command, as its host keeps it (`sandbox.history`, apps/host/internal/agent/history.go). */
export interface HostCommand {
	readonly id: string;
	readonly command?: string;
	readonly argv?: readonly string[];
	readonly startedAt: number;
	readonly endedAt: number;
	readonly exitCode?: number;
	readonly device: string;
	readonly deviceLabel?: string;
}

export interface HostCommandPage {
	readonly items: readonly HostCommand[];
	readonly next?: string;
}

const isLoopback = (hostname: string) => hostname === "127.0.0.1";

/** `kantel console`'s bridge, when this page is served by it; otherwise undefined. */
export async function localBridge(
	doFetch: typeof fetch = (input, init) => fetch(input, init),
	hostname: string | undefined = (globalThis as { location?: { hostname?: string } }).location?.hostname,
): Promise<LocalBridge | undefined> {
	if (hostname === undefined || !isLoopback(hostname)) return undefined;
	let info: LocalInfo;
	try {
		const answer = await doFetch("/local/info", { credentials: "same-origin" });
		if (!answer.ok) return undefined;
		info = (await answer.json()) as LocalInfo;
	} catch {
		return undefined;
	}
	if (info?.local !== true || !Array.isArray(info.spaces)) return undefined;
	return {
		info,
		mode: (accountId) => info.spaces.find((space) => space.id === accountId)?.mode ?? "off",
		async call<T>(sandboxId: string, method: string, params: object = {}): Promise<T> {
			const answer = await doFetch("/local/e2e", {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sandboxId, method, params }),
			});
			const body = (await answer.json().catch(() => ({}))) as {
				readonly result?: T;
				readonly error?: { readonly message?: string; readonly hostCode?: unknown };
			};
			if (!answer.ok || body.error !== undefined) {
				const message = body.error?.message ?? `kantel console answered ${answer.status}`;
				// The host's own answer, as a browser's session would have it: a path it won't read is the call's, not a
				// failure to reach it.
				if (typeof body.error?.hostCode === "string") throw new SessionError(body.error.hostCode, message, true);
				throw new Error(message);
			}
			return body.result as T;
		},
	};
}
