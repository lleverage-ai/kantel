import { describe, expect, it } from "vitest";
import { filesAtOf, filesSearch, searchWithoutFiles } from "./compute-console.tsx";
import type { FilePart, FileRange, SnapshotEntry } from "./compute-model.ts";
import { samplePart } from "./fixtures.ts";
import {
	binaryByName,
	DOWNLOAD_MAX_BYTES,
	PREVIEW_PART_BYTES,
	parentOf,
	readWhole,
	sortEntries,
	textOf,
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
		expect(filesSearch("?path=/etc&file=x", { path: "" })).toBe("");
		expect(filesSearch("", { path: "home" }, "ssn_1")).toBe("?snapshot=ssn_1&path=/home");
		expect(searchWithoutFiles("?snapshot=ssn_1&path=/home&hosting=1")).toBe("?hosting=1");
		// Read back: a name with spaces and an ampersand survives; a file with a slash in it is no file.
		const odd = filesSearch("", { path: "home/my files", file: "a & b.txt" });
		expect(filesAtOf(odd)).toEqual({ path: "home/my files", file: "a & b.txt" });
		expect(filesAtOf("?path=/home/user/&file=../x")).toEqual({ path: "home/user" });
		expect(filesAtOf("")).toEqual({ path: "" });
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
	});
});
