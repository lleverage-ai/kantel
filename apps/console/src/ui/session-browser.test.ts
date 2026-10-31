import type { ToolItem } from "@kantel/protocol";
import { sessionBrowsers } from "@kantel/ui";
import { describe, expect, it } from "vitest";
import { panelStep } from "./session-browser.tsx";

const call = (id: string, name: string, label: string, status: ToolItem["status"] = "done"): ToolItem => ({
	kind: "tool",
	id,
	callId: id,
	at: 0,
	name,
	label,
	status,
	browserSessionId: "b1",
});

const stepOf = (items: readonly ToolItem[]): string | undefined => {
	const browsers = sessionBrowsers(items);
	return panelStep(browsers.browsers.at(-1), browsers.running?.label);
};

describe("panelStep", () => {
	it("says the running call while one runs", () => {
		expect(stepOf([call("t1", "browser_open", "Opening google.com", "running")])).toBe("Opening google.com");
	});

	it("says the last step between calls", () => {
		expect(
			stepOf([call("t1", "browser_open", "Opening google.com"), call("t2", "browser_act", "Clicking Search")]),
		).toBe("Clicking Search");
	});

	it("says Closing while the close runs, and Closed once it has, not the stale call label", () => {
		const open = call("t1", "browser_open", "Opening google.com");
		expect(stepOf([open, call("t2", "browser_close", "Closing the browser", "running")])).toBe("Closing the browser");
		expect(stepOf([open, call("t2", "browser_close", "Closing the browser")])).toBe("Closed");
	});

	it("keeps a failed close's label: the browser may still be open", () => {
		const open = call("t1", "browser_open", "Opening google.com");
		expect(stepOf([open, call("t2", "browser_close", "Closing the browser", "error")])).toBe("Closing the browser");
	});

	it("says nothing before the session has a browser", () => {
		expect(panelStep(undefined, undefined)).toBeUndefined();
	});
});
