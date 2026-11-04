import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { SandboxAccess } from "./compute-model.ts";
import { createComputeFixtures, FIXTURE_NOW } from "./fixtures.ts";
import { SandboxSsh } from "./sandbox-ssh.tsx";

export default { title: "Compute/Sandbox SSH" } satisfies StoryDefault;

const ID = "sbx_7f3k2m9qa1";

const ACCESS: SandboxAccess = {
	ssh: `kantel ssh ${ID}`,
	sshWithoutCli: true,
	desktopUrl: "",
	desktopViewUrl: "",
	browserUrl: "",
};

function Scenario({
	access = ACCESS,
	open = false,
	fail = false,
	narrow = false,
}: {
	access?: SandboxAccess | "loading" | Error;
	open?: boolean;
	/** Letting the key in fails, as when the sandbox's sshd won't take it. */
	fail?: boolean;
	narrow?: boolean;
}) {
	const [source] = useState(() => {
		const { sandboxes } = createComputeFixtures();
		return fail
			? {
					sshKey: async () => {
						throw new Error("The sandbox could not let the key in: mkdir: cannot create directory");
					},
				}
			: sandboxes;
	});
	return (
		<div className={narrow ? "max-w-(--kt-popover-width)" : "max-w-content"}>
			<SandboxSsh
				source={source}
				sandboxId={ID}
				access={access}
				onAccessRetry={() => {}}
				now={FIXTURE_NOW}
				withoutCliOpen={open}
			/>
		</div>
	);
}

/** The CLI's command, and the one line that installs the CLI. */
export const Default: Story = () => <Scenario />;

/** Plain ssh, opened: paste a public key, or Get the command for a key pair Kantel makes and you download. */
export const WithoutCli: Story = () => <Scenario open />;

/** Letting the key in failed: the reason, and the button to try again. */
export const WithoutCliFails: Story = () => <Scenario open fail />;

/** End to end: `kantel e2e ssh`, and no plain ssh, which the host refuses. */
export const EndToEnd: Story = () => (
	<Scenario access={{ ...ACCESS, ssh: `kantel e2e ssh ${ID}`, sshWithoutCli: false }} />
);

/** While the sandbox's access loads. */
export const Loading: Story = () => <Scenario access="loading" />;

/** The access couldn't be read. */
export const Unreachable: Story = () => <Scenario access={new Error("Kantel couldn't reach the sandbox.")} />;

/** At 420px: the commands truncate on one line, and the key's form stacks. */
export const Mobile: Story = () => <Scenario open narrow />;
