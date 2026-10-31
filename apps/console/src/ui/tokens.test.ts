import { lintHost } from "@kantel/ui/token-lint";
import { describe, expect, it } from "vitest";

// The console is a host for @kantel/ui: its own CSS and TSX use --kt-* tokens and the library's copy rules, as the
// library's do (AGENTS.md). The same lint the library runs on itself, so CI catches a raw colour here too.
describe("console styles", () => {
	it("use only --kt-* tokens and plain copy", () => {
		const findings = lintHost(new URL("../..", import.meta.url).pathname);
		expect(findings.map((finding) => `${finding.file}:${finding.line} ${finding.rule}`)).toEqual([]);
	});
});
