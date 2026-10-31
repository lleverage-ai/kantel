/**
 * Dependency layers held as archives in an object store: the generic fallback that runs on any target. `save` packs
 * the step's outputs, as they are at the workspace's head, into a tarball under the step's key; `restore` commits a
 * cached tarball's files into the workspace as one version.
 *
 * This is right for small dependency trees and the isolate tier. The seeding measurements found that extracting a
 * large `node_modules` is the long pole everywhere (n8n's took 33-45 s): targets hold large layers as an overlay lower
 * or image layer (self-hosted) or a snapshot (Cloudflare) behind the same `DependencyLayers` contract instead.
 */
import {
	type CallContext,
	type DependencyLayerRequest,
	type DependencyLayers,
	KantelError,
	type SeedFile,
	type Workspaces,
} from "@kantel/contracts";
import { DEFAULT_ARCHIVE_BYTES, DEFAULT_ARCHIVE_FILES, packTar, unpackArchive } from "./archive.ts";
import { normalizeWorkspacePath } from "./index.ts";
import { listAll } from "./stored.ts";
import type { ModedChange } from "./tree.ts";

/** Where layer archives are kept, such as an R2 bucket or an S3 prefix. Keys are the steps' sha256 keys. */
export interface LayerObjectStore {
	get(key: string): Promise<Uint8Array | undefined>;
	put(key: string, bytes: Uint8Array): Promise<void>;
}

export interface ArchiveDependencyLayersOptions {
	readonly workspaces: Pick<Workspaces, "get" | "list" | "read" | "commit">;
	readonly objects: LayerObjectStore;
	/** Prepended to each key, such as `layers/`. Default `deps/`. */
	readonly prefix?: string;
	/** The largest layer, in bytes of its files. Default 512 MiB. */
	readonly maxBytes?: number;
	/** The most files in a layer. Default 100,000. */
	readonly maxFiles?: number;
}

/** The step's outputs, as paths: its `outputs`, or every `node_modules` directory when it names none. */
export function layerOutputs(request: Pick<DependencyLayerRequest, "step">): (path: string) => boolean {
	const outputs = request.step.outputs?.map((output) => normalizeWorkspacePath(output.replace(/\/+$/, "")));
	if (outputs === undefined) return (path) => `/${path}/`.includes("/node_modules/");
	return (path) => outputs.some((output) => path === output || path.startsWith(`${output}/`));
}

export function createArchiveDependencyLayers(options: ArchiveDependencyLayersOptions): DependencyLayers {
	const prefix = options.prefix ?? "deps/";
	const maxBytes = options.maxBytes ?? DEFAULT_ARCHIVE_BYTES;
	const maxFiles = options.maxFiles ?? DEFAULT_ARCHIVE_FILES;
	const objectKey = (request: DependencyLayerRequest) => {
		if (!/^[0-9a-f]{64}$/.test(request.report.key)) throw new KantelError("invalid", "a layer key is a sha256");
		return `${prefix}${request.report.key}.tar`;
	};
	return {
		async restore(ctx: CallContext, request) {
			const bytes = await options.objects.get(objectKey(request));
			if (bytes === undefined) return false;
			const files = await unpackArchive(bytes, { url: objectKey(request) }, { maxBytes, maxFiles });
			const inside = layerOutputs(request);
			const changes: ModedChange[] = files
				.filter((file) => inside(normalizeWorkspacePath(file.path)))
				.map((file) => ({ op: "put", path: file.path, content: file.content, mode: file.mode ?? 0o644 }));
			if (changes.length === 0) return true;
			const record = await options.workspaces.get(ctx, request.workspaceId);
			await options.workspaces.commit(ctx, request.workspaceId, {
				baseVersion: record.head,
				changes,
				message: `restore dependency layer ${request.report.name}`,
			});
			return true;
		},

		async save(ctx: CallContext, request) {
			const inside = layerOutputs(request);
			const entries = (await listAll(options.workspaces, ctx, request.workspaceId)).filter(
				(entry) => entry.kind === "file" && inside(entry.path),
			);
			if (entries.length > maxFiles) {
				throw new KantelError("exhausted", `the layer has more than ${maxFiles} files`);
			}
			let total = 0;
			const files: SeedFile[] = [];
			for (const entry of entries) {
				const file = await options.workspaces.read(ctx, request.workspaceId, entry.path);
				total += file.content.byteLength;
				if (total > maxBytes) throw new KantelError("exhausted", `the layer is larger than ${maxBytes} bytes`);
				files.push({ path: entry.path, content: file.content, mode: entry.mode ?? 0o644 });
			}
			await options.objects.put(objectKey(request), packTar(files));
		},
	};
}

/** Layer archives in memory, for tests and a single process. */
export function createMemoryLayerObjects(): LayerObjectStore & { keys(): string[] } {
	const objects = new Map<string, Uint8Array>();
	return {
		get: async (key) => objects.get(key),
		put: async (key, bytes) => {
			objects.set(key, bytes);
		},
		keys: () => [...objects.keys()].sort(),
	};
}
