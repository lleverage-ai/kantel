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
 * `busy` is set the page's main thread is taken, as Kayak's is while its results load: no evaluation (nor
 * `Runtime.enable`, nor `Page.enable`) ever answers, but the browser still knows the page's URL and title.
 */
function fakePage(elements: readonly FakeElement[], targetId = "page-1", options: FakeOptions = {}) {
	const evaluated: string[] = [];
	const dispatched: string[] = [];
	const state = { busy: false, cookieDialog: options.cookieDialog === true, mouseDown: false };
	const slider = options.slider;
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
				case "Page.enable":
				case "Runtime.enable":
					return state.busy ? new Promise(() => {}) : Promise.resolve({});
				case "Runtime.evaluate": {
					const expression = String((params as { expression: string }).expression);
					evaluated.push(expression);
					if (state.busy) return new Promise(() => {});
					if (expression.includes("function declineConsentPage")) {
						const declined = state.cookieDialog ? "Reject all" : null;
						state.cookieDialog = false;
						return Promise.resolve({ result: { value: declined } });
					}
					if (expression.includes("function readSlider") && slider !== undefined) {
						return Promise.resolve({ result: { value: slider.read() } });
					}
					if (expression.includes("__reflexDoc")) return Promise.resolve({ result: { value: snapshot() } });
					if (expression === "document.readyState") return Promise.resolve({ result: { value: "complete" } });
					if (expression.includes("elementFromPoint")) {
						return Promise.resolve({ result: { value: { x: 10, y: 10, hits: true } } });
					}
					return Promise.resolve({ result: { value: [] } });
				}
				case "Input.dispatchMouseEvent": {
					const event = params as { type: string; x: number };
					dispatched.push(event.type);
					if (event.type === "mousePressed") state.mouseDown = true;
					if (state.mouseDown && slider !== undefined) slider.moveTo(event.x);
					if (event.type === "mouseReleased") state.mouseDown = false;
					return Promise.resolve({});
				}
				default:
					return Promise.resolve({});
			}
		},
	};
	return { cdp, evaluated, dispatched, state };
}

interface FakeOptions {
	/** A cookie dialog the page shows until it is declined. */
	readonly cookieDialog?: boolean;
	/** A role=slider thumb the page moves with the mouse. */
	readonly slider?: FakeSlider;
}

/**
 * Kayak's take-off slider, as its page has it: a thumb on a 200 px rail from x = 100, whose `aria-valuenow` is a
 * timestamp (05:00 to 23:59 as milliseconds) and whose `aria-valuetext` reads "Wed 09:00 - Thu 00:00". A drag snaps it
 * to whole minutes.
 */
function kayakSlider() {
	const min = 5 * 3_600_000;
	const max = (23 * 60 + 59) * 60_000;
	let now = min;
	const left = 100;
	const width = 200;
	const clock = (ms: number) => {
		const minutes = Math.round(ms / 60_000);
		return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
	};
	return {
		value: () => clock(now),
		read: () => ({
			native: false,
			min,
			max,
			now,
			text: `Wed ${clock(now)} - Thu 00:00`,
			vertical: false,
			x: left + ((now - min) / (max - min)) * width,
			y: 400,
			track: { left, top: 395, width, height: 10 },
		}),
		moveTo(x: number) {
			const f = Math.min(1, Math.max(0, (x - left) / width));
			now = Math.round((min + f * (max - min)) / 60_000) * 60_000;
		},
	};
}
type FakeSlider = ReturnType<typeof kayakSlider>;

const REJECT: FakeElement = { id: "4", role: "button", name: "Reject all", tag: "button" };
const TAKE_OFF: FakeElement = { id: "61", role: "slider", name: "Take-off 1", tag: "span" };

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

	it("moves a slider to the time it is asked for, by dragging its thumb", async () => {
		const slider = kayakSlider();
		const { cdp } = fakePage([TAKE_OFF], "slide-time", { slider });
		const reply = await reflexAct(cdp, { verb: "slide", element: "[61]", value: "09:00" });
		expect(reply.success).toBe(true);
		expect(slider.value()).toBe("09:00");
		expect(reply.did).toContain("now at \u201CWed 09:00 - Thu 00:00\u201D");
	});

	it("moves a slider to a percentage of its range", async () => {
		const slider = kayakSlider();
		const { cdp } = fakePage([TAKE_OFF], "slide-percent", { slider });
		const reply = await reflexAct(cdp, { verb: "slide", element: "61", value: "50%" });
		expect(reply.success).toBe(true);
		expect(slider.value()).toBe("14:30");
	});

	it("says a slider value it can't place, with the page, instead of failing", async () => {
		const slider = kayakSlider();
		const { cdp } = fakePage([TAKE_OFF], "slide-unknown", { slider });
		const reply = await reflexAct(cdp, { verb: "slide", element: "61", value: "early" });
		expect(reply.success).toBe(false);
		expect(reply.did).toContain("slide not done: can't tell where \u201Cearly\u201D is");
		expect(reply.page.url).toBe("https://example.com/");
	});

	it("declines a cookie dialog after a step when asked to, and says so on the page", async () => {
		const { cdp, evaluated } = fakePage([REJECT], "consent-step", { cookieDialog: true });
		const reply = await reflexAct(cdp, { verb: "goto", url: "https://example.com/", consent: "reject" });
		expect(reply.page.declined).toBe("Reject all");
		expect(reply.page.text).toMatch(/^Declined a cookie dialog \(\u201CReject all\u201D\)/);
		const again = await reflexLook(cdp, { consent: "reject" });
		expect(again.declined).toBeUndefined();
		expect(evaluated.filter((expression) => expression.includes("function declineConsentPage"))).toHaveLength(2);
	});

	it("leaves a cookie dialog alone without consent: reject", async () => {
		const { cdp, evaluated } = fakePage([REJECT], "consent-off", { cookieDialog: true });
		const look = await reflexLook(cdp, {});
		expect(look.declined).toBeUndefined();
		expect(evaluated.some((expression) => expression.includes("function declineConsentPage"))).toBe(false);
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

	it("answers a look within 8 s all told with the last look's elements, not an error", async () => {
		const { cdp, state } = fakePage([REJECT], "busy-look");
		await reflexLook(cdp, {});
		vi.useFakeTimers();
		state.busy = true;
		let answered = false;
		const look = reflexLook(cdp, {}).finally(() => {
			answered = true;
		});
		await vi.advanceTimersByTimeAsync(7_900);
		expect(answered).toBe(false);
		await vi.advanceTimersByTimeAsync(100);
		expect(answered).toBe(true);
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
