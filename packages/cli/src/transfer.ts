/**
 * Copying files between this computer and a sandbox for `kantel scp` and `kantel push`, over the files API only (no
 * SSH, so it works on isolates as well as microVMs). The API reads and writes at most 1 MiB a call. A larger file comes
 * down in 1 MiB ranged reads, and goes up in 768 KiB parts that one command joins, which needs a microVM's shell.
 * A directory is copied file by file, a few at a time, into an isolate; into a microVM it goes as one gzipped tar.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { createGzip } from "node:zlib";
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

async function run(client: KantelClient, sandboxId: string, command: string, timeoutMs = 120_000): Promise<string> {
	const result = await client.runCommand(sandboxId, { command, timeoutMs });
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
): Promise<{ readonly files: string[]; readonly tracked: ReadonlySet<string>; readonly top: string } | undefined> {
	const [files, tracked, top] = await Promise.all([
		gitList(root, ["--cached", "--others", "--exclude-standard"]),
		gitList(root, ["--cached"]),
		gitTop(root),
	]);
	if (files === undefined || tracked === undefined || top === undefined) return undefined;
	return { files, tracked: new Set(tracked), top };
}

/** The top of the working tree `root` is in, or undefined. */
function gitTop(root: string): Promise<string | undefined> {
	return new Promise((done) => {
		const child = spawn("git", ["rev-parse", "--show-toplevel"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.once("error", () => done(undefined));
		child.once("close", (code) => {
			const top = Buffer.concat(chunks).toString("utf8").trim();
			done(code === 0 && top !== "" ? resolve(top) : undefined);
		});
	});
}

/**
 * The paths that lead to `root`, with `/`, which push puts before each file it classifies, so a root inside `.cursor`
 * or named `.docker` counts as it would from above. Both the path as named, links and all, and where it resolves
 * count. In a repository each starts at its top, named by its own name (`.docker` when git starts there), so a
 * worktree in `.claude/worktrees` isn't all agent settings. The named path's top is its nearest ancestor that
 * resolves to the repository's (`top`); with none, and outside a repository, the paths are absolute.
 */
export async function rootContexts(root: string, top?: string): Promise<string[]> {
	const named = resolve(root);
	const resolved = await real(root);
	const posixOf = (path: string) => path.split(sep).join("/");
	if (top === undefined) return [...new Set([named, resolved].map(posixOf))];
	const realTop = await real(top);
	const fromTop = (path: string, at: string) => join(basename(at), relative(at, path));
	let namedTop: string | undefined;
	for (let at = named; namedTop === undefined; at = dirname(at)) {
		if ((await real(at)) === realTop) namedTop = at;
		else if (dirname(at) === at) break;
	}
	const contexts = [namedTop === undefined ? named : fromTop(named, namedTop), fromTop(resolved, realTop)];
	return [...new Set(contexts.map(posixOf))];
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
		/** What leads to `root` ({@link rootContexts}); default its absolute paths. */
		readonly contexts?: readonly string[];
	},
): Promise<{ readonly files: string[]; readonly skipped: Skipped[] }> {
	const realRoot = await real(root);
	const keep = await Promise.all((options.keep ?? []).map(real));
	const contexts = options.contexts ?? (await rootContexts(root));
	// Each file is classified under what leads to the root, so `.cursor/User/auth.json` counts when the root is
	// `.cursor/User`, and `config.json` when it is `.docker`. A notice names the file as it is under the root.
	const exclude = (rel: string): Skipped | undefined => {
		if (!options.defaultExcludes) return undefined;
		const posixRel = rel.split(sep).join("/");
		for (const context of contexts) {
			const prefix = context === "" ? "" : `${context.replace(/\/+$/, "")}/`;
			const found = defaultExclude(`${prefix}${posixRel}`, options.tracked?.has(posixRel));
			if (found === undefined) continue;
			const under = found.path.startsWith(prefix) ? found.path.slice(prefix.length) : "";
			return { ...found, path: under === "" ? posixRel : under };
		}
		return undefined;
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

/** A ustar header block for a regular file. Names over the field's 100 bytes go in a pax record before it. */
function tarHeader(name: Uint8Array, size: number, mode: number, mtime: number, type: string): Uint8Array {
	const block = new Uint8Array(512);
	block.set(name.subarray(0, 100), 0);
	const octal = (value: number, at: number, width: number) =>
		block.set(Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`), at);
	octal(mode & 0o7777, 100, 8);
	octal(0, 108, 8);
	octal(0, 116, 8);
	octal(size, 124, 12);
	octal(mtime, 136, 12);
	block.set(Buffer.from("        "), 148);
	block.set(Buffer.from(type), 156);
	block.set(Buffer.from("ustar\x0000"), 257);
	let sum = 0;
	for (const byte of block) sum += byte;
	block.set(Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
	return block;
}

/** A pax extended header's record, `<length> <key>=<value>\n`, whose length counts the whole record. */
function paxRecord(key: string, value: string): Buffer {
	const rest = Buffer.byteLength(` ${key}=${value}\n`);
	let length = rest + 1;
	while (String(length).length + rest !== length) length = String(length).length + rest;
	return Buffer.from(`${length} ${key}=${value}\n`);
}

const padding = (size: number): Uint8Array => new Uint8Array((512 - (size % 512)) % 512);

/** The most a file in a ustar header may hold (11 octal digits); larger ones get a pax `size` record. */
const USTAR_MAX_SIZE = 0o77777777777;

/**
 * Copies `files` (relative to `root`) into `target` in a microVM as one gzipped tar: it goes up in 768 KiB parts,
 * a few at a time, and one command joins and extracts them. A tree of many small files is a handful of calls rather
 * than one a file, which for a repository of 20,000 files is minutes against seconds. Needs the microVM's shell and
 * tar, so not for an isolate. Deleted local files are left out quietly, as in `uploadTree`.
 */
export async function uploadTreeArchive(
	client: KantelClient,
	sandboxId: string,
	root: string,
	files: readonly string[],
	target: string,
	onFile?: (path: string) => void,
): Promise<Copied> {
	// Flat files in /tmp, not a directory of them: a directory the files API makes is root's, so the sandbox's user
	// couldn't remove the parts from it, while /tmp lets each owner remove their own.
	const staging = `/tmp/.kantel-push-${randomBytes(6).toString("hex")}`;
	const gzip = createGzip({ level: 1 });
	const sent: string[] = [];
	let count = 0;
	let total = 0;

	const pack = async (): Promise<void> => {
		const write = (chunk: Uint8Array): Promise<void> | undefined =>
			gzip.write(chunk) ? undefined : new Promise<void>((resolve) => gzip.once("drain", () => resolve()));
		try {
			for (const file of files) {
				const local = join(root, file);
				let info: Awaited<ReturnType<typeof stat>>;
				try {
					info = await stat(local);
				} catch {
					continue; // Tracked by git but deleted here.
				}
				if (!info.isFile()) continue;
				const content = await readFile(local);
				const path = file.split(sep).join("/");
				const name = Buffer.from(path);
				const records: Buffer[] = [];
				if (name.byteLength > 100) records.push(paxRecord("path", path));
				if (content.byteLength > USTAR_MAX_SIZE) records.push(paxRecord("size", String(content.byteLength)));
				const mtime = Math.floor(info.mtimeMs / 1000);
				if (records.length > 0) {
					const pax = Buffer.concat(records);
					await write(tarHeader(Buffer.from("PaxHeader"), pax.byteLength, 0o644, mtime, "x"));
					await write(pax);
					await write(padding(pax.byteLength));
				}
				const size = content.byteLength > USTAR_MAX_SIZE ? 0 : content.byteLength;
				// The executable bits as they are here; everything else 0644, as a file put one at a time gets.
				const mode = (info.mode & 0o111) === 0 ? 0o644 : info.mode & 0o777;
				await write(tarHeader(name, size, mode, mtime, "0"));
				await write(content);
				await write(padding(content.byteLength));
				sent.push(path);
				count++;
				total += content.byteLength;
			}
			await write(new Uint8Array(1024));
			gzip.end();
		} catch (error) {
			gzip.destroy(error instanceof Error ? error : new Error(String(error)));
		}
	};

	const upload = async (): Promise<number> => {
		const inFlight = new Set<Promise<void>>();
		let failure: unknown;
		let parts = 0;
		const put = (bytes: Uint8Array) => {
			const path = `${staging}-${String(parts++).padStart(6, "0")}`;
			const job: Promise<void> = client
				.writeFile(sandboxId, { path, content: Buffer.from(bytes).toString("base64"), encoding: "base64" })
				.then(
					() => undefined,
					(error: unknown) => {
						failure ??= error;
					},
				)
				.finally(() => inFlight.delete(job));
			inFlight.add(job);
		};
		let pending: Buffer[] = [];
		let pendingBytes = 0;
		for await (const chunk of gzip as AsyncIterable<Buffer>) {
			if (failure !== undefined) break;
			pending.push(chunk);
			pendingBytes += chunk.byteLength;
			while (pendingBytes >= PART) {
				const joined = Buffer.concat(pending);
				put(joined.subarray(0, PART));
				pending = [joined.subarray(PART)];
				pendingBytes = joined.byteLength - PART;
				while (inFlight.size >= CONCURRENCY) await Promise.race(inFlight);
			}
		}
		if (pendingBytes > 0 && failure === undefined) put(Buffer.concat(pending));
		await Promise.all(inFlight);
		if (failure !== undefined) throw failure;
		return parts;
	};

	const glob = `${quote(staging)}-*`;
	try {
		// upload() settles every part it started before it answers, failed or not, so nothing lands after the clean-up.
		const [, parts] = await Promise.all([pack(), upload()]);
		if (parts === 0) return { files: 0, bytes: 0 };
		// The parts' names sort in order, so the glob joins them as they were cut. The tar goes into a directory of its
		// own inside the destination first, so one that fails part way (a full disk) leaves the destination as it was.
		// Then each file is moved into place, a directory at a time: on one file system a move is a rename, so a file
		// already there is replaced by the whole new one in one step, never missing and never half written.
		const into = archiveTarget(target);
		const stage = quote(posix.join(archiveTargetPath(target), `.kantel-push-${staging.slice(-12)}`));
		const place = `for d; do mkdir -p "$0/$d" && find "$d" -maxdepth 1 ! -type d -print0 | xargs -0 -r mv -f -t "$0/$d" || exit 1; done`;
		await run(
			client,
			sandboxId,
			`mkdir ${stage} && cat ${glob} | tar -xzf - -C ${stage} --no-same-owner --no-same-permissions && ` +
				`(cd ${stage} && find . -type d -exec sh -c ${quote(place)} ${into} {} +); s=$?; rm -rf ${stage}; exit $s`,
			600_000,
		);
	} finally {
		await run(client, sandboxId, `rm -f ${glob}`).catch(() => undefined);
	}
	for (const path of sent) onFile?.(remoteJoin(target, path));
	return { files: count, bytes: total };
}

/**
 * A sandbox path as the files API resolves it, for a shell: a relative one under /home/user, as the files API puts it
 * (not the command account's $HOME, which on an image with no `user` is root's).
 */
const archiveTargetPath = (target: string): string =>
	target.startsWith("/") ? target : posix.join("/home/user", target);
const archiveTarget = (target: string): string => quote(archiveTargetPath(target));

/**
 * Whether a tree can go into `target` as an archive: the command account can make and write it, and write /tmp. A
 * key without `exec`, or a destination under a directory only root may write (which the files API, as root, can),
 * goes file by file instead.
 */
async function archiveFits(client: KantelClient, sandboxId: string, target: string): Promise<boolean> {
	const into = archiveTarget(target);
	try {
		await run(
			client,
			sandboxId,
			`mkdir -p ${into} && test -w ${into} && test -w /tmp && command -v tar >/dev/null && mv --help 2>&1 | grep -q -- --target-directory`,
		);
		return true;
	} catch {
		return false;
	}
}

/** Copies `files` into `target` as the sandbox takes it best: one tar into a microVM, file by file into an isolate. */
export async function uploadTreeTo(
	client: KantelClient,
	sandboxId: string,
	root: string,
	files: readonly string[],
	target: string,
	onFile?: (path: string) => void,
	note?: (line: string) => void,
): Promise<Copied> {
	let microvm: boolean;
	try {
		microvm = (await client.getSandbox(sandboxId)).type === "microvm";
	} catch (error) {
		// A key that may write files but not read the sandbox (no sandboxes:read) still pushes, one file at a time.
		if (!(error instanceof KantelApiError) || error.code !== "forbidden") throw error;
		microvm = false;
	}
	if (microvm && (await archiveFits(client, sandboxId, target))) {
		try {
			return await uploadTreeArchive(client, sandboxId, root, files, target, onFile);
		} catch (error) {
			// Extracting failed in the sandbox (a directory in the tree only root may write, say): the files API, as
			// root, still can. Anything else, such as the sandbox stopping, fails as it is.
			if (!(error instanceof CliError) || !/^a command in /.test(error.message)) throw error;
			note?.(`kantel: the archive couldn't be extracted (${error.message}); sending file by file`);
		}
	}
	return uploadTree(client, sandboxId, root, files, target, onFile);
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
