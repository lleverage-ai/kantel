// Upgrade to microVM: offered for an isolate only, and only while it can be upgraded (running or stopped, its host
// connected); the fixtures' source answers as Kantel does.
import { describe, expect, it } from "vitest";
import { canUpgrade } from "./sandbox-actions.tsx";

describe("canUpgrade", () => {
	it("is an isolate's that is running or stopped on a connected host", () => {
		expect(canUpgrade({ kind: "isolate", state: "running" })).toBe(true);
		expect(canUpgrade({ kind: "isolate", state: "stopped" })).toBe(true);
		expect(canUpgrade({ kind: "isolate", state: "starting" })).toBe(false);
		expect(canUpgrade({ kind: "isolate", state: "error" })).toBe(false);
		expect(canUpgrade({ kind: "isolate", state: "running", hostUnreachable: true })).toBe(false);
		expect(canUpgrade({ kind: "microvm", state: "running" })).toBe(false);
	});
});
