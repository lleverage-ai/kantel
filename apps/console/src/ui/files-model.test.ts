import { parentPath } from "@kantel/ui";
import { describe, expect, it } from "vitest";
import {
	ancestorsOf,
	contentOf,
	entryFor,
	MAX_CONTENT_BYTES,
	mediaType,
	previewOfPath,
	shouldRead,
	siblingsOf,
	worthPrefetching,
} from "./files-model.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const file = (text: string | Uint8Array, contentType = "text/plain; charset=utf-8") => ({
	status: "ready" as const,
	file: { content: typeof text === "string" ? bytes(text) : text, contentType, version: 3 },
});

describe("what the file browser shows", () => {
	it("gives the preview the bytes it read, with their media type", () => {
		const read = file("# Plan", "text/markdown; charset=utf-8");
		expect(contentOf("notes/plan.md", undefined, read)).toEqual({
			status: "ready",
			bytes: read.file.content,
			contentType: "text/markdown",
		});
		expect(mediaType("image/png; charset=binary")).toBe("image/png");
	});

	it("is loading until the read answers", () => {
		expect(contentOf("notes/plan.md", undefined, undefined)).toEqual({ status: "loading" });
		expect(contentOf("src/app.ts", undefined, { status: "loading" })).toEqual({ status: "loading" });
	});

	it("says why a file can't be shown: an error, or too large", () => {
		expect(contentOf("notes/plan.md", undefined, { status: "error", code: "not_found", message: "Gone." })).toEqual({
			status: "error",
			message: "Gone.",
		});
		const huge = { path: "dump.csv", kind: "file" as const, size: MAX_CONTENT_BYTES + 1 };
		expect(contentOf("dump.csv", huge, undefined)).toEqual({ status: "too-large" });
		expect(contentOf("notes/huge.md", undefined, { status: "error", code: "too_large", message: "" })).toEqual({
			status: "too-large",
		});
	});

	it("shows an archive as a file to download, without reading it", () => {
		const release = { path: "release.zip", kind: "file" as const, size: 2048 };
		expect(contentOf("release.zip", release, undefined)).toMatchObject({ status: "ready", contentType: "" });
		expect(previewOfPath("dist/release.zip", release)).toEqual({
			key: "dist/release.zip",
			name: "release.zip",
			path: "dist/release.zip",
			size: 2048,
		});
	});

	it("reads what the preview can draw, PDFs and Office files included, and nothing it can't", () => {
		expect(shouldRead("assets/logo.png", undefined)).toBe(true);
		expect(shouldRead("out/report.pdf", undefined)).toBe(true);
		expect(shouldRead("out/deck.pptx", undefined)).toBe(true);
		expect(shouldRead("assets/logo.png", { path: "assets/logo.png", kind: "file", size: MAX_CONTENT_BYTES + 1 })).toBe(
			false,
		);
		expect(shouldRead("release.zip", undefined)).toBe(false);
		expect(shouldRead("dump.csv", { path: "dump.csv", kind: "file", size: 10 })).toBe(true);
		expect(shouldRead("Makefile", undefined)).toBe(true);
	});

	it("moves through a folder's files in the tree's order, reading small ones ahead", () => {
		const entries = [
			{ path: "src/b.ts", kind: "file" as const, size: 1 },
			{ path: "src/lib", kind: "directory" as const, size: 0 },
			{ path: "src/a.ts", kind: "file" as const, size: 1 },
		];
		expect(siblingsOf(entries).map((each) => each.key)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(siblingsOf(undefined)).toEqual([]);
		expect(worthPrefetching({ path: "src/a.ts", kind: "file", size: 1 })).toBe(true);
		expect(worthPrefetching({ path: "big.csv", kind: "file", size: 8 * 1024 * 1024 })).toBe(false);
		expect(worthPrefetching({ path: "out.zip", kind: "file", size: 10 })).toBe(false);
	});

	it("finds a file's entry and the directories above it", () => {
		const entries = [
			{ path: "src/a.ts", kind: "file" as const, size: 1 },
			{ path: "src/b", kind: "directory" as const, size: 0 },
		];
		expect(entryFor(entries, "src/a.ts")?.size).toBe(1);
		expect(entryFor(entries, "src/b")).toBeUndefined();
		expect(entryFor(undefined, "src/a.ts")).toBeUndefined();
		expect(ancestorsOf("src/billing/retry.ts", parentPath)).toEqual(["", "src", "src/billing"]);
		expect(ancestorsOf("README.md", parentPath)).toEqual([""]);
		expect(ancestorsOf("/project/notes/a.md", parentPath)).toEqual(["", "/project", "/project/notes"]);
	});
});
