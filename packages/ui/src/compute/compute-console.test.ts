import { describe, expect, it } from "vitest";
import { COMPUTE_PAGES, computePath, parseComputePath, pathAfterAccountSwitch } from "./compute-console.tsx";

describe("the compute console's paths", () => {
	it("opens on Sandboxes at its base", () => {
		expect(parseComputePath("/compute")).toEqual({ page: "sandboxes" });
		expect(parseComputePath("/compute/")).toEqual({ page: "sandboxes" });
	});

	it("reads back every page it makes a path for", () => {
		for (const page of COMPUTE_PAGES) {
			// Egress is always one sandbox's: it has no page of its own.
			if (page === "egress") expect(parseComputePath(computePath(page))).toBeUndefined();
			else expect(parseComputePath(computePath(page))).toEqual({ page });
		}
	});

	it("carries the environment that's open, and the sandbox whose egress is", () => {
		const env = computePath("environments", "/compute", "env_backend");
		expect(env).toBe("/compute/environments/env_backend");
		expect(parseComputePath(env)).toEqual({ page: "environments", environmentId: "env_backend" });
		expect(parseComputePath(computePath("egress", "/compute", "sbx_4d8n"))).toEqual({
			page: "egress",
			sandboxId: "sbx_4d8n",
		});
		expect(parseComputePath("/compute/environments/env_backend/extra")).toBeUndefined();
	});

	it("carries the sandbox whose snapshots are open", () => {
		const path = computePath("snapshots", "/compute", "sbx_7f3k2m9q");
		expect(path).toBe("/compute/snapshots/sbx_7f3k2m9q");
		expect(parseComputePath(path)).toEqual({ page: "snapshots", sandboxId: "sbx_7f3k2m9q" });
	});

	it("leaves an environment or a sandbox's egress for its list when the account changes", () => {
		expect(pathAfterAccountSwitch("/compute/environments/env_backend")).toBe("/compute/environments");
		expect(pathAfterAccountSwitch("/compute/egress/sbx_4d8n")).toBe("/compute/sandboxes");
		expect(pathAfterAccountSwitch("/compute/environments")).toBeUndefined();
		expect(pathAfterAccountSwitch("/compute/keys")).toBeUndefined();
		expect(pathAfterAccountSwitch("/environments/env_backend", "")).toBe("/environments");
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
