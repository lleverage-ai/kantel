/**
 * Where the CLI finds Kantel and its key: flags (`--url`, `--key` or `--api-key`, `--account`), then the environment
 * (`KANTEL_URL`, `KANTEL_API_KEY`, `KANTEL_ACCOUNT`), then `${XDG_CONFIG_HOME:-~/.config}/kantel/config.json`, which
 * `kantel login` writes with mode 0600. Each setting is taken from the first place that has it.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, UsageError } from "./errors.ts";

/** Where Kantel is when nothing says otherwise: the hosted gateway. A self-hosted install is given with `--url`. */
export const DEFAULT_URL = "https://app.kantel.dev";

export interface Env {
	readonly [name: string]: string | undefined;
}

/** What `config.json` holds. */
export interface StoredConfig {
	readonly url?: string;
	readonly apiKey?: string;
	readonly account?: string;
}

/** What the flags gave. */
export interface ConfigFlags {
	readonly url?: string;
	readonly apiKey?: string;
	readonly account?: string;
}

export interface ResolvedConfig {
	/** The API's base URL, `<origin>/v1`. */
	readonly url: string;
	readonly apiKey?: string;
	readonly account?: string;
}

/** The directory `config.json` is in: `override`, else `${XDG_CONFIG_HOME:-~/.config}/kantel`. */
export function configDirectory(env: Env, override?: string): string {
	if (override !== undefined) return override;
	const xdg = env.XDG_CONFIG_HOME;
	return join(xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".config"), "kantel");
}

/** The config file in `directory`. */
export function configFile(directory: string): string {
	return join(directory, "config.json");
}

const isLocal = (host: string): boolean => /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(host);

/**
 * Kantel's API base URL from what someone typed: `<origin>/v1`, whether or not `/v1` (or any path) was given. A bare
 * host gets `https://`, or `http://` when it is local.
 */
export function normaliseUrl(input: string): string {
	const trimmed = input.trim();
	const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
		? trimmed
		: `${isLocal(trimmed) ? "http" : "https"}://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new UsageError(`"${input}" isn't a URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new UsageError(`"${input}" isn't an http(s) URL`);
	return `${url.origin}/v1`;
}

/** The origin of an API base URL, for people to read. */
export function originOf(url: string): string {
	return url.replace(/\/v1\/?$/, "");
}

const first = (...values: (string | undefined)[]): string | undefined =>
	values.find((value) => value !== undefined && value !== "");

/** Each setting from the flags, else the environment, else the file; the URL else `defaultUrl`. */
export function resolveConfig(
	flags: ConfigFlags,
	env: Env,
	stored: StoredConfig,
	defaultUrl: string = DEFAULT_URL,
): ResolvedConfig {
	return {
		url: normaliseUrl(first(flags.url, env.KANTEL_URL, stored.url) ?? defaultUrl),
		apiKey: first(flags.apiKey, env.KANTEL_API_KEY, stored.apiKey),
		account: first(flags.account, env.KANTEL_ACCOUNT, stored.account),
	};
}

const isMissing = (error: unknown): boolean =>
	typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

/** What `config.json` in `directory` holds; nothing when there is no file. */
export async function readStoredConfig(directory: string): Promise<StoredConfig> {
	const path = configFile(directory);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isMissing(error)) return {};
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new CliError(`${path} isn't valid JSON: fix it or delete it and run kantel login again`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const record = value as { readonly [key: string]: unknown };
	const field = (key: string): string | undefined => {
		const item = record[key];
		return typeof item === "string" && item !== "" ? item : undefined;
	};
	return { url: field("url"), apiKey: field("apiKey"), account: field("account") };
}

/** Writes `config.json` in `directory`, readable by its owner only (0600), making the directory (0700) if need be. */
export async function writeStoredConfig(directory: string, config: StoredConfig): Promise<string> {
	const path = configFile(directory);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const stored = { url: config.url, apiKey: config.apiKey, account: config.account };
	await writeFile(path, `${JSON.stringify(stored, null, "\t")}\n`, { mode: 0o600 });
	// The mode above applies only to a new file.
	await chmod(path, 0o600);
	return path;
}

/** The settings from the flags, the environment and the file in `directory`; the URL else `defaultUrl`. */
export async function loadConfig(
	flags: ConfigFlags,
	env: Env,
	directory: string,
	defaultUrl: string = DEFAULT_URL,
): Promise<ResolvedConfig> {
	return resolveConfig(flags, env, await readStoredConfig(directory), defaultUrl);
}
