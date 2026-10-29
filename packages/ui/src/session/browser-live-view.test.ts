import type { ToolItem } from "@harbour/protocol";
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
		expect(text(html)).toBe("Live Watch only Open in a new tab");
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
		expect(text(html)).toBe("Replay Watch only");
	});

	it("holds a replay's page behind Play over the last screenshot, so no recording is read until asked", () => {
		const html = render({ source: { kind: "embed", mode: "replay", url: "/browser/b1#token" }, screenshot: shot });
		expect(html).not.toContain("<iframe");
		expect(html).toContain("data:image/png;base64,AAAA");
		expect(text(html)).toBe("Replay Watch only Open in a new tab Play");
		expect(html).toContain("hb-browser-live-frame-replay");
	});

	it("embeds a link on this page's own origin, as Harbour's view links are", () => {
		expect(embeddable("/browser/b1#token")).toBe(true);
		expect(render({ source: { kind: "embed", url: "/browser/b1#token" } })).toContain('src="/browser/b1#token"');
	});

	it("shows the last screenshot while connecting and once the browser has closed", () => {
		expect(text(render({ status: "connecting", screenshot: shot }))).toBe("Connecting to the live view");
		expect(render({ status: "connecting", screenshot: shot })).toContain('aria-busy="true"');
		expect(text(render({ status: "ended" }))).toBe("The browser has closed.");
		expect(text(render({ status: "ended", screenshot: shot }))).toContain("This is the last page it showed.");
		expect(render({ status: "unavailable" })).toBe("");
	});
});
