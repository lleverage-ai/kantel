/**
 * Copying files between this computer and a sandbox for `kantel scp` and `kantel push`, over the files API only (no
 * SSH, so it works on isolates as well as microVMs). The API reads and writes at most 1 MiB a call. A larger file comes
 * down in 1 MiB ranged reads, and goes up in 768 KiB parts that one command joins, which needs a microVM's shell.
 * A directory is copied file by file, a few at a time.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { KantelApiError, type KantelClient } from "@kantel/api/sdk";
import { CliError } from "./errors.ts";

/** The most the files API takes or gives in one call. */
export const MAX_FILE = 1024 * 1024;
/** A part of a larger file: 768 KiB, which is 1 MiB in base64. */
export const PART = 768 * 1024;
/**
 * A part of a larger file coming down through a command, from a control plane before ranged reads: 512 KiB, whose
 * base64 fits well inside a command's 1 MiB of output.
 */
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

/** The bytes of `path` in the sandbox, in 1 MiB ranged reads when it is larger. */
export async function getBytes(client: KantelClient, sandboxId: string, path: string): Promise<Uint8Array> {
	return (await getFile(client, sandboxId, path)).content;
}

/** The file at `path` in the sandbox: its absolute path, as the API answers it, and its bytes. */
export async function getFile(
	client: KantelClient,
	sandboxId: string,
	path: string,
): Promise<{ readonly path: string; readonly content: Uint8Array }> {
	const read = (offset: number) => client.readFile(sandboxId, { path, encoding: "base64", offset, length: MAX_FILE });
	let first: Awaited<ReturnType<typeof read>>;
	try {
		first = await read(0);
	} catch (error) {
		if (!(error instanceof KantelApiError) || error.code !== "invalid" || !/larger than/.test(error.message))
			throw error;
		// A control plane from before ranged reads refuses a file over 1 MiB: read it with commands.
		return { path, content: await getBytesWithCommands(client, sandboxId, path) };
	}
	const head = Buffer.from(first.content, "base64");
	// One from before ranged reads answers the whole file, with no offset.
	if (first.offset === undefined || head.length >= first.size) return { path: first.path, content: head };
	const size = first.size;
	const out = new Uint8Array(size);
	out.set(head);
	for (let offset = head.length; offset < size; ) {
		const part = await read(offset);
		const bytes = Buffer.from(part.content, "base64");
		if (part.size !== size) throw new CliError(`${path} changed size while it was copied`);
		if (bytes.length === 0) throw new CliError(`${path} came back short at byte ${offset}`);
		out.set(bytes.subarray(0, size - offset), offset);
		offset += bytes.length;
	}
	return { path: first.path, content: out };
}

/** The bytes of a file over 1 MiB, read in parts by commands: needs a microVM, with tail, head and base64. */
async function getBytesWithCommands(client: KantelClient, sandboxId: string, path: string): Promise<Uint8Array> {
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

/** What `git ls-files` lists in `root` with `flags`, relative to it, or undefined when it isn't in a git repository. */
function gitList(root: string, flags: readonly string[]): Promise<string[] | undefined> {
	return new Promise((done) => {
		const child = spawn("git", ["ls-files", ...flags, "-z"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
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

/**
 * In a git repository: the files git tracks and the new ones .gitignore doesn't leave out, and which of them git
 * tracks. Otherwise undefined.
 */
export async function gitFiles(
	root: string,
): Promise<{ readonly files: string[]; readonly tracked: ReadonlySet<string> } | undefined> {
	const [files, tracked] = await Promise.all([
		gitList(root, ["--cached", "--others", "--exclude-standard"]),
		gitList(root, ["--cached"]),
	]);
	if (files === undefined || tracked === undefined) return undefined;
	return { files, tracked: new Set(tracked) };
}

/** Credentials push leaves out wherever they are in the tree, even when git tracks them. */
const CREDENTIALS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".netrc", ".pypirc"]);
/** Agents' sign-ins and settings: left out unless git tracks the file, as it does a project's shared settings. */
const AGENTS = new Set([".claude", ".codex", ".cursor"]);
/** `.env` and `.env.local`, not `.env.example`: left out unless git tracks the file. */
const isEnvFile = (name: string): boolean =>
	/^\.env(\..+)?$/.test(name) && !/^\.env\.(example|sample|template|dist)$/.test(name);

/**
 * Why push leaves out `file` (a relative path) by default, and the part of it to name; undefined to send it.
 * `tracked` is whether git tracks it, undefined outside a repository.
 */
export function defaultExclude(file: string, tracked: boolean | undefined): Skipped | undefined {
	const parts = file.split(/[\\/]/);
	for (let index = 0; index < parts.length; index++) {
		// Lower case: on macOS and Windows `.SSH` is `.ssh`.
		const name = (parts[index] as string).toLowerCase();
		const path = parts.slice(0, index + 1).join("/");
		if (CREDENTIALS.has(name)) return { path, why: "credentials", byDefault: true };
		if (name === ".docker" && parts[index + 1]?.toLowerCase() === "config.json") {
			return { path: `${path}/config.json`, why: "credentials", byDefault: true };
		}
		if (tracked === true) continue;
		// In a repository git may track some of the directory, which goes, so this names the file.
		if (AGENTS.has(name)) {
			return { path: tracked === undefined ? path : file, why: "an agent's sign-in and settings", byDefault: true };
		}
		// Projects commit theirs too, so a tracked one goes.
		if (name === ".npmrc") return { path, why: "it can hold a registry token", byDefault: true };
		if (isEnvFile(name)) return { path, why: "an environment file", byDefault: true };
	}
	return undefined;
}

/** Whether `path` is `directory` or inside it; both absolute. */
export function within(path: string, directory: string): boolean {
	const rel = relative(directory, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** `path` with its links resolved, or as it is when it doesn't exist. */
async function real(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

/** Something push left out, and why. */
export interface Skipped {
	readonly path: string;
	readonly why: string;
	/** A default exclude, which `--no-default-excludes` sends. */
	readonly byDefault?: true;
}

/**
 * The files push sends from `files` (relative to `root`): not ones that resolve outside `root` through a link, nor
 * ones in `keep` (absolute directories, such as Kantel's config), nor, with `defaultExcludes`, credentials, agents'
 * sign-ins and environment files ({@link defaultExclude}). `tracked` is what git tracks, in a repository.
 */
export async function pushPlan(
	root: string,
	files: readonly string[],
	options: {
		readonly tracked?: ReadonlySet<string>;
		readonly defaultExcludes: boolean;
		readonly keep?: readonly string[];
	},
): Promise<{ readonly files: string[]; readonly skipped: Skipped[] }> {
	const realRoot = await real(root);
	const keep = await Promise.all((options.keep ?? []).map(real));
	// The root's own name counts, as `.docker` does for `config.json`; checkPushRoot refuses a root in `.ssh` and such.
	const base = basename(realRoot);
	const exclude = (rel: string): Skipped | undefined => {
		if (!options.defaultExcludes) return undefined;
		const posixRel = rel.split(sep).join("/");
		const found = defaultExclude(`${base}/${posixRel}`, options.tracked?.has(posixRel));
		return found === undefined ? undefined : { ...found, path: found.path.slice(base.length + 1) || posixRel };
	};
	const sent = new Set<string>();
	const skipped = new Map<string, Skipped>();
	await eachLimited(files, 32, async (file) => {
		const named = exclude(file);
		if (named !== undefined) {
			skipped.set(named.path, named);
			return;
		}
		const target = await real(join(root, file));
		if (!within(target, realRoot)) {
			skipped.set(file, { path: file, why: "a link to outside the directory" });
			return;
		}
		const kept = keep.find((directory) => within(target, directory));
		if (kept !== undefined) {
			const path = relative(realRoot, kept).split(sep).join("/") || file;
			skipped.set(path, { path, why: "Kantel's config, with your API key" });
			return;
		}
		const linked = exclude(relative(realRoot, target));
		if (linked !== undefined) {
			skipped.set(file, { path: file, why: `a link to ${linked.path}, ${linked.why}`, byDefault: true });
			return;
		}
		sent.add(file);
	});
	return {
		files: files.filter((file) => sent.has(file)),
		skipped: [...skipped.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
	};
}

/**
 * Refuses to push `root` when it is in Kantel's config directory; when it is in a directory push leaves out, such as
 * `.ssh` (or `.claude` outside a repository), unless `defaultExcludes` is off; and when it is the home directory or holds it or Kantel's config directory,
 * unless `allowHome`. With it, answers the config directory for push to leave out.
 */
export async function checkPushRoot(
	root: string,
	options: {
		readonly home: string;
		readonly configDir: string;
		readonly allowHome: boolean;
		readonly defaultExcludes: boolean;
		readonly inRepository: boolean;
	},
): Promise<string | undefined> {
	const [realRoot, home, configDir] = await Promise.all([real(root), real(options.home), real(options.configDir)]);
	if (within(realRoot, configDir)) {
		throw new CliError(`${root} is in Kantel's config directory, ${configDir}, which holds your API key`);
	}
	for (const path of options.defaultExcludes ? new Set([resolve(root), realRoot]) : []) {
		// In a repository only credentials count: Claude Code keeps worktrees in `.claude/worktrees`.
		const found = defaultExclude(path, options.inRepository ? true : undefined);
		if (found !== undefined) {
			const where = found.path === path ? "is" : `is in ${found.path}, which is`;
			throw new CliError(
				`${root} ${where} one push leaves out (${found.why}): add --no-default-excludes if you mean it`,
			);
		}
	}
	if (!options.allowHome && within(home, realRoot)) {
		const what = realRoot === home ? "is your home directory" : `holds your home directory, ${home}`;
		throw new CliError(`${root} ${what}: push a project directory, or add --allow-home if you mean it`);
	}
	if (!within(configDir, realRoot)) return undefined;
	if (!options.allowHome) {
		throw new CliError(
			`${root} holds Kantel's config directory, ${configDir}, with your API key: push a directory that doesn't, ` +
				"or add --allow-home to push the rest",
		);
	}
	return configDir;
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
				// The names come from the sandbox, and become paths here: none may lead outside the directory.
				if (entry.name === "" || entry.name === "." || entry.name === ".." || /[\\/]/.test(entry.name)) {
					throw new CliError(
						`${sandboxId} listed ${JSON.stringify(entry.name)} in ${directory}, which isn't safe here`,
					);
				}
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
