import type { TranscriptItem } from "@harbour/protocol";
import { type BrowserViewSlot, Button, type SessionBrowsers, sessionBrowsers } from "@harbour/ui";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

// Which of the session's browsers its panel shows: the one the agent used last, unless a person picked another (a
// browsing run's "Show browser", an audit link's `#browser=<id>`) or hid the panel. A browser the agent moves to shows
// itself again, so a person never misses a new one.

export type SessionBrowserView = {
	/** The browser the panel shows; undefined when the session has none yet, or the person hid the panel. */
	readonly panel: BrowserViewSlot | undefined;
	/** What the agent is doing in it now, or did last. */
	readonly step: string | undefined;
	/** A browser call is running on it. */
	readonly running: boolean;
	/** Buttons to switch between the session's browsers, when it used more than one. */
	readonly picker: ReactNode | undefined;
	readonly show: (browserSessionId: string) => void;
	readonly hide: () => void;
};

export function useSessionBrowser(items: readonly TranscriptItem[], focusBrowser?: string): SessionBrowserView {
	const previous = useRef<SessionBrowsers | undefined>(undefined);
	const browsers = useMemo(() => {
		const next = sessionBrowsers(items, previous.current);
		previous.current = next;
		return next;
	}, [items]);
	const [picked, setPicked] = useState<string | undefined>(focusBrowser);
	const [hidden, setHidden] = useState(false);

	// The agent moved to another browser: show it, in place of an older pick, even if the panel was hidden.
	const seenLatest = useRef(browsers.latest);
	useEffect(() => {
		if (browsers.latest === seenLatest.current) return;
		const first = seenLatest.current === undefined;
		seenLatest.current = browsers.latest;
		// The first browser the loaded transcript names isn't a move: an audit link's pick stands.
		if (!first) setPicked(undefined);
		setHidden(false);
	}, [browsers.latest]);
	useEffect(() => {
		if (focusBrowser === undefined) return;
		setPicked(focusBrowser);
		setHidden(false);
	}, [focusBrowser]);

	const show = useCallback((id: string) => {
		setPicked(id);
		setHidden(false);
	}, []);
	const hide = useCallback(() => setHidden(true), []);

	const id = picked ?? browsers.latest;
	const slot = browsers.browsers.find((each) => each.browserSessionId === id) ?? browsers.browsers.at(-1);
	const onLatest = slot !== undefined && slot.browserSessionId === browsers.latest;
	const running = onLatest && browsers.running !== undefined;
	const step = running ? browsers.running?.label : slot?.item.label;

	const count = browsers.browsers.length;
	const picker = useMemo(
		() =>
			count < 2
				? undefined
				: browsers.browsers.map((each, index) => {
						const current = each.browserSessionId === slot?.browserSessionId;
						return (
							<Button
								key={each.browserSessionId}
								variant={current ? "secondary" : "ghost"}
								size="xs"
								aria-pressed={current}
								onClick={() => show(each.browserSessionId)}
							>
								{`Browser ${index + 1}`}
							</Button>
						);
					}),
		[count, browsers.browsers, slot?.browserSessionId, show],
	);

	return { panel: hidden ? undefined : slot, step, running, picker, show, hide };
}
