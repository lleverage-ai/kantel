import { PlusIcon } from "../primitives/icons.tsx";
import { ListRow } from "../primitives/list-row.tsx";

// Styled with Tailwind utilities (src/tokens/tailwind.css) on a wrapper round the ListRow, reaching into its parts
// through their kt-list-row classes. list-row.css is unlayered, so each of those overrides is `!` to beat its rule on
// the same property (named beside each). The kt-new-session-row classes are names for the wrapper.

/** Above the session list, with the room the list keeps between its groups. */
const row = "kt-new-session-row mb-2.5";
/** The plus in the muted colour, not the leading slot's faint one (`!` beats .kt-list-row-leading's color). */
const plusMuted = "[&_.kt-list-row-leading]:text-muted!";
/**
 * Disabled: no hover (`!` beats .kt-list-row:hover's background), a dimmed plus and words (beating
 * .kt-list-row-leading's and .kt-list-row-quiet .kt-list-row-title's color), and the reason wraps under them instead
 * of being cut off (beating .kt-list-row-meta's white-space).
 */
const disabled =
	"kt-new-session-row-disabled [&_.kt-list-row:hover]:bg-transparent! [&_.kt-list-row-leading]:text-disabled! [&_.kt-list-row-title]:text-faint! [&_.kt-list-row-meta]:whitespace-normal!";

export type NewSessionRowProps = {
	/** Where a new session is written: the host's new-session page. The row is a link when given. */
	href?: string;
	/** Makes the row a button instead, for a host that opens the composer in place. */
	onSelect?: () => void;
	/** The new-session page is open. */
	selected?: boolean;
	/**
	 * Why the person can't start a session here, such as a viewer's role. The row stays in the list, dimmed and not
	 * clickable, with the reason under it, so it says what's missing rather than disappearing.
	 */
	disabledReason?: string;
};

/**
 * The sidebar's "New session" row, at the top of a project's sessions as T3 Code's "New thread" is: a plus and the
 * words, a link to the host's new-session page. Disabled, it keeps its place and says why under it.
 */
export function NewSessionRow({ href, onSelect, selected = false, disabledReason }: NewSessionRowProps) {
	if (disabledReason !== undefined) {
		return (
			<div className={`${row} ${disabled}`} aria-disabled="true" title={disabledReason}>
				<ListRow leading={<PlusIcon />} title="New session" meta={disabledReason} density="comfortable" quiet />
			</div>
		);
	}
	return (
		<div className={`${row} ${plusMuted}`}>
			<ListRow
				leading={<PlusIcon />}
				title="New session"
				selected={selected}
				{...(href === undefined ? {} : { href })}
				{...(onSelect === undefined ? {} : { onSelect })}
			/>
		</div>
	);
}
