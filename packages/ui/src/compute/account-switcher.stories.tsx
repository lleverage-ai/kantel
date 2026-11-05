import { useEffect, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { AccountSwitcher, CreateOrganisationDialog, JoinOrganisationDialog } from "./account-switcher.tsx";
import type { ComputeAccount } from "./compute-model.ts";
import { createComputeFixtures, EVALS, LLEVERAGE, PERSONAL } from "./fixtures.ts";

export default { title: "Compute/Account switcher" } satisfies StoryDefault;

type Opened = "create" | "join" | undefined;

/** Types `code` into the open dialog's field and submits it, as a person would: the fixtures refuse a short code. */
function useSubmitCode(code: string | undefined) {
	useEffect(() => {
		if (code === undefined) return;
		const frame = requestAnimationFrame(() => {
			const input = document.querySelector<HTMLInputElement>("dialog[open] input");
			if (input === null) return;
			// React tracks an input's value itself: set it through the element's own setter so the change is seen.
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, code);
			input.dispatchEvent(new Event("input", { bubbles: true }));
			requestAnimationFrame(() => input.form?.requestSubmit());
		});
		return () => cancelAnimationFrame(frame);
	}, [code]);
}

// Each story keeps its own source, so creating or joining an organisation adds it to the menu and switches to it.
function Scenario({
	open = false,
	opened,
	code,
	linked,
}: {
	open?: boolean;
	opened?: Opened;
	code?: string;
	/** The code an invite email's link opened Join with. */
	linked?: string;
}) {
	const [source] = useState(() => createComputeFixtures());
	const [accounts, setAccounts] = useState<readonly ComputeAccount[]>([PERSONAL, LLEVERAGE, EVALS]);
	const [current, setCurrent] = useState<ComputeAccount>(LLEVERAGE);
	const [dialog, setDialog] = useState<Opened>(opened);
	useSubmitCode(code);
	const added = async (account: ComputeAccount) => {
		setAccounts(await source.accounts.list());
		setCurrent(account);
	};
	return (
		<div className="flex min-h-(--kt-popover-height) items-start">
			{/* Hidden while a dialog is open: the modal makes it inert, and the keyboard gate counts it as unreachable. */}
			{dialog === undefined ? (
				<div className="flex w-(--kt-nav-width) flex-col rounded-panel border border-border bg-panel p-1.5">
					<AccountSwitcher
						accounts={accounts}
						current={current}
						onSwitch={setCurrent}
						onCreate={() => setDialog("create")}
						onJoin={() => setDialog("join")}
						defaultOpen={open}
					/>
				</div>
			) : null}
			<CreateOrganisationDialog
				open={dialog === "create"}
				onClose={() => setDialog(undefined)}
				onCreate={async (input) => added(await source.accounts.createOrganisation(input))}
			/>
			<JoinOrganisationDialog
				open={dialog === "join"}
				onClose={() => setDialog(undefined)}
				onJoin={async (joinCode) => added(await source.accounts.join(joinCode))}
				onSignOut={() => setDialog(undefined)}
				{...(linked === undefined ? {} : { initialCode: linked })}
			/>
		</div>
	);
}

/** Open, on an organisation: the personal account first, then the organisations with your role, then make or join one. */
export const Switcher: Story = () => <Scenario open />;

/** Create an organisation, open: the slug follows the name until it's edited. */
export const CreateOrganisation: Story = () => <Scenario opened="create" />;

/** Join with an invite code, after a code that isn't right. */
export const JoinOrganisation: Story = () => <Scenario opened="join" code="abc" />;

/** Join with a code made for another email: it says which, and offers Sign out to sign in as them. */
export const JoinAsSomeoneElse: Story = () => <Scenario opened="join" code="kji_otherPerson" />;

/** Opened from an invite email's link: Join with its code filled in. */
export const JoinFromLink: Story = () => <Scenario opened="join" linked="kji_q8w2mr5tz4kd9xv3bn7c" />;

/** On a phone. */
export const Mobile: Story = () => <Scenario open />;
Mobile.meta = { width: 420 };
