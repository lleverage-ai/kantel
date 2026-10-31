import type { TranscriptItem } from "@kantel/protocol";
import { BrowserTabs, type BrowserViewSlot, type SessionBrowsers, sessionBrowsers } from "@kantel/ui";
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
	/**
	 * The window's tabs, one per browser the session used, to switch between them (with `end` at the strip's end), when
	 * it used more than one. Each says its page's title or host, as far as the agent's calls said.
	 */
	readonly tabs: ((end: ReactNode) => ReactNode) | undefined;
	/** Every browser the session used, in order of first use. */
	readonly browsers: readonly BrowserViewSlot[];
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
	const runningOn = running ? slot?.browserSessionId : undefined;
	const tabs = useMemo(
		() =>
			count < 2
				? undefined
				: (end: ReactNode) => (
						<BrowserTabs
							label="The session's browsers"
							tabs={browsers.browsers.map((each) => ({
								id: each.browserSessionId,
								url: each.page?.url,
								title: each.page?.title,
								busy: each.browserSessionId === runningOn,
							}))}
							active={slot?.browserSessionId}
							onSelect={show}
							end={end}
						/>
					),
		[count, browsers.browsers, slot?.browserSessionId, runningOn, show],
	);

	return { panel: hidden ? undefined : slot, step, running, tabs, browsers: browsers.browsers, show, hide };
}
