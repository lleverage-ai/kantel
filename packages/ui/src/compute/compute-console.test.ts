import { describe, expect, it } from "vitest";
import {
	COMPUTE_PAGES,
	computePath,
	e2eStrip,
	egressTabPath,
	parseComputePath,
	pathAfterAccountSwitch,
	sandboxPath,
} from "./compute-console.tsx";

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

describe("the end-to-end encryption strip", () => {
	const gateway = { served: "gateway" as const, mode: async () => "off" as const };
	const local = { served: "local" as const, device: "Ada's laptop", mode: async () => "on" as const };

	it("says nothing on the gateway's console where E2E is off, or with no source", () => {
		expect(e2eStrip(gateway, "off")).toBeUndefined();
		expect(e2eStrip(undefined, "on")).toBeUndefined();
		expect(e2eStrip(local, undefined)).toBeUndefined();
	});

	it("tells the gateway's console that it can't show commands, and where they are", () => {
		for (const mode of ["on", "strict"] as const) {
			expect(e2eStrip(gateway, mode)).toMatchObject({
				tone: "waiting",
				text: expect.stringContaining("kantel console"),
			});
		}
	});

	it("names the device whose key kantel console uses", () => {
		expect(e2eStrip(local, "on")).toMatchObject({ tone: "done", text: expect.stringContaining("Ada's laptop") });
		expect(e2eStrip(local, "off")?.tone).toBe("idle");
	});

	it("offers to make this browser a device on the gateway's console, and says when it is one", () => {
		const browser = { standing: async () => ({ kind: "unpinned" }) as const, trust: async () => undefined };
		const hosted = { ...gateway, browser };
		expect(e2eStrip(hosted, "on", { kind: "unpinned" })).toMatchObject({ tone: "waiting", setup: "Use this browser" });
		expect(
			e2eStrip(hosted, "on", { kind: "pending", command: "kantel e2e add-device x", fingerprint: "f" }),
		).toMatchObject({ tone: "waiting", setup: "Waiting for an admin" });
		expect(e2eStrip(hosted, "on", { kind: "ready", label: "Console in Firefox" })).toMatchObject({
			tone: "done",
			text: expect.stringContaining("(Console in Firefox)"),
		});
		const refused = e2eStrip(hosted, "on", { kind: "refused", reason: "This device's person isn't a member." });
		expect(refused?.setup).toBeUndefined();
		expect(refused?.text).toContain("isn't a member. Run kantel console");
		// Strict lets no browser in, set up or not.
		expect(e2eStrip(hosted, "strict", { kind: "ready", label: "Console in Firefox" })).toMatchObject({
			tone: "waiting",
			text: expect.stringContaining("kantel console"),
		});
		expect(e2eStrip(hosted, "strict")?.setup).toBeUndefined();
	});
});
