import { ListRow } from "../primitives/list-row.tsx";
import { Badge } from "../primitives/status.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Section, Sheet } from "../workbench/specimen.tsx";
import { SignedInAs, type SignedInAsProps } from "./signed-in-as.tsx";
import "./stories.css";

export default { title: "Identity/Signed in as" } satisfies StoryDefault;

/** The console's sidebar foot, as the shell lays it out, with the project names above it. */
function Foot(props: SignedInAsProps & { projects?: readonly string[] }) {
	const { projects, ...rest } = props;
	return (
		<div className="hb-story-sidebar">
			{projects === undefined ? null : (
				<nav aria-label="Projects">
					{projects.map((name, index) => (
						<ListRow key={name} title={name} href={`#${name}`} selected={index === 0} />
					))}
				</nav>
			)}
			<div className="hb-story-sidebar-foot">
				<SignedInAs {...rest} />
			</div>
		</div>
	);
}

export const Default: Story = () => (
	<Sheet
		title="Signed in as"
		intro="Who is signed in, at the foot of the console's sidebar, from GET /v1/me: their name and, when it adds something, their email."
	>
		<Section title="In the sidebar, under the projects">
			<Foot name="Ada Lovelace" email="ada@harbour.test" projects={["Website", "Billing", "Default"]} />
		</Section>
		<Section title="Signed in with an email code, so they can sign out here">
			<Foot name="Ada Lovelace" email="ada@harbour.test" onSignOut={() => {}} />
		</Section>
		<Section title="A name that is the email">
			<Foot name="dev@harbour.test" email="dev@harbour.test" />
		</Section>
	</Sheet>
);

export const Loading: Story = () => (
	<Sheet title="Signed in as: loading" intro="A skeleton of the same height while /v1/me answers.">
		<Foot />
	</Sheet>
);

export const SigningOut: Story = () => (
	<Sheet title="Signed in as: signing out" intro="The session is being ended.">
		<Foot name="Ada Lovelace" email="ada@harbour.test" onSignOut={() => {}} signingOut />
	</Sheet>
);
SigningOut.storyName = "Signing out";

export const Stubbed: Story = () => (
	<Sheet title="Signed in as: stubbed" intro="Recorded sessions have no one signed in, and say so.">
		<Foot name="Recorded sessions" badge={<Badge>Sign-in stubbed</Badge>} />
	</Sheet>
);

export const LongContent: Story = () => (
	<Sheet title="Signed in as: long content" intro="A long name and email truncate, with the whole of each on hover.">
		<Foot
			name="Augusta Ada King, Countess of Lovelace"
			email="ada.augusta.king-noel.countess-of-lovelace@analytical-engine.harbour.example.org"
			onSignOut={() => {}}
		/>
	</Sheet>
);
LongContent.storyName = "Long content";

export const Mobile: Story = () => (
	<Sheet title="Signed in as: mobile" intro="On a phone the sidebar is the page, and the foot spans it.">
		<Foot name="Ada Lovelace" email="ada@harbour.test" projects={["Website", "Billing"]} onSignOut={() => {}} />
	</Sheet>
);
Mobile.meta = { width: 420 };
