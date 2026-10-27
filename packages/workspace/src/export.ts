/**
 * Handing named files (`notes/`) back to the host. `Workspaces.export` returns the files at head; `syncExport` keeps a
 * host-side copy in step with them: it writes only files whose digest changed since the previous sync and removes the
 * ones that sync wrote and the workspace no longer has. It never removes a host file it did not write.
 *
 * The sink decides where the bytes go (a task's notes directory on a node, an R2 prefix, an upload). Paths reaching it
 * are normalised relative workspace paths; a sink writing to a filesystem must still keep them inside its root.
 */
import { type CallContext, HarbourError, type WorkspaceId, type Workspaces } from "@harbour/contracts";

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
	if (options.prefixes.length === 0) throw new HarbourError("invalid", "name at least one export prefix");
	const previous = options.previous?.files ?? {};
	const files = await workspaces.export(ctx, id, options.prefixes);
	const manifest: Record<string, string> = Object.create(null);
	const written: string[] = [];
	for (const file of files) {
		manifest[file.path] = file.digest;
		if (Object.hasOwn(previous, file.path) && previous[file.path] === file.digest) continue;
		await options.sink.write(file.path, file.content, file.digest);
		written.push(file.path);
	}
	const removed: string[] = [];
	for (const path of Object.keys(previous).sort()) {
		if (Object.hasOwn(manifest, path)) continue;
		// Only what an earlier sync under these prefixes wrote; the host's own files are never touched.
		if (!options.prefixes.some((prefix) => path.startsWith(prefix))) {
			manifest[path] = previous[path]!;
			continue;
		}
		await options.sink.remove(path);
		removed.push(path);
	}
	return { manifest: { files: { ...manifest } }, written, removed };
}

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
