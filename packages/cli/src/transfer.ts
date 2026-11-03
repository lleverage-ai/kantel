/**
 * Copying files between this computer and a sandbox for `kantel scp` and `kantel push`, over the files API only (no
 * SSH, so it works on isolates as well as microVMs). The API reads and writes at most 1 MiB a call; a larger file goes
 * up in 768 KiB parts that one command joins, and comes down in parts a command reads, so those need a microVM's shell.
 * A directory is copied file by file, a few at a time.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { KantelApiError, type KantelClient } from "@kantel/api/sdk";
import { CliError } from "./errors.ts";

/** The most the files API takes or gives in one call. */
export const MAX_FILE = 1024 * 1024;
/** A part of a larger file: 768 KiB, which is 1 MiB in base64. */
export const PART = 768 * 1024;
/** A part of a larger file coming down: 512 KiB, whose base64 fits well inside a command's 1 MiB of output. */
export const DOWNLOAD_PART = 512 * 1024;
/** How many files go at once. */
const CONCURRENCY = 6;

/** `sbx_123:/home/user/x` as its sandbox and path; undefined for a local path. */
export function parseRemote(spec: string): { readonly sandboxId: string; readonly path: string } | undefined {
	const match = /^([A-Za-z][\w-]*):(.*)$/.exec(spec);
	// `C:\…` is a Windows drive, not a sandbox.
	if (match === null || (match[1] as string).length === 1) return undefined;
	return { sandboxId: match[1] as string, path: match[2] as string };
}

/** A sandbox path as the API takes it: `~/x` and `x` are under the sandbox user's home, as is an empty path. */
export function remotePath(path: string): string {
	if (path === "" || path === "~") return "";
	return path.startsWith("~/") ? path.slice(2) : path;
}

/** A sandbox path for a call that defaults to the home when it has none. */
const orHome = (path: string): string | undefined => (path === "" ? undefined : path);

/** Joins a sandbox path and a relative local one, with `/`. */
export const remoteJoin = (base: string, rel: string): string =>
	base === "" ? rel.split(sep).join("/") : posix.join(base, rel.split(sep).join("/"));

const quote = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/** The command a path in the sandbox is named by in a shell, relative ones under the home. */
const shellPath = (path: string): string => (path.startsWith("/") ? quote(path) : `"$HOME"/${quote(path)}`);

function utf8(content: Uint8Array): string | undefined {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch {
		return undefined;
	}
}

/** Runs `work` on each item, `limit` at a time, in order of starting. */
async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const item = items[next++] as T;
			await work(item);
		}
	});
	await Promise.all(runners);
}

async function run(client: KantelClient, sandboxId: string, command: string): Promise<string> {
	const result = await client.runCommand(sandboxId, { command, timeoutMs: 120_000 });
	if (result.state !== "exited" || result.exitCode !== 0) {
		const why =
			result.stderr.trim() || `it ended ${result.state}${result.exitCode === undefined ? "" : ` ${result.exitCode}`}`;
		throw new CliError(`a command in ${sandboxId} failed: ${why}`);
	}
	return result.stdout;
}

/** Writes `content` to `path` in the sandbox, in parts when it is over 1 MiB. */
export async function putBytes(
	client: KantelClient,
	sandboxId: string,
	path: string,
	content: Uint8Array,
	mode?: string,
): Promise<void> {
	if (content.length <= MAX_FILE) {
		const text = utf8(content);
		await client.writeFile(sandboxId, {
			path,
			content: text ?? Buffer.from(content).toString("base64"),
			encoding: text === undefined ? "base64" : "utf8",
			mode,
		});
		return;
	}
	const parts: string[] = [];
	for (let offset = 0; offset < content.length; offset += PART) {
		const part = `${path}.kantel-part-${parts.length}`;
		await client.writeFile(sandboxId, {
			path: part,
			content: Buffer.from(content.subarray(offset, offset + PART)).toString("base64"),
			encoding: "base64",
		});
		parts.push(part);
	}
	const target = shellPath(path);
	const joined = parts.map(shellPath).join(" ");
	const chmod = mode === undefined ? "" : ` && chmod ${mode} ${target}`;
	await run(client, sandboxId, `cat ${joined} > ${target} && rm -f ${joined}${chmod}`);
}

/** The bytes of `path` in the sandbox, in parts when it is over 1 MiB. */
export async function getBytes(client: KantelClient, sandboxId: string, path: string): Promise<Uint8Array> {
	try {
		const file = await client.readFile(sandboxId, { path, encoding: "base64" });
		return Buffer.from(file.content, "base64");
	} catch (error) {
		if (!(error instanceof KantelApiError) || error.code !== "invalid" || !/larger than/.test(error.message))
			throw error;
	}
	const size = Number((await run(client, sandboxId, `stat -c %s ${shellPath(path)}`)).trim());
	if (!Number.isSafeInteger(size)) throw new CliError(`couldn't read the size of ${path}`);
	const out = new Uint8Array(size);
	for (let offset = 0; offset < size; offset += DOWNLOAD_PART) {
		const base64 = await run(
			client,
			sandboxId,
			`tail -c +${offset + 1} ${shellPath(path)} | head -c ${DOWNLOAD_PART} | base64 -w0`,
		);
		const part = Buffer.from(base64.trim(), "base64");
		if (part.length !== Math.min(DOWNLOAD_PART, size - offset)) {
			throw new CliError(`${path} came back short at byte ${offset}: it needs tail, head and base64 in the sandbox`);
		}
		out.set(part, offset);
	}
	return out;
}

/** A local file's mode for the API when it is executable, such as `0755`. */
async function executableMode(path: string): Promise<string | undefined> {
	const permissions = (await stat(path)).mode & 0o777;
	return (permissions & 0o111) === 0 ? undefined : permissions.toString(8).padStart(4, "0");
}

/** Copies a local file into the sandbox. */
export async function uploadFile(
	client: KantelClient,
	sandboxId: string,
	local: string,
	remote: string,
): Promise<number> {
	const content = await readFile(local);
	await putBytes(client, sandboxId, remote, content, await executableMode(local));
	return content.length;
}

/** The files under `root`, relative to it, leaving out `.git`. */
export async function walk(root: string): Promise<string[]> {
	const found: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) found.push(relative(root, path));
		}
	};
	await visit(root);
	return found.sort();
}

/** In a git repository: the files git tracks and the new ones .gitignore doesn't leave out. Otherwise undefined. */
export function gitFiles(root: string): Promise<string[] | undefined> {
	return new Promise((done) => {
		const child = spawn("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			cwd: root,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.once("error", () => done(undefined));
		child.once("close", (code) => {
			if (code !== 0) return done(undefined);
			const names = Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean);
			done(names.sort());
		});
	});
}

export interface Copied {
	readonly files: number;
	readonly bytes: number;
}

/** Copies `files` (relative to `root`) into `target` in the sandbox. Deleted local files are left out quietly. */
export async function uploadTree(
	client: KantelClient,
	sandboxId: string,
	root: string,
	files: readonly string[],
	target: string,
	onFile?: (path: string) => void,
): Promise<Copied> {
	let count = 0;
	let total = 0;
	await eachLimited(files, CONCURRENCY, async (file) => {
		const local = join(root, file);
		let isFile = false;
		try {
			isFile = (await stat(local)).isFile();
		} catch {
			// Tracked by git but deleted here.
		}
		if (!isFile) return;
		const remote = remoteJoin(target, file);
		total += await uploadFile(client, sandboxId, local, remote);
		count++;
		onFile?.(remote);
	});
	return { files: count, bytes: total };
}

/** The files under `path` in the sandbox, relative to it. */
async function remoteWalk(client: KantelClient, sandboxId: string, path: string): Promise<string[]> {
	const found: string[] = [];
	const visit = async (directory: string, prefix: string): Promise<void> => {
		let cursor: string | undefined;
		do {
			const page = await client.listFiles(sandboxId, { path: orHome(directory), cursor });
			for (const entry of page.items) {
				const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
				if (entry.kind === "directory") await visit(entry.path, rel);
				else if (entry.kind === "file") found.push(rel);
			}
			cursor = page.nextCursor;
		} while (cursor !== undefined);
	};
	await visit(path, "");
	return found.sort();
}

/** Copies the directory `path` in the sandbox to `target` here. */
export async function downloadTree(
	client: KantelClient,
	sandboxId: string,
	path: string,
	target: string,
	onFile?: (path: string) => void,
): Promise<Copied> {
	const files = await remoteWalk(client, sandboxId, path);
	let total = 0;
	await eachLimited(files, CONCURRENCY, async (file) => {
		const content = await getBytes(client, sandboxId, remoteJoin(path, file));
		const local = join(target, ...file.split("/"));
		await mkdir(dirname(local), { recursive: true });
		await writeFile(local, content);
		total += content.length;
		onFile?.(local);
	});
	return { files: files.length, bytes: total };
}

/** Whether `path` in the sandbox is a directory: its parent's listing says so. */
export async function remoteIsDirectory(client: KantelClient, sandboxId: string, path: string): Promise<boolean> {
	if (path === "" || path === "/" || path === "~") return true;
	const trimmed = path.replace(/\/+$/, "");
	const parent = posix.dirname(trimmed);
	const name = posix.basename(trimmed);
	let cursor: string | undefined;
	try {
		do {
			const page = await client.listFiles(sandboxId, { path: parent === "." ? undefined : parent, cursor });
			const entry = page.items.find((item) => item.name === name);
			if (entry !== undefined) return entry.kind === "directory";
			cursor = page.nextCursor;
		} while (cursor !== undefined);
	} catch (error) {
		if (error instanceof KantelApiError && error.code === "not_found") return false;
		throw error;
	}
	return false;
}
