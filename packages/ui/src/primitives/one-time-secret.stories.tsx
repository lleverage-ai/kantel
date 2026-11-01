import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Section, Sheet } from "../workbench/specimen.tsx";
import { Button } from "./button.tsx";
import { CommandBlock, OneTimeSecret } from "./one-time-secret.tsx";

export default { title: "Primitives/One-time secret" } satisfies StoryDefault;

const TOKEN = "hbt_Q7m2xK9vP4nR8sT3wB6yH2cJ5dE9aLf";
const COMMAND = `npx @kantel/tunnel --harbour https://harbour.example.com --server ts_03warehouse --token ${TOKEN} -- <your stdio MCP server command>`;
const URL_COMMAND = `npx @kantel/tunnel --harbour https://harbour.example.com --server ts_03warehouse --token ${TOKEN} --url http://127.0.0.1:8123/mcp`;

/** A tunnel token with the commands that use it; I've stored it hides it, as the owner forgets the secret. */
function Reveal() {
	const [shown, setShown] = useState(true);
	if (!shown) return <Button onClick={() => setShown(true)}>Show it again (story only)</Button>;
	return (
		<OneTimeSecret
			title="Copy the token for warehouse now"
			secret={TOKEN}
			secretLabel="Tunnel token"
			copyLabel="Copy token"
			commands={[
				{ label: "Run this where your MCP server runs", text: COMMAND },
				{ label: "Or, for a Streamable HTTP server already listening on this machine", text: URL_COMMAND },
			]}
			onAcknowledge={() => setShown(false)}
		/>
	);
}

/** The secret alone, with its commands, and a command block on its own. */
export const States: Story = () => (
	<Sheet
		title="One-time secret"
		intro="A secret shown once, when it is made: copy it and any command that uses it, then say it's stored. Kantel keeps only a hash, so nothing shows it again."
	>
		<Section title="With commands">
			<Reveal />
		</Section>
		<Section title="The secret alone">
			<OneTimeSecret
				title="Copy the key for the research supervisor now"
				secret="hbk_live_2f9c41e07b8d4a63a1c5e9f0d7b2a48c"
				secretLabel="API key"
				copyLabel="Copy key"
				warning="Kantel shows this key only once and keeps just a hash of it. Store it where the host app reads its secrets."
				onAcknowledge={() => {}}
			/>
		</Section>
		<Section title="Command block">
			<CommandBlock command="npx @kantel/tunnel --help" label="See every option" />
		</Section>
	</Sheet>
);

/** At 420px: the commands wrap rather than scroll, and Copy goes under each. */
export const Mobile: Story = () => (
	<Sheet title="One-time secret at 420px">
		<Reveal />
	</Sheet>
);
Mobile.meta = { width: 420 };
