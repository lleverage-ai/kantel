import { parentPath } from "@harbour/ui";
import { describe, expect, it } from "vitest";
import { ancestorsOf, entryFor, isImageType, MAX_CONTENT_BYTES, shouldRead, textOf, viewOf } from "./files-model.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const file = (text: string | Uint8Array, contentType = "text/plain; charset=utf-8") => ({
	status: "ready" as const,
	file: { content: typeof text === "string" ? bytes(text) : text, contentType, version: 3 },
});

describe("what the file browser shows", () => {
	it("shows a note in the note viewer and anything else in the file viewer", () => {
		expect(viewOf("notes/plan.md", undefined, file("# Plan"))).toEqual({
			viewer: "note",
			state: { status: "ready", markdown: "# Plan" },
		});
		expect(viewOf("src/app.ts", undefined, file("const a = 1;\n"))).toEqual({
			viewer: "file",
			state: { status: "ready", text: "const a = 1;\n", size: 13, version: 3 },
		});
	});

	it("is loading until the read answers, in the viewer the file will open in", () => {
		expect(viewOf("notes/plan.md", undefined, undefined)).toEqual({ viewer: "note", state: { status: "loading" } });
		expect(viewOf("src/app.ts", undefined, { status: "loading" })).toEqual({
			viewer: "file",
			state: { status: "loading" },
		});
	});

	it("says why a file can't be shown: an error, too large, or not text", () => {
		expect(viewOf("notes/plan.md", undefined, { status: "error", code: "not_found", message: "Gone." })).toEqual({
			viewer: "note",
			state: { status: "error", message: "Gone." },
		});
		const huge = { path: "dump.csv", kind: "file" as const, size: MAX_CONTENT_BYTES + 1 };
		expect(viewOf("dump.csv", huge, undefined).state).toEqual({ status: "too-large", size: MAX_CONTENT_BYTES + 1 });
		expect(
			viewOf("notes/huge.md", { ...huge, path: "notes/huge.md" }, { status: "error", code: "too_large", message: "" }),
		).toEqual({ viewer: "file", state: { status: "too-large", size: MAX_CONTENT_BYTES + 1 } });
		expect(viewOf("data.bin", undefined, file(new Uint8Array([0, 159, 146, 150]), "application/octet-stream"))).toEqual(
			{
				viewer: "file",
				state: { status: "binary", size: 4, contentType: "application/octet-stream" },
			},
		);
		const release = { path: "release.zip", kind: "file" as const, size: 2048 };
		expect(viewOf("release.zip", release, undefined).state).toEqual({ status: "binary", size: 2048 });
	});

	it("shows an image from the object URL the host made of its bytes, loading until there is one", () => {
		const png = file(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png");
		expect(viewOf("notes/chart.png", undefined, png, "blob:chart")).toEqual({
			viewer: "file",
			state: { status: "image", src: "blob:chart", size: 4, contentType: "image/png" },
		});
		expect(viewOf("notes/chart.png", undefined, png)).toEqual({ viewer: "file", state: { status: "loading" } });
		expect(viewOf("notes/chart.png", undefined, undefined)).toEqual({ viewer: "file", state: { status: "loading" } });
		// SVG comes back as text, so it is shown as its source, never rendered.
		expect(viewOf("logo.svg", undefined, file("<svg/>"), "blob:ignored").state).toMatchObject({ status: "ready" });
		expect(isImageType("image/jpeg")).toBe(true);
		expect(isImageType("IMAGE/PNG; charset=binary")).toBe(true);
		expect(isImageType("text/plain; charset=utf-8")).toBe(false);
		expect(isImageType("image/svg+xml")).toBe(false);
	});

	it("doesn't fetch a file it can't show", () => {
		expect(shouldRead("assets/logo.png", undefined)).toBe(true);
		expect(shouldRead("assets/logo.png", { path: "assets/logo.png", kind: "file", size: MAX_CONTENT_BYTES + 1 })).toBe(
			false,
		);
		expect(shouldRead("release.zip", undefined)).toBe(false);
		expect(shouldRead("dump.csv", { path: "dump.csv", kind: "file", size: MAX_CONTENT_BYTES + 1 })).toBe(false);
		expect(shouldRead("dump.csv", { path: "dump.csv", kind: "file", size: 10 })).toBe(true);
		expect(shouldRead("Makefile", undefined)).toBe(true);
	});

	it("treats bytes that aren't UTF-8, or that hold a NUL, as not text", () => {
		expect(textOf(bytes("héllo"))).toBe("héllo");
		expect(textOf(new Uint8Array([0xff, 0xfe]))).toBeUndefined();
		expect(textOf(bytes("a\u0000b"))).toBeUndefined();
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
