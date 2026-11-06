/**
 * `kantel login` in the browser: the device sign-in (`POST /v1/auth/device`, RFC 8628 style). The CLI asks Kantel for
 * a code, shows it with the console page that approves it (and opens that page when it can), then polls until a
 * person approves or denies it there or it expires. Approval hands the CLI a new API key, which it saves like any.
 *
 * A sign-in that is still waiting is kept in `login-pending.json` beside `config.json` (0600), so a second `kantel
 * login` shows the same code rather than a new one nobody has, and an agent with no terminal can start it with one
 * command and wait for it with another (`kantel login --wait`).
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeviceLogin, KantelClient } from "@kantel/api/sdk";
import { CliError } from "./errors.ts";

/** A sign-in that waits for its approval. */
export interface PendingLogin {
	/** The API base URL it was started on. */
	readonly url: string;
	readonly deviceCode: string;
	readonly userCode: string;
	readonly verificationUrl: string;
	readonly verificationUrlComplete: string;
	readonly intervalSeconds: number;
	readonly expiresAt: number;
	/** It asked for a personal access token, not an API key in one account. */
	readonly personal?: boolean;
}

/** What a sign-in's approval hands over: a personal access token or an API key, and its secret. */
export interface SignedIn {
	readonly secret: string;
	readonly kind: "personal_token" | "api_key";
	readonly name: string;
	readonly expiresAt?: number;
}

const pendingFile = (directory: string): string => join(directory, "login-pending.json");

/** The waiting sign-in for `url`, if one is kept and hasn't expired. */
export async function readPendingLogin(directory: string, url: string, now: number): Promise<PendingLogin | undefined> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(pendingFile(directory), "utf8"));
	} catch {
		return undefined;
	}
	const pending = value as Partial<PendingLogin> | null;
	if (
		pending === null ||
		typeof pending.deviceCode !== "string" ||
		typeof pending.userCode !== "string" ||
		typeof pending.verificationUrlComplete !== "string" ||
		typeof pending.expiresAt !== "number" ||
		pending.url !== url ||
		pending.expiresAt <= now
	) {
		return undefined;
	}
	return pending as PendingLogin;
}

export async function keepPendingLogin(directory: string, pending: PendingLogin): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = pendingFile(directory);
	await writeFile(path, `${JSON.stringify(pending, null, "\t")}\n`, { mode: 0o600 });
	await chmod(path, 0o600);
}

export async function forgetPendingLogin(directory: string): Promise<void> {
	await rm(pendingFile(directory), { force: true });
}

/** Starts a sign-in on `url` and keeps it. */
export async function startLogin(
	client: KantelClient,
	url: string,
	clientName: string,
	directory: string,
	personal = true,
): Promise<PendingLogin> {
	let started: DeviceLogin;
	let asked = personal;
	try {
		started = await client.startDeviceLogin(personal ? { clientName, personal } : { clientName });
	} catch (error) {
		// A Kantel from before personal tokens refuses the field: it signs in with an API key, as it always has.
		if (!personal || (error as { code?: unknown }).code !== "invalid") throw error;
		started = await client.startDeviceLogin({ clientName });
		asked = false;
	}
	const pending: PendingLogin = {
		url,
		deviceCode: started.deviceCode,
		userCode: started.userCode,
		verificationUrl: started.verificationUrl,
		verificationUrlComplete: started.verificationUrlComplete,
		intervalSeconds: started.intervalSeconds,
		expiresAt: started.expiresAt,
		...(asked ? { personal: true } : {}),
	};
	await keepPendingLogin(directory, pending);
	return pending;
}

const EXPIRED = "the sign-in code expired: run kantel login again for a new one";

/**
 * Polls until the sign-in is approved, and answers its token or key; throws when it is denied or expires, and the pending file
 * goes in each case. A network failure leaves it, so `kantel login` again carries on with the same code.
 */
export async function waitForLogin(
	client: KantelClient,
	pending: PendingLogin,
	directory: string,
	sleep: (ms: number) => Promise<void>,
	now: () => number,
): Promise<SignedIn> {
	const interval = Math.max(1, pending.intervalSeconds) * 1000;
	const finish = async (error?: CliError): Promise<never> => {
		await forgetPendingLogin(directory);
		throw error;
	};
	for (;;) {
		let result: Awaited<ReturnType<KantelClient["pollDeviceLogin"]>>;
		try {
			result = await client.pollDeviceLogin({ deviceCode: pending.deviceCode });
		} catch (error) {
			// A 404: Kantel no longer knows the code, as it expired and was cleared.
			if (error instanceof Error && (error as { code?: unknown }).code === "not_found") {
				return finish(new CliError(EXPIRED));
			}
			throw error;
		}
		if (result.state === "approved" && result.token !== undefined) {
			await forgetPendingLogin(directory);
			const { token, secret } = result.token;
			return { secret, kind: "personal_token", name: token.name, expiresAt: token.expiresAt };
		}
		if (result.state === "approved" && result.issued !== undefined) {
			await forgetPendingLogin(directory);
			const { key, secret } = result.issued;
			return {
				secret,
				kind: "api_key",
				name: key.name,
				...(key.expiresAt === undefined ? {} : { expiresAt: key.expiresAt }),
			};
		}
		if (result.state === "denied") return finish(new CliError("the sign-in was denied in the browser"));
		if (result.state !== "pending" || now() >= pending.expiresAt) return finish(new CliError(EXPIRED));
		await sleep(interval);
	}
}

/** Opens `url` in the person's browser, quietly doing nothing where it can't. */
export function openInBrowser(url: string): void {
	const [command, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url.replaceAll("&", "^&")]]
				: ["xdg-open", [url]];
	try {
		const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
		child.on("error", () => undefined);
		child.unref();
	} catch {
		// No browser: the URL is printed anyway.
	}
}
