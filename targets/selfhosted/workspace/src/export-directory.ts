/**
 * An `ExportSink` that keeps exported files under a directory on the node, such as a task's notes directory. Paths stay
 * inside the root: a path is a normalised relative workspace path, and a symlink anywhere on the way (root excepted) is
 * refused, so a link planted in the host directory cannot redirect a write. The root itself may be a symlink: it is
 * resolved once, as the host chose it. The check is not atomic with the write, so the directory must not be shared with
 * an untrusted writer while a sync runs. Each file is written to a temporary name and renamed into place, so a reader
 * never sees half a file. Removing a file also removes the directories on its way that it leaves empty (never the root,
 * and never one holding anything else), so a path that turns from a directory into a file can be written next.
 */
import { lstat, mkdir, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { KantelError } from "@kantel/contracts";
import { normalizeWorkspacePath } from "@kantel/workspace";
import type { ExportSink } from "@kantel/workspace/export";

/** Whether `path` is strictly below the absolute `root`, whatever the root is (`/` included). */
export function isStrictlyBelow(root: string, path: string): boolean {
	const below = relative(root, path);
	return below !== "" && below !== ".." && !below.startsWith(`..${sep}`) && !isAbsolute(below);
}

export function createDirectoryExportSink(root: string): ExportSink {
	let resolvedRoot: Promise<string> | undefined;
	const base = () => {
		resolvedRoot ??= (async () => {
			await mkdir(root, { recursive: true });
			return realpath(root);
		})();
		return resolvedRoot;
	};

	/** The absolute target for `path`, after checking that no existing component below the root is a symlink. */
	async function target(path: string, createParents: boolean): Promise<string> {
		const segments = normalizeWorkspacePath(path).split("/");
		let current = await base();
		for (const [index, segment] of segments.entries()) {
			current = join(current, segment);
			const last = index === segments.length - 1;
			const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			});
			if (stat?.isSymbolicLink()) {
				throw new KantelError("refused", `${path} passes through a symlink in the export directory`, { path });
			}
			if (last) {
				if (stat?.isDirectory()) throw new KantelError("invalid", `${path} is a directory on the host`, { path });
			} else if (stat === undefined) {
				if (!createParents) return current;
				await mkdir(current);
			} else if (!stat.isDirectory()) {
				throw new KantelError("invalid", `${segments.slice(0, index + 1).join("/")} is a file on the host`, { path });
			}
		}
		return current;
	}

	return {
		async write(path, content) {
			const file = await target(path, true);
			const temporary = `${file}.kantel-${crypto.randomUUID()}.tmp`;
			try {
				await writeFile(temporary, content, { flag: "wx" });
				await rename(temporary, file);
			} catch (error) {
				// The write's own error is the one worth reporting.
				await rm(temporary, { force: true }).catch(() => {});
				throw error;
			}
		},
		async remove(path) {
			const file = await target(path, false);
			await unlink(file).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
			const top = await base();
			for (let directory = dirname(file); isStrictlyBelow(top, directory); directory = dirname(directory)) {
				const emptied = await rmdir(directory).then(
					() => true,
					// Not empty (the host's files or other notes), already gone, or not a directory: stop there.
					() => false,
				);
				if (!emptied) break;
			}
		},
	};
}
