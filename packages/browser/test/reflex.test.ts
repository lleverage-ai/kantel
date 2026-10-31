// Reflex's verb mode (images/browser/agent/reflex.mjs) against a fake CDP page: the parts Harbour changed.

import { describe, expect, it } from "vitest";
import { ReflexError, reflexAct } from "../../../images/browser/agent/reflex.mjs";

interface FakeElement {
	readonly id: string;
	readonly role: string;
	readonly name: string;
	readonly tag: string;
}

/** A browser with one page holding `elements`. It records what Reflex evaluates and dispatches. */
function fakePage(elements: readonly FakeElement[]) {
	const evaluated: string[] = [];
	const dispatched: string[] = [];
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
		async send(method: string, params?: unknown): Promise<unknown> {
			switch (method) {
				case "Target.getTargets":
					return { targetInfos: [{ type: "page", targetId: "page-1", url: "https://example.com/" }] };
				case "Target.attachToTarget":
					return { sessionId: "cdp-session-1" };
				case "Runtime.evaluate": {
					const expression = String((params as { expression: string }).expression);
					evaluated.push(expression);
					if (expression.includes("__reflexDoc")) return { result: { value: snapshot() } };
					if (expression === "document.readyState") return { result: { value: "complete" } };
					if (expression.includes("elementFromPoint")) return { result: { value: { x: 10, y: 10, hits: true } } };
					return { result: { value: [] } };
				}
				case "Input.dispatchMouseEvent":
					dispatched.push((params as { type: string }).type);
					return {};
				default:
					return {};
			}
		},
	};
	return { cdp, evaluated, dispatched };
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
