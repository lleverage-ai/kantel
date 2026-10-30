import type { ToolItem, TranscriptItem } from "@harbour/protocol";
import { describe, expect, it } from "vitest";
import { assistant, finishedTurn, liveTurn, notice, tool, user } from "./fixtures.ts";
import {
	activeBrowsingRow,
	browserEntrySlots,
	browserViewSlots,
	closeRows,
	finalAnswerIds,
	findTurn,
	groupTranscript,
	isTurn,
	messageKeys,
	repeatedImageFiles,
	rowOfTurn,
	sessionBrowsers,
	type TranscriptRow,
	turnAnchor,
	turnFolds,
	workingPlacement,
} from "./transcript-model.ts";

const shape = (rows: readonly TranscriptRow[]) =>
	rows.map((row) =>
		row.kind === "item"
			? `item ${row.id}`
			: row.kind === "subagent"
				? `subagent ${row.id}`
				: `${row.kind} ${row.id} [${row.items.map((item) => item.id).join(",")}]${row.live ? " live" : ""}`,
	);

describe("groupTranscript", () => {
	it("groups consecutive tool calls into one row keyed by the first call", () => {
		expect(shape(groupTranscript(finishedTurn))).toEqual(["item u1", "tools t1 [t1,t2,t3,t4]", "item a1"]);
	});

	it("ends a group at any item that is not a tool call", () => {
		const items: TranscriptItem[] = [
			tool("x1", "read", "Read a.md"),
			tool("x2", "read", "Read b.md"),
			notice("n1", "warning", "The last command may have partly run."),
			tool("x3", "bash", "Ran ls"),
			assistant("a1", "Done."),
			tool("x4", "bash", "Ran pwd"),
		];
		expect(shape(groupTranscript(items))).toEqual([
			"tools x1 [x1,x2]",
			"item n1",
			"tools x3 [x3]",
			"item a1",
			"tools x4 [x4] live",
		]);
	});

	it("keeps a single tool call in a group, and marks only a trailing group live", () => {
		expect(
			shape(groupTranscript([user("u1", "Go"), tool("x1", "bash", "Running make", { status: "running" })])),
		).toEqual(["item u1", "tools x1 [x1] live"]);
		expect(shape(groupTranscript(liveTurn))).toEqual(["item u2", "tools t5 [t5,t6]", "item a2"]);
	});

	it("gives a subagent's call a row of its own, ending any group, and keeps it while it is unchanged", () => {
		const running = tool("s1", "subagent", "subagent", { status: "running", args: { task: "Count the tests" } });
		const items: TranscriptItem[] = [tool("x1", "read", "Read a.md"), running, tool("x2", "bash", "Ran ls")];
		const first = groupTranscript(items);
		expect(shape(first)).toEqual(["tools x1 [x1]", "subagent s1", "tools x2 [x2] live"]);
		const again = groupTranscript([...items, assistant("a1", "Done")], first);
		expect(again[1]).toBe(first[1]);
		const done = { ...running, status: "done" as const, output: "12 tests" };
		const after = groupTranscript([items[0] as ToolItem, done, items[2] as ToolItem], first);
		expect(after[1]).not.toBe(first[1]);
		// A subagent's call is work: the answer before it isn't the turn's final answer.
		const turn = groupTranscript([user("u1", "Go"), assistant("a1", "On it"), done]);
		expect(finalAnswerIds(turn).size).toBe(0);
		expect(rowOfTurn(turn, done.callId)?.item).toBe(done);
	});

	it("returns no rows for no items", () => {
		expect(groupTranscript([])).toEqual([]);
	});

	it("reuses every row whose items are unchanged while the last answer streams", () => {
		const items = [...finishedTurn, ...liveTurn];
		const first = groupTranscript(items);
		const last = items.at(-1);
		if (last?.kind !== "assistant") throw new Error("fixture changed");
		const streamed = [...items.slice(0, -1), { ...last, text: `${last.text}, all green so far` }];
		const second = groupTranscript(streamed, first);
		expect(second).not.toBe(first);
		expect(second.length).toBe(first.length);
		expect(second.slice(0, -1).every((row, index) => row === first[index])).toBe(true);
		expect(second.at(-1)).not.toBe(first.at(-1));
	});

	it("replaces only the group whose tool call changed", () => {
		const items = [...finishedTurn, ...liveTurn];
		const first = groupTranscript(items);
		const updated = items.map((item) =>
			item.id === "t6" && item.kind === "tool" ? { ...item, output: `${item.output}\n done` } : item,
		);
		const second = groupTranscript(updated, first);
		const changed = second.filter((row, index) => row !== first[index]).map((row) => row.id);
		expect(changed).toEqual(["t5"]);
	});

	it("returns the previous rows themselves when nothing changed", () => {
		const items = [...finishedTurn, ...liveTurn];
		const first = groupTranscript(items);
		expect(groupTranscript([...items], first)).toBe(first);
	});

	it("makes a new row when a trailing group stops being live", () => {
		const items: TranscriptItem[] = [user("u1", "Go"), tool("x1", "bash", "Ran make"), tool("x2", "bash", "Ran test")];
		const first = groupTranscript(items);
		expect(first.at(-1)).toMatchObject({ kind: "tools", live: true });
		const second = groupTranscript([...items, assistant("a1", "Both passed.")], first);
		expect(second[0]).toBe(first[0]);
		expect(second[1]).not.toBe(first[1]);
		expect(second[1]).toMatchObject({ kind: "tools", id: "x1", live: false });
	});

	it("keeps a group's key as calls are added to it", () => {
		const items: TranscriptItem[] = [user("u1", "Go"), tool("x1", "bash", "Ran make")];
		const first = groupTranscript(items);
		const second = groupTranscript([...items, tool("x2", "bash", "Running test", { status: "running" })], first);
		expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
		expect(second[0]).toBe(first[0]);
	});

	it("never merges an older page's calls into a group already shown", () => {
		// The loaded page starts inside a run of calls: t3 and t4 show as a group of two.
		const page: TranscriptItem[] = [
			tool("t3", "bash", "Ran make"),
			tool("t4", "bash", "Ran make test"),
			assistant("a1", "Done."),
		];
		const shown = groupTranscript(page);
		expect(shape(shown)).toEqual(["tools t3 [t3,t4]", "item a1"]);
		// The page before it ends with t1 and t2. They form their own group; t3's group is the same row object, so the
		// reader's place, and the group's open or closed state, stay as they were.
		const older: TranscriptItem[] = [
			user("u1", "Go"),
			tool("t1", "read", "Read a.md"),
			tool("t2", "read", "Read b.md"),
		];
		const after = groupTranscript([...older, ...page], shown);
		expect(shape(after)).toEqual(["item u1", "tools t1 [t1,t2]", "tools t3 [t3,t4]", "item a1"]);
		expect(after[2]).toBe(shown[0]);
	});

	it("groups the same calls as one run when they arrive in one load", () => {
		const items: TranscriptItem[] = [
			tool("t1", "read", "Read a.md"),
			tool("t2", "read", "Read b.md"),
			tool("t3", "bash", "Ran make"),
			assistant("a1", "Done."),
		];
		expect(shape(groupTranscript(items))).toEqual(["tools t1 [t1,t2,t3]", "item a1"]);
	});
});

describe("groupTranscript: browsing", () => {
	const browse = (id: string, label: string, status: ToolItem["status"] = "done") =>
		tool(id, id.startsWith("r") ? "browser_request" : "browser_act", label, { status });

	it("makes a run of browser calls one browsing row, with the words between two of its calls folded in", () => {
		const items: TranscriptItem[] = [
			user("u1", "Look it up"),
			browse("r1", "Asking for a browser"),
			browse("b1", "Opening en.wikipedia.org"),
			assistant("a1", "Searching for it."),
			browse("b2", "Typing into the page"),
			assistant("a2", "The text is cut off.", { thinking: "Scroll." }),
			assistant("a3", "I'll scroll."),
			browse("b3", "Scrolling the page"),
			assistant("a4", "Its population is 21,261."),
		];
		expect(shape(groupTranscript(items))).toEqual(["item u1", "browsing r1 [r1,b1,a1,b2,a2,a3,b3]", "item a4"]);
	});

	it("keeps the words after the last call a row of their own: they may be the answer", () => {
		const items: TranscriptItem[] = [
			browse("b1", "Reading the page"),
			assistant("a1", "I'll scroll", { streaming: true }),
		];
		const first = groupTranscript(items);
		expect(shape(first)).toEqual(["browsing b1 [b1]", "item a1"]);
		// The next step folds them in; the row keeps its key, and is live again.
		const next = groupTranscript([...items, browse("b2", "Scrolling the page", "running")], first);
		expect(shape(next)).toEqual(["browsing b1 [b1,a1,b2] live"]);
		expect(finalAnswerIds(next).size).toBe(0);
		expect(finalAnswerIds(first)).toEqual(new Set(["a1"]));
	});

	it("ends a browsing run at any other tool call, a notice, a card or the person's message", () => {
		const items: TranscriptItem[] = [
			browse("b1", "Reading the page"),
			tool("x1", "bash", "Ran ls"),
			browse("b2", "Clicking on the page"),
			notice("n1", "warning", "Careful."),
			browse("b3", "Clicking on the page"),
			assistant("a1", "Next."),
			tool("x2", "bash", "Ran pwd"),
		];
		expect(shape(groupTranscript(items))).toEqual([
			"browsing b1 [b1]",
			"tools x1 [x1]",
			"browsing b2 [b2]",
			"item n1",
			"browsing b3 [b3]",
			"item a1",
			"tools x2 [x2] live",
		]);
	});

	it("keeps a browsing row, and every row before it, while a step's output changes", () => {
		const asked = user("u1", "Go");
		const items: TranscriptItem[] = [asked, browse("b1", "Reading the page", "running")];
		const first = groupTranscript(items);
		const done = groupTranscript([asked, browse("b1", "Reading the page")], first);
		expect(done[0]).toBe(first[0]);
		expect(done[1]).not.toBe(first[1]);
		expect(groupTranscript([...items], first)).toBe(first);
	});

	it("finds a browser call's turn inside its browsing row", () => {
		const rows = groupTranscript([browse("b1", "Reading"), assistant("a1", "Then."), browse("b2", "Clicking")]);
		expect(rowOfTurn(rows, "call-b2")).toMatchObject({ row: { id: "b1" }, item: { id: "b2" } });
		expect(rowOfTurn(rows, "a1")).toMatchObject({ row: { id: "b1" }, item: { id: "a1" } });
	});
});

describe("messageKeys", () => {
	const sent = (id: string, requestId: string) => ({ ...user(id, "Run the tests."), requestId });

	it("keys a message by its requestId, so the host's copy and the session's are one row", () => {
		const local = messageKeys(groupTranscript([assistant("a0", "Hi."), sent("local:r1", "r1")]));
		const echoed = messageKeys(groupTranscript([assistant("a0", "Hi."), sent("u7", "r1")]));
		expect(local.get("local:r1")).toBe("request:r1");
		expect(echoed.get("u7")).toBe("request:r1");
	});

	it("leaves every other row keyed by its id", () => {
		const keys = messageKeys(
			groupTranscript([user("u1", "Hello."), assistant("a1", "Hi."), tool("t1", "bash", "Ran ls")]),
		);
		expect(keys.size).toBe(0);
	});

	it("keys none of the messages that share a requestId, so no two rows share a key", () => {
		const keys = messageKeys(
			groupTranscript([sent("u1", "r1"), assistant("a1", "Hi."), sent("u2", "r1"), sent("u3", "r1"), sent("u4", "r2")]),
		);
		expect([...keys]).toEqual([["u4", "request:r2"]]);
	});
});

describe("closeRows", () => {
	// The poster turn Tom judged the spacing by: prose, a group of calls, a thought, a call presenting files, the answer.
	const presenting: ToolItem = {
		...tool("x3", "present_files", "Presenting 4 files"),
		files: [{ workspaceId: "ws-1", path: "out/a.png", name: "a.png", mimeType: "image/png", size: 1 }],
	};
	const items: TranscriptItem[] = [
		user("u1", "Make four posters."),
		assistant("a1", "I'll make four."),
		tool("x1", "generate_image", "Generated an image"),
		tool("x2", "generate_image", "Generated an image"),
		assistant("a2", "", { thinking: "Now present them." }),
		presenting,
		assistant("a3", "", { thinking: "Done; say so." }),
		assistant("a4", "Here they are."),
	];

	it("keeps lines of work close, and whatever comes first under the person's message", () => {
		// a1 is under the message; x1's group a block under the prose; the thought and the presenting call close under
		// the lines before them; the thought after the presented files a block under them; the answer a block apart.
		expect([...closeRows(groupTranscript(items))]).toEqual(["a1", "a2", "x3"]);
	});

	it("keeps a card close under a final answer, whose actions row stands between them", () => {
		const rows = groupTranscript([
			user("u1", "Rotate the key."),
			tool("x1", "read", "Read a.md"),
			assistant("a1", "I've asked the vault."),
			notice("n1", "info", "Waiting for approval."),
		]);
		expect([...closeRows(rows, finalAnswerIds(rows))]).toEqual(["x1", "n1"]);
	});

	it("keeps an answer with words a block apart, even after a thought", () => {
		const rows = groupTranscript([tool("x1", "read", "Read a.md"), assistant("a1", "Done.", { thinking: "Hm." })]);
		expect([...closeRows(rows)]).toEqual([]);
	});
});

describe("finalAnswerIds", () => {
	it("picks each turn's last answer, not the words between tool calls", () => {
		const items: TranscriptItem[] = [
			user("u1", "Fix the bug."),
			assistant("a1", "Let me look."),
			tool("x1", "read", "Read a.md"),
			assistant("a2", "Fixed it."),
			notice("n1", "warning", "The last command may have partly run."),
			user("u2", "Thanks. Now the docs."),
			assistant("a3", "Reading them."),
			tool("x2", "read", "Read docs.md"),
		];
		expect([...finalAnswerIds(groupTranscript(items))]).toEqual(["a2"]);
	});

	it("counts a turn with only an answer", () => {
		const items: TranscriptItem[] = [
			user("u1", "Hi."),
			assistant("a1", "Hello."),
			user("u2", "Bye."),
			assistant("a2", "Bye."),
		];
		expect([...finalAnswerIds(groupTranscript(items))].sort()).toEqual(["a1", "a2"]);
	});
});

describe("browserViewSlots", () => {
	const shot = (data: string) => ({ mimeType: "image/png", data }) as const;
	const on = (item: ToolItem, browserSessionId: string, images?: ToolItem["images"]): ToolItem => ({
		...item,
		browserSessionId,
		...(images === undefined ? {} : { images }),
	});

	it("puts each browser's view in the row of its newest call, with the last screenshot any call on it left", () => {
		const first = shot("first");
		const items: TranscriptItem[] = [
			user("u1", "Look it up"),
			tool("x1", "browser_request", "Asking for a browser"),
			on(tool("x2", "browser_open", "Opening example.com"), "bs_1", [first]),
			on(tool("x3", "browser_act", "Reading the page"), "bs_1"),
			user("u2", "Now another."),
			on(tool("x4", "browser_open", "Opening example.org"), "bs_2", [shot("other")]),
		];
		const slots = browserViewSlots(groupTranscript(items));
		expect([...slots.keys()]).toEqual(["x1", "x4"]);
		expect(slots.get("x1")?.map((slot) => [slot.browserSessionId, slot.item.id, slot.screenshot])).toEqual([
			["bs_1", "x3", first],
		]);
		expect(slots.get("x4")?.map((slot) => [slot.browserSessionId, slot.item.id])).toEqual([["bs_2", "x4"]]);
	});

	it("keeps a browser's view in its browsing row as the agent narrates its steps", () => {
		const opened = on(tool("x1", "browser_open", "Opening example.com"), "bs_1", [shot("a")]);
		const before: TranscriptItem[] = [opened, assistant("a1", "Next.")];
		const rowsBefore = groupTranscript(before);
		const first = browserViewSlots(rowsBefore);
		expect(first.get("x1")?.map((slot) => slot.item.id)).toEqual(["x1"]);
		const stepped = on(tool("x2", "browser_act", "Clicking"), "bs_1", [shot("b")]);
		const after = browserViewSlots(groupTranscript([...before, stepped], rowsBefore), first);
		expect([...after.keys()]).toEqual(["x1"]);
		expect(after.get("x1")?.map((slot) => slot.item.id)).toEqual(["x2"]);
	});

	it("moves a browser's view down to the row of its newest call, and keeps unchanged rows' slots", () => {
		const opened = on(tool("x1", "browser_open", "Opening example.com"), "bs_1", [shot("a")]);
		const other = on(tool("x2", "browser_open", "Opening example.org"), "bs_2");
		const before: TranscriptItem[] = [opened, other, user("u1", "Next.")];
		const rowsBefore = groupTranscript(before);
		const first = browserViewSlots(rowsBefore);
		expect(first.get("x1")?.map((slot) => slot.item.id)).toEqual(["x1", "x2"]);

		const stepped = on(tool("x3", "browser_act", "Clicking"), "bs_1", [shot("b")]);
		const after = browserViewSlots(groupTranscript([...before, stepped], rowsBefore), first);
		expect(after.get("x1")?.map((slot) => slot.item.id)).toEqual(["x2"]);
		expect(after.get("x3")?.map((slot) => slot.item.id)).toEqual(["x3"]);

		// Nothing changed: the same slot arrays come back, so their rows don't render again.
		const again = browserViewSlots(groupTranscript([...before, stepped], rowsBefore), after);
		expect(again.get("x1")).toBe(after.get("x1"));
		expect(again.get("x3")).toBe(after.get("x3"));
	});

	it("has no slots for calls that name no browser", () => {
		expect(browserViewSlots(groupTranscript(finishedTurn)).size).toBe(0);
	});
});

describe("browserEntrySlots", () => {
	const shot = (data: string) => ({ mimeType: "image/png", data }) as const;
	const on = (item: ToolItem, browserSessionId: string, images?: ToolItem["images"]): ToolItem => ({
		...item,
		browserSessionId,
		...(images === undefined ? {} : { images }),
	});

	it("gives each browser one card, on the run that opened it, with its newest page from every run", () => {
		const last = shot("iana");
		const items: TranscriptItem[] = [
			user("u1", "Look it up"),
			on(
				tool("x1", "browser_open", "Opening example.com", {
					output: "URL: https://example.com/\nTitle: Example Domain",
				}),
				"bs_1",
				[shot("example")],
			),
			assistant("a1", "Now the next page."),
			on(
				tool("x2", "browser_act", "Going to www.iana.org", {
					output: "URL: https://www.iana.org/help/example-domains\nTitle: Example Domains",
				}),
				"bs_1",
				[last],
			),
			user("u2", "Close it."),
			on(tool("x3", "browser_close", "Closing the browser", { output: "Closed." }), "bs_1"),
		];
		const rows = groupTranscript(items);
		const entries = browserEntrySlots(rows);
		// One card, on the first browsing row; the run that only closed the browser has none.
		const browsing = rows.filter((row) => row.kind === "browsing").map((row) => row.id);
		expect(browsing.length).toBeGreaterThan(1);
		expect([...entries.keys()]).toEqual([browsing[0]]);
		const card = entries.get(browsing[0] as string);
		expect(card?.page).toEqual({ url: "https://www.iana.org/help/example-domains", title: "Example Domains" });
		expect(card?.screenshot).toBe(last);
		expect(card?.closed).toBe(true);
		// Unchanged: the same card comes back, so its row doesn't render again.
		expect(browserEntrySlots(rows, entries).get(browsing[0] as string)).toBe(card);
	});

	it("gives a second browser its own card, on the run that opened it", () => {
		const items: TranscriptItem[] = [
			on(tool("x1", "browser_open", "Opening example.com"), "bs_1"),
			user("u1", "Another."),
			on(tool("x2", "browser_open", "Opening example.org"), "bs_2"),
			on(tool("x3", "browser_act", "Reading"), "bs_1"),
		];
		const entries = browserEntrySlots(groupTranscript(items));
		expect([...entries].map(([row, slot]) => [row, slot.browserSessionId])).toEqual([
			["x1", "bs_1"],
			["x2", "bs_2"],
		]);
	});
});

describe("sessionBrowsers", () => {
	const shot = (data: string) => ({ mimeType: "image/png", data }) as const;
	const on = (item: ToolItem, browserSessionId: string, images?: ToolItem["images"]): ToolItem => ({
		...item,
		browserSessionId,
		...(images === undefined ? {} : { images }),
	});

	it("lists the browsers in order of first use, says which was used last and which call runs now", () => {
		const first = shot("first");
		const running = tool("x5", "browser_act", "Scrolling the page", { status: "running" });
		const items: TranscriptItem[] = [
			on(tool("x1", "browser_open", "Opening example.com"), "bs_1", [first]),
			on(tool("x2", "browser_open", "Opening example.org"), "bs_2"),
			assistant("a1", "Back to the first."),
			on(tool("x3", "browser_act", "Reading the page"), "bs_1"),
			tool("x4", "bash", "Ran ls"),
			running,
		];
		const browsers = sessionBrowsers(items);
		expect(browsers.browsers.map((slot) => [slot.browserSessionId, slot.item.id, slot.screenshot])).toEqual([
			["bs_1", "x3", first],
			["bs_2", "x2", undefined],
		]);
		expect(browsers.latest).toBe("bs_1");
		expect(browsers.running).toBe(running);
		// Nothing about the browsers changed (an answer streaming after them): the same object comes back.
		expect(sessionBrowsers([...items, assistant("a2", "Still going")], browsers)).toBe(browsers);
		expect(sessionBrowsers([user("u1", "Hi")]).browsers).toEqual([]);
	});
});

describe("turn links", () => {
	const sent = { ...user("u1", "Go"), requestId: "req-1" };
	const items: TranscriptItem[] = [
		sent,
		tool("t1", "read", "Read a.md"),
		tool("t2", "bash", "Ran ls"),
		assistant("a1", "Done."),
	];

	it("names an item by its ID, a tool call by its call ID and a message by its request ID", () => {
		expect(isTurn(sent, "u1")).toBe(true);
		expect(isTurn(sent, "req-1")).toBe(true);
		expect(findTurn(items, "call-t2")?.id).toBe("t2");
		expect(findTurn(items, "a1")?.id).toBe("a1");
		expect(findTurn(items, "")).toBeUndefined();
		expect(findTurn(items, "nope")).toBeUndefined();
	});

	it("finds the row a turn is in, and the tool call within its group", () => {
		const rows = groupTranscript(items);
		expect(rowOfTurn(rows, "req-1")?.row.id).toBe("u1");
		const call = rowOfTurn(rows, "call-t2");
		expect(call?.row.kind).toBe("tools");
		expect(call?.row.id).toBe("t1");
		expect(call?.item.id).toBe("t2");
		expect(rowOfTurn(rows, "nope")).toBeUndefined();
		expect(turnAnchor("u:1")).toBe("turn-u:1");
	});
});

describe("workingPlacement", () => {
	const place = (items: TranscriptItem[]) => workingPlacement(groupTranscript(items));

	it("puts the header under the person's message and Thinking at the end, before anything arrives", () => {
		expect(place([assistant("a0", "Earlier."), user("u1", "Go")])).toEqual({ headerAfter: 1, activity: true });
	});

	it("leaves the activity to a call that is running, and to an answer that streams", () => {
		const running = [user("u1", "Go"), tool("t1", "bash", "Running ls", { status: "running" })];
		expect(place(running)).toEqual({ headerAfter: 0, activity: false });
		expect(place([user("u1", "Go"), assistant("a1", "", { streaming: true })])).toEqual({
			headerAfter: 0,
			activity: false,
		});
		expect(place(liveTurn).activity).toBe(false);
	});

	it("shows Thinking between steps: every call finished, nothing streaming", () => {
		const between = [user("u1", "Go"), tool("t1", "bash", "Ran ls"), tool("t2", "read", "Read a.md")];
		expect(place(between)).toEqual({ headerAfter: 0, activity: true });
		expect(place([user("u1", "Go"), assistant("a1", "Looking."), tool("t1", "bash", "Ran ls")]).activity).toBe(true);
	});

	it("leaves the activity to a browsing run under way, between its steps too", () => {
		const opened = tool("b1", "browser_open", "Opening example.com");
		const said = assistant("a1", "Now scrolling.");
		const scrolling = tool("b2", "browser_act", "Scrolling the page", { status: "running" });
		expect(place([user("u1", "Go"), opened, said, scrolling])).toEqual({ headerAfter: 0, activity: false });
		const scrolled = tool("b2", "browser_act", "Scrolled the page");
		expect(place([user("u1", "Go"), opened, said, scrolled])).toEqual({ headerAfter: 0, activity: false });
		// The agent's words after the run's last call: the run may still go on.
		expect(place([user("u1", "Go"), opened, said, scrolled, assistant("a2", "Next, Dronfield.")]).activity).toBe(false);
		// Another kind of call after it: the run is over, and Thinking is back between steps.
		expect(place([user("u1", "Go"), opened, scrolled, tool("t1", "bash", "Ran ls")]).activity).toBe(true);
	});
});

describe("activeBrowsingRow", () => {
	const active = (items: TranscriptItem[]) => activeBrowsingRow(groupTranscript(items));
	const opened = tool("b1", "browser_open", "Opened example.com");
	const scrolled = tool("b2", "browser_act", "Scrolled the page");

	it("is the last browsing row while only the agent's words follow it", () => {
		expect(active([user("u1", "Go"), opened, scrolled])).toBe("b1");
		expect(active([user("u1", "Go"), opened, scrolled, assistant("a1", "Now Dronfield.")])).toBe("b1");
	});

	it("is none once anything else follows the run", () => {
		expect(active([user("u1", "Go"), opened, tool("t1", "bash", "Ran ls")])).toBeUndefined();
		expect(active([opened, scrolled, assistant("a1", "Done."), user("u2", "Close it")])).toBeUndefined();
		expect(active([user("u1", "Go"), assistant("a1", "Hello.")])).toBeUndefined();
	});
});

describe("workingPlacement, the header", () => {
	const place = (items: TranscriptItem[]) => workingPlacement(groupTranscript(items));

	it("keeps the header under the message that started the turn when the person steers it", () => {
		const steer: TranscriptItem = { ...user("u2", "Also check b"), via: "steer" };
		expect(place([user("u1", "Go"), tool("t1", "bash", "Ran ls"), steer]).headerAfter).toBe(0);
	});

	it("has no place for the header when the turn's message is in an older page", () => {
		expect(place([tool("t1", "bash", "Ran ls")])).toEqual({ headerAfter: -1, activity: true });
	});
});

describe("turnFolds", () => {
	const folds = (items: readonly TranscriptItem[], working = false) => {
		const rows = groupTranscript(items);
		const found = turnFolds(rows, working);
		return [...new Set(found.values())].map((fold) => ({ ...fold, rows: [...fold.rows] }));
	};

	it("folds a finished turn's work, and the words before its answer, under one line", () => {
		const items: TranscriptItem[] = [
			user("u1", "Draw a lighthouse.", 100),
			assistant("a1", "Making it.", { secondsAgo: 95 }),
			tool("t1", "generate_image", "Making an image", { secondsAgo: 90 }),
			assistant("a2", "Checking it.", { secondsAgo: 60 }),
			tool("t2", "present_files", "Presenting lighthouse.png", { secondsAgo: 50 }),
			assistant("a3", "Here it is.", { secondsAgo: 28 }),
		];
		expect(folds(items)).toEqual([{ id: "a1", rows: ["a1", "t1", "a2", "t2"], elapsed: 72_000, steps: 2 }]);
	});

	it("leaves the person's message, the answer, notices and cards out", () => {
		const items: TranscriptItem[] = [
			user("u1", "Fix it.", 100),
			tool("t1", "read", "Read a.md", { secondsAgo: 90 }),
			notice("n1", "warning", "The last command may have partly run."),
			tool("t2", "edit", "Edited a.md", { secondsAgo: 80 }),
			assistant("a1", "Fixed.", { secondsAgo: 70 }),
		];
		const [fold] = folds(items);
		expect(fold?.rows).toEqual(["t1", "t2"]);
	});

	it("doesn't fold the turn under way, or a finished turn with no answer", () => {
		expect(folds(liveTurn, true)).toEqual([]);
		const stopped: TranscriptItem[] = [
			user("u1", "Fix it.", 100),
			tool("t1", "read", "Read a.md", { secondsAgo: 90 }),
			tool("t2", "bash", "Ran pnpm test", { status: "interrupted", secondsAgo: 80 }),
		];
		expect(folds(stopped)).toEqual([]);
	});

	it("folds earlier turns while the last one works", () => {
		const found = folds([...finishedTurn, ...liveTurn], true);
		expect(found.map((fold) => fold.rows)).toEqual([["t1"]]);
	});

	it("doesn't fold a turn whose answer is the only thing in it", () => {
		expect(folds([user("u1", "Hi."), assistant("a1", "Hello.")])).toEqual([]);
	});

	it("keeps a steer in its turn, and out of the fold", () => {
		const items: TranscriptItem[] = [
			user("u1", "Fix it.", 100),
			tool("t1", "read", "Read a.md", { secondsAgo: 90 }),
			{ ...user("u2", "Use the new API.", 85), via: "steer" },
			tool("t2", "edit", "Edited a.md", { secondsAgo: 80 }),
			assistant("a1", "Fixed.", { secondsAgo: 70 }),
		];
		expect(folds(items).map((fold) => fold.rows)).toEqual([["t1", "t2"]]);
	});

	it("keeps each unchanged fold's identity", () => {
		const rows = groupTranscript(finishedTurn);
		const first = turnFolds(rows, false);
		const again = turnFolds(groupTranscript(finishedTurn, rows), false, first);
		expect(again.get("t1")).toBe(first.get("t1"));
	});
});

describe("repeatedImageFiles", () => {
	const file = { workspaceId: "ws", path: "images/a.png", name: "a.png", mimeType: "image/png", size: 1 };
	it("names the files a later call presents again that generate_image showed", () => {
		const made: ToolItem = { ...tool("t1", "generate_image", "Making an image"), files: [{ ...file, model: "m" }] };
		const presented: ToolItem = {
			...tool("t2", "present_files", "Presenting a.png"),
			files: [file, { ...file, path: "out/b.md", name: "b.md" }],
		};
		const rows = groupTranscript([user("u1", "Go"), made, assistant("a1", "Here."), presented]);
		expect([...repeatedImageFiles(rows)]).toEqual([["t2", "ws:images/a.png"]]);
	});
});
