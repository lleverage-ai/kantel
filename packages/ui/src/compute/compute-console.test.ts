import { describe, expect, it } from "vitest";
import { COMPUTE_PAGES, computePath, parseComputePath } from "./compute-console.tsx";

describe("the compute console's paths", () => {
	it("opens on Sandboxes at its base", () => {
		expect(parseComputePath("/compute")).toEqual({ page: "sandboxes" });
		expect(parseComputePath("/compute/")).toEqual({ page: "sandboxes" });
	});

	it("reads back every page it makes a path for", () => {
		for (const page of COMPUTE_PAGES) expect(parseComputePath(computePath(page))).toEqual({ page });
	});

	it("carries the sandbox whose snapshots are open", () => {
		const path = computePath("snapshots", "/compute", "sbx_7f3k2m9q");
		expect(path).toBe("/compute/snapshots/sbx_7f3k2m9q");
		expect(parseComputePath(path)).toEqual({ page: "snapshots", sandboxId: "sbx_7f3k2m9q" });
	});

	it("leaves paths that aren't its own", () => {
		expect(parseComputePath("/")).toBeUndefined();
		expect(parseComputePath("/computer")).toBeUndefined();
		expect(parseComputePath("/compute/sessions")).toBeUndefined();
		expect(parseComputePath("/compute/keys/extra")).toBeUndefined();
	});

	it("follows another base", () => {
		expect(computePath("hosts", "/admin/compute")).toBe("/admin/compute/hosts");
		expect(parseComputePath("/admin/compute/hosts", "/admin/compute")).toEqual({ page: "hosts" });
	});
});
