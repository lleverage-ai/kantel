import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { UserMenu } from "./user-menu.tsx";

export default { title: "Compute/Your menu" } satisfies StoryDefault;

const noop = () => {};

/** At the foot of the sidebar, open: who you are, the theme, Sign out. */
export const Sidebar: Story = () => (
	<div className="flex min-h-(--kt-popover-height) items-end">
		<div className="w-(--kt-nav-width) rounded-panel border border-border bg-panel p-1.5">
			<UserMenu name="Tom Davies" email="tom@example.com" onSignOut={noop} defaultOpen />
		</div>
	</div>
);

/** On a phone: your initials in the top bar, and Admin in the menu for a super-admin. */
export const Phone: Story = () => (
	<div className="flex min-h-(--kt-popover-height) items-start justify-end">
		<UserMenu name="Tom Davies" email="tom@example.com" compact onAdmin={noop} onSignOut={noop} defaultOpen />
	</div>
);
Phone.meta = { width: 390 };

/** While who is signed in loads. */
export const Loading: Story = () => (
	<div className="w-(--kt-nav-width) rounded-panel border border-border bg-panel p-1.5">
		<UserMenu />
	</div>
);
