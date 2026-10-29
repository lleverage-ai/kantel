import { describe, expect, it, vi } from "vitest";
import type { BrowserLiveLink } from "../api/client.ts";
import { createBrowserLiveStore, statusOfFailure } from "./browser-live.ts";

const failure = (code: string) => Object.assign(new Error(code), { code });

/** A load whose answers the test gives, one per call, in order. */
function scripted() {
	const answers: { resolve: (link: BrowserLiveLink) => void; reject: (reason: unknown) => void }[] = [];
	const load = vi.fn(
		(_id: string, _signal: AbortSignal) =>
			new Promise<BrowserLiveLink>((resolve, reject) => {
				answers.push({ resolve, reject });
			}),
	);
	return { load, answers };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the session screen's live-view links", () => {
	it("asks once per browser, and goes live with the link", async () => {
		const { load, answers } = scripted();
		const store = createBrowserLiveStore(load);
		const seen = vi.fn();
		store.subscribe("bs_1", seen);

		expect(store.get("bs_1")).toEqual({ status: "connecting" });
		expect(store.get("bs_1")).toBe(store.get("bs_1"));
		expect(load).toHaveBeenCalledTimes(1);

		answers[0]?.resolve({ url: "https://brwsr.dev/s/one", expiresAt: 1 });
		await settle();
		expect(store.get("bs_1")).toEqual({ status: "live", url: "https://brwsr.dev/s/one" });
		expect(seen).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("shows a closed or forgotten browser as ended, and no link at all as unavailable", () => {
		expect(statusOfFailure(failure("expired")).status).toBe("ended");
		expect(statusOfFailure(failure("not_found")).status).toBe("ended");
		expect(statusOfFailure(failure("forbidden")).status).toBe("unavailable");
		expect(statusOfFailure(failure("unavailable")).status).toBe("unavailable");
		expect(statusOfFailure(new Error("boom")).status).toBe("unavailable");
	});

	it("asks again when the frame says the browser has gone: a new link goes live, the same one has ended", async () => {
		const { load, answers } = scripted();
		const store = createBrowserLiveStore(load);
		store.get("bs_1");
		answers[0]?.resolve({ url: "https://brwsr.dev/s/one" });
		await settle();

		// The link ran out while the browser was still open: a new one.
		store.disconnected("bs_1");
		expect(store.get("bs_1").status).toBe("connecting");
		answers[1]?.resolve({ url: "https://brwsr.dev/s/two" });
		await settle();
		expect(store.get("bs_1")).toEqual({ status: "live", url: "https://brwsr.dev/s/two" });

		// The browser closed, but Harbour hasn't noticed: the same link, so the view settles on ended.
		store.disconnected("bs_1");
		answers[2]?.resolve({ url: "https://brwsr.dev/s/two" });
		await settle();
		expect(store.get("bs_1").status).toBe("ended");

		// Ended is final: another message from the frame asks nothing.
		store.disconnected("bs_1");
		expect(load).toHaveBeenCalledTimes(3);
	});

	it("settles on ended when Harbour says the browser has closed", async () => {
		const { load, answers } = scripted();
		const store = createBrowserLiveStore(load);
		store.get("bs_1");
		answers[0]?.reject(failure("expired"));
		await settle();
		expect(store.get("bs_1").status).toBe("ended");
	});

	it("stops asking once the screen is gone", async () => {
		const { load, answers } = scripted();
		const store = createBrowserLiveStore(load);
		const seen = vi.fn();
		store.subscribe("bs_1", seen);
		store.get("bs_1");
		const signal = load.mock.calls[0]?.[1];
		store.dispose();
		expect(signal?.aborted).toBe(true);
		answers[0]?.resolve({ url: "https://brwsr.dev/s/one" });
		await settle();
		expect(seen).not.toHaveBeenCalled();
		store.get("bs_2");
		expect(load).toHaveBeenCalledTimes(1);
	});
});
