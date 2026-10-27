import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { VList, type VListHandle } from "virtua";
import type { TranscriptItem } from "../protocol-local/index.ts";
import { Row } from "./rows.tsx";

// The virtualised transcript. Only the rows near the viewport are mounted, whatever the session's length. It follows
// new output only while the reader is at the bottom: scrolling up stops following, and returning to the bottom (or
// the "Latest" button) starts it again. Near the top it asks for the previous history page, and keeps the reader's
// place when that page is put in front.

const AT_BOTTOM_PX = 48;

// A fixed spacer always sits after the last item, so the bottom padding never belongs to a real row: if it did, the
// row that was last would render again, to lose it, every time an item arrived.
const END = { end: true } as const;
type Entry = TranscriptItem | typeof END;
const LOAD_OLDER_PX = 600;

type Props = {
	items: readonly TranscriptItem[];
	hasOlder: boolean;
	loadingOlder: boolean;
	onLoadOlder: () => void;
};

export function Transcript({ items, hasOlder, loadingOlder, onLoadOlder }: Props) {
	const list = useRef<VListHandle>(null);
	const frame = useRef<HTMLDivElement>(null);
	const following = useRef(true);
	const [showLatest, setShowLatest] = useState(false);
	const first = useRef<string | undefined>(undefined);
	const count = useRef(0);

	// Prepending older items: tell the virtualiser to keep the visible content still (virtua's `shift`).
	const firstId = items[0]?.id;
	const prepended = first.current !== undefined && firstId !== first.current && items.length > count.current;

	const toBottom = useCallback(() => {
		const handle = list.current;
		if (handle === null || items.length === 0) return;
		handle.scrollToIndex(items.length, { align: "end" });
	}, [items.length]);

	useLayoutEffect(() => {
		const initial = first.current === undefined && items.length > 0;
		first.current = firstId;
		count.current = items.length;
		if (initial || (following.current && !prepended)) toBottom();
	});

	// While following, keep the bottom in view as the last row grows (a streamed answer, a tool's output).
	useEffect(() => {
		const viewport = frame.current?.firstElementChild;
		const content = viewport?.firstElementChild;
		if (!(content instanceof HTMLElement) || !(viewport instanceof HTMLElement)) return;
		const observer = new ResizeObserver(() => {
			if (following.current) viewport.scrollTop = viewport.scrollHeight;
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, []);

	const onScroll = useCallback(
		(offset: number) => {
			const handle = list.current;
			if (handle === null) return;
			const distance = handle.scrollSize - (offset + handle.viewportSize);
			const atBottom = distance <= AT_BOTTOM_PX;
			following.current = atBottom;
			setShowLatest(!atBottom);
			if (offset < LOAD_OLDER_PX && hasOlder && !loadingOlder) onLoadOlder();
		},
		[hasOlder, loadingOlder, onLoadOlder],
	);

	return (
		<div className="transcript" ref={frame}>
			<VList<Entry> ref={list} data={[...items, END]} shift={prepended} onScroll={onScroll} className="vlist" bufferSize={600}>
				{(item, index) =>
					"end" in item ? (
						<div key="end" className="transcript-end" aria-hidden="true" />
					) : (
						<Row key={item.id} item={item} turnStart={item.kind === "user" && index > 0} first={index === 0 && !hasOlder} />
					)
				}
			</VList>
			{loadingOlder ? <div className="older">Loading earlier messages…</div> : null}
			{showLatest ? (
				<button
					type="button"
					className="latest"
					onClick={() => {
						following.current = true;
						setShowLatest(false);
						toBottom();
					}}
				>
					Latest
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M8 3v10M4 9l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</button>
			) : null}
		</div>
	);
}
