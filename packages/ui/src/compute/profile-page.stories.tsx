import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { ProfilePage } from "./profile-page.tsx";

export default { title: "Compute/Profile page" } satisfies StoryDefault;

/** Who is signed in, and the theme. */
export const Default: Story = () => <ProfilePage name="Tom Davies" email="tom@example.com" />;

/** On a phone. */
export const Phone: Story = () => <ProfilePage name="Tom Davies" email="tom@example.com" narrow />;
Phone.meta = { width: 390 };

/** With Delete account, which asks before it deletes anything. */
export const WithDeleteAccount: Story = () => (
	<ProfilePage name="Tom Davies" email="tom@example.com" onDeleteAccount={() => new Promise(() => {})} />
);

/** Delete account refused: the dialog says why (here, the last owner of an organisation). */
export const DeleteAccountRefused: Story = () => (
	<ProfilePage
		name="Tom Davies"
		email="tom@example.com"
		onDeleteAccount={() =>
			Promise.reject(new Error("You're the last owner of Acme: make someone else an owner, or delete it, first"))
		}
	/>
);

/** With Delete account, on a phone. */
export const WithDeleteAccountPhone: Story = () => (
	<ProfilePage name="Tom Davies" email="tom@example.com" narrow onDeleteAccount={() => new Promise(() => {})} />
);
WithDeleteAccountPhone.meta = { width: 390 };
