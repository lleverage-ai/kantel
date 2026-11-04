import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SandboxAccess } from "./compute-model.ts";
import { SandboxSsh } from "./sandbox-ssh.tsx";

const ACCESS: SandboxAccess = {
	ssh: "kantel ssh sbx_3ucrku3aio",
	sshWithoutCli: true,
	desktopUrl: "",
	desktopViewUrl: "",
	browserUrl: "",
};

const render = (access: SandboxAccess) =>
	renderToStaticMarkup(
		createElement(SandboxSsh, {
			source: { sshKey: async () => ({ command: "ssh" }) },
			sandboxId: "sbx_3ucrku3aio",
			access,
			onAccessRetry: () => {},
			now: 0,
		}),
	);

describe("SandboxSsh", () => {
	it("says to sign the CLI in to this Kantel once, under the install line, when the page has a gateway", () => {
		const html = render({ ...ACCESS, cliLogin: "kantel login --url https://app.kantel.dev" });
		expect(html).toContain("kantel ssh sbx_3ucrku3aio");
		expect(html).toContain("curl -fsSL https://kantel.dev/cli.sh | sh");
		expect(html).toContain("Install it, then sign it in to this Kantel once:");
		expect(html.indexOf("kantel login --url https://app.kantel.dev")).toBeGreaterThan(html.indexOf("cli.sh"));
	});

	it("has no sign-in line where the CLI serves the page", () => {
		const html = render(ACCESS);
		expect(html).not.toContain("kantel login");
		expect(html).not.toContain("sign it in");
	});
});
