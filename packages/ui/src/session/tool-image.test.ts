import type { SyntheticEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { retryToolImage, toolImageSrc } from "./tool-call.tsx";

/** An `<img>` as `retryToolImage` sees it, in the frame a tool image sits in. */
function image(src: string) {
	const frame = { hidden: false };
	const img = {
		src,
		hidden: false,
		isConnected: true,
		dataset: {} as Record<string, string>,
		closest: (selector: string) => (selector.includes(".hb-tool-image") ? frame : null),
	};
	const fail = () => retryToolImage({ currentTarget: img } as unknown as SyntheticEvent<HTMLImageElement>);
	return { img, frame, fail };
}

afterEach(() => vi.useRealTimers());

describe("tool images by reference", () => {
	it("shows an inline image as a data URL and a referenced one at its URL", () => {
		expect(toolImageSrc({ mimeType: "image/png", data: "AAAA" })).toBe("data:image/png;base64,AAAA");
		expect(toolImageSrc({ mimeType: "image/jpeg", url: "/v1/attachments/a?projectId=p" })).toBe(
			"/v1/attachments/a?projectId=p",
		);
	});

	it("asks again for a referenced image that isn't stored yet, a little later each time", () => {
		vi.useFakeTimers();
		const { img, fail } = image("https://harbour.test/v1/attachments/a?projectId=p");
		fail();
		expect(img.src).toBe("https://harbour.test/v1/attachments/a?projectId=p");
		vi.advanceTimersByTime(600);
		expect(img.src).toBe("https://harbour.test/v1/attachments/a?projectId=p&try=1");
		fail();
		vi.advanceTimersByTime(1200);
		expect(img.src).toBe("https://harbour.test/v1/attachments/a?projectId=p&try=2");
	});

	it("hides one that never comes, with its frame, rather than leave a broken image", () => {
		vi.useFakeTimers();
		const { img, frame, fail } = image("https://harbour.test/v1/attachments/a?projectId=p");
		for (let i = 0; i < 8; i += 1) {
			fail();
			vi.runAllTimers();
		}
		expect(frame.hidden).toBe(false);
		fail();
		expect(frame.hidden).toBe(true);
		expect(img.hidden).toBe(false);
	});

	it("never asks again for an inline image", () => {
		vi.useFakeTimers();
		const { img, frame, fail } = image("data:image/png;base64,AAAA");
		fail();
		vi.runAllTimers();
		expect(img.src).toBe("data:image/png;base64,AAAA");
		expect(frame.hidden).toBe(false);
	});
});
