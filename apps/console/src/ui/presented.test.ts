import type { PresentedFile, ToolItem, TranscriptItem, UserItem } from "@harbour/protocol";
import { describe, expect, it } from "vitest";
import { createAutoOpen } from "./presented.ts";

const file = (path: string): PresentedFile => ({
	workspaceId: "ws-1",
	path,
	name: path,
	mimeType: "text/markdown",
	size: 1,
});
const call = (id: string, paths: string[], status: ToolItem["status"] = "done"): ToolItem => ({
	kind: "tool",
	id,
	callId: id,
	at: 0,
	name: "present_files",
	label: "Presenting files",
	status,
	...(status === "done" ? { files: paths.map(file) } : {}),
});
const user = (id: string): UserItem => ({ kind: "user", id, at: 0, text: "Hi", via: "prompt" });

describe("createAutoOpen", () => {
	it("opens nothing the session already had when the screen opened", () => {
		const auto = createAutoOpen();
		expect(auto.next([user("u1"), call("t1", ["a.md"])])).toBeUndefined();
	});

	it("opens the first file of a call that finishes while the screen is open", () => {
		const auto = createAutoOpen();
		const before: TranscriptItem[] = [user("u1")];
		expect(auto.next(before)).toBeUndefined();
		expect(auto.next([...before, call("t1", ["a.md"], "running")])).toBeUndefined();
		expect(auto.next([...before, call("t1", ["a.md", "b.pdf"])])?.path).toBe("a.md");
		// The same items again open nothing more.
		expect(auto.next([...before, call("t1", ["a.md", "b.pdf"])])).toBeUndefined();
	});

	it("opens a call that arrives already finished, but not one presenting only files presented before", () => {
		const auto = createAutoOpen();
		auto.next([call("t1", ["a.md"])]);
		expect(auto.next([call("t1", ["a.md"]), call("t2", ["a.md"])])).toBeUndefined();
		expect(auto.next([call("t1", ["a.md"]), call("t2", ["a.md"]), call("t3", ["a.md", "c.html"])])?.path).toBe(
			"c.html",
		);
	});

	it("opens nothing for older pages loaded by scrolling back", () => {
		const auto = createAutoOpen();
		auto.next([user("u2")]);
		expect(auto.next([call("t0", ["old.pdf"]), user("u2")])).toBeUndefined();
	});
});
