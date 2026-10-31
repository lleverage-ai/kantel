/**
 * Handing named files (`notes/`) back to the host. `Workspaces.export` returns the files at head; `syncExport` keeps a
 * host-side copy in step with them: it writes only files whose digest changed since the previous sync and removes the
 * ones that sync wrote and the workspace no longer has. It never removes a host file it did not write.
 *
 * Removals go first, so a path that turned from a file into a directory (or back) frees its place before the write. When
 * the sink fails part-way, the sync rejects with a `KantelError` whose `details.manifest` is what the host now holds:
 * the files written and removed so far, the rest as before, and the path that failed marked unknown (an empty digest),
 * so the next sync, given that manifest, writes or removes it again. Keep that manifest, not the previous one.
 *
 * The sink decides where the bytes go (a task's notes directory on a node, an R2 prefix, an upload). Paths reaching it
 * are normalised relative workspace paths; a sink writing to a filesystem must still keep them inside its root.
 */
import { type CallContext, KantelError, isKantelError, type WorkspaceId, type Workspaces } from "@kantel/contracts";

export interface ExportSink {
	write(path: string, content: Uint8Array, digest: string): Promise<void>;
	remove(path: string): Promise<void>;
}

/** What a sync wrote: path to digest. Keep it with the host's copy and pass it to the next sync. */
export interface ExportManifest {
	readonly files: { readonly [path: string]: string };
}

export interface ExportResult {
	readonly manifest: ExportManifest;
	readonly written: readonly string[];
	readonly removed: readonly string[];
}

export async function syncExport(
	ctx: CallContext,
	workspaces: Pick<Workspaces, "export">,
	id: WorkspaceId,
	options: {
		readonly prefixes: readonly string[];
		readonly sink: ExportSink;
		readonly previous?: ExportManifest;
	},
): Promise<ExportResult> {
	if (options.prefixes.length === 0) throw new KantelError("invalid", "name at least one export prefix");
	const previous = options.previous?.files ?? {};
	const files = await workspaces.export(ctx, id, options.prefixes);
	const exported = new Set(files.map((file) => file.path));
	// What the host holds, kept current as the sink works, so a failure can hand it back.
	const held: Record<string, string> = Object.create(null);
	for (const [path, digest] of Object.entries(previous)) held[path] = digest;
	const written: string[] = [];
	const removed: string[] = [];
	const step = async (path: string, work: () => Promise<void>) => {
		try {
			await work();
		} catch (error) {
			held[path] = UNKNOWN;
			const code = isKantelError(error) ? error.code : "unavailable";
			const message = error instanceof Error ? error.message : String(error);
			throw new KantelError(code, `export sync stopped at ${path}: ${message}`, {
				path,
				manifest: { files: { ...held } },
				...(isKantelError(error) && error.details !== undefined ? { cause: error.details } : {}),
			});
		}
	};
	for (const path of Object.keys(previous).sort()) {
		// Only what an earlier sync under these prefixes wrote; the host's own files are never touched.
		if (exported.has(path) || !options.prefixes.some((prefix) => path.startsWith(prefix))) continue;
		await step(path, () => options.sink.remove(path));
		delete held[path];
		removed.push(path);
	}
	for (const file of files) {
		if (Object.hasOwn(previous, file.path) && previous[file.path] === file.digest) continue;
		await step(file.path, () => options.sink.write(file.path, file.content, file.digest));
		held[file.path] = file.digest;
		written.push(file.path);
	}
	return { manifest: { files: { ...held } }, written, removed };
}

/** The manifest a failed `syncExport` hands back in its error: what the host holds now, to pass to the next sync. */
export function exportManifestOf(error: unknown): ExportManifest | undefined {
	if (!isKantelError(error)) return undefined;
	const manifest = error.details?.manifest;
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return undefined;
	const files = (manifest as { files?: unknown }).files;
	if (typeof files !== "object" || files === null || Array.isArray(files)) return undefined;
	const entries = Object.entries(files);
	if (!entries.every(([, digest]) => typeof digest === "string")) return undefined;
	return { files: Object.fromEntries(entries) as Record<string, string> };
}

/** A manifest digest no file has: the host's copy of the path is unknown, so the next sync writes or removes it. */
const UNKNOWN = "";

/** A sink that keeps the files in memory, for tests and for hosts that upload the batch themselves. */
export function createMemoryExportSink(): ExportSink & { readonly files: Map<string, Uint8Array> } {
	const files = new Map<string, Uint8Array>();
	return {
		files,
		async write(path, content) {
			files.set(path, new Uint8Array(content));
		},
		async remove(path) {
			files.delete(path);
		},
	};
}
