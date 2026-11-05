import { describe, expect, it } from "vitest";
import { navigationTarget, searchWithout } from "./router.ts";

describe("query strings (#461)", () => {
	it("keeps the current query on a navigation unless the path has its own, and the hash after it", () => {
		expect(navigationTarget("/sandboxes", "?debug=1")).toBe("/sandboxes?debug=1");
		expect(navigationTarget("/hosts?add", "?debug=1")).toBe("/hosts?add");
		expect(navigationTarget("/sandboxes/sbx_1#files", "?debug=1")).toBe("/sandboxes/sbx_1?debug=1#files");
		expect(navigationTarget("/hosts?add#x", "")).toBe("/hosts?add#x");
	});

	it("drops parameters a page has read, keeping the rest", () => {
		expect(searchWithout("?add", ["add", "new"])).toBe("");
		expect(searchWithout("?debug=1&new&add", ["add", "new"])).toBe("?debug=1");
		expect(searchWithout("", ["add"])).toBe("");
	});
});
