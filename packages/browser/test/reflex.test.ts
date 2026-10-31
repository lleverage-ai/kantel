// Reflex's verb mode (images/browser/agent/reflex.mjs) against a fake CDP page: the parts Harbour changed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ReflexError, reflexAct, reflexLook } from "../../../images/browser/agent/reflex.mjs";

interface FakeElement {
	readonly id: string;
	readonly role: string;
	readonly name: string;
	readonly tag: string;
}

/**
 * A browser with one page (`targetId`) holding `elements`. It records what Reflex evaluates and dispatches. While
 * `busy` is set the page's main thread is taken, as Kayak's is while its results load: no evaluation ever answers,
 * but the browser still knows the page's URL and title.
 */
function fakePage(elements: readonly FakeElement[], targetId = "page-1") {
	const evaluated: string[] = [];
	const dispatched: string[] = [];
	const state = { busy: false };
	const snapshot = () => ({
		doc: "doc1",
		url: "https://example.com/",
		title: "Example",
		headings: [],
		text: "An example page",
		messages: [],
		elements: elements.map((element) => ({ ...element, inView: true })),
		scroll: { y: 0, max: 0 },
		sig: "sig",
	});
	const cdp = {
		send(method: string, params?: unknown): Promise<unknown> {
			switch (method) {
				case "Target.getTargets":
					return Promise.resolve({ targetInfos: [{ type: "page", targetId, url: "https://example.com/" }] });
				case "Target.getTargetInfo":
					return Promise.resolve({ targetInfo: { targetId, url: "https://example.com/", title: "Example (busy)" } });
				case "Target.attachToTarget":
					return Promise.resolve({ sessionId: "cdp-session-1" });
				case "Runtime.evaluate": {
					const expression = String((params as { expression: string }).expression);
					evaluated.push(expression);
					if (state.busy) return new Promise(() => {});
					if (expression.includes("__reflexDoc")) return Promise.resolve({ result: { value: snapshot() } });
					if (expression === "document.readyState") return Promise.resolve({ result: { value: "complete" } });
					if (expression.includes("elementFromPoint")) {
						return Promise.resolve({ result: { value: { x: 10, y: 10, hits: true } } });
					}
					return Promise.resolve({ result: { value: [] } });
				}
				case "Input.dispatchMouseEvent":
					dispatched.push((params as { type: string }).type);
					return Promise.resolve({});
				default:
					return Promise.resolve({});
			}
		},
	};
	return { cdp, evaluated, dispatched, state };
}

const REJECT: FakeElement = { id: "4", role: "button", name: "Reject all", tag: "button" };

describe("reflexAct", () => {
	it("takes element 4 as the listing shows it, as #4 or as 4", async () => {
		for (const element of ["[4]", "#4", "4", " [ 4 ] "]) {
			const { cdp, evaluated, dispatched } = fakePage([REJECT]);
			const reply = await reflexAct(cdp, { verb: "click", element });
			expect(reply.success, element).toBe(true);
			expect(reply.did, element).toContain("Reject all");
			expect(dispatched, element).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
			expect(
				evaluated.some((expression) => expression.endsWith('("4")')),
				element,
			).toBe(true);
		}
	});

	it("still says an element that isn't on the page is gone", async () => {
		const { cdp } = fakePage([REJECT]);
		const missing = reflexAct(cdp, { verb: "click", element: "[5]" });
		await expect(missing).rejects.toBeInstanceOf(ReflexError);
		await expect(missing).rejects.toThrow("No element 5");
	});
});

describe("a busy page", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("answers a look within 8 s with the last look's elements, not an error", async () => {
		const { cdp, state } = fakePage([REJECT], "busy-look");
		await reflexLook(cdp, {});
		vi.useFakeTimers();
		state.busy = true;
		const look = reflexLook(cdp, {});
		await vi.advanceTimersByTimeAsync(8_000);
		const page = await look;
		expect(page).toMatchObject({ busy: true, url: "https://example.com/", title: "Example (busy)" });
		expect(page.text).toContain("Page still busy");
		expect(page.text).toContain("An example page");
		expect(page.elements.map((element) => element.id)).toEqual(["4"]);
	});

	it("says nothing is known yet of a busy page it has never read", async () => {
		const { cdp, state } = fakePage([REJECT], "busy-unread");
		vi.useFakeTimers();
		state.busy = true;
		const look = reflexLook(cdp, {});
		await vi.advanceTimersByTimeAsync(8_000);
		const page = await look;
		expect(page.text).toContain("Nothing from it is known yet");
		expect(page.elements).toEqual([]);
	});

	it("gives up a step on a busy page with a page, not a hang", async () => {
		const { cdp, state } = fakePage([REJECT], "busy-act");
		await reflexLook(cdp, {});
		vi.useFakeTimers();
		state.busy = true;
		const step = reflexAct(cdp, { verb: "click", element: "[4]" });
		await vi.advanceTimersByTimeAsync(20_000);
		const reply = await step;
		expect(reply.success).toBe(false);
		expect(reply.did).toContain("click not done: the page is still busy");
		expect(reply.page.elements.map((element) => element.id)).toEqual(["4"]);
	});

	it("bounds a wait step on a busy page well inside the coordinator's 60 s", async () => {
		const { cdp, state } = fakePage([REJECT], "busy-wait");
		vi.useFakeTimers();
		state.busy = true;
		let settled = false;
		const step = reflexAct(cdp, { verb: "wait" }).finally(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(30_000);
		expect(settled).toBe(true);
		const reply = await step;
		expect(reply.page.text).toContain("Page still busy");
	});
});
