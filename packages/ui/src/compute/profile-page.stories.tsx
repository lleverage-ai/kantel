import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { ProfilePage } from "./profile-page.tsx";

export default { title: "Compute/Profile page" } satisfies StoryDefault;

/** Who is signed in, and the theme. */
export const Default: Story = () => <ProfilePage name="Tom Davies" email="tom@example.com" />;

/** On a phone. */
export const Phone: Story = () => <ProfilePage name="Tom Davies" email="tom@example.com" narrow />;
Phone.meta = { width: 390 };
