import type { ToolItem } from "@harbour/protocol";
import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserEntry } from "./browser-entry.tsx";
import {
	addressParts,
	BrowserAddressBar,
	BrowserTabs,
	PlayerControls,
	pageHost,
	pageLabel,
	playerClock,
} from "./browser-window.tsx";
import { browsingPage } from "./browsing-group.tsx";
import { tool } from "./fixtures.ts";
import { browserPageOf, sessionBrowsers } from "./transcript-model.ts";

const text = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
const html = <P extends object>(type: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(type, props));

describe("a browser window's pieces", () => {
	it("names a page by its title, else its host without www., else New tab", () => {
		expect(pageLabel({ url: "https://www.kayak.co.uk/flights", title: " Flights " })).toBe("Flights");
		expect(pageLabel({ url: "https://www.kayak.co.uk/flights" })).toBe("kayak.co.uk");
		expect(pageLabel({ url: "about:blank" })).toBe("New tab");
		expect(pageLabel({})).toBe("New tab");
		expect(pageLabel({ url: "chrome://settings" })).toBe("chrome://settings");
		expect(pageHost("not a url")).toBeUndefined();
	});

	it("splits an address into its host and the rest, and says when it is https", () => {
		expect(addressParts("https://example.com/a/b?c=1#d")).toEqual({
			secure: true,
			host: "example.com",
			rest: "/a/b?c=1#d",
		});
		expect(addressParts("http://localhost:8787/")).toEqual({ secure: false, host: "localhost:8787", rest: "" });
		expect(addressParts("about:blank")).toEqual({ secure: false, host: "", rest: "about:blank" });
		expect(addressParts(undefined)).toBeUndefined();
	});

	it("draws the address read-only, with the placeholder while there is none", () => {
		const bar = html(BrowserAddressBar, { url: "https://example.com/page" });
		expect(text(bar)).toBe("Address: Secure connection example.com /page");
		expect(bar).toContain('title="https://example.com/page"');
		expect(bar).not.toContain("<input");
		expect(text(html(BrowserAddressBar, { placeholder: "No page yet" }))).toBe("Address: No page yet");
	});

	it("draws each tab with its page's name, the one on show selected", () => {
		const tabs = html(BrowserTabs, {
			tabs: [
				{ id: "a", url: "https://example.com/", title: "Example Domain" },
				{ id: "b", url: "https://www.iana.org/domains" },
			],
			active: "b",
		});
		expect(text(tabs)).toBe("E Example Domain I iana.org");
		expect(tabs.match(/aria-selected="true"/g)).toHaveLength(1);
		expect(tabs).toMatch(/aria-selected="true"[^>]*data-tab="b"|data-tab="b"[^>]*aria-selected="true"/);
	});

	it("gives a replay Harbour's own controls: a play button, a scrubber and the time", () => {
		const controls = html(PlayerControls, {
			playing: false,
			position: 65_000,
			duration: 78_000,
			onToggle: () => {},
			onSeek: () => {},
			speed: 2,
			onSpeed: () => {},
		});
		expect(controls).toContain('aria-label="Play"');
		expect(controls).toContain('class="hb-scrubber hb-focusable"');
		expect(controls).toContain('aria-valuetext="1:05 of 1:18"');
		expect(text(controls)).toContain("1:05 / 1:18");
		expect(text(controls)).toContain("2×");
		const over = html(PlayerControls, {
			playing: false,
			position: 78_000,
			duration: 78_000,
			onToggle: () => {},
			onSeek: () => {},
		});
		expect(over).toContain('aria-label="Play again"');
		expect(playerClock(-5)).toBe("0:00");
	});
});

describe("a browser call's page", () => {
	const call = (name: string, output: string, args?: unknown): ToolItem => ({
		...tool("t", name, "step"),
		browserSessionId: "bs_1",
		output,
		...(args === undefined ? {} : { args }),
	});

	it("reads the URL and title a step's result names, or the address it was asked to open", () => {
		expect(browserPageOf(call("browser_act", "Clicked.\nURL: https://example.com/a\nTitle: A page\n"))).toEqual({
			url: "https://example.com/a",
			title: "A page",
		});
		expect(browserPageOf(call("browser_screenshot", "Screenshot of https://example.com/ (Example Domain)."))).toEqual({
			url: "https://example.com/",
			title: "Example Domain",
		});
		expect(browserPageOf(call("browser_open", "", { url: "https://example.org/" }))).toEqual({
			url: "https://example.org/",
		});
		expect(browserPageOf(call("browser_open", "", { url: "javascript:alert(1)" }))).toBeUndefined();
		expect(browserPageOf(call("browser_close", "Closed."))).toBeUndefined();
	});

	it("keeps each browser's newest page, and says when it closed", () => {
		const items = [
			call("browser_open", "URL: https://example.com/\nTitle: Example Domain"),
			call("browser_act", "Scrolled."),
			{ ...call("browser_close", "Closed."), status: "done" as const },
		];
		const { browsers } = sessionBrowsers(items);
		expect(browsers[0]?.page).toEqual({ url: "https://example.com/", title: "Example Domain" });
		expect(browsers[0]?.closed).toBe(true);
		// The same calls again: the same slot, so nothing that shows it renders again.
		expect(sessionBrowsers([...items], { browsers }).browsers[0]).toBe(browsers[0]);
		expect(browsingPage(items).page).toEqual({ url: "https://example.com/", title: "Example Domain" });
	});
});

describe("a browser in the timeline", () => {
	const page = { url: "https://www.kayak.co.uk/flights", title: "London to Amsterdam" };

	it("says the page, where the browser is, and what a click does", () => {
		const live = html(BrowserEntry, { page, state: "live", onShow: () => {} });
		expect(text(live)).toBe("K London to Amsterdam https://www.kayak.co.uk/flights Live Watch live");
		expect(live).toContain('aria-label="Watch live: London to Amsterdam"');
		const replay = html(BrowserEntry, {
			page,
			state: "replay",
			screenshot: { mimeType: "image/png", data: "AAAA" },
			onShow: () => {},
		});
		expect(replay).toContain("data:image/png;base64,AAAA");
		expect(text(replay)).toContain("Replay Watch the replay");
		const shown = html(BrowserEntry, { page: undefined, state: "unknown", shown: true, onShow: () => {} });
		expect(text(shown)).toBe("Browser No page yet In panel");
		expect(shown).toContain('aria-pressed="true"');
	});
});
