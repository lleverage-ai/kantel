import { describe, expect, it } from "vitest";
import {
	COMPUTE_PAGES,
	computePath,
	egressTabPath,
	parseComputePath,
	pathAfterAccountSwitch,
	sandboxPath,
	screenSearch,
} from "./compute-console.tsx";

describe("a screen's page in a new tab", () => {
	it("carries what this tab runs on and the address's theme, and nothing of the page's own", () => {
		expect(screenSearch("")).toBe("");
		expect(screenSearch("?theme=dark&path=/home/user&file=a.md&new", "source=recorded")).toBe(
			"?source=recorded&theme=dark",
		);
		// What the tab runs on, not what the address says now: it was chosen once, when the app started.
		expect(screenSearch("?hosting=hosted", "hosting=self-hosted&data=sample")).toBe("?hosting=self-hosted&data=sample");
	});
});

describe("Egress's tabs", () => {
	it("names every tab in the address, Log too, keeping the rest of the query", () => {
		expect(egressTabPath("log", "?tab=rules")).toBe("/compute/egress?tab=log");
		expect(egressTabPath("settings", "")).toBe("/compute/egress?tab=settings");
		expect(egressTabPath("rules", "?hosting=hosted&tab=log", "")).toBe("/egress?hosting=hosted&tab=rules");
	});
});

describe("the compute console's paths", () => {
	it("opens on Sandboxes at its base", () => {
		expect(parseComputePath("/compute")).toEqual({ page: "sandboxes" });
		expect(parseComputePath("/compute/")).toEqual({ page: "sandboxes" });
	});

	it("reads back every page it makes a path for", () => {
		for (const page of COMPUTE_PAGES) expect(parseComputePath(computePath(page))).toEqual({ page });
	});

	it("opens Egress at the old Egress proxy page's address", () => {
		expect(parseComputePath("/compute/proxy")).toEqual({ page: "egress" });
		expect(parseComputePath("/proxy", "")).toEqual({ page: "egress" });
		expect(parseComputePath("/compute/proxy/extra")).toBeUndefined();
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

	it("carries a sandbox's page, its tab and its screens", () => {
		expect(sandboxPath("/compute", "sbx_7f3k")).toBe("/compute/sandboxes/sbx_7f3k");
		expect(parseComputePath("/compute/sandboxes/sbx_7f3k")).toEqual({
			page: "sandboxes",
			sandboxId: "sbx_7f3k",
			sandboxView: "overview",
		});
		for (const view of ["logs", "egress", "snapshots", "files", "desktop", "watch", "browser"] as const) {
			const path = sandboxPath("/compute", "sbx_7f3k", view);
			expect(path).toBe(`/compute/sandboxes/sbx_7f3k/${view}`);
			expect(parseComputePath(path)).toEqual({ page: "sandboxes", sandboxId: "sbx_7f3k", sandboxView: view });
		}
		expect(parseComputePath("/compute/sandboxes/sbx_7f3k/nowhere")).toBeUndefined();
		expect(parseComputePath("/compute/sandboxes/sbx_7f3k/logs/more")).toBeUndefined();
		expect(pathAfterAccountSwitch("/compute/sandboxes/sbx_7f3k/desktop")).toBe("/compute/sandboxes");
	});

	it("carries the sandbox whose snapshots are open", () => {
		const path = computePath("snapshots", "/compute", "sbx_7f3k2m9q");
		expect(path).toBe("/compute/snapshots/sbx_7f3k2m9q");
		expect(parseComputePath(path)).toEqual({ page: "snapshots", sandboxId: "sbx_7f3k2m9q" });
	});

	it("leaves an environment or a sandbox's egress for its list when the account changes", () => {
		expect(pathAfterAccountSwitch("/compute/environments/env_backend")).toBe("/compute/environments");
		expect(pathAfterAccountSwitch("/compute/egress/sbx_4d8n")).toBe("/compute/sandboxes");
		// The account's Egress is every account's: it stays.
		expect(pathAfterAccountSwitch("/compute/egress")).toBeUndefined();
		expect(pathAfterAccountSwitch("/compute/environments")).toBeUndefined();
		expect(pathAfterAccountSwitch("/compute/keys")).toBeUndefined();
		// A snapshot's files (`?snapshot=`) or a sandbox's history are the last account's: the new one's saved list.
		expect(pathAfterAccountSwitch("/compute/snapshots")).toBe("/compute/snapshots");
		expect(pathAfterAccountSwitch("/compute/snapshots/sbx_4d8n")).toBe("/compute/snapshots");
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
