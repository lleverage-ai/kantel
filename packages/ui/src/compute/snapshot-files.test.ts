import { describe, expect, it } from "vitest";
import { filesAtOf, filesSearch, searchWithoutFiles } from "./compute-console.tsx";
import { type FilePart, type FileRange, FilesRefusedError, type SnapshotEntry } from "./compute-model.ts";
import { createComputeFixtures, SAVED, SCRATCH, samplePart } from "./fixtures.ts";
import {
	binaryByName,
	changedUnder,
	DOWNLOAD_MAX_BYTES,
	filesRoot,
	folderIn,
	foldersBelow,
	ISOLATE_ROOT,
	MICROVM_ROOT,
	PREVIEW_PART_BYTES,
	parentOf,
	readWhole,
	sortEntries,
	textOf,
	WHOLE_ROOT,
} from "./snapshot-files.tsx";

const entry = (name: string, kind: SnapshotEntry["kind"]): SnapshotEntry => ({ name, path: name, kind });

describe("the file browser", () => {
	it("lists folders first, then files, each by name", () => {
		const sorted = sortEntries([
			entry("zeta.txt", "file"),
			entry("src", "folder"),
			entry("README.md", "file"),
			entry("app", "folder"),
		]);
		expect(sorted.map((e) => e.name)).toEqual(["app", "src", "README.md", "zeta.txt"]);
	});

	it("goes up a folder, and stays at the root", () => {
		expect(parentOf("home/user/app")).toBe("home/user");
		expect(parentOf("home")).toBe("");
		expect(parentOf("")).toBe("");
	});

	it("keeps the folder and open file in the address, as the API's absolute path, with the rest of the query", () => {
		expect(filesSearch("", { path: "home/user" })).toBe("?path=/home/user");
		expect(filesSearch("?hosting", { path: "home/user", file: "notes.md" })).toBe(
			"?hosting=&path=/home/user&file=notes.md",
		);
		// Where the browser starts has no `path`; the root is `/`.
		expect(filesSearch("?path=/etc&file=x", {})).toBe("");
		expect(filesSearch("", { path: "" })).toBe("?path=/");
		expect(filesSearch("", { path: "home" }, "ssn_1")).toBe("?snapshot=ssn_1&path=/home");
		expect(searchWithoutFiles("?snapshot=ssn_1&path=/home&hosting=1")).toBe("?hosting=1");
		// Read back: a name with spaces and an ampersand survives; a file with a slash in it is no file.
		const odd = filesSearch("", { path: "home/my files", file: "a & b.txt" });
		expect(filesAtOf(odd)).toEqual({ path: "home/my files", file: "a & b.txt" });
		expect(filesAtOf("?path=/home/user/&file=../x")).toEqual({ path: "home/user" });
		expect(filesAtOf("")).toEqual({});
		expect(filesAtOf("?path=/")).toEqual({ path: "" });
		expect(filesAtOf("?file=notes.md")).toEqual({ file: "notes.md" });
	});
});

describe("where the browser may go", () => {
	it("keeps an isolate's to /workspace, its only files: it starts there, and the crumbs start there", () => {
		expect(filesRoot("isolate")).toBe(ISOLATE_ROOT);
		expect(ISOLATE_ROOT).toEqual({ top: "workspace", label: "workspace", start: "workspace" });
		expect(folderIn(ISOLATE_ROOT, undefined)).toBe("workspace");
		expect(folderIn(ISOLATE_ROOT, "workspace/src")).toBe("workspace/src");
		// At the top there are no crumbs above it, so Up is off; below it, the crumbs go back to it and no further.
		expect(foldersBelow(ISOLATE_ROOT, "workspace")).toEqual([]);
		expect(foldersBelow(ISOLATE_ROOT, "workspace/src/lib")).toEqual(["workspace/src", "workspace/src/lib"]);
		expect(parentOf("workspace/src")).toBe("workspace");
	});

	it("clamps an address above or beside an isolate's /workspace to it, rather than asking for what it refuses", () => {
		expect(folderIn(ISOLATE_ROOT, "")).toBe("workspace");
		expect(folderIn(ISOLATE_ROOT, "etc")).toBe("workspace");
		expect(folderIn(ISOLATE_ROOT, "home/user")).toBe("workspace");
		// A name that only starts like it is beside it, not in it.
		expect(folderIn(ISOLATE_ROOT, "workspaces")).toBe("workspace");
		expect(foldersBelow(ISOLATE_ROOT, "etc")).toEqual([]);
	});

	it("opens a microVM's at /home/user, and lets it go up to /", () => {
		expect(filesRoot("microvm")).toBe(MICROVM_ROOT);
		expect(folderIn(MICROVM_ROOT, undefined)).toBe("home/user");
		expect(folderIn(MICROVM_ROOT, "")).toBe("");
		expect(folderIn(MICROVM_ROOT, "etc")).toBe("etc");
		expect(foldersBelow(MICROVM_ROOT, "home/user")).toEqual(["home", "home/user"]);
		expect(foldersBelow(MICROVM_ROOT, "")).toEqual([]);
		// One whose kind isn't known shows the whole of it, from /.
		expect(filesRoot(undefined)).toBe(WHOLE_ROOT);
		expect(folderIn(WHOLE_ROOT, undefined)).toBe("");
	});

	it("reads an isolate's snapshot from /workspace, and refuses / as its host does, never as a failure", async () => {
		const source = createComputeFixtures();
		const saved = SAVED.find((entry) => entry.kind === "isolate");
		if (saved === undefined) throw new Error("No isolate snapshot");
		expect(await source.snapshots.kindOf?.(saved.id)).toBe("isolate");
		const root = filesRoot(await source.snapshots.kindOf?.(saved.id));
		const top = await source.snapshots.list(saved.id, folderIn(root, undefined));
		expect(top.map((entry) => entry.path)).toContain("workspace/src");
		await expect(source.snapshots.list(saved.id, "")).rejects.toBeInstanceOf(FilesRefusedError);
		// A microVM's snapshot opens at /home/user.
		const vm = SAVED.find((entry) => entry.kind === "microvm");
		if (vm === undefined) throw new Error("No microVM snapshot");
		const home = await source.snapshots.list(vm.id, folderIn(filesRoot(vm.kind), undefined));
		expect(home.map((entry) => entry.name)).toContain("notes.md");
		// And a running isolate's files the same.
		const live = source.sandboxes.files;
		if (live === undefined) throw new Error("No files");
		await expect(live.list(SCRATCH.id, "")).rejects.toThrow("/ is outside /workspace, an isolate's only files");
		expect((await live.list(SCRATCH.id, "workspace")).entries.length).toBeGreaterThan(0);
	});
});

describe("the file preview", () => {
	it("leaves binaries by their name unread", () => {
		expect(binaryByName("screenshot.PNG")).toBe(true);
		expect(binaryByName("app.wasm")).toBe(true);
		expect(binaryByName("notes.md")).toBe(false);
		expect(binaryByName(".bashrc")).toBe(false);
		expect(binaryByName("Makefile")).toBe(false);
	});

	it("shows text, and no preview for a NUL or bytes that aren't UTF-8", () => {
		const utf8 = new TextEncoder().encode("caf\u00e9 \u2713");
		expect(textOf(utf8, true)).toBe("caf\u00e9 \u2713");
		expect(textOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]), true)).toBeUndefined();
		expect(textOf(new Uint8Array([0xff, 0xfe, 0x41]), true)).toBeUndefined();
		// A character cut off at the end of a part waits for the next, rather than reading as a binary.
		expect(textOf(utf8.subarray(0, utf8.byteLength - 1), false)).toBe("caf\u00e9 ");
		expect(textOf(utf8.subarray(0, utf8.byteLength - 1), true)).toBeUndefined();
	});

	it("reads a large file's first part only, and the next from where it stopped", () => {
		const first = samplePart("var/log/syslog", { offset: 0, length: PREVIEW_PART_BYTES });
		expect(first.bytes.byteLength).toBe(PREVIEW_PART_BYTES);
		expect(first.size).toBeGreaterThan(PREVIEW_PART_BYTES);
		const next = samplePart("var/log/syslog", { offset: PREVIEW_PART_BYTES, length: PREVIEW_PART_BYTES });
		expect(next.bytes[0]).toBe(samplePart("var/log/syslog", { offset: PREVIEW_PART_BYTES, length: 1 }).bytes[0]);
	});

	it("downloads a file in parts, and refuses one too big to hold in the page", async () => {
		const ranges: FileRange[] = [];
		const read = async (_id: string, path: string, range: FileRange): Promise<FilePart> => {
			ranges.push(range);
			return samplePart(path, range);
		};
		const whole = await readWhole({ read }, "sbx_1", "var/log/syslog");
		expect(whole.byteLength).toBe(samplePart("var/log/syslog", { offset: 0, length: 1 }).size);
		expect(ranges.map((range) => range.offset)).toEqual([0, 1024 * 1024, 2 * 1024 * 1024]);

		const huge = async (): Promise<FilePart> => ({ bytes: new Uint8Array(8), size: DOWNLOAD_MAX_BYTES + 1 });
		await expect(readWhole({ read: huge }, "sbx_1", "big.iso")).rejects.toThrow(/too big/);

		// An empty file, and a snapshot's that comes whole whatever was asked.
		const empty = async (): Promise<FilePart> => ({ bytes: new Uint8Array(), size: 0 });
		expect((await readWhole({ read: empty }, "sbx_1", "empty")).byteLength).toBe(0);
		const once = async (): Promise<FilePart> => ({ bytes: new Uint8Array(5), size: 5 });
		expect((await readWhole({ read: once }, "ssn_1", "five")).byteLength).toBe(5);
	});

	it("sees a file change under Load more: shrunk, or ended before its size; not grown", () => {
		const part = (length: number, size: number): FilePart => ({ bytes: new Uint8Array(length), size });
		const shown = 256 * 1024;
		expect(changedUnder(shown, 2_000_000, part(shown, 2_000_000))).toBe(false);
		expect(changedUnder(shown, 2_000_000, part(shown, 2_100_000))).toBe(false);
		expect(changedUnder(shown, 2_000_000, part(0, 100_000))).toBe(true);
		expect(changedUnder(shown, 2_000_000, part(1000, 1_999_000))).toBe(true);
		expect(changedUnder(shown, 2_000_000, part(0, 2_000_000))).toBe(true);
	});

	it("fails a download whose file shrinks or ends early under it, rather than saving a stale part", async () => {
		// A ranged backend over a file that's truncated after its first part, as a rotated log is; offsets past its end
		// read nothing, as the hosts' readers do.
		const ranged = (file: { bytes: Uint8Array }, after?: (calls: number) => void) => {
			let calls = 0;
			return async (_id: string, _path: string, range: FileRange): Promise<FilePart> => {
				const start = Math.min(range.offset, file.bytes.byteLength);
				const part = {
					bytes: file.bytes.slice(start, start + range.length),
					size: file.bytes.byteLength,
				};
				calls += 1;
				after?.(calls);
				return part;
			};
		};
		const log = { bytes: new Uint8Array(2_500_000).fill(65) };
		const truncated = ranged(log, (calls) => {
			if (calls === 1) log.bytes = new Uint8Array(128 * 1024).fill(66);
		});
		await expect(readWhole({ read: truncated }, "sbx_1", "app.log")).rejects.toThrow(/changed/);

		// A part that ends before the size it gave, with the size the same.
		let asked = 0;
		const early = async (): Promise<FilePart> => {
			asked += 1;
			return { bytes: asked === 1 ? new Uint8Array(1024 * 1024) : new Uint8Array(), size: 2 * 1024 * 1024 };
		};
		await expect(readWhole({ read: early }, "sbx_1", "short")).rejects.toThrow(/changed/);

		// One that grows as it's read (a log being written) reads on to its new end.
		const growing = { bytes: new Uint8Array(1_500_000) };
		const grows = ranged(growing, (calls) => {
			if (calls === 1) growing.bytes = new Uint8Array(1_600_000);
		});
		expect((await readWhole({ read: grows }, "sbx_1", "app.log")).byteLength).toBe(1_600_000);
	});
});
