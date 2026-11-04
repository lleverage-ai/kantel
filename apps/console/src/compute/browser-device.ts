// This browser as a device of its own in an organisation's E2E chain (a `web` device), for the console the gateway
// serves. Its keys are WebCrypto keys made non-extractable and kept in IndexedDB as they are, so the page can use them
// but nothing can read them out; what it trusts is the genesis its person pasted, as `kantel e2e join` pins it. Every
// chain the gateway answers is verified from that genesis, and sessions go to hosts through the relay, which can't read
// them (@kantel/e2e/device).
//
// What this can't do is vouch for the page's own code, which the gateway serves: that is why a strict organisation
// lets no `web` device in, and why `kantel console` (local.ts) is the stronger choice.

import { toBase64url } from "@kantel/e2e/bytes";
import type { SpaceMode } from "@kantel/e2e/chain";
import {
	callHost,
	type DeviceGateway,
	DeviceTrustError,
	deviceCard,
	deviceStanding,
	keysFingerprint,
	pinGenesis,
	type SpaceTrust,
	type TrustStore,
	trustedChain,
} from "@kantel/e2e/device";
import { type DeviceKeys, generateWebKeys, keysFromWebKeys, type WebKeyPairs } from "@kantel/e2e/keys";
import type { ByteChannel } from "@kantel/e2e/session";
import type { BrowserDeviceSource, BrowserStanding } from "@kantel/ui";
import { type DeviceDb, indexedDeviceDb } from "./device-db.ts";

export type { DeviceDb } from "./device-db.ts";

/** This browser's keys for one person, and the label the chain lists them under. */
interface KeptKeys {
	readonly pairs: WebKeyPairs;
	readonly label: string;
}

export interface BrowserDevice extends BrowserDeviceSource {
	/** Runs `method` on the host of `sandboxId` over a session with this browser's keys. */
	call<T>(sandboxId: string, method: string, params?: object): Promise<T>;
	/**
	 * The space's mode as this browser verified it, from the genesis it pinned and on from the newest chain it took;
	 * undefined where it pinned none. A chain that doesn't verify, or goes back, throws: it never reads as off.
	 */
	mode(accountId: string): Promise<SpaceMode | undefined>;
}

export interface BrowserDeviceOptions {
	/** The gateway, called as the person `user` names and no one else. */
	readonly gateway: DeviceGateway;
	/**
	 * The person signed in: each has their own keys and trust in a shared browser. It throws a `DeviceTrustError` once
	 * that sign-in has ended or another has replaced it, and the device then does nothing more.
	 */
	readonly user: () => Promise<string>;
	readonly db?: DeviceDb;
	readonly label?: string;
	readonly connect?: (url: string) => Promise<ByteChannel>;
}

/** This browser as a device, or undefined where the browser can't hold keys that way (no IndexedDB or WebCrypto). */
export function browserDevice(options: BrowserDeviceOptions): BrowserDevice | undefined {
	const db = options.db ?? indexedDeviceDb();
	if (db === undefined || globalThis.crypto?.subtle === undefined) return undefined;
	const label = options.label ?? browserLabel();
	const trustOf = (user: string): TrustStore => ({
		read: (space) => db.get<SpaceTrust>("trust", `${user}/${space}`),
		update: (space, change) => db.update<SpaceTrust>("trust", `${user}/${space}`, change),
	});
	const keysOf = async (user: string, make: boolean): Promise<DeviceKeys | undefined> => {
		const kept = await db.get<KeptKeys>("keys", user);
		if (kept !== undefined) return keysFromWebKeys(kept.pairs);
		if (!make) return undefined;
		// Made here, kept only if no other tab kept a set first: every caller gets the set that is kept.
		const made: KeptKeys = { pairs: await generateWebKeys(), label };
		const winner = await db.update<KeptKeys>("keys", user, (current) => (current === undefined ? made : undefined));
		return keysFromWebKeys((winner ?? made).pairs);
	};
	const labelOf = async (user: string) => (await db.get<KeptKeys>("keys", user))?.label ?? label;

	return {
		async standing(accountId): Promise<BrowserStanding> {
			let user: string;
			try {
				user = await options.user();
			} catch (error) {
				if (error instanceof DeviceTrustError) return { kind: "refused", reason: error.message };
				throw error;
			}
			const trust = trustOf(user);
			if ((await trust.read(accountId)) === undefined) return { kind: "unpinned" };
			const keys = await keysOf(user, true);
			if (keys === undefined) return { kind: "unpinned" };
			let state: Awaited<ReturnType<typeof trustedChain>>;
			try {
				state = await trustedChain(trust, accountId, (await options.gateway.getE2EChain(accountId)).entries);
			} catch (error) {
				if (error instanceof DeviceTrustError) return { kind: "refused", reason: error.message };
				throw error;
			}
			const standing = deviceStanding(state, keys);
			if (standing.ok) return { kind: "ready", label: standing.device.label };
			if (standing.problem === "refused") return { kind: "refused", reason: standing.reason };
			// A device taken out of the chain can't come back with the same keys: the chain has spent them.
			if (state.spent.has(`key:${toBase64url(keys.static.publicKey)}`)) {
				return { kind: "refused", reason: "An admin took this browser out of the chain" };
			}
			const card = await deviceCard(keys, user, "web", await labelOf(user));
			const member = state.members.has(user) ? "" : " --member";
			return {
				kind: "pending",
				command: `kantel e2e add-device${member} ${card}`,
				fingerprint: await keysFingerprint(keys),
			};
		},
		async trust(accountId, genesis) {
			const user = await options.user();
			await pinGenesis(trustOf(user), accountId, genesis);
			await keysOf(user, true);
		},
		async mode(accountId) {
			const user = await options.user();
			const trust = trustOf(user);
			if ((await trust.read(accountId)) === undefined) return undefined;
			return (await trustedChain(trust, accountId, (await options.gateway.getE2EChain(accountId)).entries)).mode;
		},
		async call<T>(sandboxId: string, method: string, params?: object): Promise<T> {
			const user = await options.user();
			const keys = await keysOf(user, false);
			if (keys === undefined) {
				throw new DeviceTrustError(
					"unpinned",
					"This browser isn't a device in the organisation's chain: set it up from the strip at the top",
				);
			}
			return callHost<T>({
				gateway: options.gateway,
				trust: trustOf(user),
				keys,
				sandboxId,
				method,
				...(params === undefined ? {} : { params }),
				...(options.connect === undefined ? {} : { connect: options.connect }),
			});
		},
	};
}

/** The chain's label for this browser: which browser, so its person can tell it apart from their others. */
export function browserLabel(userAgent = globalThis.navigator?.userAgent ?? ""): string {
	const name = /Edg\//.test(userAgent)
		? "Edge"
		: /Firefox\//.test(userAgent)
			? "Firefox"
			: /Chrome\//.test(userAgent)
				? "Chrome"
				: /Safari\//.test(userAgent)
					? "Safari"
					: "a browser";
	return `Hosted console in ${name}`;
}
