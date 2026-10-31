import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton } from "../primitives/button.tsx";
import { NextStepIcon, PlayIcon, PreviousStepIcon } from "../primitives/lucide.tsx";
import { Spinner } from "../primitives/spinner.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import {
	pageAtPosition,
	REPLAY_DEFAULT_SPEED,
	REPLAY_SPEEDS,
	type ReplayManifest,
	type ReplayMarker,
	type ReplayStep,
	replayAt,
	replayPlan,
	replayPosition,
	replayReal,
	stepAt,
} from "./browser-timeline-model.ts";
import { BrowserAddressBar, BrowserTabs, BrowserWindow, PlayerControls, playerClock } from "./browser-window.tsx";
import { retryToolImage } from "./tool-call.tsx";

// A browser's recording, played in the session's browser panel on a timeline of the agent's own steps
// (`browser-timeline-model.ts`): each step a marker on the scrubber that seeks to it, the time the agent spent thinking
// skipped, 2× to start with, and the window's tab and address bar saying the page the recording shows at that point.
// The page fills the space it is given, at its own shape.
//
// Provider-neutral: the host hands it the recording's manifest and a way to read a chunk's frames (Kantel's own
// browsers: JPEG frames in Matroska, read through the view link). Nothing is read until a person plays it or picks a
// step: until then the browser's last screenshot stands in, at the page's size.

/** One frame of a recording: a JPEG, at its time on its page's clock. */
export type ReplayFrame = { readonly ms: number; readonly jpeg: Uint8Array };

/** A recording the timeline plays: its manifest, and its chunks' frames, read when they're needed. */
export interface BrowserRecording {
	readonly manifest: ReplayManifest;
	chunk(pageId: string, index: number): Promise<readonly ReplayFrame[]>;
}

export type BrowserTimelineProps = {
	readonly recording: BrowserRecording;
	/** The agent's calls on the browser, in order (`browserSteps`). */
	readonly steps: readonly ReplayStep[];
	/** The last picture of the browser, shown until playing starts: an image URL (a data URL or an object URL). */
	readonly poster?: string;
	/** The window's tabs, when the host has several browsers to pick between; this browser's own tab otherwise. */
	readonly tabs?: (end: ReactNode) => ReactNode;
	/** The speed to start at. Default 2×. */
	readonly speed?: number;
	/** Start playing at once rather than on Play. */
	readonly autoPlay?: boolean;
	readonly className?: string;
};

/** The newest frame at or before `ms` in frames sorted by time, or the first when none is. */
function frameAt(frames: readonly ReplayFrame[], ms: number): ReplayFrame | undefined {
	let low = 0;
	let high = frames.length - 1;
	let found = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if ((frames[mid] as ReplayFrame).ms <= ms) {
			found = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return frames[Math.max(found, 0)];
}

/** The view fills what it's given, never less than a small page. */
const figure = "kt-browser-timeline flex min-h-40 min-w-0 flex-1 flex-col";
/** The page's stage: the frame (or the poster) at its own shape, as large as fits, centred. */
const stage = "kt-browser-timeline-stage relative min-h-40 flex-1 overflow-hidden bg-sunken";
const picture = "absolute inset-0 block size-full object-contain";
/** The step on view, in the stage's corner. */
const caption =
	"kt-browser-timeline-step absolute bottom-2 left-2 max-w-[calc(100%-var(--kt-step-4))] truncate rounded-xs border border-border bg-raised px-2 py-1 text-xs text-fg";

export function BrowserTimeline({
	recording,
	steps,
	poster,
	tabs,
	speed: initialSpeed = REPLAY_DEFAULT_SPEED,
	autoPlay = false,
	className,
}: BrowserTimelineProps) {
	const { manifest } = recording;
	const [skipIdle, setSkipIdle] = useState(true);
	const plan = useMemo(() => replayPlan(manifest, steps, { skipIdle }), [manifest, steps, skipIdle]);
	const { duration, markers } = plan;
	const canvas = useRef<HTMLCanvasElement>(null);
	const [started, setStarted] = useState(autoPlay);
	const [painted, setPainted] = useState(false);
	const [position, setPosition] = useState(0);
	const [playing, setPlaying] = useState(autoPlay);
	const [speed, setSpeed] = useState(initialSpeed);
	const [waiting, setWaiting] = useState(false);
	// A chunk didn't load: the replay stops there until a person seeks or plays again, rather than asking on and on.
	const [failed, setFailed] = useState(false);
	// Chunks read (or being read), by `<page>/<index>`.
	const chunks = useRef(new Map<string, Promise<readonly ReplayFrame[]>>());
	const loaded = useRef(new Map<string, readonly ReplayFrame[]>());

	// A frame is decoded, then drawn unless a newer one was asked for meanwhile.
	const show = useMemo(() => {
		let newest: ReplayFrame | undefined;
		return (frame: ReplayFrame) => {
			if (frame === newest) return;
			newest = frame;
			createImageBitmap(new Blob([frame.jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }))
				.then((bitmap) => {
					const target = canvas.current;
					if (frame === newest && target !== null) {
						if (target.width !== bitmap.width || target.height !== bitmap.height) {
							target.width = bitmap.width;
							target.height = bitmap.height;
						}
						target.getContext("2d")?.drawImage(bitmap, 0, 0);
						setPainted(true);
					}
					bitmap.close();
				})
				.catch(() => undefined);
		};
	}, []);

	const load = useCallback(
		(pageId: string, index: number) => {
			const key = `${pageId}/${index}`;
			let chunk = chunks.current.get(key);
			if (chunk === undefined) {
				chunk = recording.chunk(pageId, index).then((frames) => {
					loaded.current.set(key, frames);
					return frames;
				});
				chunk.catch(() => chunks.current.delete(key));
				chunks.current.set(key, chunk);
			}
			return chunk;
		},
		[recording],
	);

	// Draw the frame at the position, reading its chunk (and the next) when they're not here yet.
	useEffect(() => {
		if (!started || failed) return;
		const where = replayAt(plan, position);
		if (where === undefined) return;
		const page = manifest.pages.find((each) => each.pageId === where.segment.pageId);
		const ordered = page?.chunks ?? [];
		const chunk = [...ordered].reverse().find((each) => each.startMs <= where.pageMs) ?? ordered[0];
		if (chunk === undefined) return;
		const key = `${where.segment.pageId}/${chunk.index}`;
		const next = ordered.find((each) => each.index > chunk.index);
		if (next !== undefined) void load(where.segment.pageId, next.index).catch(() => undefined);
		const frames = loaded.current.get(key);
		if (frames === undefined) {
			if (waiting) return;
			setWaiting(true);
			void load(where.segment.pageId, chunk.index)
				.then(() => setWaiting(false))
				.catch(() => {
					setFailed(true);
					setPlaying(false);
					setWaiting(false);
				});
			return;
		}
		const frame = frameAt(frames, where.pageMs);
		if (frame !== undefined) show(frame);
	}, [started, failed, plan, position, manifest, load, waiting, show]);

	// Play: move the position on with the clock, unless a chunk is still being read.
	useEffect(() => {
		if (!playing || waiting) return;
		let last = performance.now();
		let frame = 0;
		const tick = (now: number) => {
			const elapsed = (now - last) * speed;
			last = now;
			setPosition((at) => {
				const next = Math.min(duration, at + elapsed);
				if (next >= duration) setPlaying(false);
				return next;
			});
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [playing, waiting, speed, duration]);

	const seek = (to: number, play = playing) => {
		setStarted(true);
		setFailed(false);
		setPosition(Math.max(0, Math.min(duration, to)));
		setPlaying(play);
	};
	const current = stepAt(markers, position);
	const goTo = (marker: ReplayMarker | undefined) => {
		if (marker !== undefined) seek(marker.position, true);
	};
	const previous =
		current === undefined ? undefined : markers[current.index - (position - current.position > 1500 ? 0 : 1)];
	const next = markers.find((marker) => marker.position > position + 1);

	const toggleSkip = () => {
		// Stay on the same moment of the recording when the timeline changes under it.
		const real = replayReal(plan, position);
		const nextPlan = replayPlan(manifest, steps, { skipIdle: !skipIdle });
		setSkipIdle(!skipIdle);
		if (real !== undefined) setPosition(replayPosition(nextPlan, real));
	};

	const page = pageAtPosition(plan, manifest.pages, started ? position : duration);
	const status = <StatusLabel status="idle">Replay</StatusLabel>;
	const strip =
		tabs === undefined ? (
			<BrowserTabs label="The browser's tab" tabs={[{ id: "page", ...page }]} active="page" end={status} />
		) : (
			tabs(status)
		);
	const saved = plan.recorded - duration;

	return (
		<figure className={`${figure}${className ? ` ${className}` : ""}`} aria-label="Replay of the browser">
			<BrowserWindow
				className="min-h-0 flex-1"
				tabs={strip}
				toolbar={<BrowserAddressBar url={page?.url} placeholder="No page yet" />}
				footer={
					<PlayerControls
						playing={playing}
						position={position}
						duration={duration}
						onToggle={() => {
							setStarted(true);
							setFailed(false);
							if (position >= duration) setPosition(0);
							setPlaying((on) => !on);
						}}
						onSeek={(to) => seek(to)}
						speed={speed}
						onSpeed={() =>
							setSpeed(
								(now) =>
									REPLAY_SPEEDS[
										(REPLAY_SPEEDS.indexOf(now as (typeof REPLAY_SPEEDS)[number]) + 1) % REPLAY_SPEEDS.length
									] ?? REPLAY_DEFAULT_SPEED,
							)
						}
						markers={markers}
						{...(current === undefined ? {} : { current: current.id })}
						onMarker={(marker) => goTo(markers.find((each) => each.id === marker.id))}
						start={
							markers.length === 0 ? undefined : (
								<>
									<IconButton
										variant="ghost"
										size="sm"
										className="kt-player-previous"
										label="Previous step"
										icon={<PreviousStepIcon />}
										disabled={previous === undefined}
										onClick={() => goTo(previous)}
									/>
									<IconButton
										variant="ghost"
										size="sm"
										className="kt-player-next"
										label="Next step"
										icon={<NextStepIcon />}
										disabled={next === undefined}
										onClick={() => goTo(next)}
									/>
								</>
							)
						}
						end={
							markers.length === 0 ? undefined : (
								<Button
									variant="ghost"
									size="xs"
									className="kt-player-skip"
									aria-pressed={skipIdle}
									title={
										skipIdle
											? `Skipping ${playerClock(saved)} while the agent was thinking. Play everything`
											: "Skip the time the agent spent thinking"
									}
									onClick={toggleSkip}
								>
									{skipIdle ? "Steps only" : "Everything"}
								</Button>
							)
						}
					/>
				}
			>
				<div className={stage}>
					<canvas
						ref={canvas}
						className={`${picture}${started && painted ? "" : " invisible"}`}
						aria-label="The browser, replayed"
					/>
					{started && painted ? null : poster === undefined ? null : (
						<img
							className={`${picture} kt-browser-timeline-poster`}
							src={poster}
							alt="The last page the browser showed"
							onError={retryToolImage}
						/>
					)}
					{started ? null : (
						<Button
							variant="primary"
							size="md"
							className="kt-browser-live-play absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
							icon={<PlayIcon size="sm" />}
							onClick={() => seek(0, true)}
						>
							{markers.length === 0
								? "Play the replay"
								: `Play ${markers.length === 1 ? "1 step" : `${markers.length} steps`} in ${playerClock(duration / speed)}`}
						</Button>
					)}
					{waiting ? (
						<div
							className="kt-browser-timeline-loading absolute top-2 right-2 flex items-center gap-1.5 rounded-xs bg-raised px-2 py-1 text-xs text-muted"
							role="status"
						>
							<Spinner size="sm" /> Loading
						</div>
					) : null}
					{failed ? (
						<p
							className="kt-browser-timeline-failed absolute top-2 right-2 m-0 rounded-xs bg-raised px-2 py-1 text-xs text-status-error"
							role="alert"
						>
							This part of the replay didn't load. Play to try again.
						</p>
					) : null}
					{started && current !== undefined ? (
						<p className={caption} aria-live="polite">
							{`Step ${current.index + 1} of ${markers.length}: ${current.label}`}
						</p>
					) : null}
				</div>
			</BrowserWindow>
		</figure>
	);
}
