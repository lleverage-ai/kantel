import { isKantelError } from "@kantel/contracts";
import {
	findMount,
	isUnderMount,
	normalizeMountPoint,
	normalizeWorkspacePath,
	sha256Hex,
	toBytes,
} from "@kantel/workspace";
import { describe, expect, it } from "vitest";

const mounts = [{ path: "/project" }, { path: "/skills" }];

function codeOf(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		return isKantelError(error) ? error.code : "not a KantelError";
	}
	return undefined;
}

describe("normalizeWorkspacePath", () => {
	it("accepts normalised relative paths", () => {
		expect(normalizeWorkspacePath("notes/a.md")).toBe("notes/a.md");
		expect(normalizeWorkspacePath("a")).toBe("a");
		expect(normalizeWorkspacePath(".hidden/x")).toBe(".hidden/x");
	});

	it("rejects empty, absolute, dot, backslash and trailing-slash paths as invalid", () => {
		for (const path of ["", "/a", "a/../b", "..", ".", "./a", "a/.", "a//b", "a\\b", "a/", "a\0b"]) {
			expect(
				codeOf(() => normalizeWorkspacePath(path)),
				JSON.stringify(path),
			).toBe("invalid");
		}
	});
});

describe("normalizeMountPoint", () => {
	it("accepts absolute mount points and rejects the rest", () => {
		expect(normalizeMountPoint("/project")).toBe("/project");
		for (const path of ["/", "project", "/project/", "/a/../b"]) {
			expect(
				codeOf(() => normalizeMountPoint(path)),
				path,
			).toBe("invalid");
		}
	});
});

describe("isUnderMount and findMount", () => {
	it("matches the mount point and paths below it, not siblings with the same prefix", () => {
		expect(isUnderMount("/project", mounts)).toBe(true);
		expect(isUnderMount("/project/src/a.ts", mounts)).toBe(true);
		expect(isUnderMount("/projects/a", mounts)).toBe(false);
		expect(isUnderMount("project/a", mounts)).toBe(false);
	});

	it("returns the path inside the source", () => {
		expect(findMount("/project", mounts)).toEqual({ mount: { path: "/project" }, sourcePath: "" });
		expect(findMount("/skills/a/b.md", mounts)).toEqual({ mount: { path: "/skills" }, sourcePath: "a/b.md" });
		expect(findMount("/elsewhere", mounts)).toBeUndefined();
		expect(codeOf(() => findMount("/project/../etc", mounts))).toBe("invalid");
	});
});

describe("sha256Hex and toBytes", () => {
	it("hashes bytes to lower-case hex", async () => {
		expect(await sha256Hex(toBytes("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("copies byte input so later changes do not leak in", () => {
		const source = new Uint8Array([1, 2, 3]);
		const copy = toBytes(source);
		source[0] = 9;
		expect([...copy]).toEqual([1, 2, 3]);
		expect([...toBytes("é")]).toEqual([0xc3, 0xa9]);
	});
});
