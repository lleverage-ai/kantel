import { PlusIcon } from "../primitives/icons.tsx";
import { ListRow } from "../primitives/list-row.tsx";
import "./new-session.css";

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
			<div className="hb-new-session-row hb-new-session-row-disabled" aria-disabled="true" title={disabledReason}>
				<ListRow leading={<PlusIcon />} title="New session" meta={disabledReason} density="comfortable" quiet />
			</div>
		);
	}
	return (
		<div className="hb-new-session-row">
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
