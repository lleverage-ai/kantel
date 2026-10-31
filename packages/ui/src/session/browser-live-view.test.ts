import type { ToolItem } from "@kantel/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type BrowserLiveSource, BrowserLiveView, embeddable } from "./browser-live-view.tsx";
import { tool } from "./fixtures.ts";

const item: ToolItem = { ...tool("t1", "browser_act", "Reading the page"), browserSessionId: "bs_1" };
const shot = { mimeType: "image/png", data: "AAAA" } as const;
const text = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
const render = (props: Partial<Parameters<typeof BrowserLiveView>[0]>) =>
	renderToStaticMarkup(createElement(BrowserLiveView, { status: "live", item, ...props }));

describe("the browser's live view", () => {
	it("embeds an embed source's page, sandboxed and watch-only, as given", () => {
		const html = render({ source: { kind: "embed", url: "https://live.example/s/abc?navbar=false" } });
		expect(html).toContain('src="https://live.example/s/abc?navbar=false"');
		expect(html).toContain('sandbox="allow-scripts allow-same-origin"');
		expect(html).toContain('referrerPolicy="no-referrer"');
		// The embedded page draws its own address bar: the window has only its tab and status.
		expect(text(html)).toBe("New tab Live Watch only Open in a new tab");
		expect(html).not.toContain("kt-browser-address");
	});

	it("draws the browser in a window: its page's tab and address, or the host's tabs", () => {
		const page = { url: "https://www.kayak.co.uk/flights", title: "Flights" };
		const html = render({ status: "connecting", page });
		expect(html).toContain('role="tablist"');
		expect(text(html)).toContain("Flights");
		expect(text(html)).toContain("www.kayak.co.uk /flights");
		const hosted = render({ status: "ended", page, tabs: (end) => createElement("nav", { id: "host-tabs" }, end) });
		expect(hosted).toContain('id="host-tabs"');
		expect(hosted).not.toContain('role="tablist"');
		expect(text(hosted)).toContain("Closed");
	});

	it("never embeds a page that isn't one, and shows the screenshot instead", () => {
		expect(embeddable("javascript:alert(1)")).toBe(false);
		const html = render({ source: { kind: "embed", url: "javascript:alert(1)" }, screenshot: shot });
		expect(html).not.toContain("<iframe");
		expect(html).not.toContain("javascript:");
		expect(html).toContain("data:image/png;base64,AAAA");
	});

	it("draws a frames source's picture, starting from the last screenshot, and says a replay is one", () => {
		const replay: BrowserLiveSource = { kind: "frames", mode: "replay", subscribe: () => () => {} };
		const html = render({ source: replay, screenshot: shot });
		expect(html).not.toContain("<iframe");
		expect(html).toContain('alt="Replay of the browser: Reading the page"');
		expect(html).toContain("data:image/png;base64,AAAA");
		expect(text(html)).toBe("New tab Replay Watch only Address: The address isn't known yet");
	});

	it("holds a replay's page behind Play over the last screenshot, so no recording is read until asked", () => {
		const html = render({ source: { kind: "embed", mode: "replay", url: "/browser/b1#token" }, screenshot: shot });
		expect(html).not.toContain("<iframe");
		expect(html).toContain("data:image/png;base64,AAAA");
		expect(text(html)).toBe(
			"New tab Replay Watch only Open in a new tab Address: The address isn't known yet Play the replay",
		);
		expect(html).toContain("kt-browser-live-poster");
	});

	it("embeds a link on this page's own origin, as Kantel's view links are", () => {
		expect(embeddable("/browser/b1#token")).toBe(true);
		expect(render({ source: { kind: "embed", url: "/browser/b1#token" } })).toContain('src="/browser/b1#token"');
	});

	it("shows the last screenshot while connecting and once the browser has closed", () => {
		expect(text(render({ status: "connecting", screenshot: shot }))).toBe(
			"New tab Connecting to the live view Address: The address isn't known yet",
		);
		expect(render({ status: "connecting", screenshot: shot })).toContain('aria-busy="true"');
		expect(text(render({ status: "ended" }))).toBe(
			"New tab Closed Address: The address isn't known yet The browser has closed.",
		);
		expect(text(render({ status: "ended", screenshot: shot }))).toContain("This is the last page it showed.");
		expect(render({ status: "unavailable" })).toBe("");
	});
});
