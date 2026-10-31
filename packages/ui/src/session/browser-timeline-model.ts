import type { ToolItem, TranscriptItem } from "@harbour/protocol";
import { type BrowserCallPage, browserPageOf } from "./transcript-model.ts";

// The browser timeline's model (`BrowserTimeline`): a recording of one browser, played on a timeline of its own steps.
// Pure, so it is tested without a canvas.
//
// A recording is the browser's pages, each a run of JPEG frames by its own clock (ms from its first frame), and it
// lasts as long as the browser was open: mostly the agent thinking, the page standing still. The timeline keeps what
// happened around each step (from a moment before the call to a while after it ended, while the page settles) and
// skips the rest, so a two-minute browser plays in a few seconds a step. Each step is a marker on it, to seek to.

/** One recorded page, as a recording's manifest lists it (`RecordingPage` in @harbour/browser's runtime). */
export type ReplayPage = {
	readonly pageId: string;
	/** When the page's first frame was drawn, in ms from the browser's start. */
	readonly startMs: number;
	readonly durationMs: number;
	readonly width?: number;
	readonly height?: number;
	readonly chunks: readonly { readonly index: number; readonly startMs: number; readonly durationMs: number }[];
	/** Where the page went, by its own clock. */
	readonly navigations?: readonly ReplayNavigation[];
};

/** The page went to `url` (and its title became `title`) `atMs` into its recording. */
export type ReplayNavigation = { readonly atMs: number; readonly url: string; readonly title?: string };

/** A recording's manifest: when the browser started (epoch ms) and its pages. */
export type ReplayManifest = {
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly pages: readonly ReplayPage[];
};

/** One of the agent's steps in the browser: a tool call on it. */
export type ReplayStep = {
	readonly id: string;
	readonly label: string;
	/** When the call started and ended, epoch ms. */
	readonly at: number;
	readonly endedAt?: number;
	readonly failed?: boolean;
	/** The page the call says it left the browser on, for the tab while the recording names none. */
	readonly page?: BrowserCallPage;
};

/** A stretch of one page that plays: `from` to `to` on the page's clock, starting `at` on the timeline. */
export type ReplaySegment = {
	readonly pageId: string;
	readonly from: number;
	readonly to: number;
	readonly at: number;
	/** Its start on the browser's clock (ms from the browser's start). */
	readonly real: number;
};

/** A step on the timeline. */
export type ReplayMarker = ReplayStep & { readonly position: number; readonly index: number };

export type ReplayPlan = {
	readonly segments: readonly ReplaySegment[];
	/** How long the timeline plays at 1×, in ms. */
	readonly duration: number;
	/** How long the recording is, in ms: what the timeline skips is the difference. */
	readonly recorded: number;
	readonly markers: readonly ReplayMarker[];
};

export type ReplayPlanOptions = {
	/** Skip what happened away from the steps. Without steps nothing is skipped. Default true. */
	readonly skipIdle?: boolean;
	/** How much before a step starts is kept. */
	readonly leadMs?: number;
	/** How much after a step ends is kept: the page settling. */
	readonly tailMs?: number;
	/** How much of each page's start is kept, steps or not: its first picture. */
	readonly openingMs?: number;
};

export const REPLAY_LEAD_MS = 400;
export const REPLAY_TAIL_MS = 1500;
export const REPLAY_OPENING_MS = 600;

type Interval = readonly [number, number];

function merge(intervals: Interval[]): Interval[] {
	const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
	const out: [number, number][] = [];
	for (const [a, b] of sorted) {
		const last = out.at(-1);
		if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
		else out.push([a, b]);
	}
	return out;
}

/** A page's length: its duration, or as far as its chunks go if they go further. */
function pageLength(page: ReplayPage): number {
	return Math.max(page.durationMs, 0, ...page.chunks.map((chunk) => chunk.startMs + chunk.durationMs));
}

/**
 * The timeline for a recording and the steps taken in it: the stretches that play, in order (pages one after another,
 * as the replay page plays them), how long it plays, and where each step is on it.
 */
export function replayPlan(
	manifest: ReplayManifest,
	steps: readonly ReplayStep[],
	options: ReplayPlanOptions = {},
): ReplayPlan {
	const lead = options.leadMs ?? REPLAY_LEAD_MS;
	const tail = options.tailMs ?? REPLAY_TAIL_MS;
	const opening = options.openingMs ?? REPLAY_OPENING_MS;
	const pages = [...manifest.pages].filter((page) => page.chunks.length > 0).sort((a, b) => a.startMs - b.startMs);
	const ordered = [...steps].sort((a, b) => a.at - b.at);
	const skip = (options.skipIdle ?? true) && ordered.length > 0;
	// What is kept, on the browser's clock.
	const kept = skip
		? merge([
				...ordered.map(
					(step): Interval => [
						step.at - manifest.startedAt - lead,
						Math.max(step.at, step.endedAt ?? step.at) - manifest.startedAt + tail,
					],
				),
				...pages.map((page): Interval => [page.startMs, page.startMs + opening]),
			])
		: undefined;

	const segments: ReplaySegment[] = [];
	let at = 0;
	let recorded = 0;
	for (const page of pages) {
		const length = pageLength(page);
		recorded += length;
		const start = page.startMs;
		const end = start + length;
		const parts: Interval[] =
			kept === undefined
				? [[start, end]]
				: kept.map(([a, b]): Interval => [Math.max(a, start), Math.min(b, end)]).filter(([a, b]) => b > a);
		for (const [a, b] of parts) {
			segments.push({ pageId: page.pageId, from: a - start, to: b - start, at, real: a });
			at += b - a;
		}
	}

	const markers = ordered.map((step, index): ReplayMarker => {
		const real = step.at - manifest.startedAt;
		return { ...step, index, position: positionOfReal(segments, real, at) };
	});
	return { segments, duration: at, recorded, markers };
}

/** Where a point on the browser's clock plays: in the newest page showing then, or the next stretch that plays. */
function positionOfReal(segments: readonly ReplaySegment[], real: number, duration: number): number {
	let inside: ReplaySegment | undefined;
	let next: ReplaySegment | undefined;
	for (const segment of segments) {
		const end = segment.real + (segment.to - segment.from);
		if (real >= segment.real && real < end) inside = segment;
		else if (segment.real > real && (next === undefined || segment.real < next.real)) next = segment;
	}
	if (inside !== undefined) return inside.at + (real - inside.real);
	return next?.at ?? duration;
}

/** Where a point on the browser's clock (ms from its start) plays on a timeline. */
export function replayPosition(plan: Pick<ReplayPlan, "segments" | "duration">, real: number): number {
	return positionOfReal(plan.segments, real, plan.duration);
}

/** The point on the browser's clock a position on the timeline shows. */
export function replayReal(plan: Pick<ReplayPlan, "segments">, position: number): number | undefined {
	const where = replayAt(plan, position);
	return where === undefined ? undefined : where.segment.real + (where.pageMs - where.segment.from);
}

/** The stretch playing at a position on the timeline, and the point on its page's clock. */
export function replayAt(
	plan: Pick<ReplayPlan, "segments">,
	position: number,
): { readonly segment: ReplaySegment; readonly pageMs: number } | undefined {
	const { segments } = plan;
	let found = segments[0];
	for (const segment of segments) {
		if (segment.at > position) break;
		found = segment;
	}
	if (found === undefined) return undefined;
	const pageMs = Math.min(found.to, found.from + Math.max(0, position - found.at));
	return { segment: found, pageMs };
}

/** The step showing at a position: the last one at or before it (the first before any). */
export function stepAt(markers: readonly ReplayMarker[], position: number): ReplayMarker | undefined {
	let found: ReplayMarker | undefined;
	for (const marker of markers) {
		if (marker.position > position + 1) break;
		found = marker;
	}
	return found;
}

/** The page's address and title at a point on its own clock: its last navigation at or before it. */
export function navigationAt(
	navigations: readonly ReplayNavigation[] | undefined,
	pageMs: number,
): ReplayNavigation | undefined {
	let found: ReplayNavigation | undefined;
	for (const navigation of navigations ?? []) {
		if (navigation.atMs > pageMs) break;
		found = navigation;
	}
	return found ?? navigations?.[0];
}

/**
 * What the window's tab and address bar say at a point: the recording's own navigation there (the title the page
 * really had), else what the step showing then said of its page, else the step before it that said anything.
 */
export function pageAtPosition(
	plan: ReplayPlan,
	pages: readonly ReplayPage[],
	position: number,
): BrowserCallPage | undefined {
	const where = replayAt(plan, position);
	const page = where === undefined ? undefined : pages.find((each) => each.pageId === where.segment.pageId);
	const navigation = where === undefined ? undefined : navigationAt(page?.navigations, where.pageMs);
	const step = stepAt(plan.markers, position);
	let said: BrowserCallPage | undefined;
	for (const marker of plan.markers) {
		if (step !== undefined && marker.index > step.index) break;
		if (marker.page !== undefined) said = marker.page;
	}
	if (navigation !== undefined) {
		const title = navigation.title ?? (said?.url === navigation.url ? said.title : undefined);
		return { url: navigation.url, ...(title === undefined ? {} : { title }) };
	}
	return said;
}

/**
 * The browser's steps from a session's transcript: every finished call on it, in order. Calls the model asked for in
 * one answer share its time but run one after another: each starts no earlier than the one before it ended.
 */
export function browserSteps(items: readonly TranscriptItem[], browserSessionId: string): ReplayStep[] {
	const steps: ReplayStep[] = [];
	let ended: number | undefined;
	for (const item of items) {
		if (item.kind !== "tool" || item.browserSessionId !== browserSessionId) continue;
		const step = stepOf(item);
		const at = ended !== undefined && step.at < ended ? Math.min(ended, step.endedAt ?? ended) : step.at;
		steps.push(at === step.at ? step : { ...step, at });
		ended = Math.max(ended ?? 0, step.endedAt ?? step.at);
	}
	return steps;
}

function stepOf(item: ToolItem): ReplayStep {
	const page = browserPageOf(item);
	return {
		id: item.id,
		label: item.label,
		at: item.at,
		...(item.endedAt === undefined ? {} : { endedAt: item.endedAt }),
		...(item.status === "error" ? { failed: true } : {}),
		...(page === undefined ? {} : { page }),
	};
}

/** The speeds the timeline steps through, and the one it starts at. */
export const REPLAY_SPEEDS = [1, 2, 4, 8] as const;
export const REPLAY_DEFAULT_SPEED = 2;
