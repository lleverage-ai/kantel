// Where the self-hosted browser host keeps profiles and recordings: a directory (HARBOUR_BROWSER_DATA_DIR), each blob a
// file under its key. Blobs arrive sealed (the coordinator seals before it stores), so the directory holds no cookie or
// frame in the clear. Recordings past their retention are deleted by `sweepRecordings`.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { BlobStore } from "@harbour/browser/runtime";

export function directoryBlobStore(root: string): BlobStore {
	const base = resolve(root);
	const pathOf = (key: string) => {
		const path = resolve(base, key);
		if (!path.startsWith(base + sep)) throw new Error("A blob key may not leave the store");
		return path;
	};
	return {
		async get(key) {
			try {
				return new Uint8Array(await readFile(pathOf(key)));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		},
		async put(key, bytes) {
			const path = pathOf(key);
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
			await writeFile(temporary, bytes, { mode: 0o600 });
			await rename(temporary, path);
		},
		async delete(key) {
			await rm(pathOf(key), { force: true });
		},
	};
}

/** Deletes recordings whose directory hasn't changed for longer than `retentionMs`. Returns how many went. */
export async function sweepRecordings(root: string, retentionMs: number, now = Date.now()): Promise<number> {
	const dir = join(resolve(root), "recordings");
	let removed = 0;
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const path = join(dir, entry);
		try {
			const info = await stat(join(path, "manifest.json"));
			if (now - info.mtimeMs > retentionMs) {
				await rm(path, { recursive: true, force: true });
				removed += 1;
			}
		} catch {}
	}
	return removed;
}
