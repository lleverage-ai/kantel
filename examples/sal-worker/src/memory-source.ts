/**
 * Sal's memory repository (tvdavies/sal-memory) as a Harbour `MemorySource`, both ways (M2-BE5): `snapshot` reads the
 * OKF bundle at a commit for `importSnapshot`, and `publish` commits a space's concepts back as Sal's concept files,
 * with the directory indexes Sal rewrites, so Sal reads what Harbour publishes as if it had written it.
 *
 * Wire it with `withBundlePublishing` (`@harbour/memory/publish`), passing `render` so the bundle is Sal's files, not
 * Harbour's own export:
 *
 * ```ts
 * const source = salMemorySource({ repo, branch: "main" });
 * const memory = withBundlePublishing({ memory: inner, sourceFor: () => source, render: source.render });
 * ```
 *
 * Publishing never deletes: concept files Harbour does not hold (ones it refused on import, Sal's call notes) and every
 * file outside the bundle stay as they are, and a concept file that already says what Harbour's concept says keeps its
 * bytes. It commits through `commitFiles`, never a checkout, and only when the branch still stands where it read it.
 * Harbour's concepts win: a concept file Sal changed since Harbour imported it is overwritten with what Harbour holds
 * (Harbour imports the source before it takes writes, so Sal's change is only lost if it came after that import).
 * A concept Sal's layout has no file for fails the publish.
 * Point it at a clone of its own (bare, or with the branch not checked out); pushing that clone is the host's.
 */
import type { Concept, MemorySnapshot, MemorySource } from "@harbour/contracts";
import type { BundleFile } from "@harbour/memory/publish";
import { commitFiles, readTree, resolveCommit } from "./git.ts";
import { conceptIdOf, type OkfWriteOptions, okfConceptFiles, okfIndexes, okfSnapshot } from "./okf.ts";

export interface SalMemorySourceInput extends OkfWriteOptions {
	/** The repository; a clone of its own, as above. */
	readonly repo: string;
	/** The branch publishing commits on and `render` reads from. */
	readonly branch: string;
	/** The bundle's directory in the repository. Default `knowledge`. */
	readonly bundleDir?: string;
	/** Default `sal-memory`. */
	readonly id?: string;
	/** The commits' author and committer. Default `Harbour <harbour@localhost>`. */
	readonly author?: { readonly name: string; readonly email: string };
}

export interface SalMemorySource extends MemorySource {
	/**
	 * The space's concepts as Sal's concept files, keeping the bytes of any the branch holds that already say the same:
	 * the `render` for `withBundlePublishing`.
	 */
	render(spaceId: string, concepts: readonly Concept[]): Promise<readonly BundleFile[]>;
	snapshot(ref: string): Promise<MemorySnapshot>;
}

const decoder = new TextDecoder();

export function salMemorySource(input: SalMemorySourceInput): SalMemorySource {
	const bundleDir = (input.bundleDir ?? "knowledge").replace(/^\.\/|\/+$/g, "");
	const id = input.id ?? "sal-memory";
	const author = input.author ?? { name: "Harbour", email: "harbour@localhost" };

	/** The branch's commit, or undefined when the branch does not exist yet. */
	function head(): string | undefined {
		try {
			return resolveCommit(input.repo, `refs/heads/${input.branch}`);
		} catch {
			return undefined;
		}
	}

	/** Every bundle file at `commit`, by path inside the bundle. */
	function bundleAt(commit: string | undefined): Map<string, string> {
		if (commit === undefined) return new Map();
		return new Map(
			readTree(input.repo, commit, [bundleDir]).files.map((file) => [
				file.path.slice(bundleDir.length + 1),
				decoder.decode(file.bytes),
			]),
		);
	}

	return {
		id,

		async render(_spaceId, concepts) {
			return okfConceptFiles(concepts, bundleAt(head()), input).map((file) => ({
				path: file.path,
				content: file.text,
			}));
		},

		async publish(spaceId, files) {
			const parent = head();
			const tree = bundleAt(parent);
			const changed: string[] = [];
			for (const file of files) {
				// Concept files only: the indexes are written below, from the tree as it will be. Harbour's own export has a
				// root index, which no concept can be (an ID has two segments at least).
				if (file.path === "index.md") continue;
				// A concept Sal's layout has no file for (five segments, or one named index or log) fails the publish, which
				// is audited, rather than be left out of a publish that says it succeeded.
				if (conceptIdOf(file.path) === null) throw new Error(`Sal's memory cannot hold ${file.path}`);
				if (tree.get(file.path) === file.content) continue;
				tree.set(file.path, file.content);
				changed.push(file.path);
			}
			if (changed.length === 0 && parent !== undefined) return { ref: parent };
			const indexes = okfIndexes(changed, tree).filter((index) => tree.get(index.path) !== index.text);
			const writes = [
				...changed.map((path) => ({ path, text: tree.get(path) ?? "" })),
				...indexes.map((index) => ({ path: index.path, text: index.text })),
			];
			const ids = changed.map((path) => path.slice(0, -3));
			const subject =
				ids.length === 1
					? `memory: publish ${ids[0]} from Harbour`
					: `memory: publish ${ids.length} concepts from Harbour`;
			const commit = commitFiles(input.repo, {
				branch: input.branch,
				parent,
				files: writes.map((file) => ({ path: `${bundleDir}/${file.path}`, text: file.text })),
				message: `${subject}\n\n${ids.map((conceptId) => `- ${conceptId}`).join("\n")}\n\nHarbour-Space: ${spaceId}`,
				author,
			});
			return { ref: commit };
		},

		async snapshot(ref) {
			const commit = resolveCommit(input.repo, ref);
			const files = [...bundleAt(commit)]
				.filter(([path]) => path.endsWith(".md"))
				.map(([path, text]) => ({ path, text }));
			return okfSnapshot(files, { sourceId: id, ref: commit }).snapshot;
		},
	};
}
